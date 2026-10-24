import type { Diagnostic } from '../core/diagnostics.js';
import { ServiceError } from '../core/result.js';
import {
  BORDER_PROVINCE_KIND,
  buildBorderEdgeTableSteps,
  scoreBorderAssignment,
  type BorderEdgeTable,
  type BorderScore,
} from './border-quality.js';
import { borderQualityInputFromIndex } from './border-quality-input.js';
import type { MapWorkspaceIndex, StateRecord } from './model.js';
import {
  cloneState,
  commitState,
  currentIndex,
  uniqueStrings,
  type AllocationEvidence,
  type MapOperationBase,
  type MapOperationSteps,
  type MutableChange,
  type StatePatchFields,
} from './operations.js';
import { clusterProvinces } from './partition-groups.js';
import { restructureStates, type RestructureGroup } from './state-restructure.js';
import {
  buildTerritoryAtoms,
  buildTerritoryProvinceGraph,
  type TerritoryAtoms,
  type TerritoryProvinceGraph,
} from './territory-graph.js';
import {
  growTerritory,
  TERRITORY_MAX_COUNTRIES,
  type IslandPolicy,
  type TerritoryCountry,
  type TerritoryNote,
  type TerritoryResult,
  type TerritoryStats,
} from './territory.js';

/**
 * The `assign_territory` and `repartition_states` operations (ADR 0060): resolve the request to
 * atoms, run the territory algorithm, and write the result as state ownership, cores and claims
 * edits (and, where a border cuts a state, a regrouping of provinces into states).
 */

export type TerritoryRef = { state: number } | { province: number } | { x: number; y: number };

export interface TerritorySelection {
  stateIds?: number[];
  provinceIds?: number[];
  /** Strategic region ids: every state (or province) whose region is one of these. */
  regionIds?: number[];
}

export type BorderQualityMode = 'off' | 'report' | 'enforce';

export interface BorderTargetsInput {
  minEnrichment?: number;
  maxStraightness?: number;
  minNaturalShare?: number;
}

export interface AssignTerritoryCountry {
  tag: string;
  /** Relative target size. Default 1. */
  weight?: number;
  /** The first seed is the capital; the others are anchors. */
  seeds: TerritoryRef[];
  forced?: TerritorySelection;
  blocked?: TerritorySelection;
  /** Strategic regions this country prefers to grow in. */
  regions?: number[];
  /** Grow this country inside the territory of its overlord. */
  overlord?: string;
  /** Relabel the finished territory to another listed country, keeping this tag as a core. */
  mergeInto?: string;
  /** Extra states (or provinces' states) this country holds a core on. */
  cores?: TerritorySelection;
  /** Extra states this country claims. */
  claims?: TerritorySelection;
}

export interface TerritoryOwnershipPolicy {
  controller?: 'owner' | 'keep';
  cores?: 'keep' | 'owner' | 'add-owner';
  claims?: 'keep' | 'clear';
  unowned?: 'clear' | 'keep';
}

export interface AssignTerritoryOperation extends MapOperationBase {
  kind: 'assign_territory';
  /** `state` assigns whole states; `province` assigns provinces and regroups the states a border cuts. */
  unit?: 'state' | 'province';
  countries: AssignTerritoryCountry[];
  scope?: { stateIds?: number[]; regionIds?: number[]; owners?: string[] };
  /** Land no country owns. */
  unowned?: TerritorySelection;
  barriers?: 'natural' | 'none';
  rules?: { connectedMainland?: boolean; islandPolicy?: IslandPolicy };
  smoothing?: { passes?: number; maxShareChange?: number };
  shareTolerance?: number;
  seed?: number;
  ownership?: TerritoryOwnershipPolicy;
  /** Province unit only: fragments below `min` provinces join a neighbour of the same owner and region. */
  stateSize?: { min: number; max?: number };
  remapReferences?: 'refuse' | 'override';
  borderQuality?: BorderQualityMode;
  borderTargets?: BorderTargetsInput;
}

export interface RepartitionStatesOperation extends MapOperationBase {
  kind: 'repartition_states';
  /** Owners whose states are regrouped; default every owner. */
  countries?: string[];
  stateIds?: number[];
  provincesPerState?: { min?: number; target?: number; max?: number };
  remapReferences?: 'refuse' | 'override';
  borderQuality?: BorderQualityMode;
  borderTargets?: BorderTargetsInput;
}

export interface TerritoryReport {
  operationId: string;
  kind: 'assign_territory' | 'repartition_states';
  unit: 'state' | 'province';
  atoms: number;
  seed: number;
  barriers: 'natural' | 'none';
  stats?: TerritoryStats;
  /** The same seeds and weights grown on distance alone, for comparison. */
  baseline?: { naturalShare: number | null; enrichment: number | null; maxShareError: number };
  score: BorderScore;
  /** Score of the grouping before the operation (repartition only). */
  before?: BorderScore;
  states: { changed: number[]; created: number[]; removed: number[]; ownershipChanged: number };
  notes: TerritoryNote[];
  borderQuality: {
    mode: BorderQualityMode;
    layer: 'country' | 'state';
    targets?: BorderTargetsInput;
    /** Filled after planning, from the metric on the proposed map. */
    verdicts?: Array<{
      layer: string;
      status: string;
      enrichment: number | null;
      naturalShare: number | null;
      straightFraction: number | null;
      passed: boolean;
    }>;
  };
}

/** A bounded summary of a report for tool results; the complete report is an artifact. */
export function compactTerritoryReport(report: TerritoryReport): Record<string, unknown> {
  const stats = report.stats;
  return {
    operationId: report.operationId,
    kind: report.kind,
    unit: report.unit,
    atoms: report.atoms,
    barriers: report.barriers,
    ...(stats === undefined
      ? {}
      : {
          sizes: {
            countries: stats.countries.length,
            assignedAtoms: stats.assignedAtoms,
            unownedAtoms: stats.unownedAtoms,
            maxShareError: stats.maxShareError,
            rounds: stats.rounds,
            smoothingMoves: stats.smoothingMoves,
            corridors: stats.corridors,
            worst: stats.countries
              .slice()
              .sort((a, b) => b.shareError - a.shareError || (a.tag < b.tag ? -1 : 1))
              .slice(0, 8)
              .map(({ tag, atoms, share, targetShare, shareError }) => ({
                tag,
                atoms,
                share,
                targetShare,
                shareError,
              })),
          },
        }),
    border: {
      edges: report.score.borderEdges,
      alignment: report.score.alignment,
      baseRate: report.score.baseRate,
      enrichment: report.score.enrichment,
      naturalShare: report.score.naturalShare,
      ...(report.baseline === undefined
        ? {}
        : {
            distanceOnly: {
              enrichment: report.baseline.enrichment,
              naturalShare: report.baseline.naturalShare,
              maxShareError: report.baseline.maxShareError,
            },
          }),
      ...(report.before === undefined
        ? {}
        : {
            before: {
              enrichment: report.before.enrichment,
              naturalShare: report.before.naturalShare,
              edges: report.before.borderEdges,
            },
          }),
    },
    states: {
      changed: report.states.changed.length,
      created: report.states.created.length,
      removed: report.states.removed.length,
      ownershipChanged: report.states.ownershipChanged,
    },
    borderQuality: report.borderQuality,
    notes: report.notes.slice(0, 5).map(({ code, message }) => ({ code, message })),
  };
}

export interface TerritoryOutcome {
  diagnostics: Diagnostic[];
  report: TerritoryReport;
}

// ---------------------------------------------------------------------------------------------
// The world: border table, province graph and the units countries are made of

export interface TerritoryWorld {
  index: MapWorkspaceIndex;
  table: BorderEdgeTable;
  graph: TerritoryProvinceGraph;
  skipped: { input: string; reason: string }[];
}

function refuse(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new ServiceError(code, message, details);
}

function* buildTerritoryWorld(
  index: MapWorkspaceIndex,
  signal: AbortSignal | undefined,
): MapOperationSteps<TerritoryWorld> {
  if (index.raster === undefined)
    refuse(
      'MAP_TERRITORY_MAP_MISSING',
      'Territory assignment needs a valid province bitmap and province definitions',
    );
  const { input, skipped } = borderQualityInputFromIndex(index);
  const table = yield* buildBorderEdgeTableSteps(input, signal === undefined ? {} : { signal });
  yield;
  return { index, table, graph: buildTerritoryProvinceGraph(table), skipped };
}

const LAND = BORDER_PROVINCE_KIND.land;

function isLandProvince(table: BorderEdgeTable, province: number): boolean {
  return (
    Number.isInteger(province) &&
    province >= 0 &&
    province < table.provinceKinds.length &&
    table.provinceKinds[province] === LAND
  );
}

/** The strategic region holding most of a group of provinces (lowest id on a tie), -1 for none. */
function dominantRegion(index: MapWorkspaceIndex, provinces: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const province of provinces) {
    const id = index.regionForProvince(province)[0]?.id ?? -1;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best = -1;
  let bestCount = 0;
  for (const [id, count] of [...counts].sort(([a], [b]) => a - b))
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  return best;
}

interface AtomModel {
  unit: 'state' | 'province';
  atoms: TerritoryAtoms;
  /** Old state of every atom (a province's state in province mode). */
  stateOfAtom: number[];
  /** State mode: the atom of each state. */
  atomOfState: Map<number, number>;
  excluded: number[];
}

type ScopeInput = AssignTerritoryOperation['scope'];

function scopeFilter(
  index: MapWorkspaceIndex,
  scope: ScopeInput,
): (state: StateRecord, region: number) => boolean {
  if (scope === undefined) return () => true;
  const states = scope.stateIds === undefined ? undefined : new Set(scope.stateIds);
  const regions = scope.regionIds === undefined ? undefined : new Set(scope.regionIds);
  const owners = scope.owners === undefined ? undefined : new Set(scope.owners);
  for (const id of states ?? [])
    if (!index.statesById.has(id))
      refuse('MAP_TERRITORY_SCOPE_UNKNOWN', `The scope names state ${id}, which does not exist`, {
        stateId: id,
      });
  return (state, region) =>
    (states === undefined || states.has(state.id)) &&
    (regions === undefined || regions.has(region)) &&
    (owners === undefined || owners.has(state.owner ?? 'NONE'));
}

function buildAtomModel(
  world: TerritoryWorld,
  unit: 'state' | 'province',
  scope: ScopeInput,
): AtomModel {
  const { index, table } = world;
  const states = [...index.states].sort((a, b) => a.id - b.id);
  const inScope = scopeFilter(index, scope);
  const owner = new Map<number, number>();
  const groups: number[][] = [];
  const regions: number[] = [];
  const stateOfAtom: number[] = [];
  const atomOfState = new Map<number, number>();
  const excluded: number[] = [];
  for (const state of states) {
    const land = state.provinces.filter((province) => isLandProvince(table, province));
    if (land.length === 0) continue;
    for (const province of land) {
      const other = owner.get(province);
      if (other !== undefined && other !== state.id)
        refuse(
          'MAP_TERRITORY_STATE_OVERLAP',
          `Province ${province} belongs to states ${other} and ${state.id}; fix the state files first (hoi4.map_inspect reports the overlap)`,
          { province, states: [other, state.id] },
        );
      owner.set(province, state.id);
    }
    const region = dominantRegion(index, land);
    const wanted = inScope(state, region);
    if (unit === 'state') {
      atomOfState.set(state.id, groups.length);
      groups.push(land);
      regions.push(region);
      stateOfAtom.push(state.id);
      if (!wanted) excluded.push(groups.length - 1);
    } else
      for (const province of land) {
        groups.push([province]);
        regions.push(index.regionForProvince(province)[0]?.id ?? -1);
        stateOfAtom.push(state.id);
        if (!wanted) excluded.push(groups.length - 1);
      }
  }
  if (groups.length === 0)
    refuse(
      'MAP_TERRITORY_NO_LAND',
      'The map has no land province in a state, so there is no territory to assign',
    );
  return {
    unit,
    atoms: buildTerritoryAtoms(world.graph, groups, Int32Array.from(regions)),
    stateOfAtom,
    atomOfState,
    excluded,
  };
}

function resolveProvince(
  world: TerritoryWorld,
  model: AtomModel,
  province: number,
  label: string,
): number {
  const { index, table } = world;
  if (!index.definitionsById.has(province))
    refuse('MAP_TERRITORY_PROVINCE_UNKNOWN', `${label}: province ${province} does not exist`, {
      province,
    });
  if (!isLandProvince(table, province))
    refuse(
      'MAP_TERRITORY_SEED_IN_WATER',
      `${label}: province ${province} is not land (sea and lake provinces cannot be owned)`,
      { province },
    );
  const atom = model.atoms.atomOfProvince[province]!;
  if (atom < 0)
    refuse(
      'MAP_TERRITORY_PROVINCE_WITHOUT_STATE',
      `${label}: province ${province} belongs to no state, so it cannot have an owner`,
      { province },
    );
  return atom;
}

function resolveRef(
  world: TerritoryWorld,
  model: AtomModel,
  ref: TerritoryRef,
  label: string,
): number {
  if ('state' in ref) {
    const state = world.index.statesById.get(ref.state);
    if (state === undefined)
      refuse('MAP_TERRITORY_STATE_UNKNOWN', `${label}: state ${ref.state} does not exist`, {
        stateId: ref.state,
      });
    if (model.unit === 'state') {
      const atom = model.atomOfState.get(ref.state);
      if (atom === undefined)
        refuse('MAP_TERRITORY_SEED_IN_WATER', `${label}: state ${ref.state} has no land province`, {
          stateId: ref.state,
        });
      return atom;
    }
    // In province mode a state seed is its capital province, else its first land province.
    const land = state.provinces.filter((province) => isLandProvince(world.table, province));
    const province =
      state.capital !== undefined && land.includes(state.capital) ? state.capital : land[0];
    if (province === undefined)
      refuse('MAP_TERRITORY_SEED_IN_WATER', `${label}: state ${ref.state} has no land province`, {
        stateId: ref.state,
      });
    return resolveProvince(world, model, province, label);
  }
  if ('province' in ref) return resolveProvince(world, model, ref.province, label);
  const raster = world.index.raster!;
  if (ref.x < 0 || ref.y < 0 || ref.x >= raster.width || ref.y >= raster.height)
    refuse(
      'MAP_TERRITORY_POINT_OUTSIDE_MAP',
      `${label}: point (${ref.x}, ${ref.y}) is outside the ${raster.width} x ${raster.height} map`,
      { x: ref.x, y: ref.y },
    );
  const province = raster.provinceIds[ref.y * raster.width + ref.x]!;
  return resolveProvince(world, model, province, `${label} at (${ref.x}, ${ref.y})`);
}

function resolveSelection(
  world: TerritoryWorld,
  model: AtomModel,
  selection: TerritorySelection | undefined,
  label: string,
): Set<number> {
  const atoms = new Set<number>();
  if (selection === undefined) return atoms;
  for (const stateId of selection.stateIds ?? []) {
    const state = world.index.statesById.get(stateId);
    if (state === undefined)
      refuse('MAP_TERRITORY_STATE_UNKNOWN', `${label}: state ${stateId} does not exist`, {
        stateId,
      });
    if (model.unit === 'state') {
      const atom = model.atomOfState.get(stateId);
      if (atom !== undefined) atoms.add(atom);
    } else
      for (const province of state.provinces) {
        const atom = model.atoms.atomOfProvince[province]!;
        if (atom >= 0) atoms.add(atom);
      }
  }
  for (const province of selection.provinceIds ?? []) {
    atoms.add(resolveProvince(world, model, province, label));
  }
  if (selection.regionIds !== undefined) {
    const wanted = new Set(selection.regionIds);
    for (const region of wanted)
      if (!world.index.regionsById.has(region))
        refuse(
          'MAP_TERRITORY_REGION_UNKNOWN',
          `${label}: strategic region ${region} does not exist`,
          {
            regionId: region,
          },
        );
    for (let atom = 0; atom < model.atoms.count; atom += 1)
      if (wanted.has(model.atoms.region[atom]!)) atoms.add(atom);
  }
  return atoms;
}

// ---------------------------------------------------------------------------------------------
// Writing ownership

interface OwnershipPlan {
  controller: 'owner' | 'keep';
  cores: 'keep' | 'owner' | 'add-owner';
  claims: 'keep' | 'clear';
  unowned: 'clear' | 'keep';
}

function ownershipPolicy(input: TerritoryOwnershipPolicy | undefined): OwnershipPlan {
  return {
    controller: input?.controller ?? 'owner',
    cores: input?.cores ?? 'keep',
    claims: input?.claims ?? 'keep',
    unowned: input?.unowned ?? 'clear',
  };
}

const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
  const a = uniqueStrings(left);
  const b = uniqueStrings(right);
  return a.length === b.length && a.every((value, position) => value === b[position]);
};

/** Edit one state's owner, controller, cores and claims; returns whether anything changed. */
function editOwnership(
  changes: Map<string, MutableChange>,
  state: StateRecord,
  wanted: {
    owner: string | undefined;
    origin: string | undefined;
    addCores: readonly string[];
    addClaims: readonly string[];
    unowned: boolean;
  },
  policy: OwnershipPlan,
  operationId: string,
): boolean {
  if (wanted.unowned && policy.unowned === 'keep') return false;
  const desired = cloneState(state);
  const fields: StatePatchFields = {};
  desired.owner = wanted.owner;
  if (desired.owner !== state.owner) fields.owner = true;
  if (policy.controller === 'owner') {
    desired.controller = wanted.owner;
    if (desired.controller !== state.controller) fields.controller = true;
  }
  const tags = [wanted.owner, wanted.origin].filter((tag): tag is string => tag !== undefined);
  if (policy.cores === 'owner') desired.cores = uniqueStrings([...tags, ...wanted.addCores]);
  else if (policy.cores === 'add-owner')
    desired.cores = uniqueStrings([...state.cores, ...tags, ...wanted.addCores]);
  else desired.cores = uniqueStrings([...state.cores, ...wanted.addCores]);
  if (!sameSet(desired.cores, state.cores)) fields.cores = true;
  desired.claims = uniqueStrings([
    ...(policy.claims === 'clear' ? [] : state.claims),
    ...wanted.addClaims,
  ]);
  if (!sameSet(desired.claims, state.claims)) fields.claims = true;
  if (Object.keys(fields).length === 0) return false;
  commitState(changes, state, desired, fields, operationId);
  return true;
}

// ---------------------------------------------------------------------------------------------
// assign_territory

function provinceLabelsOf(model: AtomModel, owner: Int32Array, provinceCount: number): Int32Array {
  const labels = new Int32Array(provinceCount).fill(-1);
  for (let atom = 0; atom < model.atoms.count; atom += 1)
    for (const province of model.atoms.members[atom]!) labels[province] = owner[atom]!;
  return labels;
}

/** The state or province an atom stands for, in words and as detail fields. */
function describeAtom(
  model: AtomModel,
  atom: number,
): { words: string; details: Record<string, unknown> } {
  if (!Number.isInteger(atom) || atom < 0 || atom >= model.atoms.count)
    return { words: `atom ${atom}`, details: {} };
  if (model.unit === 'state') {
    const stateId = model.stateOfAtom[atom]!;
    return { words: `State ${stateId}`, details: { stateId } };
  }
  const provinceId = model.atoms.members[atom]![0]!;
  return {
    words: `Province ${provinceId} (state ${model.stateOfAtom[atom]!})`,
    details: { provinceId, stateId: model.stateOfAtom[atom]! },
  };
}

/**
 * Grow the territory and restate a refusal of the growth in the request's terms: the growth names
 * internal atoms, the caller sent states, provinces and points.
 */
function growInRequestTerms(
  model: AtomModel,
  countries: readonly TerritoryCountry[],
  options: Parameters<typeof growTerritory>[2],
): TerritoryResult {
  try {
    return growTerritory(model.atoms, countries, options);
  } catch (error) {
    if (!(error instanceof ServiceError) || typeof error.details.atom !== 'number') throw error;
    const atom = describeAtom(model, error.details.atom);
    const capital =
      typeof error.details.capital === 'number'
        ? describeAtom(model, error.details.capital)
        : undefined;
    const rest = Object.fromEntries(
      Object.entries(error.details).filter(([key]) => key !== 'atom' && key !== 'capital'),
    );
    throw new ServiceError(error.code, error.message.replace(/^Atom \d+/u, atom.words), {
      ...rest,
      ...atom.details,
      ...(capital === undefined ? {} : { capital: capital.details }),
    });
  }
}

function limited(values: readonly number[], limit = 1_000): number[] {
  return values.slice(0, limit);
}

export function* applyAssignTerritory(
  base: MapWorkspaceIndex,
  changes: Map<string, MutableChange>,
  allocations: AllocationEvidence[],
  operation: AssignTerritoryOperation,
  signal?: AbortSignal,
): MapOperationSteps<TerritoryOutcome> {
  if (operation.countries.length === 0)
    refuse('MAP_TERRITORY_COUNTRIES_MISSING', 'assign_territory needs at least one country');
  if (operation.countries.length > TERRITORY_MAX_COUNTRIES)
    refuse(
      'MAP_TERRITORY_TOO_MANY_COUNTRIES',
      `assign_territory accepts at most ${TERRITORY_MAX_COUNTRIES} countries, not ${operation.countries.length}`,
      { countries: operation.countries.length, limit: TERRITORY_MAX_COUNTRIES },
    );
  const unit = operation.unit ?? 'state';
  if (unit === 'state' && operation.stateSize !== undefined)
    refuse(
      'MAP_TERRITORY_STATE_SIZE_NEEDS_PROVINCE_UNIT',
      'stateSize regroups provinces into states; it needs unit "province"',
    );
  if (operation.stateSize?.max !== undefined && operation.stateSize.max < operation.stateSize.min)
    refuse('MAP_TERRITORY_STATE_SIZE_INVALID', 'stateSize.max must not be below stateSize.min');
  const index = currentIndex(base, changes);
  const world = yield* buildTerritoryWorld(index, signal);
  const model = buildAtomModel(world, unit, operation.scope);
  const atoms = model.atoms;
  const policy = ownershipPolicy(operation.ownership);
  const countries: TerritoryCountry[] = [];
  const extraCores: Array<Set<number>> = [];
  const extraClaims: Array<Set<number>> = [];
  for (const country of operation.countries) {
    const label = `Country ${country.tag}`;
    const seeds = country.seeds.map((ref) => resolveRef(world, model, ref, `${label} seed`));
    const forced = [...resolveSelection(world, model, country.forced, `${label} forced`)];
    const blocked = [...resolveSelection(world, model, country.blocked, `${label} blocked`)];
    extraCores.push(resolveSelection(world, model, country.cores, `${label} cores`));
    extraClaims.push(resolveSelection(world, model, country.claims, `${label} claims`));
    const entry: TerritoryCountry = {
      tag: country.tag,
      weight: country.weight ?? 1,
      seeds,
      forced,
      blocked,
      homeRegions: country.regions ?? [],
    };
    if (country.overlord !== undefined) entry.overlord = country.overlord;
    if (country.mergeInto !== undefined) entry.mergeInto = country.mergeInto;
    countries.push(entry);
    yield;
  }
  const unowned = [...resolveSelection(world, model, operation.unowned, 'unowned')];
  const options = {
    barriers: operation.barriers ?? 'natural',
    seed: operation.seed ?? 0,
    unowned,
    excluded: model.excluded,
    ...(operation.shareTolerance === undefined ? {} : { shareTolerance: operation.shareTolerance }),
    rules: {
      ...(operation.rules?.connectedMainland === undefined
        ? {}
        : { connectedMainland: operation.rules.connectedMainland }),
      ...(operation.rules?.islandPolicy === undefined
        ? {}
        : { islandPolicy: operation.rules.islandPolicy }),
    },
    smoothing: {
      ...(operation.smoothing?.passes === undefined ? {} : { passes: operation.smoothing.passes }),
      ...(operation.smoothing?.maxShareChange === undefined
        ? {}
        : { maxShareChange: operation.smoothing.maxShareChange }),
    },
    ...(signal === undefined ? {} : { signal }),
  } as const;
  const result: TerritoryResult = growInRequestTerms(model, countries, options);
  yield;
  // The comparison: the same seeds and weights on distance alone.
  const provinceCount = world.table.provinceKinds.length;
  const baseline = growInRequestTerms(model, countries, {
    ...options,
    barriers: 'none',
    smoothing: { passes: 0 },
  });
  const score = scoreBorderAssignment(
    world.table,
    provinceLabelsOf(model, result.owner, provinceCount),
  );
  const baselineScore = scoreBorderAssignment(
    world.table,
    provinceLabelsOf(model, baseline.owner, provinceCount),
  );
  const tagOf = (country: number): string | undefined =>
    country < 0 ? undefined : result.tags[country];
  const addTags = (extras: readonly Set<number>[], atomsOfGroup: Iterable<number>): string[] => {
    const tags = new Set<string>();
    for (const atom of atomsOfGroup)
      for (const [position, set] of extras.entries())
        if (set.has(atom)) tags.add(result.tags[position]!);
    return [...tags];
  };
  const states = new Map(index.statesById);
  let ownershipChanged = 0;
  const summary = { changed: [] as number[], created: [] as number[], removed: [] as number[] };
  if (unit === 'state') {
    const excluded = excludedSet(model);
    for (let atom = 0; atom < atoms.count; atom += 1) {
      if ((atom & 255) === 0) yield;
      if (excluded.has(atom)) continue;
      const stateId = model.stateOfAtom[atom]!;
      const state = states.get(stateId)!;
      const country = result.owner[atom]!;
      const edited = editOwnership(
        changes,
        state,
        {
          owner: tagOf(country),
          origin:
            country >= 0 && result.origin[atom] !== country
              ? tagOf(result.origin[atom]!)
              : undefined,
          addCores: addTags(extraCores, [atom]),
          addClaims: addTags(extraClaims, [atom]),
          unowned: country < 0,
        },
        policy,
        operation.id,
      );
      if (edited) {
        ownershipChanged += 1;
        summary.changed.push(stateId);
      }
    }
  } else {
    const outcome = regroupProvinces(
      world,
      model,
      result,
      policy,
      extraCores,
      extraClaims,
      operation,
      changes,
      allocations,
    );
    ownershipChanged = outcome.ownershipChanged;
    summary.changed = outcome.changed;
    summary.created = outcome.created;
    summary.removed = outcome.removed;
    for (const note of outcome.notes) result.notes.push(note);
  }
  yield;
  const report: TerritoryReport = {
    operationId: operation.id,
    kind: 'assign_territory',
    unit,
    atoms: atoms.count,
    seed: operation.seed ?? 0,
    barriers: operation.barriers ?? 'natural',
    stats: result.stats,
    baseline: {
      naturalShare: baselineScore.naturalShare,
      enrichment: baselineScore.enrichment,
      maxShareError: baseline.stats.maxShareError,
    },
    score,
    states: {
      changed: limited(summary.changed),
      created: limited(summary.created),
      removed: limited(summary.removed),
      ownershipChanged,
    },
    notes: result.notes,
    borderQuality: {
      mode: operation.borderQuality ?? 'report',
      layer: 'country',
      ...(operation.borderTargets === undefined ? {} : { targets: operation.borderTargets }),
    },
  };
  return { diagnostics: territoryDiagnostics(operation, world, report, result, model), report };
}

const excludedCache = new WeakMap<AtomModel, Set<number>>();
function excludedSet(model: AtomModel): Set<number> {
  let set = excludedCache.get(model);
  if (set === undefined) {
    set = new Set(model.excluded);
    excludedCache.set(model, set);
  }
  return set;
}

interface RegroupOutcome {
  ownershipChanged: number;
  changed: number[];
  created: number[];
  removed: number[];
  notes: TerritoryNote[];
}

interface UnitGroup {
  id: number;
  stateId: number;
  /** Country index, -1 for none. */
  label: number;
  provinces: number[];
  region: number;
}

/**
 * Province unit: every state is split by owner, small fragments join a neighbour, and the states
 * the border really cut are regrouped in one pass; the others only get their ownership edited.
 */
function regroupProvinces(
  world: TerritoryWorld,
  model: AtomModel,
  result: TerritoryResult,
  policy: OwnershipPlan,
  extraCores: readonly Set<number>[],
  extraClaims: readonly Set<number>[],
  operation: AssignTerritoryOperation,
  changes: Map<string, MutableChange>,
  allocations: AllocationEvidence[],
): RegroupOutcome {
  const { index } = world;
  const atoms = model.atoms;
  const notes: TerritoryNote[] = [];
  const excluded = excludedSet(model);
  const pixels = (province: number): number =>
    index.raster?.geometry.get(province)?.pixelCount ?? 0;
  const groups = new Map<number, UnitGroup>();
  const groupOfProvince = new Map<number, number>();
  let nextId = 0;
  const statesInOrder = [...index.states].sort((a, b) => a.id - b.id);
  for (const state of statesInOrder) {
    const members = state.provinces.filter(
      (province) =>
        atoms.atomOfProvince[province]! >= 0 && !excluded.has(atoms.atomOfProvince[province]!),
    );
    if (members.length === 0) continue;
    const byLabel = new Map<number, number[]>();
    for (const province of members) {
      const label = result.owner[atoms.atomOfProvince[province]!]!;
      const list = byLabel.get(label) ?? [];
      list.push(province);
      byLabel.set(label, list);
    }
    const others = state.provinces.filter((province) => !members.includes(province));
    const sortedLabels = [...byLabel.keys()].sort((a, b) => a - b);
    // Provinces of the state that cannot be owned (sea, lake) stay with its largest part.
    const largest = sortedLabels
      .slice()
      .sort(
        (a, b) =>
          byLabel.get(b)!.reduce((sum, p) => sum + pixels(p), 0) -
            byLabel.get(a)!.reduce((sum, p) => sum + pixels(p), 0) || a - b,
      )[0]!;
    for (const label of sortedLabels) {
      const provinces = [...byLabel.get(label)!, ...(label === largest ? others : [])].sort(
        (a, b) => a - b,
      );
      const group: UnitGroup = {
        id: nextId++,
        stateId: state.id,
        label,
        provinces,
        region: dominantRegion(index, provinces),
      };
      groups.set(group.id, group);
      for (const province of provinces) groupOfProvince.set(province, group.id);
    }
  }
  // Fragments below the minimum join the neighbour of the same owner and region that shares the
  // longest border.
  const minimum = operation.stateSize?.min ?? 1;
  const maximum = operation.stateSize?.max ?? Number.POSITIVE_INFINITY;
  if (minimum > 1) {
    const graph = world.graph.graph;
    const neighbours = new Map<number, Map<number, number>>();
    const link = (a: number, b: number, length: number): void => {
      const row = neighbours.get(a) ?? new Map<number, number>();
      row.set(b, (row.get(b) ?? 0) + length);
      neighbours.set(a, row);
    };
    for (const group of groups.values())
      for (const province of group.provinces)
        for (let slot = graph.offsets[province]!; slot < graph.offsets[province + 1]!; slot += 1) {
          const other = groupOfProvince.get(graph.to[slot]!);
          if (other !== undefined && other !== group.id) link(group.id, other, graph.length[slot]!);
        }
    const stuck = new Set<number>();
    for (;;) {
      const small = [...groups.values()]
        .filter((group) => group.provinces.length < minimum && !stuck.has(group.id))
        .sort((a, b) => a.provinces.length - b.provinces.length || a.id - b.id)[0];
      if (small === undefined) break;
      let target: UnitGroup | undefined;
      let best = -1;
      for (const [otherId, length] of [...(neighbours.get(small.id) ?? [])].sort(
        ([a], [b]) => a - b,
      )) {
        const other = groups.get(otherId);
        if (
          other?.label !== small.label ||
          other.region !== small.region ||
          other.provinces.length + small.provinces.length > maximum
        )
          continue;
        if (length > best) {
          best = length;
          target = other;
        }
      }
      if (target === undefined) {
        stuck.add(small.id);
        continue;
      }
      target.provinces = [...target.provinces, ...small.provinces].sort((a, b) => a - b);
      for (const province of small.provinces) groupOfProvince.set(province, target.id);
      for (const [otherId, length] of neighbours.get(small.id) ?? []) {
        if (otherId === target.id) continue;
        link(target.id, otherId, length);
        const row = neighbours.get(otherId);
        if (row !== undefined) {
          row.delete(small.id);
          row.set(target.id, (row.get(target.id) ?? 0) + length);
        }
      }
      neighbours.get(target.id)?.delete(small.id);
      neighbours.delete(small.id);
      groups.delete(small.id);
    }
    if (stuck.size > 0)
      notes.push({
        code: 'MAP_TERRITORY_STATE_SIZE_UNMET',
        message: `${stuck.size} state fragment(s) below ${minimum} provinces have no neighbour of the same owner and strategic region to join and stay as they are`,
        details: { fragments: stuck.size },
      });
  }
  // Groups equal to an old state only change owner; the others are regrouped in one pass.
  const restructure: RestructureGroup[] = [];
  let ownershipChanged = 0;
  const changed: number[] = [];
  const tagOf = (country: number): string | undefined =>
    country < 0 ? undefined : result.tags[country];
  const originTag = (group: UnitGroup): string | undefined => {
    const atom = atoms.atomOfProvince[group.provinces.find((p) => atoms.atomOfProvince[p]! >= 0)!]!;
    const origin = result.origin[atom];
    return origin !== undefined && origin >= 0 && origin !== group.label
      ? tagOf(origin)
      : undefined;
  };
  const tagsFor = (extras: readonly Set<number>[], group: UnitGroup): string[] => {
    const tags = new Set<string>();
    for (const province of group.provinces) {
      const atom = atoms.atomOfProvince[province]!;
      if (atom < 0) continue;
      for (const [position, set] of extras.entries())
        if (set.has(atom)) tags.add(result.tags[position]!);
    }
    return [...tags];
  };
  for (const group of [...groups.values()].sort((a, b) => a.id - b.id)) {
    const old = index.statesById.get(group.stateId)!;
    const oldSorted = [...old.provinces].sort((a, b) => a - b);
    const same =
      group.provinces.length === oldSorted.length &&
      group.provinces.every((province, position) => province === oldSorted[position]);
    const owner = tagOf(group.label);
    const origin = originTag(group);
    const addCores = tagsFor(extraCores, group);
    const addClaims = tagsFor(extraClaims, group);
    if (same) {
      if (
        editOwnership(
          changes,
          old,
          { owner, origin, addCores, addClaims, unowned: group.label < 0 },
          policy,
          operation.id,
        )
      ) {
        ownershipChanged += 1;
        changed.push(old.id);
      }
      continue;
    }
    const tags = [owner, origin].filter((tag): tag is string => tag !== undefined);
    const entry: RestructureGroup = { provinces: group.provinces };
    if (!(group.label < 0 && policy.unowned === 'keep')) entry.owner = owner ?? null;
    if (policy.controller === 'owner' && !(group.label < 0 && policy.unowned === 'keep'))
      entry.controller = owner ?? null;
    if (policy.cores === 'owner') entry.cores = uniqueStrings([...tags, ...addCores]);
    else
      entry.addCores = uniqueStrings([...(policy.cores === 'add-owner' ? tags : []), ...addCores]);
    if (policy.claims === 'clear') entry.claims = [];
    if (addClaims.length > 0) entry.addClaims = addClaims;
    restructure.push(entry);
  }
  let created: number[] = [];
  let removed: number[] = [];
  if (restructure.length > 0) {
    const summary = restructureStates(world.index, changes, allocations, restructure, {
      operationId: operation.id,
      ...(operation.remapReferences === undefined
        ? {}
        : { remapReferences: operation.remapReferences }),
    });
    created = summary.created;
    removed = summary.removed;
    changed.push(...summary.changed);
    ownershipChanged += restructure.length;
  }
  return { ownershipChanged, changed, created, removed, notes };
}

// ---------------------------------------------------------------------------------------------
// Diagnostics

function territoryDiagnostics(
  operation: AssignTerritoryOperation,
  world: TerritoryWorld,
  report: TerritoryReport,
  result: TerritoryResult,
  model: AtomModel,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const stats = result.stats;
  const worst = stats.countries
    .slice()
    .sort((a, b) => b.shareError - a.shareError || (a.tag < b.tag ? -1 : 1))
    .slice(0, 5)
    .map(({ tag, share, targetShare, shareError }) => ({ tag, share, targetShare, shareError }));
  diagnostics.push({
    code: 'MAP_TERRITORY_ASSIGNED',
    severity: 'info',
    category: 'map',
    operationId: operation.id,
    message: `Assigned ${stats.assignedAtoms} ${model.unit}${stats.assignedAtoms === 1 ? '' : 's'} to ${stats.countries.length} countries: ${report.states.ownershipChanged} state(s) changed owner or ownership, ${report.states.created.length} created, ${report.states.removed.length} removed. Natural share of country borders ${report.score.naturalShare ?? 'n/a'} (distance only ${report.baseline?.naturalShare ?? 'n/a'}), enrichment ${report.score.enrichment ?? 'n/a'} (distance only ${report.baseline?.enrichment ?? 'n/a'}); largest size error ${(stats.maxShareError * 100).toFixed(1)}%.`,
    details: {
      unit: model.unit,
      countries: stats.countries.length,
      assignedAtoms: stats.assignedAtoms,
      unownedAtoms: stats.unownedAtoms,
      maxShareError: stats.maxShareError,
      rounds: stats.rounds,
      smoothingMoves: stats.smoothingMoves,
      corridors: stats.corridors,
      score: report.score,
      baseline: report.baseline,
      worstShareErrors: worst,
      states: {
        changed: report.states.changed.length,
        created: report.states.created.length,
        removed: report.states.removed.length,
      },
    },
  });
  const tolerance = operation.shareTolerance ?? 0.15;
  if (stats.maxShareError > tolerance)
    diagnostics.push({
      code: 'MAP_TERRITORY_SHARE_OFF',
      severity: 'warning',
      category: 'map',
      operationId: operation.id,
      message: `${stats.countries.filter((entry) => entry.shareError > tolerance).length} countr${stats.countries.filter((entry) => entry.shareError > tolerance).length === 1 ? 'y is' : 'ies are'} more than ${(tolerance * 100).toFixed(0)}% from their target size (largest ${(stats.maxShareError * 100).toFixed(1)}%); whole ${model.unit}s are too coarse, blocked or forced land limits them, or islands went to a neighbour. Use unit "province" or move seeds.`,
      details: { tolerance, worst },
    });
  const split = stats.countries.filter((entry) => entry.pieces > entry.landmasses);
  if (split.length > 0)
    diagnostics.push({
      code: 'MAP_TERRITORY_DISCONNECTED',
      severity: 'warning',
      category: 'map',
      operationId: operation.id,
      message: `${split.length} countr${split.length === 1 ? 'y has' : 'ies have'} territory in several pieces on one landmass (${split
        .slice(0, 8)
        .map(({ tag }) => tag)
        .join(', ')}); anchors or forced land lie apart from the capital`,
      details: {
        countries: split
          .slice(0, 20)
          .map(({ tag, pieces, landmasses }) => ({ tag, pieces, landmasses })),
      },
    });
  const missing = (['heights', 'rivers', 'terrain'] as const).filter(
    (name) => !world.table.inputs[name],
  );
  if (missing.length === 3)
    diagnostics.push({
      code: 'MAP_TERRITORY_NO_FEATURES',
      severity: 'info',
      category: 'map',
      operationId: operation.id,
      message:
        'The mod has no height, river or terrain bitmap of the province map size, so there are no natural lines to follow; borders fall back to distance and the requested sizes',
      details: { skipped: world.skipped },
    });
  for (const note of result.notes)
    diagnostics.push({
      code: note.code,
      severity: 'info',
      category: 'map',
      operationId: operation.id,
      message: note.message,
      ...(note.details === undefined ? {} : { details: note.details }),
    });
  return diagnostics;
}

// ---------------------------------------------------------------------------------------------
// repartition_states

export function* applyRepartitionStates(
  base: MapWorkspaceIndex,
  changes: Map<string, MutableChange>,
  allocations: AllocationEvidence[],
  operation: RepartitionStatesOperation,
  signal?: AbortSignal,
): MapOperationSteps<TerritoryOutcome> {
  const min = operation.provincesPerState?.min ?? 3;
  const max = operation.provincesPerState?.max ?? 10;
  const target = operation.provincesPerState?.target ?? Math.round((min + max) / 2);
  if (!(min >= 1 && min <= target && target <= max))
    refuse(
      'MAP_TERRITORY_STATE_SIZE_INVALID',
      `provincesPerState needs 1 <= min <= target <= max; got ${min}, ${target}, ${max}`,
      { min, target, max },
    );
  const index = currentIndex(base, changes);
  const world = yield* buildTerritoryWorld(index, signal);
  const owners = operation.countries === undefined ? undefined : new Set(operation.countries);
  const wantedStates = operation.stateIds === undefined ? undefined : new Set(operation.stateIds);
  for (const id of wantedStates ?? [])
    if (!index.statesById.has(id))
      refuse('MAP_TERRITORY_STATE_UNKNOWN', `State ${id} does not exist`, { stateId: id });
  const notes: TerritoryNote[] = [];
  // Buckets: states of one owner whose land lies in one strategic region.
  const buckets = new Map<string, { owner: string; region: number; states: StateRecord[] }>();
  let skipped = 0;
  const statesInOrder = [...index.states].sort((a, b) => a.id - b.id);
  for (const state of statesInOrder) {
    if (wantedStates !== undefined && !wantedStates.has(state.id)) continue;
    if (owners !== undefined && !owners.has(state.owner ?? 'NONE')) continue;
    const land = state.provinces.filter((province) => isLandProvince(world.table, province));
    if (land.length === 0) continue;
    const regions = new Set(
      state.provinces.map((province) => index.regionForProvince(province)[0]?.id ?? -1),
    );
    if (
      regions.size > 1 ||
      state.provinces.some((province) => index.stateForProvince(province).length !== 1)
    ) {
      skipped += 1;
      continue;
    }
    const region = [...regions][0]!;
    const key = `${state.owner ?? ''}:${region}`;
    const bucket = buckets.get(key) ?? { owner: state.owner ?? '', region, states: [] };
    bucket.states.push(state);
    buckets.set(key, bucket);
  }
  if (skipped > 0)
    notes.push({
      code: 'MAP_TERRITORY_STATE_SKIPPED',
      message: `${skipped} state(s) span several strategic regions or share provinces with another state and were left as they are`,
      details: { skipped },
    });
  if (buckets.size === 0)
    refuse(
      'MAP_TERRITORY_NOTHING_TO_REPARTITION',
      'No state matches the selection (owners, stateIds), so there is nothing to regroup',
    );
  const graph = world.graph.graph;
  const oldLabel = new Int32Array(world.table.provinceKinds.length).fill(-1);
  const newLabel = new Int32Array(world.table.provinceKinds.length).fill(-1);
  const restructure: RestructureGroup[] = [];
  let groupCount = 0;
  let unchanged = 0;
  for (const bucket of [...buckets.values()].sort((a, b) =>
    a.owner === b.owner ? a.region - b.region : a.owner < b.owner ? -1 : 1,
  )) {
    yield;
    const members = bucket.states.flatMap((state) =>
      state.provinces.filter((province) => isLandProvince(world.table, province)),
    );
    for (const state of bucket.states)
      for (const province of state.provinces) oldLabel[province] = state.id;
    const clusters = clusterProvinces(members, graph, { min, target, max });
    const byCluster = new Map<number, number[]>();
    for (const [province, cluster] of clusters) {
      const list = byCluster.get(cluster) ?? [];
      list.push(province);
      byCluster.set(cluster, list);
    }
    // Provinces that are not land (inside a state) stay with the cluster holding most of their state.
    const clusterOfState = new Map<number, number>();
    for (const state of bucket.states) {
      const tally = new Map<number, number>();
      for (const province of state.provinces) {
        const cluster = clusters.get(province);
        if (cluster !== undefined) tally.set(cluster, (tally.get(cluster) ?? 0) + 1);
      }
      const best = [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      if (best !== undefined) clusterOfState.set(state.id, best[0]);
      for (const province of state.provinces)
        if (!clusters.has(province) && best !== undefined) byCluster.get(best[0])!.push(province);
    }
    for (const cluster of [...byCluster.keys()].sort((a, b) => a - b)) {
      const provinces = byCluster.get(cluster)!.sort((a, b) => a - b);
      const id = groupCount++;
      for (const province of provinces) newLabel[province] = id;
      const first = bucket.states.find((state) => state.provinces.includes(provinces[0]!));
      const identical =
        first?.provinces.length === provinces.length &&
        [...first.provinces]
          .sort((a, b) => a - b)
          .every((province, position) => province === provinces[position]);
      if (identical) {
        unchanged += 1;
        continue;
      }
      restructure.push({ provinces });
    }
  }
  yield;
  let summary = { changed: [] as number[], created: [] as number[], removed: [] as number[] };
  if (restructure.length > 0)
    summary = restructureStates(index, changes, allocations, restructure, {
      operationId: operation.id,
      ...(operation.remapReferences === undefined
        ? {}
        : { remapReferences: operation.remapReferences }),
    });
  yield;
  const before = scoreBorderAssignment(world.table, oldLabel);
  const after = scoreBorderAssignment(world.table, newLabel);
  const report: TerritoryReport = {
    operationId: operation.id,
    kind: 'repartition_states',
    unit: 'province',
    atoms: groupCount,
    seed: 0,
    barriers: 'natural',
    score: after,
    before,
    states: {
      changed: limited(summary.changed),
      created: limited(summary.created),
      removed: limited(summary.removed),
      ownershipChanged: 0,
    },
    notes,
    borderQuality: {
      mode: operation.borderQuality ?? 'report',
      layer: 'state',
      ...(operation.borderTargets === undefined ? {} : { targets: operation.borderTargets }),
    },
  };
  const diagnostics: Diagnostic[] = [
    {
      code: 'MAP_TERRITORY_REPARTITIONED',
      severity: 'info',
      category: 'map',
      operationId: operation.id,
      message: `Regrouped ${buckets.size} owner and region bucket(s) into ${groupCount} state(s): ${unchanged} kept as they were, ${summary.changed.length} rewritten, ${summary.created.length} created, ${summary.removed.length} removed. Natural share of state borders ${after.naturalShare ?? 'n/a'} (before ${before.naturalShare ?? 'n/a'}), enrichment ${after.enrichment ?? 'n/a'} (before ${before.enrichment ?? 'n/a'}).`,
      details: {
        buckets: buckets.size,
        states: groupCount,
        unchanged,
        rewritten: summary.changed.length,
        created: summary.created.length,
        removed: summary.removed.length,
        score: after,
        before,
        provincesPerState: { min, target, max },
      },
    },
    ...notes.map((note): Diagnostic => ({
      code: note.code,
      severity: 'info',
      category: 'map',
      operationId: operation.id,
      message: note.message,
      ...(note.details === undefined ? {} : { details: note.details }),
    })),
  ];
  return { diagnostics, report };
}
