import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createMcpHandler,
  InMemoryTransport,
  type JSONRPCMessage,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport as LegacyInMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolResultSchema as LegacyCallToolResultSchema,
  CreateTaskResultSchema as LegacyCreateTaskResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { JobService } from '../../src/hoi4_agent_tools/core/job-service.js';
import { SharedRequestCapacity } from '../../src/hoi4_agent_tools/core/shared-request-capacity.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  OperationTaskService,
  operationTaskId,
} from '../../src/hoi4_agent_tools/core/operation-tasks.js';
import { canonicalJson, hashCanonical } from '../../src/hoi4_agent_tools/core/canonical.js';
import {
  createMcpServer,
  SERVER_INSTRUCTIONS,
} from '../../src/hoi4_agent_tools/mcp/server/create.js';
import { createModernOperationServer } from '../../src/hoi4_agent_tools/mcp/server/create-modern-operations.js';
import { TASKS_EXTENSION } from '../../src/hoi4_agent_tools/mcp/server/modern-tasks.js';
import { MODERN_TASK_ROUTES } from '../../src/hoi4_agent_tools/mcp/transports/modern-task-routing.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const action of cleanup.splice(0).reverse()) await action();
});
const capabilities = { extensions: { [TASKS_EXTENSION]: {} } };
const responseSchema = z
  .object({
    id: z.union([z.number(), z.string(), z.null()]),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z.object({ code: z.number(), message: z.string() }).loose().optional(),
  })
  .loose();
type Response = z.infer<typeof responseSchema>;
type Mode = 'stdio' | 'http';
interface Wire {
  request(
    method: string,
    params?: Record<string, unknown>,
    caps?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<Response>;
  close(): Promise<void>;
}

function result(response: Response): Record<string, unknown> {
  expect(response.error).toBeUndefined();
  expect(response.result).toBeDefined();
  return response.result!;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-modern-task-'));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta');
  const source = path.join(alpha, 'events', 'synthetic.txt');
  await mkdir(path.dirname(source), { recursive: true });
  await mkdir(beta);
  await writeFile(
    source,
    'add_namespace = modern\ncountry_event = { id = modern.1 is_triggered_only = yes option = { name = modern.1.a } }\n',
  );
  const engine = new CoreEngine(
    await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        maxSharedTools: 1,
        workspaces: [
          { id: 'alpha', name: 'Alpha', root: alpha },
          { id: 'beta', name: 'Beta', root: beta },
        ],
        http: {
          tokens: [
            {
              principal: 'alpha-user',
              tokenEnv: 'HOI4_MODERN_TEST_ALPHA',
              workspaceIds: ['alpha'],
            },
            {
              principal: 'beta-user',
              tokenEnv: 'HOI4_MODERN_TEST_BETA',
              workspaceIds: ['alpha', 'beta'],
            },
            {
              principal: 'gamma-user',
              tokenEnv: 'HOI4_MODERN_TEST_GAMMA',
              workspaceIds: ['beta'],
            },
          ],
        },
      }),
    ),
  );
  const jobs = await JobService.create(engine.resolver);
  const connect = async (
    mode: Mode,
    principal = 'alpha-user',
    scopes = ['hoi4:read', 'hoi4:write'],
  ): Promise<Wire> => {
    let id = 0;
    let send: (message: JSONRPCMessage, headers?: Record<string, string>) => Promise<Response>;
    let close: () => Promise<void>;
    if (mode === 'stdio') {
      const [client, transport] = InMemoryTransport.createLinkedPair();
      const pending = new Map<number | string, (response: Response) => void>();
      client.onmessage = (message) => {
        if ('id' in message && message.id !== undefined)
          pending.get(message.id)?.(responseSchema.parse(message));
      };
      const handle = serveStdio(() => createModernOperationServer(engine, { principal, scopes }), {
        transport,
        legacy: 'reject',
      });
      await client.start();
      send = async (message) => {
        if (!('id' in message) || message.id === undefined)
          throw new Error('Test requests need an id');
        const requestId = message.id;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const response = new Promise<Response>((resolve, reject) => {
          pending.set(requestId, resolve);
          timer = setTimeout(() => reject(new Error('Test wire response timed out')), 60_000);
        });
        try {
          await client.send(message);
          return await response;
        } finally {
          clearTimeout(timer);
          pending.delete(requestId);
        }
      };
      close = async () => {
        await client.close();
        await handle.close();
      };
    } else {
      const handler = createMcpHandler(
        () => createModernOperationServer(engine, { principal, scopes }),
        { legacy: 'reject', responseMode: 'json' },
      );
      send = async (message, overrides = {}) => {
        if (!('method' in message)) throw new Error('Test requests need a method');
        const params = message.params as Record<string, unknown> | undefined;
        const name = message.method.startsWith('tasks/')
          ? params?.taskId
          : message.method === 'resources/read'
            ? params?.uri
            : params?.name;
        const response = await handler.fetch(
          new Request('http://localhost/mcp', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              'mcp-protocol-version': '2026-07-28',
              'mcp-method': message.method,
              ...(typeof name === 'string' ? { 'mcp-name': name } : {}),
              ...overrides,
            },
            body: JSON.stringify(message),
          }),
        );
        return responseSchema.parse(await response.json());
      };
      close = () => Promise.resolve();
    }
    cleanup.push(close);
    const wire: Wire = {
      close,
      request: (method, params = {}, caps = capabilities, headers) =>
        send(
          {
            jsonrpc: '2.0',
            id: ++id,
            method,
            params: {
              ...params,
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'modern-task-test',
                  version: '1.0.0',
                },
                'io.modelcontextprotocol/clientCapabilities': caps,
              },
            },
          },
          headers,
        ),
    };
    expect(result(await wire.request('server/discover'))).toMatchObject({
      supportedVersions: ['2026-07-28'],
      capabilities: { extensions: capabilities.extensions },
      instructions: SERVER_INSTRUCTIONS,
    });
    return wire;
  };
  return { root, alpha, source, engine, jobs, connect };
}

async function terminal(wire: Wire, taskId: string, status = 'completed') {
  let state: Record<string, unknown> = {};
  await vi.waitFor(
    async () => {
      state = result(await wire.request('tasks/get', { taskId }));
      expect(state.status).toBe(status);
    },
    { timeout: 20_000, interval: 50 },
  );
  return state;
}

async function officialClient(engine: CoreEngine, mode: Mode) {
  const client = new Client(
    { name: 'modern-progress-proof', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const exchanges: Array<{ method: string | null; contentType: string | null }> = [];
  const factory = () => createModernOperationServer(engine, { principal: 'alpha-user' });
  if (mode === 'stdio') {
    const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(factory, { transport: serverTransport, legacy: 'reject' });
    cleanup.push(async () => {
      await client.close();
      await handle.close();
    });
    await client.connect(transport);
  } else {
    const handler = createMcpHandler(factory, { legacy: 'reject', responseMode: 'auto' });
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const response = await handler.fetch(request);
        exchanges.push({
          method: request.headers.get('mcp-method'),
          contentType: response.headers.get('content-type'),
        });
        return response;
      },
    });
    cleanup.push(() => client.close());
    await client.connect(transport);
  }
  return { client, exchanges };
}

async function holdExecutionCapacity(engine: CoreEngine): Promise<() => Promise<void>> {
  let ready!: () => void;
  let release!: () => void;
  const admitted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const capacity = engine.sharedRequests.run(new AbortController().signal, () => {
    ready();
    return held;
  });
  await admitted;
  return async () => {
    release();
    await capacity;
  };
}

describe.each<Mode>(['stdio', 'http'])('2026-07-28 tasks over %s serving', (mode) => {
  it('serves impact and decision analysis through ordinary and native task calls', async () => {
    const { connect } = await fixture();
    const wire = await connect(mode);
    const listed = result(await wire.request('tools/list'));
    const tools = z.array(z.object({ name: z.string() }).loose()).parse(listed.tools);
    expect(tools.map(({ name }) => name)).toContain('hoi4.impact_inspect');
    expect(tools.map(({ name }) => name)).toContain('hoi4.decision_inspect');
    const impact = result(
      await wire.request(
        'tools/call',
        {
          name: 'hoi4.impact_inspect',
          arguments: { workspaceId: 'alpha', symbols: [{ kind: 'event', id: 'modern.1' }] },
        },
        {},
      ),
    );
    expect(impact).toMatchObject({
      resultType: 'complete',
      structuredContent: { code: 'IMPACT_ANALYZED' },
    });
    const created = result(
      await wire.request(
        'tools/call',
        { name: 'hoi4.decision_inspect', arguments: { workspaceId: 'alpha' } },
        capabilities,
      ),
    );
    expect(created.resultType).toBe('task');
    expect((await terminal(wire, z.string().parse(created.taskId))).result).toMatchObject({
      structuredContent: { code: 'DECISION_ANALYZED', data: { mode: 'inventory' } },
    });
  });

  it('keeps new analysis tools within the authenticated workspace', async () => {
    const { connect } = await fixture();
    const wire = await connect(mode, 'alpha-user');
    for (const name of ['hoi4.impact_inspect', 'hoi4.decision_inspect']) {
      const denied = result(
        await wire.request(
          'tools/call',
          {
            name,
            arguments: {
              workspaceId: 'beta',
              ...(name === 'hoi4.impact_inspect'
                ? { symbols: [{ kind: 'event', id: 'modern.1' }] }
                : {}),
            },
          },
          {},
        ),
      );
      expect(denied).toMatchObject({
        isError: true,
        structuredContent: { code: 'WORKSPACE_INACCESSIBLE' },
      });
    }
  });

  it('delivers requested progress before work finishes and leaves silent calls unstreamed', async () => {
    const { engine } = await fixture();
    const { client, exchanges } = await officialClient(engine, mode);
    const release = await holdExecutionCapacity(engine);
    const updates: Array<{
      progress: number;
      total?: number | undefined;
      message?: string | undefined;
    }> = [];
    let settled = false;
    const request = {
      name: 'hoi4.event_inspect',
      arguments: { workspaceId: 'alpha', mode: 'roots' },
    };
    const outcome = client.callTool(request, { onprogress: (update) => updates.push(update) }).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    try {
      await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0), { timeout: 5000 });
      expect(settled).toBe(false);
      expect(updates[0]).toMatchObject({
        progress: 0,
        message: 'Waiting for server execution capacity',
      });
    } finally {
      await release();
    }
    expect(await outcome).toMatchObject({ value: { structuredContent: { status: 'ok' } } });
    expect(updates.at(-1)).toMatchObject({
      progress: 3,
      total: 3,
      message: 'Persistent operation complete',
    });
    expect(
      updates.every(
        ({ progress }, index) => index === 0 || progress > updates[index - 1]!.progress,
      ),
    ).toBe(true);
    const count = updates.length;
    expect(await client.callTool(request)).toMatchObject({ structuredContent: { status: 'ok' } });
    expect(updates).toHaveLength(count);
    if (mode === 'http') {
      expect(
        exchanges
          .filter(({ method }) => method === 'tools/call')
          .map(({ contentType }) => contentType),
      ).toEqual([
        expect.stringContaining('text/event-stream'),
        expect.stringContaining('application/json'),
      ]);
    }
  });

  it('cancels a streaming ordinary call before admission without completing its operation', async () => {
    const { engine, jobs } = await fixture();
    const { client, exchanges } = await officialClient(engine, mode);
    const release = await holdExecutionCapacity(engine);
    const controller = new AbortController();
    const updates: number[] = [];
    const outcome = client
      .callTool(
        { name: 'hoi4.event_inspect', arguments: { workspaceId: 'alpha', mode: 'roots' } },
        { signal: controller.signal, onprogress: ({ progress }) => updates.push(progress) },
      )
      .then(
        () => 'completed',
        () => 'cancelled',
      );
    try {
      await vi.waitFor(
        async () => {
          expect(updates.length).toBeGreaterThan(0);
          expect((await jobs.list('alpha', 'alpha-user')).records).toHaveLength(1);
        },
        { timeout: 5000, interval: 50 },
      );
      controller.abort();
      expect(await outcome).toBe('cancelled');
      await vi.waitFor(
        async () => {
          expect((await jobs.list('alpha', 'alpha-user')).records[0]?.cancelRequested).toBe(true);
        },
        { timeout: 5000, interval: 50 },
      );
    } finally {
      controller.abort();
      await release();
    }
    await vi.waitFor(
      async () => {
        expect((await jobs.list('alpha', 'alpha-user')).records[0]).toMatchObject({
          status: 'cancelled',
          cancelRequested: true,
        });
      },
      { timeout: 20_000, interval: 50 },
    );
    expect(updates.every((value) => value < 3)).toBe(true);
    if (mode === 'http')
      expect(exchanges.find(({ method }) => method === 'tools/call')?.contentType).toContain(
        'text/event-stream',
      );
  });

  it('keeps compatibility controls foreground and responsive while execution capacity is occupied', async () => {
    const { root, engine, jobs, connect } = await fixture();
    const wire = await connect(mode);
    const active = (
      await jobs.submit(
        'alpha',
        { toolName: 'hoi4.event_inspect', arguments: { workspaceId: 'alpha' }, mutation: false },
        'alpha-user',
      )
    ).record;
    const workerRoot = path.join(root, 'state', 'job-workers');
    await mkdir(workerRoot, { recursive: true });
    const workerCapacity = new SharedRequestCapacity(workerRoot, 1);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admitted: Promise<void>[] = [];
    const holds = [engine.sharedRequests, workerCapacity].map((capacity) => {
      let ready!: () => void;
      admitted.push(
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
      );
      return capacity.run(new AbortController().signal, async () => {
        ready();
        await held;
      });
    });
    await Promise.all(admitted);
    const call = async (name: string) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          wire.request('tools/call', {
            name,
            arguments: { workspaceId: 'alpha', jobId: active.id },
          }),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Control waited for execution capacity')),
              2_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    };
    try {
      expect(result(await call('hoi4.job_inspect'))).toMatchObject({
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
        structuredContent: { code: 'JOB_STATUS', data: { jobId: active.id, status: 'queued' } },
      });
      expect(await jobs.get('alpha', active.id, 'alpha-user')).toEqual(active);
      expect(result(await call('hoi4.job_cancel'))).toMatchObject({
        resultType: 'complete',
        structuredContent: {
          code: 'JOB_CANCELLED',
          data: { status: 'cancelled', cancelRequested: true },
        },
      });
      expect((await jobs.list('alpha', 'alpha-user')).records).toHaveLength(1);
    } finally {
      release();
      await Promise.all(holds);
    }
  });

  it('preserves completed compatibility results and enforces principal and cancellation scopes', async () => {
    const { jobs, connect } = await fixture();
    const wire = await connect(mode);
    const created = result(
      await wire.request('tools/call', {
        name: 'hoi4.event_inspect',
        arguments: { workspaceId: 'alpha', mode: 'roots' },
      }),
    );
    const taskId = z.string().parse(created.taskId);
    const completed = await terminal(wire, taskId);
    const jobId = taskId.split(':')[1]!.split('.')[0]!;
    const stored = await jobs.get('alpha', jobId, 'alpha-user');
    const inspected = result(
      await wire.request(
        'tools/call',
        {
          name: 'hoi4.job_inspect',
          arguments: { workspaceId: 'alpha', jobId },
        },
        {},
      ),
    );
    expect(inspected).toMatchObject({
      resultType: 'complete',
      content: stored.result!.content,
      structuredContent: stored.result!.structuredContent,
      _meta: { 'io.github.klimPaskov/hoi4-agent-tools/job': { jobId, status: 'completed' } },
    });
    expect(completed.result).toMatchObject({
      content: inspected.content,
      structuredContent: inspected.structuredContent,
    });
    const artifacts = z
      .object({ artifacts: z.array(z.object({ uri: z.string() }).loose()).nonempty() })
      .loose()
      .parse(inspected.structuredContent).artifacts;
    const linked = result(await wire.request('resources/read', { uri: artifacts[0]!.uri }));
    expect(linked).toMatchObject({ resultType: 'complete' });
    expect(z.array(z.unknown()).parse(linked.contents)).toHaveLength(1);
    result(
      await wire.request('tools/call', {
        name: 'hoi4.job_cancel',
        arguments: { workspaceId: 'alpha', jobId },
      }),
    );
    expect(await jobs.get('alpha', jobId, 'alpha-user')).toEqual(stored);

    const queued = (
      await jobs.submit(
        'alpha',
        {
          toolName: 'hoi4.gui_rewrite',
          arguments: { workspaceId: 'alpha' },
          mutation: true,
          requestKey: 'compatibility-write-scope',
        },
        'alpha-user',
      )
    ).record;
    const reader = await connect(mode, 'alpha-user', ['hoi4:read']);
    const foreign = await connect(mode, 'beta-user');
    for (const name of ['hoi4.job_inspect', 'hoi4.job_cancel']) {
      const denied = result(
        await foreign.request('tools/call', {
          name,
          arguments: { workspaceId: 'alpha', jobId: queued.id },
        }),
      );
      const missing = result(
        await foreign.request('tools/call', {
          name,
          arguments: { workspaceId: 'alpha', jobId: `job_${'0'.repeat(64)}` },
        }),
      );
      expect(denied).toEqual(missing);
      expect(denied).toMatchObject({ isError: true, structuredContent: { code: 'JOB_NOT_FOUND' } });
      expect(
        (
          await wire.request('tools/call', {
            name,
            arguments: { workspaceId: 'alpha', jobId: queued.id, principal: 'beta-user' },
          })
        ).error,
      ).toMatchObject({ code: -32602 });
    }
    expect(
      result(
        await reader.request('tools/call', {
          name: 'hoi4.job_inspect',
          arguments: { workspaceId: 'alpha', jobId: queued.id },
        }),
      ),
    ).toMatchObject({
      structuredContent: { data: { status: 'queued' } },
    });
    expect(
      result(
        await reader.request('tools/call', {
          name: 'hoi4.job_cancel',
          arguments: { workspaceId: 'alpha', jobId: queued.id },
        }),
      ),
    ).toMatchObject({
      isError: true,
      structuredContent: { code: 'AUTH_SCOPE_REQUIRED' },
    });
    expect(await jobs.get('alpha', queued.id, 'alpha-user')).toEqual(queued);
  });

  it('shares prompt metadata and content without creating jobs or accepting invalid arguments', async () => {
    const { engine, jobs, connect } = await fixture();
    const wire = await connect(mode);
    const legacy = createMcpServer(engine, { principal: 'alpha-user' });
    const client = new LegacyClient({ name: 'legacy-prompt-parity', version: '1' });
    const [clientTransport, serverTransport] = LegacyInMemoryTransport.createLinkedPair();
    await legacy.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(async () => {
      await client.close();
      await legacy.close();
    });
    expect(result(await wire.request('server/discover'))).toMatchObject({
      capabilities: { prompts: {} },
    });
    expect(result(await wire.request('prompts/list')).prompts).toEqual(
      (await client.listPrompts()).prompts,
    );
    for (const arguments_ of [
      { objective: 'Inspect synthetic weights' },
      { objective: 'Compare explicit scenarios', sourceHint: 'events/synthetic.txt' },
    ]) {
      const params = { name: 'hoi4.probability_analysis', arguments: arguments_ };
      const modern = result(await wire.request('prompts/get', params));
      expect(modern).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' });
      expect(modern.messages).toEqual((await client.getPrompt(params)).messages);
    }
    for (const params of [
      { name: 'unknown' },
      { name: 'hoi4.probability_analysis' },
      { name: 'hoi4.probability_analysis', arguments: { objective: '' } },
      { name: 'hoi4.probability_analysis', arguments: { objective: 'x'.repeat(4097) } },
      {
        name: 'hoi4.probability_analysis',
        arguments: { objective: 'x', sourceHint: 'x'.repeat(1025) },
      },
    ])
      expect((await wire.request('prompts/get', params)).error).toMatchObject({ code: -32602 });
    expect((await jobs.list('alpha', 'alpha-user')).records).toHaveLength(0);
  });

  it('shares resource templates, exact byte ranges, and manifest content with the legacy reader', async () => {
    const { engine, connect } = await fixture();
    const workspace = engine.resolver.get('alpha', 'alpha-user');
    const chunkSize = 1_048_576;
    const bytes = Buffer.concat([Buffer.alloc(chunkSize - 1, 0x61), Buffer.from('🙂tail')]);
    const artifact = await engine.artifacts.put(
      workspace,
      'resource-boundary.txt',
      'text/plain',
      bytes,
      {
        kind: 'modern-resource-test',
        toolVersion: 'test',
        schemaVersion: 'test.v1',
        sourceHashes: {},
      },
    );
    const small = await engine.artifacts.put(
      workspace,
      'small.txt',
      'text/plain',
      Buffer.from('Exact small text\n'),
      {
        kind: 'modern-resource-test',
        toolVersion: 'test',
        schemaVersion: 'test.v1',
        sourceHashes: {},
      },
    );
    const wire = await connect(mode);
    const legacy = createMcpServer(engine, { principal: 'alpha-user' });
    const client = new LegacyClient({ name: 'legacy-resource-parity', version: '1' });
    const [clientTransport, serverTransport] = LegacyInMemoryTransport.createLinkedPair();
    await legacy.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(async () => {
      await client.close();
      await legacy.close();
    });
    expect(result(await wire.request('resources/list')).resources).toEqual([]);
    expect(result(await wire.request('resources/templates/list')).resourceTemplates).toEqual(
      (await client.listResourceTemplates()).resourceTemplates,
    );
    for (const uri of [
      artifact.uri,
      small.uri,
      `${artifact.uri}?offset=${chunkSize - 1}&length=3`,
      `${artifact.uri}?metadata=manifest`,
      `${artifact.uri}?metadata=manifest&length=2`,
    ]) {
      const modern = result(await wire.request('resources/read', { uri }));
      const previous = await client.readResource({ uri });
      expect(modern).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' });
      expect(modern.contents).toEqual(previous.contents);
    }
    const contentSchema = z
      .object({
        blob: z.string(),
        _meta: z
          .object({
            'io.github.klimpaskov/hoi4-agent-tools.artifact-byte-range': z
              .object({
                continuationUri: z.string().nullable(),
              })
              .loose(),
          })
          .loose(),
      })
      .loose();
    const reconstructed: Buffer[] = [];
    let next: string | null = artifact.uri;
    for (let pageNumber = 0; next !== null && pageNumber < 3; pageNumber += 1) {
      const page = z
        .object({ contents: z.array(contentSchema).length(1) })
        .loose()
        .parse(result(await wire.request('resources/read', { uri: next })));
      reconstructed.push(Buffer.from(page.contents[0]!.blob, 'base64'));
      next =
        page.contents[0]!._meta['io.github.klimpaskov/hoi4-agent-tools.artifact-byte-range']
          .continuationUri;
    }
    expect(next).toBeNull();
    expect(Buffer.concat(reconstructed)).toEqual(bytes);
  });

  it('rejects invalid resource selectors, ungranted workspaces, tampering, and mismatched routing headers', async () => {
    const { root, engine, connect } = await fixture();
    const workspace = engine.resolver.get('alpha', 'alpha-user');
    const artifact = await engine.artifacts.put(
      workspace,
      'private.txt',
      'text/plain',
      Buffer.from('Private artifact bytes'),
      {
        kind: 'modern-resource-security',
        toolVersion: 'test',
        schemaVersion: 'test.v1',
        sourceHashes: {},
      },
    );
    const wire = await connect(mode);
    const beta = await connect(mode, 'beta-user');
    // Artifacts are workspace-owned, unlike principal-private task execution records.
    expect(result(await beta.request('resources/read', { uri: artifact.uri })).contents).toEqual(
      result(await wire.request('resources/read', { uri: artifact.uri })).contents,
    );
    const gamma = await connect(mode, 'gamma-user');
    expect((await gamma.request('resources/read', { uri: artifact.uri })).error).toMatchObject({
      code: -32602,
      data: { uri: artifact.uri },
    });
    for (const uri of [
      `${artifact.uri}?offset=0&offset=1`,
      `${artifact.uri}?length=1048577`,
      `${artifact.uri}?length=0`,
      `${artifact.uri}?offset=-1`,
      `${artifact.uri}?unknown=1`,
      `${artifact.uri}?metadata=unsupported`,
      `${artifact.uri}#fragment`,
      artifact.uri.replace('/alpha/', '/%61lpha/'),
      artifact.uri.replace('/alpha/', '/%ZZalpha/'),
      `file:///private.txt`,
      `${artifact.uri}?length=${'1'.repeat(8192)}`,
    ]) {
      expect(
        (await wire.request('resources/read', { uri })).error,
        uri.slice(0, 120),
      ).toMatchObject({ code: -32602 });
    }
    if (mode === 'http')
      expect(
        (
          await wire.request('resources/read', { uri: artifact.uri }, capabilities, {
            'mcp-name': 'mismatch',
          })
        ).error,
      ).toBeDefined();
    const manifest = await engine.artifacts.describe(workspace, artifact.uri);
    await writeFile(manifest.path, 'tampered and longer private artifact bytes');
    const refused = await wire.request('resources/read', { uri: artifact.uri });
    expect(refused.error).toMatchObject({ code: -32602, data: { uri: artifact.uri } });
    expect(JSON.stringify(refused)).not.toContain(root);
    expect(JSON.stringify(refused)).not.toContain('Private artifact bytes');
  });

  it('preserves synchronous rewrites and shares retry receipts with a legacy task client', async () => {
    const { alpha, engine, jobs, connect } = await fixture();
    const source = path.join(alpha, 'interface', 'modern_window.gui');
    await mkdir(path.dirname(source));
    const original =
      'guiTypes = {\n\tcontainerWindowType = { name = "modern_window" position = { x = 10 y = 20 } size = { width = 320 height = 200 } }\n}\n';
    await writeFile(source, original);
    const wire = await connect(mode);
    const args = {
      mode: 'source',
      workspaceId: 'alpha',
      relativePath: 'interface/modern_window.gui',
      windowName: 'modern_window',
      scenario: { id: 'modern-rewrite', resolution: { width: 640, height: 360 } },
      source: original.replace('x = 10', 'x = 20'),
    };
    const synchronous = result(
      await wire.request('tools/call', { name: 'hoi4.gui_rewrite', arguments: args }),
    );
    expect(synchronous).toMatchObject({
      resultType: 'complete',
      structuredContent: { code: 'GUI_CHANGES_APPLIED' },
    });
    expect(synchronous).not.toHaveProperty('taskId');
    expect(await readFile(source, 'utf8')).toBe(args.source);
    const keyed = {
      ...args,
      source: original.replace('x = 10', 'x = 24'),
      requestKey: 'cross-era-once',
    };
    const created = result(
      await wire.request('tools/call', { name: 'hoi4.gui_rewrite', arguments: keyed }),
    );
    const taskId = z.string().parse(created.taskId);
    const completed = await terminal(wire, taskId);
    expect(completed.result).toMatchObject({
      structuredContent: { code: 'GUI_CHANGES_APPLIED', data: { execution: 'applied' } },
    });
    const stored = await jobs.get('alpha', taskId.split(':')[1]!.split('.')[0]!, 'alpha-user');
    expect(stored.transaction).toBeDefined();
    // An independent source edit proves that receipt retrieval does not replay the rewrite.
    const independentlyEdited = keyed.source + '# retained independent edit\n';
    await writeFile(source, independentlyEdited);
    const legacy = createMcpServer(engine, {
      principal: 'alpha-user',
      scopes: ['hoi4:read', 'hoi4:write'],
    });
    const client = new LegacyClient({ name: 'cross-era-retry', version: '1' });
    const [clientTransport, serverTransport] = LegacyInMemoryTransport.createLinkedPair();
    cleanup.push(async () => {
      await client.close();
      await legacy.close();
    });
    await legacy.connect(serverTransport);
    await client.connect(clientTransport);
    const retried = await client.request(
      { method: 'tools/call', params: { name: 'hoi4.gui_rewrite', arguments: keyed } },
      LegacyCreateTaskResultSchema,
      { task: { ttl: 60_000 } },
    );
    expect(retried.task.taskId).toBe(operationTaskId(stored));
    const legacyResult = await client.experimental.tasks.getTaskResult(
      retried.task.taskId,
      LegacyCallToolResultSchema,
    );
    expect(legacyResult.structuredContent).toEqual(
      (completed.result as Record<string, unknown>).structuredContent,
    );
    expect(
      result(await wire.request('tools/call', { name: 'hoi4.gui_rewrite', arguments: keyed }))
        .taskId,
    ).toBe(taskId);
    const conflict = result(
      await wire.request('tools/call', {
        name: 'hoi4.gui_rewrite',
        arguments: { ...keyed, source: original.replace('x = 10', 'x = 30') },
      }),
    );
    expect(conflict).toMatchObject({
      isError: true,
      structuredContent: { code: 'JOB_REQUEST_KEY_CONFLICT' },
    });
    expect((await jobs.get('alpha', stored.id, 'alpha-user')).revision).toBe(stored.revision);
    expect(await readFile(source, 'utf8')).toBe(independentlyEdited);

    const expiredAt = Date.parse(stored.updatedAt) + stored.request.protocolTask!.ttl! + 1;
    vi.spyOn(Date, 'now').mockReturnValue(expiredAt);
    expect((await wire.request('tasks/get', { taskId })).error).toMatchObject({ code: -32602 });
    const renewed = result(
      await wire.request('tools/call', { name: 'hoi4.gui_rewrite', arguments: keyed }),
    );
    expect(renewed).toMatchObject({ taskId, status: 'completed', createdAt: stored.createdAt });
    expect(renewed.ttlMs).toBeGreaterThan(stored.request.protocolTask!.ttl!);
    expect((await terminal(wire, taskId)).result).toEqual(completed.result);
    const afterRenewal = await jobs.get('alpha', stored.id, 'alpha-user');
    expect(afterRenewal.result).toEqual(stored.result);
    expect(afterRenewal.transaction).toEqual(stored.transaction);
    expect(afterRenewal.request).toEqual(stored.request);
    expect(afterRenewal.requestHash).toBe(stored.requestHash);
    expect(afterRenewal.updatedAt).toBe(stored.updatedAt);

    // Ordinary modern retries and both legacy calling styles use the same saved outcome.
    vi.mocked(Date.now).mockReturnValue(expiredAt + 2 * stored.request.protocolTask!.ttl!);
    expect(
      result(await wire.request('tools/call', { name: 'hoi4.gui_rewrite', arguments: keyed }, {})),
    ).toMatchObject({
      resultType: 'complete',
      structuredContent: stored.result!.structuredContent,
    });
    vi.mocked(Date.now).mockReturnValue(expiredAt + 4 * stored.request.protocolTask!.ttl!);
    const renewedLegacy = await client.request(
      { method: 'tools/call', params: { name: 'hoi4.gui_rewrite', arguments: keyed } },
      LegacyCreateTaskResultSchema,
      { task: { ttl: 60_000 } },
    );
    expect(renewedLegacy.task.taskId).toBe(operationTaskId(stored));
    expect((await client.experimental.tasks.getTask(renewedLegacy.task.taskId)).status).toBe(
      'completed',
    );
    expect(
      (
        await client.experimental.tasks.getTaskResult(
          renewedLegacy.task.taskId,
          LegacyCallToolResultSchema,
        )
      ).structuredContent,
    ).toEqual(stored.result!.structuredContent);
    vi.mocked(Date.now).mockReturnValue(expiredAt + 6 * stored.request.protocolTask!.ttl!);
    expect(
      (await client.callTool({ name: 'hoi4.gui_rewrite', arguments: keyed })).structuredContent,
    ).toEqual(stored.result!.structuredContent);
    expect((await jobs.store.list(jobs.scope('alpha', 'alpha-user'))).records).toHaveLength(2);
    expect(await readFile(source, 'utf8')).toBe(independentlyEdited);
  });

  it('wraps pre-hardening receipts in authenticated handles without moving or replaying them', async () => {
    const { alpha, engine, jobs, connect } = await fixture();
    const source = path.join(alpha, 'interface', 'retained_window.gui');
    await mkdir(path.dirname(source));
    const original =
      'guiTypes = { containerWindowType = { name = "retained_window" position = { x = 10 y = 20 } size = { width = 320 height = 200 } } }\n';
    await writeFile(source, original);
    const args = {
      mode: 'source',
      workspaceId: 'alpha',
      relativePath: 'interface/retained_window.gui',
      windowName: 'retained_window',
      scenario: { id: 'retained-rewrite', resolution: { width: 640, height: 360 } },
      source: original.replace('x = 10', 'x = 24'),
      requestKey: 'pre-hardening-once',
    };
    const first = await connect(mode);
    const created = result(
      await first.request('tools/call', { name: 'hoi4.gui_rewrite', arguments: args }),
    );
    const completed = await terminal(first, z.string().parse(created.taskId));
    expect(completed.result).toMatchObject({
      structuredContent: { code: 'GUI_CHANGES_APPLIED' },
    });
    await first.close();
    const stored = (await jobs.list('alpha', 'alpha-user')).records[0]!;
    const legacy = {
      ...stored,
      id: `job_${hashCanonical({ scope: stored.scope, key: stored.request.requestKey })}`,
    };
    const state = engine.resolver.serverState()!;
    const directory = path.join(state.root, 'jobs', hashCanonical(stored.scope));
    const legacyFile = path.join(directory, `${legacy.id}.json`);
    await writeFile(
      legacyFile,
      canonicalJson({
        record: legacy,
        authenticationTag: state.authenticateJournal({ kind: 'job-record.v1', record: legacy }),
      }),
    );
    await unlink(path.join(directory, `${stored.id}.json`));
    const receiptBytes = await readFile(legacyFile);
    const independent = `${args.source}# independent later source edit\n`;
    await writeFile(source, independent);
    const retry = await connect(mode);
    const retried = result(
      await retry.request('tools/call', { name: 'hoi4.gui_rewrite', arguments: args }),
    );
    const taskId = new OperationTaskService(engine).authenticatedTaskId(legacy);
    expect(retried).toMatchObject({ resultType: 'task', status: 'completed', taskId });
    expect(taskId).not.toBe(operationTaskId(legacy));
    expect(taskId).not.toBe(created.taskId);
    await retry.close();
    const reconnected = await connect(mode);
    expect((await terminal(reconnected, taskId)).result).toEqual(completed.result);
    expect(
      await new OperationTaskService(engine).get(operationTaskId(legacy), {
        principal: 'alpha-user',
      }),
    ).toEqual(legacy);
    expect(await readFile(legacyFile)).toEqual(receiptBytes);
    expect((await jobs.list('alpha', 'alpha-user')).records).toEqual([legacy]);
    expect(await readFile(source, 'utf8')).toBe(independent);
  });

  it('rejects unsigned, tampered, and cross-job references before admitting queued work', async () => {
    const { engine, jobs, connect } = await fixture();
    const records = [];
    for (const key of ['reference-a', 'reference-b']) {
      records.push(
        (
          await jobs.submit(
            'alpha',
            {
              toolName: 'hoi4.gui_rewrite',
              arguments: { workspaceId: 'alpha' },
              mutation: true,
              requestKey: key,
              protocolTask: { ttl: 60_000, pollInterval: 250 },
            },
            'alpha-user',
          )
        ).record,
      );
    }
    const [record, other] = records;
    const tasks = new OperationTaskService(engine);
    const valid = tasks.authenticatedTaskId(record!);
    const wire = await connect(mode);
    const invalid = [
      operationTaskId(record!),
      `${operationTaskId(record!)}.${'0'.repeat(64)}`,
      `${operationTaskId(record!)}.${tasks.authenticatedTaskId(other!).split('.')[1]!}`,
      valid.slice(0, -1) + (valid.endsWith('0') ? '1' : '0'),
    ];
    for (const taskId of invalid) {
      for (const method of ['tasks/get', 'tasks/cancel', 'tasks/update']) {
        const params = { taskId, ...(method === 'tasks/update' ? { inputResponses: {} } : {}) };
        expect((await wire.request(method, params)).error).toMatchObject({
          code: -32602,
          message: 'Task not found',
        });
      }
    }
    for (const original of records)
      expect(await jobs.get('alpha', original.id, 'alpha-user')).toEqual(original);
  });

  it('durably creates, reconnects, polls, and returns the same ordinary result', async () => {
    const { source, engine, jobs, connect } = await fixture();
    const before = await readFile(source);
    const first = await connect(mode);
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admitted = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const capacity = engine.sharedRequests.run(new AbortController().signal, () => {
      ready();
      return held;
    });
    await admitted;
    let taskId: string;
    try {
      const created = result(
        await first.request('tools/call', {
          name: 'hoi4.event_inspect',
          arguments: { workspaceId: 'alpha', mode: 'roots' },
        }),
      );
      expect(created).toMatchObject({
        resultType: 'task',
        status: 'working',
        ttlMs: 86_400_000,
        pollIntervalMs: 250,
      });
      expect(created).not.toHaveProperty('task');
      expect(created).not.toHaveProperty('ttl');
      taskId = z.string().parse(created.taskId);
      expect(
        (await jobs.get('alpha', taskId.split(':')[1]!.split('.')[0]!, 'alpha-user')).request
          .protocolTask,
      ).toBeDefined();
      await first.close();
      const next = await connect(mode);
      expect(result(await next.request('tasks/get', { taskId })).status).toBe('working');
      const beta = await connect(mode, 'beta-user');
      for (const method of ['tasks/get', 'tasks/cancel', 'tasks/update']) {
        const params = { taskId, ...(method === 'tasks/update' ? { inputResponses: {} } : {}) };
        expect((await beta.request(method, params)).error).toMatchObject({
          code: -32602,
          message: 'Task not found',
        });
        expect((await next.request(method, params, {})).error).toMatchObject({ code: -32021 });
      }
    } finally {
      release();
      await capacity;
    }
    const completed = await terminal(await connect(mode), taskId);
    expect(completed.resultType).toBe('complete');
    expect(completed.result).toMatchObject({
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private',
      structuredContent: { status: 'ok' },
    });
    const foreground = result(
      await (
        await connect(mode)
      ).request(
        'tools/call',
        { name: 'hoi4.event_inspect', arguments: { workspaceId: 'alpha', mode: 'roots' } },
        {},
      ),
    );
    expect(foreground.resultType).toBe('complete');
    expect(foreground).not.toHaveProperty('taskId');
    expect(foreground.structuredContent).toEqual(
      (completed.result as Record<string, unknown>).structuredContent,
    );
    expect(await readFile(source)).toEqual(before);
  });

  it('does not expose aliases or retired task methods, and requires valid task parameters', async () => {
    const { connect } = await fixture();
    const wire = await connect(mode);
    for (const method of ['tasks/list', 'tasks/result', ...MODERN_TASK_ROUTES.values()]) {
      expect((await wire.request(method, { taskId: 'missing' })).error).toMatchObject({
        code: -32601,
      });
    }
    for (const params of [{}, { taskId: [] }, { taskId: 'missing', principal: 'alpha-user' }]) {
      expect((await wire.request('tasks/get', params)).error).toMatchObject({ code: -32602 });
    }
    expect((await wire.request('tasks/get', { taskId: 'missing' })).error).toMatchObject({
      code: -32602,
      message: 'Task not found',
    });
    expect(
      (
        await wire.request('tools/call', {
          name: 'hoi4.event_inspect',
          arguments: { workspaceId: 'alpha', unknownField: true },
        })
      ).error,
    ).toMatchObject({ code: -32602 });
  });

  it('ignores unknown update keys and cannot cancel or resume writes with read-only scope', async () => {
    const { engine, jobs, connect } = await fixture();
    const record = (
      await jobs.submit(
        'alpha',
        {
          toolName: 'hoi4.gui_rewrite',
          arguments: { workspaceId: 'alpha' },
          mutation: true,
          requestKey: 'modern-cancel-guard',
          protocolTask: { ttl: 60_000, pollInterval: 250 },
        },
        'alpha-user',
      )
    ).record;
    const taskId = new OperationTaskService(engine).authenticatedTaskId(record);
    const reader = await connect(mode, 'alpha-user', ['hoi4:read']);
    expect(result(await reader.request('tasks/get', { taskId })).status).toBe('working');
    expect((await reader.request('tasks/cancel', { taskId })).error).toMatchObject({
      code: -32000,
    });
    expect(
      result(
        await reader.request('tasks/update', {
          taskId,
          inputResponses: { bogus: { result: { status: 'completed' } } },
        }),
      ),
    ).toMatchObject({ resultType: 'complete' });
    expect(await jobs.get('alpha', record.id, 'alpha-user')).toMatchObject({
      revision: record.revision,
      status: 'queued',
      cancelRequested: false,
    });
    const writer = await connect(mode);
    const ack = result(await writer.request('tasks/cancel', { taskId }));
    expect(ack).not.toHaveProperty('status');
    expect(await terminal(writer, taskId, 'cancelled')).not.toHaveProperty('result');
  });

  it('represents a stored execution failure as a completed tool error and preserves terminal state', async () => {
    const { engine, jobs, connect } = await fixture();
    const record = (
      await jobs.submit(
        'alpha',
        {
          toolName: 'hoi4.event_inspect',
          arguments: { workspaceId: 'alpha' },
          mutation: false,
          protocolTask: { ttl: 60_000, pollInterval: 250 },
        },
        'alpha-user',
      )
    ).record;
    await jobs.failInterrupted(
      'alpha',
      record.id,
      { code: 'TEST_WORKER_FAILURE', message: 'Synthetic execution failure' },
      'alpha-user',
    );
    const wire = await connect(mode);
    const taskId = new OperationTaskService(engine).authenticatedTaskId(record);
    const completed = result(await wire.request('tasks/get', { taskId }));
    expect(completed).toMatchObject({
      status: 'completed',
      result: { isError: true, structuredContent: { code: 'TEST_WORKER_FAILURE' } },
    });
    expect(completed).not.toHaveProperty('error');
    result(await wire.request('tasks/cancel', { taskId }));
    expect(result(await wire.request('tasks/get', { taskId }))).toEqual(completed);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    expect((await wire.request('tasks/get', { taskId })).error).toMatchObject({
      code: -32602,
      message: 'Task not found',
    });
  });

  it('resolves client roots before creating a durable task', async () => {
    const { alpha, jobs, connect } = await fixture();
    const wire = await connect(mode);
    const caps = { ...capabilities, roots: {} };
    const params = {
      name: 'hoi4.event_inspect',
      arguments: { workspaceId: 'current', mode: 'roots' },
    };
    const awaitingRoots = result(await wire.request('tools/call', params, caps));
    expect(awaitingRoots).toMatchObject({
      resultType: 'input_required',
      inputRequests: { 'hoi4-workspace-roots': { method: 'roots/list' } },
    });
    expect((await jobs.list('alpha', 'alpha-user')).records).toHaveLength(0);
    const created = result(
      await wire.request(
        'tools/call',
        {
          ...params,
          inputResponses: {
            'hoi4-workspace-roots': { roots: [{ uri: pathToFileURL(alpha).href }] },
          },
        },
        caps,
      ),
    );
    expect(created.resultType).toBe('task');
    const completed = await terminal(wire, z.string().parse(created.taskId));
    expect(completed.result).toMatchObject({
      structuredContent: { workspaceId: 'alpha', status: 'ok' },
    });
  });
});

it('retains all shared tool names, descriptions, annotations, and schemas across protocol eras', async () => {
  const { engine, connect } = await fixture();
  const wire = await connect('stdio');
  const modern = result(await wire.request('tools/list'));
  expect(result(await wire.request('server/discover')).instructions).toBe(SERVER_INSTRUCTIONS);
  const legacy = createMcpServer(engine, { principal: 'alpha-user' });
  const client = new LegacyClient({ name: 'legacy-catalog-proof', version: '1' });
  const [clientTransport, serverTransport] = LegacyInMemoryTransport.createLinkedPair();
  cleanup.push(async () => {
    await client.close();
    await legacy.close();
  });
  await legacy.connect(serverTransport);
  await client.connect(clientTransport);
  expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  const listed = await client.listTools();
  const operations = listed.tools.map(({ execution: _execution, ...definition }) => definition);
  expect(operations).toHaveLength(27);
  expect(modern.tools).toEqual(operations);
});

it('supports the official SDK v2 ordinary-call client without requiring the Tasks extension', async () => {
  const { engine } = await fixture();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(
    () => createModernOperationServer(engine, { principal: 'alpha-user' }),
    { transport: serverTransport, legacy: 'reject' },
  );
  const client = new Client(
    { name: 'modern-sdk-client-proof', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  cleanup.push(async () => {
    await client.close();
    await handle.close();
  });
  await client.connect(clientTransport);
  expect(client.getProtocolEra()).toBe('modern');
  expect((await client.listTools()).tools).toHaveLength(27);
  expect((await client.listPrompts()).prompts.map(({ name }) => name)).toEqual([
    'hoi4.probability_analysis',
  ]);
  expect(
    await client.getPrompt({
      name: 'hoi4.probability_analysis',
      arguments: { objective: 'Inspect synthetic official-client weights' },
    }),
  ).toMatchObject({
    // The SDK validates and removes the wire discriminator before returning prompt content.
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: expect.stringContaining('Inspect synthetic official-client weights'),
        },
      },
    ],
  });
  expect(
    await client.callTool({
      name: 'hoi4.event_inspect',
      arguments: { workspaceId: 'alpha', mode: 'roots' },
    }),
  ).toMatchObject({ structuredContent: { status: 'ok' } });
});

it('rejects mismatched HTTP task-routing headers', async () => {
  const { connect } = await fixture();
  const wire = await connect('http');
  expect(
    (
      await wire.request('tasks/get', { taskId: 'missing' }, capabilities, {
        'mcp-name': 'different-task',
      })
    ).error,
  ).toMatchObject({ code: -32602 });
  expect(
    (
      await wire.request('tasks/get', { taskId: 'missing' }, capabilities, {
        'mcp-method': 'tasks/cancel',
      })
    ).error,
  ).toBeDefined();
});

it('cancels a non-task modern tool call without leaving its durable job running', async () => {
  const { engine, jobs } = await fixture();
  let release!: () => void;
  let ready!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const capacity = engine.sharedRequests.run(new AbortController().signal, () => {
    ready();
    return held;
  });
  await admitted;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(
    () => createModernOperationServer(engine, { principal: 'alpha-user' }),
    { transport: serverTransport, legacy: 'reject' },
  );
  const client = new Client(
    { name: 'modern-cancellation-proof', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  cleanup.push(async () => {
    await client.close();
    await handle.close();
  });
  await client.connect(clientTransport);
  const controller = new AbortController();
  const call = client.callTool(
    {
      name: 'hoi4.impact_inspect',
      arguments: { workspaceId: 'alpha', symbols: [{ kind: 'event', id: 'modern.1' }] },
    },
    { signal: controller.signal },
  );
  const outcome = call.then(
    () => 'completed',
    () => 'cancelled',
  );
  try {
    await vi.waitFor(
      async () => expect((await jobs.list('alpha', 'alpha-user')).records).toHaveLength(1),
      { timeout: 5000, interval: 50 },
    );
    controller.abort();
    expect(await outcome).toBe('cancelled');
    // Client-side rejection is not a server acknowledgement. Keep capacity occupied until
    // cancellation is durable so this specifically tests cancellation before admission.
    await vi.waitFor(
      async () => {
        expect((await jobs.list('alpha', 'alpha-user')).records[0]?.cancelRequested).toBe(true);
      },
      { timeout: 5000, interval: 50 },
    );
  } finally {
    release();
    await capacity;
  }
  await vi.waitFor(
    async () => {
      expect((await jobs.list('alpha', 'alpha-user')).records[0]).toMatchObject({
        status: 'cancelled',
        cancelRequested: true,
      });
    },
    { timeout: 20_000, interval: 50 },
  );
});
