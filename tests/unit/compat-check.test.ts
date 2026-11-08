import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import {
  runEngineCheck,
  type EngineCheckReport,
} from '../../src/hoi4_agent_tools/core/engine-check.js';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  bounded,
  checkModCompatibility,
  compareLoadOrders,
  fitToBudget,
  shippedInFolders,
  summariseLoadOrder,
} from '../../src/hoi4_agent_tools/reference/compat.js';
import {
  checkPatchCompatibility,
  compareSnapshots,
  describeTextChange,
  listSnapshots,
  overriddenVanillaFiles,
  recordSnapshot,
} from '../../src/hoi4_agent_tools/reference/compat-patch.js';
import { compatCheckRequestSchema } from '../../src/hoi4_agent_tools/schemas/compat.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0)) await action();
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-compat-'));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

async function write(root: string, relative: string, text: string): Promise<void> {
  const file = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

interface Layer {
  kind: string;
  name: string;
  path?: string;
  replace_paths?: string[];
}

function report(input: {
  layers: Layer[];
  overrides?: Array<{ path: string; winner: string; replaced: string[] }>;
  findings?: Array<Partial<EngineCheckReport['findings'][number]> & { code: string }>;
  build?: string | null;
}): EngineCheckReport {
  return {
    schema: 'hoi4-engine-report/1',
    engine_version: 'test',
    verdict: 'pass',
    inputs: {
      layers: input.layers.map((layer) => ({
        kind: layer.kind,
        name: layer.name,
        path: layer.path ?? '/unused',
        replace_paths: layer.replace_paths ?? [],
      })),
      game_version: input.build === undefined ? '1.0' : input.build,
    },
    summary: { errors: 0, warnings: 0, infos: 0, by_code: {} },
    stats: {},
    overrides: input.overrides ?? [],
    findings: (input.findings ?? []).map((finding) => ({
      severity: 'warning' as const,
      message: '',
      path: 'common/x.txt',
      layer: 'Beta',
      line: 1,
      column: 1,
      ...finding,
    })),
  };
}

const alpha = { id: 'alpha', name: 'Alpha' };
const beta = { id: 'beta', name: 'Beta' };

/** Beta loads after Alpha. */
const betaAfterAlpha = () =>
  report({
    layers: [
      { kind: 'game', name: 'game' },
      { kind: 'dependency', name: 'Alpha' },
      { kind: 'mod', name: 'Beta' },
    ],
    overrides: [
      { path: 'common/ideas/a.txt', winner: 'Beta', replaced: ['Alpha:common/ideas/a.txt'] },
      {
        path: 'events/game.txt',
        winner: 'Beta',
        replaced: ['game:events/game.txt'],
      },
      {
        path: 'common/both.txt',
        winner: 'Beta',
        replaced: ['game:common/both.txt', 'Alpha:common/both.txt'],
      },
    ],
    findings: [
      {
        code: 'LINT_DUPLICATE_ACROSS_LAYERS',
        severity: 'error',
        subject: 'shared.1',
        path: 'events/b.txt',
        message:
          'event `shared.1` is also defined by dependency Alpha in events/a.txt line 3, and both load',
      },
      {
        // The same kind of finding against the game: not a compatibility problem.
        code: 'LINT_DUPLICATE_ACROSS_LAYERS',
        severity: 'error',
        subject: 'vanilla.1',
        path: 'events/b.txt',
        message:
          'event `vanilla.1` is also defined by the game in events/v.txt line 3, and both load',
      },
      {
        code: 'OVERRIDE_DROPS_DEFINITION',
        subject: 'idea:old_idea',
        path: 'common/ideas/a.txt',
        message:
          'idea `old_idea` from Alpha:common/ideas/a.txt is missing from this copy and no other loaded file defines it',
      },
      {
        code: 'OVERRIDE_DROPS_DEFINITION',
        subject: 'idea:game_idea',
        path: 'events/game.txt',
        message:
          'idea `game_idea` from game:events/game.txt is missing from this copy and no other loaded file defines it',
      },
      {
        code: 'OVERRIDE_DROPS_ON_ACTION_HOOK',
        subject: 'on_daily:events:alpha.1',
        path: 'common/on_actions/b.txt',
        message:
          '`on_daily` in Alpha:common/on_actions/a.txt runs event `alpha.1`, which this copy no longer hooks and no other loaded file hooks',
      },
      {
        code: 'OVERRIDE_BREAKS_REFERENCE',
        severity: 'error',
        subject: 'alpha_effect',
        path: 'events/b.txt',
        layer: 'Beta',
        message:
          '`alpha_effect` is called here, but its definition in Alpha:common/scripted_effects/a.txt is replaced by Beta:common/scripted_effects/a.txt without it, so the game reports it as unknown',
      },
      {
        code: 'OVERRIDE_REPLACES_FILE',
        severity: 'info',
        path: 'common/ideas/a.txt',
        message: 'this file replaces Alpha:common/ideas/a.txt entirely',
      },
    ],
  });

/** Alpha loads after Beta: Alpha's files win, with fewer losses. */
const alphaAfterBeta = () =>
  report({
    layers: [
      { kind: 'game', name: 'game' },
      { kind: 'dependency', name: 'Beta' },
      { kind: 'mod', name: 'Alpha' },
    ],
    overrides: [
      { path: 'common/ideas/a.txt', winner: 'Alpha', replaced: ['Beta:common/ideas/a.txt'] },
    ],
    findings: [
      {
        code: 'OVERRIDE_DROPS_DEFINITION',
        subject: 'idea:beta_idea',
        path: 'common/ideas/a.txt',
        layer: 'Alpha',
        message:
          'idea `beta_idea` from Beta:common/ideas/a.txt is missing from this copy and no other loaded file defines it',
      },
    ],
  });

describe('compat_check request', () => {
  it('needs other for mod and refuses it for patch', () => {
    expect(compatCheckRequestSchema.safeParse({ mode: 'mod' }).success).toBe(false);
    expect(compatCheckRequestSchema.safeParse({ mode: 'patch', other: 'x' }).success).toBe(false);
    expect(compatCheckRequestSchema.safeParse({ mode: 'mod', other: 'x', from: '1' }).success).toBe(
      false,
    );
    expect(compatCheckRequestSchema.safeParse({ mode: 'mod', other: 'x', extra: 1 }).success).toBe(
      false,
    );
    expect(compatCheckRequestSchema.parse({ mode: 'patch' }).limit).toBe(10);
    expect(compatCheckRequestSchema.safeParse({ mode: 'patch', limit: 51 }).success).toBe(false);
  });
});

describe('mod compatibility, one load order', () => {
  it('keeps only findings that involve both mods and counts errors and warnings', () => {
    const order = summariseLoadOrder(
      { report: betaAfterAlpha(), first: alpha, second: beta, replacePathFiles: [] },
      10,
    );
    expect(order.sameFile.items).toEqual([
      { path: 'common/both.txt', winner: 'Beta' },
      { path: 'common/ideas/a.txt', winner: 'Beta' },
    ]);
    expect(order.duplicateDefinitions.items.map(({ subject }) => subject)).toEqual(['shared.1']);
    expect(order.dropped.items.map(({ code, subject }) => `${code} ${subject}`)).toEqual([
      'OVERRIDE_BREAKS_REFERENCE alpha_effect',
      'OVERRIDE_DROPS_DEFINITION idea:old_idea',
      'OVERRIDE_DROPS_ON_ACTION_HOOK on_daily:events:alpha.1',
    ]);
    // 2 errors (duplicate event, broken reference) and 2 warnings (dropped idea, dropped hook).
    expect([order.errors, order.warnings]).toEqual([2, 2]);
  });

  it('counts a file a replace_path unloads as a warning', () => {
    const order = summariseLoadOrder(
      {
        report: alphaAfterBeta(),
        first: beta,
        second: alpha,
        replacePathFiles: [{ folder: 'common/ideas', files: ['a.txt', 'b.txt'] }],
      },
      10,
    );
    expect(order.replacePathDrops.items).toEqual([
      { folder: 'common/ideas', fileCount: 2, files: ['a.txt', 'b.txt'] },
    ]);
    expect([order.errors, order.warnings]).toEqual([0, 3]);
  });

  it('bounds every list and keeps the counts', () => {
    const many = report({
      layers: [
        { kind: 'dependency', name: 'Alpha' },
        { kind: 'mod', name: 'Beta' },
      ],
      findings: Array.from({ length: 12 }, (_, index) => ({
        code: 'LINT_DUPLICATE_ACROSS_LAYERS',
        subject: `id_${String(index).padStart(2, '0')}`,
        message: `event \`id_${index}\` is also defined by dependency Alpha in events/a.txt line 1, and both load`,
      })),
    });
    const order = summariseLoadOrder(
      { report: many, first: alpha, second: beta, replacePathFiles: [] },
      5,
    );
    expect(order.duplicateDefinitions).toMatchObject({ count: 12, omitted: 7 });
    expect(order.duplicateDefinitions.items).toHaveLength(5);
    expect(order.warnings).toBe(12);
    expect(bounded([1, 2, 3], 2)).toEqual({ count: 3, omitted: 1, items: [1, 2] });
  });

  it('refuses a report that does not end with the two mods', () => {
    expect(() =>
      summariseLoadOrder(
        {
          report: report({ layers: [{ kind: 'game', name: 'game' }] }),
          first: alpha,
          second: beta,
          replacePathFiles: [],
        },
        5,
      ),
    ).toThrow(/last two layers/u);
  });
});

describe('mod compatibility, both load orders', () => {
  it('says which load order loses less, with its numbers', () => {
    const compared = compareLoadOrders([
      summariseLoadOrder(
        { report: betaAfterAlpha(), first: alpha, second: beta, replacePathFiles: [] },
        10,
      ),
      summariseLoadOrder(
        { report: alphaAfterBeta(), first: beta, second: alpha, replacePathFiles: [] },
        10,
      ),
    ]);
    expect(compared.verdict).toBe('conflicts');
    expect(compared.lessLoss).toEqual({
      loadsLast: alpha,
      errors: 0,
      warnings: 1,
      otherOrderErrors: 2,
      otherOrderWarnings: 2,
    });
    expect(compared.summary).toContain(
      'Loading Alpha last loses less (0 errors and 1 warnings, against 2 and 2)',
    );
  });

  it('reports no conflicts for two mods that share nothing', () => {
    const empty = (first: string, second: string) =>
      report({
        layers: [
          { kind: 'dependency', name: first },
          { kind: 'mod', name: second },
        ],
      });
    const compared = compareLoadOrders([
      summariseLoadOrder(
        { report: empty('Alpha', 'Beta'), first: alpha, second: beta, replacePathFiles: [] },
        10,
      ),
      summariseLoadOrder(
        { report: empty('Beta', 'Alpha'), first: beta, second: alpha, replacePathFiles: [] },
        10,
      ),
    ]);
    expect(compared).toMatchObject({ verdict: 'no_conflicts', lessLoss: null });
  });

  it('fits a result to the budget by listing less, never by dropping counts', () => {
    const build = (limit: number) => ({
      count: 1000,
      items: Array.from({ length: limit }, () => 'x'.repeat(500)),
    });
    const fitted = fitToBudget(build, 50, 10_000);
    expect(fitted.count).toBe(1000);
    expect(fitted.items.length).toBeGreaterThan(0);
    expect(fitted.items.length).toBeLessThan(50);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(10_000);
  });
});

describe('replace_path files of the other mod', () => {
  it('lists plain files directly in the folder and ignores unsafe folders', async () => {
    const root = await scratch();
    await write(root, 'common/ideas/a.txt', 'x');
    await write(root, 'common/ideas/b.txt', 'x');
    await write(root, 'common/ideas/sub/c.txt', 'x');
    const found = await shippedInFolders(root, [
      'common/ideas',
      'common/missing',
      '../outside',
      '/abs',
      'common\\ideas',
      'C:/x',
    ]);
    expect(found).toEqual([{ folder: 'common/ideas', files: ['a.txt', 'b.txt'] }]);
  });
});

async function pair(extra: Record<string, unknown> = {}) {
  const root = await scratch();
  const a = path.join(root, 'alpha');
  const b = path.join(root, 'beta');
  const c = path.join(root, 'gamma');
  await Promise.all([a, b, c].map((dir) => mkdir(dir, { recursive: true })));
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [
        { id: 'alpha', name: 'Alpha', root: a },
        { id: 'beta', name: 'Beta', root: b },
        { id: 'gamma', name: 'Gamma', root: c },
      ],
      http: {
        principals: [
          { principal: 'only-alpha', workspaceIds: ['alpha'], allowDiscoveredMods: false },
        ],
      },
      ...extra,
    }),
  );
  return { root, resolver, engine: new CoreEngine(resolver), a, b };
}

describe('mod compatibility through the service', () => {
  it('runs the check in both orders with the other mod as the dependency', async () => {
    const { engine, resolver, a, b } = await pair();
    await write(b, 'descriptor.mod', 'name="Beta"\nreplace_path="common/ideas"\n');
    await write(a, 'common/ideas/mine.txt', 'x');
    const calls: Array<{ mod: string; dependencies: readonly string[] | undefined }> = [];
    const data = await checkModCompatibility(
      engine,
      resolver.get('alpha'),
      compatCheckRequestSchema.parse({ mode: 'mod', other: 'beta' }),
      undefined,
      undefined,
      {
        runCheck: async (request) => {
          calls.push({ mod: request.mod, dependencies: request.dependencies });
          return request.mod === resolver.get('alpha').modRoot
            ? betaAfterAlpha()
            : alphaAfterBeta();
        },
      },
    );
    expect(calls.map(({ mod }) => path.basename(mod)).sort()).toEqual(['alpha', 'beta']);
    expect(
      calls
        .find(({ mod }) => path.basename(mod) === 'alpha')
        ?.dependencies?.map((d) => path.basename(d)),
    ).toEqual(['beta']);
    expect(data.verdict).toBe('conflicts');
    expect(data.loadOrders[0]).toMatchObject({ first: { id: 'beta' }, second: { id: 'alpha' } });
    expect(data.loadOrders[1]).toMatchObject({ first: { id: 'alpha' }, second: { id: 'beta' } });
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThan(24_000);
  });

  it('refuses an unknown other mod', async () => {
    const { engine, resolver } = await pair();
    await expect(
      checkModCompatibility(
        engine,
        resolver.get('alpha'),
        compatCheckRequestSchema.parse({ mode: 'mod', other: 'nonexistent_mod' }),
        undefined,
        undefined,
        { runCheck: () => Promise.reject(new Error('must not run')) },
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_REGISTERED' });
  });

  it('refuses an other mod the principal may not read, and the mod itself', async () => {
    const { engine, resolver } = await pair();
    const never = { runCheck: () => Promise.reject(new Error('must not run')) };
    await expect(
      checkModCompatibility(
        engine,
        resolver.get('alpha'),
        compatCheckRequestSchema.parse({ mode: 'mod', other: 'beta' }),
        'only-alpha',
        undefined,
        never,
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_INACCESSIBLE' });
    await expect(
      checkModCompatibility(
        engine,
        resolver.get('alpha'),
        compatCheckRequestSchema.parse({ mode: 'mod', other: 'alpha' }),
        'only-alpha',
        undefined,
        never,
      ),
    ).rejects.toMatchObject({ code: 'COMPAT_OTHER_IS_SELF' });
  });

  it('reports ENGINE_UNAVAILABLE when there is no engine', async () => {
    const { engine, resolver, root } = await pair();
    const missing = path.join(root, process.platform === 'win32' ? 'none.exe' : 'none');
    const error = await checkModCompatibility(
      engine,
      resolver.get('alpha'),
      compatCheckRequestSchema.parse({ mode: 'mod', other: 'beta' }),
      undefined,
      undefined,
      {
        runCheck: (request, options) =>
          runEngineCheck(request, { ...options, env: { HOI4_ENGINE: missing } }),
      },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });
});

describe('text changes', () => {
  it('counts lines and shows the first hunk of the diff', () => {
    const older = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
    const lines = older.split('\n');
    lines[10] = 'line ten changed';
    lines.splice(25, 0, 'inserted');
    const change = describeTextChange(older, lines.join('\n'));
    expect(change).toMatchObject({ oldLines: 30, newLines: 31, linesAdded: 2, linesRemoved: 1 });
    expect(change.firstHunk).toBe(
      [
        '@@ -8,7 +8,7 @@',
        ' line 7',
        ' line 8',
        ' line 9',
        '-line 10',
        '+line ten changed',
        ' line 11',
        ' line 12',
        ' line 13',
      ].join('\n'),
    );
  });

  it('has no hunk for equal text and handles a CRLF file with a byte order mark', () => {
    expect(describeTextChange('a\nb\n', '\uFEFFa\r\nb\r\n')).toMatchObject({
      linesAdded: 0,
      firstHunk: null,
    });
  });

  it('bounds a hunk of a huge replacement', () => {
    const big = describeTextChange('x\n'.repeat(3000), 'y\n'.repeat(3000));
    expect(big.linesAdded).toBe(3000);
    expect(big.firstHunk?.length ?? 0).toBeLessThanOrEqual(1500);
  });
});

describe('snapshots of overridden vanilla files', () => {
  async function vanillaFixture() {
    const root = await scratch();
    const game = path.join(root, 'game');
    const dlc = path.join(root, 'dlc1');
    await write(game, 'common/ideas/a.txt', 'idea = {\n a = 1\n}\n');
    await write(game, 'common/ideas/b.txt', 'b\n');
    await write(game, 'common/ideas/c.txt', 'c\n');
    await write(game, 'events/e.txt', 'e\n');
    await write(game, 'gfx/pic.dds', Buffer.from([68, 68, 83, 0, 1, 2]).toString('latin1'));
    await write(dlc, 'common/ideas/d.txt', 'd\n');
    const layers: Layer[] = [
      { kind: 'game', name: 'game', path: game },
      { kind: 'dlc', name: 'dlc1', path: dlc },
      { kind: 'mod', name: 'Mine', replace_paths: ['common/ideas'] },
    ];
    const check = report({
      layers,
      overrides: [
        { path: 'events/e.txt', winner: 'Mine', replaced: ['game:events/e.txt'] },
        { path: 'gfx/pic.dds', winner: 'Mine', replaced: ['game:gfx/pic.dds'] },
        {
          path: 'events/other.txt',
          winner: 'Mine',
          replaced: ['Other:events/other.txt', 'game:../../escape.txt'],
        },
      ],
    });
    return { root, game, dlc, check };
  }

  it('lists overridden files and the vanilla files in replace_path folders', async () => {
    const { check } = await vanillaFixture();
    const files = await overriddenVanillaFiles(check);
    expect(files.map(({ layer, path: file }) => `${layer}:${file}`)).toEqual([
      'dlc1:common/ideas/d.txt',
      'game:common/ideas/a.txt',
      'game:common/ideas/b.txt',
      'game:common/ideas/c.txt',
      'game:events/e.txt',
      'game:gfx/pic.dds',
    ]);
  });

  it('stores hashes and text copies in the cache folder, prunes beyond three and ignores damage', async () => {
    const { root, check } = await vanillaFixture();
    const workspace = { cacheRoot: path.join(root, 'cache') };
    const files = await overriddenVanillaFiles(check);
    const first = await recordSnapshot(workspace, '1.0', files);
    expect(first.manifest.files).toHaveLength(6);
    expect(first.manifest.files.find(({ path: file }) => file === 'gfx/pic.dds')).toMatchObject({
      text: false,
      copied: false,
    });
    expect(first.manifest.files.filter(({ copied }) => copied)).toHaveLength(5);
    for (const build of ['1.1', '1.2', '1.3']) await recordSnapshot(workspace, build, files);
    const stored = await listSnapshots(workspace);
    expect(stored.map(({ manifest }) => manifest.build)).toEqual(['1.3', '1.2', '1.1']);
    // The same build again replaces its snapshot instead of adding one.
    await recordSnapshot(workspace, '1.3', files);
    expect((await listSnapshots(workspace)).map(({ manifest }) => manifest.build)).toEqual([
      '1.3',
      '1.2',
      '1.1',
    ]);
    // A damaged manifest is not a snapshot.
    const damaged = stored[0]!.directory;
    await writeFile(path.join(damaged, 'manifest.json'), '{"schema":"other"}');
    expect((await listSnapshots(workspace)).map(({ manifest }) => manifest.build)).toEqual([
      '1.2',
      '1.1',
    ]);
    expect(
      (await readdir(path.join(root, 'cache', 'compat-snapshots'))).filter((name) =>
        name.startsWith('.writing'),
      ),
    ).toEqual([]);
  });

  it('stops copying at the per-file and per-snapshot limits but keeps every hash', async () => {
    const { root, check, game } = await vanillaFixture();
    await write(game, 'events/e.txt', 'e'.repeat(100));
    const files = await overriddenVanillaFiles(check);
    const recorded = await recordSnapshot(
      { cacheRoot: path.join(root, 'cache') },
      '1.0',
      files,
      undefined,
      {
        maxCopiedFileBytes: 50,
        maxSnapshotBytes: 8,
      },
    );
    const byPath = new Map(recorded.manifest.files.map((file) => [file.path, file]));
    expect(byPath.get('events/e.txt')).toMatchObject({ text: true, copied: false, size: 100 });
    expect(byPath.get('events/e.txt')?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    // 'idea = {...}' is 17 bytes, over the 8 byte snapshot limit; the two-byte files fit.
    expect(byPath.get('common/ideas/a.txt')?.copied).toBe(false);
    expect(byPath.get('common/ideas/b.txt')?.copied).toBe(true);
    expect(recorded.bytes).toBeLessThanOrEqual(8);
  });

  it('reports changed, added and removed files between two builds', async () => {
    const { root, check, game } = await vanillaFixture();
    const workspace = { cacheRoot: path.join(root, 'cache') };
    const mod = path.join(root, 'mod');
    await write(mod, 'events/e.txt', 'mine');
    await recordSnapshot(workspace, '1.0', await overriddenVanillaFiles(check));
    await write(game, 'common/ideas/a.txt', 'idea = {\n a = 2\n b = 3\n}\n');
    await rm(path.join(game, 'events', 'e.txt'));
    await write(game, 'common/ideas/new.txt', 'new\n');
    await write(game, 'gfx/pic.dds', Buffer.from([68, 68, 83, 0, 9, 9]).toString('latin1'));
    await recordSnapshot(workspace, '1.1', await overriddenVanillaFiles(check));
    const [newer, older] = await listSnapshots(workspace);
    const compared = await compareSnapshots(
      older!,
      newer!,
      async (relative) => relative === 'events/e.txt',
    );
    expect(compared).toMatchObject({
      from: '1.0',
      to: '1.1',
      changed: 2,
      added: 1,
      removed: 1,
      unchanged: 3,
      noLongerOverridden: 0,
    });
    expect(compared.files.map(({ change, path: file }) => `${change} ${file}`)).toEqual([
      'changed common/ideas/a.txt',
      'changed gfx/pic.dds',
      'removed events/e.txt',
      'added common/ideas/new.txt',
    ]);
    const idea = compared.files[0]!;
    expect(idea).toMatchObject({
      oldLines: 3,
      newLines: 4,
      linesAdded: 2,
      linesRemoved: 1,
      binary: false,
    });
    expect(idea.firstHunk).toContain('-\u0020a = 1\n+\u0020a = 2');
    expect(compared.files[1]).toMatchObject({ binary: true, firstHunk: null, oldLines: null });
    // A file the mod no longer ships at that path was not removed from vanilla for its sake.
    const gone = await compareSnapshots(older!, newer!, async () => false);
    expect(gone).toMatchObject({ removed: 0, noLongerOverridden: 1 });
  });
});

describe('patch mode through the service', () => {
  async function modWorkspace() {
    const root = await scratch();
    const game = path.join(root, 'game');
    const modRoot = path.join(root, 'mod');
    await write(game, 'events/e.txt', 'one\ntwo\n');
    await write(modRoot, 'events/e.txt', 'mine\n');
    await write(modRoot, 'descriptor.mod', 'name="Mine"\n');
    const resolver = await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        gameRoot: game,
        workspaces: [
          { id: 'mine', name: 'Mine', root: modRoot, gameRoot: game, includeGameDlc: false },
        ],
      }),
    );
    const checkFor = (build: string | null) =>
      report({
        build,
        layers: [
          { kind: 'game', name: 'game', path: resolver.get('mine').gameRoot ?? game },
          { kind: 'mod', name: 'Mine' },
        ],
        overrides: [{ path: 'events/e.txt', winner: 'Mine', replaced: ['game:events/e.txt'] }],
      });
    return { resolver, game, workspace: resolver.get('mine'), checkFor };
  }

  it('records a baseline first, then reports what the patch changed', async () => {
    const { workspace, game, checkFor } = await modWorkspace();
    let build = '1.0';
    const services = { runCheck: async () => checkFor(build) };
    const first = await checkPatchCompatibility(
      workspace,
      compatCheckRequestSchema.parse({ mode: 'patch' }),
      undefined,
      services,
    );
    expect(first).toMatchObject({
      installedBuild: '1.0',
      comparison: null,
      recorded: { build: '1.0', files: 1 },
    });
    expect(first.summary).toContain('Run again after the next game update');
    expect((await listSnapshots(workspace))[0]?.directory.startsWith(workspace.cacheRoot)).toBe(
      true,
    );
    build = '1.1';
    await write(game, 'events/e.txt', 'one\nTWO\nthree\n');
    const second = await checkPatchCompatibility(
      workspace,
      compatCheckRequestSchema.parse({ mode: 'patch' }),
      undefined,
      services,
    );
    expect(second.comparison).toMatchObject({
      from: '1.0',
      to: '1.1',
      changed: 1,
      added: 0,
      removed: 0,
    });
    expect(second.comparison?.files[0]).toMatchObject({
      path: 'events/e.txt',
      change: 'changed',
      linesAdded: 2,
      linesRemoved: 1,
    });
    expect(second.stored.map(({ build: name }) => name)).toEqual(['1.1', '1.0']);
    expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThan(24_000);
  });

  it('compares two stored builds without the engine, and names missing ones', async () => {
    const { workspace, game, checkFor } = await modWorkspace();
    let build = '1.0';
    const services = { runCheck: async () => checkFor(build) };
    const request = compatCheckRequestSchema.parse({ mode: 'patch' });
    await checkPatchCompatibility(workspace, request, undefined, services);
    build = '1.1';
    await write(game, 'events/e.txt', 'changed\n');
    await checkPatchCompatibility(workspace, request, undefined, services);
    const noEngine = { runCheck: () => Promise.reject(new Error('must not run')) };
    const stored = await checkPatchCompatibility(
      workspace,
      compatCheckRequestSchema.parse({ mode: 'patch', from: '1.0', to: '1.1' }),
      undefined,
      noEngine,
    );
    expect(stored).toMatchObject({
      installedBuild: null,
      recorded: null,
      comparison: { changed: 1 },
    });
    await expect(
      checkPatchCompatibility(
        workspace,
        compatCheckRequestSchema.parse({ mode: 'patch', from: '0.9', to: '1.1' }),
        undefined,
        noEngine,
      ),
    ).rejects.toMatchObject({ code: 'COMPAT_SNAPSHOT_NOT_FOUND' });
    await expect(
      checkPatchCompatibility(
        workspace,
        compatCheckRequestSchema.parse({ mode: 'patch', from: '1.1', to: '1.1' }),
        undefined,
        noEngine,
      ),
    ).rejects.toMatchObject({ code: 'COMPAT_SNAPSHOT_SAME_BUILD' });
  });

  it('refuses an unknown game build and an unavailable engine', async () => {
    const { workspace, checkFor, resolver } = await modWorkspace();
    await expect(
      checkPatchCompatibility(
        workspace,
        compatCheckRequestSchema.parse({ mode: 'patch' }),
        undefined,
        {
          runCheck: async () => checkFor(null),
        },
      ),
    ).rejects.toMatchObject({ code: 'COMPAT_GAME_BUILD_UNKNOWN' });
    const missing = path.join(
      path.dirname(workspace.modRoot),
      process.platform === 'win32' ? 'none.exe' : 'none',
    );
    await expect(
      checkPatchCompatibility(
        resolver.get('mine'),
        compatCheckRequestSchema.parse({ mode: 'patch' }),
        undefined,
        {
          runCheck: (request, options) =>
            runEngineCheck(request, { ...options, env: { HOI4_ENGINE: missing } }),
        },
      ),
    ).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });

  it('lists at most the requested number of files and counts the rest', async () => {
    const { workspace, game } = await modWorkspace();
    const names = Array.from({ length: 8 }, (_, index) => `common/f${index}.txt`);
    await Promise.all(names.map((name) => write(game, name, 'v1\n')));
    const check = (build: string) =>
      report({
        build,
        layers: [
          { kind: 'game', name: 'game', path: game },
          { kind: 'mod', name: 'Mine' },
        ],
        overrides: names.map((name) => ({
          path: name,
          winner: 'Mine',
          replaced: [`game:${name}`],
        })),
      });
    await checkPatchCompatibility(
      workspace,
      compatCheckRequestSchema.parse({ mode: 'patch' }),
      undefined,
      { runCheck: async () => check('1.0') },
    );
    await Promise.all(names.map((name) => write(game, name, 'v2\n')));
    const data = await checkPatchCompatibility(
      workspace,
      compatCheckRequestSchema.parse({ mode: 'patch', limit: 3 }),
      undefined,
      { runCheck: async () => check('1.1') },
    );
    expect(data.comparison).toMatchObject({ changed: 8, omitted: 5 });
    expect(data.comparison?.files).toHaveLength(3);
  });
});
