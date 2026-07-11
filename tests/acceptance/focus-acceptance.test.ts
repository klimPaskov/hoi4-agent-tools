import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine, type ScanSnapshot } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { parseClausewitz } from '../../src/hoi4_agent_tools/core/source/index.js';
import {
  compileContinuousFocusPalette,
  compileFocusTree,
  FocusWorkbench,
  importContinuousFocusPalettes,
  parseFocusPlanningSidecar,
  resolveFocusPresentation,
  updateFocusTreeSource,
  type ContinuousFocusPalettePlan,
  type FocusPlanningSidecar,
  type FocusPresentationResolution,
  type FocusLayoutResult,
  type FocusPosition,
  type FocusReferenceCatalog,
  type FocusTreePlan,
} from '../../src/hoi4_agent_tools/focus/index.js';

interface FocusFixtureManifest {
  schemaVersion: number;
  treeId: string;
  focusCount: number;
  routeFamilyCount: number;
  layoutOptions: { laneSpacing: number; nodeSpacing: number };
  layoutHash: string;
  sourceSha256: string;
  planSha256: string;
  features: Record<string, number>;
  invalidVariants: { id: string; expectedDiagnosticCodes: string[] }[];
}

interface InvalidFixtureVariant {
  id: string;
  mutation:
    | { kind: 'replace_prerequisites'; focusId: string; focusIds: string[] }
    | { kind: 'replace_position'; focusId: string; position: FocusPosition }
    | { kind: 'replace_link_target'; focusId: string; from: string; to: string }
    | { kind: 'remove_reveal'; focusId: string };
  expectedDiagnosticCodes: string[];
}

interface InvalidFixtureFile {
  schemaVersion: number;
  variants: InvalidFixtureVariant[];
}

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const fixtureRoot = path.join(repositoryRoot, 'fixtures', 'focus');
const workspaceRoot = path.join(fixtureRoot, 'workspace');
const sourceRelativePath = 'common/national_focus/synthetic_acceptance.txt';
const sourcePath = path.join(workspaceRoot, ...sourceRelativePath.split('/'));
const planPath = path.join(fixtureRoot, 'plans', 'synthetic_acceptance.plan.json');
const sidecarPath = path.join(
  workspaceRoot,
  'common',
  'national_focus',
  'synthetic_acceptance.focus-plan.json',
);
const continuousSourcePath = path.join(
  workspaceRoot,
  'common',
  'continuous_focus',
  'synthetic_acceptance.txt',
);
const manifestPath = path.join(fixtureRoot, 'fixture-manifest.json');
const invalidVariantsPath = path.join(fixtureRoot, 'invalid', 'invalid-variants.json');
const workspaceId = 'focus_acceptance';

let temporaryRoot: string;
let engine: CoreEngine;
let workbench: FocusWorkbench;
let snapshot: ScanSnapshot;
let plan: FocusTreePlan;
let planBytes: Buffer;
let manifest: FocusFixtureManifest;
let invalidFixture: InvalidFixtureFile;
let references: FocusReferenceCatalog;
let sidecar: FocusPlanningSidecar;
let continuousPalette: ContinuousFocusPalettePlan;
let presentation: FocusPresentationResolution;

function hardDiagnostics(diagnostics: readonly { severity: string }[]): { severity: string }[] {
  return diagnostics.filter(({ severity }) => severity === 'blocker' || severity === 'error');
}

function focusById(value: FocusTreePlan, id: string): FocusTreePlan['focuses'][number] {
  const focus = value.focuses.find((candidate) => candidate.id === id);
  if (focus === undefined) throw new Error(`Fixture focus ${id} is missing`);
  return focus;
}

function applyInvalidVariant(base: FocusTreePlan, variant: InvalidFixtureVariant): FocusTreePlan {
  const changed = structuredClone(base);
  const mutation = variant.mutation;
  const focus = focusById(changed, mutation.focusId);
  switch (mutation.kind) {
    case 'replace_prerequisites':
      focus.prerequisites = {
        operator: 'and',
        groups: [{ operator: 'or', focusIds: mutation.focusIds, rawPassthrough: [] }],
      };
      break;
    case 'replace_position':
      focus.position = mutation.position;
      break;
    case 'replace_link_target': {
      const link = focus.links.find(({ target }) => target === mutation.from);
      if (link === undefined) {
        throw new Error(`Fixture link ${mutation.from} is missing from ${mutation.focusId}`);
      }
      link.target = mutation.to;
      break;
    }
    case 'remove_reveal':
      delete focus.reveal;
      delete focus.allowBranch;
      break;
  }
  return changed;
}

function overlapPairs(layout: FocusLayoutResult): string[] {
  const horizontalSpacing = 176;
  const verticalSpacing = 116;
  const nodeWidth = 144;
  const nodeHeight = 76;
  const overlaps: string[] = [];
  for (let leftIndex = 0; leftIndex < layout.nodes.length; leftIndex += 1) {
    const left = layout.nodes[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < layout.nodes.length; rightIndex += 1) {
      const right = layout.nodes[rightIndex];
      if (right === undefined) continue;
      const horizontalDistance = Math.abs(left.x - right.x) * horizontalSpacing;
      const verticalDistance = Math.abs(left.y - right.y) * verticalSpacing;
      if (horizontalDistance < nodeWidth && verticalDistance < nodeHeight) {
        overlaps.push(`${left.id}:${right.id}`);
      }
    }
  }
  return overlaps;
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'hoi4-focus-acceptance-'));
  [planBytes, manifest, invalidFixture, sidecar] = await Promise.all([
    readFile(planPath),
    readFile(manifestPath, 'utf8').then((value) => JSON.parse(value) as FocusFixtureManifest),
    readFile(invalidVariantsPath, 'utf8').then((value) => JSON.parse(value) as InvalidFixtureFile),
    readFile(sidecarPath).then(parseFocusPlanningSidecar),
  ]);
  plan = JSON.parse(planBytes.toString('utf8')) as FocusTreePlan;
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    writePolicy: 'read-only',
    storageRoots: [path.join(temporaryRoot, 'artifacts'), path.join(temporaryRoot, 'cache')],
    workspaces: [
      {
        id: workspaceId,
        name: 'Project-owned focus acceptance fixture',
        root: workspaceRoot,
        kind: 'mod',
        artifactRoot: path.join(temporaryRoot, 'artifacts'),
        cacheRoot: path.join(temporaryRoot, 'cache'),
        writeEnabled: false,
      },
    ],
  });
  const resolver = await WorkspaceResolver.create(configuration);
  engine = new CoreEngine(resolver);
  await engine.initialize();
  snapshot = await engine.scan(workspaceId);
  workbench = new FocusWorkbench(resolver, engine.transactions, engine.artifacts);
  references = {
    decision: snapshot.index.findAll('decision').map(({ id }) => id),
    decision_category: snapshot.index.findAll('decision_category').map(({ id }) => id),
    event: snapshot.index.findAll('event').map(({ id }) => id),
    formable: snapshot.index.findAll('formable').map(({ id }) => id),
    helper: snapshot.index.findAll('scripted_effect').map(({ id }) => id),
  };
  const continuousDocument = parseClausewitz(
    await readFile(continuousSourcePath),
    'mod:common/continuous_focus/synthetic_acceptance.txt',
  );
  const importedContinuous = importContinuousFocusPalettes(continuousDocument);
  continuousPalette = importedContinuous.continuousFocusPalettes[0]!;
  presentation = await resolveFocusPresentation({
    plans: [plan],
    palettes: [continuousPalette],
    files: snapshot.files,
    index: snapshot.index,
    scanner: engine.scanner,
    workspace: engine.resolver.get(workspaceId),
  });
});

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('Focus Tree Workbench project-owned acceptance fixture', () => {
  it('imports deterministic ordinary HOI4 source and preserves the complete planning topology', async () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.focusCount).toBe(255);
    expect(plan.id).toBe(manifest.treeId);
    expect(plan.focuses).toHaveLength(manifest.focusCount);
    expect(plan.focuses.length).toBeGreaterThanOrEqual(250);
    expect(plan.branchGroups).toHaveLength(10);
    expect(new Set(plan.branchGroups.map(({ family }) => family)).size).toBe(
      manifest.routeFamilyCount,
    );
    expect(plan.focuses.some(({ mutuallyExclusive }) => mutuallyExclusive.length > 0)).toBe(true);
    expect(plan.focuses.some(({ convergence }) => convergence)).toBe(true);
    expect(plan.focuses.some(({ visibility }) => visibility === 'hidden')).toBe(true);
    expect(plan.focuses.some(({ visibility }) => visibility === 'crisis')).toBe(true);
    expect(plan.focuses.some(({ sharedSupport }) => sharedSupport)).toBe(true);
    expect(plan.focuses.some(({ position }) => position.mode === 'relative')).toBe(true);
    expect(plan.focuses.some(({ position }) => position.pinned)).toBe(true);
    expect(plan.focuses.some(({ continuous }) => continuous !== undefined)).toBe(false);
    expect(plan.continuousFocusPaletteIds).toEqual(['synthetic_acceptance_continuous']);
    expect(plan.continuousFocusIds.length).toBeGreaterThan(0);
    expect(plan.continuousFocusPosition).toBeDefined();
    expect(plan.focuses.flatMap(({ links }) => links).some(({ kind }) => kind === 'decision')).toBe(
      true,
    );
    expect(plan.focuses.flatMap(({ links }) => links).some(({ kind }) => kind === 'event')).toBe(
      true,
    );
    expect(plan.focuses.flatMap(({ links }) => links).some(({ kind }) => kind === 'formable')).toBe(
      true,
    );
    expect(plan.focuses.flatMap(({ links }) => links).some(({ kind }) => kind === 'helper')).toBe(
      true,
    );
    expect(
      plan.focuses.flatMap(({ links }) => links).some(({ kind }) => kind === 'decision_category'),
    ).toBe(true);
    expect(
      plan.focuses
        .flatMap(({ links }) => links)
        .some(({ target }) => target === 'SYNTHETIC_ACCEPTANCE_COSMETIC'),
    ).toBe(false);

    const layout = workbench.layout(plan, manifest.layoutOptions);
    const sourceBytes = await readFile(sourcePath);
    expect(sha256Bytes(sourceBytes)).toBe(manifest.sourceSha256);
    expect(sha256Bytes(planBytes)).toBe(manifest.planSha256);
    expect(layout.layoutHash).toBe(manifest.layoutHash);
    expect(`${compileFocusTree(plan, layout)}\n`).toBe(sourceBytes.toString('utf8'));
    expect(sourceBytes.toString('utf8')).not.toMatch(/^\s*(?:hidden|crisis|continuous)\s*=/mu);

    const continuousBytes = await readFile(continuousSourcePath);
    expect(`${compileContinuousFocusPalette(continuousPalette)}\n`).toBe(
      continuousBytes.toString('utf8'),
    );
    expect(continuousPalette.focuses.map(({ id }) => id)).toEqual(plan.continuousFocusIds);

    const imported = await workbench.importPath(
      workspaceId,
      sourceRelativePath,
      undefined,
      sidecar,
    );
    expect(hardDiagnostics(imported.result.diagnostics)).toEqual([]);
    expect(imported.result.plans).toHaveLength(1);
    expect(imported.result.plans[0]?.focuses).toHaveLength(manifest.focusCount);
    expect(
      imported.result.plans[0]?.focuses.some(({ visibility }) => visibility === 'hidden'),
    ).toBe(true);
    expect(
      imported.result.plans[0]?.focuses.some(({ visibility }) => visibility === 'crisis'),
    ).toBe(true);
    expect(
      imported.result.plans[0]?.focuses
        .flatMap(({ links }) => links)
        .some(({ kind }) => kind === 'decision'),
    ).toBe(true);
    expect(
      imported.result.plans[0]?.focuses
        .flatMap(({ links }) => links)
        .some(({ kind }) => kind === 'event'),
    ).toBe(true);
    for (const kind of ['decision_category', 'formable', 'helper'] as const) {
      expect(
        imported.result.plans[0]?.focuses
          .flatMap(({ links }) => links)
          .some((link) => link.kind === kind),
      ).toBe(true);
    }
    expect(snapshot.index.unresolvedReferences()).toEqual([]);
    expect(snapshot.index.find('sprite', 'GFX_synthetic_focus')).toBeDefined();
    expect(snapshot.index.find('continuous_focus_palette', continuousPalette.id)).toBeDefined();
    expect(snapshot.index.findAll('continuous_focus')).toHaveLength(2);
    expect(snapshot.index.findAll('decision').length).toBeGreaterThan(0);
    expect(
      snapshot.index.find('decision_category', 'synthetic_acceptance_decisions'),
    ).toBeDefined();
    expect(snapshot.index.find('formable', 'form_synthetic_union')).toBeDefined();
    expect(snapshot.index.find('scripted_effect', 'synthetic_focus_reward_effect')).toBeDefined();
    expect(snapshot.index.findAll('event').length).toBeGreaterThan(0);
    expect(presentation.entries.synthetic_root?.title).toBe('Synthetic Root');
    expect(presentation.icons.GFX_synthetic_focus).toEqual(
      expect.objectContaining({ frame: 0, frameCount: 2, width: 64, height: 64, format: 'png' }),
    );
    expect(presentation.icons.GFX_synthetic_focus?.dataUri).toMatch(/^data:image\/png;base64,/u);
    expect(hardDiagnostics(presentation.diagnostics)).toEqual([]);
  });

  it('repairs a 255-node authored layout through deterministic fixed-to-auto planning', () => {
    const baseline = workbench.layout(plan, manifest.layoutOptions);
    const baselineNodes = new Map(baseline.nodes.map((node) => [node.id, node]));
    const authored = structuredClone(plan);
    for (const focus of authored.focuses) {
      const node = baselineNodes.get(focus.id)!;
      focus.position = { mode: 'fixed', x: node.x, y: node.y, pinned: false };
    }
    const proposed = structuredClone(authored);
    for (const focus of proposed.focuses) {
      const position = focus.position;
      if (position.mode !== 'fixed') throw new Error('Expected authored fixed coordinate');
      focus.position = {
        mode: 'auto',
        pinned: false,
        preferredX: position.x,
        preferredY: position.y,
      };
    }

    const first = workbench.layout(proposed, manifest.layoutOptions);
    const repeated = workbench.layout(proposed, manifest.layoutOptions);
    expect(first.nodes).toHaveLength(manifest.focusCount);
    expect(first.layoutHash).toBe(repeated.layoutHash);
    expect(overlapPairs(first)).toEqual([]);
    expect(new Set(first.nodes.map(({ x, y }) => `${x},${y}`)).size).toBe(manifest.focusCount);
    const nodes = new Map(first.nodes.map((node) => [node.id, node]));
    for (const focus of proposed.focuses) {
      const child = nodes.get(focus.id)!;
      for (const group of focus.prerequisites.groups) {
        for (const parentId of group.focusIds) {
          const parent = nodes.get(parentId);
          if (parent !== undefined)
            expect(parent.y, `${parentId} -> ${focus.id}`).toBeLessThan(child.y);
        }
      }
    }
  });

  it('produces byte-stable layouts without coordinate collisions, visible overlaps, or cycles', () => {
    const first = workbench.layout(plan, manifest.layoutOptions);
    const second = workbench.layout(plan, manifest.layoutOptions);
    expect(Buffer.from(canonicalJson(second))).toEqual(Buffer.from(canonicalJson(first)));
    expect(second.layoutHash).toBe(first.layoutHash);
    expect(first.nodes).toHaveLength(plan.focuses.length);
    expect(new Set(first.nodes.map(({ x, y }) => `${x},${y}`)).size).toBe(first.nodes.length);
    expect(overlapPairs(first)).toEqual([]);
    expect(hardDiagnostics(first.diagnostics)).toEqual([]);

    const positions = new Map(first.nodes.map((node) => [node.id, node]));
    for (const focus of plan.focuses) {
      const child = positions.get(focus.id);
      expect(child).toBeDefined();
      for (const parentId of focus.prerequisites.groups.flatMap(({ focusIds }) => focusIds)) {
        const parent = positions.get(parentId);
        expect(parent).toBeDefined();
        expect(parent?.y).toBeLessThan(child?.y ?? Number.NEGATIVE_INFINITY);
      }
      for (const excludedId of focus.mutuallyExclusive) {
        const excluded = positions.get(excludedId);
        expect(excluded).toBeDefined();
        expect(Math.abs((child?.x ?? 0) - (excluded?.x ?? 0))).toBeGreaterThanOrEqual(
          manifest.layoutOptions.nodeSpacing,
        );
      }
    }

    const diagnostics = workbench.lint(plan, {
      index: snapshot.index,
      layout: first,
      references,
    });
    const codes = new Set(diagnostics.map(({ code }) => code));
    expect(codes.has('FOCUS_PREREQUISITE_CYCLE')).toBe(false);
    expect(codes.has('FOCUS_RELATIVE_POSITION_CYCLE')).toBe(false);
    expect(codes.has('FOCUS_DUPLICATE_COORDINATE')).toBe(false);
    expect(hardDiagnostics(diagnostics)).toEqual([]);
  });

  it('keeps fixture coordinates and every unrelated source byte stable for a one-scalar edit', async () => {
    const imported = await workbench.importPath(
      workspaceId,
      sourceRelativePath,
      undefined,
      sidecar,
    );
    const current = imported.result.plans[0];
    expect(current).toBeDefined();
    if (current === undefined) return;
    const beforeLayout = workbench.layout(current, manifest.layoutOptions);
    const target = structuredClone(current);
    const root = focusById(target, 'synthetic_root');
    expect(root.cost).toBe(5);
    root.cost = 6;
    const afterLayout = workbench.layout(target, {
      ...manifest.layoutOptions,
      previous: beforeLayout,
    });
    expect(afterLayout.nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual(
      beforeLayout.nodes.map(({ id, x, y }) => ({ id, x, y })),
    );
    const decisions = new Map(
      afterLayout.decisions.map((decision) => [decision.focusId, decision]),
    );
    for (const focus of target.focuses.filter(({ position }) => position.mode === 'auto')) {
      expect(decisions.get(focus.id)).toEqual(expect.objectContaining({ kind: 'preserved' }));
    }

    const sourceBytes = await readFile(sourcePath);
    const document = parseClausewitz(sourceBytes, `mod:${sourceRelativePath}`);
    const updated = updateFocusTreeSource(document, current, target, afterLayout);
    expect(updated).toHaveLength(sourceBytes.length);
    const changedOffsets: number[] = [];
    for (let offset = 0; offset < sourceBytes.length; offset += 1) {
      if (sourceBytes[offset] !== updated[offset]) changedOffsets.push(offset);
    }
    expect(changedOffsets).toHaveLength(1);
    const changedOffset = changedOffsets[0];
    expect(changedOffset).toBeDefined();
    if (changedOffset === undefined) return;
    expect(String.fromCharCode(sourceBytes[changedOffset]!)).toBe('5');
    expect(String.fromCharCode(updated[changedOffset]!)).toBe('6');
    expect(updated.toString('utf8')).toContain(
      'id = synthetic_root\n\t\ticon = GFX_synthetic_focus\n\t\tx = 14\n\t\ty = 0\n\t\tcost = 6',
    );
  });

  it('stores byte-deterministic HTML, SVG, real PNG, and JSON artifacts through FocusWorkbench', async () => {
    const layout = workbench.layout(plan, manifest.layoutOptions);
    const options = {
      layout,
      index: snapshot.index,
      references,
      horizontalSpacing: 144,
      verticalSpacing: 76,
      padding: 24,
      presentation,
      renderProfile: { fixture: 'focus-acceptance-v1' },
    };
    const first = await workbench.renderAndStore(workspaceId, plan, options);
    const second = await workbench.renderAndStore(workspaceId, plan, options);

    expect(second.bundle.hashes).toEqual(first.bundle.hashes);
    expect(second.bundle.html).toBe(first.bundle.html);
    expect(second.bundle.svg).toBe(first.bundle.svg);
    expect(second.bundle.json).toBe(first.bundle.json);
    expect(second.bundle.png.equals(first.bundle.png)).toBe(true);
    expect(second.artifacts.map(({ name, sha256 }) => ({ name, sha256 }))).toEqual(
      first.artifacts.map(({ name, sha256 }) => ({ name, sha256 })),
    );
    expect(hardDiagnostics(first.diagnostics)).toEqual([]);

    expect(first.bundle.html).toContain('Offline HOI4 Agent Tools representation');
    expect(first.bundle.html).toContain('not an in-game screenshot or editor');
    expect(first.bundle.svg).toContain('<svg');
    expect(first.bundle.svg).toContain('<image href="data:image/png;base64,');
    expect(first.bundle.svg).toContain('data-font-sha256=');
    expect(first.bundle.svg).not.toMatch(/<text\b|font-family=/u);
    expect(first.bundle.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const pngMetadata = await sharp(first.bundle.png).metadata();
    expect(pngMetadata.format).toBe('png');
    expect(pngMetadata.width).toBe(first.bundle.width);
    expect(pngMetadata.height).toBe(first.bundle.height);
    const graph = JSON.parse(first.bundle.json) as {
      tree: { id: string; focusCount: number };
      focuses: unknown[];
    };
    expect(graph.tree).toEqual(
      expect.objectContaining({ id: plan.id, focusCount: manifest.focusCount }),
    );
    expect(graph.focuses).toHaveLength(manifest.focusCount);

    expect(new Set(first.artifacts.map(({ mimeType }) => mimeType))).toEqual(
      new Set(['text/html', 'image/svg+xml', 'image/png', 'application/json']),
    );
    const expectedBytes = new Map([
      ['synthetic_acceptance_tree.focus.html', Buffer.from(first.bundle.html, 'utf8')],
      ['synthetic_acceptance_tree.focus.svg', Buffer.from(first.bundle.svg, 'utf8')],
      ['synthetic_acceptance_tree.focus.png', first.bundle.png],
      ['synthetic_acceptance_tree.focus.json', Buffer.from(first.bundle.json, 'utf8')],
    ]);
    for (const artifact of first.artifacts) {
      const expected = expectedBytes.get(artifact.name);
      if (expected !== undefined) expect(await readFile(artifact.path)).toEqual(expected);
      else {
        const json = await readFile(artifact.path, 'utf8');
        expect(() => JSON.parse(json)).not.toThrow();
      }
    }
    expect(first.bundle.sourceMap.mappings).toHaveLength(manifest.focusCount);
    expect(first.bundle.sourceMap.mappings[0]).toEqual(
      expect.objectContaining({
        focusId: expect.any(String),
        generatedLocation: expect.any(Object),
      }),
    );
    expect(first.artifacts.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'synthetic_acceptance_tree.focus.source-map.json',
        'synthetic_acceptance_tree.focus.plan.json',
      ]),
    );
    expect(await engine.artifacts.list(engine.resolver.get(workspaceId))).toHaveLength(6);
  }, 120_000);

  it('stores continuous HTML, SVG, PNG, JSON, and complete source maps through FocusWorkbench', async () => {
    const options = {
      columns: 2,
      padding: 32,
      presentation,
      renderProfile: { fixture: 'continuous-focus-acceptance-v1' },
    };
    const first = await workbench.renderContinuousAndStore(workspaceId, continuousPalette, options);
    const second = await workbench.renderContinuousAndStore(
      workspaceId,
      continuousPalette,
      options,
    );

    expect(hardDiagnostics(first.diagnostics)).toEqual([]);
    expect(second.bundle.hashes).toEqual(first.bundle.hashes);
    expect(second.bundle.html).toBe(first.bundle.html);
    expect(second.bundle.svg).toBe(first.bundle.svg);
    expect(second.bundle.json).toBe(first.bundle.json);
    expect(second.bundle.png.equals(first.bundle.png)).toBe(true);
    expect(second.artifacts.map(({ name, sha256 }) => ({ name, sha256 }))).toEqual(
      first.artifacts.map(({ name, sha256 }) => ({ name, sha256 })),
    );

    expect(first.bundle.html).toContain('Offline source-derived review artifact');
    expect(first.bundle.svg).toContain('data-continuous-focus-id=');
    expect(first.bundle.svg).toContain('<image href="data:image/png;base64,');
    expect(first.bundle.svg).toContain('data-font-sha256=');
    expect(first.bundle.svg).not.toMatch(/<text\b|font-family=/u);
    expect(first.bundle.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const pngMetadata = await sharp(first.bundle.png).metadata();
    expect(pngMetadata).toEqual(
      expect.objectContaining({
        format: 'png',
        width: first.bundle.width,
        height: first.bundle.height,
      }),
    );
    const structured = JSON.parse(first.bundle.json) as {
      kind: string;
      palette: { id: string };
      focuses: Array<{ id: string; resolvedIcon: unknown }>;
      sourceMap: { treeId: string };
    };
    expect(structured).toMatchObject({
      kind: 'continuous-focus-palette',
      palette: { id: continuousPalette.id },
      focuses: continuousPalette.focuses.map(({ id }) => ({ id })),
      sourceMap: { treeId: continuousPalette.id },
    });
    for (const focus of continuousPalette.focuses) {
      const sprite = focus.icons[0]?.sprite;
      expect(sprite).toBeDefined();
      if (sprite === undefined) continue;
      expect(structured.focuses.find(({ id }) => id === focus.id)?.resolvedIcon).toEqual(
        expect.objectContaining({ sprite, frame: presentation.icons[sprite]?.frame }),
      );
      expect(first.bundle.svg).toContain(presentation.icons[sprite]?.dataUri);
    }
    expect(first.bundle.json).not.toContain('data:image');

    expect(first.bundle.sourceMap.mappings).toHaveLength(continuousPalette.focuses.length);
    expect(first.bundle.sourceMap.generatedSha256).toBe(
      sha256Bytes(compileContinuousFocusPalette(continuousPalette)),
    );
    expect(first.bundle.sourceMap.mappings.map(({ focusId }) => focusId)).toEqual(
      continuousPalette.focuses.map(({ id }) => id),
    );
    expect(
      first.bundle.sourceMap.mappings.every(
        ({ generatedLocation, planNodeLocation }) =>
          generatedLocation.path.startsWith('generated:') && planNodeLocation !== undefined,
      ),
    ).toBe(true);
    expect(first.artifacts.map(({ name }) => name)).toEqual([
      'synthetic_acceptance_continuous.continuous.html',
      'synthetic_acceptance_continuous.continuous.svg',
      'synthetic_acceptance_continuous.continuous.png',
      'synthetic_acceptance_continuous.continuous.json',
      'synthetic_acceptance_continuous.continuous.source-map.json',
    ]);
    const sourceMapArtifact = first.artifacts.find(({ name }) =>
      name.endsWith('.continuous.source-map.json'),
    );
    expect(sourceMapArtifact).toBeDefined();
    if (sourceMapArtifact !== undefined) {
      expect(JSON.parse(await readFile(sourceMapArtifact.path, 'utf8'))).toEqual(
        first.bundle.sourceMap,
      );
    }
    const storedNames = (await engine.artifacts.list(engine.resolver.get(workspaceId))).map(
      ({ name }) => name,
    );
    expect(storedNames).toEqual(expect.arrayContaining(first.artifacts.map(({ name }) => name)));
  }, 120_000);

  it('detects every committed invalid fixture variant with the real linter and layout engine', () => {
    expect(invalidFixture.schemaVersion).toBe(1);
    expect(
      invalidFixture.variants.map(({ id, expectedDiagnosticCodes }) => ({
        id,
        expectedDiagnosticCodes,
      })),
    ).toEqual(manifest.invalidVariants);

    for (const variant of invalidFixture.variants) {
      const invalidPlan = applyInvalidVariant(plan, variant);
      const layout = workbench.layout(invalidPlan, manifest.layoutOptions);
      const diagnostics = workbench.lint(invalidPlan, {
        index: snapshot.index,
        layout,
        references,
      });
      const codes = new Set(diagnostics.map(({ code }) => code));
      for (const expectedCode of variant.expectedDiagnosticCodes) {
        expect(codes, `${variant.id} should report ${expectedCode}`).toContain(expectedCode);
      }
    }
  });
});
