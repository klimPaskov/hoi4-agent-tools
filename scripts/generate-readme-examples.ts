import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { serverConfigurationSchema } from '../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../src/hoi4_agent_tools/core/engine.js';
import { parseClausewitz } from '../src/hoi4_agent_tools/core/source/index.js';
import { WorkspaceResolver } from '../src/hoi4_agent_tools/core/workspace.js';
import { focusDomainScanPatterns } from '../src/hoi4_agent_tools/core/domain-scan-patterns.js';
import {
  FocusWorkbench,
  importFocusTrees,
  resolveFocusPresentation,
} from '../src/hoi4_agent_tools/focus/index.js';
import {
  ScriptedGuiStudio,
  defaultPreviewScenario,
  parsePreviewScenario,
} from '../src/hoi4_agent_tools/gui/index.js';
import { AgentNudger } from '../src/hoi4_agent_tools/map/index.js';
import { EventChainViewer } from '../src/hoi4_agent_tools/event/index.js';
import { TechnologyTreeViewer } from '../src/hoi4_agent_tools/technology/index.js';
import {
  ProbabilityAnalyzer,
  renderProbabilityResult,
  type ProbabilitySequenceRequest,
} from '../src/hoi4_agent_tools/probability/index.js';

const gameRoot = process.env.HOI4_GAME_ROOT;
const modRoot = process.env.HOI4_EXTERNAL_MOD_ROOT;
const communistScreenshot = process.env.HOI4_COMMUNIST_SCREENSHOT;
const chaosMeterScreenshot = process.env.HOI4_CHAOS_METER_SCREENSHOT;

if (
  gameRoot === undefined ||
  modRoot === undefined ||
  communistScreenshot === undefined ||
  chaosMeterScreenshot === undefined
) {
  throw new Error(
    'Set HOI4_GAME_ROOT, HOI4_EXTERNAL_MOD_ROOT, HOI4_COMMUNIST_SCREENSHOT, and HOI4_CHAOS_METER_SCREENSHOT',
  );
}

await Promise.all(
  [gameRoot, modRoot, communistScreenshot, chaosMeterScreenshot].map((target) => access(target)),
);

const outputRoot = path.resolve('docs', 'images', 'readme');
const workspaceId = 'readme-examples';
const stages = ['gui', 'focus', 'technology', 'map', 'event', 'probability'] as const;
type Stage = (typeof stages)[number];
const requestedStage = process.env.HOI4_README_STAGE as Stage | undefined;

async function runStage(stage: Stage): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
      cwd: process.cwd(),
      env: { ...process.env, HOI4_README_STAGE: stage },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`README example stage ${stage} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function writePng(
  name: string,
  bytes: Buffer,
  options: { maximumWidth?: number; trimRendererBackground?: boolean } = {},
): Promise<void> {
  let pipeline = sharp(bytes, { limitInputPixels: 268_402_689 });
  if (options.trimRendererBackground === true)
    pipeline = pipeline.trim({ background: '#17202a', threshold: 8 });
  const metadata = await pipeline.metadata();
  if (options.maximumWidth !== undefined && metadata.width > options.maximumWidth) {
    pipeline = pipeline.resize({ width: options.maximumWidth, withoutEnlargement: true });
  }
  await writeFile(
    path.join(outputRoot, name),
    await pipeline
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer(),
  );
}

if (requestedStage === undefined) {
  await mkdir(outputRoot, { recursive: true });
  await Promise.all([
    copyFile(communistScreenshot, path.join(outputRoot, 'communist-insurgency-ingame.png')),
    copyFile(chaosMeterScreenshot, path.join(outputRoot, 'chaos-meter-ingame.png')),
  ]);
  for (const stage of stages) await runStage(stage);
} else {
  if (!stages.includes(requestedStage))
    throw new Error(`Unknown README example stage: ${requestedStage}`);
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), `hoi4-agent-readme-${requestedStage}-`));

  try {
    await mkdir(outputRoot, { recursive: true });

    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(runtimeRoot, 'server-state'),
      storageRoots: [path.join(runtimeRoot, 'artifacts'), path.join(runtimeRoot, 'cache')],
      workspaces: [
        {
          id: workspaceId,
          name: 'README production examples',
          root: modRoot,
          gameRoot,
          artifactRoot: path.join(runtimeRoot, 'artifacts'),
          cacheRoot: path.join(runtimeRoot, 'cache'),
        },
      ],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    await engine.initialize();

    if (requestedStage === 'gui') {
      const studio = new ScriptedGuiStudio(
        engine.resolver,
        engine.transactions,
        engine.scanner,
        engine.artifacts,
      );
      const guiExamples = [
        {
          windowName: 'communism_spread_dashboard_container',
          output: 'communist-insurgency-mcp.png',
          flags: {},
          visibility: {},
          seed: 'readme-communist-insurgency-v3',
        },
        {
          windowName: 'chaos_meter_popup_window',
          output: 'chaos-meter-mcp.png',
          flags: { chaos_meter_deaths_tab: true },
          visibility: {
            chaos_meter_status_content_window: false,
            chaos_meter_history_content_window: false,
            chaos_meter_air_content_window: false,
            chaos_meter_condemnation_content_window: false,
            chaos_meter_deaths_content_window: true,
            status_tab_button_idle: true,
            status_tab_button_active: false,
            history_tab_button_idle: true,
            history_tab_button_active: false,
            air_tab_button_idle: true,
            air_tab_button_active: false,
            condemnation_tab_button_idle: true,
            condemnation_tab_button_active: false,
            deaths_tab_button_idle: false,
            deaths_tab_button_active: true,
          },
          seed: 'readme-chaos-meter-v3',
        },
        {
          windowName: 'chaosx_settings_window',
          output: 'settings-events-mcp.png',
          flags: { chaosx_settings_open: true, show_trigger_events_menu: true },
          visibility: {
            trigger_events_content: true,
            events_content: true,
            event_clusters_content: false,
            timer_interval_content: false,
            tag_management_content: false,
            chaos_meter_content: false,
            advanced_settings_content: false,
            miscellaneous_content: false,
          },
          seed: 'readme-settings-events-v3',
        },
        {
          windowName: 'chaosx_settings_window',
          output: 'settings-advanced-mcp.png',
          flags: { chaosx_settings_open: true, show_advanced_settings_menu: true },
          visibility: {
            trigger_events_content: false,
            events_content: false,
            event_clusters_content: false,
            timer_interval_content: false,
            tag_management_content: false,
            chaos_meter_content: false,
            advanced_settings_content: true,
            miscellaneous_content: false,
          },
          seed: 'readme-settings-advanced-v3',
        },
      ] as const;
      const requestedGuiExample = process.env.HOI4_README_GUI_EXAMPLE;
      const selectedGuiExamples =
        requestedGuiExample === undefined
          ? guiExamples
          : guiExamples.filter(({ output }) => output === requestedGuiExample);
      if (selectedGuiExamples.length === 0)
        throw new Error(`Unknown README GUI example: ${requestedGuiExample}`);
      for (const example of selectedGuiExamples) {
        const scenario = parsePreviewScenario({
          ...defaultPreviewScenario(example.output.replace('.png', '')),
          flags: example.flags,
          visibility: example.visibility,
        });
        const rendered = await studio.renderAndStore({
          workspaceId,
          windowName: example.windowName,
          scenario,
          generatedScenarios: {
            enabled: true,
            count: 1,
            seed: example.seed,
            idPrefix: 'readme',
            preservePlaceholder: false,
            numericMinimum: 0,
            numericMaximum: 100,
            integerValues: true,
            listRowsMinimum: 2,
            listRowsMaximum: 4,
            trueProbability: 0.7,
            visibility: example.output === 'communist-insurgency-mcp.png' ? 'show-all' : 'varied',
            elementStates: 'normal',
            textSamples: ['Stable', 'Available', 'Ready', 'In Progress'],
          },
          states: ['normal'],
          resolutions: [{ width: 1920, height: 1080, uiScale: 1 }],
        });
        const cropped = rendered.render.images.find(({ variant }) => variant === 'cropped');
        if (cropped === undefined)
          throw new Error(`Missing cropped render for ${example.windowName}`);
        await writePng(example.output, cropped.png, { trimRendererBackground: true });
      }
      studio.clearCaches();
    }

    if (requestedStage === 'focus') {
      const workspace = engine.resolver.get(workspaceId);
      const snapshot = await engine.scan(workspaceId, {
        patterns: focusDomainScanPatterns(workspace),
      });
      const focusPath = 'common/national_focus/012_africa_continental_focus_tree.txt';
      const focusFile = snapshot.files.find(
        ({ rootKind, relativePath, shadowedBy }) =>
          rootKind === 'mod' && relativePath === focusPath && shadowedBy === undefined,
      );
      if (focusFile === undefined) throw new Error(`Missing ${focusPath}`);
      const focusPlans = importFocusTrees(
        parseClausewitz(focusFile.bytes, focusFile.displayPath),
      ).plans;
      const focusPlan = focusPlans.sort(
        (left, right) => right.focuses.length - left.focuses.length,
      )[0];
      if (focusPlan === undefined) throw new Error(`No focus tree in ${focusPath}`);
      const focusPresentation = await resolveFocusPresentation({
        plans: [focusPlan],
        files: snapshot.files,
        index: snapshot.index,
        scanner: engine.scanner,
        workspace,
      });
      const focusWorkbench = new FocusWorkbench(
        engine.resolver,
        engine.transactions,
        engine.artifacts,
      );
      const focus = await focusWorkbench.renderAndStore(workspaceId, focusPlan, {
        outputScale: 0.5,
        presentation: focusPresentation,
        index: snapshot.index,
      });
      await writePng('focus-tree-mcp.png', focus.bundle.png, { maximumWidth: 2_000 });
    }

    if (requestedStage === 'technology') {
      const technologyViewer = new TechnologyTreeViewer(engine);
      const technology = await technologyViewer.renderAndStore({
        workspaceId,
        view: 'folder',
        folderId: 'infantry_folder',
        maxNodes: 1_000,
        includeHtml: false,
      });
      await writePng('technology-tree-mcp.png', technology.render.png, { maximumWidth: 2_000 });
    }

    if (requestedStage === 'map') {
      const nudger = new AgentNudger(
        engine.resolver,
        engine.transactions,
        engine.artifacts,
        engine.scanner,
      );
      const map = await nudger.renderAndStore(workspaceId, {
        layer: 'state',
        overlays: ['coastlines', 'ports', 'victory-points', 'supply-nodes', 'railways'],
        scale: 1,
      });
      await writePng('map-mcp.png', map.bundle.png, { maximumWidth: 2_000 });
    }

    if (requestedStage === 'event') {
      const eventViewer = new EventChainViewer(engine);
      const eventGraph = await eventViewer.scan(workspaceId);
      const namespaceCounts = new Map<string, number>();
      for (const node of eventGraph.nodes) {
        if (
          node.kind !== 'event' ||
          node.namespace === undefined ||
          node.sourcePath?.startsWith('mod:') !== true
        )
          continue;
        namespaceCounts.set(node.namespace, (namespaceCounts.get(node.namespace) ?? 0) + 1);
      }
      const eventNamespace = [...namespaceCounts.entries()]
        .filter(([, count]) => count >= 8)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
      if (eventNamespace === undefined)
        throw new Error('No representative mod event namespace found');
      const event = await eventViewer.renderAndStore({
        workspaceId,
        view: 'overview',
        selector: { kind: 'namespace', namespace: eventNamespace },
        maxDepth: 5,
        maxNodes: 120,
        includeHtml: false,
      });
      await writePng('event-chain-mcp.png', event.render.png, { maximumWidth: 2_000 });
    }

    if (requestedStage === 'probability') {
      const sequenceRequest = JSON.parse(
        await readFile(
          path.resolve('examples', 'probability', 'adaptive-event-sequence-input.json'),
          'utf8',
        ),
      ) as Omit<ProbabilitySequenceRequest, 'workspaceId'>;
      const probabilityAnalyzer = new ProbabilityAnalyzer(engine);
      const probability = await probabilityAnalyzer.sequence({
        ...sequenceRequest,
        workspaceId,
        samples: 25_000,
        outputs: ['json'],
      });
      const probabilityRender = await renderProbabilityResult(probability, ['ranking'], false, {
        kind: 'readme-probability-example',
        toolVersion: '3.0.0',
        schemaVersion: 'probability-analysis.v1',
        sourceHashes: { aggregate: probability.metadata.sourceHash },
      });
      const probabilityPng = probabilityRender.writes.find(
        ({ name, mimeType }) => name.endsWith('-ranking.png') && mimeType === 'image/png',
      )?.content;
      if (!Buffer.isBuffer(probabilityPng)) throw new Error('Missing probability ranking PNG');
      await writePng('probability-mcp.png', probabilityPng, { maximumWidth: 2_000 });
    }
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}
