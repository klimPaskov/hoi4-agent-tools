import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import {
  canonicalJson,
  hashCanonical,
  sha256Bytes,
} from '../src/hoi4_agent_tools/core/canonical.js';
import { locateEngineBinary } from '../src/hoi4_agent_tools/core/engine-client.js';
import { sharedResidentEngine } from '../src/hoi4_agent_tools/core/resident-engine.js';
import { SymbolIndex } from '../src/hoi4_agent_tools/core/index.js';
import type { ScanSnapshot } from '../src/hoi4_agent_tools/core/engine.js';
import type { ScannedFile } from '../src/hoi4_agent_tools/core/scanner.js';
import {
  activeFiles,
  buildEventGraph,
  catalogFor,
  shouldAnalyzeEventFile,
} from '../src/hoi4_agent_tools/event/graph.js';
import {
  analyzeEventSource,
  type EventSourceAnalysisContext,
} from '../src/hoi4_agent_tools/event/source-analysis.js';
import type { EventGraphSnapshot, EventType } from '../src/hoi4_agent_tools/event/model.js';
import {
  eventInspectOutcome,
  type EventInspectInput,
} from '../src/hoi4_agent_tools/event/service.js';

/**
 * Parity check for the event source analysis on the shared Rust engine (packet P6). Every file is
 * analyzed by `analyzeEventSource` and by the engine operation `event.fragments`, first without a
 * catalog and then with the event, helper and decision catalogs the first pass found, and the two
 * fragments are compared as canonical JSON. A third pass builds the whole graph with `buildEventGraph`
 * and with `event.graph` over the engine's fragments, and compares the two snapshots. `--skip-graph`
 * leaves that pass out, for roots too large to build a TypeScript graph in memory.
 *
 *   npx tsx scripts/event-parity.ts [--dir ROOT]... [--include REGEX] [--out FILE]
 *
 * Without `--dir` it checks a built-in set of synthetic sources. `--dir` takes a game or mod root
 * (its `.txt` and `.yml` files). The engine is `HOI4_ENGINE` or the bundled binary. Exit status 1
 * when anything differs.
 */

const { values } = parseArgs({
  options: {
    dir: { type: 'string', multiple: true },
    include: { type: 'string' },
    'skip-graph': { type: 'boolean' },
    'skip-inspect': { type: 'boolean' },
    'only-graph': { type: 'boolean' },
    out: { type: 'string' },
  },
});

const located = locateEngineBinary();
if (!('path' in located)) {
  process.stderr.write(`${located.message}\n`);
  process.exit(2);
}
const engine = sharedResidentEngine();
const hello = await engine.request('hello');
const ops = hello.ok ? hello.response.result.ops : undefined;
if (!Array.isArray(ops) || !ops.includes('event.fragments')) {
  process.stderr.write(
    `${located.path} has no event.fragments operation; build this branch first\n`,
  );
  engine.close();
  process.exit(2);
}

function scanned(relativePath: string, bytes: Buffer): ScannedFile {
  return {
    absolutePath: `/fixture/${relativePath}`,
    displayPath: `fixture:${relativePath}`,
    relativePath,
    rootKind: 'fixture',
    loadOrder: 1,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

const SYNTHETIC: Array<[string, string]> = [
  [
    'events/a.txt',
    `add_namespace = a
country_event = {
	id = a.1
	title = a.1.t
	desc = { trigger = { has_country_flag = x } text = a.1.d1 }
	desc = a.1.d2
	trigger = { has_global_flag = g }
	mean_time_to_happen = { days = 10 modifier = { factor = 2 has_country_flag = y } }
	immediate = {
		set_country_flag = f1
		country_event = { id = a.2 days = 3 random_days = 2 }
		hidden_effect = { country_event = a.3 }
		random_list = {
			10 = { country_event = a.2 modifier = { factor = 2 tag = GER } }
			0 = { country_event = a.3 }
		}
		GER = { news_event = { id = a.4 hours = abc } }
		random_events = { 50 = a.2 0 = a.3 25 = a.9 }
	}
	option = { name = a.1.a add_to_variable = { v = 1 } my_helper = yes unknown_helper = yes event_target:foo = { add_stability = 1 } clr_country_flag = f1 }
	option = { name = a.1.a trigger = { always = yes } country_event = a.1 }
	option = { country_event = event_target:bar save_event_target_as = baz }
	after = { country_event = { id = a.2 date = 1936.1.1 } }
}
state_event = { id = a.5 is_triggered_only = yes hidden = yes immediate = { set_temp_variable = { t = 1 } every_owned_state = { limit = { is_core_of = ROOT } set_state_flag = z } } }
`,
  ],
  [
    'common/scripted_effects/h.txt',
    `my_helper = { if = { limit = { has_country_flag = x } country_event = a.2 } else = { other_helper = yes } set_global_variable = { v = 1 } }
other_helper = { random = { chance = 20 country_event = a.3 } }
`,
  ],
  [
    'common/on_actions/o.txt',
    `on_actions = { on_daily = { effect = { country_event = a.1 } random_events = { 100 = a.2 } } on_startup = { events = { a.1 a.2 } } on_unit_leader_created = { effect = { my_helper = yes } } }
`,
  ],
  [
    'common/national_focus/f.txt',
    `focus_tree = { id = t focus = { id = F1 available = { has_country_flag = q } completion_reward = { country_event = { id = a.1 days = 5 } set_country_flag = r } } joint_focus = { id = J1 completion_reward_joint_member = { country_event = a.2 } } }
`,
  ],
  [
    'common/decisions/d.txt',
    `cat = { dec1 = { visible = { has_global_flag = v } complete_effect = { country_event = a.1 } days_mission_timeout = 30 timeout_effect = { country_event = a.2 } } }
`,
  ],
  [
    'history/countries/GER.txt',
    `set_country_flag = hist
GER = { country_event = a.1 }
`,
  ],
  [
    'history/states/1-X.txt',
    `state = { history = { owner = GER add_core_of = GER set_state_flag = h } }\n`,
  ],
  [
    'common/ideas/i.txt',
    `ideas = { country = { i1 = { on_add = { country_event = a.1 } modifier = { x = 1 } foo_helper = yes } } }\n`,
  ],
  [
    'localisation/english/a_l_english.yml',
    '﻿l_english:\n a.1.t:0 "Title"\n a.1.d1:0 "Desc §Y1§!"\n bad line\n',
  ],
  ['events/broken.txt', 'country_event = { id = z.1 immediate = { country_event = z.2 \n'],
  [
    'events/cp1252.txt',
    Buffer.from(
      'country_event = { id = c.1 # caf\xe9\n option = { name = c.1.a } }\n',
      'latin1',
    ) as unknown as string,
  ],
];

interface Source {
  file: ScannedFile;
}
/** `--include` matches from the start of the path relative to the root, so `events` does not also take `docs/x/events`. */
const include = new RegExp(`^(?:${values.include ?? ''})`, 'u');
/** Files read from disk: the engine reads these itself by path instead of taking their bytes. */
const onDisk = new Set<string>();
const sources: Source[] = SYNTHETIC.map(([relativePath, text]) => ({
  file: scanned(
    relativePath,
    typeof text === 'string' ? Buffer.from(text, 'utf8') : (text as Buffer),
  ),
}));
for (const root of values.dir ?? []) {
  const stack = [''];
  while (stack.length > 0) {
    const relative = stack.pop()!;
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) stack.push(next);
      else if (/\.(?:txt|yml)$/iu.test(entry.name) && include.test(next)) {
        const absolute = path.join(root, next);
        const scannedFile = scanned(next, await readFile(absolute));
        scannedFile.absolutePath = absolute;
        onDisk.add(scannedFile.displayPath);
        sources.push({ file: scannedFile });
      }
    }
  }
}
sources.sort((a, b) => (a.file.relativePath < b.file.relativePath ? -1 : 1));

/** A value as text, cut short, for a report of where two values differ. */
function shown(value: unknown): string {
  try {
    return canonicalJson(value).slice(0, 700);
  } catch {
    return '(too large to show)';
  }
}

/** Where two values first differ: the path down to the first differing piece, and both pieces. */
function firstDifference(left: unknown, right: unknown, at = ''): string {
  if (Array.isArray(left) && Array.isArray(right)) {
    const index = left.findIndex((item, position) => !sameValue(item, right[position]));
    if (index !== -1 && index < right.length)
      return firstDifference(left[index], right[index], `${at}[${index}]`);
    return `    ${at || 'value'}: ${left.length} ts items, ${right.length} rust items\n    ts tail:   ${shown(left[right.length])}\n    rust tail: ${shown(right[left.length])}\n`;
  }
  if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const key = [...new Set([...Object.keys(a), ...Object.keys(b)])].find(
      (candidate) => !sameValue(a[candidate], b[candidate]),
    );
    if (key !== undefined) return firstDifference(a[key], b[key], `${at}.${key}`);
  }
  const size = (value: unknown): string =>
    Array.isArray(value)
      ? `array of ${value.length}`
      : typeof value === 'object' && value !== null
        ? `object with keys ${Object.keys(value).join(',')}`
        : typeof value;
  return `    at ${at || 'value'}\n    ts:   ${size(left)} ${shown(left)}\n    rust: ${size(right)} ${shown(right)}\n`;
}

function wire(context: EventSourceAnalysisContext): Record<string, unknown> {
  const set = (value: ReadonlySet<string> | undefined): string[] | undefined =>
    value === undefined ? undefined : [...value];
  const map = (
    value: ReadonlyMap<string, string> | undefined,
  ): Record<string, string> | undefined =>
    value === undefined ? undefined : Object.fromEntries(value);
  return {
    knownEventIds: set(context.knownEventIds),
    knownEventTypes:
      context.knownEventTypes === undefined
        ? undefined
        : Object.fromEntries(context.knownEventTypes),
    knownHelperIds: set(context.knownHelperIds),
    knownDecisionIds: set(context.knownDecisionIds),
    inventoryComplete: context.inventoryComplete,
    documentedEffectKeys: set(context.documentedEffectKeys),
    activeEventPaths: map(context.activeEventPaths),
    retainedEventPaths:
      context.retainedEventPaths === undefined
        ? undefined
        : Object.fromEntries(
            [...context.retainedEventPaths].map(([id, paths]) => [id, [...paths]]),
          ),
    activeHelperPaths: map(context.activeHelperPaths),
    activeDecisionPaths: map(context.activeDecisionPaths),
  };
}

type InspectParams = Omit<EventInspectInput, 'workspaceId' | 'refresh' | 'principal' | 'signal'>;

/** Whether two values are the same JSON, compared piece by piece when one string cannot hold them. */
function sameValue(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    if (Array.isArray(left) && Array.isArray(right))
      return (
        left.length === right.length && left.every((item, index) => sameValue(item, right[index]))
      );
    if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
      const a = left as Record<string, unknown>;
      const b = right as Record<string, unknown>;
      return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) =>
        sameValue(a[key], b[key]),
      );
    }
    return false;
  }
}

/** The mode queries of one graph, answered by TypeScript and by the engine's event.inspect. */
async function inspectParity(graph: EventGraphSnapshot, label: string): Promise<string[]> {
  const events = graph.nodes.filter((node) => node.kind === 'event' && node.eventId !== undefined);
  const first = events[0];
  const last = events.at(-1);
  const flowEdge = graph.edges.find(
    (edge) =>
      !edge.derived &&
      edge.from.startsWith('event:') &&
      edge.to.startsWith('event:') &&
      edge.from !== edge.to,
  );
  const access = graph.stateAccesses[Math.floor(graph.stateAccesses.length / 2)];
  const helper = graph.nodes.find((node) => node.kind === 'helper');
  const eventSelector = (eventId: string) => ({ kind: 'event' as const, eventId });
  const cases: Array<[string, InspectParams]> = [
    ['scan', { mode: 'scan' }],
    ['roots', { mode: 'roots' }],
    ['lint', { mode: 'lint' }],
    ['not found', { mode: 'roots', selector: eventSelector('definitely_missing.1') }],
    ['no selector for trace', { mode: 'trace' }],
    ['no subject for impact', { mode: 'impact' }],
    ['unknown file', { mode: 'lint', selector: { kind: 'file', sourcePath: 'nowhere/none.txt' } }],
    [
      'unknown state',
      { mode: 'state_flow', stateSubject: { kind: 'country_flag', name: 'no_such_flag_anywhere' } },
    ],
  ];
  cases.push(['state flow', { mode: 'state_flow' }]);
  if (first?.eventId !== undefined) {
    const selector = eventSelector(first.eventId);
    cases.push(
      ['roots of an event', { mode: 'roots', selector }],
      ['lint of an event', { mode: 'lint', selector }],
      ['trace both', { mode: 'trace', selector, maxDepth: 4 }],
      [
        'trace up expanded',
        {
          mode: 'trace',
          selector,
          direction: 'upstream',
          expandHelpers: true,
          maxDepth: 3,
          maxNodes: 50,
          maxEdges: 100,
        },
      ],
      ['trace down', { mode: 'trace', selector, direction: 'downstream' }],
      ['state flow of an event', { mode: 'state_flow', selector }],
      [
        'impact of an event',
        { mode: 'impact', impactSubject: { kind: 'event', name: first.eventId } },
      ],
      [
        'lint of a manifest',
        { mode: 'lint', selector: { kind: 'manifest', manifest: { eventIds: [first.eventId] } } },
      ],
      ['near miss', { mode: 'roots', selector: eventSelector(`${first.eventId}x`) }],
      [
        'lint of a node',
        { mode: 'lint', selector: { kind: 'node', nodeId: first.id } },
      ],
      [
        'trace cut at the edge limit',
        { mode: 'trace', selector, maxEdges: 3, maxNodes: 4, maxDepth: 6 },
      ],
      [
        'manifest with every field',
        {
          mode: 'lint',
          selector: {
            kind: 'manifest',
            manifest: {
              id: 'parity',
              eventIds: [first.eventId],
              namespaces: first.namespace === undefined ? [] : [first.namespace],
              sourcePaths: first.sourcePath === undefined ? [] : [first.sourcePath],
              nodeIds: [first.id],
            },
          },
        },
      ],
    );
    if (first.sourcePath !== undefined)
      cases.push([
        'manifest of a source path',
        {
          mode: 'roots',
          selector: { kind: 'manifest', manifest: { sourcePaths: [first.sourcePath] } },
        },
      ]);
    if (first.namespace !== undefined)
      cases.push([
        'lint of a namespace',
        { mode: 'lint', selector: { kind: 'namespace', namespace: first.namespace } },
      ]);
    if (first.sourcePath !== undefined)
      cases.push([
        'lint of a file',
        { mode: 'lint', selector: { kind: 'file', sourcePath: first.sourcePath } },
      ]);
    if (first.location !== undefined)
      cases.push([
        'lint of a source line',
        {
          mode: 'lint',
          selector: {
            kind: 'source',
            sourcePath: first.location.path,
            line: first.location.start.line,
          },
        },
      ]);
  }
  if (flowEdge !== undefined) {
    const from = graph.nodes.find((node) => node.id === flowEdge.from);
    const to = graph.nodes.find((node) => node.id === flowEdge.to);
    if (from?.eventId !== undefined && to?.eventId !== undefined)
      cases.push(
        [
          'explain a route',
          {
            mode: 'explain_path',
            from: eventSelector(from.eventId),
            to: eventSelector(to.eventId),
          },
        ],
        [
          'explain a route without helpers',
          {
            mode: 'explain_path',
            from: eventSelector(from.eventId),
            to: eventSelector(to.eventId),
            expandHelpers: false,
            maxDepth: 1,
          },
        ],
      );
  }
  if (first?.eventId !== undefined && last?.eventId !== undefined && first !== last)
    cases.push([
      'explain a likely missing route',
      {
        mode: 'explain_path',
        from: eventSelector(last.eventId),
        to: eventSelector(first.eventId),
        maxDepth: 2,
      },
    ]);
  if (first?.location !== undefined) {
    const { path: sourcePath, start } = first.location;
    cases.push(
      [
        'lint of a source column',
        { mode: 'lint', selector: { kind: 'source', sourcePath, line: start.line, column: start.column } },
      ],
      [
        'lint past the column',
        { mode: 'lint', selector: { kind: 'source', sourcePath, line: start.line, column: 9999 } },
      ],
    );
  }
  if (access !== undefined)
    cases.push(
      [
        'unknown state with a near miss',
        { mode: 'state_flow', stateSubject: { kind: access.kind, name: `${access.name}x` } },
      ],
      [
        'state flow of a value',
        { mode: 'state_flow', stateSubject: { kind: access.kind, name: access.name } },
      ],
      [
        'impact of a value',
        {
          mode: 'impact',
          impactSubject: {
            kind: access.kind === 'variable' ? 'variable' : 'flag',
            name: access.name,
          },
        },
      ],
    );
  if (helper !== undefined)
    cases.push([
      'impact of a helper',
      { mode: 'impact', impactSubject: { kind: 'helper', name: helper.label } },
    ]);
  const graphJson = Buffer.from(canonicalJson(graph), 'utf8');
  const failed: string[] = [];
  const tooLarge: string[] = [];
  let ran = 0;
  for (const [name, params] of cases) {
    if (process.env.PARITY_CASE !== undefined && !name.includes(process.env.PARITY_CASE)) continue;
    ran += 1;
    let expected: unknown;
    try {
      expected = eventInspectOutcome(graph, params);
    } catch (error) {
      const { code, message, details } = error as {
        code?: string;
        message: string;
        details?: unknown;
      };
      expected = { error: { code, message, details } };
    }
    const outcome = await engine.request(
      'event.inspect',
      { graphPayload: [0, graphJson.length], params },
      graphJson,
      { timeoutMs: 1_800_000 },
    );
    let actual: unknown;
    if (outcome.ok && outcome.response.payload.length > 0)
      actual = JSON.parse(outcome.response.payload.toString('utf8'));
    else if (outcome.ok) {
      const error = outcome.response.result as {
        code?: string;
        message?: string;
        details?: unknown;
      };
      actual = { error: { code: error.code, message: error.message, details: error.details } };
    } else if (outcome.kind === 'error') {
      // The engine nests a refusal's details under its own details key; none is null.
      const nested = (outcome.details as { details?: unknown }).details;
      actual = {
        error: {
          code: outcome.code,
          message: outcome.message,
          details: nested === null ? undefined : nested,
        },
      };
    } else actual = { engine: outcome };
    // The pipe carries at most 512 MiB. A TypeScript report over that is refused by the engine with
    // EVENT_RESULT_TOO_LARGE: a named divergence per corpus, never a silent pass.
    const refusedAsTooLarge =
      (actual as { error?: { code?: string } }).error?.code === 'EVENT_RESULT_TOO_LARGE' &&
      Buffer.byteLength(canonicalJson(expected), 'utf8') > 512 * 1024 * 1024;
    if (refusedAsTooLarge) {
      tooLarge.push(`inspect ${label} ${name}`);
      continue;
    }
    if (!sameValue(expected, actual)) {
      failed.push(`inspect ${label} ${name}`);
      if (failed.length <= 3)
        process.stderr.write(`  inspect ${name}\n${firstDifference(expected, actual)}`);
    }
  }
  const filter = process.env.PARITY_CASE;
  process.stdout.write(
    `inspect ${label}: ${ran} of ${cases.length} cases${filter === undefined ? '' : ` (PARITY_CASE=${filter}: a partial run, not a pass)`}, ${failed.length} differ, ${tooLarge.length} refused as over the 512 MiB pipe (${tooLarge.join('; ') || 'none'})\n`,
  );
  return failed;
}

const crashed: string[] = [];
async function rust(files: ScannedFile[], context: EventSourceAnalysisContext): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let at = 0; at < files.length; at += 100) {
    const chunk = files.slice(at, at + 100);
    try {
      out.push(...(await rustBatch(chunk, context)));
    } catch {
      for (const file of chunk) {
        try {
          out.push(...(await rustBatch([file], context)));
        } catch (error) {
          crashed.push(file.relativePath);
          if (crashed.length <= 3)
            process.stderr
              .write(`  engine failure on ${file.relativePath}: ${String(error).slice(0, 700)}
`);
          out.push(null);
        }
      }
    }
  }
  return out;
}

/** The request entries of files and the payload holding the bytes of those not read by path. */
function entries(files: ScannedFile[]): { files: Record<string, unknown>[]; payload: Buffer } {
  const chunks: Buffer[] = [];
  let at = 0;
  const described = files.map((file) => {
    const common = {
      relativePath: file.relativePath,
      displayPath: file.displayPath,
      sha256: file.sha256,
      cacheKey: `key:${file.displayPath}`,
    };
    if (onDisk.has(file.displayPath))
      return { ...common, path: file.absolutePath, size: file.size };
    chunks.push(file.bytes);
    const entry = { ...common, payload: [at, file.bytes.length] };
    at += file.bytes.length;
    return entry;
  });
  return { files: described, payload: Buffer.concat(chunks) };
}

async function rustBatch(files: ScannedFile[], context: EventSourceAnalysisContext) {
  const described = entries(files);
  const outcome = await engine.request(
    'event.fragments',
    { files: described.files, context: wire(context) },
    described.payload,
    { timeoutMs: 1_800_000 },
  );
  if (!outcome.ok) throw new Error(`engine unavailable: ${JSON.stringify(outcome)}`);
  const result = outcome.response.result as { error?: unknown };
  if (outcome.response.payload.length === 0) throw new Error(JSON.stringify(result));
  return JSON.parse(outcome.response.payload.toString('utf8')) as unknown[];
}

const files = sources.map(({ file }) => file);
const failures: string[] = [];
let compared = 0;
for (const pass of values['only-graph'] === true ? [] : ([0, 1] as const)) {
  let context: EventSourceAnalysisContext = {};
  if (pass === 1) {
    const eventIds = new Set<string>();
    const types = new Map<string, EventType>();
    const helpers = new Set<string>();
    for (const file of files) {
      const fragment = analyzeEventSource(file, {});
      for (const node of fragment.nodes) {
        if (node.kind === 'event' && node.eventId !== undefined) {
          eventIds.add(node.eventId);
          types.set(node.eventId, node.metadata.eventType as EventType);
        }
        if (node.kind === 'helper') helpers.add(node.label);
      }
    }
    // Leave one event out so the missing-event path runs, and mark the inventory partial once.
    const dropped = [...eventIds].sort().at(-1);
    if (dropped !== undefined) eventIds.delete(dropped);
    context = { knownEventIds: eventIds, knownEventTypes: types, knownHelperIds: helpers };
  }
  const expected = files.map((file) => analyzeEventSource(file, context));
  const actual = await rust(files, context);
  files.forEach((file, index) => {
    compared += 1;
    if (actual[index] === null) {
      failures.push(`pass ${pass} ${file.relativePath} (engine failed)`);
      return;
    }
    // The TypeScript cache key is not computed here; the engine echoes the one it was given.
    const left = canonicalJson({ ...expected[index], cacheKey: `key:${file.displayPath}` });
    const right = canonicalJson(actual[index]);
    if (left !== right) failures.push(`pass ${pass} ${file.relativePath}`);
    if (left !== right && failures.length <= 3) {
      const a = JSON.parse(left) as Record<string, unknown>;
      const b = JSON.parse(right) as Record<string, unknown>;
      for (const key of Object.keys(a)) {
        if (canonicalJson(a[key]) !== canonicalJson(b[key]))
          process.stderr.write(`  ${file.relativePath} ${key}\n${firstDifference(a[key], b[key])}`);
      }
    }
  });
}
if (values['skip-graph'] !== true) {
  const snapshot: ScanSnapshot = (() => {
    const index = SymbolIndex.build(files);
    return {
      workspaceId: 'synthetic',
      files,
      index,
      revision: hashCanonical(
        files.map(({ displayPath, sha256, loadOrder, shadowedBy }) => ({
          displayPath,
          sha256,
          loadOrder,
          shadowedBy,
        })),
      ),
      complete: index.complete,
      skippedSources: index.skippedSources,
      skippedSourceCount: index.skippedSourceCount,
      diagnostics: index.diagnostics,
    };
  })();
  const graphFailures: string[] = [];
  for (const projectHelpers of [true, false]) {
    const catalog = catalogFor(snapshot);
    const covered = activeFiles(snapshot).filter(
      (file) => shouldAnalyzeEventFile(file) && !snapshot.index.isSourceSkipped(file.displayPath),
    );
    // One request: the engine reads the files by path, analyzes them and builds the graph, so no
    // fragments cross the pipe.
    const described = entries(covered);
    const graphStarted = performance.now();
    const outcome = await engine.request(
      'event.graph',
      {
        analyze: {
          files: described.files,
          context: wire({
            knownEventIds: catalog.eventIds,
            knownEventTypes: catalog.eventTypes,
            knownHelperIds: catalog.helperIds,
            knownDecisionIds: catalog.decisionIds,
            activeEventPaths: catalog.activeEventPaths,
            retainedEventPaths: catalog.retainedEventPaths,
            activeHelperPaths: catalog.activeHelperPaths,
            activeDecisionPaths: catalog.activeDecisionPaths,
            inventoryComplete: snapshot.complete,
          }),
        },
        files: activeFiles(snapshot).map(({ displayPath, sha256 }) => ({ displayPath, sha256 })),
        workspaceId: snapshot.workspaceId,
        revision: snapshot.revision,
        complete: snapshot.complete,
        skippedSourceCount: snapshot.skippedSourceCount,
        skippedSources: snapshot.skippedSources,
        diagnostics: snapshot.diagnostics,
        projectHelpers,
      },
      described.payload,
      { timeoutMs: 1_800_000 },
    );
    const graphMs = performance.now() - graphStarted;
    if (!outcome.ok) throw new Error(`engine unavailable: ${JSON.stringify(outcome)}`);
    const typescriptStarted = performance.now();
    const typescriptGraph = buildEventGraph(snapshot, { projectHelpers });
    const typescriptMs = performance.now() - typescriptStarted;
    process.stdout.write(
      `timing projectHelpers=${projectHelpers}: engine ${Math.round(graphMs)} ms for ${covered.length} files and ${Math.round(outcome.response.payload.length / 1048576)} MB of graph (${JSON.stringify((outcome.response.result as { timingsMs?: unknown }).timingsMs)}), TypeScript ${Math.round(typescriptMs)} ms (node rss ${Math.round(process.memoryUsage().rss / 1048576)} MB)\n`,
    );
    const left = JSON.parse(canonicalJson(typescriptGraph)) as Record<string, unknown>;
    const right = JSON.parse(outcome.response.payload.toString('utf8')) as Record<string, unknown>;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (canonicalJson(left[key]) === canonicalJson(right[key])) continue;
      graphFailures.push(`graph projectHelpers=${projectHelpers} ${key}`);
      if (graphFailures.length <= 6)
        process.stderr.write(
          `  graph ${key}
    ts:   ${canonicalJson(left[key]).slice(0, 1200)}
    rust: ${canonicalJson(right[key]).slice(0, 1200)}
`,
        );
    }
    compared += 1;
    if (values['skip-inspect'] !== true) {
      for (const failure of await inspectParity(
        typescriptGraph,
        `projectHelpers=${projectHelpers}`,
      ))
        graphFailures.push(failure);
    }
  }
  failures.push(...graphFailures);
}
engine.close();
process.stdout.write(
  `${compared} fragments and graphs compared, ${failures.length} differ, ${crashed.length} engine failures\n`,
);
for (const file of crashed.slice(0, 50)) process.stdout.write(`  engine failed on ${file}\n`);
for (const failure of failures.slice(0, 200)) process.stdout.write(`  ${failure}\n`);
if (values.out !== undefined) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(values.out, `${JSON.stringify({ compared, failures }, null, 2)}\n`);
}
process.exit(failures.length === 0 ? 0 : 1);
