import path from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { compareCodeUnits, deterministicId, sha256Bytes } from '../core/canonical.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { ServiceError } from '../core/result.js';
import type { ScannedFile } from '../core/scanner.js';
import {
  applyReplacements,
  assignments,
  encodeSource,
  parseLocalisation,
  type AssignmentNode,
  type BlockNode,
  type LocalisationDocument,
  type LocalisationEntry,
  type SourceReplacement,
} from '../core/source/index.js';
import type { ProposedFileChange } from '../core/transactions.js';
import { rgbKey, type PixelDiffBounds, type PixelPoint, type RgbColor } from './bmp.js';
import {
  MAP_MASK_CELL_LIMIT,
  MAP_POLYGON_WORK_LIMIT,
  MAP_SELECTED_OFFSET_BYTES,
  MAP_SELECTED_PIXEL_LIMIT,
} from './limits.js';
import {
  derivedStateCapital,
  encodeTextDocument,
  MapWorkspaceIndex,
  parseTextDocument,
  type AdjacencyRecord,
  type BuildingPositionRecord,
  type ProvinceDefinition,
  type StateRecord,
  type StrategicRegionRecord,
  type TextFileDocument,
  type UnitPositionRecord,
  type WeatherPositionRecord,
} from './model.js';

type MapOperationSteps<T> = Generator<void, T, void>;

function* cancellationCheckpoint(
  signal: AbortSignal | undefined,
  iteration = 0,
  stride = 1,
): MapOperationSteps<void> {
  if (iteration % stride !== 0) return;
  signal?.throwIfAborted();
  yield;
}

function completeSynchronously<T>(steps: MapOperationSteps<T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

async function completeCooperatively<T>(
  steps: MapOperationSteps<T>,
  signal?: AbortSignal,
): Promise<T> {
  let yieldDeadline = performance.now() + 8;
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    signal?.throwIfAborted();
    if (performance.now() < yieldDeadline) continue;
    await yieldToEventLoop();
    signal?.throwIfAborted();
    yieldDeadline = performance.now() + 8;
  }
}

export interface MapOperationBase {
  id: string;
  summary?: string;
}

export interface MoveStateDistributionPolicy {
  stateValues: 'retain-in-current-states';
  ownership: 'retain-in-current-states';
  provinceBuildings: 'follow-province';
  victoryPoints: 'follow-province';
  ports: 'follow-province';
  supplyNodes: 'follow-province';
  railways: 'follow-province';
  positions: 'follow-province';
  strategicRegion: 'require-same' | 'move-to-target-region';
}

export type SplitScalarPolicy =
  | { method: 'retain-in-source' }
  | { method: 'proportional-by-land-pixels' }
  | { method: 'exact'; source: number; destination: number };

export type SplitMapPolicy =
  | { method: 'retain-in-source' }
  | { method: 'proportional-by-land-pixels' }
  | { method: 'exact'; source: Record<string, number>; destination: Record<string, number> };

export type SplitTagPolicy =
  | { method: 'copy-source' }
  | { method: 'exact'; source: string | null; destination: string | null };

export type SplitTagListPolicy =
  { method: 'copy-source' } | { method: 'exact'; source: string[]; destination: string[] };

export interface SplitStateDistributionPolicy {
  manpower: SplitScalarPolicy;
  resources: SplitMapPolicy;
  stateBuildings: SplitMapPolicy;
  owner: SplitTagPolicy;
  controller: SplitTagPolicy;
  cores: SplitTagListPolicy;
  claims: SplitTagListPolicy;
  victoryPoints: 'follow-province';
  provinceBuildings: 'follow-province';
  ports: 'follow-province';
  supplyNodes: 'follow-province';
  railways: 'follow-province';
  positions: 'follow-province';
}

export type StateLocalisationPolicy =
  | { method: 'existing'; language: 'l_english' }
  | {
      method: 'upsert';
      language: 'l_english';
      value: string;
      file?: string;
    };

export interface MergeStateDistributionPolicy {
  stateValues: 'sum-into-target';
  ownership: 'retain-target';
  controller: 'retain-target';
  cores: 'union';
  claims: 'union';
  victoryPoints: 'follow-province';
  provinceBuildings: 'follow-province';
  ports: 'follow-province';
  supplyNodes: 'follow-province';
  railways: 'follow-province';
  positions: 'follow-province';
  strategicRegion: 'require-same';
}

export interface MoveStateProvincesOperation extends MapOperationBase {
  kind: 'move_state_provinces';
  sourceStateId: number;
  targetStateId: number;
  provinceIds: number[];
  distribution: MoveStateDistributionPolicy;
}

export interface UpdateStateOperation extends MapOperationBase {
  kind: 'update_state';
  stateId: number;
  changes: {
    capital?: number | null;
    manpower?: number;
    category?: string;
    resources?: Record<string, number>;
    stateBuildings?: Record<string, number>;
    owner?: string | null;
    controller?: string | null;
    cores?: string[];
    claims?: string[];
    victoryPoints?: { provinceId: number; value: number }[];
    provinceBuildings?: Record<string, Record<string, number>>;
  };
}

export interface SplitStateOperation extends MapOperationBase {
  kind: 'split_state' | 'create_state';
  sourceStateId: number;
  stateId?: number;
  provinceIds: number[];
  name?: string;
  fileName?: string;
  localisation?: StateLocalisationPolicy;
  distribution: SplitStateDistributionPolicy;
}

export interface MergeStatesOperation extends MapOperationBase {
  kind: 'merge_states';
  sourceStateIds: number[];
  targetStateId: number;
  distribution: MergeStateDistributionPolicy;
}

export type ProvinceGeometrySelection =
  | { kind: 'pixels'; pixels: PixelPoint[] }
  | {
      kind: 'mask';
      width: number;
      height: number;
      origin: PixelPoint;
      selectedPixelCount: number;
      sha256: string;
      data: string;
    }
  | { kind: 'polygon'; points: PixelPoint[] };

export interface SplitProvinceDistributionPolicy {
  state: 'inherit-source' | 'none';
  strategicRegion: 'inherit-source';
  victoryPoints: 'retain-source';
  provinceBuildings: 'retain-source';
  ports: 'retain-source';
  supplyNodes: 'retain-source';
  railways: 'retain-source';
  adjacencies: 'retain-source';
  positions: 'retain-source';
  entityLocators: 'retain-source';
}

export type SupportedProvinceType = 'land' | 'sea' | 'lake';

export interface ProvinceDefinitionInput {
  color?: RgbColor;
  type?: SupportedProvinceType;
  coastal?: boolean;
  terrain?: string;
  continent?: number;
}

export interface SplitProvinceOperation extends MapOperationBase {
  kind: 'split_province' | 'create_province';
  sourceProvinceId: number;
  provinceId?: number;
  geometry: ProvinceGeometrySelection;
  definition:
    | { method: 'inherit-source'; overrides?: ProvinceDefinitionInput }
    | {
        method: 'exact';
        value: ProvinceDefinitionInput & {
          type: SupportedProvinceType;
          coastal: boolean;
          terrain: string;
          continent: number;
        };
      };
  distribution: SplitProvinceDistributionPolicy;
}

export interface MergeProvinceDistributionPolicy {
  membership: 'require-same';
  victoryPoints: 'sum-into-target';
  provinceBuildings: 'sum-into-target';
  references: 'remap-to-target-and-deduplicate';
}

export interface MergeProvincesOperation extends MapOperationBase {
  kind: 'merge_provinces';
  sourceProvinceIds: number[];
  targetProvinceId: number;
  distribution: MergeProvinceDistributionPolicy;
}

export interface RemoveProvinceOperation extends MapOperationBase {
  kind: 'remove_province';
  provinceId: number;
  mergeIntoProvinceId: number;
  distribution: MergeProvinceDistributionPolicy;
}

export type ProvinceTypeStateMembershipPolicy =
  | { method: 'retain' }
  | { method: 'remove'; stateId: number }
  | { method: 'assign'; stateId: number };

/**
 * Complete policy for every indexed dependency that may become invalid when a
 * province crosses the land/sea/lake boundary. Retention is accepted only
 * when the proposed target type keeps the referenced record valid.
 */
export interface ProvinceTypeDistributionPolicy {
  stateMembership: ProvinceTypeStateMembershipPolicy;
  stateValues: 'retain-in-current-states';
  strategicRegion: 'retain-membership';
  victoryPoints: 'retain-if-valid' | 'remove';
  provinceBuildings: 'retain-if-valid' | 'remove';
  ports: 'retain-if-valid' | 'remove';
  supplyNodes: 'retain-if-valid' | 'remove';
  railways: 'retain-if-valid' | 'remove-containing';
  buildingPositions: 'retain-if-valid' | 'remove';
  unitPositions: 'retain-if-valid' | 'remove';
  entityLocators: 'retain-at-coordinate';
  adjacencies: 'retain-if-valid' | 'remove-referencing';
}

export interface UpdateProvinceDefinitionOperation extends MapOperationBase {
  kind: 'update_province_definition';
  provinceId: number;
  changes: ProvinceDefinitionInput;
  distribution?: ProvinceTypeDistributionPolicy;
}

export interface MoveRegionProvincesOperation extends MapOperationBase {
  kind: 'move_region_provinces';
  sourceRegionId: number;
  targetRegionId: number;
  provinceIds: number[];
  distribution: 'move-membership';
}

export interface AddAdjacencyOperation extends MapOperationBase {
  kind: 'add_adjacency';
  adjacency: Omit<AdjacencyRecord, 'index' | 'line' | 'document'>;
}

export interface RemoveAdjacencyOperation extends MapOperationBase {
  kind: 'remove_adjacency';
  from: number;
  to: number;
  type?: string;
}

export interface ProvincePixelTransfer extends PixelPoint {
  sourceProvinceId: number;
  targetProvinceId: number;
}

export interface NormalAdjacencyOperation extends MapOperationBase {
  kind: 'add_normal_adjacency' | 'remove_normal_adjacency';
  from: number;
  to: number;
  pixelTransfers: ProvincePixelTransfer[];
}

export interface AddSupplyNodeOperation extends MapOperationBase {
  kind: 'add_supply_node';
  level: number;
  provinceId: number;
}

export interface RemoveSupplyNodeOperation extends MapOperationBase {
  kind: 'remove_supply_node';
  provinceId: number;
}

export interface AddRailwayOperation extends MapOperationBase {
  kind: 'add_railway';
  level: number;
  provinces: number[];
}

export interface RemoveRailwayOperation extends MapOperationBase {
  kind: 'remove_railway';
  index: number;
}

export interface UpsertBuildingPositionOperation extends MapOperationBase {
  kind: 'upsert_building_position';
  match: { stateId: number; building: string; occurrence?: number };
  value: Omit<BuildingPositionRecord, 'line' | 'document'>;
}

export interface RemoveBuildingPositionOperation extends MapOperationBase {
  kind: 'remove_building_position';
  match: { stateId: number; building: string; occurrence?: number };
}

export interface UpsertUnitPositionOperation extends MapOperationBase {
  kind: 'upsert_unit_position';
  match: { provinceId: number; type: number; occurrence?: number };
  value: Omit<UnitPositionRecord, 'line' | 'document'>;
}

export interface RemoveUnitPositionOperation extends MapOperationBase {
  kind: 'remove_unit_position';
  match: { provinceId: number; type: number; occurrence?: number };
}

export interface UpsertWeatherPositionOperation extends MapOperationBase {
  kind: 'upsert_weather_position';
  match: { strategicRegionId: number; size: string; occurrence?: number };
  value: Omit<WeatherPositionRecord, 'line' | 'document'>;
}

export interface RemoveWeatherPositionOperation extends MapOperationBase {
  kind: 'remove_weather_position';
  match: { strategicRegionId: number; size: string; occurrence?: number };
}

export interface UpdateEntityLocatorOperation extends MapOperationBase {
  kind: 'update_entity_locator';
  entity: string;
  name: string;
  position: [number, number, number];
}

export type MapOperation =
  | MoveStateProvincesOperation
  | UpdateStateOperation
  | SplitStateOperation
  | MergeStatesOperation
  | SplitProvinceOperation
  | MergeProvincesOperation
  | RemoveProvinceOperation
  | UpdateProvinceDefinitionOperation
  | MoveRegionProvincesOperation
  | AddAdjacencyOperation
  | RemoveAdjacencyOperation
  | NormalAdjacencyOperation
  | AddSupplyNodeOperation
  | RemoveSupplyNodeOperation
  | AddRailwayOperation
  | RemoveRailwayOperation
  | UpsertBuildingPositionOperation
  | RemoveBuildingPositionOperation
  | UpsertUnitPositionOperation
  | RemoveUnitPositionOperation
  | UpsertWeatherPositionOperation
  | RemoveWeatherPositionOperation
  | UpdateEntityLocatorOperation;

type SimpleMapOperation =
  | AddAdjacencyOperation
  | RemoveAdjacencyOperation
  | AddSupplyNodeOperation
  | RemoveSupplyNodeOperation
  | AddRailwayOperation
  | RemoveRailwayOperation
  | UpsertBuildingPositionOperation
  | RemoveBuildingPositionOperation
  | UpsertUnitPositionOperation
  | RemoveUnitPositionOperation
  | UpsertWeatherPositionOperation
  | RemoveWeatherPositionOperation;

export interface AllocationEvidence {
  kind: 'state-id' | 'province-id' | 'province-color';
  allocated: number | string;
  strategy: string;
  highestObserved?: number;
  contiguousBefore?: boolean;
  probes?: number;
  occupiedCount?: number;
  roots: {
    rootKind: string;
    loadOrder: number;
    sourceCount: number;
    samplePath: string;
    maximumId: number;
  }[];
}

export interface MapOperationBlocker {
  code: string;
  message: string;
  operationId: string;
  details?: Record<string, unknown>;
}

export interface MapOperationPlan {
  changes: ProposedFileChange[];
  diagnostics: Diagnostic[];
  blockers: MapOperationBlocker[];
  allocations: AllocationEvidence[];
  expectedChangedBounds?: PixelDiffBounds;
  finalIndex: MapWorkspaceIndex;
  operations: { id: string; kind: string; summary: string; data: Record<string, unknown> }[];
}

interface MutableChange {
  relativePath: string;
  content: Buffer | null;
  operationIds: Set<string>;
  mediaType: string;
}

interface StateData {
  id: number;
  name: string;
  manpower: number;
  category: string;
  provinces: number[];
  resources: Map<string, number>;
  owner: string | undefined;
  controller: string | undefined;
  cores: string[];
  claims: string[];
  victoryPoints: { provinceId: number; value: number }[];
  provinceBuildings: Map<number, Map<string, number>>;
  stateBuildings: Map<string, number>;
}

interface StatePatchFields {
  manpower?: boolean;
  category?: boolean;
  resources?: boolean;
  provinces?: boolean;
  owner?: boolean;
  controller?: boolean;
  cores?: boolean;
  claims?: boolean;
  victoryPoints?: boolean;
  buildings?: boolean;
}

function normalizeRelative(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase();
}

function numberText(value: number): string {
  if (!Number.isFinite(value))
    throw new ServiceError('MAP_NUMBER_INVALID', 'Map values must be finite', { value });
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '');
}

function required<T>(value: T | undefined, code: string, message: string): T {
  if (value === undefined) throw new ServiceError(code, message);
  return value;
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => compareCodeUnits(left, right));
}

function lineIndent(text: string, offset: number): string {
  const lineStart =
    Math.max(
      text.lastIndexOf('\n', Math.max(0, offset - 1)),
      text.lastIndexOf('\r', Math.max(0, offset - 1)),
    ) + 1;
  return /^[\t ]*/u.exec(text.slice(lineStart, offset))?.[0] ?? '';
}

function assignmentFor(block: BlockNode, key: string): AssignmentNode | undefined {
  return assignments(block, key)[0];
}

function renderScalarMap(
  values: ReadonlyMap<string, number>,
  indent: string,
  newline: string,
): string {
  const rows = [...values]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, value]) => `${indent}\t${key} = ${numberText(value)}`);
  return rows.length === 0 ? `{ }` : `{${newline}${rows.join(newline)}${newline}${indent}}`;
}

function renderNumberList(values: readonly number[], indent: string, newline: string): string {
  const sorted = uniqueSorted(values);
  return sorted.length === 0
    ? `{ }`
    : `{${newline}${indent}\t${sorted.join(' ')}${newline}${indent}}`;
}

function renderBuildings(data: StateData, indent: string, newline: string): string {
  const rows = [...data.stateBuildings]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, value]) => `${indent}\t${key} = ${numberText(value)}`);
  for (const [provinceId, buildings] of [...data.provinceBuildings].sort(
    ([left], [right]) => left - right,
  )) {
    const inner = [...buildings]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, value]) => `${indent}\t\t${key} = ${numberText(value)}`)
      .join(newline);
    rows.push(`${indent}\t${provinceId} = {${newline}${inner}${newline}${indent}\t}`);
  }
  return rows.length === 0 ? `{ }` : `{${newline}${rows.join(newline)}${newline}${indent}}`;
}

function blockInsertion(
  block: BlockNode,
  documentText: string,
  content: string,
  newline: string,
): SourceReplacement {
  if (block.close === undefined)
    throw new ServiceError(
      'MAP_SOURCE_BLOCK_UNCLOSED',
      'Cannot insert into an unclosed source block',
    );
  const indent = lineIndent(documentText, block.close.start);
  return {
    start: block.close.start,
    end: block.close.start,
    text: `\t${content}${newline}${indent}`,
    description: 'Insert map source assignment',
  };
}

function cloneState(state: StateRecord): StateData {
  return {
    id: state.id,
    name: state.name,
    manpower: state.manpower,
    category: state.category,
    provinces: [...state.provinces],
    resources: new Map(state.resources),
    owner: state.owner,
    controller: state.controller,
    cores: [...state.cores],
    claims: [...state.claims],
    victoryPoints: state.victoryPoints.map(({ provinceId, value }) => ({ provinceId, value })),
    provinceBuildings: new Map(
      [...state.provinceBuildings].map(([provinceId, values]) => [provinceId, new Map(values)]),
    ),
    stateBuildings: new Map(state.stateBuildings),
  };
}

function compileHistory(data: StateData, indent: string, newline: string): string {
  const rows: string[] = [];
  if (data.owner !== undefined) rows.push(`${indent}\towner = ${data.owner}`);
  if (data.controller !== undefined) rows.push(`${indent}\tcontroller = ${data.controller}`);
  rows.push(...uniqueStrings(data.cores).map((tag) => `${indent}\tadd_core_of = ${tag}`));
  rows.push(...uniqueStrings(data.claims).map((tag) => `${indent}\tadd_claim_by = ${tag}`));
  rows.push(
    ...data.victoryPoints
      .slice()
      .sort((left, right) => left.provinceId - right.provinceId || left.value - right.value)
      .map(
        ({ provinceId, value }) =>
          `${indent}\tvictory_points = { ${provinceId} ${numberText(value)} }`,
      ),
  );
  if (data.stateBuildings.size > 0 || data.provinceBuildings.size > 0) {
    rows.push(`${indent}\tbuildings = ${renderBuildings(data, `${indent}\t`, newline)}`);
  }
  return rows.length === 0 ? `{ }` : `{${newline}${rows.join(newline)}${newline}${indent}}`;
}

function compileState(data: StateData, newline = '\n'): Buffer {
  const resources =
    data.resources.size === 0
      ? ''
      : `\tresources = ${renderScalarMap(data.resources, '\t', newline)}${newline}`;
  const history = compileHistory(data, '\t', newline);
  const text = [
    'state = {',
    `\tid = ${data.id}`,
    `\tname = ${quote(data.name)}`,
    `\tmanpower = ${numberText(data.manpower)}`,
    `\tstate_category = ${data.category}`,
    resources.trimEnd(),
    `\tprovinces = ${renderNumberList(data.provinces, '\t', newline)}`,
    `\thistory = ${history}`,
    '}',
    '',
  ]
    .filter((line) => line !== '')
    .join(newline);
  return Buffer.from(`${text}${newline}`, 'utf8');
}

function removeAssignments(block: BlockNode, key: string, replacements: SourceReplacement[]): void {
  for (const assignment of assignments(block, key)) {
    replacements.push({
      start: assignment.start,
      end: assignment.end,
      text: '',
      description: `Remove ${key}`,
    });
  }
}

function patchState(state: StateRecord, data: StateData, fields: StatePatchFields): Buffer {
  const replacements: SourceReplacement[] = [];
  const stateInsertions: string[] = [];
  const newline = state.document.newline;
  const stateIndent = lineIndent(state.document.text, state.assignment.start);
  if (fields.manpower === true) {
    const assignment = assignmentFor(state.block, 'manpower');
    if (assignment?.value.type === 'scalar') {
      replacements.push({
        start: assignment.value.start,
        end: assignment.value.end,
        text: numberText(data.manpower),
        description: 'Update state manpower',
      });
    } else {
      stateInsertions.push(`manpower = ${numberText(data.manpower)}`);
    }
  }
  if (fields.category === true) {
    const assignment = assignmentFor(state.block, 'state_category');
    if (assignment?.value.type === 'scalar') {
      replacements.push({
        start: assignment.value.start,
        end: assignment.value.end,
        text: data.category,
        description: 'Update state category',
      });
    } else {
      stateInsertions.push(`state_category = ${data.category}`);
    }
  }
  if (fields.resources === true) {
    const assignment = assignmentFor(state.block, 'resources');
    const rendered = `resources = ${renderScalarMap(data.resources, `${stateIndent}\t`, newline)}`;
    if (assignment !== undefined) {
      replacements.push({
        start: assignment.start,
        end: assignment.end,
        text: rendered,
        description: 'Update state resources',
      });
    } else if (data.resources.size > 0) {
      stateInsertions.push(rendered);
    }
  }
  if (fields.provinces === true) {
    const assignment = assignmentFor(state.block, 'provinces');
    const rendered = `provinces = ${renderNumberList(data.provinces, `${stateIndent}\t`, newline)}`;
    if (assignment !== undefined) {
      replacements.push({
        start: assignment.start,
        end: assignment.end,
        text: rendered,
        description: 'Update state provinces',
      });
    } else {
      stateInsertions.push(rendered);
    }
  }
  const historyChanged =
    fields.owner === true ||
    fields.controller === true ||
    fields.cores === true ||
    fields.claims === true ||
    fields.victoryPoints === true ||
    fields.buildings === true;
  if (historyChanged) {
    const history = state.historyBlock;
    if (history === undefined) {
      stateInsertions.push(`history = ${compileHistory(data, `${stateIndent}\t`, newline)}`);
    } else {
      const historyIndent = lineIndent(state.document.text, history.open?.start ?? history.start);
      const historyInsertions: string[] = [];
      const patchOptionalScalar = (key: string, value: string | undefined): void => {
        const matching = assignments(history, key);
        if (value === undefined) removeAssignments(history, key, replacements);
        else if (matching[0]?.value.type === 'scalar') {
          replacements.push({
            start: matching[0].value.start,
            end: matching[0].value.end,
            text: value,
            description: `Update state ${key}`,
          });
          for (const duplicate of matching.slice(1)) {
            replacements.push({
              start: duplicate.start,
              end: duplicate.end,
              text: '',
              description: `Remove duplicate ${key}`,
            });
          }
        } else {
          removeAssignments(history, key, replacements);
          historyInsertions.push(`${key} = ${value}`);
        }
      };
      if (fields.owner === true) patchOptionalScalar('owner', data.owner);
      if (fields.controller === true) patchOptionalScalar('controller', data.controller);
      if (fields.cores === true) {
        removeAssignments(history, 'add_core_of', replacements);
        historyInsertions.push(...uniqueStrings(data.cores).map((tag) => `add_core_of = ${tag}`));
      }
      if (fields.claims === true) {
        removeAssignments(history, 'add_claim_by', replacements);
        historyInsertions.push(...uniqueStrings(data.claims).map((tag) => `add_claim_by = ${tag}`));
      }
      if (fields.victoryPoints === true) {
        removeAssignments(history, 'victory_points', replacements);
        historyInsertions.push(
          ...data.victoryPoints
            .slice()
            .sort((left, right) => left.provinceId - right.provinceId || left.value - right.value)
            .map(
              ({ provinceId, value }) => `victory_points = { ${provinceId} ${numberText(value)} }`,
            ),
        );
      }
      if (fields.buildings === true) {
        const assignment = assignmentFor(history, 'buildings');
        const rendered = `buildings = ${renderBuildings(data, `${historyIndent}\t`, newline)}`;
        if (assignment !== undefined) {
          replacements.push({
            start: assignment.start,
            end: assignment.end,
            text: rendered,
            description: 'Update state buildings',
          });
        } else if (data.stateBuildings.size > 0 || data.provinceBuildings.size > 0) {
          historyInsertions.push(rendered);
        }
      }
      if (historyInsertions.length > 0) {
        replacements.push(
          blockInsertion(
            history,
            state.document.text,
            historyInsertions.join(`${newline}${historyIndent}\t`),
            newline,
          ),
        );
      }
    }
  }
  if (stateInsertions.length > 0) {
    replacements.push(
      blockInsertion(
        state.block,
        state.document.text,
        stateInsertions.join(`${newline}${stateIndent}\t`),
        newline,
      ),
    );
  }
  return applyReplacements(state.document, replacements);
}

function patchRegion(region: StrategicRegionRecord, provinces: readonly number[]): Buffer {
  const assignment = assignmentFor(region.block, 'provinces');
  const indent = lineIndent(region.document.text, region.assignment.start);
  const rendered = `provinces = ${renderNumberList(provinces, `${indent}\t`, region.document.newline)}`;
  const replacement =
    assignment === undefined
      ? blockInsertion(region.block, region.document.text, rendered, region.document.newline)
      : {
          start: assignment.start,
          end: assignment.end,
          text: rendered,
          description: 'Update strategic region provinces',
        };
  return applyReplacements(region.document, [replacement]);
}

function definitionLine(definition: ProvinceDefinition): string {
  return [
    definition.id,
    definition.color.r,
    definition.color.g,
    definition.color.b,
    definition.type,
    definition.coastal ? 'true' : 'false',
    definition.terrain,
    definition.continent,
  ].join(';');
}

function replaceDelimitedFields(line: string, replacements: ReadonlyMap<number, string>): string {
  if (replacements.size === 0) return line;
  const maximumIndex = [...replacements.keys()].reduce(
    (maximum, index) => Math.max(maximum, index),
    -1,
  );
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index <= maximumIndex; index += 1) {
    const delimiter = line.indexOf(';', start);
    const end = delimiter < 0 ? line.length : delimiter;
    if (start > line.length || (delimiter < 0 && index < maximumIndex))
      throw new ServiceError(
        'MAP_DELIMITED_FIELD_MISSING',
        `Delimited source row has no field ${index}`,
      );
    const field = line.slice(start, end);
    const value = replacements.get(index);
    const leading = /^\s*/u.exec(field)?.[0] ?? '';
    const trailing = /\s*$/u.exec(field)?.[0] ?? '';
    parts.push(value === undefined ? field : `${leading}${value}${trailing}`);
    if (delimiter < 0) {
      start = line.length;
      break;
    }
    parts.push(';');
    start = delimiter + 1;
  }
  parts.push(line.slice(start));
  return parts.join('');
}

function patchDefinitionLine(source: ProvinceDefinition, updated: ProvinceDefinition): string {
  const line = source.document.lines[source.line - 1];
  if (line === undefined)
    throw new ServiceError(
      'MAP_DEFINITION_LINE_MISSING',
      `Definition line ${source.line} is missing`,
    );
  const replacements = new Map<number, string>();
  if (updated.id !== source.id) replacements.set(0, String(updated.id));
  if (updated.color.r !== source.color.r) replacements.set(1, String(updated.color.r));
  if (updated.color.g !== source.color.g) replacements.set(2, String(updated.color.g));
  if (updated.color.b !== source.color.b) replacements.set(3, String(updated.color.b));
  if (updated.type !== source.type) replacements.set(4, updated.type);
  if (updated.coastal !== source.coastal) replacements.set(5, updated.coastal ? 'true' : 'false');
  if (updated.terrain !== source.terrain) replacements.set(6, updated.terrain);
  if (updated.continent !== source.continent) replacements.set(7, String(updated.continent));
  return replaceDelimitedFields(line.text, replacements);
}

function applyTextRanges(
  document: TextFileDocument,
  replacements: readonly SourceReplacement[],
): Buffer {
  const ordered = [...replacements].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let cursor = 0;
  const pieces: string[] = [];
  for (const replacement of ordered) {
    if (
      replacement.start < cursor ||
      replacement.end < replacement.start ||
      replacement.end > document.text.length
    ) {
      throw new ServiceError(
        'MAP_TEXT_REPLACEMENT_OVERLAP',
        'Map text replacements overlap or leave the file bounds',
      );
    }
    pieces.push(document.text.slice(cursor, replacement.start), replacement.text);
    cursor = replacement.end;
  }
  pieces.push(document.text.slice(cursor));
  return encodeTextDocument(document, pieces.join(''));
}

function patchDefinitions(
  index: MapWorkspaceIndex,
  updates: ReadonlyMap<number, ProvinceDefinition>,
  removals: ReadonlySet<number>,
  additions: readonly ProvinceDefinition[],
): Buffer {
  const file = index.definitionFile;
  if (file === undefined)
    throw new ServiceError(
      'MAP_DEFINITION_FILE_MISSING',
      'Cannot edit provinces without definition.csv',
    );
  const document = parseTextDocument(file);
  const replacements: SourceReplacement[] = [];
  for (const definition of index.definitions) {
    const line = document.lines[definition.line - 1];
    if (line === undefined)
      throw new ServiceError(
        'MAP_DEFINITION_LINE_MISSING',
        `Definition line ${definition.line} is missing`,
      );
    if (removals.has(definition.id)) {
      replacements.push({
        start: line.start,
        end: line.fullEnd,
        text: '',
        description: `Remove province ${definition.id}`,
      });
    } else {
      const update = updates.get(definition.id);
      if (update !== undefined) {
        replacements.push({
          start: line.start,
          end: line.end,
          text: patchDefinitionLine(definition, update),
          description: `Update province ${definition.id}`,
        });
      }
    }
  }
  if (additions.length > 0) {
    const separator =
      document.text.length === 0 || /(?:\r\n|\n|\r)$/u.test(document.text) ? '' : document.newline;
    replacements.push({
      start: document.text.length,
      end: document.text.length,
      text: `${separator}${additions.map(definitionLine).join(document.newline)}${document.newline}`,
      description: 'Append province definitions',
    });
  }
  return applyTextRanges(document, replacements);
}

function rootEvidence(
  records: readonly { id: number; file: ScannedFile }[],
): AllocationEvidence['roots'] {
  const groups = new Map<
    string,
    {
      rootKind: string;
      loadOrder: number;
      sourcePaths: Set<string>;
      samplePath: string;
      maximumId: number;
    }
  >();
  for (const record of records) {
    const key = `${record.file.rootKind}:${record.file.loadOrder}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        rootKind: record.file.rootKind,
        loadOrder: record.file.loadOrder,
        sourcePaths: new Set([record.file.displayPath]),
        samplePath: record.file.displayPath,
        maximumId: record.id,
      });
      continue;
    }
    existing.sourcePaths.add(record.file.displayPath);
    if (compareCodeUnits(record.file.displayPath, existing.samplePath) < 0) {
      existing.samplePath = record.file.displayPath;
    }
    existing.maximumId = Math.max(existing.maximumId, record.id);
  }
  return [...groups.values()]
    .map(({ sourcePaths, ...group }) => ({ ...group, sourceCount: sourcePaths.size }))
    .sort(
      (left, right) =>
        left.loadOrder - right.loadOrder || compareCodeUnits(left.rootKind, right.rootKind),
    );
}

function contiguous(ids: readonly number[], start: number): boolean {
  if (ids.length === 0) return true;
  const sorted = [...new Set(ids)].sort((left, right) => left - right);
  let expected = start;
  for (const id of sorted) {
    if (!Number.isSafeInteger(id) || id !== expected) return false;
    expected += 1;
  }
  return true;
}

function maximumObservedId(values: readonly number[], fallback: number): number {
  let maximum = fallback;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) {
      throw new ServiceError('MAP_ID_INVALID', 'Scanned map ID is not a safe integer');
    }
    maximum = Math.max(maximum, value);
  }
  return maximum;
}

function* allocateStateId(
  index: MapWorkspaceIndex,
  requested?: number,
  signal?: AbortSignal,
): MapOperationSteps<{ id: number; evidence: AllocationEvidence }> {
  const highest = maximumObservedId(
    index.statesAcrossRoots.map(({ id }) => id),
    0,
  );
  const used = new Set(index.statesAcrossRoots.map(({ id }) => id));
  if (requested !== undefined) {
    if (!Number.isSafeInteger(requested) || requested <= 0 || requested > 2_147_483_647)
      throw new ServiceError(
        'MAP_STATE_ID_INVALID',
        'Explicit state ID must be a positive integer',
      );
    if (used.has(requested))
      throw new ServiceError(
        index.statesById.has(requested)
          ? 'MAP_STATE_ID_COLLISION'
          : 'MAP_DEPENDENCY_STATE_ID_CONFLICT',
        `Explicit state ID ${requested} is already present in a scanned root`,
        {
          stateId: requested,
          sources: index.statesAcrossRoots
            .filter(({ id }) => id === requested)
            .map(({ file }) => file.displayPath)
            .sort(),
        },
      );
    return {
      id: requested,
      evidence: {
        kind: 'state-id',
        allocated: requested,
        strategy: 'explicit-request-after-full-scan',
        highestObserved: highest,
        probes: used.size,
        roots: rootEvidence(
          index.statesAcrossRoots.map(({ id: value, file }) => ({ id: value, file })),
        ),
      },
    };
  }
  if (highest >= 2_147_483_647) {
    throw new ServiceError('MAP_STATE_ID_EXHAUSTED', 'No safe state ID remains available');
  }
  let id = 1;
  let probes = 1;
  while (used.has(id)) {
    yield* cancellationCheckpoint(signal, probes, 256);
    id += 1;
    probes += 1;
  }
  return {
    id,
    evidence: {
      kind: 'state-id',
      allocated: id,
      strategy: 'lowest-positive-unused-active-id-across-roots',
      highestObserved: highest,
      contiguousBefore: contiguous([...used], 1),
      probes,
      roots: rootEvidence(
        index.statesAcrossRoots.map(({ id: value, file }) => ({ id: value, file })),
      ),
    },
  };
}

function* allocateProvince(
  index: MapWorkspaceIndex,
  requested?: number,
  signal?: AbortSignal,
): MapOperationSteps<{
  id: number;
  color: RgbColor;
  evidence: AllocationEvidence[];
}> {
  const highest = maximumObservedId(
    index.definitions.map(({ id }) => id),
    -1,
  );
  const contiguousBefore = contiguous(
    index.definitions.map(({ id: value }) => value),
    0,
  );
  if (!contiguousBefore) {
    throw new ServiceError(
      'MAP_PROVINCE_ID_GAP',
      'Province IDs must be contiguous before a new ID can be allocated',
    );
  }
  let id = highest + 1;
  let idStrategy = 'maximum-active-id-plus-one-across-roots';
  if (requested !== undefined) {
    if (!Number.isSafeInteger(requested) || requested < 0 || requested > 2_147_483_647)
      throw new ServiceError(
        'MAP_PROVINCE_ID_INVALID',
        'Explicit province ID must be a nonnegative integer',
      );
    if (index.definitionsAcrossRoots.some(({ id: existingId }) => existingId === requested))
      throw new ServiceError(
        index.definitionsById.has(requested)
          ? 'MAP_PROVINCE_ID_COLLISION'
          : 'MAP_DEPENDENCY_PROVINCE_ID_CONFLICT',
        `Explicit province ID ${requested} is already present in a scanned root`,
        {
          provinceId: requested,
          sources: index.definitionsAcrossRoots
            .filter(({ id: existingId }) => existingId === requested)
            .map(({ document }) => document.file.displayPath)
            .sort(),
        },
      );
    if (requested !== highest + 1)
      throw new ServiceError(
        'MAP_PROVINCE_ID_NOT_CONTIGUOUS',
        `Explicit province ID must be ${highest + 1} to preserve contiguous province definitions`,
      );
    id = requested;
    idStrategy = 'explicit-request-after-full-scan';
  }
  if (!Number.isSafeInteger(id) || id > 2_147_483_647) {
    throw new ServiceError('MAP_PROVINCE_ID_EXHAUSTED', 'No safe province ID remains available');
  }
  const crossRootId = index.definitionsAcrossRoots.find(
    ({ id: existingId, document }) =>
      existingId === id && document.file.displayPath !== index.definitionFile?.displayPath,
  );
  if (crossRootId !== undefined)
    throw new ServiceError(
      'MAP_DEPENDENCY_PROVINCE_ID_CONFLICT',
      `Next contiguous province ID ${id} collides with a lower-load-order definition`,
      { provinceId: id, source: crossRootId.document.file.displayPath },
    );
  const occupied = new Set(index.definitionsAcrossRoots.map(({ color }) => rgbKey(color)));
  for (const unknown of index.raster?.unknownColors ?? []) occupied.add(rgbKey(unknown.color));
  const seed = Number.parseInt(sha256Bytes(`province-color:${id}`).slice(0, 6), 16);
  let probes = 0;
  while (probes < 0xff_ff_ff) {
    yield* cancellationCheckpoint(signal, probes, 4096);
    const candidate = ((seed + probes) % 0xff_ff_ff) + 1;
    const color = {
      r: (candidate >>> 16) & 0xff,
      g: (candidate >>> 8) & 0xff,
      b: candidate & 0xff,
    };
    if (!occupied.has(rgbKey(color))) {
      return {
        id,
        color,
        evidence: [
          {
            kind: 'province-id',
            allocated: id,
            strategy: idStrategy,
            highestObserved: highest,
            contiguousBefore,
            roots: rootEvidence(
              index.definitionsAcrossRoots.map(({ id: value, document }) => ({
                id: value,
                file: document.file,
              })),
            ),
          },
          {
            kind: 'province-color',
            allocated: rgbKey(color),
            strategy: 'sha256-seeded-linear-probe-excluding-definition-and-bitmap-colors',
            probes: probes + 1,
            occupiedCount: occupied.size,
            roots: rootEvidence(
              index.definitionsAcrossRoots.map(({ id: value, document }) => ({
                id: value,
                file: document.file,
              })),
            ),
          },
        ],
      };
    }
    probes += 1;
  }
  throw new ServiceError('MAP_PROVINCE_COLOR_EXHAUSTED', 'No unused 24-bit province color remains');
}

export type MapAllocationRequest =
  | { kind: 'state'; requestedId?: number }
  | { kind: 'province'; requestedId?: number; requestedColor?: RgbColor };

export interface MapAllocationResult {
  stateId?: number;
  provinceId?: number;
  color?: RgbColor;
  evidence: AllocationEvidence[];
}

function* allocateMapIdentifierSteps(
  index: MapWorkspaceIndex,
  request: MapAllocationRequest,
  signal?: AbortSignal,
): MapOperationSteps<MapAllocationResult> {
  yield* cancellationCheckpoint(signal);
  if (request.kind === 'state') {
    const allocation = yield* allocateStateId(index, request.requestedId, signal);
    return { stateId: allocation.id, evidence: [allocation.evidence] };
  }
  const allocation = yield* allocateProvince(index, request.requestedId, signal);
  if (request.requestedColor === undefined) {
    return {
      provinceId: allocation.id,
      color: allocation.color,
      evidence: allocation.evidence,
    };
  }
  const color = request.requestedColor;
  if (
    ![color.r, color.g, color.b].every(
      (channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255,
    ) ||
    (color.r === 0 && color.g === 0 && color.b === 0)
  ) {
    throw new ServiceError(
      'MAP_PROVINCE_COLOR_INVALID',
      'Explicit province color must be a non-black 24-bit RGB value',
    );
  }
  const key = rgbKey(color);
  const crossRootDefinition = index.definitionsAcrossRoots.find(
    ({ color: existing }) => rgbKey(existing) === key,
  );
  if (
    crossRootDefinition !== undefined ||
    index.raster?.unknownColors.some(({ color: unknown }) => rgbKey(unknown) === key)
  ) {
    throw new ServiceError(
      crossRootDefinition !== undefined && !index.definitionsByColor.has(key)
        ? 'MAP_DEPENDENCY_PROVINCE_COLOR_CONFLICT'
        : 'MAP_PROVINCE_COLOR_DUPLICATE',
      `Explicit province color ${key} is already used in a scanned source`,
      {
        ...(crossRootDefinition === undefined
          ? {}
          : { source: crossRootDefinition.document.file.displayPath }),
      },
    );
  }
  return {
    provinceId: allocation.id,
    color,
    evidence: allocation.evidence.map((entry) =>
      entry.kind === 'province-color'
        ? { ...entry, allocated: key, strategy: 'explicit-request-after-full-scan' }
        : entry,
    ),
  };
}

/** Preview deterministic identifiers only after the complete active map index has been scanned. */
export function allocateMapIdentifiers(
  index: MapWorkspaceIndex,
  request: MapAllocationRequest,
  signal?: AbortSignal,
): MapAllocationResult {
  return completeSynchronously(allocateMapIdentifierSteps(index, request, signal));
}

export async function allocateMapIdentifiersAsync(
  index: MapWorkspaceIndex,
  request: MapAllocationRequest,
  signal?: AbortSignal,
): Promise<MapAllocationResult> {
  return completeCooperatively(allocateMapIdentifierSteps(index, request, signal), signal);
}

function syntheticFile(relativePath: string, bytes: Buffer, loadOrder: number): ScannedFile {
  return {
    absolutePath: `virtual://${relativePath}`,
    displayPath: `mod:${relativePath}`,
    relativePath,
    rootKind: 'mod',
    loadOrder,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

export function indexWithProposedChanges(
  base: MapWorkspaceIndex,
  changes: readonly Pick<ProposedFileChange, 'relativePath' | 'content'>[],
): MapWorkspaceIndex {
  const maximumLoadOrder =
    base.sourceFiles.reduce((maximum, { loadOrder }) => Math.max(maximum, loadOrder), 0) + 1;
  const byPath = new Map(changes.map((change) => [normalizeRelative(change.relativePath), change]));
  const files = base.sourceFiles.filter(
    (file) => !(file.rootKind === 'mod' && byPath.has(normalizeRelative(file.relativePath))),
  );
  for (const change of changes) {
    if (change.content !== null)
      files.push(syntheticFile(change.relativePath, Buffer.from(change.content), maximumLoadOrder));
  }
  return MapWorkspaceIndex.build(files, base.sourceRoots, base.sharedIndex.rebuild(files));
}

function addChange(
  changes: Map<string, MutableChange>,
  relativePath: string,
  content: Uint8Array | null,
  operationId: string,
  mediaType: string,
): void {
  const key = normalizeRelative(relativePath);
  const current = changes.get(key);
  if (current === undefined) {
    changes.set(key, {
      relativePath: relativePath.replaceAll('\\', '/'),
      content: content === null ? null : Buffer.from(content),
      operationIds: new Set([operationId]),
      mediaType,
    });
  } else {
    current.content = content === null ? null : Buffer.from(content);
    current.operationIds.add(operationId);
    current.mediaType = mediaType;
  }
}

function proposedChanges(changes: ReadonlyMap<string, MutableChange>): ProposedFileChange[] {
  return [...changes.values()]
    .sort((left, right) => compareCodeUnits(left.relativePath, right.relativePath))
    .map((change) => ({
      relativePath: change.relativePath,
      content: change.content,
      operationIds: [...change.operationIds].sort((left, right) => compareCodeUnits(left, right)),
      mediaType: change.mediaType,
    }));
}

function currentIndex(
  base: MapWorkspaceIndex,
  changes: ReadonlyMap<string, MutableChange>,
): MapWorkspaceIndex {
  return indexWithProposedChanges(base, proposedChanges(changes));
}

function samePolicy(actual: unknown, expected: Record<string, unknown>): boolean {
  if (actual === null || typeof actual !== 'object') return false;
  const object = actual as Record<string, unknown>;
  return Object.entries(expected).every(([key, value]) => object[key] === value);
}

function requireMovePolicy(operation: MoveStateProvincesOperation): void {
  const distribution = (
    operation as unknown as { distribution?: Partial<MoveStateDistributionPolicy> }
  ).distribution;
  if (
    !samePolicy(distribution, {
      stateValues: 'retain-in-current-states',
      ownership: 'retain-in-current-states',
      provinceBuildings: 'follow-province',
      victoryPoints: 'follow-province',
      ports: 'follow-province',
      supplyNodes: 'follow-province',
      railways: 'follow-province',
      positions: 'follow-province',
    }) ||
    (distribution?.strategicRegion !== 'require-same' &&
      distribution?.strategicRegion !== 'move-to-target-region')
  ) {
    throw new ServiceError(
      'MAP_STATE_DISTRIBUTION_REQUIRED',
      'Moving state provinces requires explicit state-value, ownership, building, victory-point, port, network, position, and strategic-region policies',
    );
  }
}

function requireSplitPolicy(operation: SplitStateOperation): SplitStateDistributionPolicy {
  const policy = (operation as unknown as { distribution?: Partial<SplitStateDistributionPolicy> })
    .distribution;
  if (
    policy?.manpower === undefined ||
    policy.resources === undefined ||
    policy.stateBuildings === undefined ||
    policy.owner === undefined ||
    policy.controller === undefined ||
    policy.cores === undefined ||
    policy.claims === undefined ||
    policy.victoryPoints !== 'follow-province' ||
    policy.provinceBuildings !== 'follow-province' ||
    policy.ports !== 'follow-province' ||
    policy.supplyNodes !== 'follow-province' ||
    policy.railways !== 'follow-province' ||
    policy.positions !== 'follow-province'
  ) {
    throw new ServiceError(
      'MAP_STATE_DISTRIBUTION_REQUIRED',
      'State creation requires a complete explicit value, ownership, port, network, position, and province-data distribution policy',
    );
  }
  return policy as SplitStateDistributionPolicy;
}

function requireSafeLocalisationDocument(
  document: LocalisationDocument,
  relativePath: string,
): void {
  if (document.encoding !== 'utf8-bom') {
    throw new ServiceError(
      'MAP_STATE_LOCALISATION_ENCODING_INVALID',
      'State localisation edits require an existing UTF-8 BOM source file',
      { file: relativePath, encoding: document.encoding },
    );
  }
  const errors = document.diagnostics.filter(
    ({ severity }) => severity === 'error' || severity === 'blocker',
  );
  if (errors.length > 0) {
    throw new ServiceError(
      'MAP_STATE_LOCALISATION_SOURCE_INVALID',
      'State localisation cannot target a malformed source file',
      { file: relativePath, diagnostics: errors.map(({ code }) => code) },
    );
  }
}

function safeLocalisationRelativePath(index: MapWorkspaceIndex, requested: string): string {
  const value = requested.replaceAll('\\', '/');
  const segments = value.split('/');
  if (
    value === '' ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    path.posix.normalize(value) !== value ||
    !/\.yml$/iu.test(value)
  ) {
    throw new ServiceError(
      'MAP_STATE_LOCALISATION_TARGET_INVALID',
      'State localisation target must be a safe relative .yml path',
      { file: requested },
    );
  }
  const normalized = normalizeRelative(value);
  if (
    !index.sourceRoots.localisation.some(
      (root) => normalized === root || normalized.startsWith(`${root}/`),
    )
  ) {
    throw new ServiceError(
      'MAP_STATE_LOCALISATION_TARGET_INVALID',
      'State localisation target must be inside a configured localisation root',
      { file: requested, roots: index.sourceRoots.localisation },
    );
  }
  return value;
}

function escapedLocalisationValue(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\r\n', '\\n')
    .replaceAll('\r', '\\n')
    .replaceAll('\n', '\\n');
}

function localisationEntryLine(
  document: LocalisationDocument,
  entry: LocalisationEntry,
  value: string,
): string {
  const line = document.text.slice(entry.start, entry.end);
  const opening = line.indexOf('"');
  if (opening < 0)
    throw new ServiceError(
      'MAP_STATE_LOCALISATION_SOURCE_INVALID',
      'State localisation source entry has no quoted value',
      { file: document.path, line: entry.line },
    );
  let closing = -1;
  let escaped = false;
  for (let index = opening + 1; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      closing = index;
      break;
    }
  }
  if (closing < 0)
    throw new ServiceError(
      'MAP_STATE_LOCALISATION_SOURCE_INVALID',
      'State localisation source entry has an unclosed quoted value',
      { file: document.path, line: entry.line },
    );
  return `${line.slice(0, opening + 1)}${escapedLocalisationValue(value)}${line.slice(closing)}`;
}

function appendLocalisationEntry(
  document: LocalisationDocument,
  key: string,
  value: string,
): Buffer {
  let englishHeaders = 0;
  const matcher = /^\s*l_english:\s*(?:#.*)?$/gmu;
  while (matcher.exec(document.text) !== null && englishHeaders < 2) englishHeaders += 1;
  if (englishHeaders !== 1) {
    throw new ServiceError(
      'MAP_STATE_LOCALISATION_SOURCE_INVALID',
      'State localisation target must contain exactly one l_english declaration',
      { file: document.path, englishHeaders },
    );
  }
  const separator =
    document.text.length === 0 || /(?:\r\n|\n|\r)$/u.test(document.text) ? '' : document.newline;
  return encodeSource(
    `${document.text}${separator}${key}: "${escapedLocalisationValue(value)}"${document.newline}`,
    'utf8-bom',
  );
}

function applyStateLocalisation(
  index: MapWorkspaceIndex,
  changes: Map<string, MutableChange>,
  operation: SplitStateOperation,
  key: string,
): void {
  const policy = (operation as unknown as { localisation?: unknown }).localisation;
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new ServiceError(
      'MAP_STATE_LOCALISATION_POLICY_REQUIRED',
      'State creation requires an explicit existing or upsert localisation policy',
    );
  }
  const object = policy as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  const existingPolicy =
    object.method === 'existing' &&
    object.language === 'l_english' &&
    keys.join(',') === 'language,method';
  const upsertPolicy =
    object.method === 'upsert' &&
    object.language === 'l_english' &&
    typeof object.value === 'string' &&
    object.value.length > 0 &&
    (object.file === undefined || (typeof object.file === 'string' && object.file.length > 0)) &&
    (keys.join(',') === 'language,method,value' || keys.join(',') === 'file,language,method,value');
  if (!existingPolicy && !upsertPolicy) {
    throw new ServiceError(
      'MAP_STATE_LOCALISATION_POLICY_REQUIRED',
      'State creation localisation policy is incomplete or unsupported',
      { requiredLanguage: 'l_english', methods: ['existing', 'upsert'] },
    );
  }
  const entries = index.localisationByKey.get(`l_english:${key}`) ?? [];
  if (entries.length > 1) {
    throw new ServiceError(
      'MAP_STATE_LOCALISATION_AMBIGUOUS',
      `English localisation key ${key} has multiple active definitions`,
      {
        key,
        sources: entries.map(({ file, entry }) => ({ file: file.displayPath, line: entry.line })),
      },
    );
  }
  const current = entries[0];
  if (existingPolicy) {
    if (current === undefined) {
      throw new ServiceError(
        'MAP_STATE_LOCALISATION_MISSING',
        `English localisation key ${key} does not exist`,
        { key },
      );
    }
    requireSafeLocalisationDocument(current.document, current.file.relativePath);
    return;
  }
  const value = object.value as string;
  const requestedFile = object.file as string | undefined;
  if (current !== undefined) {
    requireSafeLocalisationDocument(current.document, current.file.relativePath);
    if (
      requestedFile !== undefined &&
      normalizeRelative(safeLocalisationRelativePath(index, requestedFile)) !==
        normalizeRelative(current.file.relativePath)
    ) {
      throw new ServiceError(
        'MAP_STATE_LOCALISATION_TARGET_MISMATCH',
        `English localisation key ${key} exists in a different target file`,
        { requestedFile, existingFile: current.file.relativePath },
      );
    }
    const replacement = localisationEntryLine(current.document, current.entry, value);
    const text = `${current.document.text.slice(0, current.entry.start)}${replacement}${current.document.text.slice(current.entry.end)}`;
    addChange(
      changes,
      current.file.relativePath,
      encodeSource(text, 'utf8-bom'),
      operation.id,
      'text/yaml',
    );
    return;
  }
  if (requestedFile === undefined) {
    throw new ServiceError(
      'MAP_STATE_LOCALISATION_TARGET_REQUIRED',
      'Creating an English localisation key requires an explicit target file',
      { key },
    );
  }
  const relativePath = safeLocalisationRelativePath(index, requestedFile);
  const target = index.activeFiles.byRelativePath.get(normalizeRelative(relativePath));
  if (target === undefined) {
    addChange(
      changes,
      relativePath,
      encodeSource(`l_english:\n${key}: "${escapedLocalisationValue(value)}"\n`, 'utf8-bom'),
      operation.id,
      'text/yaml',
    );
    return;
  }
  const document = parseLocalisation(target.bytes, target.displayPath);
  requireSafeLocalisationDocument(document, target.relativePath);
  addChange(
    changes,
    target.relativePath,
    appendLocalisationEntry(document, key, value),
    operation.id,
    'text/yaml',
  );
}

function splitScalar(total: number, ratio: number, policy: SplitScalarPolicy): [number, number] {
  if (policy.method === 'retain-in-source') return [total, 0];
  if (policy.method === 'proportional-by-land-pixels') {
    const destination = Math.round(total * ratio);
    return [total - destination, destination];
  }
  if (Math.abs(policy.source + policy.destination - total) > 0.000_001) {
    throw new ServiceError(
      'MAP_DISTRIBUTION_TOTAL_MISMATCH',
      'Exact scalar distribution does not preserve the source total',
      {
        total,
        source: policy.source,
        destination: policy.destination,
      },
    );
  }
  return [policy.source, policy.destination];
}

function splitMap(
  total: ReadonlyMap<string, number>,
  ratio: number,
  policy: SplitMapPolicy,
): [Map<string, number>, Map<string, number>] {
  if (policy.method === 'retain-in-source') return [new Map(total), new Map<string, number>()];
  if (policy.method === 'proportional-by-land-pixels') {
    const source = new Map<string, number>();
    const destination = new Map<string, number>();
    for (const [key, value] of total) {
      const moved = Math.round(value * ratio * 1_000_000) / 1_000_000;
      source.set(key, value - moved);
      if (moved !== 0) destination.set(key, moved);
    }
    return [source, destination];
  }
  const source = new Map(Object.entries(policy.source));
  const destination = new Map(Object.entries(policy.destination));
  const keys = new Set([...total.keys(), ...source.keys(), ...destination.keys()]);
  for (const key of keys) {
    if (
      Math.abs((source.get(key) ?? 0) + (destination.get(key) ?? 0) - (total.get(key) ?? 0)) >
      0.000_001
    ) {
      throw new ServiceError(
        'MAP_DISTRIBUTION_TOTAL_MISMATCH',
        `Exact map distribution does not preserve ${key}`,
      );
    }
  }
  return [source, destination];
}

function splitTag(
  value: string | undefined,
  policy: SplitTagPolicy,
): [string | undefined, string | undefined] {
  if (policy.method === 'copy-source') return [value, value];
  return [policy.source ?? undefined, policy.destination ?? undefined];
}

function splitTags(value: readonly string[], policy: SplitTagListPolicy): [string[], string[]] {
  return policy.method === 'copy-source'
    ? [[...value], [...value]]
    : [uniqueStrings(policy.source), uniqueStrings(policy.destination)];
}

function provincePixelTotal(index: MapWorkspaceIndex, provinceIds: readonly number[]): number {
  return provinceIds.reduce(
    (sum, id) => sum + (index.raster?.geometry.get(id)?.pixelCount ?? 0),
    0,
  );
}

function mergeBounds(
  left: PixelDiffBounds | undefined,
  right: PixelDiffBounds | undefined,
): PixelDiffBounds | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return {
    minX: Math.min(left.minX, right.minX),
    minY: Math.min(left.minY, right.minY),
    maxX: Math.max(left.maxX, right.maxX),
    maxY: Math.max(left.maxY, right.maxY),
    count: left.count + right.count,
  };
}

function regionMembershipId(index: MapWorkspaceIndex, provinceId: number): number {
  const regions = index.regionForProvince(provinceId);
  if (regions.length !== 1)
    throw new ServiceError(
      'MAP_REGION_MEMBERSHIP_AMBIGUOUS',
      `Province ${provinceId} must have exactly one strategic region`,
    );
  return required(
    regions[0],
    'MAP_REGION_MEMBERSHIP_AMBIGUOUS',
    `Province ${provinceId} has no indexed strategic region`,
  ).id;
}

function stateMembershipId(index: MapWorkspaceIndex, provinceId: number): number | undefined {
  const states = index.stateForProvince(provinceId);
  if (states.length > 1)
    throw new ServiceError(
      'MAP_STATE_MEMBERSHIP_AMBIGUOUS',
      `Province ${provinceId} belongs to multiple states`,
    );
  return states[0]?.id;
}

function commitState(
  changes: Map<string, MutableChange>,
  state: StateRecord,
  data: StateData,
  fields: StatePatchFields,
  operationId: string,
): void {
  addChange(
    changes,
    state.file.relativePath,
    patchState(state, data, fields),
    operationId,
    'text/plain',
  );
}

function commitRegion(
  changes: Map<string, MutableChange>,
  region: StrategicRegionRecord,
  provinces: readonly number[],
  operationId: string,
): void {
  addChange(
    changes,
    region.file.relativePath,
    patchRegion(region, provinces),
    operationId,
    'text/plain',
  );
}

function remapBuildingPositionStates(
  index: MapWorkspaceIndex,
  changes: Map<string, MutableChange>,
  provinceIds: ReadonlySet<number>,
  targetStateId: number,
  operationId: string,
): void {
  const documents = new Map(
    index.buildingPositions.map((record) => [record.document.file.relativePath, record.document]),
  );
  for (const [relativePath, document] of documents) {
    const replacements = index.buildingPositions
      .filter((record) => record.document === document && record.stateId !== targetStateId)
      .flatMap((record): SourceReplacement[] => {
        const provinceId = index.provinceAtMapCoordinate(record.x, record.z);
        if (provinceId === undefined || !provinceIds.has(provinceId)) return [];
        const line = document.lines[record.line - 1];
        return line === undefined
          ? []
          : [
              {
                start: line.start,
                end: line.end,
                text: buildingPositionLine({ ...record, stateId: targetStateId }),
                description: 'Remap building-position state reference',
              },
            ];
      });
    if (replacements.length > 0)
      addChange(
        changes,
        relativePath,
        applyTextRanges(document, replacements),
        operationId,
        'text/plain',
      );
  }
}

function exactNumericMap(values: Record<string, number>, label: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const [key, value] of Object.entries(values)) {
    if (key === '' || !Number.isFinite(value) || value < 0)
      throw new ServiceError(
        'MAP_STATE_VALUE_INVALID',
        `${label}.${key || '<empty>'} must be nonnegative and finite`,
      );
    result.set(key, value);
  }
  return result;
}

function applyUpdateState(
  base: MapWorkspaceIndex,
  changes: Map<string, MutableChange>,
  operation: UpdateStateOperation,
): void {
  const index = currentIndex(base, changes);
  const state = index.statesById.get(operation.stateId);
  if (state === undefined)
    throw new ServiceError('MAP_STATE_NOT_FOUND', `State ${operation.stateId} does not exist`);
  const desired = cloneState(state);
  const fields: StatePatchFields = {};
  const values = operation.changes;
  if (values.capital !== undefined) {
    if (values.victoryPoints === undefined)
      throw new ServiceError(
        'MAP_STATE_CAPITAL_ASSERTION_REQUIRES_VICTORY_POINTS',
        'A derived state-capital assertion requires an exact victoryPoints payload',
      );
    const derived = derivedStateCapital(values.victoryPoints);
    if ((values.capital ?? undefined) !== derived)
      throw new ServiceError(
        'MAP_STATE_CAPITAL_ASSERTION_MISMATCH',
        'The asserted state capital must be the highest victory point, using the lowest province ID on ties',
        { asserted: values.capital, derived: derived ?? null },
      );
  }
  if (values.manpower !== undefined) {
    if (!Number.isFinite(values.manpower) || values.manpower < 0)
      throw new ServiceError(
        'MAP_STATE_MANPOWER_INVALID',
        'State manpower must be nonnegative and finite',
      );
    desired.manpower = values.manpower;
    fields.manpower = true;
  }
  if (values.category !== undefined) {
    if (values.category.trim() === '')
      throw new ServiceError('MAP_STATE_CATEGORY_INVALID', 'State category cannot be empty');
    desired.category = values.category;
    fields.category = true;
  }
  if (values.resources !== undefined) {
    desired.resources = exactNumericMap(values.resources, 'resources');
    fields.resources = true;
  }
  if (values.owner !== undefined) {
    desired.owner = values.owner ?? undefined;
    fields.owner = true;
  }
  if (values.controller !== undefined) {
    desired.controller = values.controller ?? undefined;
    fields.controller = true;
  }
  if (values.cores !== undefined) {
    desired.cores = uniqueStrings(values.cores);
    fields.cores = true;
  }
  if (values.claims !== undefined) {
    desired.claims = uniqueStrings(values.claims);
    fields.claims = true;
  }
  if (values.victoryPoints !== undefined) {
    const seen = new Set<number>();
    desired.victoryPoints = values.victoryPoints.map(({ provinceId, value }) => {
      if (
        !state.provinces.includes(provinceId) ||
        seen.has(provinceId) ||
        !Number.isFinite(value) ||
        value < 0
      )
        throw new ServiceError(
          'MAP_STATE_VICTORY_POINT_INVALID',
          'Victory points require unique member provinces and nonnegative finite values',
        );
      seen.add(provinceId);
      return { provinceId, value };
    });
    fields.victoryPoints = true;
  }
  if (values.stateBuildings !== undefined) {
    desired.stateBuildings = exactNumericMap(values.stateBuildings, 'stateBuildings');
    fields.buildings = true;
  }
  if (values.provinceBuildings !== undefined) {
    const provinceBuildings = new Map<number, Map<string, number>>();
    for (const [rawProvinceId, buildings] of Object.entries(values.provinceBuildings)) {
      if (!/^\d+$/u.test(rawProvinceId))
        throw new ServiceError(
          'MAP_STATE_BUILDING_PROVINCE_INVALID',
          `Invalid province key ${rawProvinceId}`,
        );
      const provinceId = Number(rawProvinceId);
      if (
        !Number.isSafeInteger(provinceId) ||
        provinceId < 0 ||
        provinceId > 2_147_483_647 ||
        !state.provinces.includes(provinceId)
      )
        throw new ServiceError(
          'MAP_STATE_BUILDING_PROVINCE_INVALID',
          `Province ${provinceId} is outside state ${state.id}`,
        );
      provinceBuildings.set(
        provinceId,
        exactNumericMap(buildings, `provinceBuildings.${provinceId}`),
      );
    }
    desired.provinceBuildings = provinceBuildings;
    fields.buildings = true;
  }
  commitState(changes, state, desired, fields, operation.id);
}

function applyMoveStateProvinces(
  base: MapWorkspaceIndex,
  changes: Map<string, MutableChange>,
  operation: MoveStateProvincesOperation,
): void {
  requireMovePolicy(operation);
  const index = currentIndex(base, changes);
  const source = index.statesById.get(operation.sourceStateId);
  const target = index.statesById.get(operation.targetStateId);
  if (source === undefined || target === undefined || source.id === target.id) {
    throw new ServiceError(
      'MAP_STATE_SELECTION_INVALID',
      'Source and target must be different existing states',
    );
  }
  const moving = uniqueSorted(operation.provinceIds);
  if (moving.length === 0 || moving.some((id) => !source.provinces.includes(id))) {
    throw new ServiceError(
      'MAP_STATE_PROVINCE_SELECTION_INVALID',
      'Every moved province must belong to the source state',
    );
  }
  if (source.provinces.length === moving.length) {
    throw new ServiceError(
      'MAP_STATE_WOULD_BE_EMPTY',
      'Moving every province would leave the source state empty',
    );
  }
  const sourceData = cloneState(source);
  const targetData = cloneState(target);
  const movingSet = new Set(moving);
  sourceData.provinces = sourceData.provinces.filter((id) => !movingSet.has(id));
  targetData.provinces = uniqueSorted([...targetData.provinces, ...moving]);
  const movedVps = sourceData.victoryPoints.filter(({ provinceId }) => movingSet.has(provinceId));
  sourceData.victoryPoints = sourceData.victoryPoints.filter(
    ({ provinceId }) => !movingSet.has(provinceId),
  );
  targetData.victoryPoints.push(...movedVps);
  for (const provinceId of moving) {
    const buildings = sourceData.provinceBuildings.get(provinceId);
    if (buildings !== undefined) {
      targetData.provinceBuildings.set(provinceId, buildings);
      sourceData.provinceBuildings.delete(provinceId);
    }
  }
  const targetRegionIds = new Set(target.provinces.map((id) => regionMembershipId(index, id)));
  const movingRegionIds = new Set(moving.map((id) => regionMembershipId(index, id)));
  if (targetRegionIds.size !== 1)
    throw new ServiceError(
      'MAP_TARGET_REGION_AMBIGUOUS',
      'Target state spans multiple strategic regions',
    );
  const targetRegionId = required(
    [...targetRegionIds][0],
    'MAP_TARGET_REGION_AMBIGUOUS',
    'Target state has no strategic region',
  );
  if (
    operation.distribution.strategicRegion === 'require-same' &&
    [...movingRegionIds].some((id) => id !== targetRegionId)
  ) {
    throw new ServiceError(
      'MAP_STATE_REGION_DISTRIBUTION_CONFLICT',
      'Moved provinces are not in the target strategic region',
    );
  }
  commitState(
    changes,
    source,
    sourceData,
    { provinces: true, victoryPoints: true, buildings: true },
    operation.id,
  );
  commitState(
    changes,
    target,
    targetData,
    { provinces: true, victoryPoints: true, buildings: true },
    operation.id,
  );
  if (operation.distribution.strategicRegion === 'move-to-target-region') {
    for (const regionId of movingRegionIds) {
      if (regionId === targetRegionId) continue;
      const region = required(
        index.regionsById.get(regionId),
        'MAP_REGION_NOT_FOUND',
        `Strategic region ${regionId} does not exist`,
      );
      commitRegion(
        changes,
        region,
        region.provinces.filter((id) => !movingSet.has(id)),
        operation.id,
      );
    }
    const targetRegion = required(
      index.regionsById.get(targetRegionId),
      'MAP_REGION_NOT_FOUND',
      `Strategic region ${targetRegionId} does not exist`,
    );
    commitRegion(
      changes,
      targetRegion,
      uniqueSorted([...targetRegion.provinces, ...moving]),
      operation.id,
    );
  }
  remapBuildingPositionStates(index, changes, movingSet, target.id, operation.id);
}

function* applySplitState(
  base: MapWorkspaceIndex,
  changes: Map<string, MutableChange>,
  allocations: AllocationEvidence[],
  operation: SplitStateOperation,
  signal?: AbortSignal,
): MapOperationSteps<void> {
  const policy = requireSplitPolicy(operation);
  const index = currentIndex(base, changes);
  const source = index.statesById.get(operation.sourceStateId);
  if (source === undefined)
    throw new ServiceError(
      'MAP_STATE_NOT_FOUND',
      `State ${operation.sourceStateId} does not exist`,
    );
  const selected = uniqueSorted(operation.provinceIds);
  const selectedSet = new Set(selected);
  if (selected.length === 0 || selected.some((id) => !source.provinces.includes(id))) {
    throw new ServiceError(
      'MAP_STATE_PROVINCE_SELECTION_INVALID',
      'Every new-state province must belong to the source state',
    );
  }
  if (selected.length === source.provinces.length)
    throw new ServiceError(
      'MAP_STATE_WOULD_BE_EMPTY',
      'A split must leave provinces in the source state',
    );
  const allocation = yield* allocateStateId(index, operation.stateId, signal);
  allocations.push(allocation.evidence);
  const sourcePixels = provincePixelTotal(index, source.provinces);
  const destinationPixels = provincePixelTotal(index, selected);
  if (sourcePixels <= 0 || destinationPixels <= 0)
    throw new ServiceError(
      'MAP_STATE_DISTRIBUTION_GEOMETRY_MISSING',
      'Proportional state distribution requires province geometry',
    );
  const ratio = destinationPixels / sourcePixels;
  const sourceData = cloneState(source);
  const destinationData = cloneState(source);
  destinationData.id = allocation.id;
  if (operation.name === undefined || operation.name.trim() === '')
    throw new ServiceError(
      'MAP_STATE_NAME_REQUIRED',
      'State creation requires an explicit localisation key',
    );
  destinationData.name = operation.name;
  applyStateLocalisation(index, changes, operation, destinationData.name);
  sourceData.provinces = sourceData.provinces.filter((id) => !selectedSet.has(id));
  destinationData.provinces = selected;
  [sourceData.manpower, destinationData.manpower] = splitScalar(
    source.manpower,
    ratio,
    policy.manpower,
  );
  [sourceData.resources, destinationData.resources] = splitMap(
    source.resources,
    ratio,
    policy.resources,
  );
  [sourceData.stateBuildings, destinationData.stateBuildings] = splitMap(
    source.stateBuildings,
    ratio,
    policy.stateBuildings,
  );
  [sourceData.owner, destinationData.owner] = splitTag(source.owner, policy.owner);
  [sourceData.controller, destinationData.controller] = splitTag(
    source.controller,
    policy.controller,
  );
  [sourceData.cores, destinationData.cores] = splitTags(source.cores, policy.cores);
  [sourceData.claims, destinationData.claims] = splitTags(source.claims, policy.claims);
  sourceData.victoryPoints = sourceData.victoryPoints.filter(
    ({ provinceId }) => !selectedSet.has(provinceId),
  );
  destinationData.victoryPoints = destinationData.victoryPoints.filter(({ provinceId }) =>
    selectedSet.has(provinceId),
  );
  sourceData.provinceBuildings = new Map(
    [...sourceData.provinceBuildings].filter(([provinceId]) => !selectedSet.has(provinceId)),
  );
  destinationData.provinceBuildings = new Map(
    [...destinationData.provinceBuildings].filter(([provinceId]) => selectedSet.has(provinceId)),
  );
  commitState(
    changes,
    source,
    sourceData,
    {
      manpower: true,
      resources: true,
      provinces: true,
      owner: true,
      controller: true,
      cores: true,
      claims: true,
      victoryPoints: true,
      buildings: true,
    },
    operation.id,
  );
  const requestedName = operation.fileName ?? `${allocation.id}-AGENT_STATE.txt`;
  const safeName = requestedName.replaceAll('\\', '/').split('/').at(-1) ?? requestedName;
  if (!/^[-A-Za-z0-9_.]+\.txt$/u.test(safeName))
    throw new ServiceError('MAP_STATE_FILENAME_INVALID', 'State filename is not safe');
  const statesRoot = index.sourceRoots.states[0] ?? 'history/states';
  const relativePath = `${statesRoot}/${safeName}`;
  if (index.activeFiles.byRelativePath.has(normalizeRelative(relativePath))) {
    throw new ServiceError(
      'MAP_STATE_FILENAME_COLLISION',
      `State file already exists: ${relativePath}`,
    );
  }
  addChange(
    changes,
    relativePath,
    compileState(destinationData, source.document.newline),
    operation.id,
    'text/plain',
  );
  remapBuildingPositionStates(index, changes, selectedSet, allocation.id, operation.id);
}

function requireMergeStatePolicy(operation: MergeStatesOperation): void {
  if (
    !samePolicy(operation.distribution, {
      stateValues: 'sum-into-target',
      ownership: 'retain-target',
      controller: 'retain-target',
      cores: 'union',
      claims: 'union',
      victoryPoints: 'follow-province',
      provinceBuildings: 'follow-province',
      ports: 'follow-province',
      supplyNodes: 'follow-province',
      railways: 'follow-province',
      positions: 'follow-province',
      strategicRegion: 'require-same',
    })
  ) {
    throw new ServiceError(
      'MAP_STATE_DISTRIBUTION_REQUIRED',
      'State merge requires a complete explicit value, ownership, port, network, position, and province-data distribution policy',
    );
  }
}

function removalContent(index: MapWorkspaceIndex, file: ScannedFile, label: string): Buffer | null {
  const lowerExists = index.sourceFiles.some(
    (candidate) =>
      normalizeRelative(candidate.relativePath) === normalizeRelative(file.relativePath) &&
      candidate.displayPath !== file.displayPath &&
      candidate.loadOrder < file.loadOrder,
  );
  return file.rootKind === 'mod' && !lowerExists
    ? null
    : Buffer.from(`# ${label}${file.bytes.includes(13) ? '\r\n' : '\n'}`, 'utf8');
}

function addMaps(target: Map<string, number>, source: ReadonlyMap<string, number>): void {
  for (const [key, value] of source) target.set(key, (target.get(key) ?? 0) + value);
}

function applyMergeStates(
  base: MapWorkspaceIndex,
  changes: Map<string, MutableChange>,
  operation: MergeStatesOperation,
): void {
  requireMergeStatePolicy(operation);
  const index = currentIndex(base, changes);
  const target = index.statesById.get(operation.targetStateId);
  const sourceIds = uniqueSorted(operation.sourceStateIds).filter(
    (id) => id !== operation.targetStateId,
  );
  const sources = sourceIds.flatMap((id) => {
    const state = index.statesById.get(id);
    return state === undefined ? [] : [state];
  });
  if (target === undefined || sourceIds.length === 0 || sources.length !== sourceIds.length) {
    throw new ServiceError(
      'MAP_STATE_SELECTION_INVALID',
      'Merge target and source states must exist',
    );
  }
  const regionIds = new Set(
    [...target.provinces, ...sources.flatMap((state) => state.provinces)].map((id) =>
      regionMembershipId(index, id),
    ),
  );
  if (regionIds.size !== 1)
    throw new ServiceError(
      'MAP_STATE_REGION_DISTRIBUTION_CONFLICT',
      'Merged states must share one strategic region',
    );
  const data = cloneState(target);
  for (const source of sources) {
    data.manpower += source.manpower;
    addMaps(data.resources, source.resources);
    addMaps(data.stateBuildings, source.stateBuildings);
    data.provinces.push(...source.provinces);
    data.cores.push(...source.cores);
    data.claims.push(...source.claims);
    data.victoryPoints.push(
      ...source.victoryPoints.map(({ provinceId, value }) => ({ provinceId, value })),
    );
    for (const [provinceId, buildings] of source.provinceBuildings)
      data.provinceBuildings.set(provinceId, new Map(buildings));
  }
  data.provinces = uniqueSorted(data.provinces);
  data.cores = uniqueStrings(data.cores);
  data.claims = uniqueStrings(data.claims);
  commitState(
    changes,
    target,
    data,
    {
      manpower: true,
      resources: true,
      provinces: true,
      cores: true,
      claims: true,
      victoryPoints: true,
      buildings: true,
    },
    operation.id,
  );
  for (const source of sources) {
    addChange(
      changes,
      source.file.relativePath,
      removalContent(index, source.file, `State ${source.id} merged into ${target.id}`),
      operation.id,
      'text/plain',
    );
  }
  remapBuildingPositionStates(
    index,
    changes,
    new Set(sources.flatMap(({ provinces }) => provinces)),
    target.id,
    operation.id,
  );
}

function pointInPolygon(x: number, y: number, points: readonly PixelPoint[]): boolean {
  let inside = false;
  for (
    let current = 0, previous = points.length - 1;
    current < points.length;
    previous = current, current += 1
  ) {
    const a = required(points[current], 'MAP_POLYGON_INVALID', 'Polygon vertex is missing');
    const b = required(points[previous], 'MAP_POLYGON_INVALID', 'Polygon vertex is missing');
    const intersects = a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function assertSelectedPixelBudget(selectedPixels: number, source: string): void {
  if (!Number.isSafeInteger(selectedPixels) || selectedPixels < 0) {
    throw new ServiceError(
      'MAP_SELECTED_PIXEL_BUDGET_BLOCKED',
      `${source} declares an invalid selected-pixel count`,
      { source, selectedPixels, maximumSelectedPixels: MAP_SELECTED_PIXEL_LIMIT },
    );
  }
  if (selectedPixels > MAP_SELECTED_PIXEL_LIMIT) {
    throw new ServiceError(
      'MAP_SELECTED_PIXEL_BUDGET_BLOCKED',
      `${source} exceeds the fixed selected-pixel memory budget`,
      {
        source,
        selectedPixels,
        maximumSelectedPixels: MAP_SELECTED_PIXEL_LIMIT,
        maximumOffsetBytes: MAP_SELECTED_PIXEL_LIMIT * MAP_SELECTED_OFFSET_BYTES,
      },
    );
  }
}

function packedRgb({ r, g, b }: RgbColor): number {
  return (r << 16) | (g << 8) | b;
}

function* rasterMaskPixels(
  raster: NonNullable<MapWorkspaceIndex['raster']>,
  geometry: Extract<ProvinceGeometrySelection, { kind: 'mask' }>,
  signal?: AbortSignal,
): MapOperationSteps<Uint32Array> {
  const { width, height, origin, selectedPixelCount, sha256, data } = geometry;
  assertSelectedPixelBudget(selectedPixelCount, 'Raster-mask geometry');
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isInteger(origin.x) ||
    !Number.isInteger(origin.y) ||
    origin.x < 0 ||
    origin.y < 0 ||
    origin.x + width > raster.width ||
    origin.y + height > raster.height
  ) {
    throw new ServiceError(
      'MAP_RASTER_MASK_DIMENSIONS_MISMATCH',
      'Raster-mask dimensions and origin must describe a positive rectangle inside the active province raster',
      {
        mask: { width, height, origin },
        raster: { width: raster.width, height: raster.height },
      },
    );
  }
  const cells = width * height;
  if (!Number.isSafeInteger(cells) || cells > MAP_MASK_CELL_LIMIT) {
    throw new ServiceError(
      'MAP_RASTER_MASK_DIMENSIONS_MISMATCH',
      'Raster-mask dimensions exceed the supported exact-pixel limit',
      { width, height, maximumCells: MAP_MASK_CELL_LIMIT },
    );
  }
  if (data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) {
    throw new ServiceError(
      'MAP_RASTER_MASK_ENCODING_INVALID',
      'Raster-mask data must be canonical Base64',
    );
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data || bytes.length !== cells) {
    throw new ServiceError(
      'MAP_RASTER_MASK_DIMENSIONS_MISMATCH',
      'Raster-mask byte length must equal width multiplied by height',
      { expectedBytes: cells, actualBytes: bytes.length },
    );
  }
  let actualSelectedPixelCount = 0;
  for (const [index, value] of bytes.entries()) {
    yield* cancellationCheckpoint(signal, index, 4096);
    if (value !== 0 && value !== 1) {
      throw new ServiceError(
        'MAP_RASTER_MASK_ENCODING_INVALID',
        'Raster-mask bytes must contain only canonical 0 or 1 cell values',
      );
    }
    actualSelectedPixelCount += value;
  }
  const actualSha256 = sha256Bytes(bytes);
  if (!/^[a-f0-9]{64}$/u.test(sha256) || actualSha256 !== sha256) {
    throw new ServiceError(
      'MAP_RASTER_MASK_HASH_MISMATCH',
      'Raster-mask SHA-256 does not match its decoded exact-pixel payload',
      { expected: sha256, actual: actualSha256 },
    );
  }
  if (
    !Number.isInteger(selectedPixelCount) ||
    selectedPixelCount < 0 ||
    selectedPixelCount !== actualSelectedPixelCount
  ) {
    throw new ServiceError(
      'MAP_RASTER_MASK_COUNT_MISMATCH',
      'Raster-mask selected-pixel count does not match its decoded payload',
      { expected: selectedPixelCount, actual: actualSelectedPixelCount },
    );
  }
  const result = new Uint32Array(selectedPixelCount);
  let selectedIndex = 0;
  for (let localY = 0; localY < height; localY += 1) {
    yield* cancellationCheckpoint(signal, localY, 16);
    for (let localX = 0; localX < width; localX += 1) {
      if (bytes[localY * width + localX] === 1) {
        result[selectedIndex] = (origin.y + localY) * raster.width + (origin.x + localX);
        selectedIndex += 1;
      }
    }
  }
  return result;
}

function* selectedPixels(
  index: MapWorkspaceIndex,
  provinceId: number,
  geometry: ProvinceGeometrySelection,
  signal?: AbortSignal,
): MapOperationSteps<Uint32Array> {
  yield* cancellationCheckpoint(signal);
  const raster = index.raster;
  if (raster === undefined)
    throw new ServiceError(
      'MAP_PROVINCE_BITMAP_MISSING',
      'Province geometry requires provinces.bmp',
    );
  if (geometry.kind === 'pixels') {
    assertSelectedPixelBudget(geometry.pixels.length, 'Explicit pixel geometry');
    const offsets = new Uint32Array(geometry.pixels.length);
    for (const [pointIndex, point] of geometry.pixels.entries()) {
      yield* cancellationCheckpoint(signal, pointIndex, 4096);
      if (
        !Number.isInteger(point.x) ||
        !Number.isInteger(point.y) ||
        point.x < 0 ||
        point.y < 0 ||
        point.x >= raster.width ||
        point.y >= raster.height
      ) {
        throw new ServiceError(
          'MAP_GEOMETRY_OUT_OF_BOUNDS',
          'Province geometry contains an out-of-bounds pixel',
          { ...point },
        );
      }
      const offset = point.y * raster.width + point.x;
      if (raster.provinceIds[offset] !== provinceId) {
        throw new ServiceError(
          'MAP_GEOMETRY_OUTSIDE_SOURCE',
          'Every selected pixel must belong to the source province',
          { ...point, provinceId },
        );
      }
      offsets[pointIndex] = offset;
    }
    offsets.sort();
    let uniqueCount = 0;
    let previous: number | undefined;
    for (const offset of offsets) {
      if (offset === previous) continue;
      offsets[uniqueCount] = offset;
      uniqueCount += 1;
      previous = offset;
    }
    return offsets.subarray(0, uniqueCount);
  }
  if (geometry.kind === 'mask') {
    const offsets = yield* rasterMaskPixels(raster, geometry, signal);
    for (let indexOffset = 0; indexOffset < offsets.length; indexOffset += 1) {
      yield* cancellationCheckpoint(signal, indexOffset, 4096);
      const offset = offsets[indexOffset];
      if (offset === undefined || raster.provinceIds[offset] !== provinceId) {
        const safeOffset = offset ?? 0;
        throw new ServiceError(
          'MAP_GEOMETRY_OUTSIDE_SOURCE',
          'Every selected pixel must belong to the source province',
          {
            x: safeOffset % raster.width,
            y: Math.floor(safeOffset / raster.width),
            provinceId,
          },
        );
      }
    }
    return offsets;
  }
  {
    if (geometry.points.length < 3)
      throw new ServiceError(
        'MAP_POLYGON_INVALID',
        'Province polygon requires at least three points',
      );
    let rawMinX = Number.POSITIVE_INFINITY;
    let rawMaxX = Number.NEGATIVE_INFINITY;
    let rawMinY = Number.POSITIVE_INFINITY;
    let rawMaxY = Number.NEGATIVE_INFINITY;
    for (const point of geometry.points) {
      rawMinX = Math.min(rawMinX, point.x);
      rawMaxX = Math.max(rawMaxX, point.x);
      rawMinY = Math.min(rawMinY, point.y);
      rawMaxY = Math.max(rawMaxY, point.y);
    }
    const minX = Math.max(0, Math.floor(rawMinX));
    const maxX = Math.min(raster.width - 1, Math.ceil(rawMaxX));
    const minY = Math.max(0, Math.floor(rawMinY));
    const maxY = Math.min(raster.height - 1, Math.ceil(rawMaxY));
    const width = Math.max(0, maxX - minX + 1);
    const height = Math.max(0, maxY - minY + 1);
    const cells = width * height;
    const work = cells * geometry.points.length;
    if (!Number.isSafeInteger(work) || work > MAP_POLYGON_WORK_LIMIT) {
      throw new ServiceError(
        'MAP_POLYGON_WORK_LIMIT',
        'Province polygon exceeds the configured geometry work budget',
      );
    }
    const offsets = new Uint32Array(Math.min(cells, MAP_SELECTED_PIXEL_LIMIT));
    let selectedCount = 0;
    let examined = 0;
    for (let y = minY; y <= maxY; y += 1) {
      yield* cancellationCheckpoint(signal, y - minY, 8);
      for (let x = minX; x <= maxX; x += 1) {
        yield* cancellationCheckpoint(signal, examined, 4_096);
        examined += 1;
        if (!pointInPolygon(x + 0.5, y + 0.5, geometry.points)) continue;
        if (selectedCount >= MAP_SELECTED_PIXEL_LIMIT) {
          assertSelectedPixelBudget(selectedCount + 1, 'Polygon geometry');
        }
        const offset = y * raster.width + x;
        if (raster.provinceIds[offset] !== provinceId) {
          throw new ServiceError(
            'MAP_GEOMETRY_OUTSIDE_SOURCE',
            'Every selected pixel must belong to the source province',
            { x, y, provinceId },
          );
        }
        offsets[selectedCount] = offset;
        selectedCount += 1;
      }
    }
    return offsets.subarray(0, selectedCount);
  }
}

function* provincePixelOffsets(
  raster: NonNullable<MapWorkspaceIndex['raster']>,
  provinceIds: ReadonlySet<number>,
  source: string,
  signal?: AbortSignal,
): MapOperationSteps<Uint32Array> {
  let expectedPixelCount = 0;
  for (const provinceId of provinceIds) {
    const pixelCount = raster.geometry.get(provinceId)?.pixelCount ?? 0;
    if (!Number.isSafeInteger(pixelCount) || pixelCount < 0) {
      throw new ServiceError(
        'MAP_RASTER_GEOMETRY_MISMATCH',
        `${source} cannot trust the indexed province pixel count`,
        { source, provinceId, pixelCount },
      );
    }
    expectedPixelCount += pixelCount;
  }
  assertSelectedPixelBudget(expectedPixelCount, source);
  const offsets = new Uint32Array(expectedPixelCount);
  let selectedCount = 0;
  for (let offset = 0; offset < raster.provinceIds.length; offset += 1) {
    yield* cancellationCheckpoint(signal, offset, 4096);
    if (!provinceIds.has(raster.provinceIds[offset] ?? -1)) continue;
    if (selectedCount >= offsets.length) {
      assertSelectedPixelBudget(selectedCount + 1, source);
      throw new ServiceError(
        'MAP_RASTER_GEOMETRY_MISMATCH',
        `${source} found more pixels than the indexed province geometry declared`,
        { source, expectedPixelCount, observedPixelCount: selectedCount + 1 },
      );
    }
    offsets[selectedCount] = offset;
    selectedCount += 1;
  }
  if (selectedCount !== expectedPixelCount) {
    throw new ServiceError(
      'MAP_RASTER_GEOMETRY_MISMATCH',
      `${source} found fewer pixels than the indexed province geometry declared`,
      { source, expectedPixelCount, observedPixelCount: selectedCount },
    );
  }
  return offsets;
}

function definitionFromOperation(
  source: ProvinceDefinition,
  operation: SplitProvinceOperation,
  id: number,
  allocatedColor: RgbColor,
): ProvinceDefinition {
  const values =
    operation.definition.method === 'inherit-source'
      ? {
          type: operation.definition.overrides?.type ?? source.type,
          coastal: operation.definition.overrides?.coastal ?? source.coastal,
          terrain: operation.definition.overrides?.terrain ?? source.terrain,
          continent: operation.definition.overrides?.continent ?? source.continent,
          color: operation.definition.overrides?.color ?? allocatedColor,
        }
      : {
          ...operation.definition.value,
          color: operation.definition.value.color ?? allocatedColor,
        };
  return {
    id,
    color: values.color,
    type: values.type,
    coastal: values.coastal,
    terrain: values.terrain,
    continent: values.continent,
    line: source.document.lines.length + 1,
    document: source.document,
  };
}

function requireSplitProvincePolicy(
  operation: SplitProvinceOperation,
  source: ProvinceDefinition,
): void {
  const policy = (
    operation as unknown as { distribution?: Partial<SplitProvinceDistributionPolicy> }
  ).distribution;
  if (
    policy?.strategicRegion !== 'inherit-source' ||
    policy.victoryPoints !== 'retain-source' ||
    policy.provinceBuildings !== 'retain-source' ||
    policy.ports !== 'retain-source' ||
    policy.supplyNodes !== 'retain-source' ||
    policy.railways !== 'retain-source' ||
    policy.adjacencies !== 'retain-source' ||
    policy.positions !== 'retain-source' ||
    policy.entityLocators !== 'retain-source' ||
    (source.type === 'land' ? policy.state !== 'inherit-source' : policy.state !== 'none')
  ) {
    throw new ServiceError(
      'MAP_PROVINCE_DISTRIBUTION_REQUIRED',
      'Province creation requires explicit compatible state, region, data, port, network, adjacency, position, and locator policies',
    );
  }
}

function* applySplitProvince(
  base: MapWorkspaceIndex,
  changes: Map<string, MutableChange>,
  allocations: AllocationEvidence[],
  operation: SplitProvinceOperation,
  signal?: AbortSignal,
): MapOperationSteps<PixelDiffBounds> {
  const index = currentIndex(base, changes);
  const source = index.definitionsById.get(operation.sourceProvinceId);
  const bitmap = index.provinceBitmap;
  if (source === undefined || bitmap?.bitsPerPixel !== 24) {
    throw new ServiceError(
      'MAP_PROVINCE_SOURCE_INVALID',
      'Province split requires an existing province and 24-bit provinces.bmp',
    );
  }
  requireSplitProvincePolicy(operation, source);
  const pixels = yield* selectedPixels(index, source.id, operation.geometry, signal);
  const total = index.raster?.geometry.get(source.id)?.pixelCount ?? 0;
  if (pixels.length === 0 || pixels.length >= total)
    throw new ServiceError(
      'MAP_PROVINCE_SPLIT_GEOMETRY_INVALID',
      'Split geometry must select some but not all source pixels',
    );
  const allocation = yield* allocateProvince(index, operation.provinceId, signal);
  const definition = definitionFromOperation(source, operation, allocation.id, allocation.color);
  if (definition.color.r === 0 && definition.color.g === 0 && definition.color.b === 0)
    throw new ServiceError('MAP_PROVINCE_COLOR_INVALID', 'Black cannot be allocated to a province');
  const existingColor = index.definitionsAcrossRoots.find(
    ({ color }) => rgbKey(color) === rgbKey(definition.color),
  );
  if (
    existingColor !== undefined ||
    index.raster?.unknownColors.some(({ color }) => rgbKey(color) === rgbKey(definition.color))
  ) {
    throw new ServiceError(
      existingColor !== undefined && !index.definitionsByColor.has(rgbKey(definition.color))
        ? 'MAP_DEPENDENCY_PROVINCE_COLOR_CONFLICT'
        : 'MAP_PROVINCE_COLOR_DUPLICATE',
      `Province color ${rgbKey(definition.color)} is already used`,
      {
        ...(existingColor === undefined ? {} : { source: existingColor.document.file.displayPath }),
      },
    );
  }
  allocations.push(
    ...allocation.evidence.map((evidence) =>
      evidence.kind === 'province-color'
        ? { ...evidence, allocated: rgbKey(definition.color) }
        : evidence,
    ),
  );
  const changedBitmap = bitmap.withRgbOffsets(pixels, definition.color);
  addChange(
    changes,
    required(
      index.provinceBitmapFile,
      'MAP_PROVINCE_BITMAP_MISSING',
      'Province bitmap file is missing',
    ).relativePath,
    changedBitmap.encode(),
    operation.id,
    'image/bmp',
  );
  addChange(
    changes,
    required(index.definitionFile, 'MAP_DEFINITION_FILE_MISSING', 'Definition file is missing')
      .relativePath,
    patchDefinitions(index, new Map(), new Set(), [definition]),
    operation.id,
    'text/plain',
  );
  if (source.type === 'land') {
    const stateId = stateMembershipId(index, source.id);
    if (stateId === undefined)
      throw new ServiceError(
        'MAP_STATE_MEMBERSHIP_MISSING',
        `Land province ${source.id} has no state`,
      );
    const state = required(
      index.statesById.get(stateId),
      'MAP_STATE_NOT_FOUND',
      `State ${stateId} does not exist`,
    );
    const data = cloneState(state);
    data.provinces = uniqueSorted([...data.provinces, definition.id]);
    commitState(changes, state, data, { provinces: true }, operation.id);
  }
  const sourceRegionId = regionMembershipId(index, source.id);
  const region = required(
    index.regionsById.get(sourceRegionId),
    'MAP_REGION_NOT_FOUND',
    `Strategic region ${sourceRegionId} does not exist`,
  );
  commitRegion(changes, region, uniqueSorted([...region.provinces, definition.id]), operation.id);
  return required(
    bitmap.diffBounds(changedBitmap),
    'MAP_PROVINCE_SPLIT_NO_CHANGE',
    'Province split did not change any bitmap pixel',
  );
}

function updateDefinitionValue(
  source: ProvinceDefinition,
  changes: ProvinceDefinitionInput,
): ProvinceDefinition {
  return {
    ...source,
    color: changes.color ?? source.color,
    type: changes.type ?? source.type,
    coastal: changes.coastal ?? source.coastal,
    terrain: changes.terrain ?? source.terrain,
    continent: changes.continent ?? source.continent,
  };
}

function requireProvinceTypeDistribution(
  operation: UpdateProvinceDefinitionOperation,
): ProvinceTypeDistributionPolicy {
  const distribution = (operation as unknown as { distribution?: unknown }).distribution;
  const expectedKeys = [
    'stateMembership',
    'stateValues',
    'strategicRegion',
    'victoryPoints',
    'provinceBuildings',
    'ports',
    'supplyNodes',
    'railways',
    'buildingPositions',
    'unitPositions',
    'entityLocators',
    'adjacencies',
  ].sort();
  if (distribution === null || typeof distribution !== 'object' || Array.isArray(distribution)) {
    throw new ServiceError(
      'MAP_PROVINCE_TYPE_DISTRIBUTION_REQUIRED',
      'Province type migration requires a complete explicit dependency distribution policy',
      { missing: expectedKeys },
    );
  }
  const object = distribution as Record<string, unknown>;
  const actualKeys = Object.keys(object).sort();
  const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
  const unexpected = actualKeys.filter((key) => !expectedKeys.includes(key));
  const stateMembership = object.stateMembership;
  const stateMembershipValid = (() => {
    if (
      stateMembership === null ||
      typeof stateMembership !== 'object' ||
      Array.isArray(stateMembership)
    )
      return false;
    const value = stateMembership as Record<string, unknown>;
    const keys = Object.keys(value).sort();
    if (value.method === 'retain') return keys.join(',') === 'method';
    return (
      (value.method === 'remove' || value.method === 'assign') &&
      keys.join(',') === 'method,stateId' &&
      Number.isSafeInteger(value.stateId) &&
      Number(value.stateId) > 0
    );
  })();
  const literalValid =
    object.stateValues === 'retain-in-current-states' &&
    object.strategicRegion === 'retain-membership' &&
    (object.victoryPoints === 'retain-if-valid' || object.victoryPoints === 'remove') &&
    (object.provinceBuildings === 'retain-if-valid' || object.provinceBuildings === 'remove') &&
    (object.ports === 'retain-if-valid' || object.ports === 'remove') &&
    (object.supplyNodes === 'retain-if-valid' || object.supplyNodes === 'remove') &&
    (object.railways === 'retain-if-valid' || object.railways === 'remove-containing') &&
    (object.buildingPositions === 'retain-if-valid' || object.buildingPositions === 'remove') &&
    (object.unitPositions === 'retain-if-valid' || object.unitPositions === 'remove') &&
    object.entityLocators === 'retain-at-coordinate' &&
    (object.adjacencies === 'retain-if-valid' || object.adjacencies === 'remove-referencing');
  if (missing.length > 0 || unexpected.length > 0 || !stateMembershipValid || !literalValid) {
    throw new ServiceError(
      'MAP_PROVINCE_TYPE_DISTRIBUTION_REQUIRED',
      'Province type migration requires every dependency policy with no unknown fields',
      {
        missing,
        unexpected,
        stateMembershipValid,
        literalPoliciesValid: literalValid,
      },
    );
  }
  return distribution as ProvinceTypeDistributionPolicy;
}

function provinceTypeDistributionConflict(
  source: ProvinceDefinition,
  targetType: SupportedProvinceType,
  field: string,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new ServiceError('MAP_PROVINCE_TYPE_DISTRIBUTION_INCONSISTENT', message, {
    provinceId: source.id,
    sourceType: source.type,
    targetType,
    field,
    ...details,
  });
}

interface PendingStatePatch {
  state: StateRecord;
  data: StateData;
  fields: StatePatchFields;
}

function* applyUpdateProvinceDefinition(
  base: MapWorkspaceIndex,
  changes: Map<string, MutableChange>,
  operation: UpdateProvinceDefinitionOperation,
  signal?: AbortSignal,
): MapOperationSteps<PixelDiffBounds | undefined> {
  const index = currentIndex(base, changes);
  const source = index.definitionsById.get(operation.provinceId);
  if (source === undefined)
    throw new ServiceError(
      'MAP_PROVINCE_NOT_FOUND',
      `Province ${operation.provinceId} does not exist`,
    );
  const updated = updateDefinitionValue(source, operation.changes);
  const typeChanged = updated.type !== source.type;
  if (!typeChanged && operation.distribution !== undefined)
    throw new ServiceError(
      'MAP_PROVINCE_TYPE_DISTRIBUTION_UNEXPECTED',
      'A province type distribution policy is only valid when the type actually changes',
      { provinceId: source.id, type: source.type },
    );
  const supportedTypes: readonly SupportedProvinceType[] = ['land', 'sea', 'lake'];
  if (typeChanged && !supportedTypes.includes(updated.type as SupportedProvinceType))
    throw new ServiceError(
      'MAP_PROVINCE_TYPE_INVALID',
      'Province type must be land, sea, or lake',
      { provinceId: source.id, type: updated.type },
    );
  const targetType = updated.type as SupportedProvinceType;
  if (typeChanged && !supportedTypes.includes(source.type as SupportedProvinceType))
    provinceTypeDistributionConflict(
      source,
      targetType,
      'type',
      'Cannot migrate from an unsupported source province type',
    );
  if (
    typeChanged &&
    targetType === 'sea' &&
    (updated.terrain !== 'ocean' || updated.continent !== 0)
  )
    provinceTypeDistributionConflict(
      source,
      targetType,
      'definition',
      'Sea migration requires ocean terrain and continent zero',
      { terrain: updated.terrain, continent: updated.continent },
    );
  if (
    typeChanged &&
    targetType === 'lake' &&
    (updated.terrain !== 'lakes' || updated.continent !== 0)
  )
    provinceTypeDistributionConflict(
      source,
      targetType,
      'definition',
      'Lake migration requires lakes terrain and continent zero',
      { terrain: updated.terrain, continent: updated.continent },
    );
  if (
    typeChanged &&
    targetType === 'land' &&
    (updated.continent === 0 || updated.terrain === 'ocean' || updated.terrain === 'lakes')
  )
    provinceTypeDistributionConflict(
      source,
      targetType,
      'definition',
      'Land migration requires a nonzero continent and non-water terrain',
      { terrain: updated.terrain, continent: updated.continent },
    );

  const statePatches = new Map<number, PendingStatePatch>();
  const statePatch = (state: StateRecord): PendingStatePatch => {
    const current = statePatches.get(state.id);
    if (current !== undefined) return current;
    const created = { state, data: cloneState(state), fields: {} };
    statePatches.set(state.id, created);
    return created;
  };
  const buildingPositionRemovals = new Set<BuildingPositionRecord>();
  const unitPositionRemovals = new Set<UnitPositionRecord>();
  const supplyNodeRemovals = new Set<(typeof index.supplyNodes)[number]>();
  const railwayRemovals = new Set<(typeof index.railways)[number]>();
  const adjacencyRemovals = new Set<AdjacencyRecord>();

  if (typeChanged) {
    const policy = requireProvinceTypeDistribution(operation);
    const sourceIsLand = source.type === 'land';
    const targetIsLand = targetType === 'land';
    const memberships = index.stateForProvince(source.id);
    if (memberships.length > 1)
      provinceTypeDistributionConflict(
        source,
        targetType,
        'stateMembership',
        'Province type migration cannot resolve multiple source-state memberships',
        { stateIds: memberships.map(({ id }) => id).sort((left, right) => left - right) },
      );
    const regionId = regionMembershipId(index, source.id);
    let projectedStateId: number | undefined;
    if (sourceIsLand && !targetIsLand) {
      const sourceState = memberships[0];
      if (
        sourceState === undefined ||
        policy.stateMembership.method !== 'remove' ||
        policy.stateMembership.stateId !== sourceState.id
      )
        provinceTypeDistributionConflict(
          source,
          targetType,
          'stateMembership',
          'Land-to-water migration must remove the province from its exact indexed state',
          {
            indexedStateId: sourceState?.id ?? null,
            policy: policy.stateMembership,
          },
        );
      const patch = statePatch(sourceState);
      patch.data.provinces = patch.data.provinces.filter((id) => id !== source.id);
      if (
        patch.data.provinces.length === 0 ||
        !patch.data.provinces.some((id) => index.definitionsById.get(id)?.type === 'land')
      )
        provinceTypeDistributionConflict(
          source,
          targetType,
          'stateMembership',
          'Type migration cannot leave the source state without a land province',
          { stateId: sourceState.id },
        );
      patch.fields.provinces = true;
    } else if (!sourceIsLand && targetIsLand) {
      if (memberships.length !== 0 || policy.stateMembership.method !== 'assign')
        provinceTypeDistributionConflict(
          source,
          targetType,
          'stateMembership',
          'Water-to-land migration requires one explicit target state and no existing state membership',
          {
            indexedStateIds: memberships.map(({ id }) => id).sort((left, right) => left - right),
            policy: policy.stateMembership,
          },
        );
      const targetState = index.statesById.get(policy.stateMembership.stateId);
      if (targetState === undefined)
        provinceTypeDistributionConflict(
          source,
          targetType,
          'stateMembership',
          'The explicit target state does not exist',
          { stateId: policy.stateMembership.stateId },
        );
      const targetRegionIds = new Set(
        targetState.provinces.map((id) => regionMembershipId(index, id)),
      );
      if (targetRegionIds.size > 1 || [...targetRegionIds].some((id) => id !== regionId))
        provinceTypeDistributionConflict(
          source,
          targetType,
          'strategicRegion',
          'The assigned state must remain inside the province strategic region',
          {
            stateId: targetState.id,
            provinceRegionId: regionId,
            stateRegionIds: [...targetRegionIds].sort((left, right) => left - right),
          },
        );
      const patch = statePatch(targetState);
      patch.data.provinces = uniqueSorted([...patch.data.provinces, source.id]);
      patch.fields.provinces = true;
      projectedStateId = targetState.id;
    } else {
      if (memberships.length !== 0 || policy.stateMembership.method !== 'retain')
        provinceTypeDistributionConflict(
          source,
          targetType,
          'stateMembership',
          'Water-to-water migration must explicitly retain an empty state membership',
          {
            indexedStateIds: memberships.map(({ id }) => id).sort((left, right) => left - right),
            policy: policy.stateMembership,
          },
        );
    }

    const victoryPoints = index.victoryPointsByProvince.get(source.id) ?? [];
    if (
      policy.victoryPoints === 'retain-if-valid' &&
      victoryPoints.some(({ stateId }) => stateId !== projectedStateId)
    )
      provinceTypeDistributionConflict(
        source,
        targetType,
        'victoryPoints',
        'Retained victory points would not belong to the projected land state',
        { stateIds: victoryPoints.map(({ stateId }) => stateId) },
      );
    if (policy.victoryPoints === 'remove') {
      for (const { stateId } of victoryPoints) {
        const state = index.statesById.get(stateId);
        if (state === undefined) continue;
        const patch = statePatch(state);
        patch.data.victoryPoints = patch.data.victoryPoints.filter(
          ({ provinceId }) => provinceId !== source.id,
        );
        patch.fields.victoryPoints = true;
      }
    }

    const provinceBuildingEntries = index.provinceBuildingsByProvince.get(source.id) ?? [];
    const nonPortBuildingEntries = provinceBuildingEntries.filter(({ buildings }) =>
      [...buildings.keys()].some((building) => building !== 'naval_base'),
    );
    if (
      policy.provinceBuildings === 'retain-if-valid' &&
      nonPortBuildingEntries.some(({ stateId }) => stateId !== projectedStateId)
    )
      provinceTypeDistributionConflict(
        source,
        targetType,
        'provinceBuildings',
        'Retained province buildings would not belong to the projected land state',
        { stateIds: nonPortBuildingEntries.map(({ stateId }) => stateId) },
      );
    if (policy.provinceBuildings === 'remove') {
      for (const { stateId } of nonPortBuildingEntries) {
        const state = index.statesById.get(stateId);
        if (state === undefined) continue;
        const patch = statePatch(state);
        const buildings = new Map(patch.data.provinceBuildings.get(source.id) ?? []);
        for (const building of [...buildings.keys()])
          if (building !== 'naval_base') buildings.delete(building);
        if (buildings.size === 0) patch.data.provinceBuildings.delete(source.id);
        else patch.data.provinceBuildings.set(source.id, buildings);
        patch.fields.buildings = true;
      }
    }

    const isPortPosition = ({ building }: BuildingPositionRecord): boolean =>
      building === 'naval_base_spawn' || building === 'floating_harbor';
    const dependentPortPositions = index.buildingPositions.filter((position) => {
      if (!isPortPosition(position)) return false;
      return (
        index.provinceAtMapCoordinate(position.x, position.z) === source.id ||
        position.adjacentSeaProvince === source.id
      );
    });
    const dependentPortBuildings = new Map<string, { stateId: number; provinceId: number }>();
    for (const { stateId, buildings } of provinceBuildingEntries) {
      if ((buildings.get('naval_base') ?? 0) > 0)
        dependentPortBuildings.set(`${stateId}:${source.id}`, {
          stateId,
          provinceId: source.id,
        });
    }
    for (const position of dependentPortPositions) {
      const provinceId = index.provinceAtMapCoordinate(position.x, position.z);
      const buildings =
        provinceId === undefined
          ? undefined
          : index.statesById.get(position.stateId)?.provinceBuildings.get(provinceId);
      if (provinceId !== undefined && (buildings?.get('naval_base') ?? 0) > 0)
        dependentPortBuildings.set(`${position.stateId}:${provinceId}`, {
          stateId: position.stateId,
          provinceId,
        });
    }
    if (policy.ports === 'retain-if-valid') {
      for (const position of dependentPortPositions) {
        const locatedProvince = index.provinceAtMapCoordinate(position.x, position.z);
        if (
          (locatedProvince === source.id &&
            (targetType !== 'land' ||
              position.stateId !== projectedStateId ||
              !updated.coastal ||
              index.definitionsById.get(position.adjacentSeaProvince)?.type !== 'sea')) ||
          (position.adjacentSeaProvince === source.id && targetType !== 'sea')
        )
          provinceTypeDistributionConflict(
            source,
            targetType,
            'ports',
            'A retained port placement would no longer identify compatible land and sea provinces',
            {
              stateId: position.stateId,
              locatedProvince: locatedProvince ?? null,
              adjacentSeaProvince: position.adjacentSeaProvince,
            },
          );
      }
      for (const { stateId, provinceId } of dependentPortBuildings.values()) {
        if (
          provinceId === source.id
            ? targetType !== 'land' || stateId !== projectedStateId || !updated.coastal
            : targetType !== 'sea'
        )
          provinceTypeDistributionConflict(
            source,
            targetType,
            'ports',
            'A retained naval base would not have compatible projected province types',
            { stateId, portProvinceId: provinceId },
          );
      }
    } else {
      for (const position of dependentPortPositions) buildingPositionRemovals.add(position);
      for (const { stateId, provinceId } of dependentPortBuildings.values()) {
        const state = index.statesById.get(stateId);
        if (state === undefined) continue;
        const patch = statePatch(state);
        const buildings = new Map(patch.data.provinceBuildings.get(provinceId) ?? []);
        buildings.delete('naval_base');
        if (buildings.size === 0) patch.data.provinceBuildings.delete(provinceId);
        else patch.data.provinceBuildings.set(provinceId, buildings);
        patch.fields.buildings = true;
      }
    }

    const nonPortPositions = index.buildingPositions.filter((position) => {
      if (isPortPosition(position)) return false;
      return (
        index.provinceAtMapCoordinate(position.x, position.z) === source.id ||
        position.adjacentSeaProvince === source.id
      );
    });
    if (policy.buildingPositions === 'retain-if-valid') {
      for (const position of nonPortPositions) {
        const locatedProvince = index.provinceAtMapCoordinate(position.x, position.z);
        if (
          (locatedProvince === source.id &&
            (targetType !== 'land' || position.stateId !== projectedStateId)) ||
          (position.adjacentSeaProvince === source.id && targetType !== 'sea')
        )
          provinceTypeDistributionConflict(
            source,
            targetType,
            'buildingPositions',
            'A retained building position would no longer resolve in a compatible state/province',
            { stateId: position.stateId, locatedProvince: locatedProvince ?? null },
          );
      }
    } else {
      for (const position of nonPortPositions) buildingPositionRemovals.add(position);
    }

    const unitPositions = index.unitPositions.filter(({ provinceId }) => provinceId === source.id);
    if (policy.unitPositions === 'remove')
      for (const position of unitPositions) unitPositionRemovals.add(position);

    const supplyNodes = index.supplyNodes.filter(({ provinceId }) => provinceId === source.id);
    if (policy.supplyNodes === 'retain-if-valid' && targetType !== 'land' && supplyNodes.length > 0)
      provinceTypeDistributionConflict(
        source,
        targetType,
        'supplyNodes',
        'Supply nodes can only be retained in a stateful land province',
        { count: supplyNodes.length },
      );
    if (policy.supplyNodes === 'remove')
      for (const node of supplyNodes) supplyNodeRemovals.add(node);

    const railways = index.railways.filter(({ provinces }) => provinces.includes(source.id));
    if (policy.railways === 'retain-if-valid' && targetType !== 'land' && railways.length > 0)
      provinceTypeDistributionConflict(
        source,
        targetType,
        'railways',
        'Railway routes can only be retained through a stateful land province',
        { indexes: railways.map((railway) => index.railways.indexOf(railway)) },
      );
    if (policy.railways === 'remove-containing')
      for (const railway of railways) railwayRemovals.add(railway);

    const adjacencies = index.adjacencies.filter(
      ({ from, to, through }) => from === source.id || to === source.id || through === source.id,
    );
    if (policy.adjacencies === 'retain-if-valid') {
      for (const adjacency of adjacencies) {
        const otherId = adjacency.from === source.id ? adjacency.to : adjacency.from;
        const otherType = index.definitionsById.get(otherId)?.type;
        const incompatible =
          adjacency.type === 'sea'
            ? ((adjacency.from === source.id || adjacency.to === source.id) &&
                otherType !== targetType) ||
              (adjacency.through === source.id && targetType !== 'sea')
            : adjacency.type === 'impassable' &&
              (adjacency.from === source.id || adjacency.to === source.id) &&
              targetType !== 'land';
        if (incompatible)
          provinceTypeDistributionConflict(
            source,
            targetType,
            'adjacencies',
            'A retained special adjacency would be incompatible with the target province type',
            {
              from: adjacency.from,
              to: adjacency.to,
              through: adjacency.through,
              type: adjacency.type,
            },
          );
      }
    } else {
      for (const adjacency of adjacencies) adjacencyRemovals.add(adjacency);
    }
  }

  const colorChanged = rgbKey(updated.color) !== rgbKey(source.color);
  if (colorChanged) {
    const crossRootCollision = index.definitionsAcrossRoots.find(
      ({ id, color }) => id !== source.id && rgbKey(color) === rgbKey(updated.color),
    );
    if (rgbKey(updated.color) === '0,0,0' || crossRootCollision !== undefined) {
      throw new ServiceError(
        crossRootCollision !== undefined && !index.definitionsByColor.has(rgbKey(updated.color))
          ? 'MAP_DEPENDENCY_PROVINCE_COLOR_CONFLICT'
          : 'MAP_PROVINCE_COLOR_DUPLICATE',
        `Province color ${rgbKey(updated.color)} is invalid or already used`,
        {
          ...(crossRootCollision === undefined
            ? {}
            : { source: crossRootCollision.document.file.displayPath }),
        },
      );
    }
  }
  for (const { state, data, fields } of [...statePatches.values()].sort(
    (left, right) => left.state.id - right.state.id,
  ))
    commitState(changes, state, data, fields, operation.id);
  const removeRows = (records: ReadonlySet<{ line: number; document: TextFileDocument }>): void => {
    const groups = new Map<string, { document: TextFileDocument; lines: Set<number> }>();
    for (const record of records) {
      const key = record.document.file.relativePath;
      const group = groups.get(key) ?? { document: record.document, lines: new Set<number>() };
      group.lines.add(record.line);
      groups.set(key, group);
    }
    for (const [relativePath, { document, lines }] of groups)
      addChange(
        changes,
        relativePath,
        deleteLines(
          document,
          [...lines].sort((left, right) => left - right),
        ),
        operation.id,
        'text/plain',
      );
  };
  removeRows(buildingPositionRemovals);
  removeRows(unitPositionRemovals);
  removeRows(supplyNodeRemovals);
  removeRows(railwayRemovals);
  removeRows(adjacencyRemovals);
  addChange(
    changes,
    required(index.definitionFile, 'MAP_DEFINITION_FILE_MISSING', 'Definition file is missing')
      .relativePath,
    patchDefinitions(index, new Map([[source.id, updated]]), new Set(), []),
    operation.id,
    'text/plain',
  );
  if (!colorChanged) return undefined;
  const bitmap = index.provinceBitmap;
  const raster = index.raster;
  if (bitmap === undefined || raster === undefined || bitmap.bitsPerPixel !== 24)
    throw new ServiceError(
      'MAP_PROVINCE_BITMAP_MISSING',
      'Color change requires a 24-bit province bitmap',
    );
  const pixels = yield* provincePixelOffsets(
    raster,
    new Set([source.id]),
    'Province color update',
    signal,
  );
  const next = bitmap.withRgbOffsets(pixels, updated.color);
  addChange(
    changes,
    required(
      index.provinceBitmapFile,
      'MAP_PROVINCE_BITMAP_MISSING',
      'Province bitmap file is missing',
    ).relativePath,
    next.encode(),
    operation.id,
    'image/bmp',
  );
  return bitmap.diffBounds(next);
}

function remapStateProvinceData(
  data: StateData,
  provinceIds: ReadonlyMap<number, number>,
): StatePatchFields {
  const fields: StatePatchFields = {};
  if (data.provinces.some((id) => remapProvinceId(provinceIds, id) !== id)) {
    data.provinces = uniqueSorted(data.provinces.map((id) => remapProvinceId(provinceIds, id)));
    fields.provinces = true;
  }
  if (
    data.victoryPoints.some(
      ({ provinceId }) => remapProvinceId(provinceIds, provinceId) !== provinceId,
    )
  ) {
    const vpTotals = new Map<number, number>();
    for (const point of data.victoryPoints) {
      const provinceId = remapProvinceId(provinceIds, point.provinceId);
      vpTotals.set(provinceId, (vpTotals.get(provinceId) ?? 0) + point.value);
    }
    data.victoryPoints = [...vpTotals].map(([provinceId, value]) => ({ provinceId, value }));
    fields.victoryPoints = true;
  }
  if (
    [...data.provinceBuildings.keys()].some(
      (provinceId) => remapProvinceId(provinceIds, provinceId) !== provinceId,
    )
  ) {
    const buildingTotals = new Map<number, Map<string, number>>();
    for (const [provinceId, buildings] of data.provinceBuildings) {
      const remappedId = remapProvinceId(provinceIds, provinceId);
      const totals = buildingTotals.get(remappedId) ?? new Map<string, number>();
      addMaps(totals, buildings);
      buildingTotals.set(remappedId, totals);
    }
    data.provinceBuildings = buildingTotals;
    fields.buildings = true;
  }
  return fields;
}

function remapProvinceId(provinceIds: ReadonlyMap<number, number>, provinceId: number): number {
  return provinceIds.get(provinceId) ?? provinceId;
}

function compactedProvinceIds(
  index: MapWorkspaceIndex,
  sources: ReadonlySet<number>,
  target: number,
): ReadonlyMap<number, number> {
  const ids = uniqueSorted(index.definitions.map(({ id }) => id));
  const duplicateIds = [...index.duplicateDefinitionIds]
    .filter(([, definitions]) => definitions.length > 1)
    .map(([id]) => id);
  const duplicateColors = [...index.duplicateColors]
    .filter(([, definitions]) => definitions.length > 1)
    .map(([color]) => color);
  if (duplicateIds.length > 0 || duplicateColors.length > 0)
    throw new ServiceError(
      'MAP_PROVINCE_ID_RENUMBER_AMBIGUOUS',
      'Province IDs cannot be compacted while the active definition table has duplicate IDs or colors',
      { duplicateIds, duplicateColors },
    );
  if (!contiguous(ids, 0))
    throw new ServiceError(
      'MAP_PROVINCE_ID_GAP',
      'Province IDs must be contiguous from zero before a merge can compact them safely',
      { ids },
    );
  const result = new Map<number, number>();
  let nextId = 0;
  for (const id of ids) {
    if (sources.has(id)) continue;
    result.set(id, nextId);
    nextId += 1;
  }
  const remappedTarget = result.get(target);
  if (remappedTarget === undefined)
    throw new ServiceError(
      'MAP_PROVINCE_ID_RENUMBER_AMBIGUOUS',
      'Province merge target did not survive ID compaction',
      { target },
    );
  for (const source of sources) result.set(source, remappedTarget);
  return result;
}

function* applyMergeProvinces(
  base: MapWorkspaceIndex,
  changes: Map<string, MutableChange>,
  operation: MergeProvincesOperation | (RemoveProvinceOperation & { kind: 'remove_province' }),
  signal?: AbortSignal,
): MapOperationSteps<PixelDiffBounds> {
  if (
    !samePolicy(operation.distribution, {
      membership: 'require-same',
      victoryPoints: 'sum-into-target',
      provinceBuildings: 'sum-into-target',
      references: 'remap-to-target-and-deduplicate',
    })
  ) {
    throw new ServiceError(
      'MAP_PROVINCE_DISTRIBUTION_REQUIRED',
      'Province merge requires complete explicit membership, data, and reference policies',
    );
  }
  const index = currentIndex(base, changes);
  const sourceIds =
    operation.kind === 'remove_province'
      ? [operation.provinceId]
      : uniqueSorted(operation.sourceProvinceIds);
  const targetId =
    operation.kind === 'remove_province'
      ? operation.mergeIntoProvinceId
      : operation.targetProvinceId;
  const sources = sourceIds.filter((id) => id !== targetId);
  const target = index.definitionsById.get(targetId);
  if (
    target === undefined ||
    sources.length === 0 ||
    sources.some((id) => !index.definitionsById.has(id))
  ) {
    throw new ServiceError(
      'MAP_PROVINCE_SELECTION_INVALID',
      'Merge target and source provinces must exist and differ',
    );
  }
  const sourceSet = new Set(sources);
  const provinceIds = compactedProvinceIds(index, sourceSet, targetId);
  const definitions = [
    target,
    ...sources.map((id) =>
      required(
        index.definitionsById.get(id),
        'MAP_PROVINCE_NOT_FOUND',
        `Province ${id} does not exist`,
      ),
    ),
  ];
  if (definitions.some(({ type }) => type !== target.type))
    throw new ServiceError(
      'MAP_PROVINCE_TYPE_MISMATCH',
      'Merged provinces must have the same type',
    );
  const stateIds = new Set(definitions.map(({ id }) => stateMembershipId(index, id) ?? -1));
  const regionIds = new Set(definitions.map(({ id }) => regionMembershipId(index, id)));
  if (stateIds.size !== 1 || regionIds.size !== 1)
    throw new ServiceError(
      'MAP_PROVINCE_MEMBERSHIP_MISMATCH',
      'Merged provinces must share state and strategic-region membership',
    );
  const bitmap = index.provinceBitmap;
  const raster = index.raster;
  if (bitmap === undefined || raster === undefined || bitmap.bitsPerPixel !== 24)
    throw new ServiceError(
      'MAP_PROVINCE_BITMAP_MISSING',
      'Province merge requires a 24-bit province bitmap',
    );
  const pixelOffsets = yield* provincePixelOffsets(
    raster,
    sourceSet,
    'Province merge recolor',
    signal,
  );
  const nextBitmap = bitmap.withRgbOffsets(pixelOffsets, target.color);
  addChange(
    changes,
    required(
      index.provinceBitmapFile,
      'MAP_PROVINCE_BITMAP_MISSING',
      'Province bitmap file is missing',
    ).relativePath,
    nextBitmap.encode(),
    operation.id,
    'image/bmp',
  );
  const mergedCoastal = definitions.some(({ coastal }) => coastal);
  const definitionUpdates = new Map<number, ProvinceDefinition>();
  for (const definition of index.definitions) {
    if (sourceSet.has(definition.id)) continue;
    const remappedId = required(
      provinceIds.get(definition.id),
      'MAP_PROVINCE_ID_RENUMBER_AMBIGUOUS',
      `Province ${definition.id} has no compacted ID`,
    );
    const coastal = definition.id === targetId ? mergedCoastal : definition.coastal;
    if (remappedId !== definition.id || coastal !== definition.coastal)
      definitionUpdates.set(definition.id, { ...definition, id: remappedId, coastal });
  }
  addChange(
    changes,
    required(index.definitionFile, 'MAP_DEFINITION_FILE_MISSING', 'Definition file is missing')
      .relativePath,
    patchDefinitions(index, definitionUpdates, sourceSet, []),
    operation.id,
    'text/plain',
  );
  for (const state of index.states) {
    const data = cloneState(state);
    const fields = remapStateProvinceData(data, provinceIds);
    if (Object.values(fields).some((changed) => changed === true))
      commitState(changes, state, data, fields, operation.id);
  }
  for (const region of index.regions) {
    if (!region.provinces.some((id) => remapProvinceId(provinceIds, id) !== id)) continue;
    commitRegion(
      changes,
      region,
      uniqueSorted(region.provinces.map((id) => remapProvinceId(provinceIds, id))),
      operation.id,
    );
  }
  remapReferenceFiles(index, changes, provinceIds, operation.id);
  return required(
    bitmap.diffBounds(nextBitmap),
    'MAP_PROVINCE_MERGE_NO_CHANGE',
    'Province merge did not change any bitmap pixel',
  );
}

function applyMoveRegions(
  base: MapWorkspaceIndex,
  changes: Map<string, MutableChange>,
  operation: MoveRegionProvincesOperation,
): void {
  if ((operation as unknown as { distribution?: unknown }).distribution !== 'move-membership')
    throw new ServiceError(
      'MAP_REGION_DISTRIBUTION_REQUIRED',
      'Region move requires explicit move-membership policy',
    );
  const index = currentIndex(base, changes);
  const source = index.regionsById.get(operation.sourceRegionId);
  const target = index.regionsById.get(operation.targetRegionId);
  const ids = uniqueSorted(operation.provinceIds);
  if (
    source === undefined ||
    target === undefined ||
    source.id === target.id ||
    ids.length === 0 ||
    ids.some((id) => !source.provinces.includes(id))
  ) {
    throw new ServiceError(
      'MAP_REGION_SELECTION_INVALID',
      'Region source, target, and provinces are invalid',
    );
  }
  const selected = new Set(ids);
  commitRegion(
    changes,
    source,
    source.provinces.filter((id) => !selected.has(id)),
    operation.id,
  );
  commitRegion(changes, target, uniqueSorted([...target.provinces, ...ids]), operation.id);
}

function hasNormalAdjacency(index: MapWorkspaceIndex, from: number, to: number): boolean {
  return index.raster?.adjacency.get(from)?.has(to) ?? false;
}

function* applyNormalAdjacency(
  base: MapWorkspaceIndex,
  changes: Map<string, MutableChange>,
  operation: NormalAdjacencyOperation,
  signal?: AbortSignal,
): MapOperationSteps<PixelDiffBounds> {
  const index = currentIndex(base, changes);
  const bitmap = index.provinceBitmap;
  const raster = index.raster;
  if (bitmap?.bitsPerPixel !== 24 || raster === undefined) {
    throw new ServiceError(
      'MAP_PROVINCE_BITMAP_MISSING',
      'Normal adjacency edits require an active 24-bit provinces bitmap',
    );
  }
  if (
    operation.from === operation.to ||
    !index.definitionsById.has(operation.from) ||
    !index.definitionsById.has(operation.to)
  ) {
    throw new ServiceError(
      'MAP_NORMAL_ADJACENCY_PROVINCE_INVALID',
      'Normal adjacency endpoints must be different existing provinces',
      { from: operation.from, to: operation.to },
    );
  }
  const existsBefore = hasNormalAdjacency(index, operation.from, operation.to);
  if (operation.kind === 'add_normal_adjacency' && existsBefore) {
    throw new ServiceError(
      'MAP_NORMAL_ADJACENCY_ALREADY_EXISTS',
      'Requested normal adjacency already exists in the active province raster',
      { from: operation.from, to: operation.to },
    );
  }
  if (operation.kind === 'remove_normal_adjacency' && !existsBefore) {
    throw new ServiceError(
      'MAP_NORMAL_ADJACENCY_NOT_FOUND',
      'Requested normal adjacency does not exist in the active province raster',
      { from: operation.from, to: operation.to },
    );
  }
  if (!Array.isArray(operation.pixelTransfers) || operation.pixelTransfers.length === 0) {
    throw new ServiceError(
      'MAP_NORMAL_ADJACENCY_GEOMETRY_REQUIRED',
      'Normal adjacency edits require one or more exact pixel transfers',
    );
  }
  assertSelectedPixelBudget(operation.pixelTransfers.length, 'Normal adjacency pixel transfers');
  const pair = new Set([operation.from, operation.to]);
  const seen = new Set<number>();
  const pixelOffsets = new Uint32Array(operation.pixelTransfers.length);
  const packedColors = new Uint32Array(operation.pixelTransfers.length);
  for (const [transferIndex, transfer] of operation.pixelTransfers.entries()) {
    yield* cancellationCheckpoint(signal, transferIndex, 4096);
    if (
      !Number.isInteger(transfer.x) ||
      !Number.isInteger(transfer.y) ||
      transfer.x < 0 ||
      transfer.y < 0 ||
      transfer.x >= raster.width ||
      transfer.y >= raster.height
    ) {
      throw new ServiceError(
        'MAP_GEOMETRY_OUT_OF_BOUNDS',
        'Normal adjacency pixel transfer is outside the active province raster',
        { x: transfer.x, y: transfer.y },
      );
    }
    const pixelOffset = transfer.y * raster.width + transfer.x;
    if (seen.has(pixelOffset)) {
      throw new ServiceError(
        'MAP_NORMAL_ADJACENCY_TRANSFER_DUPLICATE',
        'Normal adjacency pixel transfers must have unique coordinates',
        { x: transfer.x, y: transfer.y },
      );
    }
    seen.add(pixelOffset);
    if (
      transfer.sourceProvinceId === transfer.targetProvinceId ||
      !index.definitionsById.has(transfer.sourceProvinceId) ||
      !index.definitionsById.has(transfer.targetProvinceId)
    ) {
      throw new ServiceError(
        'MAP_NORMAL_ADJACENCY_TRANSFER_PROVINCE_INVALID',
        'Normal adjacency transfer source and target must be different existing provinces',
        { ...transfer },
      );
    }
    if (!pair.has(transfer.sourceProvinceId) && !pair.has(transfer.targetProvinceId)) {
      throw new ServiceError(
        'MAP_NORMAL_ADJACENCY_TRANSFER_UNRELATED',
        'Every normal adjacency transfer must involve at least one requested endpoint',
        { ...transfer, from: operation.from, to: operation.to },
      );
    }
    const observed = raster.provinceIds[pixelOffset];
    if (observed !== transfer.sourceProvinceId) {
      throw new ServiceError(
        'MAP_NORMAL_ADJACENCY_TRANSFER_SOURCE_MISMATCH',
        'Normal adjacency transfer source does not match the active province raster',
        { ...transfer, observedProvinceId: observed },
      );
    }
    const target = required(
      index.definitionsById.get(transfer.targetProvinceId),
      'MAP_NORMAL_ADJACENCY_TRANSFER_PROVINCE_INVALID',
      'Normal adjacency transfer target province does not exist',
    );
    pixelOffsets[transferIndex] = pixelOffset;
    packedColors[transferIndex] = packedRgb(target.color);
  }
  const nextBitmap = bitmap.withPackedRgbOffsetChanges(pixelOffsets, packedColors);
  const bounds = required(
    bitmap.diffBounds(nextBitmap),
    'MAP_NORMAL_ADJACENCY_GEOMETRY_REQUIRED',
    'Normal adjacency pixel transfers do not change the province raster',
  );
  const bitmapFile = required(
    index.provinceBitmapFile,
    'MAP_PROVINCE_BITMAP_MISSING',
    'Province bitmap file is missing',
  );
  addChange(changes, bitmapFile.relativePath, nextBitmap.encode(), operation.id, 'image/bmp');
  const proposed = currentIndex(base, changes);
  const existsAfter = hasNormalAdjacency(proposed, operation.from, operation.to);
  const expectedAfter = operation.kind === 'add_normal_adjacency';
  if (existsAfter !== expectedAfter) {
    throw new ServiceError(
      'MAP_NORMAL_ADJACENCY_RESULT_MISMATCH',
      'Exact pixel transfers did not produce the requested normal adjacency result',
      {
        from: operation.from,
        to: operation.to,
        expectedAfter,
        actualAfter: existsAfter,
        changedPixels: bounds.count,
      },
    );
  }
  return bounds;
}

function formatAdjacency(adjacency: Omit<AdjacencyRecord, 'index' | 'line' | 'document'>): string {
  return [
    adjacency.from,
    adjacency.to,
    adjacency.type,
    adjacency.through,
    numberText(adjacency.startX),
    numberText(adjacency.startY),
    numberText(adjacency.stopX),
    numberText(adjacency.stopY),
    adjacency.rule,
    adjacency.comment,
  ].join(';');
}

function findActiveFile(index: MapWorkspaceIndex, relativePath: string): ScannedFile {
  const normalized = normalizeRelative(relativePath);
  let file = index.activeFiles.byRelativePath.get(normalized);
  if (file === undefined && normalized.startsWith('map/')) {
    const filename = normalized.slice('map/'.length);
    for (const root of index.sourceRoots.map) {
      file = index.activeFiles.byRelativePath.get(normalizeRelative(`${root}/${filename}`));
      if (file !== undefined) break;
    }
  }
  if (file === undefined)
    throw new ServiceError('MAP_FILE_MISSING', `Required map file is missing: ${relativePath}`);
  return file;
}

function appendBeforeSentinel(document: TextFileDocument, text: string): Buffer {
  const sentinel = document.lines.find((line) => line.text.trim().startsWith('-1;'));
  const offset = sentinel?.start ?? document.text.length;
  const prefix =
    offset === 0 || /(?:\r\n|\n|\r)$/u.test(document.text.slice(0, offset)) ? '' : document.newline;
  return applyTextRanges(document, [
    {
      start: offset,
      end: offset,
      text: `${prefix}${text}${document.newline}`,
      description: 'Append map row',
    },
  ]);
}

function deleteLines(document: TextFileDocument, lineNumbers: readonly number[]): Buffer {
  const wanted = new Set(lineNumbers);
  return applyTextRanges(
    document,
    document.lines
      .filter((line) => wanted.has(line.index + 1))
      .map((line) => ({
        start: line.start,
        end: line.fullEnd,
        text: '',
        description: 'Remove map row',
      })),
  );
}

function replaceLine(document: TextFileDocument, lineNumber: number, text: string): Buffer {
  const line = document.lines[lineNumber - 1];
  if (line === undefined)
    throw new ServiceError('MAP_POSITION_ROW_MISSING', `Map row ${lineNumber} does not exist`);
  return applyTextRanges(document, [
    { start: line.start, end: line.end, text, description: 'Update map row' },
  ]);
}

function appendLine(document: TextFileDocument, text: string): Buffer {
  const prefix =
    document.text.length === 0 || /(?:\r\n|\n|\r)$/u.test(document.text) ? '' : document.newline;
  return applyTextRanges(document, [
    {
      start: document.text.length,
      end: document.text.length,
      text: `${prefix}${text}${document.newline}`,
      description: 'Append map row',
    },
  ]);
}

function occurrence<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
  selected = 0,
): T | undefined {
  return values.filter(predicate)[selected];
}

function handleSimpleOperation(
  base: MapWorkspaceIndex,
  changes: Map<string, MutableChange>,
  operation: SimpleMapOperation,
): void {
  const index = currentIndex(base, changes);
  if (operation.kind === 'add_adjacency') {
    const file = required(
      index.adjacencyFile,
      'MAP_ADJACENCY_FILE_MISSING',
      'The default.map adjacency file is missing',
    );
    const document = parseTextDocument(file);
    addChange(
      changes,
      file.relativePath,
      appendBeforeSentinel(document, formatAdjacency(operation.adjacency)),
      operation.id,
      'text/plain',
    );
  } else if (operation.kind === 'remove_adjacency') {
    const matching = index.adjacencies.filter(
      ({ from, to, type }) =>
        ((from === operation.from && to === operation.to) ||
          (from === operation.to && to === operation.from)) &&
        (operation.type === undefined || type === operation.type),
    );
    if (matching.length === 0)
      throw new ServiceError('MAP_ADJACENCY_NOT_FOUND', 'No matching adjacency exists');
    const document = required(
      matching[0],
      'MAP_ADJACENCY_NOT_FOUND',
      'No matching adjacency exists',
    ).document;
    addChange(
      changes,
      document.file.relativePath,
      deleteLines(
        document,
        matching.map(({ line }) => line),
      ),
      operation.id,
      'text/plain',
    );
  } else if (operation.kind === 'add_supply_node') {
    const file = required(
      index.supplyNodeFile,
      'MAP_SUPPLY_NODE_FILE_MISSING',
      'The default.map supply-node file is missing',
    );
    const document = parseTextDocument(file);
    addChange(
      changes,
      file.relativePath,
      appendLine(document, `${operation.level} ${operation.provinceId}`),
      operation.id,
      'text/plain',
    );
  } else if (operation.kind === 'remove_supply_node') {
    const matching = index.supplyNodes.filter(
      ({ provinceId }) => provinceId === operation.provinceId,
    );
    if (matching.length === 0)
      throw new ServiceError('MAP_SUPPLY_NODE_NOT_FOUND', 'No matching supply node exists');
    const document = required(
      matching[0],
      'MAP_SUPPLY_NODE_NOT_FOUND',
      'No matching supply node exists',
    ).document;
    addChange(
      changes,
      document.file.relativePath,
      deleteLines(
        document,
        matching.map(({ line }) => line),
      ),
      operation.id,
      'text/plain',
    );
  } else if (operation.kind === 'add_railway') {
    const file = required(
      index.railwayFile,
      'MAP_RAILWAY_FILE_MISSING',
      'The default.map railway file is missing',
    );
    const document = parseTextDocument(file);
    const provinces = uniqueConsecutive(operation.provinces);
    addChange(
      changes,
      file.relativePath,
      appendLine(document, `${operation.level} ${provinces.length} ${provinces.join(' ')}`),
      operation.id,
      'text/plain',
    );
  } else if (operation.kind === 'remove_railway') {
    const railway = index.railways[operation.index];
    if (railway === undefined)
      throw new ServiceError(
        'MAP_RAILWAY_NOT_FOUND',
        `Railway index ${operation.index} does not exist`,
      );
    addChange(
      changes,
      railway.document.file.relativePath,
      deleteLines(railway.document, [railway.line]),
      operation.id,
      'text/plain',
    );
  } else if (
    operation.kind === 'upsert_building_position' ||
    operation.kind === 'remove_building_position'
  ) {
    const record = occurrence(
      index.buildingPositions,
      ({ stateId, building }) =>
        stateId === operation.match.stateId && building === operation.match.building,
      operation.match.occurrence,
    );
    const file = record?.document.file ?? findActiveFile(index, 'map/buildings.txt');
    const document = record?.document ?? parseTextDocument(file);
    const content =
      operation.kind === 'remove_building_position'
        ? record === undefined
          ? (() => {
              throw new ServiceError(
                'MAP_BUILDING_POSITION_NOT_FOUND',
                'Building position does not exist',
              );
            })()
          : deleteLines(document, [record.line])
        : record === undefined
          ? appendLine(document, buildingPositionLine(operation.value))
          : replaceLine(document, record.line, buildingPositionLine(operation.value));
    addChange(changes, file.relativePath, content, operation.id, 'text/plain');
  } else if (
    operation.kind === 'upsert_unit_position' ||
    operation.kind === 'remove_unit_position'
  ) {
    const record = occurrence(
      index.unitPositions,
      ({ provinceId, type }) =>
        provinceId === operation.match.provinceId && type === operation.match.type,
      operation.match.occurrence,
    );
    const file = record?.document.file ?? findActiveFile(index, 'map/unitstacks.txt');
    const document = record?.document ?? parseTextDocument(file);
    const content =
      operation.kind === 'remove_unit_position'
        ? record === undefined
          ? (() => {
              throw new ServiceError('MAP_UNIT_POSITION_NOT_FOUND', 'Unit position does not exist');
            })()
          : deleteLines(document, [record.line])
        : record === undefined
          ? appendLine(document, unitPositionLine(operation.value))
          : replaceLine(document, record.line, unitPositionLine(operation.value));
    addChange(changes, file.relativePath, content, operation.id, 'text/plain');
  } else {
    const record = occurrence(
      index.weatherPositions,
      ({ strategicRegionId, size }) =>
        strategicRegionId === operation.match.strategicRegionId && size === operation.match.size,
      operation.match.occurrence,
    );
    const file = record?.document.file ?? findActiveFile(index, 'map/weatherpositions.txt');
    const document = record?.document ?? parseTextDocument(file);
    const content =
      operation.kind === 'remove_weather_position'
        ? record === undefined
          ? (() => {
              throw new ServiceError(
                'MAP_WEATHER_POSITION_NOT_FOUND',
                'Weather position does not exist',
              );
            })()
          : deleteLines(document, [record.line])
        : record === undefined
          ? appendLine(document, weatherPositionLine(operation.value))
          : replaceLine(document, record.line, weatherPositionLine(operation.value));
    addChange(changes, file.relativePath, content, operation.id, 'text/plain');
  }
}

function buildingPositionLine(value: Omit<BuildingPositionRecord, 'line' | 'document'>): string {
  return [
    value.stateId,
    value.building,
    value.x,
    value.y,
    value.z,
    value.rotation,
    value.adjacentSeaProvince,
  ]
    .map((part) => (typeof part === 'number' ? numberText(part) : part))
    .join(';');
}

function unitPositionLine(value: Omit<UnitPositionRecord, 'line' | 'document'>): string {
  return [value.provinceId, value.type, value.x, value.y, value.z, value.rotation, value.offset]
    .map(numberText)
    .join(';');
}

function weatherPositionLine(value: Omit<WeatherPositionRecord, 'line' | 'document'>): string {
  return [
    numberText(value.strategicRegionId),
    numberText(value.x),
    numberText(value.y),
    numberText(value.z),
    value.size,
  ].join(';');
}

function uniqueConsecutive(values: readonly number[]): number[] {
  const result: number[] = [];
  for (const value of values) if (result.at(-1) !== value) result.push(value);
  return result;
}

function replaceWhitespaceData(line: string, value: string): string {
  const commentStart = line.indexOf('#');
  const data = commentStart < 0 ? line : line.slice(0, commentStart);
  const comment = commentStart < 0 ? '' : line.slice(commentStart);
  const leading = /^\s*/u.exec(data)?.[0] ?? '';
  const trailing = /\s*$/u.exec(data)?.[0] ?? '';
  return `${leading}${value}${trailing}${comment}`;
}

function remapReferenceFiles(
  index: MapWorkspaceIndex,
  changes: Map<string, MutableChange>,
  provinceIds: ReadonlyMap<number, number>,
  operationId: string,
): void {
  if (index.adjacencies.length > 0) {
    const document = required(
      index.adjacencies[0],
      'MAP_ADJACENCY_FILE_MISSING',
      'Adjacency source row is missing',
    ).document;
    const mapped = index.adjacencies.map((adjacency) => {
      const from = remapProvinceId(provinceIds, adjacency.from);
      const to = remapProvinceId(provinceIds, adjacency.to);
      const through = remapProvinceId(provinceIds, adjacency.through);
      const value = { ...adjacency, from, to, through };
      const key = `${Math.min(from, to)}:${Math.max(from, to)}:${value.type}:${through}`;
      return {
        record: adjacency,
        value,
        key,
        affected: from !== adjacency.from || to !== adjacency.to || through !== adjacency.through,
      };
    });
    const groups = new Map<string, typeof mapped>();
    for (const entry of mapped) {
      const group = groups.get(entry.key) ?? [];
      group.push(entry);
      groups.set(entry.key, group);
    }
    const replacements: SourceReplacement[] = [];
    for (const group of groups.values()) {
      if (!group.some(({ affected }) => affected)) continue;
      const keep = group.find(({ affected }) => !affected) ?? group[0];
      for (const entry of group) {
        const line = document.lines[entry.record.line - 1];
        if (line === undefined) continue;
        if (entry.value.from === entry.value.to || entry !== keep) {
          replacements.push({
            start: line.start,
            end: line.fullEnd,
            text: '',
            description: 'Remove remapped adjacency collision',
          });
        } else if (entry.affected) {
          const fields = new Map<number, string>();
          if (entry.value.from !== entry.record.from) fields.set(0, String(entry.value.from));
          if (entry.value.to !== entry.record.to) fields.set(1, String(entry.value.to));
          if (entry.value.through !== entry.record.through)
            fields.set(3, String(entry.value.through));
          replacements.push({
            start: line.start,
            end: line.end,
            text: replaceDelimitedFields(line.text, fields),
            description: 'Remap adjacency province reference',
          });
        }
      }
    }
    if (replacements.length > 0)
      addChange(
        changes,
        document.file.relativePath,
        applyTextRanges(document, replacements),
        operationId,
        'text/plain',
      );
  }
  if (index.supplyNodes.length > 0) {
    const document = required(
      index.supplyNodes[0],
      'MAP_SUPPLY_NODE_FILE_MISSING',
      'Supply-node source row is missing',
    ).document;
    const groups = new Map<
      number,
      { record: (typeof index.supplyNodes)[number]; provinceId: number; affected: boolean }[]
    >();
    for (const record of index.supplyNodes) {
      const provinceId = remapProvinceId(provinceIds, record.provinceId);
      const group = groups.get(provinceId) ?? [];
      group.push({ record, provinceId, affected: provinceId !== record.provinceId });
      groups.set(provinceId, group);
    }
    const replacements: SourceReplacement[] = [];
    for (const group of groups.values()) {
      if (!group.some(({ affected }) => affected)) continue;
      const keep = group.find(({ affected }) => !affected) ?? group[0];
      const level = group.reduce(
        (maximum, { record }) => Math.max(maximum, record.level),
        Number.NEGATIVE_INFINITY,
      );
      for (const entry of group) {
        const line = document.lines[entry.record.line - 1];
        if (line === undefined) continue;
        replacements.push(
          entry === keep
            ? {
                start: line.start,
                end: line.end,
                text: replaceWhitespaceData(line.text, `${level} ${entry.provinceId}`),
                description: 'Remap supply-node province reference',
              }
            : {
                start: line.start,
                end: line.fullEnd,
                text: '',
                description: 'Remove remapped supply-node collision',
              },
        );
      }
    }
    if (replacements.length > 0)
      addChange(
        changes,
        document.file.relativePath,
        applyTextRanges(document, replacements),
        operationId,
        'text/plain',
      );
  }
  if (index.railways.length > 0) {
    const document = required(
      index.railways[0],
      'MAP_RAILWAY_FILE_MISSING',
      'Railway source row is missing',
    ).document;
    const replacements: SourceReplacement[] = [];
    for (const railway of index.railways) {
      const provinces = uniqueConsecutive(
        railway.provinces.map((id) => remapProvinceId(provinceIds, id)),
      );
      if (
        provinces.length === railway.provinces.length &&
        provinces.every((id, position) => id === railway.provinces[position])
      )
        continue;
      const line = document.lines[railway.line - 1];
      if (line === undefined) continue;
      replacements.push(
        provinces.length < 2
          ? {
              start: line.start,
              end: line.fullEnd,
              text: '',
              description: 'Remove collapsed railway',
            }
          : {
              start: line.start,
              end: line.end,
              text: replaceWhitespaceData(
                line.text,
                `${railway.level} ${provinces.length} ${provinces.join(' ')}`,
              ),
              description: 'Remap railway province references',
            },
      );
    }
    if (replacements.length > 0)
      addChange(
        changes,
        document.file.relativePath,
        applyTextRanges(document, replacements),
        operationId,
        'text/plain',
      );
  }
  if (index.unitPositions.length > 0) {
    const documents = new Map(
      index.unitPositions.map((record) => [record.document.file.relativePath, record.document]),
    );
    for (const [relativePath, document] of documents) {
      const replacements = index.unitPositions
        .filter((record) => record.document === document)
        .flatMap((record): SourceReplacement[] => {
          const provinceId = remapProvinceId(provinceIds, record.provinceId);
          if (provinceId === record.provinceId) return [];
          const line = document.lines[record.line - 1];
          return line === undefined
            ? []
            : [
                {
                  start: line.start,
                  end: line.end,
                  text: replaceDelimitedFields(line.text, new Map([[0, numberText(provinceId)]])),
                  description: 'Remap unit-position province reference',
                },
              ];
        });
      if (replacements.length > 0)
        addChange(
          changes,
          relativePath,
          applyTextRanges(document, replacements),
          operationId,
          'text/plain',
        );
    }
  }
  if (index.buildingPositions.length > 0) {
    const document = required(
      index.buildingPositions[0],
      'MAP_BUILDING_POSITION_FILE_MISSING',
      'Building-position source row is missing',
    ).document;
    const replacements = index.buildingPositions.flatMap((record): SourceReplacement[] => {
      const adjacentSeaProvince = remapProvinceId(provinceIds, record.adjacentSeaProvince);
      if (adjacentSeaProvince === record.adjacentSeaProvince) return [];
      const line = document.lines[record.line - 1];
      return line === undefined
        ? []
        : [
            {
              start: line.start,
              end: line.end,
              text: replaceDelimitedFields(
                line.text,
                new Map([[6, numberText(adjacentSeaProvince)]]),
              ),
              description: 'Remap building-position sea reference',
            },
          ];
    });
    if (replacements.length > 0)
      addChange(
        changes,
        document.file.relativePath,
        applyTextRanges(document, replacements),
        operationId,
        'text/plain',
      );
  }
}

function applyEntityLocator(
  base: MapWorkspaceIndex,
  changes: Map<string, MutableChange>,
  operation: UpdateEntityLocatorOperation,
): void {
  const index = currentIndex(base, changes);
  const matching = index.entityLocators.filter(
    ({ entity, name }) => entity === operation.entity && name === operation.name,
  );
  if (matching.length !== 1)
    throw new ServiceError(
      'MAP_ENTITY_LOCATOR_AMBIGUOUS',
      `Entity locator ${operation.entity}:${operation.name} must resolve exactly once`,
    );
  const locator = required(
    matching[0],
    'MAP_ENTITY_LOCATOR_AMBIGUOUS',
    `Entity locator ${operation.entity}:${operation.name} did not resolve`,
  );
  const indent = lineIndent(
    locator.document.text,
    locator.positionBlock.open?.start ?? locator.positionBlock.start,
  );
  const rendered = `{ ${operation.position.map(numberText).join(' ')} }`;
  const assignment = assignments(
    locator.assignment.value.type === 'block' ? locator.assignment.value : locator.document.root,
    'position',
  )[0];
  if (assignment === undefined)
    throw new ServiceError(
      'MAP_ENTITY_LOCATOR_MALFORMED',
      'Entity locator position assignment is missing',
    );
  const output = applyReplacements(locator.document, [
    {
      start: assignment.value.start,
      end: assignment.value.end,
      text: rendered,
      description: `Update entity locator at ${indent.length}`,
    },
  ]);
  addChange(changes, locator.file.relativePath, output, operation.id, 'text/plain');
}

function* planMapOperationSteps(
  base: MapWorkspaceIndex,
  operations: readonly MapOperation[],
  signal?: AbortSignal,
): MapOperationSteps<MapOperationPlan> {
  yield* cancellationCheckpoint(signal);
  const changes = new Map<string, MutableChange>();
  const diagnostics: Diagnostic[] = [];
  const blockers: MapOperationBlocker[] = [];
  const allocations: AllocationEvidence[] = [];
  let expectedChangedBounds: PixelDiffBounds | undefined;
  const manifestOperations: MapOperationPlan['operations'] = [];
  const ids = new Set<string>();
  for (const [operationIndex, operation] of operations.entries()) {
    yield* cancellationCheckpoint(signal, operationIndex);
    if (ids.has(operation.id)) {
      blockers.push({
        code: 'MAP_OPERATION_ID_DUPLICATE',
        message: `Operation ID ${operation.id} is duplicated`,
        operationId: operation.id,
      });
      continue;
    }
    ids.add(operation.id);
    manifestOperations.push({
      id: operation.id,
      kind: operation.kind,
      summary: operation.summary ?? operation.kind.replaceAll('_', ' '),
      data: JSON.parse(JSON.stringify(operation)) as Record<string, unknown>,
    });
    const changesCheckpoint = new Map(
      [...changes].map(([key, change]) => [
        key,
        {
          ...change,
          content: change.content === null ? null : Buffer.from(change.content),
          operationIds: new Set(change.operationIds),
        },
      ]),
    );
    const allocationsCheckpoint = allocations.length;
    const boundsCheckpoint = expectedChangedBounds;
    try {
      if (operation.kind === 'move_state_provinces')
        applyMoveStateProvinces(base, changes, operation);
      else if (operation.kind === 'update_state') applyUpdateState(base, changes, operation);
      else if (operation.kind === 'split_state' || operation.kind === 'create_state')
        yield* applySplitState(base, changes, allocations, operation, signal);
      else if (operation.kind === 'merge_states') applyMergeStates(base, changes, operation);
      else if (operation.kind === 'split_province' || operation.kind === 'create_province')
        expectedChangedBounds = mergeBounds(
          expectedChangedBounds,
          yield* applySplitProvince(base, changes, allocations, operation, signal),
        );
      else if (operation.kind === 'merge_provinces' || operation.kind === 'remove_province')
        expectedChangedBounds = mergeBounds(
          expectedChangedBounds,
          yield* applyMergeProvinces(base, changes, operation, signal),
        );
      else if (operation.kind === 'update_province_definition')
        expectedChangedBounds = mergeBounds(
          expectedChangedBounds,
          yield* applyUpdateProvinceDefinition(base, changes, operation, signal),
        );
      else if (operation.kind === 'move_region_provinces')
        applyMoveRegions(base, changes, operation);
      else if (
        operation.kind === 'add_normal_adjacency' ||
        operation.kind === 'remove_normal_adjacency'
      )
        expectedChangedBounds = mergeBounds(
          expectedChangedBounds,
          yield* applyNormalAdjacency(base, changes, operation, signal),
        );
      else if (operation.kind === 'update_entity_locator')
        applyEntityLocator(base, changes, operation);
      else handleSimpleOperation(base, changes, operation as SimpleMapOperation);
    } catch (error) {
      if (signal?.aborted) throw error;
      changes.clear();
      for (const [key, change] of changesCheckpoint) changes.set(key, change);
      allocations.length = allocationsCheckpoint;
      expectedChangedBounds = boundsCheckpoint;
      const serviceError =
        error instanceof ServiceError
          ? error
          : new ServiceError(
              'MAP_OPERATION_FAILED',
              error instanceof Error ? error.message : String(error),
            );
      const blocker: MapOperationBlocker = {
        code: serviceError.code,
        message: serviceError.message,
        operationId: operation.id,
        ...(Object.keys(serviceError.details).length === 0
          ? {}
          : { details: serviceError.details }),
      };
      blockers.push(blocker);
      diagnostics.push({
        code: blocker.code,
        severity: 'blocker',
        category: 'map',
        message: blocker.message,
        operationId: blocker.operationId,
        ...(blocker.details === undefined ? {} : { details: blocker.details }),
      });
    }
  }
  const finalized = proposedChanges(changes);
  yield* cancellationCheckpoint(signal);
  const finalIndex = indexWithProposedChanges(base, finalized);
  return {
    changes: finalized,
    diagnostics,
    blockers,
    allocations,
    ...(expectedChangedBounds === undefined ? {} : { expectedChangedBounds }),
    finalIndex,
    operations: manifestOperations,
  };
}

export function planMapOperations(
  base: MapWorkspaceIndex,
  operations: readonly MapOperation[],
  signal?: AbortSignal,
): MapOperationPlan {
  return completeSynchronously(planMapOperationSteps(base, operations, signal));
}

/** Plans map mutations while periodically yielding so protocol cancellation can be delivered. */
export async function planMapOperationsAsync(
  base: MapWorkspaceIndex,
  operations: readonly MapOperation[],
  signal?: AbortSignal,
): Promise<MapOperationPlan> {
  return completeCooperatively(planMapOperationSteps(base, operations, signal), signal);
}

export function mapOperationId(
  operation: Omit<MapOperationBase, 'id'> & Record<string, unknown>,
): string {
  return deterministicId('map_operation', operation);
}
