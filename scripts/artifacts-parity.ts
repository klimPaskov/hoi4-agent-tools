import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import {
  ArtifactStore,
  boundedSourceHashEvidence,
} from '../src/hoi4_agent_tools/core/artifacts.js';
import { sweepTemporaryDirectories } from '../src/hoi4_agent_tools/core/temporary-directories.js';
import {
  artifactsAvailable,
  binaryDiffOnEngine,
  commitArtifacts,
  describeArtifact,
  comparePngImagesOnEngine,
  listArtifactPage,
  listArtifacts,
  planManagedOutputsOnEngine,
  putArtifacts,
  readArtifact,
  readLogicalArtifact,
  refreshManagedOutputsOnEngine,
  releaseArtifacts,
  summarizeChangedFilesOnEngine,
  sweepTemporaryDirectoriesOnEngine,
  unifiedTextDiffOnEngine,
  type EnginePathRule,
  type EngineStoreWorkspace,
} from '../src/hoi4_agent_tools/core/artifacts-engine.js';
import { canonicalJson, sha256Bytes } from '../src/hoi4_agent_tools/core/canonical.js';
import { summarizeChangedFiles } from '../src/hoi4_agent_tools/core/changed-summary.js';
import { binaryDiff, unifiedTextDiff } from '../src/hoi4_agent_tools/core/diff.js';
import { comparePngImages } from '../src/hoi4_agent_tools/core/image-diff.js';
import {
  planManagedOutputs,
  refreshManagedOutputs,
} from '../src/hoi4_agent_tools/core/managed-outputs.js';
import { sharedResidentEngine } from '../src/hoi4_agent_tools/core/resident-engine.js';
import type { ResolvedWorkspace } from '../src/hoi4_agent_tools/core/workspace.js';
import {
  worldOutputPermits,
  isWorldCountryOutput,
} from '../src/hoi4_agent_tools/map/world-outputs.js';
import { locateCorpus } from './bench/corpus.js';
import { corpusFileSchema } from './bench/schema.js';
import { capEngineMemory } from './bench/engine-memory-cap.js';

// Every engine this script starts runs under a hard memory cap (HOI4_PARITY_ENGINE_MAX_MB).
capEngineMemory({ label: 'artifacts-parity' });

/**
 * Parity check for the artifact store, diffs, changed-file summary, managed outputs and image diff
 * on the Rust engine (`hoi4-artifacts`, packet P3 of ADR 0089). It runs the TypeScript code that
 * built the old answer and the engine operation on the same inputs and reports the full count of
 * differences of each kind:
 *
 *   - `diff`: unified text diffs (whole file, context hunks, and the patience path) of real files
 *     of each corpus under seven deterministic edits;
 *   - `binary`: byte diffs of the same files;
 *   - `changed`: the changed-files summary of corpus path lists;
 *   - `store`: artifact URIs, hashes, manifest bytes, listing order, pages and reads of the real
 *     files stored by both stores, and each store reading the other's;
 *   - `managed`: the managed-output plan and refresh under the world-output rules, over random
 *     inventories of real paths;
 *   - `image`: PNG comparisons by decoded pixels (the encoded PNG bytes differ by encoder).
 *
 *   npx tsx scripts/artifacts-parity.ts [--corpus synthetic,vanilla,zin] [--files 150] [--out FILE]
 *
 * The engine is `HOI4_ENGINE`. The run stops when `hello` does not list an operation it compares.
 * Exit status 1 when anything differs.
 */

const { values } = parseArgs({
  options: {
    corpus: { type: 'string' },
    files: { type: 'string', default: '150' },
    out: { type: 'string' },
  },
});
const filesPerCorpus = Number(values.files);

const REQUIRED_OPS = [
  'artifacts.put',
  'artifacts.read',
  'artifacts.list',
  'artifacts.list_page',
  'artifacts.changed_summary',
  'artifacts.managed_plan',
  'artifacts.managed_refresh',
  'diff.text',
  'diff.binary',
  'diff.image',
];
const hello = await sharedResidentEngine().request('hello', {});
if (!hello.ok) {
  process.stderr.write(`hoi4-engine is unavailable: ${JSON.stringify(hello)}\n`);
  process.exit(2);
}
const listed = new Set((hello.response.result.ops as string[] | undefined) ?? []);
const missing = REQUIRED_OPS.filter((op) => !listed.has(op));
if (missing.length > 0) {
  process.stderr.write(
    `the engine does not list the operations ${missing.join(', ')}; build it from this branch\n`,
  );
  process.exit(2);
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Tally {
  checked: number;
  differences: number;
  samples: string[];
}
const report: Record<string, Tally> = {};
function tally(kind: string): Tally {
  return (report[kind] ??= { checked: 0, differences: 0, samples: [] });
}
function check(kind: string, label: string, expected: unknown, actual: unknown): void {
  const entry = tally(kind);
  entry.checked += 1;
  const same = (value: unknown) => canonicalJson(value === undefined ? null : value);
  if (same(expected) === same(actual)) return;
  entry.differences += 1;
  if (entry.samples.length < 8)
    entry.samples.push(
      `${label}: ${JSON.stringify(expected).slice(0, 200)} != ${JSON.stringify(actual).slice(0, 200)}`,
    );
}

const TEXT_EXTENSIONS = new Set(['.txt', '.gui', '.gfx', '.yml', '.csv', '.mod']);
async function walk(root: string, relative: string, depth: number, found: string[]): Promise<void> {
  if (depth > 6 || found.length > 40_000) return;
  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) await walk(root, child, depth + 1, found);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      found.push(child);
  }
}

function sample<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const stride = items.length / count;
  return Array.from({ length: count }, (_, index) => items[Math.floor(index * stride)]!);
}

function edits(text: string, rnd: () => number): Array<[string, string]> {
  const lines = text.split('\n');
  const middle = Math.floor(lines.length / 2);
  const inserted = [
    ...lines.slice(0, middle),
    'inserted_a = 1',
    'inserted_b = 2',
    'inserted_c = 3',
    ...lines.slice(middle),
  ].join('\n');
  const deleted = [...lines.slice(0, Math.max(0, middle - 2)), ...lines.slice(middle + 3)].join(
    '\n',
  );
  const replaced = lines
    .map((line, index) => (index % 7 === 3 ? `${line} # edited` : line))
    .join('\n');
  const shuffled = lines.slice();
  for (let swaps = 0; swaps < Math.min(6, lines.length); swaps += 1) {
    const a = Math.floor(rnd() * lines.length);
    const b = Math.floor(rnd() * lines.length);
    [shuffled[a], shuffled[b]] = [shuffled[b]!, shuffled[a]!];
  }
  return [
    ['insert', inserted],
    ['delete', deleted],
    ['replace', replaced],
    ['swap', shuffled.join('\n')],
    ['eol', text.includes('\r\n') ? text.replaceAll('\r\n', '\n') : text.replaceAll('\n', '\r\n')],
    ['empty-to-full', text],
    ['full-to-empty', ''],
  ];
}

const PATH_SAMPLE_LIMIT = 4000;
const corpusIds = values.corpus?.split(',');
const corpora = corpusFileSchema
  .parse(JSON.parse(await readFile(path.join('bench', 'corpus.json'), 'utf8')))
  .corpora.filter(({ id }) => corpusIds === undefined || corpusIds.includes(id));

const scratch = await mkdtemp(path.join(os.tmpdir(), 'hoi4-artifacts-parity-'));
const sweepSeed = 20261122;
let storeSerial = 0;
try {
  const roots: Array<{ id: string; root: string }> = [];
  for (const corpus of corpora) {
    if (corpus.kind === 'synthetic') {
      roots.push({ id: corpus.id, root: path.resolve('bench', 'fixtures', 'synthetic') });
      continue;
    }
    const found = await locateCorpus(corpus);
    if (found.root === undefined) {
      process.stderr.write(`${corpus.id}: ${found.unavailable ?? 'not found'}\n`);
      continue;
    }
    roots.push({ id: corpus.id, root: found.root });
  }

  for (const { id, root } of roots) {
    const all: string[] = [];
    await walk(root, '', 0, all);
    const chosen = sample(all, filesPerCorpus);
    const rnd = random(sweepSeed + id.length);
    const worldRules = worldOutputPermits({
      mapRoot: 'map',
      stateRoots: ['history/states'],
      localisationRoots: ['localisation'],
    });
    const pathsForManaged = sample(all, PATH_SAMPLE_LIMIT);

    // diff, binary
    for (const relative of chosen) {
      const full = path.join(root, relative);
      if ((await stat(full)).size > 2_000_000) continue;
      const bytes = await readFile(full);
      const text = bytes.toString('utf8');
      for (const [name, after] of edits(text, rnd)) {
        const before = name === 'empty-to-full' ? '' : text;
        for (const [mode, options] of [
          ['context', { context: 3 }],
          ['whole', {}],
          ['patience', { context: 3, maxMatrixCells: 1000 }],
        ] as const) {
          check(
            'diff',
            `${id}:${relative}:${name}:${mode}`,
            unifiedTextDiff(before, after, `a/${relative}`, `b/${relative}`, options),
            await unifiedTextDiffOnEngine(before, after, `a/${relative}`, `b/${relative}`, options),
          );
        }
        const beforeBytes = Buffer.from(before, 'utf8');
        const afterBytes = Buffer.from(after, 'utf8');
        check(
          'binary',
          `${id}:${relative}:${name}`,
          binaryDiff(beforeBytes, afterBytes),
          await binaryDiffOnEngine(beforeBytes, afterBytes),
        );
      }
    }

    // changed-file summary
    for (let round = 0; round < 20; round += 1) {
      const subset = pathsForManaged
        .filter(() => rnd() < 0.3)
        .map((relativePath) => {
          const kind = rnd();
          return {
            relativePath: round % 2 === 0 ? relativePath : relativePath.replaceAll('/', '\\'),
            beforeSha256: kind < 0.3 ? null : 'a'.repeat(64),
            afterSha256: kind > 0.8 ? null : 'b'.repeat(64),
          };
        });
      const limit = [1, 5, 40][round % 3]!;
      check(
        'changed',
        `${id}:${round}`,
        summarizeChangedFiles(subset, limit),
        await summarizeChangedFilesOnEngine(subset, limit),
      );
    }

    // artifact store
    const tsRoot = path.join(scratch, `ts-${storeSerial}`);
    const rustRoot = path.join(scratch, `rust-${storeSerial}`);
    storeSerial += 1;
    await mkdir(tsRoot, { recursive: true });
    await mkdir(rustRoot, { recursive: true });
    const identity = {
      workspaceIdentity: sha256Bytes(`ws-${id}`),
      ownerIdentity: sha256Bytes(`owner-${id}`),
    };
    const tsWorkspace = {
      id: 'parity',
      artifactRoot: tsRoot,
      ...identity,
    } as unknown as ResolvedWorkspace;
    const rustWorkspace: EngineStoreWorkspace = {
      id: 'parity',
      artifactRoot: rustRoot,
      ...identity,
    };
    const tsStore = new ArtifactStore(50_000_000_000, 100_000, 8_000_000);
    const limits = { maxBytes: 50_000_000_000, maxEntries: 100_000, maxSingleBytes: 8_000_000 };
    const stored = sample(chosen, 40);
    let serial = 0;
    const links: string[] = [];
    for (const relative of stored) {
      const full = path.join(root, relative);
      if ((await stat(full)).size > 1_000_000) continue;
      const content = await readFile(full);
      const name =
        `${String(serial).padStart(4, '0')}-${path.basename(relative).replace(/[^A-Za-z0-9._-]/gu, '_')}`.slice(
          0,
          120,
        );
      serial += 1;
      const provenance = {
        kind: 'parity',
        toolVersion: '1',
        schemaVersion: '1',
        sourceHashes: { [relative]: sha256Bytes(content) },
      };
      const expected = await tsStore.put(
        tsWorkspace,
        name,
        'text/plain',
        content,
        provenance,
        `File ${serial}`,
      );
      const actual = (
        await putArtifacts(
          rustWorkspace,
          [{ name, mimeType: 'text/plain', content, provenance, description: `File ${serial}` }],
          { limits },
        )
      ).artifacts[0]!;
      check(
        'store',
        `${id}:${name}:address`,
        [expected.uri, expected.sha256, expected.provenanceHash, expected.size],
        [actual.uri, actual.sha256, actual.provenanceHash, actual.size],
      );
      const manifestName = `${name}.${expected.provenanceHash}.manifest.json`;
      const dir = (file: string, base: string) => path.join(base, file.slice(0, 2), file);
      check(
        'store',
        `${id}:${name}:manifest-bytes`,
        (await readFile(path.join(dir(expected.sha256, tsRoot), manifestName))).toString('utf8'),
        (await readFile(path.join(dir(actual.sha256, rustRoot), manifestName))).toString('utf8'),
      );
      const range = { offset: 3, length: 50 };
      check(
        'store',
        `${id}:${name}:range`,
        (await tsStore.read(tsWorkspace, expected.uri, range)).bytes.toString('base64'),
        (await readArtifact(rustWorkspace, actual.uri, range, limits)).bytes.toString('base64'),
      );
      links.push(expected.uri);
    }
    check(
      'store',
      `${id}:list`,
      await tsStore.list(tsWorkspace),
      await listArtifacts(rustWorkspace, limits),
    );
    for (const limit of [1, 7, 100]) {
      let after: string | undefined;
      for (let page = 0; page < 3; page += 1) {
        const expected = await tsStore.listPage(tsWorkspace, {
          limit,
          ...(after === undefined ? {} : { afterUri: after }),
        });
        const actual = await listArtifactPage(
          rustWorkspace,
          { limit, ...(after === undefined ? {} : { afterUri: after }) },
          limits,
        );
        check('store', `${id}:page-${limit}-${page}`, expected, actual);
        after = expected.artifacts.at(-1)?.uri;
        if (after === undefined) break;
      }
    }
    // Each store reads what the other wrote: the Rust store over the TypeScript root and back.
    const swapped = { ...rustWorkspace, artifactRoot: tsRoot };
    for (const uri of links.slice(0, 10))
      check(
        'store',
        `${id}:cross-read`,
        (await tsStore.read(tsWorkspace, uri)).bytes.toString('base64'),
        (await readArtifact(swapped, uri, undefined, limits)).bytes.toString('base64'),
      );

    // chunked puts, logical reads, describe, available, release, the scratch sweep, hash evidence
    {
      const chunkLimits = { maxBytes: 50_000_000, maxEntries: 10_000, maxSingleBytes: 8192 };
      const tsChunkRoot = path.join(scratch, `ts-chunk-${storeSerial}`);
      const rustChunkRoot = path.join(scratch, `rust-chunk-${storeSerial}`);
      const rustReleaseRoot = path.join(scratch, `rust-release-${storeSerial}`);
      storeSerial += 1;
      for (const folder of [tsChunkRoot, rustChunkRoot, rustReleaseRoot])
        await mkdir(folder, { recursive: true });
      const chunkTs = new ArtifactStore(
        chunkLimits.maxBytes,
        chunkLimits.maxEntries,
        chunkLimits.maxSingleBytes,
      );
      const chunkTsWorkspace = { ...tsWorkspace, artifactRoot: tsChunkRoot };
      const chunkRustWorkspace = { ...rustWorkspace, artifactRoot: rustChunkRoot };
      const outcome = async (run: () => Promise<unknown>): Promise<unknown> => {
        try {
          return { ok: await run() };
        } catch (error) {
          return { error: (error as { code?: string }).code ?? 'unknown' };
        }
      };
      const logicalOptions = { mimeType: 'application/json', maxBytes: 1_000_000, maxChunks: 1000 };
      let chunkSerial = 0;
      for (const relative of sample(chosen, 14)) {
        const content = await readFile(path.join(root, relative));
        if (content.length < 1 || content.length > 100_000) continue;
        const name =
          `${String(chunkSerial).padStart(3, '0')}-${path.basename(relative).replace(/[^A-Za-z0-9._-]/gu, '_')}`.slice(
            0,
            100,
          );
        chunkSerial += 1;
        const provenance = {
          kind: 'parity',
          toolVersion: '1',
          schemaVersion: '1',
          sourceHashes: { [relative]: sha256Bytes(content) },
        };
        const expected = await chunkTs.putChunked(
          chunkTsWorkspace,
          name,
          'application/json',
          content,
          provenance,
          'chunked',
        );
        const actual = (
          await putArtifacts(
            chunkRustWorkspace,
            [{ name, mimeType: 'application/json', content, provenance, description: 'chunked' }],
            { chunked: true, limits: chunkLimits },
          )
        ).artifacts[0]!;
        const addressOf = (value: {
          uri: string;
          mimeType: string;
          size?: number | undefined;
          sha256: string;
          provenanceHash: string;
        }) => [value.uri, value.mimeType, value.size ?? null, value.sha256, value.provenanceHash];
        check('chunked', `${id}:${name}:address`, addressOf(expected), addressOf(actual));
        const tsRead = await chunkTs.readLogical(chunkTsWorkspace, expected.uri, logicalOptions);
        const rustRead = await readLogicalArtifact(
          chunkRustWorkspace,
          actual.uri,
          logicalOptions,
          chunkLimits,
        );
        const readOf = (value: {
          bytes: Buffer;
          name: string;
          totalSize: number;
          mimeType: string;
        }) => [value.bytes.toString('base64'), value.name, value.totalSize, value.mimeType];
        check('chunked', `${id}:${name}:logical`, readOf(tsRead), readOf(rustRead));
        check(
          'chunked',
          `${id}:${name}:source-bytes`,
          content.toString('base64'),
          rustRead.bytes.toString('base64'),
        );
        const tsDescribed = await chunkTs.describe(chunkTsWorkspace, expected.uri);
        const rustDescribed = await describeArtifact(chunkRustWorkspace, actual.uri, chunkLimits);
        const describedOf = (value: {
          uri: string;
          name: string;
          mimeType: string;
          size?: number | undefined;
          sha256: string;
          provenanceHash: string;
          description?: string | undefined;
        }) => [
          value.uri,
          value.name,
          value.mimeType,
          value.size ?? null,
          value.sha256,
          value.provenanceHash,
          value.description ?? null,
        ];
        check('describe', `${id}:${name}`, describedOf(tsDescribed), describedOf(rustDescribed));
        check(
          'available',
          `${id}:${name}`,
          await outcome(() => chunkTs.available(chunkTsWorkspace, [{ uri: expected.uri }])),
          await outcome(() => artifactsAvailable(chunkRustWorkspace, [actual.uri], chunkLimits)),
        );
        const missing = chunkTs.uri('parity', 'f'.repeat(64), 'e'.repeat(64), 'missing.txt');
        check(
          'available',
          `${id}:${name}:missing`,
          await outcome(() =>
            chunkTs.available(chunkTsWorkspace, [{ uri: expected.uri }, { uri: missing }]),
          ),
          await outcome(() =>
            artifactsAvailable(chunkRustWorkspace, [actual.uri, missing], chunkLimits),
          ),
        );
      }

      // release: a put taken back leaves the root as it was, and a file another put reused stays
      const releaseWorkspace = { ...rustWorkspace, artifactRoot: rustReleaseRoot };
      // Files only: the folders a put made are tidied by the next storage scan, not by release.
      const tree = async () => {
        const files: string[] = [];
        for (const entry of await readdir(rustReleaseRoot, { recursive: true })) {
          const relative = entry.replaceAll('\\', '/');
          if (relative.startsWith('.artifact-')) continue;
          if ((await stat(path.join(rustReleaseRoot, relative))).isFile()) files.push(relative);
        }
        return files.sort();
      };
      const releaseBytes = Buffer.from(`release parity ${id}`);
      const releaseProvenance = {
        kind: 'parity',
        toolVersion: '1',
        schemaVersion: '1',
        sourceHashes: { release: sha256Bytes(releaseBytes) },
      };
      const releaseWrite = {
        name: 'release.txt',
        mimeType: 'text/plain',
        content: releaseBytes,
        provenance: releaseProvenance,
      };
      const before = await tree();
      const first = await putArtifacts(releaseWorkspace, [releaseWrite], { limits });
      await releaseArtifacts(releaseWorkspace, first.created, limits);
      check('release', `${id}:roundtrip`, before, await tree());
      const held = await putArtifacts(releaseWorkspace, [releaseWrite], { limits });
      const reused = await putArtifacts(releaseWorkspace, [releaseWrite], { limits });
      await commitArtifacts(releaseWorkspace, reused.created, limits);
      await releaseArtifacts(releaseWorkspace, held.created, limits);
      check(
        'release',
        `${id}:reused-file-kept`,
        Buffer.from(releaseBytes).toString('base64'),
        (
          await readArtifact(releaseWorkspace, held.artifacts[0]!.uri, undefined, limits)
        ).bytes.toString('base64'),
      );

      // source hash evidence: the TypeScript commitment and the engine's, over real path names
      for (let round = 0; round < 12; round += 1) {
        const paths = sample(chosen, Math.floor(rnd() * 400));
        if (round % 3 === 0) paths.push('zz\u{1F600}', 'zz\uFF21', 'zz\u00E9', 'ZZ');
        const hashes = Object.fromEntries(paths.map((entry) => [entry, sha256Bytes(entry)]));
        const answer = await sharedResidentEngine().request(
          'artifacts.source_hash_evidence',
          { sourceHashes: hashes },
          undefined,
          {},
        );
        check(
          'evidence',
          `${id}:round-${round}`,
          boundedSourceHashEvidence(hashes),
          answer.ok ? answer.response.result : answer,
        );
      }

      // scratch sweep: both sweeps judge the same directories alike
      const deadPid = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;
      for (const protectedFirst of [false, true]) {
        const folders = {
          ts: path.join(scratch, `sweep-ts-${storeSerial}-${protectedFirst}`),
          rust: path.join(scratch, `sweep-rust-${storeSerial}-${protectedFirst}`),
        };
        for (const parent of Object.values(folders)) {
          await mkdir(parent, { recursive: true });
          const layout: Array<[string, number | undefined]> = [
            ['hoi4-map-AAAAAA', deadPid],
            ['hoi4-map-BBBBBB', process.pid],
            ['hoi4-map-CCCCCC', undefined],
            ['hoi4-map-DDDDDD', deadPid],
          ];
          for (const [folder, pid] of layout) {
            await mkdir(path.join(parent, folder), { recursive: true });
            await writeFile(path.join(parent, folder, 'data.bin'), Buffer.alloc(64));
            if (pid !== undefined)
              await writeFile(
                path.join(parent, folder, '.hoi4-temp-owner.json'),
                JSON.stringify({ version: 1, pid, host: os.hostname(), token: randomUUID() }),
              );
          }
        }
        const options = (parent: string) => ({
          ownedFixturesOnly: true,
          now: Date.now() + 1_000_000,
          staleMs: 0,
          ...(protectedFirst ? { protectedRoots: [path.join(parent, 'hoi4-map-AAAAAA')] } : {}),
        });
        const expected = await sweepTemporaryDirectories(folders.ts, options(folders.ts));
        const actual = await sweepTemporaryDirectoriesOnEngine(folders.rust, options(folders.rust));
        check('sweep', `${id}:${protectedFirst ? 'protected' : 'plain'}`, expected, actual);
        check(
          'sweep',
          `${id}:${protectedFirst ? 'protected' : 'plain'}:survivors`,
          (await readdir(folders.ts)).sort(),
          (await readdir(folders.rust)).sort(),
        );
        storeSerial += 1;
      }
    }

    // managed outputs
    const permits: EnginePathRule = {
      any: [
        {
          dir: {
            dirs: ['map'],
            files: [
              'provinces.bmp',
              'definition.csv',
              'default.map',
              'continent.txt',
              'adjacencies.csv',
              'adjacency_rules.txt',
              'positions.txt',
              'ambient_object.txt',
              'heightmap.bmp',
              'terrain.bmp',
              'rivers.bmp',
              'trees.bmp',
              'cities.bmp',
              'world_normal.bmp',
              'buildings.txt',
              'unitstacks.txt',
              'weatherpositions.txt',
              'supply_nodes.txt',
              'railways.txt',
            ],
          },
        },
        { dir: { dirs: ['map/terrain'], pattern: '^colormap_[a-z0-9_]+\\.dds$' } },
        { dir: { dirs: ['map/strategicregions'], pattern: '^\\d+.*\\.txt$' } },
        { dir: { dirs: ['history/states'], pattern: '^\\d+.*\\.txt$' } },
        {
          dir: {
            dirs: ['common/countries', 'history/countries'],
            pattern: '^[A-Z][A-Z0-9]{2} - [^/]+\\.txt$',
          },
        },
        { dir: { dirs: ['history/units'], pattern: '^[A-Z][A-Z0-9]{2}_world\\.txt$' } },
        {
          dir: {
            dirs: ['gfx/flags', 'gfx/flags/medium', 'gfx/flags/small'],
            pattern: '^[A-Z][A-Z0-9]{2}\\.tga$',
          },
        },
        { path: 'common/countries/colors.txt' },
        { path: 'common/country_tags/zz_world_countries.txt' },
        { path: 'common/bookmarks/world.txt' },
        { path: 'common/on_actions/world.txt' },
        { path: 'common/ai_areas/world.txt' },
        { path: 'common/ai_strategy_plans/world.txt' },
        { path: 'localisation/english/world_l_english.yml' },
        { path: 'localisation/replace/world_l_english.yml' },
      ],
    };
    const countryRule: EnginePathRule = {
      any: [
        {
          dir: {
            dirs: ['common/countries', 'history/countries'],
            pattern: '^[A-Z][A-Z0-9]{2} - [^/]+\\.txt$',
          },
        },
        { dir: { dirs: ['history/units'], pattern: '^[A-Z][A-Z0-9]{2}_world\\.txt$' } },
        {
          dir: {
            dirs: ['gfx/flags', 'gfx/flags/medium', 'gfx/flags/small'],
            pattern: '^[A-Z][A-Z0-9]{2}\\.tga$',
          },
        },
        { path: 'common/countries/colors.txt' },
        { path: 'common/country_tags/zz_world_countries.txt' },
        { path: 'common/bookmarks/world.txt' },
      ],
    };
    const addable: EnginePathRule = { all: [permits, { not: countryRule }] };
    const manifestPath = '.hoi4-agent-world.json';
    // Every sampled real path is one rule decision: it must be written exactly when the TypeScript predicate allows it.
    const decisions = pathsForManaged.slice(0, 2000);
    const tsDecision = planManagedOutputs({
      manifestPath,
      sources: [],
      proposed: decisions.map((relativePath) => ({
        relativePath,
        content: Buffer.from(relativePath),
        operationIds: ['op'],
      })),
      operationId: 'op',
      permitsPath: worldRules,
    });
    const rustDecision = await planManagedOutputsOnEngine({
      manifestPath,
      sources: [],
      proposed: decisions.map((relativePath) => ({
        relativePath,
        sha256: sha256Bytes(Buffer.from(relativePath)),
        operationIds: ['op'],
      })),
      operationId: 'op',
      permits,
    });
    check('managed', `${id}:rule-decisions`, tsDecision.written, rustDecision.written);
    for (let scenario = 0; scenario < 60; scenario += 1) {
      const pool = pathsForManaged
        .concat([
          'map/definition.csv',
          'history/states/1-Test.txt',
          'common/countries/ABC - Test.txt',
          'gfx/flags/ABC.tga',
          'other/tool.txt',
        ])
        .filter(() => rnd() < 0.05);
      const recorded = pool.map((relativePath) => ({
        relativePath,
        content: Buffer.from(`recorded ${relativePath}`),
      }));
      const manifestFiles = recorded.filter(
        ({ relativePath }) => worldRules(relativePath) || rnd() < 0.2,
      );
      const manifestText = `${JSON.stringify({ version: 1, files: manifestFiles.map((file) => ({ relativePath: file.relativePath, sha256: sha256Bytes(file.content) })) })}\n`;
      const sourceFiles = [
        { relativePath: manifestPath, content: Buffer.from(manifestText) },
        ...recorded
          .filter(() => rnd() < 0.85)
          .map((file) => ({
            relativePath: file.relativePath,
            content: rnd() < 0.15 ? Buffer.from(`edited ${file.relativePath}`) : file.content,
          })),
      ];
      const proposed = pool
        .filter(() => rnd() < 0.5)
        .map((relativePath) => ({
          relativePath,
          content: rnd() < 0.15 ? null : Buffer.from(`new ${relativePath}`),
          operationIds: [`op${Math.floor(rnd() * 3)}`],
        }));
      const release = rnd() < 0.5;
      const adoptAll = rnd() < 0.3;
      const adoptUnrecorded = rnd() < 0.3;
      const scanned = (name: string) =>
        name.startsWith('history/states/') || name.startsWith('map/strategicregions/');
      const scannedRule: EnginePathRule = {
        dir: { dirs: ['history/states', 'map/strategicregions'], pattern: '.*' },
      };
      const tsSources = sourceFiles.map((file) => ({
        relativePath: file.relativePath,
        bytes: file.content,
        rootKind: 'mod' as const,
      })) as never;
      const engineSources = sourceFiles.map((file) => ({
        relativePath: file.relativePath,
        rootKind: 'mod',
        sha256: sha256Bytes(file.content),
      }));
      const engineProposed = proposed.map((change) => ({
        relativePath: change.relativePath,
        sha256: change.content === null ? null : sha256Bytes(change.content),
        operationIds: change.operationIds,
      }));
      const label = `${id}:scenario-${scenario}`;
      const settle = async <T>(action: () => Promise<T> | T): Promise<unknown> => {
        try {
          return await action();
        } catch (error) {
          return {
            code: (error as { code?: string }).code,
            details: (error as { details?: unknown }).details,
          };
        }
      };
      const expectedPlan = await settle(() => {
        const plan = planManagedOutputs({
          manifestPath,
          sources: tsSources,
          proposed,
          operationId: 'plan',
          permitsPath: worldRules,
          ...(release ? { releasable: isWorldCountryOutput } : {}),
        });
        return {
          deletions: plan.changes
            .filter((change) => change.content === null)
            .map((change) => ({
              relativePath: change.relativePath,
              operationIds: change.operationIds,
            })),
          manifest: Buffer.from(plan.changes.at(-1)!.content!).toString('utf8'),
          written: plan.written,
          retired: plan.retired,
          released: plan.released,
          ignored: plan.ignored,
        };
      });
      const actualPlan = await settle(() =>
        planManagedOutputsOnEngine({
          manifestPath,
          sources: engineSources,
          manifestText,
          proposed: engineProposed,
          operationId: 'plan',
          permits,
          ...(release ? { releasable: countryRule } : {}),
        }),
      );
      check('managed', `${label}:plan`, expectedPlan, actualPlan);
      const expectedRefresh = await settle(() => {
        const refresh = refreshManagedOutputs({
          manifestPath,
          sources: tsSources,
          proposed,
          adoptAll,
          adoptUnrecorded,
          addable: (name) => worldRules(name) && !isWorldCountryOutput(name),
          alwaysScanned: scanned,
        });
        return refresh === undefined
          ? null
          : {
              ...refresh,
              content: refresh.content === undefined ? null : refresh.content.toString('utf8'),
            };
      });
      const actualRefresh = await settle(async () => {
        const refresh = await refreshManagedOutputsOnEngine({
          manifestPath,
          sources: engineSources,
          manifestText,
          proposed: engineProposed,
          adoptAll,
          adoptUnrecorded,
          addable,
          alwaysScanned: scannedRule,
        });
        return refresh === null ? null : { ...refresh, content: refresh.content ?? null };
      });
      check('managed', `${label}:refresh`, expectedRefresh, actualRefresh);
    }
  }

  // image diff, by decoded pixels
  const rnd = random(sweepSeed);
  for (let round = 0; round < 40; round += 1) {
    const size = (side: number) => 1 + Math.floor(rnd() * side);
    const make = async (width: number, height: number, mode: number): Promise<Buffer> => {
      const data = Buffer.alloc(width * height * 4);
      for (let index = 0; index < data.length; index += 1)
        data[index] =
          mode === 0 ? Math.floor(rnd() * 256) : mode === 1 ? (index % 4 === 3 ? 255 : 100) : 0;
      return sharp(data, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer();
    };
    const left = await make(size(40), size(40), round % 3);
    const right = await make(size(40), size(40), (round + 1) % 3);
    const threshold = [0, 8, 64][round % 3]!;
    const expected = await comparePngImages(left, right, threshold);
    const actual = await comparePngImagesOnEngine(left, right, { threshold });
    const pixels = async (png: Buffer) =>
      (await sharp(png).ensureAlpha().raw().toBuffer()).toString('base64');
    check(
      'image',
      `round-${round}`,
      [
        expected.width,
        expected.height,
        expected.changedPixels,
        expected.changedRatio,
        expected.json,
        await pixels(expected.png),
      ],
      [
        actual.width,
        actual.height,
        actual.changedPixels,
        actual.changedRatio,
        actual.json,
        await pixels(actual.png),
      ],
    );
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

let differs = false;
for (const [kind, entry] of Object.entries(report)) {
  process.stdout.write(`${kind}: ${entry.checked} checked, ${entry.differences} differ\n`);
  if (entry.differences > 0) {
    differs = true;
    for (const line of entry.samples) process.stdout.write(`  ${line}\n`);
  }
}
if (values.out !== undefined) await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
process.exit(differs ? 1 : 0);
