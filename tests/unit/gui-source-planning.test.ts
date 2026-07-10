import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore, type StoredArtifact } from '../../src/hoi4_agent_tools/core/artifacts.js';
import { hashCanonical, sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceScanner } from '../../src/hoi4_agent_tools/core/scanner.js';
import {
  TransactionManager,
  type TransactionManifest,
} from '../../src/hoi4_agent_tools/core/transactions.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  ScriptedGuiStudio,
  fidelityCategories,
  parsePreviewScenario,
  type GuiPreviewScenario,
} from '../../src/hoi4_agent_tools/gui/index.js';

const workspaceId = 'gui_source_safety';
const relativePath = 'interface/safety.gui';
const temporaryRoots: string[] = [];

interface Harness {
  absolutePath: string;
  artifacts: ArtifactStore;
  original: Buffer;
  resolver: WorkspaceResolver;
  studio: ScriptedGuiStudio;
  transactions: TransactionManager;
}

async function createHarness(original: Buffer): Promise<Harness> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'hoi4-gui-source-safety-'));
  temporaryRoots.push(temporaryRoot);
  const modRoot = path.join(temporaryRoot, 'mod');
  const absolutePath = path.join(modRoot, ...relativePath.split('/'));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, original);
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    writePolicy: 'transactions',
    serverStateRoot: path.join(temporaryRoot, 'server-state'),
    storageRoots: [
      path.join(temporaryRoot, 'runtime', 'artifacts'),
      path.join(temporaryRoot, 'runtime', 'cache'),
    ],
    workspaces: [
      {
        id: workspaceId,
        name: 'Project-owned synthetic GUI source safety fixture',
        root: modRoot,
        kind: 'mod',
        artifactRoot: path.join(temporaryRoot, 'runtime', 'artifacts'),
        cacheRoot: path.join(temporaryRoot, 'runtime', 'cache'),
        writeEnabled: true,
      },
    ],
  });
  const resolver = await WorkspaceResolver.create(configuration);
  const artifacts = new ArtifactStore();
  const transactions = new TransactionManager(resolver, artifacts);
  const studio = new ScriptedGuiStudio(resolver, transactions, new WorkspaceScanner(), artifacts);
  return { absolutePath, artifacts, original, resolver, studio, transactions };
}

function patchFor(source: string, expectedText: string, text: string) {
  const start = source.indexOf(expectedText);
  if (start < 0) throw new Error(`Synthetic patch text is missing: ${expectedText}`);
  return {
    start,
    end: start + expectedText.length,
    expectedText,
    text,
    description: `Replace ${expectedText} with ${text}`,
  };
}

function planHashPayload(manifest: TransactionManifest): unknown {
  return {
    version: manifest.version,
    workspaceId: manifest.workspaceId,
    principal: manifest.principal ?? null,
    rootFingerprint: manifest.rootFingerprint,
    operationKind: manifest.operationKind,
    operations: manifest.operations,
    readDependencies: manifest.readDependencies,
    files: manifest.files.map((file) => {
      const withoutDiffArtifact = { ...file };
      delete withoutDiffArtifact.diffArtifact;
      return withoutDiffArtifact;
    }),
    diagnostics: manifest.diagnostics,
    validation: manifest.validation,
    artifacts: manifest.artifacts,
  };
}

interface GuiArtifactScenarioEvidence {
  scenario: Pick<
    GuiPreviewScenario,
    'id' | 'resolution' | 'uiScale' | 'state' | 'animationTimeSeconds'
  >;
  sourceRevision: string;
  fidelity: Record<string, { count: number; fields: string[]; fieldsTruncated: boolean }>;
}

function expectGuiArtifactProvenance(
  artifact: StoredArtifact,
  expectedScenario: GuiPreviewScenario,
  expectedSourceHashes: Record<string, string>,
  expectedScenarioRevisions: readonly string[],
): void {
  const primaryRevision = expectedScenarioRevisions[0];
  expect(primaryRevision).toBeDefined();
  if (primaryRevision === undefined) return;
  const profile = artifact.provenance.renderProfile as
    | {
        scenarioId: string;
        sourceRevision: string;
        fidelity: GuiArtifactScenarioEvidence['fidelity'];
        scenarios: GuiArtifactScenarioEvidence[];
      }
    | undefined;
  expect(profile).toBeDefined();
  if (profile === undefined) return;

  expect(artifact.provenance.sourceHashes).toEqual(expectedSourceHashes);
  expect(profile.scenarioId).toBe(expectedScenario.id);
  expect(profile.sourceRevision).toBe(primaryRevision);
  expect(profile.sourceRevision).toBe(hashCanonical(expectedSourceHashes));
  expect(Object.keys(profile.fidelity).sort()).toEqual([...fidelityCategories].sort());
  expect(profile.scenarios).toHaveLength(expectedScenarioRevisions.length);
  expect(profile.fidelity).toEqual(profile.scenarios[0]?.fidelity);
  const expectedScenarioSummary = {
    id: expectedScenario.id,
    resolution: expectedScenario.resolution,
    uiScale: expectedScenario.uiScale,
    state: expectedScenario.state,
    animationTimeSeconds: expectedScenario.animationTimeSeconds,
  };
  for (const [index, evidence] of profile.scenarios.entries()) {
    expect(evidence.scenario).toEqual(expectedScenarioSummary);
    expect(evidence.sourceRevision).toBe(expectedScenarioRevisions[index]);
    expect(Object.keys(evidence.fidelity).sort()).toEqual([...fidelityCategories].sort());
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('ScriptedGuiStudio targeted source planning safety', () => {
  it('refuses whole-file source replacement for an existing GUI file', async () => {
    const source = 'guiTypes = { containerWindowType = { name = "safety_window" } }\n';
    const harness = await createHarness(Buffer.from(source, 'utf8'));

    await expect(
      harness.studio.planSource({
        workspaceId,
        relativePath,
        source: source.replace('safety_window', 'replacement_window'),
      }),
    ).rejects.toMatchObject({ code: 'GUI_UNSAFE_WHOLE_FILE_REWRITE' });
    expect(await readFile(harness.absolutePath)).toEqual(harness.original);
  });

  it('cannot disguise whole-file, block, or unknown-field rewrites as targeted patches', async () => {
    const source = [
      'guiTypes = {',
      '\tcontainerWindowType = {',
      '\t\tname = "safety_window"',
      '\t\tposition = { x = 10 y = 20 }',
      '\t\tcustom_future_field = { preserve = exactly }',
      '\t}',
      '}',
      '',
    ].join('\n');
    const harness = await createHarness(Buffer.from(source, 'utf8'));
    const expectedSourceHash = sha256Bytes(harness.original);
    for (const patch of [
      {
        start: 0,
        end: source.length,
        expectedText: source,
        text: source.replace('safety_window', 'replacement_window'),
        description: 'Unsafe complete rewrite',
      },
      patchFor(
        source,
        'custom_future_field = { preserve = exactly }',
        'custom_future_field = { preserve = no }',
      ),
      patchFor(source, 'position = { x = 10 y = 20 }', 'position = { x = 30 y = 40 }'),
    ]) {
      await expect(
        harness.studio.planSource({
          workspaceId,
          relativePath,
          expectedSourceHash,
          patches: [patch],
        }),
      ).rejects.toMatchObject({ code: 'GUI_UNSAFE_PATCH_RANGE' });
    }
    expect(await readFile(harness.absolutePath)).toEqual(harness.original);
  });

  it('requires both the exact source hash and exact expected patch text', async () => {
    const source = [
      'guiTypes = {',
      '\tcontainerWindowType = {',
      '\t\tname = "safety_window"',
      '\t\tposition = { x = 10 y = 20 }',
      '\t\tsize = { width = 320 height = 200 }',
      '\t}',
      '}',
      '',
    ].join('\n');
    const harness = await createHarness(Buffer.from(source, 'utf8'));
    const patch = patchFor(source, 'x = 10', 'x = 11');

    await expect(
      harness.studio.planSource({ workspaceId, relativePath, patches: [patch] }),
    ).rejects.toMatchObject({ code: 'GUI_EXPECTED_SOURCE_HASH_REQUIRED' });
    await expect(
      harness.studio.planSource({
        workspaceId,
        relativePath,
        expectedSourceHash: '0'.repeat(64),
        patches: [patch],
      }),
    ).rejects.toMatchObject({ code: 'GUI_SOURCE_STALE' });
    await expect(
      harness.studio.planSource({
        workspaceId,
        relativePath,
        expectedSourceHash: sha256Bytes(harness.original),
        patches: [{ ...patch, expectedText: 'x = 99' }],
      }),
    ).rejects.toMatchObject({ code: 'GUI_PATCH_PRECONDITION_FAILED' });

    const planned = await harness.studio.planSource({
      workspaceId,
      relativePath,
      expectedSourceHash: sha256Bytes(harness.original),
      patches: [patch],
    });
    expect(planned).toMatchObject({
      state: 'planned',
      validation: { passed: true },
      files: [{ beforeSha256: sha256Bytes(harness.original) }],
    });
    expect(await readFile(harness.absolutePath)).toEqual(harness.original);
  });

  it('allows a complete parsed GUI entry inserted at a block-close anchor', async () => {
    const source = [
      'guiTypes = {',
      '\tcontainerWindowType = {',
      '\t\tname = "safety_window"',
      '\t\tsize = { width = 320 height = 200 }',
      '\t}',
      '}',
      '',
    ].join('\n');
    const harness = await createHarness(Buffer.from(source, 'utf8'));
    const anchor = source.indexOf('\n\t}\n') + 2;
    const planned = await harness.studio.planSource({
      workspaceId,
      relativePath,
      expectedSourceHash: sha256Bytes(harness.original),
      patches: [
        {
          start: anchor,
          end: anchor,
          expectedText: '',
          text: 'iconType = { name = "inserted_icon" position = { x = 4 y = 5 } }\n\t\t',
          description: 'Insert one parsed child element',
        },
      ],
    });
    expect(planned.validation.passed).toBe(true);
    expect(await readFile(harness.absolutePath)).toEqual(harness.original);
  });

  it('preserves comments, unknown fields, CRLF, and Windows-1252 through plan, apply, and rollback', async () => {
    const source = [
      '# caf\u00e9 synthetic fixture',
      'guiTypes = {',
      '\tcontainerWindowType = {',
      '\t\tname = "safety_window"',
      '\t\tposition = { x = 10 y = 20 } # preserve inline comment',
      '\t\tsize = { width = 320 height = 200 }',
      '\t\tcustom_future_field = { preserve = exactly mystery = "caf\u00e9" }',
      '\t}',
      '}',
      '',
    ].join('\r\n');
    const original = Buffer.from(source, 'latin1');
    const expected = Buffer.from(source.replace('x = 10', 'x = 42'), 'latin1');
    const harness = await createHarness(original);
    const planned = await harness.studio.planSource({
      workspaceId,
      relativePath,
      expectedSourceHash: sha256Bytes(original),
      patches: [patchFor(source, 'x = 10', 'x = 42')],
    });

    expect(await readFile(harness.absolutePath)).toEqual(original);
    expect(planned.files[0]).toMatchObject({
      beforeSha256: sha256Bytes(original),
      afterSha256: sha256Bytes(expected),
      beforeSize: original.length,
      afterSize: expected.length,
    });

    const applied = await harness.studio.applyPlannedSource(
      workspaceId,
      planned.transactionId,
      planned.planHash,
    );
    const appliedBytes = await readFile(harness.absolutePath);
    expect(applied.state).toBe('applied');
    expect(appliedBytes).toEqual(expected);
    expect(appliedBytes.includes(Buffer.from('# caf\u00e9 synthetic fixture', 'latin1'))).toBe(
      true,
    );
    expect(
      appliedBytes.includes(
        Buffer.from('custom_future_field = { preserve = exactly mystery = "caf\u00e9" }', 'latin1'),
      ),
    ).toBe(true);
    expect(appliedBytes.toString('latin1')).toContain('\r\n');
    expect(appliedBytes.includes(Buffer.from([0xe9]))).toBe(true);

    const rolledBack = await harness.transactions.rollback(
      workspaceId,
      planned.transactionId,
      planned.planHash,
    );
    expect(rolledBack).toMatchObject({ state: 'rolled_back', rollbackStatus: 'applied' });
    expect(await readFile(harness.absolutePath)).toEqual(original);
  });

  it('binds supported proposed, visual-diff, fidelity, and source-diff artifacts to the plan', async () => {
    const source = [
      'guiTypes = {',
      '\tcontainerWindowType = {',
      '\t\tname = "safety_window"',
      '\t\tposition = { x = 10 y = 10 }',
      '\t\tsize = { width = 120 height = 80 }',
      '\t}',
      '}',
      '',
    ].join('\n');
    const original = Buffer.from(source, 'utf8');
    const proposed = Buffer.from(source.replace('x = 10', 'x = 30'), 'utf8');
    const harness = await createHarness(original);
    const planned = await harness.studio.planSource({
      workspaceId,
      relativePath,
      expectedSourceHash: sha256Bytes(original),
      patches: [patchFor(source, 'x = 10', 'x = 30')],
      windowName: 'safety_window',
      scenario: {
        id: 'targeted-source-preflight',
        resolution: { width: 640, height: 360 },
      },
    });

    expect(planned.validation).toMatchObject({ passed: true });
    expect(planned.validation.checks.map(({ id }) => id)).toContain('gui-visual-preflight');
    const expectedVisualArtifacts = [
      { name: 'safety_window-before.png', kind: 'gui-before-render' },
      { name: 'safety_window-proposed.png', kind: 'gui-proposed-render' },
      { name: 'safety_window-visual-diff.png', kind: 'gui-visual-diff' },
      { name: 'safety_window-visual-diff.json', kind: 'gui-visual-diff-json' },
      { name: 'safety_window-proposed-fidelity.json', kind: 'gui-proposed-fidelity' },
    ];
    const artifactsByName = new Map(planned.artifacts.map((artifact) => [artifact.name, artifact]));
    expect(planned.readDependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rootKind: 'mod', relativePath: 'interface/safety.gui' }),
      ]),
    );
    for (const { name } of expectedVisualArtifacts) expect(artifactsByName.has(name)).toBe(true);
    expect(artifactsByName.has('safety.gui.diff')).toBe(true);

    const workspace = harness.resolver.get(workspaceId);
    for (const { name, kind } of expectedVisualArtifacts) {
      const artifact = artifactsByName.get(name);
      expect(artifact).toBeDefined();
      if (artifact === undefined) continue;
      const stored = await harness.artifacts.describe(workspace, artifact.uri);
      const originalSourceHashes = { [`mod:${relativePath}`]: sha256Bytes(original) };
      const proposedSourceHashes = { [`mod:${relativePath}`]: sha256Bytes(proposed) };
      const originalRevision = hashCanonical(originalSourceHashes);
      const proposedRevision = hashCanonical(proposedSourceHashes);
      const isBefore = kind === 'gui-before-render';
      const isComparison = kind === 'gui-visual-diff' || kind === 'gui-visual-diff-json';
      expect(stored.provenance).toMatchObject({
        kind,
        schemaVersion: 'gui-studio.v1',
        metadata: { relativePath },
      });
      expectGuiArtifactProvenance(
        stored,
        parsePreviewScenario({
          id: 'targeted-source-preflight',
          resolution: { width: 640, height: 360 },
        }),
        isBefore ? originalSourceHashes : proposedSourceHashes,
        isComparison
          ? [proposedRevision, originalRevision]
          : [isBefore ? originalRevision : proposedRevision],
      );
    }
    const sourceDiff = artifactsByName.get('safety.gui.diff');
    expect(sourceDiff).toBeDefined();
    if (sourceDiff !== undefined) {
      const stored = await harness.artifacts.describe(workspace, sourceDiff.uri);
      expect(stored.provenance).toMatchObject({
        kind: 'source-diff',
        schemaVersion: 'transaction.v1',
        sourceHashes: { before: sha256Bytes(original), after: sha256Bytes(proposed) },
      });
    }

    expect(hashCanonical(planHashPayload(planned))).toBe(planned.planHash);
    const persisted = await harness.transactions.status(workspaceId, planned.transactionId);
    expect(persisted.planHash).toBe(planned.planHash);
    expect(persisted.artifacts).toEqual(planned.artifacts);
  });
});
