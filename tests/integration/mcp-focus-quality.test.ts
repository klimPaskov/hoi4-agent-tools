import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';
import {
  staircaseTree,
  symmetricLanes,
  TWIN_LANES,
  type FixtureFocus,
} from '../helpers/focus-quality-fixture.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

/** The Clausewitz source of a hand-typed tree: every focus carries a fixed x and y. */
function sourceOf(treeId: string, specs: readonly FixtureFocus[]): string {
  const focuses = specs.map((spec) => {
    const needs = (spec.needs ?? [])
      .map((entry) => {
        const ids = Array.isArray(entry) ? entry : [entry];
        return `\t\tprerequisite = { ${ids.map((id) => `focus = ${id}`).join(' ')} }\n`;
      })
      .join('');
    const exclusive =
      spec.exclusive === undefined || spec.exclusive.length === 0
        ? ''
        : `\t\tmutually_exclusive = { ${spec.exclusive.map((id) => `focus = ${id}`).join(' ')} }\n`;
    return `\tfocus = {\n\t\tid = ${spec.id}\n\t\tx = ${String(spec.x)}\n\t\ty = ${String(spec.y)}\n${needs}${exclusive}\t\tcost = 5\n\t\tcompletion_reward = { add_political_power = 25 }\n\t}\n`;
  });
  return `focus_tree = {\n\tid = ${treeId}\n${focuses.join('')}}\n`;
}

async function fixture(trees: Record<string, readonly FixtureFocus[]>) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-focus-quality-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const mod = path.join(root, 'mod');
  await mkdir(path.join(mod, 'common', 'national_focus'), { recursive: true });
  for (const [treeId, specs] of Object.entries(trees))
    await writeFile(
      path.join(mod, 'common', 'national_focus', `${treeId}.txt`),
      sourceOf(treeId, specs),
    );
  const runtimeRoot = path.join(root, 'runtime');
  const engine = new CoreEngine(
    await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        storageRoots: [runtimeRoot],
        workspaces: [
          {
            id: 'test',
            name: 'Focus quality fixture',
            root: mod,
            artifactRoot: path.join(runtimeRoot, 'artifacts'),
            cacheRoot: path.join(runtimeRoot, 'cache'),
          },
        ],
      }),
    ),
  );
  await engine.initialize();
  const server = createMcpServer(engine);
  const client = new Client({ name: 'focus-quality-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, mod };
}

interface QualityOutputData {
  verdict: string;
  scorecard: Array<{ status: string; fix?: { suggested: string } }>;
  nextActions: string[];
  notEvaluated: string[];
}

interface TreeData {
  layoutQuality: QualityOutputData;
  layoutDelta?: Record<string, unknown>;
}

interface ToolPayload {
  layoutVerdict?: string;
  treeCount: number;
  trees: TreeData[];
  layoutQuality: QualityOutputData;
  layoutDelta?: Record<string, unknown>;
  compactOutcome?: Record<string, unknown>;
  inlineImages?: Array<{ kind: string; label: string; focusIds: string[] }>;
}

interface ToolData {
  status: string;
  code: string;
  data: ToolPayload;
  diagnostics: Array<{ code: string; severity: string; message: string }>;
  validation: { passed: boolean; checks: Array<{ id: string; passed: boolean; message: string }> };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: { workspaceId: 'test', ...args } });
  return {
    structured: result.structuredContent as unknown as ToolData,
    content: result.content as Array<{
      type: string;
      data?: string;
      mimeType?: string;
      text?: string;
    }>,
  };
}

const relative = (treeId: string): string => `common/national_focus/${treeId}.txt`;

describe('focus layout quality through the MCP tools', () => {
  it('turns "structure ok" into a layout verdict a hand-typed staircase cannot pass', async () => {
    const { client } = await fixture({ stair_tree: staircaseTree(45) });
    const { structured } = await call(client, 'hoi4.focus_inspect', {
      relativePath: relative('stair_tree'),
      treeId: 'stair_tree',
    });
    expect(structured.status).toBe('ok');
    expect(structured.data.layoutVerdict).toBe('revise');
    const tree = structured.data.trees[0]!;
    expect(tree.layoutQuality.verdict).toBe('revise');
    expect(tree.layoutQuality.scorecard.length).toBeLessThanOrEqual(12);
    expect(tree.layoutQuality.scorecard[0]).toMatchObject({ status: 'revise' });
    expect(tree.layoutQuality.scorecard[0]!.fix!.suggested).toMatch(/\w+/u);
    expect(tree.layoutQuality.nextActions.join(' ')).toMatch(
      /not finished while the verdict is revise/u,
    );
    expect(tree.layoutQuality.notEvaluated.join(' ')).toMatch(/visual review/u);
    // The structural answer is unchanged and the layout answer sits beside it.
    const checks = Object.fromEntries(structured.validation.checks.map((c) => [c.id, c]));
    expect(checks['focus-diagnostics']!.message).toMatch(/not a layout verdict/u);
    expect(checks['focus-layout-verdict']).toMatchObject({ passed: false });
    expect(checks['focus-layout-verdict']!.message).toMatch(/layout verdict: revise/u);
    const codes = structured.diagnostics.map(({ code }) => code);
    expect(codes).toContain('FOCUS_LAYOUT_VERDICT_REVISE');
    expect(codes).not.toContain('FOCUS_LAYOUT_CONNECTOR_CROSSING_UNSATISFIED');
    expect(codes).not.toContain('FOCUS_AVOIDABLE_CONNECTOR_CROSSING');
  });

  it('reports a tidy tree as pass and a previous layout as a delta', async () => {
    const { client } = await fixture({ twin_tree: TWIN_LANES });
    const first = await call(client, 'hoi4.focus_inspect', {
      relativePath: relative('twin_tree'),
      treeId: 'twin_tree',
    });
    expect(first.structured.data.layoutVerdict).toBe('pass');
    const tree = first.structured.data.trees[0]!;
    expect(tree.layoutDelta).toBeUndefined();
    const layout = { treeId: 'twin_tree', nodes: [] as unknown[], decisions: [], diagnostics: [] };
    layout.nodes = TWIN_LANES.map(({ id, x, y }) => ({
      id,
      x: x + (id === 'a2' ? 4 : 0),
      y,
      laneId: 'default',
      preserved: true,
      sourceMode: 'fixed',
    }));
    const again = await call(client, 'hoi4.focus_inspect', {
      relativePath: relative('twin_tree'),
      treeId: 'twin_tree',
      previous: { ...layout, layoutHash: 'a'.repeat(64) },
    });
    const delta = again.structured.data.trees[0]!.layoutDelta;
    expect(delta).toMatchObject({
      verdictAfter: 'pass',
      movedFocusCount: 1,
      movedFocusIds: ['a2'],
      prerequisitesUnchanged: true,
    });
  });

  it('returns the render inline: an overview and the worst places, without a second call', async () => {
    const { client } = await fixture({ stair_tree: staircaseTree(45) });
    const { structured, content } = await call(client, 'hoi4.focus_render', {
      relativePath: relative('stair_tree'),
      treeId: 'stair_tree',
      png: false,
    });
    const images = content.filter(({ type }) => type === 'image');
    expect(images.length).toBeGreaterThanOrEqual(2);
    expect(images.length).toBeLessThanOrEqual(6);
    for (const image of images) {
      expect(image.mimeType).toBe('image/png');
      const bytes = Buffer.from(image.data!, 'base64');
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(bytes.length).toBeLessThan(900_000);
    }
    const described = structured.data.inlineImages as Array<{ kind: string; label: string }>;
    expect(described).toHaveLength(images.length);
    expect(described[0]).toMatchObject({ kind: 'overview' });
    expect(described.slice(1).every(({ kind }) => kind === 'problem')).toBe(true);
    expect(structured.data.layoutQuality.verdict).toBe('revise');
    // The structured result stays small even though the images travel with it.
    expect(JSON.stringify(structured).length).toBeLessThan(32_768);
    expect(content.find(({ type }) => type === 'text')?.text).toContain('"inlineImages"');
  });

  it('crops named branches, reports an unknown one, and can be told to skip the images', async () => {
    const { client } = await fixture({ lanes_tree: symmetricLanes(11, 4) });
    const crops = await call(client, 'hoi4.focus_render', {
      relativePath: relative('lanes_tree'),
      treeId: 'lanes_tree',
      png: false,
      cropBranchIds: ['lane_2_1', 'no_such_branch'],
    });
    const described = crops.structured.data.inlineImages as Array<{
      kind: string;
      label: string;
      focusIds: string[];
    }>;
    expect(described.map(({ kind }) => kind)).toEqual(['overview', 'branch']);
    expect(described[1]!.label).toBe('branch lane_2_1');
    expect(described[1]!.focusIds).toEqual(expect.arrayContaining(['lane_2_1', 'lane_2_4']));
    expect(crops.structured.diagnostics.map(({ code }) => code)).toContain(
      'FOCUS_CROP_BRANCH_UNKNOWN',
    );
    const quiet = await call(client, 'hoi4.focus_render', {
      relativePath: relative('lanes_tree'),
      treeId: 'lanes_tree',
      png: false,
      inline: false,
    });
    expect(quiet.content.some(({ type }) => type === 'image')).toBe(false);
    expect(quiet.structured.data.inlineImages).toBeUndefined();
  });

  it('keeps many trees in one inspection inside the response budget', async () => {
    const trees: Record<string, readonly FixtureFocus[]> = {};
    for (let index = 0; index < 8; index += 1) trees[`tree_${String(index)}`] = TWIN_LANES;
    const { client } = await fixture(trees);
    const { structured } = await call(client, 'hoi4.focus_inspect', {});
    expect(structured.data.treeCount).toBe(8);
    for (const tree of structured.data.trees) {
      expect(tree.layoutQuality.scorecard).toEqual([]);
      expect(tree.layoutQuality.verdict).toBe('pass');
    }
    expect(
      structured.validation.checks.find(({ id }) => id === 'focus-layout-verdict')?.message,
    ).toMatch(/layout verdicts: tree_0 pass/u);
  });

  it('says so, and leaves the source alone, when a repair has nothing to improve', async () => {
    const { client, mod } = await fixture({ twin_tree: TWIN_LANES });
    const file = path.join(mod, 'common', 'national_focus', 'twin_tree.txt');
    const before = await readFile(file);
    const arguments_ = {
      relativePath: relative('twin_tree'),
      treeId: 'twin_tree',
      layoutMode: 'compact',
    };
    // The first rewrite of a tree also writes its planning sidecar; the source is not touched.
    const first = await call(client, 'hoi4.focus_rewrite', arguments_);
    expect(first.structured.data.compactOutcome).toEqual({
      outcome: 'nothing_to_improve',
      reason: 'verdict_pass',
      blockedBy: [],
    });
    expect((await readFile(file)).equals(before)).toBe(true);
    const { structured } = await call(client, 'hoi4.focus_rewrite', arguments_);
    expect(structured.code).toBe('FOCUS_CHANGES_UNCHANGED');
    expect(structured.diagnostics.map(({ code }) => code)).toContain(
      'FOCUS_COMPACT_NOTHING_TO_IMPROVE',
    );
    expect(structured.data.layoutQuality.verdict).toBe('pass');
    expect(structured.data.layoutDelta).toMatchObject({
      verdictBefore: 'pass',
      verdictAfter: 'pass',
      movedFocusCount: 0,
      prerequisitesUnchanged: true,
      mutualExclusionsUnchanged: true,
    });
    expect(structured.validation.checks.some(({ id }) => id === 'focus-layout-verdict')).toBe(true);
    expect((await readFile(file)).equals(before)).toBe(true);
  });
});
