/**
 * Run one campaign map end to end through the MCP server (request ZR-4): preview, write, inspect,
 * then independent checks of the written files. The map runs in a fresh test mod with the
 * installed game read-only beneath it; nothing outside the run folder is written.
 *
 * Usage: tsx scripts/map-campaign/run-one.ts --id <map id> --store <dir> --game <game root>
 *        [--maps <dir>] [--manifest <file>] [--options <json>]
 * Writes `<store>/results/<id>.json` and prints its path.
 */
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { BmpImage } from '../../src/hoi4_agent_tools/map/bmp.js';
import { WATER_SURFACE_HEIGHT } from '../../src/hoi4_agent_tools/map/water.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';
import { manifestSchema } from './manifest.js';

interface PublicResult {
  status: string;
  code: string;
  blockers?: { code: string; message: string }[];
  diagnostics?: { code: string; severity: string; message: string }[];
  validation?: { passed: boolean; checks: { id: string; passed: boolean; message: string }[] };
  data?: Record<string, unknown>;
  changedFiles?: string[];
}

interface StepSummary {
  status: string;
  code: string;
  milliseconds: number;
  blockers: string[];
  errors: string[];
  warnings: Record<string, number>;
  failedChecks: string[];
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function summarize(result: PublicResult, milliseconds: number): StepSummary {
  const warnings: Record<string, number> = {};
  for (const diagnostic of result.diagnostics ?? []) {
    if (diagnostic.severity === 'warning')
      warnings[diagnostic.code] = (warnings[diagnostic.code] ?? 0) + 1;
  }
  return {
    status: result.status,
    code: result.code,
    milliseconds,
    blockers: (result.blockers ?? []).map(({ code, message }) =>
      `${code}: ${message}`.slice(0, 300),
    ),
    errors: (result.diagnostics ?? [])
      .filter(({ severity }) => severity === 'error')
      .map(({ code, message }) => `${code}: ${message}`.slice(0, 300)),
    warnings,
    failedChecks: (result.validation?.checks ?? [])
      .filter(({ passed }) => !passed)
      .map(({ id, message }) => `${id}: ${message}`.slice(0, 300)),
  };
}

/** Facts read back from the written files, independent of the server's own validation. */
async function writtenChecks(modRoot: string): Promise<Record<string, unknown>> {
  const provinces = BmpImage.decode(await readFile(path.join(modRoot, 'map', 'provinces.bmp')));
  const heights = BmpImage.decode(await readFile(path.join(modRoot, 'map', 'heightmap.bmp')));
  const definition = (await readFile(path.join(modRoot, 'map', 'definition.csv'), 'utf8'))
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(';'));
  const typeByColor = new Map<number, string>();
  const ids: number[] = [];
  for (const row of definition) {
    const id = Number(row[0]);
    if (!Number.isInteger(id) || id === 0) continue;
    ids.push(id);
    typeByColor.set((Number(row[1]) << 16) | (Number(row[2]) << 8) | Number(row[3]), row[4] ?? '');
  }
  ids.sort((left, right) => left - right);
  const contiguous = ids.every((id, index) => id === index + 1);
  let land = 0;
  let landBelowWater = 0;
  let waterAboveSurface = 0;
  let unknownColor = 0;
  const sameSize = provinces.width === heights.width && provinces.height === heights.height;
  if (sameSize) {
    for (let y = 0; y < provinces.height; y++) {
      for (let x = 0; x < provinces.width; x++) {
        const { r, g, b } = provinces.rgbAt(x, y);
        const type = typeByColor.get((r << 16) | (g << 8) | b);
        if (type === undefined) {
          unknownColor += 1;
          continue;
        }
        const height = heights.paletteIndexAt(x, y);
        if (type === 'land') {
          land += 1;
          if (height < WATER_SURFACE_HEIGHT) landBelowWater += 1;
        } else if (height > WATER_SURFACE_HEIGHT) waterAboveSurface += 1;
      }
    }
  }
  return {
    width: provinces.width,
    height: provinces.height,
    heightmapSameSize: sameSize,
    provinces: ids.length,
    contiguousIds: contiguous,
    landShare: Number((land / (provinces.width * provinces.height)).toFixed(4)),
    landBelowWater,
    waterAboveSurface,
    pixelsWithoutDefinition: unknownColor,
  };
}

async function main(): Promise<void> {
  const id = option('--id');
  const store = option('--store');
  const game = option('--game');
  if (id === undefined || store === undefined || game === undefined) {
    throw new Error('Usage: run-one.ts --id <id> --store <dir> --game <game root>');
  }
  const manifestPath = path.resolve(
    option('--manifest') ?? 'docs/plans/map-campaign/manifest.json',
  );
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  const entry = manifest.maps.find((map) => map.id === id);
  if (entry === undefined) throw new Error(`Unknown map ${id}`);
  const extraOptions = JSON.parse(option('--options') ?? '{}') as Record<string, unknown>;

  const run = path.join(store, 'runs', id);
  await rm(run, { recursive: true, force: true });
  const modRoot = path.join(run, 'mods', 'campaign');
  const imagePath = `reference/${path.posix.basename(entry.file)}`;
  await mkdir(path.join(modRoot, 'reference'), { recursive: true });
  const maps = option('--maps') ?? path.join(store, 'maps');
  await copyFile(path.join(maps, entry.file), path.join(modRoot, imagePath));
  await writeFile(
    path.join(modRoot, 'descriptor.mod'),
    'version="1.0"\nname="Map campaign"\nsupported_version="1.*"\n',
  );

  const started = performance.now();
  const result: Record<string, unknown> = { id, title: entry.title, category: entry.category };
  try {
    const engine = new CoreEngine(
      await WorkspaceResolver.create(
        serverConfigurationSchema.parse({
          version: 1,
          serverStateRoot: path.join(run, 'state'),
          workspaceStorageRoot: path.join(run, 'storage'),
          modRoots: [path.join(run, 'mods')],
          gameRoot: game,
        }),
      ),
    );
    await engine.initialize();
    const server = createMcpServer(engine);
    const client = new Client({ name: 'map-campaign', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (name: string, arguments_: Record<string, unknown>) => {
      const before = performance.now();
      const called = await client.callTool({ name, arguments: arguments_ }, undefined, {
        timeout: 1_800_000,
      });
      return {
        content: called.structuredContent as PublicResult,
        milliseconds: Math.round(performance.now() - before),
      };
    };
    const operation = {
      id: 'world',
      kind: 'create_world',
      reference: { imagePath },
      ...extraOptions,
    };
    const preview = await call('hoi4.map_rewrite', {
      workspaceId: 'campaign',
      preview: true,
      operations: [operation],
    });
    result.preview = summarize(preview.content, preview.milliseconds);
    const write = await call('hoi4.map_rewrite', {
      workspaceId: 'campaign',
      operations: [operation],
    });
    result.write = summarize(write.content, write.milliseconds);
    result.changedFiles = write.content.changedFiles?.length ?? 0;
    if (write.content.status === 'ok') {
      const inspect = await call('hoi4.map_inspect', {
        workspaceId: 'campaign',
        includeOverview: false,
      });
      result.inspect = summarize(inspect.content, inspect.milliseconds);
      result.files = await writtenChecks(modRoot);
    }
    await client.close();
    await server.close();
  } catch (error) {
    result.crash =
      error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 500) : String(error);
  }
  result.milliseconds = Math.round(performance.now() - started);
  result.peakRssMiB = Math.round(process.resourceUsage().maxRSS / 1024);
  // Keep a failed run's mod and artifacts for triage; a passing world is only its result.
  const files = result.files as Record<string, unknown> | undefined;
  const passed =
    result.crash === undefined &&
    (result.write as StepSummary | undefined)?.status === 'ok' &&
    (result.inspect as StepSummary | undefined)?.status === 'ok' &&
    files?.contiguousIds === true &&
    files.landBelowWater === 0 &&
    files.waterAboveSurface === 0 &&
    files.pixelsWithoutDefinition === 0;
  result.passed = passed;
  if (passed && !process.argv.includes('--keep')) await rm(run, { recursive: true, force: true });
  const target = path.join(store, 'results', `${id}.json`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${target}\n`);
}

await main();
