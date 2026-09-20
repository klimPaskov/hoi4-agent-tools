import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ScanSnapshot } from '../../src/hoi4_agent_tools/core/engine.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { buildProposedSourceOverlay } from '../../src/hoi4_agent_tools/core/source-overlay.js';
import type { ResolvedWorkspace } from '../../src/hoi4_agent_tools/core/workspace.js';

const modRoot = '/fixture/mod';
const workspace = {
  id: 'fixture',
  modRoot,
  roots: [
    { kind: 'game', path: '/fixture/game', loadOrder: 0 },
    { kind: 'mod', path: modRoot, loadOrder: 1 },
  ],
} as ResolvedWorkspace;

function source(relativePath: string, contents: string, rootKind: 'game' | 'mod'): ScannedFile {
  const bytes = Buffer.from(contents);
  const rootPath = rootKind === 'mod' ? modRoot : '/fixture/game';
  return {
    absolutePath: `${rootPath}/${relativePath}`,
    displayPath: `${rootKind}:${relativePath}`,
    relativePath,
    rootKind,
    loadOrder: rootKind === 'mod' ? 1 : 0,
    size: bytes.length,
    modifiedMs: 1,
    sha256: sha256Bytes(bytes),
    bytes,
    ...(rootKind === 'game' ? { shadowedBy: `mod:${relativePath}` } : {}),
  };
}

function baseline(): ScanSnapshot {
  const files = [
    source('common/ideas/policy.txt', 'ideas = { country = { old_idea = {} } }', 'game'),
    source('common/ideas/policy.txt', 'ideas = { country = { current_idea = {} } }', 'mod'),
  ];
  const index = SymbolIndex.build(files);
  return {
    workspaceId: 'fixture',
    revision: 'baseline-revision',
    files,
    index,
    complete: index.complete,
    skippedSourceCount: index.skippedSourceCount,
    skippedSources: index.skippedSources,
    diagnostics: index.diagnostics,
  };
}

describe('in-memory proposed source overlays', () => {
  it('replaces and adds mod sources without mutating the baseline', () => {
    const original = baseline();
    const proposed = buildProposedSourceOverlay(original, workspace, [
      {
        relativePath: 'common/ideas/policy.txt',
        content: 'ideas = { country = { proposed_idea = {} } }',
      },
      {
        relativePath: 'events/proposal.txt',
        content: 'country_event = { id = proposal.1 }',
      },
    ]);
    expect(proposed.baselineRevision).toBe('baseline-revision');
    expect(proposed.snapshot.revision).not.toBe(original.revision);
    expect(proposed.changes.map(({ change }) => change)).toEqual(['replaced', 'added']);
    expect(proposed.snapshot.index.find('idea', 'proposed_idea')).toBeDefined();
    expect(proposed.snapshot.index.find('event', 'proposal.1')).toBeDefined();
    expect(original.index.find('idea', 'current_idea')).toBeDefined();
    expect(original.files).toHaveLength(2);
  });

  it('reveals a lower-precedence definition when a mod source is removed', () => {
    const proposed = buildProposedSourceOverlay(baseline(), workspace, [
      { relativePath: 'common/ideas/policy.txt', content: null },
    ]);
    expect(proposed.snapshot.index.find('idea', 'old_idea')?.overridden).toBe(false);
    expect(proposed.snapshot.files).toHaveLength(1);
    expect(proposed.snapshot.files[0]?.shadowedBy).toBeUndefined();
  });

  it('uses verified content identity even when source length is unchanged', () => {
    const original = baseline();
    const prior = original.files.find(({ rootKind }) => rootKind === 'mod')!;
    const changed = prior.bytes.toString('utf8').replace('current_idea', 'altered_idea');
    expect(Buffer.byteLength(changed)).toBe(prior.size);
    const proposed = buildProposedSourceOverlay(original, workspace, [
      { relativePath: 'common/ideas/POLICY.txt', content: changed },
    ]);
    expect(proposed.changes[0]?.beforeHash).toBe(prior.sha256);
    expect(proposed.changes[0]?.afterHash).not.toBe(prior.sha256);
    expect(proposed.snapshot.files.find(({ rootKind }) => rootKind === 'mod')?.displayPath).toBe(
      prior.displayPath,
    );
    expect(proposed.snapshot.index.find('idea', 'altered_idea')).toBeDefined();
    expect(original.index.find('idea', 'current_idea')).toBeDefined();
  });

  it('rejects unbound workspaces, traversal, duplicate paths, and oversized content', () => {
    const scan = baseline();
    expect(() =>
      buildProposedSourceOverlay(scan, { ...workspace, id: 'other' }, [
        { relativePath: 'events/new.txt', content: '' },
      ]),
    ).toThrow('workspace');
    expect(() =>
      buildProposedSourceOverlay(scan, workspace, [
        { relativePath: '../outside.txt', content: '' },
      ]),
    ).toThrow('normalized');
    expect(() =>
      buildProposedSourceOverlay(scan, workspace, [
        { relativePath: 'events/new.txt', content: '' },
        { relativePath: 'events/NEW.txt', content: '' },
      ]),
    ).toThrow('Duplicate');
    expect(() =>
      buildProposedSourceOverlay(scan, workspace, [
        { relativePath: 'events/new.txt', content: 'x'.repeat(8 * 1024 * 1024 + 1) },
      ]),
    ).toThrow('limit');
  });
});
