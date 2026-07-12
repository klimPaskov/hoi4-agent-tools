import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
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

interface OperationResult {
  status: 'ok' | 'blocked' | 'error';
  code: string;
  changedFiles: string[];
  artifacts: Array<{ uri: string; name: string; mimeType: string }>;
  data: Record<string, unknown>;
}

type ProvinceRowRun = [y: number, startX: number, endXExclusive: number];

interface ProvinceGeometryArtifact {
  schemaVersion: 1;
  revision: string;
  dimensions: { width: number; height: number };
  coordinateSystem: {
    origin: 'top-left';
    xDirection: 'right';
    yDirection: 'down';
  };
  rowRunFormat: ['y', 'startX', 'endXExclusive'];
  requestedProvinceIds: number[];
  unknownProvinceIds: number[];
  missingGeometryProvinceIds: number[];
  pixelCount: number;
  rowRunCount: number;
  provinces: Array<{
    provinceId: number;
    pixelCount: number;
    bounds: {
      minX: number;
      minY: number;
      maxXExclusive: number;
      maxYExclusive: number;
    };
    rowRunCount: number;
    rowRuns: ProvinceRowRun[];
  }>;
}

const cleanup: Array<() => Promise<void>> = [];
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((callback) => callback()));
});

function resultOf(value: Awaited<ReturnType<Client['callTool']>>): OperationResult {
  return value.structuredContent as unknown as OperationResult;
}

async function connect(temporary: string, workspace: Record<string, unknown>): Promise<Client> {
  const artifactRoot = path.join(temporary, 'runtime', 'artifacts');
  const cacheRoot = path.join(temporary, 'runtime', 'cache');
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(temporary, 'server-state'),
    storageRoots: [artifactRoot, cacheRoot],
    workspaces: [{ ...workspace, artifactRoot, cacheRoot }],
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  await engine.initialize();
  const server = createMcpServer(engine);
  const client = new Client({ name: 'map-geometry-artifact-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport as unknown as Transport);
  await client.connect(clientTransport as unknown as Transport);
  cleanup.push(
    async () => client.close(),
    async () => server.close(),
    async () => rm(temporary, { recursive: true, force: true }),
  );
  return client;
}

function geometryLink(result: OperationResult): OperationResult['artifacts'][number] {
  const artifact = result.artifacts.find(
    ({ name, mimeType }) =>
      mimeType === 'application/json' && name.startsWith('map-province-geometry.'),
  );
  if (artifact === undefined) throw new Error('Exact province geometry artifact is missing');
  return artifact;
}

async function readGeometryArtifact(
  client: Client,
  uri: string,
): Promise<ProvinceGeometryArtifact> {
  const resource = await client.readResource({ uri });
  const content = resource.contents[0];
  if (content === undefined || !('text' in content)) {
    throw new Error('Expected a complete JSON text resource');
  }
  return JSON.parse(content.text) as ProvinceGeometryArtifact;
}

describe('MCP province geometry artifact', () => {
  it('exports canonical runs that an MCP client turns into an exact rewrite subset', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-map-geometry-'));
    const fixtureRoots = path.join(repositoryRoot, 'fixtures', 'map', 'roots');
    const game = path.join(temporary, 'game');
    const dependency = path.join(temporary, 'dependency');
    const mod = path.join(temporary, 'mod');
    await Promise.all([
      cp(path.join(fixtureRoots, 'game'), game, { recursive: true }),
      cp(path.join(fixtureRoots, 'dependency'), dependency, { recursive: true }),
      cp(path.join(fixtureRoots, 'mod'), mod, { recursive: true }),
    ]);
    const client = await connect(temporary, {
      id: 'map-geometry',
      name: 'Synthetic map geometry workflow',
      root: mod,
      gameRoot: game,
      dependencyRoots: [dependency],
    });
    const inspectArguments = {
      workspaceId: 'map-geometry',
      provinceIds: [4, 999],
    };

    const oversizedSelector = await client.callTool({
      name: 'hoi4.map_inspect',
      arguments: {
        workspaceId: 'map-geometry',
        provinceIds: Array.from({ length: 33 }, (_unused, provinceId) => provinceId),
      },
    });
    expect(oversizedSelector.isError).toBe(true);
    expect(JSON.stringify(oversizedSelector.content)).toContain('32');

    const inspected = resultOf(
      await client.callTool({ name: 'hoi4.map_inspect', arguments: inspectArguments }),
    );
    expect(inspected).toMatchObject({
      status: 'ok',
      code: 'MAP_INSPECTED',
      data: {
        provinceGeometryCount: 1,
        unknownProvinceIds: [999],
        missingGeometryProvinceIds: [],
      },
    });
    const firstGeometryLink = geometryLink(inspected);
    const artifact = await readGeometryArtifact(client, firstGeometryLink.uri);
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      revision: inspected.data.revision,
      coordinateSystem: {
        origin: 'top-left',
        xDirection: 'right',
        yDirection: 'down',
      },
      rowRunFormat: ['y', 'startX', 'endXExclusive'],
      requestedProvinceIds: [4, 999],
      unknownProvinceIds: [999],
      missingGeometryProvinceIds: [],
    });
    expect(artifact.dimensions.width).toBe(inspected.data.width);
    expect(artifact.dimensions.height).toBe(inspected.data.height);
    expect(artifact.pixelCount).toBe(inspected.data.provinceGeometryPixelCount);
    expect(artifact.rowRunCount).toBe(inspected.data.provinceGeometryRowRunCount);

    for (const province of artifact.provinces) {
      expect(province.rowRunCount).toBe(province.rowRuns.length);
      expect(
        province.rowRuns.reduce(
          (count, [_y, startX, endXExclusive]) => count + endXExclusive - startX,
          0,
        ),
      ).toBe(province.pixelCount);
      expect(province.rowRuns).toEqual(
        [...province.rowRuns].sort(
          ([leftY, leftStartX], [rightY, rightStartX]) =>
            leftY - rightY || leftStartX - rightStartX,
        ),
      );
    }

    const repeatedInspection = resultOf(
      await client.callTool({ name: 'hoi4.map_inspect', arguments: inspectArguments }),
    );
    expect(geometryLink(repeatedInspection).uri).toBe(firstGeometryLink.uri);

    const sourceGeometry = artifact.provinces.find(({ provinceId }) => provinceId === 4);
    if (sourceGeometry === undefined) throw new Error('Province 4 geometry was not exported');
    const sourceWidth = sourceGeometry.bounds.maxXExclusive - sourceGeometry.bounds.minX;
    const sourceHeight = sourceGeometry.bounds.maxYExclusive - sourceGeometry.bounds.minY;
    const selection = {
      minX: sourceGeometry.bounds.minX + Math.floor(sourceWidth / 4),
      maxXExclusive: sourceGeometry.bounds.minX + Math.floor(sourceWidth / 2),
      minY: sourceGeometry.bounds.minY + Math.floor(sourceHeight / 4),
      maxYExclusive: sourceGeometry.bounds.minY + Math.floor((sourceHeight * 3) / 4),
    };
    const pixels = sourceGeometry.rowRuns.flatMap(([y, runStartX, runEndXExclusive]) => {
      if (y < selection.minY || y >= selection.maxYExclusive) return [];
      const startX = Math.max(runStartX, selection.minX);
      const endXExclusive = Math.min(runEndXExclusive, selection.maxXExclusive);
      return Array.from({ length: Math.max(0, endXExclusive - startX) }, (_unused, offset) => ({
        x: startX + offset,
        y,
      }));
    });
    expect(pixels.length).toBeGreaterThan(0);
    expect(pixels.length).toBeLessThan(sourceGeometry.pixelCount);

    const rewritten = resultOf(
      await client.callTool({
        name: 'hoi4.map_rewrite',
        arguments: {
          workspaceId: 'map-geometry',
          operations: [
            {
              id: 'artifact-derived-split',
              kind: 'split_province',
              sourceProvinceId: 4,
              geometry: { kind: 'pixels', pixels },
              definition: { method: 'inherit-source' },
              distribution: {
                state: 'inherit-source',
                strategicRegion: 'inherit-source',
                victoryPoints: 'retain-source',
                provinceBuildings: 'retain-source',
                ports: 'retain-source',
                supplyNodes: 'retain-source',
                railways: 'retain-source',
                adjacencies: 'retain-source',
                positions: 'retain-source',
                entityLocators: 'retain-source',
              },
            },
          ],
        },
      }),
    );
    expect(rewritten).toMatchObject({
      status: 'ok',
      code: 'MAP_CHANGES_APPLIED',
      data: { execution: 'applied' },
    });
    expect(rewritten.changedFiles).toEqual(
      expect.arrayContaining(['map/definition.csv', 'map/provinces.bmp']),
    );
    expect(await readFile(path.join(mod, 'map', 'definition.csv'), 'utf8')).toContain('5;');
  }, 120_000);
});
