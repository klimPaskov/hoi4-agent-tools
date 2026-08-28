import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

interface ArtifactLink {
  uri: string;
}

interface ToolOutput {
  status: string;
  code: string;
  artifacts: ArtifactLink[];
}

const cleanup: Array<() => Promise<void>> = [];
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

afterEach(async () => {
  for (const callback of cleanup.splice(0).reverse()) await callback();
});

function outputOf(value: Awaited<ReturnType<Client['callTool']>>): ToolOutput {
  return value.structuredContent as unknown as ToolOutput;
}

function manifestPath(artifactRoot: string, uri: string): string {
  const segments = new URL(uri).pathname.split('/').filter(Boolean);
  const artifactIndex = segments.indexOf('artifact');
  const sha256 = segments[artifactIndex + 1];
  const provenanceHash = segments[artifactIndex + 2];
  const encodedName = segments.slice(artifactIndex + 3).join('/');
  if (sha256 === undefined || provenanceHash === undefined || encodedName.length === 0) {
    throw new Error(`Invalid artifact URI: ${uri}`);
  }
  const name = decodeURIComponent(encodedName);
  return path.join(
    artifactRoot,
    sha256.slice(0, 2),
    sha256,
    `${name}.${provenanceHash}.manifest.json`,
  );
}

async function corruptManifest(artifactRoot: string, uri: string): Promise<void> {
  const target = manifestPath(artifactRoot, uri);
  const manifest = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
  manifest.mimeType = 'application/x-corrupted-manifest';
  await writeFile(target, `${JSON.stringify(manifest)}\n`);
}

describe('MCP artifact manifest recovery', () => {
  it('repairs corrupted deterministic evidence for probability, event, and GUI routes', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-manifest-recovery-'));
    const mod = path.join(temporary, 'mod');
    const runtime = path.join(temporary, 'runtime');
    const artifactRoot = path.join(runtime, 'artifacts');
    await Promise.all([
      cp(path.join(repositoryRoot, 'fixtures', 'gui', 'workspace'), mod, { recursive: true }),
      mkdir(runtime, { recursive: true }),
    ]);
    await mkdir(path.join(mod, 'events'), { recursive: true });
    await writeFile(
      path.join(mod, 'events', 'manifest-recovery.txt'),
      [
        'add_namespace = recovery',
        'country_event = {',
        '\tid = recovery.1',
        '\tis_triggered_only = yes',
        '\toption = { name = recovery.1.a }',
        '}',
        '',
      ].join('\n'),
    );
    const scenario = JSON.parse(
      await readFile(
        path.join(repositoryRoot, 'fixtures', 'gui', 'scenarios', 'baseline.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(temporary, 'state'),
      storageRoots: [runtime],
      workspaces: [
        {
          id: 'recovery',
          name: 'Manifest recovery fixture',
          root: mod,
          artifactRoot,
          cacheRoot: path.join(runtime, 'cache'),
        },
      ],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    const server = createMcpServer(engine);
    const client = new Client({ name: 'manifest-recovery-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);
    cleanup.push(
      async () => client.close(),
      async () => server.close(),
      async () => rm(temporary, { recursive: true, force: true }),
    );

    const calls = [
      {
        name: 'hoi4.probability_evaluate',
        arguments: {
          adapter: 'event_option_ai_chance',
          source: {
            inlineClausewitz:
              'country_event = { id = recovery.2 option = { name = a ai_chance = { base = 1 } } option = { name = b ai_chance = { base = 3 } } }',
          },
          scenarioSet: {
            schemaVersion: '1.0',
            id: 'recovery-scenarios',
            scenarios: [{ id: 'baseline', state: {} }],
          },
          outputs: ['json'],
        },
      },
      {
        name: 'hoi4.event_inspect',
        arguments: { mode: 'scan', maxNodes: 100, maxEdges: 400 },
      },
      {
        name: 'hoi4.gui_inspect',
        arguments: { windowName: 'synthetic_gui_window', scenario },
      },
    ] as const;

    for (const call of calls) {
      const first = outputOf(await client.callTool(call));
      expect(first.status, first.code).toBe('ok');
      expect(first.artifacts.length, first.code).toBeGreaterThan(0);
      await Promise.all(first.artifacts.map(({ uri }) => corruptManifest(artifactRoot, uri)));

      const recovered = outputOf(await client.callTool(call));
      expect(recovered.status, recovered.code).toBe('ok');
      expect(recovered.code).not.toBe('ARTIFACT_MANIFEST_INTEGRITY_FAILED');
      expect(recovered.artifacts.length).toBe(first.artifacts.length);
      for (const artifact of recovered.artifacts) {
        await expect(client.readResource({ uri: artifact.uri })).resolves.toBeDefined();
      }
    }
  }, 120_000);
});
