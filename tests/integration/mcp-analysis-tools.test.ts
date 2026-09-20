import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, CreateTaskResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function connected() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-analysis-mcp-'));
  cleanup.push(() =>
    rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  );
  const mod = path.join(temporary, 'mod');
  const decisionFile = path.join(mod, 'common', 'decisions', 'policy.txt');
  const ideaFile = path.join(mod, 'common', 'ideas', 'policy.txt');
  await Promise.all([
    mkdir(path.dirname(decisionFile), { recursive: true }),
    mkdir(path.dirname(ideaFile), { recursive: true }),
  ]);
  const decisionSource =
    'policy = { fund = { available = { always = yes } cost = 10 complete_effect = { set_country_flag = funded } } linked = { available = { has_idea = rationing } } }';
  await Promise.all([
    writeFile(decisionFile, decisionSource),
    writeFile(ideaFile, 'ideas = { country = { rationing = {} } }'),
  ]);
  const engine = new CoreEngine(
    await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(temporary, 'state'),
        workspaces: [{ id: 'test', name: 'Analysis test', root: mod }],
      }),
    ),
  );
  const server = createMcpServer(engine);
  const client = new Client({ name: 'analysis-tool-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, decisionFile, decisionSource };
}

describe('public analysis tools', () => {
  it('returns ordinary impact evidence and a durable native decision task', async () => {
    const { client, decisionFile, decisionSource } = await connected();
    const listed = await client.listTools();
    for (const name of [
      'hoi4.impact_inspect',
      'hoi4.decision_inspect',
      'hoi4.mechanic_test',
      'hoi4.package_check',
      'hoi4.scenario_test',
    ])
      expect(listed.tools.find((tool) => tool.name === name)).toMatchObject({
        execution: { taskSupport: 'optional' },
        annotations: { readOnlyHint: true },
      });
    const impact = await client.callTool({
      name: 'hoi4.impact_inspect',
      arguments: { workspaceId: 'test', symbols: [{ kind: 'idea', id: 'rationing' }] },
    });
    expect(impact).toMatchObject({
      structuredContent: {
        code: 'IMPACT_ANALYZED',
        data: { directConsumers: 1, mode: 'inspect' },
      },
    });
    const created = await client.request(
      {
        method: 'tools/call',
        params: {
          name: 'hoi4.decision_inspect',
          arguments: {
            workspaceId: 'test',
            mode: 'inspect',
            id: 'fund',
            scenarios: [{ id: 'actor', actor: 'AAA', state: { political_power: 15 } }],
          },
        },
      },
      CreateTaskResultSchema,
      { task: {} },
    );
    await vi.waitFor(
      async () => {
        expect((await client.experimental.tasks.getTask(created.task.taskId)).status).toBe(
          'completed',
        );
      },
      { timeout: 30_000, interval: 100 },
    );
    const decision = await client.experimental.tasks.getTaskResult(
      created.task.taskId,
      CallToolResultSchema,
    );
    expect(decision).toMatchObject({
      structuredContent: { code: 'DECISION_ANALYZED', data: { mode: 'inspect', scenarios: 1 } },
    });
    expect(await readFile(decisionFile, 'utf8')).toBe(decisionSource);
  });

  it('runs mechanic, package, and suite tools through the ordinary MCP contract', async () => {
    const { client } = await connected();
    const mechanicCase = {
      id: 'fund-payment',
      scenario: { schemaVersion: '1.0', id: 'fund-payment', state: { political_power: 15 } },
      steps: [{ kind: 'effect', source: { kind: 'decision', id: 'fund' } }],
      assertions: [
        { id: 'paid-once', kind: 'single_payment', balance: { key: 'political_power' }, cost: 10 },
      ],
    };
    const mechanic = await client.callTool({
      name: 'hoi4.mechanic_test',
      arguments: { workspaceId: 'test', test: mechanicCase },
    });
    expect(mechanic).toMatchObject({
      structuredContent: {
        code: 'MECHANIC_TEST_PASSED',
        data: { status: 'passed', passed: 1 },
      },
    });
    const manifest = {
      schemaVersion: '1.0',
      id: 'policy',
      definitions: [
        { kind: 'decision', id: 'fund' },
        { kind: 'idea', id: 'rationing' },
      ],
    };
    const packageResult = await client.callTool({
      name: 'hoi4.package_check',
      arguments: { workspaceId: 'test', manifest },
    });
    expect(packageResult).toMatchObject({
      structuredContent: {
        code: 'PACKAGE_CHECK_PASSED',
        data: { complete: true, present: 2 },
      },
    });
    const suite = await client.callTool({
      name: 'hoi4.scenario_test',
      arguments: {
        workspaceId: 'test',
        suite: {
          schemaVersion: '1.0',
          id: 'policy-suite',
          cases: [
            { id: 'payment', domain: 'mechanic', test: mechanicCase },
            { id: 'connections', domain: 'package', manifest },
          ],
        },
        maxCases: 2,
      },
    });
    expect(suite).toMatchObject({
      structuredContent: {
        code: 'SCENARIO_SUITE_PASSED',
        data: { completed: 2, pending: 0, failed: 0, unresolved: 0 },
      },
    });
  });
});
