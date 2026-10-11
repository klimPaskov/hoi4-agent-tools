import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * The agent-style calls shared by the CI and local stdio smoke suites: one realistic call per
 * read-only tool, one deliberately wrong-field call per tool, and the discovery of real
 * identifiers (an event, a focus tree, a window, a decision) from the files of a game or mod.
 */

/** Every tool the default stdio server exposes. */
export const ALL_TOOLS = [
  'hoi4.reference_context',
  'hoi4.reference_search',
  'hoi4.reference_read',
  'hoi4.source_lookup',
  'hoi4.script_validate',
  'hoi4.error_log',
  'hoi4.mod_index',
  'hoi4.focus_inspect',
  'hoi4.focus_render',
  'hoi4.focus_rewrite',
  'hoi4.gui_inspect',
  'hoi4.gui_render',
  'hoi4.gui_rewrite',
  'hoi4.map_inspect',
  'hoi4.map_rewrite',
  'hoi4.event_inspect',
  'hoi4.event_render',
  'hoi4.tech_inspect',
  'hoi4.tech_render',
  'hoi4.probability_inspect',
  'hoi4.probability_analyze',
  'hoi4.impact_inspect',
  'hoi4.decision_inspect',
  'hoi4.mechanic_test',
  'hoi4.package_check',
  'hoi4.scenario_test',
  'hoi4.job_inspect',
  'hoi4.job_cancel',
] as const;

export interface SmokeSubjects {
  workspaceId: string;
  /** A word the installed documentation certainly mentions. */
  documentationQuery: string;
  eventId: string;
  eventNamespace: string;
  eventFile: string;
  focusFile: string;
  focusTreeId: string;
  guiWindow?: string;
  decision?: { id: string; file: string };
  scriptedEffect?: { id: string; file: string };
  technology?: { id: string; folder: string };
  probability?: { path: string; candidates: string[]; state: Record<string, unknown> };
  map?: { lookup: Record<string, unknown>; render: Record<string, unknown> };
}

export interface SmokeCall {
  tool: string;
  label: string;
  args: Record<string, unknown>;
  /** Result codes that count as an answer, such as a game folder without a log yet. */
  tolerate?: string[];
}

export interface WrongFieldCall {
  tool: string;
  /** The misspelled or invented field the call uses; the error must name it. */
  field: string;
  args: Record<string, unknown>;
}

/** One realistic call per read-only tool; `hoi4.reference_read` follows `hoi4.reference_search`. */
export function readOnlyCalls(subjects: SmokeSubjects): SmokeCall[] {
  const workspaceId = subjects.workspaceId;
  const calls: SmokeCall[] = [
    {
      tool: 'hoi4.reference_context',
      label: 'documentation bundle for event scripting',
      args: { surface: 'event', limit: 3 },
    },
    {
      tool: 'hoi4.reference_search',
      label: 'search the installed documentation',
      args: { query: subjects.documentationQuery, limit: 5 },
    },
    {
      tool: 'hoi4.source_lookup',
      label: 'find the definition of an event',
      args: { symbol: subjects.eventId, kind: 'event' },
    },
    {
      tool: 'hoi4.script_validate',
      label: 'validate an effect snippet',
      args: { source: 'add_political_power = 10', kind: 'effect', scope: 'country' },
    },
    {
      tool: 'hoi4.script_validate',
      label: 'validate a whole event file',
      args: { path: subjects.eventFile },
    },
    {
      tool: 'hoi4.error_log',
      label: 'group the last game error log',
      args: { limit: 5 },
      tolerate: ['ERROR_LOG_NOT_FOUND'],
    },
    { tool: 'hoi4.mod_index', label: 'summarize the mod', args: { mode: 'overview' } },
    {
      tool: 'hoi4.mod_index',
      label: 'next free event ID in a namespace',
      args: { mode: 'next_id', kind: 'event', namespace: subjects.eventNamespace },
    },
    {
      tool: 'hoi4.event_inspect',
      label: 'lint an event namespace',
      args: { mode: 'lint', selector: subjects.eventNamespace },
    },
    {
      tool: 'hoi4.event_inspect',
      label: 'trace one event downstream',
      args: { mode: 'trace', selector: subjects.eventId, direction: 'downstream', maxDepth: 3 },
    },
    {
      tool: 'hoi4.event_render',
      label: 'render an event namespace overview',
      args: { view: 'overview', selector: subjects.eventNamespace, maxNodes: 40 },
    },
    {
      tool: 'hoi4.focus_inspect',
      label: 'inspect a focus tree',
      args: { treeId: subjects.focusTreeId },
    },
    {
      tool: 'hoi4.focus_render',
      label: 'render a focus tree',
      args: { relativePath: subjects.focusFile, treeId: subjects.focusTreeId },
    },
  ];
  if (subjects.guiWindow !== undefined)
    calls.push(
      {
        tool: 'hoi4.gui_inspect',
        label: 'inspect a scripted GUI window',
        args: { windowName: subjects.guiWindow },
      },
      {
        tool: 'hoi4.gui_render',
        label: 'render a scripted GUI window',
        args: {
          windowName: subjects.guiWindow,
          scenario: { id: 'smoke', state: 'normal' },
          resolutions: [{ width: 1920, height: 1080 }],
          states: ['normal'],
        },
      },
    );
  if (subjects.decision !== undefined)
    calls.push(
      {
        tool: 'hoi4.decision_inspect',
        label: 'inventory the decisions',
        args: { mode: 'inventory' },
      },
      {
        tool: 'hoi4.decision_inspect',
        label: 'evaluate one decision under a declared scenario',
        args: {
          mode: 'inspect',
          id: subjects.decision.id,
          scenarios: [{ id: 'peace', actor: 'GER', state: { has_war: false } }],
        },
      },
    );
  if (subjects.scriptedEffect !== undefined)
    calls.push(
      {
        tool: 'hoi4.impact_inspect',
        label: 'who consumes a scripted effect',
        args: { symbols: [{ kind: 'scripted_effect', id: subjects.scriptedEffect.id }] },
      },
      {
        tool: 'hoi4.package_check',
        label: 'check a package manifest',
        args: {
          manifest: {
            schemaVersion: '1.0',
            id: 'smoke_package',
            definitions: [{ kind: 'scripted_effect', id: subjects.scriptedEffect.id }],
            registrations: [
              { path: subjects.scriptedEffect.file, token: subjects.scriptedEffect.id },
            ],
          },
        },
      },
      {
        tool: 'hoi4.scenario_test',
        label: 'run a one-case suite',
        args: {
          suite: {
            schemaVersion: '1.0',
            id: 'smoke_suite',
            cases: [
              {
                id: 'package_present',
                domain: 'package',
                manifest: {
                  schemaVersion: '1.0',
                  id: 'smoke_package',
                  definitions: [{ kind: 'scripted_effect', id: subjects.scriptedEffect.id }],
                },
              },
            ],
          },
          maxCases: 1,
        },
      },
      {
        tool: 'hoi4.mechanic_test',
        label: 'interpret a scripted effect on a declared state',
        args: {
          test: {
            id: 'smoke_mechanic',
            scenario: {
              schemaVersion: '1.0',
              id: 'smoke_mechanic',
              state: { treasury: 10, savings: 2 },
            },
            steps: [
              {
                kind: 'effect',
                source: { kind: 'scripted_effect', id: subjects.scriptedEffect.id },
              },
            ],
            assertions: [
              {
                id: 'funds_conserved',
                kind: 'conservation',
                paths: [{ key: 'treasury' }, { key: 'savings' }],
              },
            ],
          },
        },
      },
    );
  if (subjects.technology !== undefined)
    calls.push(
      {
        tool: 'hoi4.tech_inspect',
        label: 'explain one technology',
        args: { mode: 'explain', technologyId: subjects.technology.id },
      },
      {
        tool: 'hoi4.tech_render',
        label: 'render one technology folder',
        args: { view: 'folder', folderId: subjects.technology.folder, maxNodes: 80 },
      },
    );
  if (subjects.probability !== undefined)
    calls.push(
      {
        tool: 'hoi4.probability_inspect',
        label: 'weights of decisions under a declared scenario',
        args: {
          source: { path: subjects.probability.path },
          candidatePool: subjects.probability.candidates,
          scenarioSet: [{ id: 'peace', actor: 'GER', state: subjects.probability.state }],
        },
      },
      {
        tool: 'hoi4.probability_analyze',
        label: 'sweep one declared input',
        args: {
          analysis: 'sweep',
          source: { path: subjects.probability.path },
          candidatePool: subjects.probability.candidates,
          scenarioSet: [
            {
              id: 'peace',
              actor: 'GER',
              state: subjects.probability.state,
              uncertainInputs: [{ path: 'variable.pressure', range: { min: 0, max: 100 } }],
            },
          ],
          sweep: { paths: ['variable.pressure'], steps: 5 },
        },
      },
    );
  if (subjects.map !== undefined)
    calls.push(
      { tool: 'hoi4.map_inspect', label: 'look up map entities', args: subjects.map.lookup },
      { tool: 'hoi4.map_inspect', label: 'render a map tile', args: subjects.map.render },
    );
  return calls.map((call) => ({ ...call, args: { workspaceId, ...call.args } }));
}

/** One plausible agent mistake per tool: an invented or misspelled field. */
export function wrongFieldCalls(workspaceId: string): WrongFieldCall[] {
  const wrong = (tool: string, field: string, args: Record<string, unknown>): WrongFieldCall => ({
    tool,
    field,
    args: { workspaceId, ...args },
  });
  return [
    wrong('hoi4.reference_context', 'topic', { topic: 'event' }),
    wrong('hoi4.reference_search', 'q', { q: 'add_political_power' }),
    wrong('hoi4.reference_read', 'section', { section: 'effects#add_political_power' }),
    wrong('hoi4.source_lookup', 'name', { name: 'my_effect' }),
    wrong('hoi4.script_validate', 'script_text', { script_text: 'add_political_power = 10' }),
    wrong('hoi4.error_log', 'severity', { severity: 'error' }),
    wrong('hoi4.mod_index', 'mod', { mode: 'overview', mod: 'my_mod' }),
    wrong('hoi4.event_inspect', 'event_id', { mode: 'trace', event_id: 'my_mod.1' }),
    wrong('hoi4.event_render', 'event_id', { view: 'overview', event_id: 'my_mod.1' }),
    wrong('hoi4.focus_inspect', 'tree', { tree: 'my_focus_tree' }),
    wrong('hoi4.focus_render', 'file', { file: 'common/national_focus/my_tree.txt' }),
    wrong('hoi4.focus_rewrite', 'path', { path: 'common/national_focus/my_tree.txt' }),
    wrong('hoi4.gui_inspect', 'window', { window: 'my_window' }),
    wrong('hoi4.gui_render', 'window', { window: 'my_window' }),
    wrong('hoi4.gui_rewrite', 'file', { mode: 'source', file: 'interface/my_window.gui' }),
    wrong('hoi4.map_inspect', 'province', { province: 1 }),
    wrong('hoi4.map_rewrite', 'ops', { ops: [] }),
    wrong('hoi4.tech_inspect', 'tech', { mode: 'explain', tech: 'my_tech' }),
    wrong('hoi4.tech_render', 'folder', { view: 'folder', folder: 'my_folder' }),
    wrong('hoi4.probability_inspect', 'decision', { decision: 'my_decision' }),
    wrong('hoi4.probability_analyze', 'type', { type: 'sweep' }),
    wrong('hoi4.impact_inspect', 'symbol', { symbol: 'my_effect' }),
    wrong('hoi4.decision_inspect', 'decision_id', { mode: 'inspect', decision_id: 'my_decision' }),
    wrong('hoi4.mechanic_test', 'steps', { steps: [] }),
    wrong('hoi4.package_check', 'package', { package: { id: 'my_package' } }),
    wrong('hoi4.scenario_test', 'cases', { cases: [] }),
    wrong('hoi4.job_inspect', 'id', { id: 'job_1' }),
    wrong('hoi4.job_cancel', 'id', { id: 'job_1' }),
  ];
}

async function listFiles(directory: string): Promise<Array<{ name: string; size: number }>> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const files: Array<{ name: string; size: number }> = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.txt')) continue;
    try {
      const info = await stat(path.join(directory, name));
      if (info.isFile()) files.push({ name, size: info.size });
    } catch {
      /* a vanished file is not a candidate */
    }
  }
  return files.sort((left, right) => left.size - right.size || left.name.localeCompare(right.name));
}

async function firstMatch(
  root: string,
  folder: string,
  pattern: RegExp,
  maxBytes = 400_000,
): Promise<{ file: string; match: RegExpMatchArray } | undefined> {
  for (const { name, size } of await listFiles(path.join(root, folder))) {
    if (size > maxBytes) continue;
    const text = await readFile(path.join(root, folder, name), 'utf8');
    const match = pattern.exec(text);
    if (match !== null) return { file: `${folder}/${name}`, match };
  }
  return undefined;
}

/** Real identifiers for a read-only smoke run, read from the files of one root (a mod or the game). */
export async function discoverSubjects(
  root: string,
  workspaceId: string,
): Promise<{ subjects: SmokeSubjects; missing: string[] }> {
  const missing: string[] = [];
  const event = await firstMatch(root, 'events', /^\s*id\s*=\s*([A-Za-z_][\w]*)\.(\d+)\b/mu);
  const focus = await firstMatch(
    root,
    'common/national_focus',
    /focus_tree\s*=\s*\{(?:\s|#[^\n]*\n)*id\s*=\s*"?([A-Za-z_]\w*)"?/u,
  );
  const gui = await firstMatch(
    root,
    'common/scripted_guis',
    /window_name\s*=\s*"?([A-Za-z_]\w*)"?/u,
  );
  const decision = await firstMatch(
    root,
    'common/decisions',
    /^\t([A-Za-z_]\w*)\s*=\s*\{(?:(?!^\t?[A-Za-z_]\w*\s*=\s*\{)[\s\S])*?\bai_will_do\b/mu,
  );
  const effect = await firstMatch(
    root,
    'common/scripted_effects',
    /^([A-Za-z_]\w*)\s*=\s*\{/mu,
    60_000,
  );
  // A file that names a folder and also defines a technology, so one folder and one card match.
  const technology = await firstMatch(
    root,
    'common/technologies',
    /^(?=[\s\S]*technologies\s*=\s*\{\s*(?:#[^\n]*\n\s*)*[A-Za-z_]\w*\s*=\s*\{)[\s\S]*?folder\s*=\s*\{\s*name\s*=\s*([A-Za-z_]\w*)/u,
  );
  let technologyId: string | undefined;
  if (technology !== undefined) {
    const text = await readFile(path.join(root, technology.file), 'utf8');
    technologyId = /technologies\s*=\s*\{\s*(?:#[^\n]*\n\s*)*([A-Za-z_]\w*)\s*=\s*\{/u.exec(
      text,
    )?.[1];
  }
  if (event === undefined) missing.push('event');
  if (focus === undefined) missing.push('focus tree');
  if (gui === undefined) missing.push('scripted GUI');
  if (decision === undefined) missing.push('decision with ai_will_do');
  if (effect === undefined) missing.push('scripted effect');
  if (technology === undefined || technologyId === undefined) missing.push('technology');
  const subjects: SmokeSubjects = {
    workspaceId,
    documentationQuery: 'add_political_power',
    eventId: event === undefined ? 'missing.1' : `${event.match[1]!}.${event.match[2]!}`,
    eventNamespace: event?.match[1] ?? 'missing',
    eventFile: event?.file ?? 'events/missing.txt',
    focusFile: focus?.file ?? 'common/national_focus/missing.txt',
    focusTreeId: focus?.match[1] ?? 'missing',
    ...(gui === undefined ? {} : { guiWindow: gui.match[1]! }),
    ...(decision === undefined
      ? {}
      : { decision: { id: decision.match[1]!, file: decision.file } }),
    ...(effect === undefined
      ? {}
      : { scriptedEffect: { id: effect.match[1]!, file: effect.file } }),
    ...(technology === undefined || technologyId === undefined
      ? {}
      : { technology: { id: technologyId, folder: technology.match[1]! } }),
    ...(decision === undefined
      ? {}
      : {
          probability: {
            path: decision.file,
            candidates: [decision.match[1]!],
            state: { has_war: false },
          },
        }),
  };
  return { subjects, missing };
}
