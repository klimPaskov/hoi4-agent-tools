import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArtifactStore,
  type ChunkedArtifactIndex,
} from '../../src/hoi4_agent_tools/core/artifacts.js';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const cleanup: Array<() => Promise<void>> = [];
const resourceChunkBytes = 1_048_576;

afterEach(async () => Promise.all(cleanup.splice(0).map((callback) => callback())));

describe('MCP artifact resources', () => {
  it('returns partial textual byte ranges as base64 without corrupting split UTF-8 code points', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-resource-range-'));
    const mod = path.join(root, 'mod');
    const artifactRoot = path.join(root, 'artifacts');
    await Promise.all([mkdir(mod), mkdir(artifactRoot)]);
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      storageRoots: [artifactRoot],
      workspaces: [{ id: 'range', name: 'Range', root: mod, artifactRoot }],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    const workspace = engine.resolver.get('range');
    const splitCodePoint = Buffer.from([0xf0, 0x9f, 0x98, 0x80]);
    const bytes = Buffer.concat([
      Buffer.alloc(resourceChunkBytes - 1, 0x61),
      splitCodePoint,
      Buffer.from('tail', 'utf8'),
    ]);
    const artifact = await engine.artifacts.put(
      workspace,
      'utf8-boundary.txt',
      'text/plain',
      bytes,
      {
        kind: 'test',
        toolVersion: 'test',
        schemaVersion: 'test.v1',
        sourceHashes: Object.fromEntries(
          Array.from({ length: 150 }, (_, index) => [
            `localisation/english/source-${index}.yml`,
            sha256Bytes(String(index)),
          ]),
        ),
      },
      'd'.repeat(4_096),
    );
    const invalidUtf8Artifact = await engine.artifacts.put(
      workspace,
      'invalid-utf8.txt',
      'text/plain',
      Buffer.from([0xff]),
      {
        kind: 'test',
        toolVersion: 'test',
        schemaVersion: 'test.v1',
        sourceHashes: {},
      },
    );
    const server = createMcpServer(engine);
    const client = new Client({ name: 'artifact-range-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);
    cleanup.push(
      async () => client.close(),
      async () => server.close(),
      async () => rm(root, { recursive: true, force: true }),
    );

    const beforeDescribe = await client.callTool({
      name: 'hoi4.artifact_list',
      arguments: { workspaceId: 'range' },
    });
    const described = await client.callTool({
      name: 'hoi4.artifact_describe',
      arguments: { workspaceId: 'range', uri: artifact.uri },
    });
    expect(described.structuredContent).toMatchObject({
      status: 'ok',
      code: 'ARTIFACT_DESCRIBE',
      data: {
        artifact: {
          provenance: {
            sourceHashCount: 150,
            sourceHashesTruncated: true,
            sourceHashes: expect.any(Array),
          },
          description: 'd'.repeat(1_024),
          descriptionTruncated: true,
        },
      },
    });
    const describedContent = described.structuredContent as {
      artifacts: Array<{ uri: string; name: string }>;
      data: { artifact: { provenance: { sourceHashes: unknown[] } } };
    };
    expect(describedContent.data.artifact.provenance.sourceHashes).toHaveLength(100);
    const provenanceLink = describedContent.artifacts.find(({ name }) =>
      name.endsWith('.manifest.json'),
    );
    expect(provenanceLink).toBeDefined();
    const provenanceResource = await client.readResource({ uri: provenanceLink!.uri });
    const provenanceContent = provenanceResource.contents[0];
    expect(provenanceContent !== undefined && 'text' in provenanceContent).toBe(true);
    const provenanceManifest = JSON.parse(
      provenanceContent !== undefined && 'text' in provenanceContent ? provenanceContent.text : '',
    ) as { description: string; provenance: { sourceHashes: Record<string, string> } };
    expect(provenanceManifest.description).toHaveLength(4_096);
    expect(Object.keys(provenanceManifest.provenance.sourceHashes)).toHaveLength(150);
    const afterDescribe = await client.callTool({
      name: 'hoi4.artifact_list',
      arguments: { workspaceId: 'range' },
    });
    expect(afterDescribe.structuredContent).toMatchObject(beforeDescribe.structuredContent ?? {});

    const first = await client.readResource({ uri: artifact.uri });
    const firstContent = first.contents[0];
    expect(firstContent).toMatchObject({ mimeType: 'text/plain' });
    expect(firstContent !== undefined && 'blob' in firstContent).toBe(true);
    const firstBytes = Buffer.from(
      firstContent !== undefined && 'blob' in firstContent ? firstContent.blob : '',
      'base64',
    );
    expect(firstBytes).toEqual(bytes.subarray(0, resourceChunkBytes));

    const remainderUri = new URL(artifact.uri);
    remainderUri.searchParams.set('offset', String(resourceChunkBytes));
    remainderUri.searchParams.set('length', String(resourceChunkBytes));
    const remainder = await client.readResource({ uri: remainderUri.href });
    const remainderContent = remainder.contents[0];
    expect(remainderContent !== undefined && 'blob' in remainderContent).toBe(true);
    const remainderBytes = Buffer.from(
      remainderContent !== undefined && 'blob' in remainderContent ? remainderContent.blob : '',
      'base64',
    );
    const reconstructed = Buffer.concat([firstBytes, remainderBytes]);
    expect(reconstructed).toEqual(bytes);
    expect(sha256Bytes(reconstructed)).toBe(sha256Bytes(bytes));

    const invalidUtf8 = await client.readResource({ uri: invalidUtf8Artifact.uri });
    const invalidUtf8Content = invalidUtf8.contents[0];
    expect(invalidUtf8Content !== undefined && 'blob' in invalidUtf8Content).toBe(true);
    expect(
      Buffer.from(
        invalidUtf8Content !== undefined && 'blob' in invalidUtf8Content
          ? invalidUtf8Content.blob
          : '',
        'base64',
      ),
    ).toEqual(Buffer.from([0xff]));

    const queriedDescribe = await client.callTool({
      name: 'hoi4.artifact_describe',
      arguments: { workspaceId: 'range', uri: `${artifact.uri}?offset=1` },
    });
    expect(queriedDescribe.structuredContent).toMatchObject({
      status: 'error',
      code: 'ARTIFACT_URI_INVALID',
    });

    await expect(client.readResource({ uri: `${artifact.uri}?offset=0&offset=1` })).rejects.toThrow(
      /repeated/u,
    );
    await expect(client.readResource({ uri: `${artifact.uri}?unknown=1` })).rejects.toThrow(
      /not supported/u,
    );
    await expect(client.readResource({ uri: `${artifact.uri}#fragment` })).rejects.toThrow(
      /canonical/u,
    );
  });

  it('exposes an oversized logical artifact as an exact linked resource bundle', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-resource-bundle-'));
    const mod = path.join(root, 'mod');
    const artifactRoot = path.join(root, 'artifacts');
    await Promise.all([mkdir(mod), mkdir(artifactRoot)]);
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      storageRoots: [artifactRoot],
      workspaces: [{ id: 'bundle', name: 'Bundle', root: mod, artifactRoot }],
    });
    const store = new ArtifactStore(1_000_000, 100, 16_384);
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration), {
      artifacts: store,
    });
    const workspace = engine.resolver.get('bundle');
    const original = Buffer.from('resource🙂boundary\n'.repeat(4_000), 'utf8');
    const logical = await store.putChunked(
      workspace,
      'complete-graph.json',
      'application/json',
      original,
      {
        kind: 'resource-bundle-test',
        toolVersion: 'test',
        schemaVersion: 'bundle.v1',
        sourceHashes: {},
      },
    );
    const server = createMcpServer(engine);
    const client = new Client({ name: 'artifact-bundle-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);
    cleanup.push(
      async () => client.close(),
      async () => server.close(),
      async () => rm(root, { recursive: true, force: true }),
    );

    const indexResource = await client.readResource({ uri: logical.uri });
    const indexContent = indexResource.contents[0];
    expect(indexContent !== undefined && 'text' in indexContent).toBe(true);
    const index = JSON.parse(
      indexContent !== undefined && 'text' in indexContent ? indexContent.text : '',
    ) as ChunkedArtifactIndex;
    expect(index.original).toMatchObject({
      name: 'complete-graph.json',
      mimeType: 'application/json',
      size: original.length,
      sha256: sha256Bytes(original),
    });

    const reconstructed: Buffer[] = [];
    for (const chunk of index.chunks) {
      const resource = await client.readResource({ uri: chunk.uri });
      const content = resource.contents[0];
      expect(content !== undefined && 'blob' in content).toBe(true);
      const bytes = Buffer.from(
        content !== undefined && 'blob' in content ? content.blob : '',
        'base64',
      );
      expect(bytes).toHaveLength(chunk.length);
      expect(sha256Bytes(bytes)).toBe(chunk.sha256);
      reconstructed.push(bytes);
    }
    expect(Buffer.concat(reconstructed)).toEqual(original);
  });

  it('returns a reconstructable chunk index when gui_scan produces a large graph', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-gui-graph-bundle-'));
    const mod = path.join(root, 'mod');
    const interfaceRoot = path.join(mod, 'interface');
    const artifactRoot = path.join(root, 'artifacts');
    await Promise.all([
      mkdir(interfaceRoot, { recursive: true }),
      mkdir(artifactRoot, { recursive: true }),
    ]);
    const children = Array.from(
      { length: 600 },
      (_, index) =>
        `iconType = { name = "generated_icon_${index}" position = { x = ${index % 30} y = ${Math.floor(index / 30)} } size = { width = 8 height = 8 } tooltip = "GENERATED_TOOLTIP_${index}" unknown_${index} = { retained = yes } }`,
    ).join('\n');
    await writeFile(
      path.join(interfaceRoot, 'large.gui'),
      `guiTypes = { containerWindowType = { name = "large_window" size = { width = 640 height = 480 } ${children} } }\n`,
    );
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      storageRoots: [artifactRoot],
      workspaces: [{ id: 'gui-bundle', name: 'GUI bundle', root: mod, artifactRoot }],
    });
    const store = new ArtifactStore(10_000_000, 1_000, 65_536);
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration), {
      artifacts: store,
    });
    const server = createMcpServer(engine);
    const client = new Client({ name: 'gui-graph-bundle-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);
    cleanup.push(
      async () => client.close(),
      async () => server.close(),
      async () => rm(root, { recursive: true, force: true }),
    );

    const scanned = await client.callTool({
      name: 'hoi4.gui_scan',
      arguments: { workspaceId: 'gui-bundle' },
    });
    const output = scanned.structuredContent as {
      status: string;
      artifacts: Array<{ uri: string; name: string }>;
    };
    expect(output.status).toBe('ok');
    expect(output.artifacts).toHaveLength(1);
    expect(output.artifacts[0]?.name).toMatch(/\.chunks\.json$/u);
    const indexResource = await client.readResource({ uri: output.artifacts[0]!.uri });
    const indexContent = indexResource.contents[0];
    const index = JSON.parse(
      indexContent !== undefined && 'text' in indexContent ? indexContent.text : '',
    ) as ChunkedArtifactIndex;
    const chunks: Buffer[] = [];
    for (const chunk of index.chunks) {
      const resource = await client.readResource({ uri: chunk.uri });
      const content = resource.contents[0];
      chunks.push(
        Buffer.from(content !== undefined && 'blob' in content ? content.blob : '', 'base64'),
      );
    }
    const graphArtifact = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      graph: { elements: Array<{ name: string; rawSource: string }> };
    };
    expect(graphArtifact.graph.elements).toHaveLength(601);
    expect(
      graphArtifact.graph.elements.some(
        ({ name, rawSource }) => name === 'generated_icon_599' && rawSource.includes('unknown_599'),
      ),
    ).toBe(true);
  });
});
