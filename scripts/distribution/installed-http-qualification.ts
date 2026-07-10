import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const protocolVersion = '2025-11-25';

interface ObservedRequest {
  headers: Headers;
  method: string;
  rpcMethod?: string;
  status?: number;
}

export interface InstalledHttpQualificationOptions {
  cwd: string;
  entryPath: string;
  environment: NodeJS.ProcessEnv;
  expectedPromptNames: readonly string[];
  expectedResourceUri: string;
  expectedServerName: string;
  expectedServerVersion: string;
  expectedToolNames: readonly string[];
  origin: string;
  token: string;
  workspaceId: string;
}

export interface InstalledHttpQualificationResult {
  cancellationObserved: boolean;
  deleteStatus: number;
  initializedStatus: number;
  progress: number[];
  promptNames: string[];
  resourceMimeType: string | undefined;
  resourceUris: string[];
  sessionId: string;
  toolNames: string[];
  url: string;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function rpcMethod(body: BodyInit | null | undefined): string | undefined {
  if (typeof body !== 'string') return undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      'method' in parsed &&
      typeof parsed.method === 'string'
    ) {
      return parsed.method;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function waitForHttpListening(child: ChildProcessWithoutNullStreams): Promise<string> {
  let pending = '';
  let stderr = '';
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Installed HTTP binary did not start\n${stderr}`));
    }, 15_000);
    const consume = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      stderr = `${stderr}${text}`.slice(-65_536);
      pending += text;
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) return;
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line.length === 0) continue;
        try {
          const event = JSON.parse(line) as { event?: unknown; url?: unknown };
          if (event.event === 'http_listening' && typeof event.url === 'string') {
            cleanup();
            resolve(event.url);
            return;
          }
        } catch {
          // Startup diagnostics are JSON, but retain non-JSON stderr in the timeout message.
        }
      }
    };
    const exited = (code: number | null): void => {
      cleanup();
      reject(new Error(`Installed HTTP binary exited before listening: ${code ?? 1}\n${stderr}`));
    };
    const failed = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stderr.off('data', consume);
      child.off('exit', exited);
      child.off('error', failed);
    };
    child.stderr.on('data', consume);
    child.once('exit', exited);
    child.once('error', failed);
  });
}

async function stopHttp(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let abandonTimeout: NodeJS.Timeout | undefined;
    const complete = (): void => {
      clearTimeout(forceTimeout);
      if (abandonTimeout !== undefined) clearTimeout(abandonTimeout);
      child.off('exit', complete);
      resolve();
    };
    const forceTimeout = setTimeout(() => {
      child.kill('SIGKILL');
      abandonTimeout = setTimeout(complete, 1_000);
    }, 3_000);
    child.once('exit', complete);
    if (!child.kill('SIGTERM')) {
      complete();
      return;
    }
  });
}

async function waitForObservedRequest(
  requests: ObservedRequest[],
  predicate: (request: ObservedRequest) => boolean,
  label: string,
): Promise<ObservedRequest> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const request = requests.find(predicate);
    if (request?.status !== undefined) return request;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function assertRequestHeaders(request: ObservedRequest, token: string, origin: string): void {
  requireCondition(
    request.headers.get('authorization') === `Bearer ${token}`,
    `${request.rpcMethod ?? request.method} omitted the installed HTTP bearer token`,
  );
  requireCondition(
    request.headers.get('origin') === origin,
    `${request.rpcMethod ?? request.method} omitted the installed HTTP Origin`,
  );
  if (request.method === 'POST') {
    const accept = request.headers.get('accept') ?? '';
    requireCondition(
      accept.includes('application/json') && accept.includes('text/event-stream'),
      `${request.rpcMethod ?? request.method} omitted required Streamable HTTP Accept types`,
    );
    requireCondition(
      request.headers.get('content-type')?.includes('application/json'),
      `${request.rpcMethod ?? request.method} omitted the JSON content type`,
    );
  }
}

/** Exercise the installed HTTP entry point through an authenticated, stateful MCP session. */
export async function qualifyInstalledHttpBinary(
  options: InstalledHttpQualificationOptions,
): Promise<InstalledHttpQualificationResult> {
  const child = spawn(process.execPath, [options.entryPath], {
    cwd: options.cwd,
    env: options.environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', () => undefined);
  let client: Client | undefined;
  try {
    const url = await waitForHttpListening(child);
    const requests: ObservedRequest[] = [];
    const observedFetch: FetchLike = async (url, init) => {
      const requestRpcMethod = rpcMethod(init?.body);
      const observation: ObservedRequest = {
        headers: new Headers(init?.headers),
        method: init?.method?.toUpperCase() ?? 'GET',
        ...(requestRpcMethod === undefined ? {} : { rpcMethod: requestRpcMethod }),
      };
      requests.push(observation);
      const response = await fetch(url, init);
      observation.status = response.status;
      return response;
    };
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      fetch: observedFetch,
      requestInit: {
        headers: {
          authorization: `Bearer ${options.token}`,
          origin: options.origin,
        },
      },
    });
    client = new Client({
      name: 'installed-http-qualification',
      version: options.expectedServerVersion,
    });
    await client.connect(transport as unknown as Transport);

    const sessionId = transport.sessionId;
    requireCondition(sessionId !== undefined, 'Installed HTTP initialization omitted a session ID');
    requireCondition(
      /^[0-9a-f-]{36}$/u.test(sessionId),
      'Installed HTTP initialization returned a malformed session ID',
    );
    requireCondition(
      transport.protocolVersion === protocolVersion,
      `Installed HTTP negotiated ${transport.protocolVersion ?? 'no protocol version'}`,
    );
    const serverVersion = client.getServerVersion();
    requireCondition(
      serverVersion?.name === options.expectedServerName &&
        serverVersion.version === options.expectedServerVersion,
      'Installed HTTP server reported mismatched package identity',
    );

    const tools = await client.listTools();
    const toolNames = tools.tools.map(({ name }) => name);
    for (const expected of options.expectedToolNames) {
      requireCondition(
        toolNames.includes(expected),
        `Installed HTTP server is missing tool ${expected}`,
      );
    }

    const resources = await client.listResources();
    const resourceUris = resources.resources.map(({ uri }) => uri);
    requireCondition(
      resourceUris.includes(options.expectedResourceUri),
      `Installed HTTP server is missing resource ${options.expectedResourceUri}`,
    );
    const resource = await client.readResource({ uri: options.expectedResourceUri });
    const resourceContent = resource.contents[0];
    requireCondition(
      resourceContent !== undefined && 'text' in resourceContent && resourceContent.text.length > 0,
      `Installed HTTP resource ${options.expectedResourceUri} did not return text`,
    );

    const prompts = await client.listPrompts();
    const promptNames = prompts.prompts.map(({ name }) => name);
    for (const expected of options.expectedPromptNames) {
      requireCondition(
        promptNames.includes(expected),
        `Installed HTTP server is missing prompt ${expected}`,
      );
    }

    const progress: number[] = [];
    await client.callTool(
      { name: 'hoi4.project_scan', arguments: { workspaceId: options.workspaceId } },
      undefined,
      { onprogress: ({ progress: value }) => progress.push(value) },
    );
    requireCondition(progress.length > 0, 'Installed HTTP tool call emitted no progress');
    requireCondition(
      progress.every((value, index) => index === 0 || value > progress[index - 1]!),
      'Installed HTTP progress was not strictly monotonic',
    );

    const cancellation = new AbortController();
    let cancellationObserved = false;
    try {
      await client.callTool(
        { name: 'hoi4.project_scan', arguments: { workspaceId: options.workspaceId } },
        undefined,
        {
          signal: cancellation.signal,
          onprogress: () => cancellation.abort(),
        },
      );
    } catch (error) {
      requireCondition(
        /abort/iu.test(error instanceof Error ? error.message : String(error)),
        'Installed HTTP cancellation failed for an unrelated reason',
      );
      cancellationObserved = true;
    }
    requireCondition(
      cancellationObserved,
      'Installed HTTP cancellation request unexpectedly completed',
    );

    const initializeRequest = await waitForObservedRequest(
      requests,
      (request) => request.rpcMethod === 'initialize',
      'initialize request',
    );
    const initializedRequest = await waitForObservedRequest(
      requests,
      (request) => request.rpcMethod === 'notifications/initialized',
      'initialized notification',
    );
    const cancellationRequest = await waitForObservedRequest(
      requests,
      (request) => request.rpcMethod === 'notifications/cancelled',
      'cancellation notification',
    );
    requireCondition(initializeRequest.status === 200, 'Installed HTTP initialize did not succeed');
    requireCondition(
      initializedRequest.status === 202,
      'Installed HTTP initialized notification was not accepted',
    );
    requireCondition(
      cancellationRequest.status === 202,
      'Installed HTTP cancellation notification was not accepted',
    );

    for (const request of requests.filter(
      (entry) => entry.rpcMethod !== undefined || entry.method === 'DELETE',
    )) {
      assertRequestHeaders(request, options.token, options.origin);
      if (request.rpcMethod !== 'initialize') {
        requireCondition(
          request.headers.get('mcp-session-id') === sessionId,
          `${request.rpcMethod ?? request.method} omitted the negotiated session ID`,
        );
        requireCondition(
          request.headers.get('mcp-protocol-version') === protocolVersion,
          `${request.rpcMethod ?? request.method} omitted the negotiated protocol version`,
        );
      }
    }

    await transport.terminateSession();
    const deleteRequest = await waitForObservedRequest(
      requests,
      (request) => request.method === 'DELETE',
      'session DELETE',
    );
    assertRequestHeaders(deleteRequest, options.token, options.origin);
    requireCondition(
      deleteRequest.headers.get('mcp-session-id') === sessionId &&
        deleteRequest.headers.get('mcp-protocol-version') === protocolVersion,
      'Installed HTTP session DELETE omitted negotiated headers',
    );
    requireCondition(deleteRequest.status === 200, 'Installed HTTP session DELETE did not succeed');

    return {
      cancellationObserved,
      deleteStatus: deleteRequest.status,
      initializedStatus: initializedRequest.status,
      progress,
      promptNames,
      resourceMimeType: resourceContent.mimeType,
      resourceUris,
      sessionId,
      toolNames,
      url,
    };
  } finally {
    await client?.close().catch(() => undefined);
    await stopHttp(child);
  }
}
