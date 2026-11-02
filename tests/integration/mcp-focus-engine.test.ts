import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashCanonical } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { parseClausewitz } from '../../src/hoi4_agent_tools/core/source/index.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { importFocusTrees } from '../../src/hoi4_agent_tools/focus/index.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';
import { writeFakeEngine } from '../helpers/fake-engine.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const relativePath = 'common/national_focus/engine_tree.txt';
const treeId = 'engine_tree';

function isFile(candidate: string | undefined): candidate is string {
  if (candidate === undefined || candidate === '' || !path.isAbsolute(candidate)) return false;
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** A built hoi4-engine: HOI4_ENGINE, else a cargo debug or release build. */
function realEngineBinary(): string | undefined {
  const executable = process.platform === 'win32' ? 'hoi4-engine.exe' : 'hoi4-engine';
  const targets = [
    process.env.CARGO_TARGET_DIR,
    path.join(repositoryRoot, 'engine', 'target'),
  ].filter((entry): entry is string => entry !== undefined && entry !== '');
  return [
    process.env.HOI4_ENGINE,
    ...targets.flatMap((target) => [
      path.resolve(target, 'debug', executable),
      path.resolve(target, 'release', executable),
    ]),
  ].find(isFile);
}

const engineBinary = realEngineBinary();

interface FocusSpec {
  id: string;
  lane: string;
  needs?: string[][];
  exclusive?: string[];
}

function focusNode(spec: FocusSpec): Record<string, unknown> {
  return {
    id: spec.id,
    label: spec.id,
    branchId: spec.lane,
    laneId: spec.lane,
    prerequisites: {
      operator: 'and',
      groups: (spec.needs ?? []).map((focusIds) => ({
        operator: 'or',
        focusIds,
        rawPassthrough: [],
      })),
    },
    mutuallyExclusive: spec.exclusive ?? [],
    routeLocks: [],
    position: { mode: 'auto', pinned: false },
    visibility: 'normal',
    convergence: false,
    sharedSupport: false,
    icons: [{ kind: 'static', sprite: 'GFX_synthetic_focus' }],
    localisation: {
      titleKey: 'synthetic_root',
      descriptionKey: 'synthetic_root_desc',
      workingLabel: spec.id,
    },
    ai: {
      raw: { text: '{ factor = 10 }', referencedFocusIds: [] },
      majorRoute: false,
      strategyIds: [],
    },
    filters: ['FOCUS_FILTER_POLITICAL'],
    links: [],
    cost: 10,
    completionReward: { text: '{ add_political_power = 10 }', referencedFocusIds: [] },
    rawPassthrough: [],
  };
}

const baseFocuses: FocusSpec[] = [
  { id: 'eng_pol_start', lane: 'politics' },
  {
    id: 'eng_pol_left',
    lane: 'politics',
    needs: [['eng_pol_start']],
    exclusive: ['eng_pol_right'],
  },
  {
    id: 'eng_pol_right',
    lane: 'politics',
    needs: [['eng_pol_start']],
    exclusive: ['eng_pol_left'],
  },
  { id: 'eng_pol_left_2', lane: 'politics', needs: [['eng_pol_left']] },
  { id: 'eng_pol_right_2', lane: 'politics', needs: [['eng_pol_right']] },
  { id: 'eng_pol_end', lane: 'politics', needs: [['eng_pol_left_2', 'eng_pol_right_2']] },
  { id: 'eng_ind_start', lane: 'industry' },
  { id: 'eng_ind_civ', lane: 'industry', needs: [['eng_ind_start']] },
  { id: 'eng_ind_mil', lane: 'industry', needs: [['eng_ind_start']] },
];

const insertedFocuses: FocusSpec[] = [
  { id: 'eng_ind_new', lane: 'industry', needs: [['eng_ind_start']] },
  { id: 'eng_ind_new_2', lane: 'industry', needs: [['eng_ind_new']] },
];

function treePlan(specs: readonly FocusSpec[]): Record<string, unknown> {
  const lanes = [...new Set(specs.map(({ lane }) => lane))];
  return {
    schemaVersion: 1,
    id: treeId,
    default: true,
    branchGroups: lanes.map((lane) => ({
      id: lane,
      label: lane,
      family: 'engine-test',
      focusIds: specs.filter((spec) => spec.lane === lane).map(({ id }) => id),
      laneId: lane,
      major: false,
      hidden: false,
      crisis: false,
      conditional: false,
      aiStrategyIds: [],
    })),
    laneGroups: lanes.map((lane, order) => ({ id: lane, label: lane, order })),
    entryFocusIds: specs.filter(({ needs }) => needs === undefined).map(({ id }) => id),
    focuses: specs.map(focusNode),
    sharedFocusIds: [],
    continuousFocusPaletteIds: [],
    continuousFocusIds: [],
    rawPassthrough: [],
    provenance: {
      sourcePath: `plan:${treeId}`,
      sourceHash: '0'.repeat(64),
      importedPlanHash: '0'.repeat(64),
    },
  };
}

interface RewriteData {
  execution: string;
  layoutQuality?: { verdict: string };
  layoutDelta?: Record<string, unknown>;
  engine?: {
    operation: string;
    hashes: { layout: string | null; untouched: string; prerequisites: string; exclusions: string };
    movedFocusIds: string[];
    movedFocusCount: number;
  };
}

interface RewriteResult {
  isError?: boolean;
  structuredContent: {
    status: string;
    code: string;
    message?: string;
    data: RewriteData;
    diagnostics: Array<{ code: string }>;
    blockers: Array<{ code: string; message: string }>;
  };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-focus-engine-'));
  const mod = path.join(temporary, 'mod');
  await cp(path.join(repositoryRoot, 'fixtures', 'focus', 'workspace'), mod, { recursive: true });
  await rm(path.join(mod, 'common', 'national_focus'), { recursive: true, force: true });
  await mkdir(path.join(mod, 'common', 'national_focus'), { recursive: true });
  const engine = new CoreEngine(
    await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(temporary, 'server-state'),
        workspaces: [{ id: 'engine', name: 'Focus engine fixture', root: mod }],
      }),
    ),
  );
  await engine.initialize();
  const server = createMcpServer(engine);
  const client = new Client({ name: 'focus-engine-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(
    async () => client.close(),
    async () => server.close(),
    async () => rm(temporary, { recursive: true, force: true }),
  );
  return { client, mod, engine, sourcePath: path.join(mod, ...relativePath.split('/')) };
}

async function rewrite(client: Client, args: Record<string, unknown>): Promise<RewriteResult> {
  return (await client.callTool({
    name: 'hoi4.focus_rewrite',
    arguments: { workspaceId: 'engine', relativePath, ...args },
  })) as unknown as RewriteResult;
}

/** The current plan of the tree, as hoi4.focus_inspect returns it in its linked artifact. */
async function inspectPlan(client: Client): Promise<Record<string, unknown>> {
  const inspected = await client.callTool({
    name: 'hoi4.focus_inspect',
    arguments: { workspaceId: 'engine', relativePath, treeId },
  });
  expect(inspected.isError).not.toBe(true);
  const artifacts = (inspected.structuredContent as { artifacts: Array<{ uri: string }> })
    .artifacts;
  const resource = await client.readResource({ uri: artifacts[0]!.uri });
  const content = resource.contents[0];
  if (content === undefined || !('text' in content)) throw new Error('Missing focus plan artifact');
  return (JSON.parse(content.text) as { plans: Array<Record<string, unknown>> }).plans[0]!;
}

/** Absolute coordinates and source modes of the tree as written. */
async function writtenTree(sourcePath: string) {
  const document = parseClausewitz(await readFile(sourcePath), `mod:${relativePath}`);
  const plan = importFocusTrees(document).plans.find(({ id }) => id === treeId);
  expect(plan).toBeDefined();
  const focuses = new Map(plan!.focuses.map((focus) => [focus.id, focus]));
  const resolved = new Map<string, { x: number; y: number }>();
  const resolve = (id: string): { x: number; y: number } => {
    const known = resolved.get(id);
    if (known !== undefined) return known;
    const position = focuses.get(id)!.position;
    if (position.mode === 'auto') throw new Error(`${id} has no coordinates`);
    const base = position.mode === 'relative' ? resolve(position.relativeTo) : { x: 0, y: 0 };
    const point = { x: base.x + position.x, y: base.y + position.y };
    resolved.set(id, point);
    return point;
  };
  for (const id of focuses.keys()) resolve(id);
  return { plan: plan!, positions: resolved };
}

function withEnvironment(values: Record<string, string | undefined>): () => void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (entries: Record<string, string | undefined>): void => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  };
  apply(values);
  return () => apply(previous);
}

describe(
  engineBinary === undefined
    ? 'hoi4.focus_rewrite with the real focus layout engine (skipped: engine unavailable; run cargo build -p hoi4-engine-cli in engine/ or set HOI4_ENGINE)'
    : 'hoi4.focus_rewrite with the real focus layout engine',
  () => {
    let restore: (() => void) | undefined;
    beforeAll(() => {
      if (engineBinary !== undefined) restore = withEnvironment({ HOI4_ENGINE: engineBinary });
    });
    afterAll(() => restore?.());

    it.skipIf(engineBinary === undefined)(
      'lays out an automatic tree, writes anchors and is idempotent',
      async () => {
        const { client, sourcePath } = await fixture();
        const plan = treePlan(baseFocuses);
        const first = await rewrite(client, { plan, createIfMissing: true, layoutMode: 'engine' });
        expect(first.isError, JSON.stringify(first.structuredContent)).not.toBe(true);
        expect(first.structuredContent).toMatchObject({
          status: 'ok',
          code: 'FOCUS_CHANGES_APPLIED',
        });
        const data = first.structuredContent.data;
        expect(data.layoutQuality?.verdict).toMatch(/^(pass|review|revise|blocked)$/u);
        expect(data.engine).toMatchObject({ operation: 'layout' });
        expect(data.engine?.hashes.layout).toMatch(/^[0-9a-f]{64}$/u);
        expect(data.engine?.movedFocusCount).toBe(baseFocuses.length);

        const source = await readFile(sourcePath, 'utf8');
        expect(source).toContain('relative_position_id = eng_pol_start');
        const { plan: written, positions } = await writtenTree(sourcePath);
        expect(written.focuses.every(({ position }) => position.mode !== 'auto')).toBe(true);
        for (const spec of baseFocuses)
          for (const group of spec.needs ?? [])
            for (const parent of group)
              expect(positions.get(parent)!.y).toBeLessThan(positions.get(spec.id)!.y);
        const all = [...positions.entries()];
        for (const [leftId, left] of all)
          for (const [rightId, right] of all)
            if (leftId < rightId && left.y === right.y)
              expect(Math.abs(left.x - right.x), `${leftId} and ${rightId}`).toBeGreaterThanOrEqual(
                2,
              );

        // Again from the source alone, and again with the plan the inspect tool returns.
        const second = await rewrite(client, { treeId, layoutMode: 'engine' });
        expect(second.structuredContent).toMatchObject({
          status: 'ok',
          code: 'FOCUS_CHANGES_UNCHANGED',
        });
        expect(second.structuredContent.data.engine?.hashes.layout).toBe(
          data.engine?.hashes.layout,
        );
        const third = await rewrite(client, {
          plan: await inspectPlan(client),
          layoutMode: 'engine',
        });
        expect(third.structuredContent).toMatchObject({
          status: 'ok',
          code: 'FOCUS_CHANGES_UNCHANGED',
        });
        expect(await readFile(sourcePath, 'utf8')).toBe(source);
      },
    );

    it.skipIf(engineBinary === undefined)(
      'inserts new focuses and keeps every other focus where it was',
      async () => {
        const { client, sourcePath } = await fixture();
        const created = await rewrite(client, {
          plan: treePlan(baseFocuses),
          createIfMissing: true,
          layoutMode: 'engine',
        });
        expect(created.structuredContent.code).toBe('FOCUS_CHANGES_APPLIED');
        const before = await writtenTree(sourcePath);

        const plan = await inspectPlan(client);
        const additions = treePlan(insertedFocuses);
        plan.focuses = [...(plan.focuses as unknown[]), ...(additions.focuses as unknown[])];
        const inserted = await rewrite(client, {
          plan,
          placement: { focusIds: insertedFocuses.map(({ id }) => id), preferSide: 'right' },
        });
        expect(inserted.isError, JSON.stringify(inserted.structuredContent)).not.toBe(true);
        expect(inserted.structuredContent).toMatchObject({
          status: 'ok',
          code: 'FOCUS_CHANGES_APPLIED',
        });
        const engine = inserted.structuredContent.data.engine!;
        expect(engine.operation).toBe('insert');
        expect([...engine.movedFocusIds].sort()).toEqual(
          insertedFocuses.map(({ id }) => id).sort(),
        );
        const untouched = [...before.positions.entries()]
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([id, { x, y }]) => ({ id, x, y }));
        expect(engine.hashes.untouched).toBe(hashCanonical(untouched));
        expect(inserted.structuredContent.data.layoutQuality?.verdict).toBeDefined();
        expect(inserted.structuredContent.data.layoutDelta).toBeDefined();

        const after = await writtenTree(sourcePath);
        for (const [id, point] of before.positions) expect(after.positions.get(id)).toEqual(point);
        const start = after.positions.get('eng_ind_start')!;
        const added = after.positions.get('eng_ind_new')!;
        const added2 = after.positions.get('eng_ind_new_2')!;
        expect(added.y).toBeGreaterThan(start.y);
        expect(added2.y).toBeGreaterThan(added.y);
      },
    );

    it.skipIf(engineBinary === undefined)(
      'renders the PNG as the game view and names every asset it could not draw',
      async () => {
        const { client, mod } = await fixture();
        const created = await rewrite(client, {
          plan: treePlan(baseFocuses),
          createIfMissing: true,
          layoutMode: 'engine',
        });
        expect(created.structuredContent.code).toBe('FOCUS_CHANGES_APPLIED');
        const rendered = (await client.callTool({
          name: 'hoi4.focus_render',
          arguments: { workspaceId: 'engine', relativePath, treeId, inline: false },
        })) as unknown as {
          isError?: boolean;
          structuredContent: {
            status: string;
            code: string;
            data: { width: number; height: number };
            diagnostics: Array<{ code: string; details?: { name?: string; focusIds?: string[] } }>;
          };
        };
        expect(rendered.isError, JSON.stringify(rendered.structuredContent)).not.toBe(true);
        expect(rendered.structuredContent).toMatchObject({
          status: 'ok',
          code: 'FOCUS_RASTERIZED',
        });
        const codes = rendered.structuredContent.diagnostics.map(({ code }) => code);
        expect(codes).not.toContain('FOCUS_GAME_VIEW_UNAVAILABLE');
        // The fixture has no game folder, so the view's own sprites are missing, and each is named.
        const missing = rendered.structuredContent.diagnostics.filter(
          ({ code }) => code === 'FOCUS_GAME_VIEW_ASSET_MISSING',
        );
        expect(missing.map(({ details }) => details?.name)).toContain('GFX_focus_can_start');
        // The game view is drawn on the game's 96 by 130 grid, not the schematic's.
        const { width } = rendered.structuredContent.data;
        expect(width).toBeGreaterThan(0);
        const pngs = await findFiles(mod, (name) => name.endsWith('.focus.png'));
        expect(pngs.length).toBeGreaterThan(0);
      },
    );
  },
);

async function findFiles(root: string, accept: (name: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true }))
    if (entry.isFile() && accept(entry.name)) found.push(path.join(entry.parentPath, entry.name));
  return found;
}

describe('hoi4.focus_rewrite engine refusals', () => {
  it('refuses with FOCUS_ENGINE_UNAVAILABLE and writes nothing when the engine is missing', async () => {
    const { client, mod } = await fixture();
    const restore = withEnvironment({
      HOI4_ENGINE: path.join(mod, 'no-such-engine', 'hoi4-engine.exe'),
    });
    try {
      const result = await rewrite(client, {
        plan: treePlan(baseFocuses),
        createIfMissing: true,
        layoutMode: 'engine',
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: 'error',
        code: 'FOCUS_ENGINE_UNAVAILABLE',
      });
      expect(JSON.stringify(result.structuredContent)).toContain('HOI4_ENGINE');
    } finally {
      restore();
    }
    expect(await readdir(path.join(mod, 'common', 'national_focus'))).toEqual([]);
  });

  it('reports a blocked engine result with needsRoom and writes nothing', async () => {
    const { client, mod } = await fixture();
    const fake = await writeFakeEngine();
    cleanup.push(fake.cleanup);
    const restore = withEnvironment({ HOI4_ENGINE: fake.path, FAKE_ENGINE_MODE: 'blocked' });
    try {
      const result = await rewrite(client, {
        plan: treePlan(baseFocuses),
        createIfMissing: true,
        layoutMode: 'engine',
      });
      expect(result.structuredContent).toMatchObject({
        status: 'blocked',
        code: 'FOCUS_ENGINE_BLOCKED',
      });
      const message = result.structuredContent.blockers[0]?.message ?? '';
      expect(message).toContain('needsRoom: {"shift":[{"fromX":4,"columns":2');
      expect(message).toContain('FOCUS_ENGINE_NO_CORRIDOR');
      expect(message).toContain('placement.allowShift');
    } finally {
      restore();
    }
    expect(await readdir(path.join(mod, 'common', 'national_focus'))).toEqual([]);
  });

  it('rejects placement in compact mode and an anchor outside the placed focuses', async () => {
    const { client } = await fixture();
    const compact = await rewrite(client, {
      treeId,
      layoutMode: 'compact',
      placement: { focusIds: ['eng_ind_mil'] },
    });
    expect(compact.isError).toBe(true);
    expect(JSON.stringify(compact.structuredContent)).toContain(
      'placement requires authored or engine layout mode',
    );
    const anchor = await rewrite(client, {
      plan: treePlan(baseFocuses),
      layoutMode: 'engine',
      placement: { focusIds: ['eng_ind_mil'], anchorId: 'eng_ind_civ' },
    });
    expect(anchor.isError).toBe(true);
    expect(JSON.stringify(anchor.structuredContent)).toContain(
      'placement.anchorId must be one of placement.focusIds',
    );
  });
});
