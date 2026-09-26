import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256Bytes } from '../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../src/hoi4_agent_tools/core/workspace.js';
import { AgentNudger } from '../src/hoi4_agent_tools/map/index.js';
import { EventChainViewer } from '../src/hoi4_agent_tools/event/index.js';
import { PACKAGE_VERSION } from '../src/hoi4_agent_tools/version.js';

// Real external-source examples only. Synthetic probability pools belong in tests
// and explicitly labelled API examples, never in the public visual comparison.
const gameRoot = process.env.HOI4_GAME_ROOT;
const modRoot = process.env.HOI4_EXTERNAL_MOD_ROOT;
if (gameRoot === undefined || modRoot === undefined)
  throw new Error('Set HOI4_GAME_ROOT and HOI4_EXTERNAL_MOD_ROOT');
await Promise.all([access(gameRoot), access(modRoot)]);
const output = path.resolve('docs/images/comparisons/source');
const runtime = await mkdtemp(path.join(tmpdir(), 'hoi4-source-examples-'));
try {
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(runtime, 'state'),
    storageRoots: [path.join(runtime, 'output')],
    workspaces: [
      {
        id: 'examples',
        name: 'Source examples',
        root: modRoot,
        gameRoot,
        artifactRoot: path.join(runtime, 'output/artifacts'),
        cacheRoot: path.join(runtime, 'output/cache'),
      },
    ],
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  await mkdir(output, { recursive: true });
  const nudger = new AgentNudger(
    engine.resolver,
    engine.transactions,
    engine.artifacts,
    engine.scanner,
  );
  const map = await nudger.renderAndStore('examples', {
    layer: 'state',
    overlays: ['coastlines', 'ports', 'victory-points', 'supply-nodes', 'railways'],
    scale: 1,
  });
  await writeFile(path.join(output, 'map-mcp.png'), map.bundle.png);
  process.stdout.write(`Map rendered at ${map.bundle.width}x${map.bundle.height}\n`);

  const viewer = new EventChainViewer(engine);
  const eventId = process.env.HOI4_EXAMPLE_EVENT_ID ?? 'chaosx.nr7.60';
  const event = await viewer.renderAndStore({
    workspaceId: 'examples',
    view: 'options',
    selector: { kind: 'event', eventId },
    direction: 'downstream',
    maxDepth: 3,
    maxNodes: 80,
    includeHtml: false,
    compactLayout: true,
  });
  if (event.render.selectedNodeIds.length === 0) throw new Error('No matching real event source');
  await writeFile(path.join(output, 'event-chain-mcp.png'), event.render.png);
  const manifest = {
    toolVersion: PACKAGE_VERSION,
    offline: true,
    source: 'Chaos Redux with installed vanilla dependencies',
    map: {
      sourceRevision: map.revision,
      filesScanned: map.filesScanned.length,
      width: map.bundle.width,
      height: map.bundle.height,
      pngSha256: sha256Bytes(map.bundle.png),
      layer: 'state',
      overlays: ['coastlines', 'ports', 'victory-points', 'supply-nodes', 'railways'],
    },
    event: {
      eventId,
      view: 'options',
      compactLayout: true,
      direction: 'downstream',
      maxDepth: 3,
      maxNodes: 80,
      sourceRevision: event.render.graphRevision,
      selectedNodeCount: event.render.selectedNodeIds.length,
      omittedNodeCount: event.render.omittedNodeCount,
      pngSha256: sha256Bytes(event.render.png),
    },
  };
  await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
} finally {
  await rm(runtime, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
