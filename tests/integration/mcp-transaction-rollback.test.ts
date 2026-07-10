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
import { operationResultSchema } from '../../src/hoi4_agent_tools/mcp/server/result.js';

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const callback of cleanup.splice(0)) await callback();
});

const focusRelativePath = 'common/national_focus/fixture.txt';
const originalFocusBytes = Buffer.from(
  [
    '\ufefffocus_tree = {',
    '\tid = fixture_focus',
    '\tcountry = {',
    '\t\tfactor = 0',
    '\t}',
    '\tfocus = {',
    '\t\tid = fixture_start',
    '\t\tx = 0',
    '\t\ty = 0',
    '\t\tcost = 10',
    '\t}',
    '}',
    '',
  ].join('\r\n'),
  'utf8',
);

async function connectedWorkspace(): Promise<{
  client: Client;
  engine: CoreEngine;
  focusPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-mcp-transaction-'));
  const mod = path.join(root, 'mod');
  const focusPath = path.join(mod, focusRelativePath);
  await mkdir(path.dirname(focusPath), { recursive: true });
  await writeFile(focusPath, originalFocusBytes);
  const config = serverConfigurationSchema.parse({
    version: 1,
    writePolicy: 'transactions',
    serverStateRoot: path.join(root, 'server-state'),
    transactionTtlSeconds: 3600,
    workspaces: [{ id: 'test', name: 'Synthetic transaction test', root: mod, writeEnabled: true }],
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(config));
  const server = createMcpServer(engine);
  const client = new Client({ name: 'transaction-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(
    async () => client.close(),
    async () => server.close(),
    async () => rm(root, { recursive: true, force: true }),
  );
  return { client, engine, focusPath };
}

async function planInvalidFocus(engine: CoreEngine) {
  return engine.transactions.plan({
    workspaceId: 'test',
    operationKind: 'focus-plan-changes',
    operations: [
      {
        id: 'make-invalid-focus',
        kind: 'test-only-source-replacement',
        summary: 'Replace synthetic focus source with malformed bytes',
        data: {},
      },
    ],
    changes: [
      {
        relativePath: focusRelativePath,
        content: Buffer.from('focus_tree = { id = "unterminated', 'utf8'),
        operationIds: ['make-invalid-focus'],
      },
    ],
    validate: () =>
      Promise.resolve({
        diagnostics: [],
        checks: [{ id: 'synthetic-dry-run', passed: true, message: 'Dry run approved for test' }],
      }),
  });
}

describe('MCP transaction apply rollback', () => {
  it('returns the failed state and restores exact bytes after focus post-validation fails', async () => {
    const { client, engine, focusPath } = await connectedWorkspace();
    const plan = await planInvalidFocus(engine);

    expect(plan.validation.passed).toBe(true);
    expect(await readFile(focusPath)).toEqual(originalFocusBytes);

    const response = await client.callTool({
      name: 'hoi4.transaction_apply',
      arguments: {
        workspaceId: 'test',
        transactionId: plan.transactionId,
        expectedPlanHash: plan.planHash,
      },
    });

    expect(response.isError).toBe(true);
    const result = operationResultSchema.parse(response.structuredContent);
    expect(result).toMatchObject({
      status: 'error',
      code: 'TRANSACTION_POST_VALIDATION_FAILED',
      workspaceId: 'test',
      transactionId: plan.transactionId,
      planHash: plan.planHash,
      proposedFiles: [focusRelativePath],
      changedFiles: [],
      validation: { passed: false },
      rollbackStatus: 'applied',
      data: {
        state: 'rolled_back',
        failure: {
          code: 'TRANSACTION_POST_VALIDATION_FAILED',
          message: 'Transaction apply failed',
        },
      },
    });
    expect(
      result.validation.checks.find(({ id }) => id === 'post-write-shared-index'),
    ).toMatchObject({ passed: false });
    expect(result.validation.checks.find(({ id }) => id === 'post-write-focus')).toMatchObject({
      passed: false,
    });
    expect(await readFile(focusPath)).toEqual(originalFocusBytes);
    const failedManifest = await engine.transactions.status('test', plan.transactionId);
    expect(failedManifest).toMatchObject({
      state: 'rolled_back',
      appliedFiles: [focusRelativePath],
      rollbackStatus: 'applied',
      failure: { code: 'TRANSACTION_POST_VALIDATION_FAILED' },
    });
    expect(
      failedManifest.diagnostics.some(
        ({ code, severity }) => code === 'SOURCE_UNTERMINATED_STRING' && severity === 'error',
      ),
    ).toBe(true);
  });

  it('requires strict transaction arguments and the exact planned hash', async () => {
    const { client, engine, focusPath } = await connectedWorkspace();
    const plan = await planInvalidFocus(engine);

    const missingTransaction = await client.callTool({
      name: 'hoi4.transaction_apply',
      arguments: { workspaceId: 'test', expectedPlanHash: plan.planHash },
    });
    expect(missingTransaction.isError).toBe(true);
    expect(JSON.stringify(missingTransaction.content)).toMatch(/transactionId/iu);
    const missingHash = await client.callTool({
      name: 'hoi4.transaction_apply',
      arguments: { workspaceId: 'test', transactionId: plan.transactionId },
    });
    expect(missingHash.isError).toBe(true);
    expect(JSON.stringify(missingHash.content)).toMatch(/expectedPlanHash/iu);
    const unexpectedArgument = await client.callTool({
      name: 'hoi4.transaction_apply',
      arguments: {
        workspaceId: 'test',
        transactionId: plan.transactionId,
        expectedPlanHash: plan.planHash,
        unexpected: true,
      },
    });
    expect(unexpectedArgument.isError).toBe(true);
    expect(JSON.stringify(unexpectedArgument.content)).toMatch(/unrecognized|unexpected/iu);

    const reflectedIdentifier = 'x'.repeat(10_000);
    const invalidStatus = await client.callTool({
      name: 'hoi4.transaction_status',
      arguments: { workspaceId: 'test', transactionId: reflectedIdentifier },
    });
    expect(invalidStatus.isError).toBe(true);
    expect(JSON.stringify(invalidStatus.content)).not.toContain('x'.repeat(256));
    const malformedHash = await client.callTool({
      name: 'hoi4.transaction_apply',
      arguments: {
        workspaceId: 'test',
        transactionId: plan.transactionId,
        expectedPlanHash: 'z'.repeat(64),
      },
    });
    expect(malformedHash.isError).toBe(true);

    const wrongHash = await client.callTool({
      name: 'hoi4.transaction_apply',
      arguments: {
        workspaceId: 'test',
        transactionId: plan.transactionId,
        expectedPlanHash: '0'.repeat(64),
      },
    });
    expect(wrongHash.isError).toBe(true);
    expect(operationResultSchema.parse(wrongHash.structuredContent)).toMatchObject({
      status: 'error',
      code: 'TRANSACTION_PLAN_HASH_MISMATCH',
      transactionId: plan.transactionId,
      planHash: plan.planHash,
      changedFiles: [],
      rollbackStatus: 'available',
      data: { state: 'planned', failure: null },
    });
    expect(await readFile(focusPath)).toEqual(originalFocusBytes);
    await expect(engine.transactions.status('test', plan.transactionId)).resolves.toMatchObject({
      state: 'planned',
      appliedFiles: [],
      rollbackStatus: 'available',
    });
  });

  it('reports a successful apply compactly when complete review metadata exceeds the wire budget', async () => {
    const { client, engine, focusPath } = await connectedWorkspace();
    const reviewArtifacts = Array.from({ length: 511 }, (_, index) => ({
      uri: `hoi4-agent://workspace/test/artifact/${index.toString(16).padStart(64, '0')}/${'a'.repeat(64)}/review-${index}.json`,
      name: `review-${index}.json`,
      mimeType: 'application/json',
      description: 'r'.repeat(1_024),
    }));
    const plan = await engine.transactions.plan({
      workspaceId: 'test',
      operationKind: 'test-valid-source-change',
      operations: [
        {
          id: 'bounded-apply-result',
          kind: 'test-only-source-replacement',
          summary: 'Exercise compact applied-transaction output',
          data: {},
        },
      ],
      changes: [
        {
          relativePath: focusRelativePath,
          content: Buffer.concat([originalFocusBytes, Buffer.from('# bounded output\r\n', 'utf8')]),
          operationIds: ['bounded-apply-result'],
        },
      ],
      artifacts: reviewArtifacts,
      validate: () =>
        Promise.resolve({
          diagnostics: [],
          checks: [{ id: 'synthetic-dry-run', passed: true, message: 'Source remains valid' }],
        }),
    });

    let cursor: string | undefined;
    let firstCursor: string | undefined;
    let reviewedArtifacts = 0;
    let pages = 0;
    do {
      const reviewed = await client.callTool({
        name: 'hoi4.transaction_diff',
        arguments: {
          workspaceId: 'test',
          transactionId: plan.transactionId,
          ...(cursor === undefined ? {} : { cursor }),
        },
      });
      expect(reviewed.structuredContent).toMatchObject({
        status: 'ok',
        code: 'TRANSACTION_DIFF',
      });
      const data = (reviewed.structuredContent as { data: Record<string, unknown> }).data as {
        returnedArtifacts: number;
        nextCursor?: string;
      };
      reviewedArtifacts += data.returnedArtifacts;
      pages += 1;
      cursor = data.nextCursor;
      firstCursor ??= cursor;
    } while (cursor !== undefined);
    expect(reviewedArtifacts).toBe(512);
    expect(pages).toBeGreaterThan(20);

    const secondPlan = await engine.transactions.plan({
      workspaceId: 'test',
      operationKind: 'test-valid-source-change',
      operations: [
        {
          id: 'second-plan',
          kind: 'test-only-source-replacement',
          summary: 'Create another immutable cursor binding',
          data: {},
        },
      ],
      changes: [
        {
          relativePath: focusRelativePath,
          content: Buffer.concat([originalFocusBytes, Buffer.from('# second plan\r\n', 'utf8')]),
          operationIds: ['second-plan'],
        },
      ],
      validate: () =>
        Promise.resolve({
          diagnostics: [],
          checks: [{ id: 'synthetic-dry-run', passed: true, message: 'Source remains valid' }],
        }),
    });
    const stale = await client.callTool({
      name: 'hoi4.transaction_diff',
      arguments: {
        workspaceId: 'test',
        transactionId: secondPlan.transactionId,
        cursor: firstCursor,
      },
    });
    expect(stale.structuredContent).toMatchObject({
      status: 'error',
      code: 'TRANSACTION_CURSOR_STALE',
    });

    const applied = await client.callTool({
      name: 'hoi4.transaction_apply',
      arguments: {
        workspaceId: 'test',
        transactionId: plan.transactionId,
        expectedPlanHash: plan.planHash,
      },
    });
    expect(applied.structuredContent).toMatchObject({
      status: 'ok',
      code: 'TRANSACTION_APPLIED',
      artifacts: [{ name: `${plan.transactionId}.manifest.json` }],
      data: { state: 'applied', artifactCount: 512 },
    });
    expect(JSON.stringify(applied)).not.toContain('MCP_RESPONSE_LIMIT');
    expect(Buffer.byteLength(JSON.stringify(applied), 'utf8')).toBeLessThan(500_000);

    const link = (applied.structuredContent as { artifacts: Array<{ uri: string }> }).artifacts[0]!;
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const uri = new URL(link.uri);
      if (offset > 0) uri.searchParams.set('offset', String(offset));
      const resource = await client.readResource({ uri: uri.href });
      const content = resource.contents[0];
      if (content === undefined) throw new Error('missing transaction manifest chunk');
      const bytes =
        'text' in content ? Buffer.from(content.text, 'utf8') : Buffer.from(content.blob, 'base64');
      chunks.push(bytes);
      offset += bytes.length;
      if (bytes.length < 1_048_576) break;
    }
    const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      transactionId: string;
      artifacts: unknown[];
    };
    expect(manifest.transactionId).toBe(plan.transactionId);
    expect(manifest.artifacts).toHaveLength(512);
    expect(await readFile(focusPath)).not.toEqual(originalFocusBytes);
  });
});
