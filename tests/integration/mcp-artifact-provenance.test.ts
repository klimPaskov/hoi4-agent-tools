import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  boundedSourceHashEvidence,
  type ArtifactProvenance,
} from '../../src/hoi4_agent_tools/core/artifacts.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { AgentNudger } from '../../src/hoi4_agent_tools/map/service.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

interface ArtifactLink {
  uri: string;
  name: string;
  mimeType: string;
}

interface ToolOutput {
  status: string;
  code: string;
  artifacts: ArtifactLink[];
}

interface ArtifactManifestResource {
  version: 2;
  name: string;
  provenance: ArtifactProvenance;
}

const cleanup: Array<() => Promise<void>> = [];
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((callback) => callback()));
});

function sourceHashes(
  files: readonly Pick<ScannedFile, 'displayPath' | 'sha256'>[],
): Record<string, string> {
  return Object.fromEntries(files.map(({ displayPath, sha256 }) => [displayPath, sha256]));
}

async function writeInBatches(
  count: number,
  write: (index: number) => Promise<void>,
): Promise<void> {
  const batchSize = 64;
  for (let offset = 0; offset < count; offset += batchSize) {
    await Promise.all(
      Array.from({ length: Math.min(batchSize, count - offset) }, (_unused, index) =>
        write(offset + index),
      ),
    );
  }
}

async function connect(
  temporary: string,
  workspace: Record<string, unknown>,
): Promise<{ client: Client; engine: CoreEngine }> {
  const artifactRoot = workspace.artifactRoot as string;
  const cacheRoot = workspace.cacheRoot as string;
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(temporary, 'server-state'),
    storageRoots: [artifactRoot, cacheRoot],
    workspaces: [workspace],
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  await engine.initialize();
  const server = createMcpServer(engine);
  const client = new Client({ name: 'artifact-provenance-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport as unknown as Transport);
  await client.connect(clientTransport as unknown as Transport);
  cleanup.push(
    async () => client.close(),
    async () => server.close(),
    async () => rm(temporary, { recursive: true, force: true }),
  );
  return { client, engine };
}

function toolOutput(value: Awaited<ReturnType<Client['callTool']>>): ToolOutput {
  return value.structuredContent as unknown as ToolOutput;
}

async function readJsonResource(client: Client, uri: string): Promise<Record<string, unknown>> {
  const resource = await client.readResource({ uri });
  const content = resource.contents[0];
  if (content === undefined || !('text' in content)) {
    throw new Error(`Expected one complete JSON text resource for ${uri}`);
  }
  return JSON.parse(content.text) as Record<string, unknown>;
}

async function readArtifactManifest(
  client: Client,
  artifact: ArtifactLink,
): Promise<ArtifactManifestResource> {
  const manifestUri = new URL(artifact.uri);
  manifestUri.searchParams.set('metadata', 'manifest');
  return (await readJsonResource(client, manifestUri.href)) as unknown as ArtifactManifestResource;
}

async function expectBoundManifestEvidence(
  client: Client,
  artifact: ArtifactLink,
  completeSourceHashes: Readonly<Record<string, string>>,
): Promise<void> {
  const expected = boundedSourceHashEvidence(completeSourceHashes);
  expect(expected.inventory).toMatchObject({
    schemaVersion: 1,
    algorithm: 'sha256-length-prefixed-path-digest-v1',
    count: Object.keys(completeSourceHashes).length,
    retainedCount: 256,
    truncated: true,
  });
  expect(expected.inventory.digest).toMatch(/^[a-f0-9]{64}$/u);

  const manifest = await readArtifactManifest(client, artifact);
  expect(manifest.name).toBe(artifact.name);
  expect(manifest.provenance.sourceHashes).toEqual(expected.sourceHashes);
  expect(manifest.provenance.metadata).toMatchObject({
    sourceHashInventory: expected.inventory,
  });
}

describe('MCP broad artifact provenance', () => {
  it('binds every map evidence call site to complete readable source inventories', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-map-provenance-'));
    const fixtureRoots = path.join(repositoryRoot, 'fixtures', 'map', 'roots');
    const game = path.join(temporary, 'game');
    const dependency = path.join(temporary, 'dependency');
    const mod = path.join(temporary, 'mod');
    const artifactRoot = path.join(temporary, 'runtime', 'artifacts');
    const cacheRoot = path.join(temporary, 'runtime', 'cache');
    await Promise.all([
      cp(path.join(fixtureRoots, 'game'), game, { recursive: true }),
      cp(path.join(fixtureRoots, 'dependency'), dependency, { recursive: true }),
      cp(path.join(fixtureRoots, 'mod'), mod, { recursive: true }),
      mkdir(artifactRoot, { recursive: true }),
      mkdir(cacheRoot, { recursive: true }),
    ]);
    const localisationRoot = path.join(mod, 'localisation', 'english');
    await mkdir(localisationRoot, { recursive: true });
    await writeInBatches(320, async (index) => {
      const suffix = String(index).padStart(3, '0');
      await writeFile(
        path.join(localisationRoot, `map_bulk_${suffix}_l_english.yml`),
        `l_english:\n map_bulk_${suffix}: "Map evidence ${suffix}"\n`,
      );
    });

    const { client, engine } = await connect(temporary, {
      id: 'map-provenance',
      name: 'Broad map provenance fixture',
      root: mod,
      gameRoot: game,
      dependencyRoots: [dependency],
      artifactRoot,
      cacheRoot,
    });
    const snapshot = await new AgentNudger(engine).scan('map-provenance');
    const expectedSourceHashes = sourceHashes(snapshot.files);
    expect(Object.keys(expectedSourceHashes).length).toBeGreaterThan(320);

    const results = [
      toolOutput(
        await client.callTool({
          name: 'hoi4.map_inspect',
          arguments: {
            workspaceId: 'map-provenance',
            allocationRequests: [{ kind: 'state' }],
          },
        }),
      ),
      toolOutput(
        await client.callTool({
          name: 'hoi4.map_render',
          arguments: { workspaceId: 'map-provenance', layer: 'province' },
        }),
      ),
    ];
    expect(results.map(({ status }) => status)).toEqual(['ok', 'ok']);

    const structuredArtifacts = results.map((result) => {
      const artifact = result.artifacts.find(({ mimeType }) => mimeType === 'application/json');
      expect(artifact, result.code).toBeDefined();
      return artifact!;
    });
    for (const artifact of structuredArtifacts) {
      const content = await readJsonResource(client, artifact.uri);
      expect(content.sourceHashes).toEqual(expectedSourceHashes);
      await expectBoundManifestEvidence(client, artifact, expectedSourceHashes);
    }

    const renderArtifacts = results.at(-1)!.artifacts;
    expect(renderArtifacts.map(({ mimeType }) => mimeType)).toEqual(
      expect.arrayContaining(['application/json', 'image/png', 'text/html']),
    );
    for (const artifact of renderArtifacts) {
      await expectBoundManifestEvidence(client, artifact, expectedSourceHashes);
    }
  }, 60_000);
});
