import { compareCodeUnits } from '../core/canonical.js';
import path from 'node:path';
import type { Diagnostic, SourceLocation } from '../core/diagnostics.js';
import { SymbolIndex } from '../core/index.js';
import { assertRenderDimensions } from '../core/render-budget.js';
import { addMapDiagnostic, addMapDiagnostics } from './diagnostic-limit.js';
import { ServiceError } from '../core/result.js';
import type { ScannedFile } from '../core/scanner.js';
import {
  assignments,
  childBlocks,
  decodeSource,
  encodeSource,
  firstScalar,
  nodeLocation,
  parseClausewitz,
  parseLocalisation,
  type AssignmentNode,
  type BlockNode,
  type DecodedSource,
  type LocalisationDocument,
  type LocalisationEntry,
  type SourceDocument,
} from '../core/source/index.js';
import { BmpImage, rgbKey, type RgbColor } from './bmp.js';

export type ProvinceType = string;

export interface MapIndexSourceRoots {
  map: readonly string[];
  states: readonly string[];
  localisation: readonly string[];
}

const defaultMapIndexSourceRoots: MapIndexSourceRoots = {
  map: ['map'],
  states: ['history/states'],
  localisation: ['localisation', 'localisation_synced'],
};

export interface TextLine {
  index: number;
  start: number;
  end: number;
  fullEnd: number;
  text: string;
}

export interface TextFileDocument extends DecodedSource {
  file: ScannedFile;
  lines: TextLine[];
}

export interface ProvinceDefinition {
  id: number;
  color: RgbColor;
  type: ProvinceType;
  coastal: boolean;
  terrain: string;
  continent: number;
  line: number;
  document: TextFileDocument;
}

export interface VictoryPoint {
  provinceId: number;
  value: number;
  assignment: AssignmentNode;
}

export function derivedStateCapital(
  victoryPoints: readonly Pick<VictoryPoint, 'provinceId' | 'value'>[],
): number | undefined {
  return victoryPoints
    .slice()
    .sort((left, right) => right.value - left.value || left.provinceId - right.provinceId)[0]
    ?.provinceId;
}

export interface StateRecord {
  id: number;
  name: string;
  capital?: number;
  manpower: number;
  category: string;
  provinces: number[];
  resources: ReadonlyMap<string, number>;
  owner?: string;
  controller?: string;
  cores: string[];
  claims: string[];
  victoryPoints: VictoryPoint[];
  provinceBuildings: ReadonlyMap<number, ReadonlyMap<string, number>>;
  stateBuildings: ReadonlyMap<string, number>;
  file: ScannedFile;
  document: SourceDocument;
  assignment: AssignmentNode;
  block: BlockNode;
  provincesBlock?: BlockNode;
  historyBlock?: BlockNode;
  resourcesBlock?: BlockNode;
  buildingsBlock?: BlockNode;
}

export interface StrategicRegionRecord {
  id: number;
  name: string;
  provinces: number[];
  navalTerrain?: string;
  file: ScannedFile;
  document: SourceDocument;
  assignment: AssignmentNode;
  block: BlockNode;
  provincesBlock?: BlockNode;
}

export interface AdjacencyRecord {
  index: number;
  from: number;
  to: number;
  type: string;
  through: number;
  startX: number;
  startY: number;
  stopX: number;
  stopY: number;
  rule: string;
  comment: string;
  line: number;
  document: TextFileDocument;
}

export interface SupplyNodeRecord {
  level: number;
  provinceId: number;
  line: number;
  document: TextFileDocument;
}

export interface RailwayRecord {
  level: number;
  declaredCount: number;
  provinces: number[];
  line: number;
  document: TextFileDocument;
}

export interface BuildingPositionRecord {
  stateId: number;
  building: string;
  x: number;
  y: number;
  z: number;
  rotation: number;
  adjacentSeaProvince: number;
  line: number;
  document: TextFileDocument;
}

export interface UnitPositionRecord {
  provinceId: number;
  type: number;
  x: number;
  y: number;
  z: number;
  rotation: number;
  offset: number;
  line: number;
  document: TextFileDocument;
}

export interface WeatherPositionRecord {
  strategicRegionId: number;
  x: number;
  y: number;
  z: number;
  size: string;
  line: number;
  document: TextFileDocument;
}

export interface EntityLocatorRecord {
  entity: string;
  name: string;
  position: readonly [number, number, number];
  file: ScannedFile;
  document: SourceDocument;
  assignment: AssignmentNode;
  positionBlock: BlockNode;
}

export interface IndexedVictoryPoint {
  stateId: number;
  provinceId: number;
  value: number;
  record: VictoryPoint;
}

export interface IndexedProvinceBuildings {
  stateId: number;
  provinceId: number;
  buildings: ReadonlyMap<string, number>;
}

export interface IndexedMapLocalisationEntry {
  file: ScannedFile;
  document: LocalisationDocument;
  entry: LocalisationEntry;
}

export interface PortRecord {
  stateId: number;
  provinceId: number;
  level: number;
  coastal: boolean;
  positions: BuildingPositionRecord[];
  adjacentSeaProvinceIds: number[];
}

export interface ProvinceGeometry {
  id: number;
  pixelCount: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  centerX: number;
  centerY: number;
}

export interface UnknownMapColor {
  color: RgbColor;
  count: number;
  firstX: number;
  firstY: number;
}

export interface ProvinceRaster {
  width: number;
  height: number;
  provinceIds: Int32Array;
  adjacency: ReadonlyMap<number, ReadonlySet<number>>;
  geometry: ReadonlyMap<number, ProvinceGeometry>;
  unknownColors: readonly UnknownMapColor[];
  unknownColorCount: number;
  coastalProvinceIds: ReadonlySet<number>;
}

export const MAP_PROVINCE_ENGINE_MAX_PIXELS = 13_238_272;
export const MAP_TEXT_MAX_BYTES = 16_777_216;
export const MAP_TEXT_MAX_RECORDS = 500_000;
const MAP_TEXT_FIELD_LIMIT = 10_000;
const MAP_MODEL_MAX_SCRIPT_FILES = 5_000;
const MAP_MODEL_MAX_SOURCE_TOKENS = 1_000_000;
const MAP_MODEL_MAX_RECORDS = 500_000;
const MAP_MODEL_MAX_LOCALISATION_RECORDS = 2_000_000;
const MAP_MODEL_MAX_MEMBERSHIP_EDGES = 1_000_000;

class MapModelBudget {
  readonly #documents = new Set<string>();
  #tokens = 0;
  #records = 0;
  #localisationRecords = 0;
  #membershipEdges = 0;

  assertScriptFiles(count: number): void {
    if (count > MAP_MODEL_MAX_SCRIPT_FILES) {
      this.block('script files', count, MAP_MODEL_MAX_SCRIPT_FILES);
    }
  }

  addDocument(document: SourceDocument): void {
    if (this.#documents.has(document.path)) return;
    this.#documents.add(document.path);
    this.#tokens += document.tokens.length;
    if (this.#tokens > MAP_MODEL_MAX_SOURCE_TOKENS) {
      this.block('retained source tokens', this.#tokens, MAP_MODEL_MAX_SOURCE_TOKENS);
    }
  }

  addRecords(count: number): void {
    this.#records += count;
    if (!Number.isSafeInteger(this.#records) || this.#records > MAP_MODEL_MAX_RECORDS) {
      this.block('domain records', this.#records, MAP_MODEL_MAX_RECORDS);
    }
  }

  addLocalisationRecords(count: number): void {
    this.#localisationRecords += count;
    if (
      !Number.isSafeInteger(this.#localisationRecords) ||
      this.#localisationRecords > MAP_MODEL_MAX_LOCALISATION_RECORDS
    ) {
      this.block(
        'localisation records',
        this.#localisationRecords,
        MAP_MODEL_MAX_LOCALISATION_RECORDS,
      );
    }
  }

  addMembershipEdges(count: number): void {
    this.#membershipEdges += count;
    if (
      !Number.isSafeInteger(this.#membershipEdges) ||
      this.#membershipEdges > MAP_MODEL_MAX_MEMBERSHIP_EDGES
    ) {
      this.block('membership edges', this.#membershipEdges, MAP_MODEL_MAX_MEMBERSHIP_EDGES);
    }
  }

  private block(kind: string, observed: number, limit: number): never {
    throw new ServiceError(
      'MAP_MODEL_BUDGET_BLOCKED',
      `Map workspace model exceeds the fixed ${kind} ceiling`,
      { kind, observed, limit },
    );
  }
}

export interface ActiveFileSet {
  all: readonly ScannedFile[];
  byRelativePath: ReadonlyMap<string, ScannedFile>;
}

function normalizedPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase();
}

/** Selects the one loaded file for each relative filename, while retaining separate database files. */
export function selectActiveFiles(files: readonly ScannedFile[]): ActiveFileSet {
  const byRelativePath = new Map<string, ScannedFile>();
  for (const file of [...files].sort((left, right) => {
    const load = left.loadOrder - right.loadOrder;
    return load !== 0 ? load : compareCodeUnits(left.displayPath, right.displayPath);
  })) {
    byRelativePath.set(normalizedPath(file.relativePath), file);
  }
  const all = [...byRelativePath.values()].sort(
    (left, right) =>
      left.loadOrder - right.loadOrder || compareCodeUnits(left.relativePath, right.relativePath),
  );
  return { all, byRelativePath };
}

export function parseTextDocument(file: ScannedFile): TextFileDocument {
  if (file.bytes.length > MAP_TEXT_MAX_BYTES) {
    throw new ServiceError(
      'MAP_TEXT_FILE_LIMIT',
      'Map text table exceeds the supported 16 MiB parsing limit',
      { bytes: file.bytes.length, maximumBytes: MAP_TEXT_MAX_BYTES },
    );
  }
  const decoded = decodeSource(file.bytes);
  const lines: TextLine[] = [];
  const matcher = /.*(?:\r\n|\n|\r|$)/gu;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = matcher.exec(decoded.text)) !== null) {
    if (match[0] === '' && matcher.lastIndex === decoded.text.length) break;
    const full = match[0];
    const text = full.replace(/(?:\r\n|\n|\r)$/u, '');
    const start = match.index;
    if (index >= MAP_TEXT_MAX_RECORDS) {
      throw new ServiceError(
        'MAP_TEXT_RECORD_LIMIT',
        'Map text table exceeds the supported record limit',
        { records: index + 1, maximumRecords: MAP_TEXT_MAX_RECORDS },
      );
    }
    lines.push({ index, start, end: start + text.length, fullEnd: start + full.length, text });
    index += 1;
    if (full.length === 0) break;
  }
  return { ...decoded, file, lines };
}

export function encodeTextDocument(document: TextFileDocument, text: string): Buffer {
  return encodeSource(text, document.encoding);
}

function lineLocation(document: TextFileDocument, line: TextLine): SourceLocation {
  return {
    path: document.file.displayPath,
    start: { line: line.index + 1, column: 1, offset: line.start },
    end: { line: line.index + 1, column: line.text.length + 1, offset: line.end },
  };
}

function splitDelimitedRow(value: string, maximumParts: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (parts.length + 1 < maximumParts) {
    const next = value.indexOf(';', start);
    if (next < 0) break;
    parts.push(value.slice(start, next).trim());
    start = next + 1;
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function whitespaceRow(
  document: TextFileDocument,
  line: TextLine,
  diagnostics: Diagnostic[],
): string[] | undefined {
  const comment = line.text.indexOf('#');
  const value = (comment < 0 ? line.text : line.text.slice(0, comment)).trim();
  if (value === '') return [];
  const fields: string[] = [];
  const matcher = /\S+/gu;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(value)) !== null) {
    if (fields.length >= MAP_TEXT_FIELD_LIMIT) {
      addMapDiagnostic(diagnostics, {
        code: 'MAP_TEXT_FIELD_LIMIT',
        severity: 'blocker',
        category: 'map',
        message: 'Map text-table row exceeds the fixed field limit',
        location: lineLocation(document, line),
        details: { limit: MAP_TEXT_FIELD_LIMIT },
      });
      return undefined;
    }
    fields.push(match[0]);
  }
  return fields;
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/u.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requiredNumber(
  values: readonly (number | undefined)[],
  index: number,
  label: string,
): number {
  const value = values[index];
  if (value === undefined) {
    throw new ServiceError('MAP_PARSED_NUMBER_MISSING', `${label} is missing after row validation`);
  }
  return value;
}

function scalarList(block: BlockNode | undefined): string[] {
  if (block === undefined) return [];
  return block.entries.filter((entry) => entry.type === 'scalar').map((entry) => entry.value);
}

function numericMap(block: BlockNode | undefined): Map<string, number> {
  const result = new Map<string, number>();
  if (block === undefined) return result;
  for (const assignment of assignments(block)) {
    if (assignment.value.type !== 'scalar') continue;
    const value = parseNumber(assignment.value.value);
    if (value !== undefined) result.set(assignment.key.value, value);
  }
  return result;
}

function directBlock(block: BlockNode, key: string): BlockNode | undefined {
  return childBlocks(block, key)[0];
}

function firstTopLevelAssignment(
  document: SourceDocument,
  key: string,
): AssignmentNode | undefined {
  return assignments(document.root, key)[0];
}

export function parseDefinitions(
  file: ScannedFile,
  diagnostics: Diagnostic[],
): ProvinceDefinition[] {
  const document = parseTextDocument(file);
  const definitions: ProvinceDefinition[] = [];
  for (const line of document.lines) {
    const trimmed = line.text.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const parts = splitDelimitedRow(line.text, 9);
    if (parts.length < 8) {
      addMapDiagnostic(diagnostics, {
        code: 'MAP_DEFINITION_ROW_MALFORMED',
        severity: 'error',
        category: 'map',
        message: 'Province definition row must contain eight semicolon-separated fields',
        location: lineLocation(document, line),
      });
      continue;
    }
    const id = parseInteger(parts[0]);
    const red = parseInteger(parts[1]);
    const green = parseInteger(parts[2]);
    const blue = parseInteger(parts[3]);
    const continent = parseInteger(parts[7]);
    if (
      id === undefined ||
      red === undefined ||
      green === undefined ||
      blue === undefined ||
      continent === undefined ||
      id < 0 ||
      id > 2_147_483_647 ||
      continent < 0 ||
      continent > 2_147_483_647 ||
      red < 0 ||
      red > 255 ||
      green < 0 ||
      green > 255 ||
      blue < 0 ||
      blue > 255
    ) {
      addMapDiagnostic(diagnostics, {
        code: 'MAP_DEFINITION_VALUE_INVALID',
        severity: 'error',
        category: 'map',
        message: 'Province definition contains an invalid ID, color, or continent',
        location: lineLocation(document, line),
      });
      continue;
    }
    definitions.push({
      id,
      color: { r: red, g: green, b: blue },
      type: parts[4] ?? '',
      coastal: parts[5]?.toLowerCase() === 'true',
      terrain: parts[6] ?? '',
      continent,
      line: line.index + 1,
      document,
    });
  }
  return definitions;
}

export function parseState(file: ScannedFile, diagnostics: Diagnostic[]): StateRecord | undefined {
  const document = parseClausewitz(file.bytes, file.displayPath);
  addMapDiagnostics(diagnostics, document.diagnostics);
  const assignment = firstTopLevelAssignment(document, 'state');
  if (assignment?.value.type !== 'block') return undefined;
  const block = assignment.value;
  const idScalar = firstScalar(block, 'id');
  const id = parseInteger(idScalar?.value);
  if (id === undefined || id <= 0 || id > 2_147_483_647) {
    addMapDiagnostic(diagnostics, {
      code: idScalar === undefined ? 'MAP_STATE_ID_MISSING' : 'MAP_STATE_ID_INVALID',
      severity: 'error',
      category: 'map',
      message:
        idScalar === undefined
          ? 'State file has no integer ID'
          : 'State ID must be a positive signed 32-bit integer',
      location: nodeLocation(document, assignment),
    });
    return undefined;
  }
  const provincesBlock = directBlock(block, 'provinces');
  const provinces = scalarList(provincesBlock).flatMap((value) => {
    const parsed = parseInteger(value);
    return parsed === undefined ? [] : [parsed];
  });
  const historyBlock = directBlock(block, 'history');
  const resourcesBlock = directBlock(block, 'resources');
  const buildingsBlock =
    historyBlock === undefined ? undefined : directBlock(historyBlock, 'buildings');
  const provinceBuildings = new Map<number, ReadonlyMap<string, number>>();
  const stateBuildings = new Map<string, number>();
  if (buildingsBlock !== undefined) {
    for (const entry of assignments(buildingsBlock)) {
      if (entry.value.type === 'block') {
        const province = parseInteger(entry.key.value);
        if (province !== undefined) provinceBuildings.set(province, numericMap(entry.value));
      } else {
        const level = parseNumber(entry.value.value);
        if (level !== undefined) stateBuildings.set(entry.key.value, level);
      }
    }
  }
  const victoryPoints: VictoryPoint[] = [];
  if (historyBlock !== undefined) {
    for (const entry of assignments(historyBlock, 'victory_points')) {
      if (entry.value.type !== 'block') continue;
      const values = scalarList(entry.value);
      const provinceId = parseInteger(values[0]);
      const value = parseNumber(values[1]);
      if (provinceId !== undefined && value !== undefined) {
        victoryPoints.push({ provinceId, value, assignment: entry });
      }
    }
  }
  const owner = firstScalar(historyBlock ?? block, 'owner')?.value;
  const controller = firstScalar(historyBlock ?? block, 'controller')?.value;
  const capital = derivedStateCapital(victoryPoints);
  return {
    id,
    name: firstScalar(block, 'name')?.value ?? `STATE_${id}`,
    ...(capital === undefined ? {} : { capital }),
    manpower: parseNumber(firstScalar(block, 'manpower')?.value) ?? 0,
    category: firstScalar(block, 'state_category')?.value ?? '',
    provinces,
    resources: numericMap(resourcesBlock),
    ...(owner === undefined ? {} : { owner }),
    ...(controller === undefined ? {} : { controller }),
    cores:
      historyBlock === undefined
        ? []
        : assignments(historyBlock, 'add_core_of').flatMap(({ value }) =>
            value.type === 'scalar' ? [value.value] : [],
          ),
    claims:
      historyBlock === undefined
        ? []
        : assignments(historyBlock, 'add_claim_by').flatMap(({ value }) =>
            value.type === 'scalar' ? [value.value] : [],
          ),
    victoryPoints,
    provinceBuildings,
    stateBuildings,
    file,
    document,
    assignment,
    block,
    ...(provincesBlock === undefined ? {} : { provincesBlock }),
    ...(historyBlock === undefined ? {} : { historyBlock }),
    ...(resourcesBlock === undefined ? {} : { resourcesBlock }),
    ...(buildingsBlock === undefined ? {} : { buildingsBlock }),
  };
}

export function parseStrategicRegion(
  file: ScannedFile,
  diagnostics: Diagnostic[],
): StrategicRegionRecord | undefined {
  const document = parseClausewitz(file.bytes, file.displayPath);
  addMapDiagnostics(diagnostics, document.diagnostics);
  const assignment =
    firstTopLevelAssignment(document, 'strategic_region') ??
    firstTopLevelAssignment(document, 'strategic_region_template');
  if (assignment?.value.type !== 'block') return undefined;
  const block = assignment.value;
  const idScalar = firstScalar(block, 'id');
  const id = parseInteger(idScalar?.value);
  if (id === undefined || id <= 0 || id > 2_147_483_647) {
    addMapDiagnostic(diagnostics, {
      code: idScalar === undefined ? 'MAP_REGION_ID_MISSING' : 'MAP_REGION_ID_INVALID',
      severity: 'error',
      category: 'map',
      message:
        idScalar === undefined
          ? 'Strategic region has no integer ID'
          : 'Strategic-region ID must be a positive signed 32-bit integer',
      location: nodeLocation(document, assignment),
    });
    return undefined;
  }
  const provincesBlock = directBlock(block, 'provinces');
  const navalTerrain = firstScalar(block, 'naval_terrain')?.value;
  return {
    id,
    name: firstScalar(block, 'name')?.value ?? `STRATEGICREGION_${id}`,
    provinces: scalarList(provincesBlock).flatMap((value) => {
      const parsed = parseInteger(value);
      return parsed === undefined ? [] : [parsed];
    }),
    ...(navalTerrain === undefined ? {} : { navalTerrain }),
    file,
    document,
    assignment,
    block,
    ...(provincesBlock === undefined ? {} : { provincesBlock }),
  };
}

export function parseAdjacencies(file: ScannedFile, diagnostics: Diagnostic[]): AdjacencyRecord[] {
  const document = parseTextDocument(file);
  const result: AdjacencyRecord[] = [];
  let dataIndex = 0;
  for (const line of document.lines) {
    const trimmed = line.text.trim();
    if (line.index === 0 || trimmed === '' || trimmed.startsWith('#')) continue;
    const parts = splitDelimitedRow(line.text, 10);
    if (parts[0] === '-1') break;
    if (parts.length < 9) {
      addMapDiagnostic(diagnostics, {
        code: 'MAP_ADJACENCY_ROW_MALFORMED',
        severity: 'error',
        category: 'map',
        message: 'Adjacency row has fewer than nine fields',
        location: lineLocation(document, line),
      });
      continue;
    }
    const numbers = [0, 1, 3, 4, 5, 6, 7].map((index) => parseNumber(parts[index]));
    if (numbers.some((value) => value === undefined)) {
      addMapDiagnostic(diagnostics, {
        code: 'MAP_ADJACENCY_VALUE_INVALID',
        severity: 'error',
        category: 'map',
        message: 'Adjacency row contains a non-numeric province or coordinate field',
        location: lineLocation(document, line),
      });
      continue;
    }
    const [from, to, through, startX, startY, stopX, stopY] = numbers as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    result.push({
      index: dataIndex,
      from,
      to,
      type: (parts[2] ?? '') === '' ? 'sea' : (parts[2] ?? ''),
      through,
      startX,
      startY,
      stopX,
      stopY,
      rule: parts[8] ?? '',
      comment: parts.slice(9).join(';'),
      line: line.index + 1,
      document,
    });
    dataIndex += 1;
  }
  return result;
}

function parseWhitespaceRows(
  file: ScannedFile,
  diagnostics: Diagnostic[],
): { line: TextLine; values: string[]; document: TextFileDocument }[] {
  const document = parseTextDocument(file);
  return document.lines.flatMap((line) => {
    const values = whitespaceRow(document, line, diagnostics);
    return values === undefined || values.length === 0 ? [] : [{ line, values, document }];
  });
}

export function parseSupplyNodes(file: ScannedFile, diagnostics: Diagnostic[]): SupplyNodeRecord[] {
  return parseWhitespaceRows(file, diagnostics).flatMap(({ line, values, document }) => {
    const level = parseInteger(values[0]);
    const provinceId = parseInteger(values[1]);
    if (values.length !== 2 || level === undefined || provinceId === undefined) {
      addMapDiagnostic(diagnostics, {
        code: 'MAP_SUPPLY_NODE_ROW_MALFORMED',
        severity: 'error',
        category: 'map',
        message: 'Supply node row must be: level province',
        location: lineLocation(document, line),
      });
      return [];
    }
    return [{ level, provinceId, line: line.index + 1, document }];
  });
}

export function parseRailways(file: ScannedFile, diagnostics: Diagnostic[]): RailwayRecord[] {
  return parseWhitespaceRows(file, diagnostics).flatMap(({ line, values, document }) => {
    const level = parseInteger(values[0]);
    const declaredCount = parseInteger(values[1]);
    const provinces = values.slice(2).map(parseInteger);
    if (
      level === undefined ||
      declaredCount === undefined ||
      provinces.some((value) => value === undefined)
    ) {
      addMapDiagnostic(diagnostics, {
        code: 'MAP_RAILWAY_ROW_MALFORMED',
        severity: 'error',
        category: 'map',
        message: 'Railway row must contain an integer level, count, and province list',
        location: lineLocation(document, line),
      });
      return [];
    }
    return [
      {
        level,
        declaredCount,
        provinces: provinces as number[],
        line: line.index + 1,
        document,
      },
    ];
  });
}

function parseDelimitedNumbers(
  file: ScannedFile,
  expected: number,
  diagnostics: Diagnostic[],
  code: string,
): { line: TextLine; parts: string[]; numbers: number[]; document: TextFileDocument }[] {
  const document = parseTextDocument(file);
  return document.lines.flatMap((line) => {
    if (line.text.trim() === '' || line.text.trim().startsWith('#')) return [];
    const parts = splitDelimitedRow(line.text, expected + 1);
    const numbers = parts.slice(0, expected).map(parseNumber);
    if (parts.length < expected || numbers.some((value) => value === undefined)) {
      addMapDiagnostic(diagnostics, {
        code,
        severity: 'error',
        category: 'map',
        message: `Position row must contain at least ${expected} semicolon-separated fields`,
        location: lineLocation(document, line),
      });
      return [];
    }
    return [{ line, parts, numbers: numbers as number[], document }];
  });
}

export function parseBuildingPositions(
  file: ScannedFile,
  diagnostics: Diagnostic[],
): BuildingPositionRecord[] {
  const document = parseTextDocument(file);
  return document.lines.flatMap((line) => {
    if (line.text.trim() === '' || line.text.trim().startsWith('#')) return [];
    const parts = splitDelimitedRow(line.text, 8);
    const stateId = parseInteger(parts[0]);
    const numbers = parts.slice(2, 7).map(parseNumber);
    if (
      parts.length < 7 ||
      stateId === undefined ||
      parts[1] === '' ||
      numbers.some((value) => value === undefined)
    ) {
      addMapDiagnostic(diagnostics, {
        code: 'MAP_BUILDING_POSITION_ROW_MALFORMED',
        severity: 'error',
        category: 'map',
        message: 'Building position row is malformed',
        location: lineLocation(document, line),
      });
      return [];
    }
    return [
      {
        stateId,
        building: parts[1] ?? '',
        x: requiredNumber(numbers, 0, 'building x'),
        y: requiredNumber(numbers, 1, 'building y'),
        z: requiredNumber(numbers, 2, 'building z'),
        rotation: requiredNumber(numbers, 3, 'building rotation'),
        adjacentSeaProvince: requiredNumber(numbers, 4, 'building adjacent sea'),
        line: line.index + 1,
        document,
      },
    ];
  });
}

export function parseUnitPositions(
  file: ScannedFile,
  diagnostics: Diagnostic[],
): UnitPositionRecord[] {
  return parseDelimitedNumbers(file, 7, diagnostics, 'MAP_UNIT_POSITION_ROW_MALFORMED').map(
    ({ line, numbers, document }) => ({
      provinceId: requiredNumber(numbers, 0, 'unit province'),
      type: requiredNumber(numbers, 1, 'unit type'),
      x: requiredNumber(numbers, 2, 'unit x'),
      y: requiredNumber(numbers, 3, 'unit y'),
      z: requiredNumber(numbers, 4, 'unit z'),
      rotation: requiredNumber(numbers, 5, 'unit rotation'),
      offset: requiredNumber(numbers, 6, 'unit offset'),
      line: line.index + 1,
      document,
    }),
  );
}

export function parseWeatherPositions(
  file: ScannedFile,
  diagnostics: Diagnostic[],
): WeatherPositionRecord[] {
  const document = parseTextDocument(file);
  return document.lines.flatMap((line) => {
    if (line.text.trim() === '' || line.text.trim().startsWith('#')) return [];
    const parts = splitDelimitedRow(line.text, 6);
    const strategicRegionId = parseInteger(parts[0]);
    const coordinates = parts.slice(1, 4).map(parseNumber);
    if (
      parts.length < 5 ||
      strategicRegionId === undefined ||
      coordinates.some((value) => value === undefined) ||
      parts[4] === ''
    ) {
      addMapDiagnostic(diagnostics, {
        code: 'MAP_WEATHER_POSITION_ROW_MALFORMED',
        severity: 'error',
        category: 'map',
        message: 'Weather position row is malformed',
        location: lineLocation(document, line),
      });
      return [];
    }
    return [
      {
        strategicRegionId,
        x: requiredNumber(coordinates, 0, 'weather x'),
        y: requiredNumber(coordinates, 1, 'weather y'),
        z: requiredNumber(coordinates, 2, 'weather z'),
        size: parts[4] ?? '',
        line: line.index + 1,
        document,
      },
    ];
  });
}

export function parseEntityLocators(
  file: ScannedFile,
  diagnostics: Diagnostic[],
): EntityLocatorRecord[] {
  const document = parseClausewitz(file.bytes, file.displayPath);
  addMapDiagnostics(diagnostics, document.diagnostics);
  const result: EntityLocatorRecord[] = [];
  for (const entityAssignment of assignments(document.root, 'entity')) {
    if (entityAssignment.value.type !== 'block') continue;
    const entity = firstScalar(entityAssignment.value, 'name')?.value;
    if (entity === undefined) continue;
    for (const locator of assignments(entityAssignment.value, 'locator')) {
      if (locator.value.type !== 'block') continue;
      const name = firstScalar(locator.value, 'name')?.value;
      const positionBlock = directBlock(locator.value, 'position');
      const values = scalarList(positionBlock).map(parseNumber);
      if (
        name === undefined ||
        positionBlock === undefined ||
        values.length !== 3 ||
        values.some((value) => value === undefined)
      ) {
        addMapDiagnostic(diagnostics, {
          code: 'MAP_ENTITY_LOCATOR_MALFORMED',
          severity: 'error',
          category: 'map',
          message: 'Entity locator must have a name and three-number position',
          location: nodeLocation(document, locator, entity),
        });
        continue;
      }
      result.push({
        entity,
        name,
        position: values as [number, number, number],
        file,
        document,
        assignment: locator,
        positionBlock,
      });
    }
  }
  return result;
}

export function defaultMapSelectorValue(
  defaultMap: ScannedFile | undefined,
  key: string,
  fallback: string,
): string {
  if (defaultMap === undefined) return fallback;
  const document = parseClausewitz(defaultMap.bytes, defaultMap.displayPath);
  if (document.diagnostics.length > 0) {
    const reasonCodes = [...new Set(document.diagnostics.map(({ code }) => code))].sort(
      (left, right) => compareCodeUnits(left, right),
    );
    throw new ServiceError(
      'MAP_DEFAULT_MAP_SELECTOR_BLOCKED',
      `The map selector cannot be trusted: ${defaultMap.displayPath}`,
      {
        path: defaultMap.displayPath,
        relativePath: defaultMap.relativePath,
        rootKind: defaultMap.rootKind,
        loadOrder: defaultMap.loadOrder,
        reasonCodes,
        diagnostics: document.diagnostics.map(({ code, severity, category, location }) => ({
          code,
          severity,
          category,
          ...(location === undefined ? {} : { location }),
        })),
      },
    );
  }
  return firstScalar(document.root, key)?.value ?? fallback;
}

function fileByRelative(active: ActiveFileSet, relativePath: string): ScannedFile | undefined {
  return active.byRelativePath.get(normalizedPath(relativePath));
}

function normalizeConfiguredRoot(value: string): string {
  return normalizedPath(value).replace(/^\.\//u, '').replace(/\/$/u, '');
}

function inConfiguredRoot(relativePath: string, roots: readonly string[]): boolean {
  const value = normalizedPath(relativePath);
  return roots.some((root) => value === root || value.startsWith(`${root}/`));
}

function fileInRoots(
  active: ActiveFileSet,
  roots: readonly string[],
  filename: string,
): ScannedFile | undefined {
  for (const root of roots) {
    const file = fileByRelative(active, path.posix.join(root, filename).replaceAll('\\', '/'));
    if (file !== undefined) return file;
  }
  return undefined;
}

function mapFile(
  active: ActiveFileSet,
  filename: string,
  mapRoots: readonly string[],
): ScannedFile | undefined {
  return fileInRoots(active, mapRoots, filename);
}

function sourceIdentity(file: Pick<ScannedFile, 'rootKind' | 'loadOrder'>): string {
  return `${file.rootKind}:${file.loadOrder}`;
}

/**
 * Resolve every definition database selected by a scanned root's own
 * default.map. A root without a selector inherits the active selector name,
 * matching the way partial dependency/mod roots supplement an active map.
 */
function definitionFilesAcrossRoots(
  files: readonly ScannedFile[],
  mapRoots: readonly string[],
  activeDefinitionsName: string,
): ScannedFile[] {
  const groups = new Map<string, ScannedFile[]>();
  for (const file of files) {
    const key = sourceIdentity(file);
    const group = groups.get(key) ?? [];
    group.push(file);
    groups.set(key, group);
  }
  const selected = new Map<string, ScannedFile>();
  for (const group of groups.values()) {
    const byPath = new Map(group.map((file) => [normalizedPath(file.relativePath), file] as const));
    for (const root of mapRoots) {
      const defaultMap = byPath.get(normalizedPath(path.posix.join(root, 'default.map')));
      const definitionsName = defaultMapSelectorValue(
        defaultMap,
        'definitions',
        activeDefinitionsName,
      );
      const definition = byPath.get(
        normalizedPath(path.posix.join(root, definitionsName).replaceAll('\\', '/')),
      );
      if (definition !== undefined) selected.set(definition.displayPath, definition);
    }
  }
  return [...selected.values()].sort(
    (left, right) =>
      left.loadOrder - right.loadOrder || compareCodeUnits(left.displayPath, right.displayPath),
  );
}

function addNeighbor(adjacency: Map<number, Set<number>>, left: number, right: number): void {
  if (left < 0 || right < 0 || left === right) return;
  const leftSet = adjacency.get(left) ?? new Set<number>();
  const rightSet = adjacency.get(right) ?? new Set<number>();
  leftSet.add(right);
  rightSet.add(left);
  adjacency.set(left, leftSet);
  adjacency.set(right, rightSet);
}

export function buildProvinceRaster(
  bitmap: BmpImage,
  definitionsByColor: ReadonlyMap<string, ProvinceDefinition>,
  definitionsById: ReadonlyMap<number, ProvinceDefinition>,
): ProvinceRaster {
  assertRenderDimensions(bitmap.width, bitmap.height, 'map province raster', {
    maximumPixels: MAP_PROVINCE_ENGINE_MAX_PIXELS,
  });
  const provinceIds = new Int32Array(bitmap.width * bitmap.height);
  provinceIds.fill(-1);
  const accumulators = new Map<
    number,
    {
      count: number;
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
      sumX: number;
      sumY: number;
    }
  >();
  const unknown = new Map<string, UnknownMapColor>();
  const unknownColorBits = new Uint8Array(1 << 21);
  let unknownColorCount = 0;
  for (let y = 0; y < bitmap.height; y += 1) {
    for (let x = 0; x < bitmap.width; x += 1) {
      const color = bitmap.rgbAt(x, y);
      const definition = definitionsByColor.get(rgbKey(color));
      if (definition === undefined) {
        const key = rgbKey(color);
        const value = (color.r << 16) | (color.g << 8) | color.b;
        const byteIndex = value >>> 3;
        const bit = 1 << (value & 7);
        if ((unknownColorBits[byteIndex]! & bit) === 0) {
          unknownColorBits[byteIndex] = unknownColorBits[byteIndex]! | bit;
          unknownColorCount += 1;
        }
        const record = unknown.get(key);
        if (record === undefined && unknown.size < 256)
          unknown.set(key, { color, count: 1, firstX: x, firstY: y });
        else if (record !== undefined) record.count += 1;
        continue;
      }
      const offset = y * bitmap.width + x;
      provinceIds[offset] = definition.id;
      const accumulator = accumulators.get(definition.id) ?? {
        count: 0,
        minX: x,
        minY: y,
        maxX: x,
        maxY: y,
        sumX: 0,
        sumY: 0,
      };
      accumulator.count += 1;
      accumulator.minX = Math.min(accumulator.minX, x);
      accumulator.minY = Math.min(accumulator.minY, y);
      accumulator.maxX = Math.max(accumulator.maxX, x);
      accumulator.maxY = Math.max(accumulator.maxY, y);
      accumulator.sumX += x;
      accumulator.sumY += y;
      accumulators.set(definition.id, accumulator);
    }
  }
  const adjacency = new Map<number, Set<number>>();
  for (let y = 0; y < bitmap.height; y += 1) {
    for (let x = 0; x < bitmap.width; x += 1) {
      const current = provinceIds[y * bitmap.width + x] ?? -1;
      const rightX = x === bitmap.width - 1 ? 0 : x + 1;
      addNeighbor(adjacency, current, provinceIds[y * bitmap.width + rightX] ?? -1);
      if (y + 1 < bitmap.height)
        addNeighbor(adjacency, current, provinceIds[(y + 1) * bitmap.width + x] ?? -1);
    }
  }
  const geometry = new Map<number, ProvinceGeometry>();
  for (const [id, value] of accumulators) {
    geometry.set(id, {
      id,
      pixelCount: value.count,
      minX: value.minX,
      minY: value.minY,
      maxX: value.maxX,
      maxY: value.maxY,
      centerX: value.sumX / value.count,
      centerY: value.sumY / value.count,
    });
  }
  const coastalProvinceIds = new Set<number>();
  for (const [id, neighbors] of adjacency) {
    const definition = definitionsById.get(id);
    if (definition === undefined) continue;
    if (
      [...neighbors].some((neighbor) => {
        const other = definitionsById.get(neighbor);
        return (
          (definition.type === 'land' && other?.type === 'sea') ||
          (definition.type === 'sea' && other?.type === 'land')
        );
      })
    ) {
      coastalProvinceIds.add(id);
    }
  }
  return {
    width: bitmap.width,
    height: bitmap.height,
    provinceIds,
    adjacency,
    geometry,
    unknownColors: [...unknown.values()].sort((left, right) =>
      compareCodeUnits(rgbKey(left.color), rgbKey(right.color)),
    ),
    unknownColorCount,
    coastalProvinceIds,
  };
}

export class MapWorkspaceIndex {
  /** Every scanned root file, including entries shadowed by a higher-load-order root. */
  readonly sourceFiles: readonly ScannedFile[];
  readonly sourceRoots: MapIndexSourceRoots;
  /** Shared cross-domain symbol/reference authority for these exact source bytes. */
  readonly sharedIndex: SymbolIndex;
  readonly activeFiles: ActiveFileSet;
  readonly diagnostics: Diagnostic[] = [];
  readonly definitions: ProvinceDefinition[];
  readonly definitionsAcrossRoots: ProvinceDefinition[];
  readonly definitionsById = new Map<number, ProvinceDefinition>();
  readonly definitionsByColor = new Map<string, ProvinceDefinition>();
  readonly duplicateDefinitionIds = new Map<number, ProvinceDefinition[]>();
  readonly duplicateColors = new Map<string, ProvinceDefinition[]>();
  readonly states: StateRecord[];
  readonly statesAcrossRoots: StateRecord[];
  readonly statesById = new Map<number, StateRecord>();
  readonly regions: StrategicRegionRecord[];
  readonly regionsById = new Map<number, StrategicRegionRecord>();
  readonly statesByProvince = new Map<number, StateRecord[]>();
  readonly regionsByProvince = new Map<number, StrategicRegionRecord[]>();
  readonly ownersByState = new Map<number, string>();
  readonly controllersByState = new Map<number, string>();
  readonly capitalsByState = new Map<number, number>();
  readonly coresByState = new Map<number, readonly string[]>();
  readonly claimsByState = new Map<number, readonly string[]>();
  readonly victoryPointsByProvince = new Map<number, IndexedVictoryPoint[]>();
  readonly provinceBuildingsByProvince = new Map<number, IndexedProvinceBuildings[]>();
  readonly adjacencies: AdjacencyRecord[];
  readonly supplyNodes: SupplyNodeRecord[];
  readonly railways: RailwayRecord[];
  readonly buildingPositions: BuildingPositionRecord[];
  readonly unitPositions: UnitPositionRecord[];
  readonly weatherPositions: WeatherPositionRecord[];
  readonly entityLocators: EntityLocatorRecord[];
  readonly ports: PortRecord[] = [];
  readonly coastalProvinceIds: ReadonlySet<number>;
  readonly localisationKeys = new Set<string>();
  readonly localisationEntries: IndexedMapLocalisationEntry[] = [];
  readonly localisationByKey = new Map<string, IndexedMapLocalisationEntry[]>();
  readonly provinceBitmapFile: ScannedFile | undefined;
  readonly provinceBitmap: BmpImage | undefined;
  readonly raster: ProvinceRaster | undefined;
  readonly defaultMapFile: ScannedFile | undefined;
  readonly definitionFile: ScannedFile | undefined;
  readonly adjacencyFile: ScannedFile | undefined;
  readonly supplyNodeFile: ScannedFile | undefined;
  readonly railwayFile: ScannedFile | undefined;

  private constructor(
    files: readonly ScannedFile[],
    sourceRoots: MapIndexSourceRoots = defaultMapIndexSourceRoots,
    sharedIndex: SymbolIndex = SymbolIndex.build(files),
  ) {
    this.sourceFiles = [...files];
    this.sharedIndex = sharedIndex;
    this.sourceRoots = {
      map: sourceRoots.map.map(normalizeConfiguredRoot),
      states: sourceRoots.states.map(normalizeConfiguredRoot),
      localisation: sourceRoots.localisation.map(normalizeConfiguredRoot),
    };
    this.activeFiles = selectActiveFiles(files);
    const modelBudget = new MapModelBudget();
    modelBudget.assertScriptFiles(
      this.sourceFiles.filter(
        (file) =>
          inConfiguredRoot(file.relativePath, this.sourceRoots.states) ||
          this.sourceRoots.map.some((root) =>
            normalizedPath(file.relativePath).startsWith(`${root}/strategicregions/`),
          ) ||
          ((file.rootKind === 'mod' || file.rootKind === 'fixture') &&
            normalizedPath(file.relativePath).endsWith('.asset') &&
            file.bytes.includes('locator')),
      ).length,
    );
    this.defaultMapFile = fileInRoots(this.activeFiles, this.sourceRoots.map, 'default.map');
    const definitionsName = defaultMapSelectorValue(
      this.defaultMapFile,
      'definitions',
      'definition.csv',
    );
    const provincesName = defaultMapSelectorValue(
      this.defaultMapFile,
      'provinces',
      'provinces.bmp',
    );
    this.definitionFile = mapFile(this.activeFiles, definitionsName, this.sourceRoots.map);
    this.provinceBitmapFile = mapFile(this.activeFiles, provincesName, this.sourceRoots.map);
    const definitionFiles = definitionFilesAcrossRoots(
      this.sourceFiles,
      this.sourceRoots.map,
      definitionsName,
    );
    const parsedDefinitions = new Map<string, ProvinceDefinition[]>();
    const definitionsFor = (file: ScannedFile): ProvinceDefinition[] => {
      const cached = parsedDefinitions.get(file.displayPath);
      if (cached !== undefined) return cached;
      const parsed = parseDefinitions(
        file,
        file.displayPath === this.definitionFile?.displayPath ? this.diagnostics : [],
      );
      modelBudget.addRecords(parsed.length);
      parsedDefinitions.set(file.displayPath, parsed);
      return parsed;
    };
    this.definitionsAcrossRoots = definitionFiles.flatMap(definitionsFor);
    this.definitions = this.definitionFile === undefined ? [] : definitionsFor(this.definitionFile);
    for (const definition of this.definitions) {
      const byId = this.duplicateDefinitionIds.get(definition.id) ?? [];
      byId.push(definition);
      this.duplicateDefinitionIds.set(definition.id, byId);
      const key = rgbKey(definition.color);
      const byColor = this.duplicateColors.get(key) ?? [];
      byColor.push(definition);
      this.duplicateColors.set(key, byColor);
      if (!this.definitionsById.has(definition.id))
        this.definitionsById.set(definition.id, definition);
      if (!this.definitionsByColor.has(key)) this.definitionsByColor.set(key, definition);
    }
    if (this.provinceBitmapFile !== undefined) {
      try {
        this.provinceBitmap = BmpImage.decode(this.provinceBitmapFile.bytes);
      } catch (error) {
        addMapDiagnostic(this.diagnostics, {
          code: error instanceof Error && 'code' in error ? String(error.code) : 'MAP_BMP_INVALID',
          severity: 'error',
          category: 'map',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (this.provinceBitmap !== undefined) {
      this.raster = buildProvinceRaster(
        this.provinceBitmap,
        this.definitionsByColor,
        this.definitionsById,
      );
    }
    const stateFiles = this.activeFiles.all.filter((file) =>
      inConfiguredRoot(file.relativePath, this.sourceRoots.states),
    );
    const activeStatePaths = new Set(stateFiles.map(({ displayPath }) => displayPath));
    const parsedStates = new Map<string, StateRecord | null>();
    const stateFor = (file: ScannedFile): StateRecord | undefined => {
      const cached = parsedStates.get(file.displayPath);
      if (cached !== undefined) return cached ?? undefined;
      const state = parseState(
        file,
        activeStatePaths.has(file.displayPath) ? this.diagnostics : [],
      );
      parsedStates.set(file.displayPath, state ?? null);
      if (state !== undefined) {
        modelBudget.addDocument(state.document);
        modelBudget.addRecords(1);
        modelBudget.addMembershipEdges(
          state.provinces.length +
            state.victoryPoints.length +
            state.provinceBuildings.size +
            state.cores.length +
            state.claims.length,
        );
      }
      return state;
    };
    this.statesAcrossRoots = this.sourceFiles
      .filter((file) => inConfiguredRoot(file.relativePath, this.sourceRoots.states))
      .flatMap((file) => {
        const state = stateFor(file);
        return state === undefined ? [] : [state];
      });
    this.states = stateFiles.flatMap((file) => {
      const state = stateFor(file);
      return state === undefined ? [] : [state];
    });
    for (const state of this.states) {
      if (!this.statesById.has(state.id)) this.statesById.set(state.id, state);
      if (state.owner !== undefined) this.ownersByState.set(state.id, state.owner);
      if (state.controller !== undefined) this.controllersByState.set(state.id, state.controller);
      if (state.capital !== undefined) this.capitalsByState.set(state.id, state.capital);
      this.coresByState.set(state.id, state.cores);
      this.claimsByState.set(state.id, state.claims);
      for (const provinceId of state.provinces) {
        const memberships = this.statesByProvince.get(provinceId) ?? [];
        memberships.push(state);
        this.statesByProvince.set(provinceId, memberships);
      }
      for (const record of state.victoryPoints) {
        const points = this.victoryPointsByProvince.get(record.provinceId) ?? [];
        points.push({
          stateId: state.id,
          provinceId: record.provinceId,
          value: record.value,
          record,
        });
        this.victoryPointsByProvince.set(record.provinceId, points);
      }
      for (const [provinceId, buildings] of state.provinceBuildings) {
        const records = this.provinceBuildingsByProvince.get(provinceId) ?? [];
        records.push({ stateId: state.id, provinceId, buildings });
        this.provinceBuildingsByProvince.set(provinceId, records);
      }
    }
    const regionFiles = this.activeFiles.all.filter((file) =>
      this.sourceRoots.map.some((root) =>
        normalizedPath(file.relativePath).startsWith(`${root}/strategicregions/`),
      ),
    );
    this.regions = regionFiles.flatMap((file) => {
      const region = parseStrategicRegion(file, this.diagnostics);
      if (region !== undefined) {
        modelBudget.addDocument(region.document);
        modelBudget.addRecords(1);
        modelBudget.addMembershipEdges(region.provinces.length);
      }
      return region === undefined ? [] : [region];
    });
    for (const region of this.regions) {
      if (!this.regionsById.has(region.id)) this.regionsById.set(region.id, region);
      for (const provinceId of region.provinces) {
        const memberships = this.regionsByProvince.get(provinceId) ?? [];
        memberships.push(region);
        this.regionsByProvince.set(provinceId, memberships);
      }
    }
    this.adjacencyFile = mapFile(
      this.activeFiles,
      defaultMapSelectorValue(this.defaultMapFile, 'adjacencies', 'adjacencies.csv'),
      this.sourceRoots.map,
    );
    this.adjacencies =
      this.adjacencyFile === undefined
        ? []
        : parseAdjacencies(this.adjacencyFile, this.diagnostics);
    modelBudget.addRecords(this.adjacencies.length);
    this.supplyNodeFile = mapFile(
      this.activeFiles,
      defaultMapSelectorValue(this.defaultMapFile, 'supply_nodes', 'supply_nodes.txt'),
      this.sourceRoots.map,
    );
    this.supplyNodes =
      this.supplyNodeFile === undefined
        ? []
        : parseSupplyNodes(this.supplyNodeFile, this.diagnostics);
    modelBudget.addRecords(this.supplyNodes.length);
    modelBudget.addMembershipEdges(this.supplyNodes.length);
    this.railwayFile = mapFile(
      this.activeFiles,
      defaultMapSelectorValue(this.defaultMapFile, 'railways', 'railways.txt'),
      this.sourceRoots.map,
    );
    this.railways =
      this.railwayFile === undefined ? [] : parseRailways(this.railwayFile, this.diagnostics);
    modelBudget.addRecords(this.railways.length);
    modelBudget.addMembershipEdges(
      this.railways.reduce((total, railway) => total + railway.provinces.length, 0),
    );
    const buildingsFile = mapFile(this.activeFiles, 'buildings.txt', this.sourceRoots.map);
    this.buildingPositions =
      buildingsFile === undefined ? [] : parseBuildingPositions(buildingsFile, this.diagnostics);
    modelBudget.addRecords(this.buildingPositions.length);
    const unitstacksFile = mapFile(this.activeFiles, 'unitstacks.txt', this.sourceRoots.map);
    const positionsFile = mapFile(
      this.activeFiles,
      defaultMapSelectorValue(this.defaultMapFile, 'positions', 'positions.txt'),
      this.sourceRoots.map,
    );
    this.unitPositions = [unitstacksFile, positionsFile]
      .filter((file): file is ScannedFile => file !== undefined && file.size > 0)
      .flatMap((file) => parseUnitPositions(file, this.diagnostics));
    modelBudget.addRecords(this.unitPositions.length);
    const weatherFile = mapFile(this.activeFiles, 'weatherpositions.txt', this.sourceRoots.map);
    this.weatherPositions =
      weatherFile === undefined ? [] : parseWeatherPositions(weatherFile, this.diagnostics);
    modelBudget.addRecords(this.weatherPositions.length);
    this.entityLocators = this.activeFiles.all
      .filter(
        (file) =>
          (file.rootKind === 'mod' || file.rootKind === 'fixture') &&
          normalizedPath(file.relativePath).endsWith('.asset') &&
          file.bytes.includes('locator'),
      )
      .flatMap((file) => {
        const locators = parseEntityLocators(file, this.diagnostics);
        if (locators[0] !== undefined) modelBudget.addDocument(locators[0].document);
        modelBudget.addRecords(locators.length);
        return locators;
      });
    for (const file of this.activeFiles.all.filter(
      (entry) =>
        inConfiguredRoot(entry.relativePath, this.sourceRoots.localisation) &&
        normalizedPath(entry.relativePath).endsWith('.yml'),
    )) {
      const document = parseLocalisation(file.bytes, file.displayPath);
      if (file.rootKind === 'mod' || file.rootKind === 'fixture') {
        addMapDiagnostics(this.diagnostics, document.diagnostics);
      }
      // Localisation is a supporting lookup table rather than connected map topology. Account for
      // it separately so a normal full-game language database cannot exhaust the domain-record
      // budget before provinces, states, regions, railways, and adjacencies are available.
      modelBudget.addLocalisationRecords(document.entries.length);
      for (const entry of document.entries) {
        this.localisationKeys.add(`${entry.language}:${entry.key}`);
        const indexed = { file, document, entry };
        this.localisationEntries.push(indexed);
        const key = `${entry.language}:${entry.key}`;
        const values = this.localisationByKey.get(key) ?? [];
        values.push(indexed);
        this.localisationByKey.set(key, values);
      }
    }
    this.coastalProvinceIds = this.raster?.coastalProvinceIds ?? new Set<number>();
    const portPositionsByStateProvince = new Map<string, BuildingPositionRecord[]>();
    for (const position of this.buildingPositions) {
      if (position.building !== 'naval_base_spawn' && position.building !== 'floating_harbor') {
        continue;
      }
      const provinceId = this.provinceAtMapCoordinate(position.x, position.z);
      if (provinceId === undefined) continue;
      const key = `${position.stateId}:${provinceId}`;
      const positions = portPositionsByStateProvince.get(key) ?? [];
      positions.push(position);
      portPositionsByStateProvince.set(key, positions);
    }
    for (const [provinceId, records] of this.provinceBuildingsByProvince) {
      const level = records.reduce(
        (total, { buildings }) => total + (buildings.get('naval_base') ?? 0),
        0,
      );
      if (level <= 0) continue;
      const firstRecord = records[0];
      if (firstRecord === undefined) continue;
      const stateId = firstRecord.stateId;
      const positions = portPositionsByStateProvince.get(`${stateId}:${provinceId}`) ?? [];
      this.ports.push({
        stateId,
        provinceId,
        level,
        coastal: this.coastalProvinceIds.has(provinceId),
        positions,
        adjacentSeaProvinceIds: uniqueNumbers(
          positions.map(({ adjacentSeaProvince }) => adjacentSeaProvince),
        ),
      });
    }
  }

  static build(
    files: readonly ScannedFile[],
    sourceRoots: MapIndexSourceRoots = defaultMapIndexSourceRoots,
    sharedIndex: SymbolIndex = SymbolIndex.build(files),
  ): MapWorkspaceIndex {
    return new MapWorkspaceIndex(files, sourceRoots, sharedIndex);
  }

  provinceAtMapCoordinate(x: number, z: number): number | undefined {
    if (this.raster === undefined) return undefined;
    const pixelX = Math.floor(x);
    const pixelY = this.raster.height - 1 - Math.floor(z);
    if (pixelX < 0 || pixelX >= this.raster.width || pixelY < 0 || pixelY >= this.raster.height) {
      return undefined;
    }
    const id = this.raster.provinceIds[pixelY * this.raster.width + pixelX] ?? -1;
    return id < 0 ? undefined : id;
  }

  stateForProvince(provinceId: number): StateRecord[] {
    return this.statesByProvince.get(provinceId) ?? [];
  }

  regionForProvince(provinceId: number): StrategicRegionRecord[] {
    return this.regionsByProvince.get(provinceId) ?? [];
  }
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}
