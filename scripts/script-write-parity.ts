import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { sharedResidentEngine } from '../src/hoi4_agent_tools/core/resident-engine.js';
import { ServiceError } from '../src/hoi4_agent_tools/core/result.js';
import type * as NewSourceModule from '../src/hoi4_agent_tools/core/source/index.js';
import { capEngineMemory } from './bench/engine-memory-cap.js';

// Every engine this script starts runs under a hard memory cap (HOI4_PARITY_ENGINE_MAX_MB).
capEngineMemory({ label: 'script-write-parity' });

/**
 * Parity check for the script writers on the Rust engine (ADR 0089, packet P10). For every file of
 * `common/ideas`, `common/characters`, `common/decisions`, `common/doctrines`, `common/technologies`
 * and `events` under the given mod copies it runs the same operations through the TypeScript writers
 * of `--old-root` (a checkout of the commit before the move, with its own node_modules) and through
 * the engine, and compares the answers: the refusal code and message, or the bytes of the file
 * after the edit, the untouched count and the edit text.
 *
 *   npx tsx scripts/script-write-parity.ts --old-root DIR --mods DIR[,DIR...] [--max-per-file 6]
 *
 * Run it on copies of the mods in a scratch folder, never on the real sources. The engine is
 * `HOI4_ENGINE`; the script stops when its `hello` does not list the writer operations. It reports
 * the full number of differences, and exits 1 when there is any.
 */

const { values } = parseArgs({
  options: {
    'old-root': { type: 'string' },
    mods: { type: 'string' },
    'max-per-file': { type: 'string', default: '6' },
  },
});
if (values['old-root'] === undefined || values.mods === undefined) {
  process.stderr.write('usage: script-write-parity.ts --old-root DIR --mods DIR[,DIR...]\n');
  process.exit(2);
}
const oldRoot = path.resolve(values['old-root']);
const maxPerFile = Number(values['max-per-file']);

const OPS = [
  'idea_write.plan',
  'character_write.plan',
  'decision_write.plan',
  'doctrine_write.plan',
  'tech_write.plan',
  'event_write.plan',
];
const hello = await sharedResidentEngine().request('hello', {});
const listed = hello.ok ? ((hello.response.result as { ops?: string[] }).ops ?? []) : [];
const absent = OPS.filter((op) => !listed.includes(op));
if (absent.length > 0) {
  process.stderr.write(`the engine does not list ${absent.join(', ')}; stopping\n`);
  process.exit(2);
}

type Answer = { error: { code: string; message: string } } | { ok: Record<string, unknown> };

interface Writer {
  domain: string;
  dir: string;
  /** Top-level entries that hold definitions: the container key, or undefined for flat/category files. */
  planOld: (source: { bytes: Uint8Array; path: string }, input: never) => unknown;
  planNew: (source: { bytes: Uint8Array; path: string }, input: never) => Promise<unknown>;
  newFile: (path: string, input: never) => Promise<unknown>;
  oldNewFile: (path: string, input: never) => unknown;
}

async function load(rel: string, name: string): Promise<Record<string, unknown>> {
  void name;
  return (await import(
    pathToFileURL(path.join(oldRoot, 'src/hoi4_agent_tools', rel)).href
  )) as Record<string, unknown>;
}
async function loadNew(rel: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(path.resolve('src/hoi4_agent_tools', rel)).href)) as Record<
    string,
    unknown
  >;
}

const writers: Writer[] = [];
for (const [domain, rel, dir, oldFn, newFn, oldNew, newNew] of [
  [
    'idea',
    'ideas/write-plan.ts',
    'common/ideas',
    'planIdeaWrite',
    'planIdeaWrite',
    'planNewIdeaFile',
    'planNewIdeaFile',
  ],
  [
    'character',
    'characters/write-plan.ts',
    'common/characters',
    'planCharacterWrite',
    'planCharacterWrite',
    'planNewCharacterFile',
    'planNewCharacterFile',
  ],
  [
    'decision',
    'decision/write-plan.ts',
    'common/decisions',
    'planDecisionWrite',
    'planDecisionWrite',
    'planNewDecisionFile',
    'planNewDecisionFile',
  ],
  [
    'doctrine',
    'doctrine/write-plan.ts',
    'common/doctrines',
    'planDoctrineWrite',
    'planDoctrineWrite',
    'planNewDoctrineFile',
    'planNewDoctrineFile',
  ],
  [
    'tech',
    'technology/write-plan.ts',
    'common/technologies',
    'planTechWrite',
    'planTechWrite',
    'planNewTechFile',
    'planNewTechFile',
  ],
  [
    'event',
    'event/write-plan.ts',
    'events',
    'planEventWrite',
    'planEventWrite',
    'planNewEventFile',
    'planNewEventFile',
  ],
] as const) {
  const [oldModule, newModule] = [await load(rel, domain), await loadNew(rel)];
  writers.push({
    domain,
    dir,
    planOld: oldModule[oldFn] as Writer['planOld'],
    planNew: newModule[newFn] as Writer['planNew'],
    oldNewFile: oldModule[oldNew] as Writer['oldNewFile'],
    newFile: newModule[newNew] as Writer['newFile'],
  });
}
const oldSource = (await import(
  pathToFileURL(path.join(oldRoot, 'src/hoi4_agent_tools/core/source/index.ts')).href
)) as typeof NewSourceModule;

async function files(dir: string): Promise<string[]> {
  const found: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return found;
  }
  for (const name of names.sort()) {
    const full = path.join(dir, name);
    const info = await stat(full);
    if (info.isDirectory()) found.push(...(await files(full)));
    else if (name.toLowerCase().endsWith('.txt')) found.push(full);
  }
  return found;
}

async function settle(run: () => unknown): Promise<Answer> {
  try {
    const plan = (await run()) as Record<string, unknown>;
    const edits = (plan.edits ?? [plan.edit]) as Array<{ text: string; description: string }>;
    return {
      ok: {
        bytes: Buffer.from(plan.bytes as Buffer).toString('base64'),
        untouched: plan.untouchedDefinitions,
        category: plan.category ?? null,
        kind: plan.kind ?? null,
        namespaceAdded: plan.namespaceAdded ?? null,
        edits: edits.map((edit) => `${edit.description}\n${edit.text}`),
        diff: plan.diff,
      },
    };
  } catch (error) {
    // The old tree loads its own ServiceError class, so match by name as well as by class.
    if (
      error instanceof ServiceError ||
      (error instanceof Error &&
        error.name === 'ServiceError' &&
        typeof (error as { code?: unknown }).code === 'string')
    )
      return { error: { code: (error as ServiceError).code, message: error.message } };
    return { error: { code: 'UNEXPECTED', message: String(error) } };
  }
}

let operations = 0;
const differences: string[] = [];
const byDomain = new Map<string, { operations: number; differences: number }>();

async function compare(
  writer: Writer,
  label: string,
  oldRun: () => unknown,
  newRun: () => unknown,
): Promise<void> {
  const [before, after] = [await settle(oldRun), await settle(newRun)];
  operations += 1;
  const stats = byDomain.get(writer.domain) ?? { operations: 0, differences: 0 };
  stats.operations += 1;
  byDomain.set(writer.domain, stats);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    stats.differences += 1;
    differences.push(
      `${writer.domain} ${label}: old ${JSON.stringify(before).slice(0, 300)} new ${JSON.stringify(after).slice(0, 300)}`,
    );
  }
}

function inputs(writer: Writer, id: string, body: string, category: string | undefined) {
  const base = { id, ...(category === undefined ? {} : { category }) };
  return {
    add: {
      operation: 'add',
      ...base,
      body,
      ...(category === undefined ? {} : { createCategory: false }),
    },
    replace: { operation: 'replace', id, body },
    remove: { operation: 'remove', id },
    addNew: {
      operation: 'add',
      id: writer.domain === 'event' ? 'parity_ns.900001' : 'parity_new_definition',
      ...(category === undefined ? {} : { category }),
      body: body.length > 0 ? body : 'a = b',
      ...(writer.domain === 'event' ? { createNamespace: true } : {}),
    },
  };
}

for (const mod of values.mods.split(',')) {
  for (const writer of writers) {
    for (const file of await files(path.join(mod, writer.dir))) {
      const rel = path.relative(mod, file).replaceAll('\\', '/');
      const bytes = await readFile(file);
      const document = oldSource.parseClausewitz(bytes, rel);
      // Candidate definitions: nested blocks of the file, with their container as a category.
      const candidates: Array<{ id: string; category?: string; body: string }> = [];
      const body = (node: { start: number; end: number }): string => {
        const text = document.text.slice(node.start, node.end);
        return text.slice(text.indexOf('{') + 1, text.lastIndexOf('}'));
      };
      for (const top of oldSource.assignments(document.root)) {
        if (top.value.type !== 'block') continue;
        if (writer.domain === 'event') {
          const id = oldSource.assignments(top.value, 'id')[0];
          if (id?.value.type === 'scalar') candidates.push({ id: id.value.value, body: body(top) });
          continue;
        }
        if (writer.domain === 'doctrine') {
          candidates.push({ id: top.key.value, body: body(top) });
          continue;
        }
        for (const inner of oldSource.assignments(top.value)) {
          if (inner.value.type !== 'block') continue;
          if (['idea', 'decision'].includes(writer.domain)) {
            // idea files nest category blocks inside `ideas = { ... }`.
            if (writer.domain === 'idea') {
              for (const idea of oldSource.assignments(inner.value))
                if (idea.value.type === 'block')
                  candidates.push({
                    id: idea.key.value,
                    category: inner.key.value,
                    body: body(idea),
                  });
              continue;
            }
            candidates.push({ id: inner.key.value, category: top.key.value, body: body(inner) });
          } else candidates.push({ id: inner.key.value, body: body(inner) });
        }
      }
      const picked =
        candidates.length <= maxPerFile
          ? candidates
          : Array.from(
              { length: maxPerFile },
              (_, index) =>
                candidates[Math.floor((index * (candidates.length - 1)) / (maxPerFile - 1))]!,
            );
      const source = { bytes, path: rel };
      for (const candidate of picked) {
        const all = inputs(writer, candidate.id, candidate.body, candidate.category);
        for (const [name, input] of Object.entries(all)) {
          const label = `${mod}:${rel} ${name} ${candidate.id}`;
          await compare(
            writer,
            label,
            () => writer.planOld(source, input as never),
            () => writer.planNew(source, input as never),
          );
        }
      }
      // A file that is not there yet, and the empty-source and CRLF variants of this one.
      const probe = inputs(
        writer,
        'parity_new_definition',
        'a = b',
        writer.domain === 'idea' ? 'country' : 'parity_category',
      );
      await compare(
        writer,
        `${mod}:${rel} new-file`,
        () => writer.oldNewFile(`${writer.dir}/parity_new.txt`, probe.add as never),
        () => writer.newFile(`${writer.dir}/parity_new.txt`, probe.add as never),
      );
      const crlf = {
        bytes: Buffer.from(document.text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'), 'utf8'),
        path: rel,
      };
      if (picked[0] !== undefined) {
        const all = inputs(writer, picked[0].id, picked[0].body, picked[0].category);
        await compare(
          writer,
          `${mod}:${rel} crlf replace`,
          () => writer.planOld(crlf, all.replace as never),
          () => writer.planNew(crlf, all.replace as never),
        );
        await compare(
          writer,
          `${mod}:${rel} crlf add`,
          () => writer.planOld(crlf, all.addNew as never),
          () => writer.planNew(crlf, all.addNew as never),
        );
      }
    }
  }
}

process.stdout.write(`operations compared: ${operations}\n`);
for (const [domain, stats] of byDomain)
  process.stdout.write(
    `${domain}: ${stats.operations} operations, ${stats.differences} differences\n`,
  );
process.stdout.write(`differences: ${differences.length}\n`);
for (const line of differences.slice(0, 40)) process.stdout.write(`${line}\n`);
process.exit(differences.length > 0 ? 1 : 0);
