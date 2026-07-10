import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compareCodeUnits } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine, type ScanSnapshot } from '../../src/hoi4_agent_tools/core/engine.js';
import { parseClausewitz } from '../../src/hoi4_agent_tools/core/source/index.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  importFocusTrees,
  layoutFocusTree,
  renderFocusTree,
  type FocusTreePlan,
} from '../../src/hoi4_agent_tools/focus/index.js';
import { nativeFocusEffectKeys } from '../../src/hoi4_agent_tools/focus/native-effects.js';
import { ScriptedGuiStudio, defaultPreviewScenario } from '../../src/hoi4_agent_tools/gui/index.js';
import { AgentNudger } from '../../src/hoi4_agent_tools/map/index.js';

const gameRoot = process.env.HOI4_GAME_ROOT;
const modRoot = process.env.HOI4_EXTERNAL_MOD_ROOT;
const dependencyRoots = (process.env.HOI4_DEPENDENCY_ROOTS ?? '')
  .split(path.delimiter)
  .filter(Boolean);
const local = gameRoot === undefined || modRoot === undefined ? describe.skip : describe;
let runtimeRoot = '';

function representativeFocusPlan(
  snapshot: ScanSnapshot,
  rootKind: 'game' | 'mod',
  minimumFocuses: number,
): FocusTreePlan | undefined {
  const targetSize = 250;
  const candidates = snapshot.files
    .filter(
      ({ rootKind: fileRoot, shadowedBy, relativePath }) =>
        fileRoot === rootKind &&
        shadowedBy === undefined &&
        relativePath.replaceAll('\\', '/').startsWith('common/national_focus/') &&
        relativePath.toLowerCase().endsWith('.txt'),
    )
    .map((file) => ({
      file,
      estimatedFocuses: file.bytes.toString('utf8').match(/\bfocus\s*=/gu)?.length ?? 0,
    }))
    .sort(
      (left, right) =>
        Math.abs(left.estimatedFocuses - targetSize) -
          Math.abs(right.estimatedFocuses - targetSize) ||
        compareCodeUnits(left.file.displayPath, right.file.displayPath),
    );
  const fallback: FocusTreePlan[] = [];
  for (const { file } of candidates) {
    const document = parseClausewitz(file.bytes, file.displayPath);
    const plans = importFocusTrees(document).plans.sort(
      (left, right) =>
        Math.abs(left.focuses.length - targetSize) - Math.abs(right.focuses.length - targetSize) ||
        compareCodeUnits(left.id, right.id),
    );
    fallback.push(...plans);
    const representative = plans.find(({ focuses }) => focuses.length >= minimumFocuses);
    if (representative !== undefined) return representative;
  }
  return fallback.sort(
    (left, right) =>
      right.focuses.length - left.focuses.length || compareCodeUnits(left.id, right.id),
  )[0];
}

async function engine(): Promise<CoreEngine> {
  await Promise.all([access(gameRoot!), access(modRoot!)]);
  if (runtimeRoot === '') runtimeRoot = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-local-'));
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    storageRoots: [path.join(runtimeRoot, 'artifacts'), path.join(runtimeRoot, 'cache')],
    workspaces: [
      {
        id: 'external',
        name: 'External integration workspace',
        root: modRoot!,
        gameRoot: gameRoot!,
        dependencyRoots,
        artifactRoot: path.join(runtimeRoot, 'artifacts'),
        cacheRoot: path.join(runtimeRoot, 'cache'),
      },
    ],
  });
  return new CoreEngine(await WorkspaceResolver.create(configuration));
}

local('local installed-game and external-mod integration', () => {
  afterAll(async () => {
    if (runtimeRoot !== '') await rm(runtimeRoot, { recursive: true, force: true });
  });

  it('indexes both roots and deterministically renders a large vanilla focus tree', async () => {
    const effectDocumentation = await readFile(
      path.join(gameRoot!, 'documentation', 'effects_documentation.md'),
      'utf8',
    );
    const documentedEffects = new Set(
      effectDocumentation.split(/\r?\n/u).flatMap((line) => {
        const match = /^## ([a-z][a-z0-9_]*)\s*$/u.exec(line);
        return match?.[1] === undefined ? [] : [match[1]];
      }),
    );
    expect(documentedEffects.size).toBe(553);
    expect([...documentedEffects].filter((effect) => !nativeFocusEffectKeys.has(effect))).toEqual(
      [],
    );
    expect([...nativeFocusEffectKeys].filter((effect) => !documentedEffects.has(effect))).toEqual(
      [],
    );

    const core = await engine();
    expect(core.resolver.get('external').artifactRoot).toBe(path.join(runtimeRoot, 'artifacts'));
    expect(core.resolver.get('external').cacheRoot).toBe(path.join(runtimeRoot, 'cache'));
    const snapshot = await core.scan('external');
    expect(snapshot.files.some(({ rootKind }) => rootKind === 'game')).toBe(true);
    expect(snapshot.files.some(({ rootKind }) => rootKind === 'mod')).toBe(true);
    const plan = representativeFocusPlan(snapshot, 'game', 100);
    expect(plan?.focuses.length).toBeGreaterThanOrEqual(100);
    const layout = layoutFocusTree(plan!);
    const first = await renderFocusTree(plan!, layout, []);
    const second = await renderFocusTree(plan!, layoutFocusTree(plan!), []);
    expect(first.hashes).toEqual(second.hashes);

    const externalPlan = representativeFocusPlan(snapshot, 'mod', 1);
    expect(externalPlan).toBeDefined();
    expect(externalPlan!.focuses.length).toBeGreaterThan(0);
    const externalLayout = layoutFocusTree(externalPlan!);
    const externalRender = await renderFocusTree(externalPlan!, externalLayout, []);
    expect(externalRender.png.subarray(1, 4).toString('ascii')).toBe('PNG');
  }, 600_000);

  it('builds and deterministically renders an offline GUI scene without launching HOI4', async () => {
    const core = await engine();
    const studio = new ScriptedGuiStudio(
      core.resolver,
      core.transactions,
      core.scanner,
      core.artifacts,
    );
    const scannedGui = await studio.scan('external');
    const candidates = scannedGui.graph.elements
      .filter(
        ({ parentId, elementType }) =>
          parentId === undefined && /(?:containerWindowType|windowType)/u.test(elementType),
      )
      .sort(
        (left, right) =>
          right.childIds.length - left.childIds.length || compareCodeUnits(left.name, right.name),
      );
    expect(candidates.length).toBeGreaterThan(0);
    const renderInput = {
      workspaceId: 'external',
      windowName: candidates[0]!.name,
      scenario: defaultPreviewScenario('local-integration'),
      states: ['normal' as const],
      resolutions: [{ width: 1920, height: 1080, uiScale: 1 }],
    };
    const first = await studio.renderAndStore(renderInput);
    const second = await studio.renderAndStore(renderInput);
    expect(first.render.images).toEqual(second.render.images);
    expect(first.render.hierarchySvg).toBe(second.render.hierarchySvg);
    expect(first.render.layoutJson).toBe(second.render.layoutJson);
    expect(first.render.scenarioJson).toBe(second.render.scenarioJson);
    expect(first.render.images).toHaveLength(5);
    expect(
      first.render.images.every(({ png }) => png.subarray(1, 4).toString('ascii') === 'PNG'),
    ).toBe(true);
    expect(
      first.render.scene.elements.some(
        ({ sprite }) => sprite?.supported === true && sprite.dataUri !== undefined,
      ),
    ).toBe(true);
    const glyphSources = first.render.scene.elements.flatMap(
      ({ text }) => text?.glyphLines.map(({ source }) => source) ?? [],
    );
    expect(
      glyphSources.some((source) => source === 'fontkit-path' || source === 'bmfont-atlas'),
    ).toBe(true);
    expect(first.artifacts.length).toBeGreaterThan(10);
  }, 600_000);

  it('scans, renders, and stores the current map without launching HOI4', async () => {
    const core = await engine();
    const nudger = new AgentNudger(core.resolver, core.transactions, core.artifacts, core.scanner);
    const renderedMap = await nudger.renderAndStore('external', {
      layer: 'state',
      overlays: ['coastlines', 'supply-nodes', 'railways'],
    });
    const metadata = JSON.parse(renderedMap.bundle.json) as { definitions?: unknown[] };
    expect(metadata.definitions?.length).toBeGreaterThan(1_000);
    expect(renderedMap.bundle.width).toBeGreaterThan(1_000);
    expect(renderedMap.filesScanned.length).toBeGreaterThan(0);
    expect(renderedMap.artifacts).toHaveLength(3);
    expect(renderedMap.bundle.png.subarray(1, 4).toString('ascii')).toBe('PNG');
  }, 600_000);
});
