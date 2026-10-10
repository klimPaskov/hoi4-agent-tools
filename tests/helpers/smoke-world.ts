import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LedgerRow } from './smoke-ledger.js';
import { successProblems, type SmokeResult, type SmokeServer } from './mcp-stdio-smoke.js';

/**
 * The map-modding flow of the stdio smoke suite: generate a world, split and merge a state with
 * its script references, repair a dangling reference, and after every step load-check the files
 * on disk independently of the server's own validator.
 */

export interface WorldRow {
  result: SmokeResult;
  kind: LedgerRow['kind'];
  problems: string[];
}

interface WorldState {
  id: number;
  file: string;
  provinces: number[];
  manpower: number;
  owner: string | undefined;
}

export interface WorldFiles {
  /** Province ID -> province type from `definition.csv`. */
  definitions: Map<number, string>;
  states: Map<number, WorldState>;
  /** Strategic region ID -> province IDs. */
  regions: Map<number, number[]>;
  supplyNodes: number[];
  railways: number[][];
}

function numbers(text: string): number[] {
  return [...text.matchAll(/\d+/gu)].map(([value]) => Number(value));
}

export async function readWorldFiles(mod: string): Promise<WorldFiles> {
  const definitions = new Map<number, string>();
  const definitionText = await readFile(path.join(mod, 'map', 'definition.csv'), 'utf8');
  for (const line of definitionText.split(/\r?\n/u)) {
    const columns = line.split(';');
    if (columns.length < 5 || !/^\d+$/u.test(columns[0]!)) continue;
    definitions.set(Number(columns[0]), columns[4]!);
  }
  const states = new Map<number, WorldState>();
  for (const name of await readdir(path.join(mod, 'history', 'states'))) {
    const text = await readFile(path.join(mod, 'history', 'states', name), 'utf8');
    const id = /^\s*id\s*=\s*(\d+)/mu.exec(text)?.[1];
    if (id === undefined) continue;
    states.set(Number(id), {
      id: Number(id),
      file: name,
      provinces: numbers(/provinces\s*=\s*\{([^}]*)\}/u.exec(text)?.[1] ?? ''),
      manpower: Number(/^\s*manpower\s*=\s*(\d+)/mu.exec(text)?.[1] ?? 0),
      owner: /\bowner\s*=\s*([A-Za-z0-9_]+)/u.exec(text)?.[1],
    });
  }
  const regions = new Map<number, number[]>();
  for (const name of await readdir(path.join(mod, 'map', 'strategicregions'))) {
    const text = await readFile(path.join(mod, 'map', 'strategicregions', name), 'utf8');
    const id = /^\s*id\s*=\s*(\d+)/mu.exec(text)?.[1];
    if (id === undefined) continue;
    regions.set(Number(id), numbers(/provinces\s*=\s*\{([^}]*)\}/u.exec(text)?.[1] ?? ''));
  }
  const readLines = async (file: string): Promise<string[]> =>
    (await readFile(path.join(mod, 'map', file), 'utf8'))
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== '');
  const supplyNodes = (await readLines('supply_nodes.txt')).map((line) => numbers(line)[1]!);
  const railways = (await readLines('railways.txt')).map((line) => numbers(line).slice(2));
  return { definitions, states, regions, supplyNodes, railways };
}

/** What would not load cleanly: dangling or duplicated province, state and region membership. */
export function loadCheckProblems(world: WorldFiles): string[] {
  const problems: string[] = [];
  const stateOf = new Map<number, number>();
  for (const state of world.states.values()) {
    if (state.provinces.length === 0) problems.push(`state ${state.id} has no provinces`);
    for (const province of state.provinces) {
      const type = world.definitions.get(province);
      if (type === undefined)
        problems.push(`state ${state.id} names undefined province ${province}`);
      else if (type !== 'land')
        problems.push(`state ${state.id} contains the ${type} province ${province}`);
      const other = stateOf.get(province);
      if (other !== undefined)
        problems.push(`province ${province} is in states ${other} and ${state.id}`);
      stateOf.set(province, state.id);
    }
  }
  const regionOf = new Map<number, number>();
  for (const [region, provinces] of world.regions)
    for (const province of provinces) {
      if (!world.definitions.has(province))
        problems.push(`region ${region} names undefined province ${province}`);
      const other = regionOf.get(province);
      if (other !== undefined)
        problems.push(`province ${province} is in regions ${other} and ${region}`);
      regionOf.set(province, region);
    }
  for (const [province, type] of world.definitions)
    if (province > 0 && !regionOf.has(province) && type !== 'lake')
      problems.push(`province ${province} is in no strategic region`);
  for (const province of stateOf.keys())
    if (!regionOf.has(province)) problems.push(`state province ${province} is in no region`);
  for (const node of world.supplyNodes)
    if (!world.definitions.has(node)) problems.push(`supply node in undefined province ${node}`);
  for (const railway of world.railways)
    for (const province of railway)
      if (!world.definitions.has(province))
        problems.push(`railway through undefined province ${province}`);
  return problems.slice(0, 20);
}

async function writeScript(mod: string, relativePath: string, text: string): Promise<void> {
  const file = path.join(mod, ...relativePath.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** A scripted effect that names a state as a trigger and as a scope, with no localisation to resolve. */
function referenceScript(stateId: number, name: string): string {
  return [
    `${name} = {`,
    '	if = {',
    `		limit = { owns_state = ${stateId} }`,
    `		${stateId} = { add_core_of = ROOT }`,
    '	}',
    '}',
    '',
  ].join('\n');
}

export async function runWorldFlow(
  server: SmokeServer,
  mod: string,
  workspaceId: string,
): Promise<WorldRow[]> {
  const rows: WorldRow[] = [];
  const step = async (
    tool: string,
    label: string,
    args: Record<string, unknown>,
    kind: LedgerRow['kind'] = 'rewrite',
    extra: (result: SmokeResult) => string[] = () => [],
  ): Promise<SmokeResult> => {
    const result = await server.call(tool, label, { workspaceId, ...args });
    const problems = [...successProblems(result)];
    if (problems.length === 0) problems.push(...extra(result));
    rows.push({ result, kind, problems });
    return result;
  };
  const diskProblems = async (stage: string): Promise<string[]> =>
    (await readWorldFiles(mod).then(loadCheckProblems)).map((problem) => `${stage}: ${problem}`);
  const missingReferences = (result: SmokeResult): string[] => {
    const references = (
      result.structured.data as { scriptReferences?: { references: number; missing: number } }
    ).scriptReferences;
    if (references === undefined) return ['inspection reported no scriptReferences'];
    return references.missing === 0 ? [] : [`${references.missing} script references are missing`];
  };

  await step('hoi4.map_rewrite', 'create a 512x256 world with three countries', {
    operations: [
      {
        id: 'world',
        kind: 'create_world',
        width: 512,
        height: 256,
        seed: 3,
        countries: [
          { tag: 'AUR', name: 'Aurelia' },
          { tag: 'BOR', name: 'Borea', share: 2 },
          { tag: 'CAL', name: 'Calder', ideology: 'democratic' },
        ],
        continentNames: ['Aster', 'Brum', 'Corvel'],
      },
    ],
  });
  if (rows.at(-1)!.problems.length > 0) return rows;
  const created = await readWorldFiles(mod);
  const loadAfterCreate = loadCheckProblems(created);
  rows.at(-1)!.problems.push(...loadAfterCreate.map((problem) => `world: ${problem}`));
  await step(
    'hoi4.map_inspect',
    'validate the generated world',
    { includeOverview: false, references: true },
    'success',
    (result) => {
      const errors = (result.structured.diagnostics ?? []).filter(
        (diagnostic) => (diagnostic as { severity?: string }).severity === 'error',
      );
      return errors.length === 0 ? [] : [`${errors.length} validation errors`];
    },
  );

  // The largest state, so one province can leave it and still leave a valid state behind.
  const source = [...created.states.values()].sort(
    (left, right) => right.provinces.length - left.provinces.length || left.id - right.id,
  )[0]!;
  const moved = source.provinces.at(-1)!;
  const newId = Math.max(...created.states.keys()) + 1;
  await writeScript(
    mod,
    'common/scripted_effects/world_smoke_effects.txt',
    referenceScript(source.id, 'world_smoke_effect'),
  );

  await step('hoi4.map_rewrite', 'split a state and remap its script references', {
    operations: [
      {
        id: 'split',
        kind: 'create_state',
        sourceStateId: source.id,
        stateId: newId,
        provinceIds: [moved],
        displayName: 'Smoke Split',
      },
      {
        id: 'remap',
        kind: 'remap_map_references',
        entity: 'state',
        mapping: [{ from: source.id, to: [source.id, newId] }],
      },
    ],
  });
  const split = await readWorldFiles(mod);
  const splitProblems = [
    ...loadCheckProblems(split).map((problem) => `split: ${problem}`),
    ...(split.states.get(newId)?.provinces.join() === String(moved)
      ? []
      : [`split: new state ${newId} does not hold exactly province ${moved}`]),
    ...(split.states.get(source.id)?.provinces.includes(moved)
      ? [`split: province ${moved} is still in state ${source.id}`]
      : []),
    ...(split.states.get(newId)?.owner === source.owner
      ? []
      : ['split: the new state did not inherit its owner']),
  ];
  const manpowerBefore = source.manpower;
  const manpowerAfter =
    (split.states.get(source.id)?.manpower ?? 0) + (split.states.get(newId)?.manpower ?? 0);
  if (manpowerAfter !== manpowerBefore)
    splitProblems.push(`split: manpower ${manpowerBefore} became ${manpowerAfter}`);
  rows.at(-1)!.problems.push(...splitProblems);
  const script = await readFile(
    path.join(mod, 'common', 'scripted_effects', 'world_smoke_effects.txt'),
    'utf8',
  );
  if (!script.includes(`owns_state = ${newId}`) || !script.includes(`${newId} = {`))
    rows.at(-1)!.problems.push('split: the event does not reference the new state');
  await step(
    'hoi4.map_inspect',
    'check script references after the split',
    { includeOverview: false, references: true },
    'success',
    missingReferences,
  );

  await step('hoi4.map_rewrite', 'merge the new state back and remap its references', {
    operations: [
      {
        id: 'merge',
        kind: 'merge_states',
        sourceStateIds: [newId],
        targetStateId: source.id,
      },
      {
        id: 'remap_back',
        kind: 'remap_map_references',
        entity: 'state',
        mapping: [{ from: newId, to: source.id }],
      },
    ],
  });
  const merged = await readWorldFiles(mod);
  const mergedProblems = [
    ...loadCheckProblems(merged).map((problem) => `merge: ${problem}`),
    ...(merged.states.has(newId) ? [`merge: state ${newId} still exists`] : []),
    ...([...(merged.states.get(source.id)?.provinces ?? [])].sort().join() ===
    [...source.provinces].sort().join()
      ? []
      : [`merge: state ${source.id} does not hold its original provinces again`]),
    ...((merged.states.get(source.id)?.manpower ?? 0) === manpowerBefore
      ? []
      : [`merge: manpower is ${merged.states.get(source.id)?.manpower}, not ${manpowerBefore}`]),
  ];
  rows.at(-1)!.problems.push(...mergedProblems);
  await step(
    'hoi4.map_inspect',
    'check script references after the merge',
    { includeOverview: false, references: true },
    'success',
    missingReferences,
  );

  // Reference repair: a reference to a state the map lacks is found, then mapped to a real one.
  const dangling = Math.max(...merged.states.keys()) + 500;
  await writeScript(
    mod,
    'common/scripted_effects/world_smoke_dangling_effects.txt',
    referenceScript(dangling, 'world_smoke_dangling_effect'),
  );
  const found = await step(
    'hoi4.map_inspect',
    'find a script reference to a missing state',
    { includeOverview: false, references: true },
    'success',
    (result) => {
      const references = (result.structured.data as { scriptReferences?: { missing: number } })
        .scriptReferences;
      return (references?.missing ?? 0) > 0
        ? []
        : ['the dangling state reference was not reported'];
    },
  );
  void found;
  await step('hoi4.map_rewrite', 'repair the dangling reference', {
    operations: [
      {
        id: 'repair',
        kind: 'remap_map_references',
        entity: 'state',
        mapping: [{ from: dangling, to: source.id }],
      },
    ],
  });
  await step(
    'hoi4.map_inspect',
    'no script reference is missing after the repair',
    { includeOverview: false, references: true },
    'success',
    missingReferences,
  );
  const repaired = await readFile(
    path.join(mod, 'common', 'scripted_effects', 'world_smoke_dangling_effects.txt'),
    'utf8',
  );
  if (repaired.includes(String(dangling)))
    rows.at(-1)!.problems.push('repair: the dangling number is still in the event file');
  rows.at(-1)!.problems.push(...(await diskProblems('final')));
  return rows;
}
