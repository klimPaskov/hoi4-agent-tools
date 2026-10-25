import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

// Regression tests for the HOI4 Factory S01 EXP-02 findings 3 and 4. All fixtures are synthetic.

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

const relativePath = 'common/national_focus/guard_focus.txt';
const sidecarPath = 'common/national_focus/guard_focus.focus-plan.json';

const treeSource = `# guard tree
focus_tree = {
\tid = guard_tree
\tfocus = {
\t\tid = guard_a
\t\tx = 0
\t\ty = 0
\t\tcost = 5
\t}
\tfocus = {
\t\tid = guard_b
\t\tx = 2
\t\ty = 0
\t\tcost = 8
\t}
}
`;

function withBytes(before: string, bytes: number[], after: string): Buffer {
  return Buffer.concat([
    Buffer.from(before, 'latin1'),
    Buffer.from(bytes),
    Buffer.from(after, 'latin1'),
  ]);
}

async function fixture(source: Buffer | string) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-focus-guard-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const mod = path.join(root, 'mod');
  const sourcePath = path.join(mod, ...relativePath.split('/'));
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, source);
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
            name: 'Focus source guard fixture',
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
  const client = new Client({ name: 'focus-guard-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, engine, sourcePath, directory: path.dirname(sourcePath) };
}

async function inspectPlan(client: Client) {
  const inspected = await client.callTool({
    name: 'hoi4.focus_inspect',
    arguments: { workspaceId: 'test', relativePath, treeId: 'guard_tree' },
  });
  expect(inspected.isError).not.toBe(true);
  const artifacts = (inspected.structuredContent as { artifacts: Array<{ uri: string }> })
    .artifacts;
  const resource = await client.readResource({ uri: artifacts[0]!.uri });
  const content = resource.contents[0];
  if (content === undefined || !('text' in content)) throw new Error('Missing focus plan artifact');
  const plan = (JSON.parse(content.text) as { plans: Array<Record<string, unknown>> }).plans[0]!;
  return { inspected, plan };
}

function setCost(plan: Record<string, unknown>, id: string, cost: number): void {
  const focus = (plan.focuses as Array<Record<string, unknown>>).find((entry) => entry.id === id);
  if (focus === undefined) throw new Error(`Missing focus ${id}`);
  focus.cost = cost;
}

describe('focus rewrite source-preservation guards', () => {
  it('refuses a stale semantic edit instead of reverting another focus', async () => {
    const { client, engine, sourcePath, directory } = await fixture(treeSource);
    const { plan } = await inspectPlan(client);
    setCost(plan, 'guard_a', 6);
    const external = Buffer.from(treeSource.replace('cost = 8', 'cost = 9'));
    await writeFile(sourcePath, external);
    engine.invalidate('test');

    const result = await client.callTool({
      name: 'hoi4.focus_rewrite',
      arguments: { workspaceId: 'test', relativePath, plan },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        status: 'error',
        code: 'FOCUS_SOURCE_CHANGED_SINCE_PLAN',
      },
    });
    expect(await readFile(sourcePath)).toEqual(external);
    expect(await readdir(directory)).toEqual(['guard_focus.txt']);
  });

  it('accepts the same edit once the plan is re-imported from the current source', async () => {
    const { client, engine, sourcePath } = await fixture(treeSource);
    const stale = await inspectPlan(client);
    setCost(stale.plan, 'guard_a', 6);
    await writeFile(sourcePath, treeSource.replace('cost = 8', 'cost = 9'));
    engine.invalidate('test');
    const { plan } = await inspectPlan(client);
    setCost(plan, 'guard_a', 6);

    const result = await client.callTool({
      name: 'hoi4.focus_rewrite',
      arguments: { workspaceId: 'test', relativePath, plan },
    });
    expect(result.structuredContent).toMatchObject({
      status: 'ok',
      code: 'FOCUS_CHANGES_APPLIED',
    });
    expect(await readFile(sourcePath, 'utf8')).toBe(
      treeSource.replace('cost = 5', 'cost = 6').replace('cost = 8', 'cost = 9'),
    );
  });

  it('preserves a formatting-only external change while applying the planned edit', async () => {
    const { client, engine, sourcePath } = await fixture(treeSource);
    const { plan } = await inspectPlan(client);
    setCost(plan, 'guard_a', 6);
    await writeFile(sourcePath, treeSource.replace('# guard tree', '# guard tree, edited outside'));
    engine.invalidate('test');

    const result = await client.callTool({
      name: 'hoi4.focus_rewrite',
      arguments: { workspaceId: 'test', relativePath, plan },
    });
    expect(result.structuredContent).toMatchObject({ status: 'ok', code: 'FOCUS_CHANGES_APPLIED' });
    expect(await readFile(sourcePath, 'utf8')).toBe(
      treeSource
        .replace('# guard tree', '# guard tree, edited outside')
        .replace('cost = 5', 'cost = 6'),
    );
  });

  it.each([0x81, 0x8d, 0x8f, 0x90, 0x9d])(
    'reads a non-UTF-8 file containing byte %i with a warning and refuses to rewrite it',
    async (byte) => {
      const source = withBytes('# reward caf', [byte], treeSource.slice(treeSource.indexOf('\n')));
      const { client, sourcePath, directory } = await fixture(source);
      const { inspected, plan } = await inspectPlan(client);
      expect(JSON.stringify(inspected.structuredContent)).toContain(
        'SOURCE_ENCODING_NOT_ROUND_TRIPPABLE',
      );
      setCost(plan, 'guard_a', 6);

      const result = await client.callTool({
        name: 'hoi4.focus_rewrite',
        arguments: { workspaceId: 'test', relativePath, plan },
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          status: 'error',
          code: 'SOURCE_ENCODING_NOT_ROUND_TRIPPABLE',
        },
      });
      expect(JSON.stringify(result.content)).toContain(`0x${byte.toString(16).toUpperCase()}`);
      expect(await readFile(sourcePath)).toEqual(source);
      expect(await readdir(directory)).toEqual(['guard_focus.txt']);
    },
  );

  it('still edits valid Windows-1252 and leaves every other byte unchanged', async () => {
    const source = withBytes(
      '# reward caf',
      [0xe9, 0x80],
      treeSource.slice(treeSource.indexOf('\n')),
    );
    const { client, sourcePath } = await fixture(source);
    const { plan } = await inspectPlan(client);
    setCost(plan, 'guard_a', 6);

    const result = await client.callTool({
      name: 'hoi4.focus_rewrite',
      arguments: { workspaceId: 'test', relativePath, plan },
    });
    expect(result.structuredContent).toMatchObject({ status: 'ok', code: 'FOCUS_CHANGES_APPLIED' });
    const expected = Buffer.from(
      source.toString('latin1').replace('cost = 5', 'cost = 6'),
      'latin1',
    );
    expect(await readFile(sourcePath)).toEqual(expected);
    await expect(
      readFile(path.join(path.dirname(sourcePath), path.basename(sidecarPath))),
    ).resolves.toBeDefined();
  });
});
