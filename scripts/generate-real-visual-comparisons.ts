import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { serverConfigurationSchema } from '../src/hoi4_agent_tools/core/configuration.js';
import { focusDomainScanPatterns } from '../src/hoi4_agent_tools/core/domain-scan-patterns.js';
import { CoreEngine } from '../src/hoi4_agent_tools/core/engine.js';
import { parseClausewitz } from '../src/hoi4_agent_tools/core/source/index.js';
import { WorkspaceResolver } from '../src/hoi4_agent_tools/core/workspace.js';
import {
  FocusWorkbench,
  importFocusTrees,
  resolveFocusPresentation,
} from '../src/hoi4_agent_tools/focus/index.js';
import { TechnologyTreeViewer } from '../src/hoi4_agent_tools/technology/index.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const outputRoot = path.join(projectRoot, 'docs', 'images', 'comparisons');
const gameRoot = process.env.HOI4_GAME_ROOT;
const modRoot = process.env.HOI4_EXTERNAL_MOD_ROOT;
if (gameRoot === undefined || modRoot === undefined)
  throw new Error('Set HOI4_GAME_ROOT and HOI4_EXTERNAL_MOD_ROOT');
await Promise.all([access(gameRoot), access(modRoot)]);

const references = [
  ['HOI4_FURY_SCREENSHOT', 'fury-ingame.png'],
  ['HOI4_HOLY_REALM_SCREENSHOT', 'holy-realm-ingame.png'],
  ['HOI4_UTOPIA_SCREENSHOT', 'utopia-ingame.png'],
  ['HOI4_INFANTRY_SCREENSHOT', 'infantry-ingame.png'],
  ['HOI4_CHEMICAL_SCREENSHOT', 'chemical-ingame.png'],
  ['HOI4_CHEMICAL_CURRENT_SCREENSHOT', 'chemical-recent-ingame.png'],
  ['HOI4_CHEMICAL_CARDS_SCREENSHOT', 'chemical-cards-ingame.png'],
  ['HOI4_BIOLOGICAL_CARDS_SCREENSHOT', 'biological-cards-ingame.png'],
] as const;

const focusTrees = [
  ['common/national_focus/007_fury_focus_tree.txt', 'fury_focus_tree', 'fury-mcp.png'],
  ['common/national_focus/003_holy_realm.txt', 'THR_focus', 'holy-realm-mcp.png'],
  [
    'common/national_focus/015_utopia_manifesto_focus_tree.txt',
    'utopia_manifesto_tree',
    'utopia-mcp.png',
  ],
] as const;
const technologyFolders = [
  ['infantry_folder', 'infantry-mcp.png'],
  ['chemical_warfare_folder', 'chemical-mcp.png'],
  ['biowarfare_folder', 'biological-mcp.png'],
] as const;
const historicalChemicalRevision = '4efc01fc87f1137e98c864f928dd5603e6b7d2f1';
const historicalChemicalSources = [
  'common/technologies/chaosx_technologies.txt',
  'interface/countrytechtreeview.gui',
] as const;
const comparisonStage = process.env.HOI4_COMPARISON_STAGE ?? 'all';
if (!['all', 'current', 'historical'].includes(comparisonStage))
  throw new Error('HOI4_COMPARISON_STAGE must be all, current, or historical');
const historicalOnly = comparisonStage === 'historical';
const currentOnly = comparisonStage === 'current';

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'hoi4-real-visual-comparisons-'));
try {
  await mkdir(outputRoot, { recursive: true });
  const priorManifest =
    comparisonStage !== 'all'
      ? (JSON.parse(await readFile(path.join(outputRoot, 'manifest.json'), 'utf8')) as {
          focusSourceRevision: string;
          focus: unknown[];
          technology: unknown[];
          historicalChemical: unknown;
        })
      : undefined;
  let focusSourceRevision = priorManifest?.focusSourceRevision;
  const focusManifest: unknown[] = historicalOnly ? (priorManifest?.focus ?? []) : [];
  const technologyManifest: unknown[] = historicalOnly ? (priorManifest?.technology ?? []) : [];
  if (!historicalOnly) {
    for (const [variable, filename] of references) {
      const source = process.env[variable];
      const destination = path.join(outputRoot, filename);
      if (source === undefined) {
        await access(destination);
        continue;
      }
      await access(source);
      await copyFile(source, destination);
    }
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(temporaryRoot, 'state'),
      storageRoots: [path.join(temporaryRoot, 'artifacts'), path.join(temporaryRoot, 'cache')],
      workspaces: [
        {
          id: 'real-visual-comparisons',
          name: 'User-approved game comparison',
          root: modRoot,
          gameRoot,
          kind: 'mod',
          artifactRoot: path.join(temporaryRoot, 'artifacts'),
          cacheRoot: path.join(temporaryRoot, 'cache'),
        },
      ],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    await engine.initialize();
    const workspaceId = 'real-visual-comparisons';
    const workspace = engine.resolver.get(workspaceId);
    const focusSnapshot = await engine.scan(workspaceId, {
      patterns: focusDomainScanPatterns(workspace),
    });
    focusSourceRevision = focusSnapshot.revision;
    const focusWorkbench = new FocusWorkbench(
      engine.resolver,
      engine.transactions,
      engine.artifacts,
    );
    for (const [sourcePath, treeId, filename] of focusTrees) {
      const source = focusSnapshot.files.find(
        (file) =>
          file.rootKind === 'mod' &&
          file.relativePath === sourcePath &&
          file.shadowedBy === undefined,
      );
      if (source === undefined) throw new Error(`Missing active focus source: ${sourcePath}`);
      const plan = importFocusTrees(parseClausewitz(source.bytes, source.displayPath)).plans.find(
        ({ id }) => id === treeId,
      );
      if (plan === undefined) throw new Error(`Missing focus tree ${treeId} in ${sourcePath}`);
      const presentation = await resolveFocusPresentation({
        plans: [plan],
        files: focusSnapshot.files,
        index: focusSnapshot.index,
        scanner: engine.scanner,
        workspace,
      });
      const result = await focusWorkbench.renderAndStore(workspaceId, plan, {
        horizontalSpacing: 96,
        verticalSpacing: 130,
        outputScale: 0.5,
        presentation,
        index: focusSnapshot.index,
      });
      await writeFile(
        path.join(outputRoot, filename),
        await sharp(result.bundle.png)
          .resize({ width: 2400, withoutEnlargement: true })
          .png()
          .toBuffer(),
      );
      focusManifest.push({
        treeId,
        sourcePath,
        sourceSha256: source.sha256,
        nodes: plan.focuses.length,
      });
    }

    const viewer = new TechnologyTreeViewer(engine);
    for (const [folderId, filename] of technologyFolders) {
      const result = await viewer.renderAndStore({
        workspaceId,
        view: 'folder',
        folderId,
        maxNodes: 1000,
        includeHtml: false,
      });
      await writeFile(path.join(outputRoot, filename), result.render.png);
      const report = JSON.parse(result.render.json) as {
        nodes: Array<{
          id: string;
          layoutSize?: string;
          placement?: { layoutWidth?: number; layoutHeight?: number };
        }>;
        iconCoverage: { rendered: number; requested: number; unresolvedSprites: string[] };
      };
      technologyManifest.push({
        folderId,
        graphRevision: result.graph.revision,
        nodes: report.nodes.length,
        omitted: result.render.omittedNodeCount,
        sourceAccurate: result.render.sourceAccurate,
        iconCoverage: report.iconCoverage,
        layouts: Object.fromEntries(
          ['small', 'large', 'unknown'].map((size) => [
            size,
            report.nodes.filter((node) => node.layoutSize === size).length,
          ]),
        ),
      });
    }
    viewer.clearCaches();
  }
  let historicalChemicalManifest: unknown = priorManifest?.historicalChemical;
  if (!currentOnly) {
    const historicalRoot = path.join(temporaryRoot, 'historical-chemical-source');
    for (const relativePath of historicalChemicalSources) {
      const destination = path.join(historicalRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      const source = execFileSync(
        'git',
        ['show', `${historicalChemicalRevision}:${relativePath}`],
        {
          cwd: modRoot,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      await writeFile(destination, source);
    }
    const historicalConfiguration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(temporaryRoot, 'historical-state'),
      storageRoots: [
        path.join(temporaryRoot, 'historical-artifacts'),
        path.join(temporaryRoot, 'historical-cache'),
      ],
      workspaces: [
        {
          id: 'historical-chemical-comparison',
          name: 'Historical Chaos Redux chemical comparison',
          root: historicalRoot,
          dependencyRoots: [modRoot],
          gameRoot,
          kind: 'mod',
          artifactRoot: path.join(temporaryRoot, 'historical-artifacts'),
          cacheRoot: path.join(temporaryRoot, 'historical-cache'),
        },
      ],
    });
    const historicalEngine = new CoreEngine(
      await WorkspaceResolver.create(historicalConfiguration),
    );
    await historicalEngine.initialize();
    const historicalResult = await new TechnologyTreeViewer(historicalEngine).renderAndStore({
      workspaceId: 'historical-chemical-comparison',
      view: 'folder',
      folderId: 'chemical_warfare_folder',
      maxNodes: 1000,
      includeHtml: false,
    });
    await writeFile(
      path.join(outputRoot, 'chemical-historical-mcp.png'),
      historicalResult.render.png,
    );
    await Promise.all([
      writeFile(
        path.join(outputRoot, 'chemical-wide-cards-ingame.png'),
        await sharp(path.join(outputRoot, 'chemical-recent-ingame.png'))
          .extract({ left: 30, top: 230, width: 230, height: 270 })
          .png()
          .toBuffer(),
      ),
      writeFile(
        path.join(outputRoot, 'chemical-wide-cards-mcp.png'),
        await sharp(historicalResult.render.png)
          .extract({ left: 140, top: 220, width: 220, height: 270 })
          .png()
          .toBuffer(),
      ),
    ]);
    const historicalReport = JSON.parse(historicalResult.render.json) as {
      nodes: Array<{ id: string; layoutSize?: string }>;
      iconCoverage: { rendered: number; requested: number; unresolvedSprites: string[] };
    };
    historicalChemicalManifest = {
      sourceRevision: historicalChemicalRevision,
      overlaidSources: historicalChemicalSources,
      graphRevision: historicalResult.graph.revision,
      nodes: historicalReport.nodes.length,
      omitted: historicalResult.render.omittedNodeCount,
      sourceAccurate: historicalResult.render.sourceAccurate,
      iconCoverage: historicalReport.iconCoverage,
      layouts: Object.fromEntries(
        ['small', 'large', 'unknown'].map((size) => [
          size,
          historicalReport.nodes.filter((node) => node.layoutSize === size).length,
        ]),
      ),
    };
  }
  // Native-size crop aligned to the three supplied chemical card interiors.
  if (!historicalOnly) {
    await writeFile(
      path.join(outputRoot, 'chemical-cards-mcp.png'),
      await sharp(path.join(outputRoot, 'chemical-mcp.png'))
        .extract({ left: 113, top: 184, width: 302, height: 320 })
        .png()
        .toBuffer(),
    );
  }
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  ) as {
    version: string;
  };
  await writeFile(
    path.join(outputRoot, 'manifest.json'),
    `${JSON.stringify(
      {
        toolVersion: packageJson.version,
        focusSourceRevision,
        focus: focusManifest,
        technology: technologyManifest,
        historicalChemical: historicalChemicalManifest,
        chemicalCardCrop: { file: 'chemical-cards-mcp.png', sourceX: 113, sourceY: 184 },
        chemicalWideCardCrops: {
          inGame: { file: 'chemical-wide-cards-ingame.png', sourceX: 30, sourceY: 230 },
          mcp: { file: 'chemical-wide-cards-mcp.png', sourceX: 140, sourceY: 220 },
        },
        note: 'User-approved game captures and source-linked MCP renders; screenshots may differ in viewport and source revision.',
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
