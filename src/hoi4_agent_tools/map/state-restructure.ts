import { compareCodeUnits } from '../core/canonical.js';
import { ServiceError } from '../core/result.js';
import { assignments, encodeSource, parseLocalisation } from '../core/source/index.js';
import type { SourceReplacement } from '../core/source/index.js';
import type { MapWorkspaceIndex, StateRecord } from './model.js';
import { parseMapDate } from './model.js';
import {
  addChange,
  appendLocalisationEntry,
  applyTextRanges,
  assertDatedStateHistorySafe,
  buildingPositionLine,
  cloneState,
  commitState,
  compileState,
  currentIndex,
  escapedLocalisationValue,
  isLevelStateBuilding,
  localisationEntryLine,
  maximumObservedId,
  normalizeRelative,
  regionMembershipId,
  removalContent,
  remapScriptReferences,
  requireSafeLocalisationDocument,
  rootEvidence,
  uniqueStrings,
  type AllocationEvidence,
  type MutableChange,
  type StateData,
  type StatePatchFields,
} from './operations.js';

/**
 * Bulk state restructuring (ADR 0060). Given a complete new grouping of the provinces of some
 * states, rewrite the state files in one pass: the group that overlaps an old state most keeps
 * its identifier, file and history; other groups become new states; old states that no group
 * inherits are removed. Population, resources and slot buildings follow the land by pixel share
 * (whole units, remainders to the largest share, so every total is conserved); levels keep the
 * highest value; victory points and province buildings follow their provinces; cores and claims
 * are the union of the contributing states. The same code serves `assign_territory` (province
 * mode) and `repartition_states`, so neither re-indexes the workspace per state.
 */

export interface RestructureGroup {
  provinces: readonly number[];
  /** Ownership to write; an omitted field is taken from the group's heir. `null` clears it. */
  owner?: string | null;
  controller?: string | null;
  cores?: readonly string[];
  claims?: readonly string[];
  /** Tags added to the cores and claims after they are derived or replaced. */
  addCores?: readonly string[];
  addClaims?: readonly string[];
}

export interface RestructureOptions {
  operationId: string;
  remapReferences?: 'refuse' | 'override';
}

export interface RestructureSummary {
  /** States that keep their identifier and were rewritten. */
  changed: number[];
  created: number[];
  removed: number[];
  /** Old state id to the group index that inherited it. */
  heirs: Array<{ stateId: number; group: number }>;
  /** Final state id of every group, in the order given. */
  stateIds: number[];
}

/**
 * Split `total` into whole shares proportional to `weights` so the parts add up exactly. Integers
 * use the largest-remainder rule; a value with decimals is shared in hundredths.
 */
export function apportion(total: number, weights: readonly number[]): number[] {
  const scale = Number.isInteger(total) ? 1 : 100;
  const units = Math.round(total * scale);
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  if (weights.length === 0) return [];
  if (sum <= 0) {
    const shares = weights.map(() => 0);
    shares[0] = units;
    return shares.map((share) => share / scale);
  }
  const raw = weights.map((weight) => (units * weight) / sum);
  const shares = raw.map((value) => Math.floor(value));
  let remaining = units - shares.reduce((acc, share) => acc + share, 0);
  const order = raw
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let position = 0; remaining > 0 && order.length > 0; position += 1, remaining -= 1)
    shares[order[position % order.length]!.index]! += 1;
  return shares.map((share) => share / scale);
}

function statesOfGroups(index: MapWorkspaceIndex, groups: readonly RestructureGroup[]) {
  const owner = new Map<number, StateRecord>();
  const seen = new Map<number, number>();
  for (const [position, group] of groups.entries()) {
    if (group.provinces.length === 0)
      throw new ServiceError(
        'MAP_STATE_WOULD_BE_EMPTY',
        `State group ${position} has no provinces`,
      );
    for (const province of group.provinces) {
      if (seen.has(province))
        throw new ServiceError(
          'MAP_STATE_PROVINCE_SELECTION_INVALID',
          `Province ${province} appears in state groups ${seen.get(province)!} and ${position}`,
          { province },
        );
      seen.set(province, position);
      const states = index.stateForProvince(province);
      if (states.length !== 1)
        throw new ServiceError(
          'MAP_STATE_MEMBERSHIP_AMBIGUOUS',
          `Province ${province} must belong to exactly one state to be regrouped`,
          { province, states: states.map(({ id }) => id) },
        );
      owner.set(province, states[0]!);
    }
  }
  return { stateOfProvince: owner, groupOfProvince: seen };
}

/** Rewrite the state files so that exactly `groups` hold the provinces of the states they touch. */
export function restructureStates(
  base: MapWorkspaceIndex,
  changes: Map<string, MutableChange>,
  allocations: AllocationEvidence[],
  groups: readonly RestructureGroup[],
  options: RestructureOptions,
): RestructureSummary {
  const index = currentIndex(base, changes);
  const operationId = options.operationId;
  const { stateOfProvince, groupOfProvince } = statesOfGroups(index, groups);
  const affected = new Map<number, StateRecord>();
  for (const state of stateOfProvince.values()) affected.set(state.id, state);
  if (affected.size === 0)
    return { changed: [], created: [], removed: [], heirs: [], stateIds: [] };
  // The groups must cover every province of every state they touch.
  for (const state of affected.values())
    for (const province of state.provinces)
      if (!groupOfProvince.has(province))
        throw new ServiceError(
          'MAP_STATE_RESTRUCTURE_INCOMPLETE',
          `State ${state.id} would lose province ${province} to no state; every province of a regrouped state needs a group`,
          { stateId: state.id, province },
        );
  const pixels = (province: number): number =>
    index.raster?.geometry.get(province)?.pixelCount ?? 0;
  // Pixel overlap of every group with every old state.
  const overlap: Array<Map<number, number>> = groups.map(() => new Map<number, number>());
  const stateTotals = new Map<number, number>();
  for (const [position, group] of groups.entries())
    for (const province of group.provinces) {
      const state = stateOfProvince.get(province)!;
      const size = pixels(province);
      overlap[position]!.set(state.id, (overlap[position]!.get(state.id) ?? 0) + size);
    }
  for (const state of affected.values())
    stateTotals.set(
      state.id,
      state.provinces.reduce((sum, province) => sum + pixels(province), 0),
    );
  for (const [stateId, total] of stateTotals)
    if (total <= 0)
      throw new ServiceError(
        'MAP_STATE_DISTRIBUTION_GEOMETRY_MISSING',
        `State ${stateId} has no province geometry; proportional distribution needs the province map`,
        { stateId },
      );
  // Heirs: the biggest overlaps first; ties go to the lower state id and group index.
  const pairs: Array<{ group: number; state: number; pixels: number }> = [];
  for (const [position, map] of overlap.entries())
    for (const [state, px] of map) pairs.push({ group: position, state, pixels: px });
  pairs.sort((a, b) => b.pixels - a.pixels || a.state - b.state || a.group - b.group);
  const heirOfGroup = new Map<number, number>();
  const groupOfHeir = new Map<number, number>();
  for (const pair of pairs) {
    if (heirOfGroup.has(pair.group) || groupOfHeir.has(pair.state)) continue;
    heirOfGroup.set(pair.group, pair.state);
    groupOfHeir.set(pair.state, pair.group);
  }
  // A group takes provinces of one strategic region only.
  for (const [position, group] of groups.entries()) {
    const regions = new Set(group.provinces.map((province) => regionMembershipId(index, province)));
    if (regions.size > 1)
      throw new ServiceError(
        'MAP_STATE_REGION_DISTRIBUTION_CONFLICT',
        `State group ${position} (provinces ${group.provinces.slice(0, 6).join(', ')}...) spans strategic regions ${[...regions].join(', ')}; a state may hold provinces of one region only`,
        { group: position, regions: [...regions] },
      );
  }
  // Dated history cannot follow a regrouping safely.
  const removedStates = [...affected.values()].filter((state) => !groupOfHeir.has(state.id));
  for (const state of removedStates) {
    const dated =
      state.historyBlock === undefined
        ? undefined
        : assignments(state.historyBlock).find(
            (entry) => entry.value.type === 'block' && parseMapDate(entry.key.value) !== undefined,
          );
    if (dated !== undefined)
      throw new ServiceError(
        'MAP_DATED_STATE_HISTORY_CONFLICT',
        `State ${state.id} has dated history (${dated.key.value}) that would be lost when its provinces move to other states; edit or move that block first`,
        { stateId: state.id, datedAt: dated.key.value, sourcePath: state.file.displayPath },
      );
  }
  // Allocate identifiers for groups with no heir: the lowest positive ids no root uses.
  const used = new Set(index.statesAcrossRoots.map(({ id }) => id));
  const highest = maximumObservedId(
    index.statesAcrossRoots.map(({ id }) => id),
    0,
  );
  const roots = rootEvidence(index.statesAcrossRoots.map(({ id, file }) => ({ id, file })));
  const stateIds: number[] = [];
  let cursor = 1;
  let probes = 0;
  for (const position of groups.keys()) {
    const heir = heirOfGroup.get(position);
    if (heir !== undefined) {
      stateIds.push(heir);
      continue;
    }
    while (used.has(cursor)) {
      cursor += 1;
      probes += 1;
    }
    if (cursor >= 2_147_483_647)
      throw new ServiceError('MAP_STATE_ID_EXHAUSTED', 'No safe state ID remains available');
    used.add(cursor);
    stateIds.push(cursor);
    allocations.push({
      kind: 'state-id',
      allocated: cursor,
      strategy: 'lowest-positive-unused-active-id-across-roots',
      highestObserved: highest,
      probes: probes + 1,
      roots,
    });
  }
  // Values: each old state shares its numbers among the groups that took its land.
  interface Contribution {
    manpower: number;
    resources: Map<string, number>;
    buildings: Map<string, number>;
  }
  const contributions: Array<Map<number, Contribution>> = groups.map(
    () => new Map<number, Contribution>(),
  );
  for (const state of affected.values()) {
    const takers = groups.flatMap((_, position) =>
      overlap[position]!.has(state.id) ? [position] : [],
    );
    const weights = takers.map((position) => overlap[position]!.get(state.id)!);
    const manpower = apportion(state.manpower, weights);
    const resourceShares = new Map<string, number[]>();
    for (const [resource, amount] of state.resources)
      resourceShares.set(resource, apportion(amount, weights));
    const buildingShares = new Map<string, number[] | 'level'>();
    for (const [building, amount] of state.stateBuildings)
      buildingShares.set(
        building,
        isLevelStateBuilding(index, building) ? 'level' : apportion(amount, weights),
      );
    for (const [slot, position] of takers.entries()) {
      const resources = new Map<string, number>();
      for (const [resource, shares] of resourceShares)
        if (shares[slot]! !== 0) resources.set(resource, shares[slot]!);
      const buildings = new Map<string, number>();
      for (const [building, shares] of buildingShares) {
        const value = shares === 'level' ? state.stateBuildings.get(building)! : shares[slot]!;
        if (value !== 0) buildings.set(building, value);
      }
      contributions[position]!.set(state.id, { manpower: manpower[slot]!, resources, buildings });
    }
  }
  // Ownership fields written for a group, and whether they differ from the heir's.
  const sameList = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((value, position) => value === right[position]);
  const changed: number[] = [];
  const created: number[] = [];
  const names: Array<[string, string]> = [];
  const nameCounts = new Map<number, number>();
  const provinceState = new Map<number, number>();
  const statesRoot = index.sourceRoots.states[0] ?? 'history/states';
  const reservedFiles = new Set<string>();
  for (const [position, group] of groups.entries()) {
    const heirId = heirOfGroup.get(position);
    const parts = [...contributions[position]!.keys()].sort((a, b) => a - b);
    const sources = parts.map((id) => affected.get(id)!);
    const primaryId =
      heirId ?? [...overlap[position]!].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
    const primary = affected.get(primaryId)!;
    const provinces = [...group.provinces].sort((a, b) => a - b);
    const set = new Set(provinces);
    const data: StateData = cloneState(primary);
    data.provinces = provinces;
    data.manpower = 0;
    data.resources = new Map();
    data.stateBuildings = new Map();
    for (const id of parts) {
      const part = contributions[position]!.get(id)!;
      data.manpower += part.manpower;
      for (const [resource, amount] of part.resources)
        data.resources.set(resource, (data.resources.get(resource) ?? 0) + amount);
      for (const [building, amount] of part.buildings)
        data.stateBuildings.set(
          building,
          isLevelStateBuilding(index, building)
            ? Math.max(data.stateBuildings.get(building) ?? 0, amount)
            : (data.stateBuildings.get(building) ?? 0) + amount,
        );
    }
    for (const [resource, amount] of data.resources)
      data.resources.set(resource, Math.round(amount * 100) / 100);
    data.victoryPoints = sources.flatMap((state) =>
      state.victoryPoints
        .filter(({ provinceId }) => set.has(provinceId))
        .map(({ provinceId, value }) => ({ provinceId, value })),
    );
    data.provinceBuildings = new Map(
      sources.flatMap((state) =>
        [...state.provinceBuildings]
          .filter(([provinceId]) => set.has(provinceId))
          .map(([provinceId, values]) => [provinceId, new Map(values)] as const),
      ),
    );
    data.cores = uniqueStrings(sources.flatMap((state) => state.cores));
    data.claims = uniqueStrings(sources.flatMap((state) => state.claims));
    if (group.cores !== undefined) data.cores = uniqueStrings(group.cores);
    if (group.claims !== undefined) data.claims = uniqueStrings(group.claims);
    if (group.addCores !== undefined)
      data.cores = uniqueStrings([...data.cores, ...group.addCores]);
    if (group.addClaims !== undefined)
      data.claims = uniqueStrings([...data.claims, ...group.addClaims]);
    if (group.owner !== undefined) data.owner = group.owner ?? undefined;
    if (group.controller !== undefined) data.controller = group.controller ?? undefined;
    const finalId = stateIds[position]!;
    for (const province of provinces) provinceState.set(province, finalId);
    if (heirId !== undefined) {
      const heir = affected.get(heirId)!;
      const fields: StatePatchFields = {
        manpower: true,
        resources: true,
        provinces: true,
        victoryPoints: true,
        buildings: true,
      };
      if (!sameList(data.cores, uniqueStrings(heir.cores))) fields.cores = true;
      if (!sameList(data.claims, uniqueStrings(heir.claims))) fields.claims = true;
      if (data.owner !== heir.owner) fields.owner = true;
      if (data.controller !== heir.controller) fields.controller = true;
      commitState(changes, heir, data, fields, operationId);
      changed.push(heirId);
      continue;
    }
    // A new state: the largest source's history, with its undated blocks, under a new identifier.
    assertDatedStateHistorySafe(primary, { provinces: true }, operationId);
    const dated: string[] = [];
    if (primary.historyBlock !== undefined)
      for (const entry of assignments(primary.historyBlock))
        if (entry.value.type === 'block' && parseMapDate(entry.key.value) !== undefined)
          dated.push(primary.document.text.slice(entry.start, entry.end));
    data.id = finalId;
    data.name = `STATE_${finalId}`;
    data.datedHistory = dated;
    let relativePath = `${statesRoot}/${finalId}-AGENT_STATE.txt`;
    for (let suffix = 2; ; suffix += 1) {
      const key = normalizeRelative(relativePath);
      if (!index.activeFiles.byRelativePath.has(key) && !reservedFiles.has(key)) break;
      relativePath = `${statesRoot}/${finalId}-AGENT_STATE_${suffix}.txt`;
    }
    reservedFiles.add(normalizeRelative(relativePath));
    addChange(
      changes,
      relativePath,
      compileState(data, primary.document.newline),
      operationId,
      'text/plain',
    );
    created.push(finalId);
    const label =
      index.localisationByKey.get(`l_english:${primary.name}`)?.[0]?.entry.value ??
      `State ${primary.id}`;
    const ordinal = (nameCounts.get(primary.id) ?? 1) + 1;
    nameCounts.set(primary.id, ordinal);
    names.push([`STATE_${finalId}`, `${label} (${ordinal})`]);
  }
  // Dated history of a heir that loses land is refused by `commitState` above; removed states go.
  for (const state of removedStates)
    addChange(
      changes,
      state.file.relativePath,
      removalContent(index, state.file, `State ${state.id} regrouped into other states`),
      operationId,
      'text/plain',
    );
  remapPositions(index, changes, provinceState, operationId);
  upsertStateNames(index, changes, names, operationId);
  if (options.remapReferences !== undefined) {
    const mapping: Array<{ from: number; to: number | number[] }> = [];
    for (const state of affected.values()) {
      const takers = groups.flatMap((_, position) =>
        overlap[position]!.has(state.id) ? [position] : [],
      );
      const targets = [...new Set(takers.map((position) => stateIds[position]!))];
      const heirGroup = groupOfHeir.get(state.id);
      const keepsId = heirGroup !== undefined;
      const others = targets.filter((id) => id !== state.id);
      if (keepsId && others.length === 0) continue;
      mapping.push({
        from: state.id,
        to: keepsId
          ? [state.id, ...others]
          : takers.length === 1
            ? stateIds[takers[0]!]!
            : (() => {
                const best = takers
                  .slice()
                  .sort(
                    (a, b) => overlap[b]!.get(state.id)! - overlap[a]!.get(state.id)! || a - b,
                  )[0]!;
                return [stateIds[best]!, ...targets.filter((id) => id !== stateIds[best])];
              })(),
      });
    }
    if (mapping.length > 0)
      remapScriptReferences(base, changes, operationId, {
        entity: 'state',
        mapping,
        readOnlySources: options.remapReferences,
      });
  }
  return {
    changed: changed.sort((a, b) => a - b),
    created,
    removed: removedStates.map(({ id }) => id).sort((a, b) => a - b),
    heirs: [...groupOfHeir]
      .map(([stateId, group]) => ({ stateId, group }))
      .sort((a, b) => a.stateId - b.stateId),
    stateIds,
  };
}

/** Point every building position at the state that now holds the province it lies in. */
function remapPositions(
  index: MapWorkspaceIndex,
  changes: Map<string, MutableChange>,
  provinceState: ReadonlyMap<number, number>,
  operationId: string,
): void {
  const documents = new Map(
    index.buildingPositions.map((record) => [record.document.file.relativePath, record.document]),
  );
  for (const [relativePath, document] of documents) {
    const replacements = index.buildingPositions
      .filter((record) => record.document === document)
      .flatMap((record): SourceReplacement[] => {
        const provinceId = index.provinceAtMapCoordinate(record.x, record.z);
        const target = provinceId === undefined ? undefined : provinceState.get(provinceId);
        if (target === undefined || target === record.stateId) return [];
        const line = document.lines[record.line - 1];
        return line === undefined
          ? []
          : [
              {
                start: line.start,
                end: line.end,
                text: buildingPositionLine({ ...record, stateId: target }),
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

/** English names for new states: existing keys in mod files are replaced, others are appended. */
function upsertStateNames(
  index: MapWorkspaceIndex,
  changes: Map<string, MutableChange>,
  entries: readonly (readonly [string, string])[],
  operationId: string,
): void {
  if (entries.length === 0) return;
  const defaultFile = `${index.sourceRoots.localisation[0] ?? 'localisation'}/english/hoi4_agent_map_l_english.yml`;
  const working = new Map<string, Buffer>();
  const current = (relativePath: string): Buffer | undefined => {
    const key = normalizeRelative(relativePath);
    const staged = working.get(key);
    if (staged !== undefined) return staged;
    const change = changes.get(key);
    if (change !== undefined) return change.content ?? undefined;
    return index.activeFiles.byRelativePath.get(key)?.bytes;
  };
  const paths = new Map<string, string>();
  for (const [key, value] of entries) {
    const existing = index.localisationByKey.get(`l_english:${key}`) ?? [];
    if (existing.length > 1)
      throw new ServiceError(
        'MAP_STATE_LOCALISATION_AMBIGUOUS',
        `English localisation key ${key} has multiple active definitions`,
        { key },
      );
    const target =
      existing[0]?.file.rootKind === 'mod' ? existing[0].file.relativePath : defaultFile;
    const bytes = current(target);
    paths.set(normalizeRelative(target), target);
    if (bytes === undefined) {
      working.set(
        normalizeRelative(target),
        encodeSource(`l_english:\n${key}: "${escapedLocalisationValue(value)}"\n`, 'utf8-bom'),
      );
      continue;
    }
    const document = parseLocalisation(bytes, target);
    requireSafeLocalisationDocument(document, target);
    const entry = document.entries.find(
      (candidate) => candidate.key === key && candidate.language === 'l_english',
    );
    if (entry === undefined)
      working.set(normalizeRelative(target), appendLocalisationEntry(document, key, value));
    else
      working.set(
        normalizeRelative(target),
        encodeSource(
          `${document.text.slice(0, entry.start)}${localisationEntryLine(document, entry, value)}${document.text.slice(entry.end)}`,
          'utf8-bom',
        ),
      );
  }
  for (const [key, bytes] of [...working].sort(([left], [right]) => compareCodeUnits(left, right)))
    addChange(changes, paths.get(key)!, bytes, operationId, 'text/yaml');
}
