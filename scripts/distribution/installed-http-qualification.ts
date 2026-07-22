import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const protocolVersion = '2025-11-25';
const artifactResourceTemplate =
  'hoi4-agent://workspace/{workspaceId}/artifact/{sha256}/{provenanceHash}/{name}';
const publicToolNames = [
  'hoi4.focus_inspect',
  'hoi4.focus_render',
  'hoi4.focus_raster',
  'hoi4.focus_rewrite',
  'hoi4.gui_inspect',
  'hoi4.gui_render',
  'hoi4.gui_rewrite',
  'hoi4.map_inspect',
  'hoi4.map_render',
  'hoi4.map_rewrite',
  'hoi4.event_inspect',
  'hoi4.event_render',
  'hoi4.event_compare',
  'hoi4.tech_inspect',
  'hoi4.tech_render',
  'hoi4.tech_compare',
  'hoi4.probability_inspect',
  'hoi4.probability_evaluate',
  'hoi4.probability_sweep',
  'hoi4.probability_simulate',
  'hoi4.probability_sequence',
  'hoi4.probability_compare',
  'hoi4.probability_render',
] as const;

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
  expectedServerName: string;
  expectedServerVersion: string;
  focusRelativePath: string;
  probabilityFocusId: string;
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
  artifactResourceUri: string;
  boundedArtifactBytes: number;
  resourceMimeType: string | undefined;
  resourceTemplateUris: string[];
  resourceUris: string[];
  sessionId: string;
  toolNames: string[];
  url: string;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireExactNames(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const orderedActual = [...actual].sort();
  const orderedExpected = [...expected].sort();
  requireCondition(
    JSON.stringify(orderedActual) === JSON.stringify(orderedExpected),
    `${label} mismatch: expected ${orderedExpected.join(', ')}, received ${orderedActual.join(', ')}`,
  );
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
  let serverStdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    serverStdout = `${serverStdout}${chunk.toString('utf8')}`.slice(-65_536);
  });
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
    requireExactNames(toolNames, publicToolNames, 'Installed HTTP tools');

    const resources = await client.listResources();
    const resourceUris = resources.resources.map(({ uri }) => uri);
    requireCondition(resourceUris.length === 0, 'Installed HTTP server exposed fixed resources');
    const resourceTemplates = await client.listResourceTemplates();
    const resourceTemplateUris = resourceTemplates.resourceTemplates.map(
      ({ uriTemplate }) => uriTemplate,
    );
    requireExactNames(
      resourceTemplateUris,
      [artifactResourceTemplate],
      'Installed HTTP resource templates',
    );

    const promptNames = (await client.listPrompts()).prompts.map(({ name }) => name);
    requireCondition(
      client.getServerCapabilities()?.prompts !== undefined,
      'Installed HTTP server did not advertise the probability-analysis prompt',
    );
    requireExactNames(promptNames, ['hoi4.probability_analysis'], 'Installed HTTP prompts');

    const progress: number[] = [];
    const inspection = await client.callTool(
      {
        name: 'hoi4.focus_inspect',
        arguments: {
          workspaceId: options.workspaceId,
          relativePath: options.focusRelativePath,
        },
      },
      undefined,
      { onprogress: ({ progress: value }) => progress.push(value) },
    );
    requireCondition(
      inspection.isError !== true,
      'Installed HTTP focus inspection returned an error',
    );
    const artifactLink = (inspection.content as unknown[]).find(
      (entry): entry is { type: 'resource_link'; uri: string; mimeType?: string } =>
        typeof entry === 'object' &&
        entry !== null &&
        'type' in entry &&
        entry.type === 'resource_link' &&
        'uri' in entry &&
        typeof entry.uri === 'string' &&
        'mimeType' in entry &&
        entry.mimeType === 'application/json',
    );
    requireCondition(
      artifactLink !== undefined,
      'Installed HTTP focus inspection returned no JSON artifact resource link',
    );
    const artifactResourceUri = artifactLink.uri;
    const rangedArtifactUri = new URL(artifactResourceUri);
    rangedArtifactUri.searchParams.set('offset', '0');
    rangedArtifactUri.searchParams.set('length', '64');
    const resource = await client.readResource({ uri: rangedArtifactUri.href });
    const resourceContent = resource.contents[0];
    requireCondition(resourceContent !== undefined, 'Installed HTTP artifact range was empty');
    const boundedArtifactBytes =
      'blob' in resourceContent
        ? Buffer.from(resourceContent.blob, 'base64').length
        : Buffer.byteLength(resourceContent.text, 'utf8');
    requireCondition(
      boundedArtifactBytes === 64,
      `Installed HTTP artifact range returned ${boundedArtifactBytes} bytes instead of 64`,
    );
    requireCondition(progress.length > 0, 'Installed HTTP tool call emitted no progress');
    requireCondition(
      progress.every((value, index) => index === 0 || value > progress[index - 1]!),
      'Installed HTTP progress was not strictly monotonic',
    );

    const eventProgress: number[] = [];
    const eventInspection = await client.callTool(
      {
        name: 'hoi4.event_inspect',
        arguments: { workspaceId: options.workspaceId, mode: 'scan' },
      },
      undefined,
      { onprogress: ({ progress: value }) => eventProgress.push(value) },
    );
    requireCondition(
      eventInspection.isError !== true,
      'Installed HTTP event-chain inspection returned an error',
    );
    const eventStructured = eventInspection.structuredContent as
      { status?: unknown; code?: unknown } | undefined;
    requireCondition(
      eventStructured?.status === 'ok' &&
        (eventStructured.code === 'EVENT_INSPECTED' ||
          eventStructured.code === 'EVENT_INSPECTED_PARTIAL'),
      'Installed HTTP event-chain inspection returned an invalid structured result',
    );
    requireCondition(
      (eventInspection.content as unknown[]).some(
        (entry): entry is { type: 'resource_link'; mimeType: string } =>
          typeof entry === 'object' &&
          entry !== null &&
          'type' in entry &&
          entry.type === 'resource_link' &&
          'mimeType' in entry &&
          entry.mimeType === 'application/json',
      ),
      'Installed HTTP event-chain inspection returned no JSON artifact resource link',
    );
    requireCondition(
      JSON.stringify(eventProgress) === JSON.stringify([0, 2, 3]),
      `Installed HTTP event-chain progress was unexpected: ${eventProgress.join(', ')}`,
    );

    const probabilityInspection = await client.callTool({
      name: 'hoi4.probability_inspect',
      arguments: {
        workspaceId: options.workspaceId,
        adapter: 'national_focus_ai_will_do',
        source: { identifier: options.probabilityFocusId },
        candidatePool: [options.probabilityFocusId],
      },
    });
    requireCondition(
      probabilityInspection.isError !== true,
      'Installed HTTP probability inspection returned an error',
    );
    const probabilityStructured = probabilityInspection.structuredContent as
      { status?: unknown; code?: unknown } | undefined;
    requireCondition(
      probabilityStructured?.status === 'ok' &&
        probabilityStructured.code === 'PROBABILITY_SOURCE_INSPECTED',
      'Installed HTTP probability inspection returned an invalid structured result',
    );

    const cancellation = new AbortController();
    let cancellationObserved = false;
    try {
      await client.callTool(
        {
          name: 'hoi4.focus_inspect',
          arguments: {
            workspaceId: options.workspaceId,
            relativePath: options.focusRelativePath,
          },
        },
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
    requireCondition(
      serverStdout.length === 0,
      `Installed HTTP binary wrote non-protocol data to stdout: ${serverStdout.slice(0, 256)}`,
    );

    return {
      artifactResourceUri,
      boundedArtifactBytes,
      cancellationObserved,
      deleteStatus: deleteRequest.status,
      initializedStatus: initializedRequest.status,
      progress,
      promptNames,
      resourceMimeType: resourceContent.mimeType,
      resourceTemplateUris,
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
