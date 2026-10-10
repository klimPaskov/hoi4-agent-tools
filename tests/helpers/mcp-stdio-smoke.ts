import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Shared pieces of the end-to-end stdio smoke suites: a real `hoi4-agent-tools` child process
 * driven by the MCP SDK client, plus the result checks every tool call must pass.
 */

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const stdioEntry = path.join(projectRoot, 'src', 'bin', 'stdio.ts');

/** An inline result larger than this has stopped being a bounded, agent-readable answer. */
export const SMOKE_MAX_TEXT_BYTES = 40_000;
export const SMOKE_MAX_STRUCTURED_BYTES = 40_000;
export const SMOKE_MAX_IMAGE_BYTES = 4_000_000;
/** Starting a TypeScript server on a loaded machine can take far longer than the SDK default. */
const STARTUP_TIMEOUT_MS = 300_000;

export interface SmokeResult {
  tool: string;
  label: string;
  isError: boolean;
  /** The operation envelope (`status`, `code`, `data` and friends). */
  structured: {
    status: 'ok' | 'blocked' | 'error';
    code: string;
    workspaceId: string;
    data: Record<string, unknown>;
    artifacts?: Array<{ uri: string; name: string; mimeType: string }>;
    blockers?: Array<{ code: string; message: string }>;
    diagnostics?: unknown[];
  };
  text: string;
  textBytes: number;
  structuredBytes: number;
  imageBytes: number;
  milliseconds: number;
}

export interface SmokeServer {
  client: Client;
  toolNames: string[];
  call(tool: string, label: string, args: Record<string, unknown>): Promise<SmokeResult>;
  /** The server's stderr so far (structured log lines), for diagnosing a failed call. */
  stderr(): string;
  close(): Promise<void>;
}

export async function writeSmokeConfig(
  directory: string,
  workspaces: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'config.json');
  await writeFile(
    file,
    `${JSON.stringify({
      version: 1,
      serverStateRoot: path.join(directory, 'server-state'),
      workspaceStorageRoot: path.join(directory, 'workspace-storage'),
      workspaces,
      ...extra,
    })}\n`,
  );
  return file;
}

export async function launchSmokeServer(configPath: string): Promise<SmokeServer> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) environment[key] = value;
  environment.HOI4_AGENT_CONFIG = configPath;
  delete environment.HOI4_AGENT_TOOLS_CHAOSX;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, stdioEntry],
    cwd: projectRoot,
    env: environment,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-smoke', version: '1.0.0' });
  let stderrText = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderrText = `${stderrText}${chunk.toString('utf8')}`.slice(-20_000);
  });
  let listed: Awaited<ReturnType<Client['listTools']>>;
  try {
    await client.connect(transport, { timeout: STARTUP_TIMEOUT_MS });
    listed = await client.listTools(undefined, { timeout: STARTUP_TIMEOUT_MS });
  } catch (error) {
    // The server writes why it stopped to stderr; without it a failed start is just a closed pipe.
    throw new Error(
      `stdio server failed to start: ${error instanceof Error ? error.message : String(error)}
${stderrText.slice(-2_000)}`,
      { cause: error },
    );
  }
  return {
    client,
    toolNames: listed.tools.map(({ name }) => name),
    async call(tool, label, args) {
      const started = performance.now();
      const raw = await client.callTool(
        { name: tool, arguments: args },
        undefined,
        // Cold indexing of an installed game plus a large mod can take minutes on a loaded machine.
        { timeout: 600_000, resetTimeoutOnProgress: true },
      );
      const milliseconds = Math.round(performance.now() - started);
      const content = Array.isArray(raw.content) ? raw.content : [];
      let text = '';
      let imageBytes = 0;
      for (const item of content as Array<{ type: string; text?: string; data?: string }>) {
        if (item.type === 'text') text += item.text ?? '';
        else if (item.type === 'image') imageBytes += Buffer.byteLength(item.data ?? '', 'base64');
      }
      return {
        tool,
        label,
        isError: raw.isError === true,
        structured: (raw.structuredContent ?? {}) as SmokeResult['structured'],
        text,
        textBytes: Buffer.byteLength(text),
        structuredBytes: Buffer.byteLength(JSON.stringify(raw.structuredContent ?? {})),
        imageBytes,
        milliseconds,
      };
    },
    stderr: () => stderrText,
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}

/** Problems that make a result unfit for an agent: empty, oversized or not an operation envelope. */
export function wellFormedProblems(result: SmokeResult): string[] {
  const problems: string[] = [];
  const { structured } = result;
  if (typeof structured.status !== 'string' || typeof structured.code !== 'string')
    problems.push('result has no operation envelope (status/code)');
  const data: unknown = structured.data;
  if (typeof data !== 'object' || data === null) problems.push('result has no data object');
  if (result.text.trim() === '') problems.push('result has no text content');
  if (result.textBytes > SMOKE_MAX_TEXT_BYTES)
    problems.push(`text content is ${result.textBytes} bytes (limit ${SMOKE_MAX_TEXT_BYTES})`);
  if (result.structuredBytes > SMOKE_MAX_STRUCTURED_BYTES)
    problems.push(
      `structured content is ${result.structuredBytes} bytes (limit ${SMOKE_MAX_STRUCTURED_BYTES})`,
    );
  if (result.imageBytes > SMOKE_MAX_IMAGE_BYTES)
    problems.push(`inline image is ${result.imageBytes} bytes (limit ${SMOKE_MAX_IMAGE_BYTES})`);
  return problems;
}

/** A successful call: not a tool error, status ok, and a well-formed bounded result. */
export function successProblems(result: SmokeResult, tolerate: readonly string[] = []): string[] {
  const problems = wellFormedProblems(result);
  if (tolerate.includes(result.structured.code)) return problems;
  if (result.isError)
    problems.push(`tool error ${result.structured.code}: ${result.text.slice(0, 300)}`);
  else if (result.structured.status !== 'ok')
    problems.push(
      `status ${result.structured.status} (${result.structured.code}): ${result.text.slice(0, 300)}`,
    );
  return problems;
}

/** A deliberately wrong call: a tool error that names the misspelled field and shows a working call. */
export function helpfulErrorProblems(result: SmokeResult, field: string): string[] {
  const problems = wellFormedProblems(result);
  if (!result.isError) problems.push('wrong-field call was not reported as a tool error');
  if (result.structured.code !== 'INVALID_ARGUMENTS')
    problems.push(`error code ${result.structured.code}, expected INVALID_ARGUMENTS`);
  if (!result.text.includes(field)) problems.push(`error text does not name the field ${field}`);
  if (!result.text.includes('Example: ')) problems.push('error text shows no working example call');
  return problems;
}
