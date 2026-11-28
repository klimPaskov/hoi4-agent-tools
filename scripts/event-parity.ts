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
import type { EventType } from '../src/hoi4_agent_tools/event/model.js';

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
const include = new RegExp(values.include ?? '', 'u');
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
      else if (/.(?:txt|yml)$/iu.test(entry.name) && include.test(next))
        sources.push({ file: scanned(next, await readFile(path.join(root, next))) });
    }
  }
}
sources.sort((a, b) => (a.file.relativePath < b.file.relativePath ? -1 : 1));

/** The first element of two arrays that differs, or both values cut short. */
function firstDifference(left: unknown, right: unknown): string {
  if (Array.isArray(left) && Array.isArray(right)) {
    const at = left.findIndex((item, index) => canonicalJson(item) !== canonicalJson(right[index]));
    const index = at === -1 ? Math.min(left.length, right.length) : at;
    return `    [${index}] of ${left.length} ts, ${right.length} rust\n    ts:   ${canonicalJson(left[index]).slice(0, 700)}\n    rust: ${canonicalJson(right[index]).slice(0, 700)}\n`;
  }
  return `    ts:   ${canonicalJson(left).slice(0, 700)}\n    rust: ${canonicalJson(right).slice(0, 700)}\n`;
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

async function rustBatch(files: ScannedFile[], context: EventSourceAnalysisContext) {
  const chunks = files.map((file) => file.bytes);
  const offsets: Array<[number, number]> = [];
  let at = 0;
  for (const chunk of chunks) {
    offsets.push([at, chunk.length]);
    at += chunk.length;
  }
  const outcome = await engine.request(
    'event.fragments',
    {
      files: files.map((file, index) => ({
        relativePath: file.relativePath,
        displayPath: file.displayPath,
        sha256: file.sha256,
        cacheKey: `key:${file.displayPath}`,
        payload: offsets[index],
      })),
      context: wire(context),
    },
    Buffer.concat(chunks),
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
for (const pass of [0, 1] as const) {
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
    const fragments = await rust(covered, {
      knownEventIds: catalog.eventIds,
      knownEventTypes: catalog.eventTypes,
      knownHelperIds: catalog.helperIds,
      knownDecisionIds: catalog.decisionIds,
      activeEventPaths: catalog.activeEventPaths,
      retainedEventPaths: catalog.retainedEventPaths,
      activeHelperPaths: catalog.activeHelperPaths,
      activeDecisionPaths: catalog.activeDecisionPaths,
      inventoryComplete: snapshot.complete,
    });
    const outcome = await engine.request(
      'event.graph',
      {
        fragments,
        files: activeFiles(snapshot).map(({ displayPath, sha256 }) => ({ displayPath, sha256 })),
        workspaceId: snapshot.workspaceId,
        revision: snapshot.revision,
        complete: snapshot.complete,
        skippedSourceCount: snapshot.skippedSourceCount,
        skippedSources: snapshot.skippedSources,
        diagnostics: snapshot.diagnostics,
        projectHelpers,
      },
      undefined,
      { timeoutMs: 1_800_000 },
    );
    if (!outcome.ok) throw new Error(`engine unavailable: ${JSON.stringify(outcome)}`);
    const left = JSON.parse(canonicalJson(buildEventGraph(snapshot, { projectHelpers }))) as Record<
      string,
      unknown
    >;
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
