import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ScanSnapshot } from '../../src/hoi4_agent_tools/core/engine.js';
import { compareImpactGraphs } from '../../src/hoi4_agent_tools/core/impact-comparison.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { buildProposedSourceOverlay } from '../../src/hoi4_agent_tools/core/source-overlay.js';
import type { ResolvedWorkspace } from '../../src/hoi4_agent_tools/core/workspace.js';

const modRoot = '/fixture/mod';
const workspace = {
  id: 'fixture',
  modRoot,
  roots: [{ kind: 'mod', path: modRoot, loadOrder: 1 }],
} as ResolvedWorkspace;

function file(relativePath: string, content: string): ScannedFile {
  const bytes = Buffer.from(content);
  return {
    absolutePath: `${modRoot}/${relativePath}`,
    displayPath: `mod:${relativePath}`,
    relativePath,
    rootKind: 'mod',
    loadOrder: 1,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

function snapshot(): ScanSnapshot {
  const files = [
    file('common/ideas/needs.txt', 'ideas = { country = { rationing = {} } }'),
    file(
      'common/decisions/needs.txt',
      'needs = { spend = { available = { has_idea = rationing } } }',
    ),
  ];
  const index = SymbolIndex.build(files);
  return {
    workspaceId: 'fixture',
    revision: 'impact-before',
    files,
    index,
    complete: index.complete,
    skippedSourceCount: index.skippedSourceCount,
    skippedSources: index.skippedSources,
    diagnostics: index.diagnostics,
  };
}

describe('impact source comparison', () => {
  it('attributes a removed decision dependency and its affected file', () => {
    const before = snapshot();
    const after = buildProposedSourceOverlay(before, workspace, [
      {
        relativePath: 'common/decisions/needs.txt',
        content: 'needs = { spend = { available = { always = yes } } }',
      },
    ]).snapshot;
    const result = compareImpactGraphs(before, after, {
      symbols: [{ kind: 'idea', id: 'rationing' }],
    });
    expect(result.beforeRevision).toBe(before.revision);
    expect(result.afterRevision).toBe(after.revision);
    expect(result.removedConsumers.map(({ source }) => source.id)).toEqual(['spend']);
    expect(result.addedConsumers).toEqual([]);
    expect(result.noLongerAffectedFiles).toEqual(['mod:common/decisions/needs.txt']);
    expect(result.complete).toBe(true);
  });

  it('does not compare snapshots from different workspaces', () => {
    const before = snapshot();
    expect(() =>
      compareImpactGraphs(
        before,
        { ...before, workspaceId: 'other' },
        {
          symbols: [{ kind: 'idea', id: 'rationing' }],
        },
      ),
    ).toThrow('workspace');
  });
});
