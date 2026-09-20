import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ScanSnapshot } from '../../src/hoi4_agent_tools/core/engine.js';
import { inspectImpactGraph } from '../../src/hoi4_agent_tools/core/impact-graph.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';

function file(
  relativePath: string,
  text: string,
  rootKind: ScannedFile['rootKind'] = 'mod',
  loadOrder = 1,
): ScannedFile {
  const bytes = Buffer.from(text);
  return {
    absolutePath: `/fixture/${rootKind}/${relativePath}`,
    displayPath: `${rootKind}:${relativePath}`,
    relativePath,
    rootKind,
    loadOrder,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

function snapshot(): ScanSnapshot {
  const files = [
    file(
      'common/national_focus/vanilla.txt',
      'focus_tree = { id = vanilla focus = { id = alpha x = 0 y = 0 } }',
      'game',
      0,
    ),
    file(
      'common/national_focus/alpha.txt',
      'focus_tree = { id = mod_tree focus = { id = alpha x = 0 y = 0 } }',
    ),
    file(
      'common/national_focus/bravo.txt',
      'focus_tree = { id = bravo_tree focus = { id = bravo prerequisite = { focus = alpha } x = 0 y = 1 } }',
    ),
    file(
      'common/national_focus/charlie.txt',
      'focus_tree = { id = charlie_tree focus = { id = charlie prerequisite = { focus = bravo } x = 0 y = 2 } }',
    ),
  ];
  const index = SymbolIndex.build(files);
  return {
    workspaceId: 'fixture',
    revision: 'impact-revision',
    files,
    index,
    complete: index.complete,
    skippedSourceCount: index.skippedSourceCount,
    skippedSources: index.skippedSources,
    diagnostics: index.diagnostics,
  };
}

describe('revision-pinned impact graph', () => {
  it('reports active and overridden definitions with direct and transitive consumers', () => {
    const scan = snapshot();
    const result = inspectImpactGraph(scan, { symbols: [{ kind: 'focus', id: 'alpha' }] });
    expect(result.sourceRevision).toBe(scan.revision);
    expect(result.definitions.map(({ path, overridden }) => [path, overridden])).toEqual([
      ['mod:common/national_focus/alpha.txt', false],
      ['game:common/national_focus/vanilla.txt', true],
    ]);
    expect(result.directConsumers.map(({ source }) => source.id)).toEqual(['bravo']);
    expect(result.transitiveConsumers.map(({ source }) => source.id)).toEqual(['charlie']);
    expect(result.affectedFiles).toEqual([
      'mod:common/national_focus/alpha.txt',
      'mod:common/national_focus/bravo.txt',
      'mod:common/national_focus/charlie.txt',
    ]);
    expect(result.complete).toBe(true);
    expect(result.unresolved).toEqual([]);
  });

  it('retains explicit traversal boundaries and the changed-file seed', () => {
    const scan = snapshot();
    const changed = 'mod:common/national_focus/alpha.txt';
    const depth = inspectImpactGraph(scan, { changedFiles: [changed], maxDepth: 1 });
    expect(depth.directConsumers.map(({ source }) => source.id)).toEqual(['bravo']);
    expect(depth.transitiveConsumers).toEqual([]);
    expect(depth.coverage).toMatchObject({
      stoppedAtDepth: true,
      omittedEdges: 1,
    });
    expect(depth.complete).toBe(false);
    const edge = inspectImpactGraph(scan, { changedFiles: [changed], maxEdges: 1 });
    expect(edge.coverage.omittedEdges).toBe(1);
    expect(edge.complete).toBe(false);
  });

  it('states when a selected symbol is absent without inventing a definition', () => {
    const result = inspectImpactGraph(snapshot(), {
      symbols: [{ kind: 'focus', id: 'deleted_focus' }],
    });
    expect(result.definitions).toEqual([]);
    expect(result.missingSymbols).toEqual([{ kind: 'focus', id: 'deleted_focus' }]);
    expect(result.directConsumers).toEqual([]);
  });

  it('connects an idea to decision consumers and then event consumers while retaining dynamic gaps', () => {
    const files = [
      file('common/ideas/ideas.txt', 'ideas = { country = { rationing = { } } }'),
      file(
        'common/decisions/policy.txt',
        'policy = { ration = { available = { has_idea = rationing } complete_effect = { add_ideas = rationing } } }',
      ),
      file(
        'events/policy.txt',
        'country_event = { id = policy.1 option = { name = okay activate_decision = ration } } country_event = { id = policy.2 immediate = { activate_decision = event_target:choice } }',
      ),
    ];
    const index = SymbolIndex.build(files);
    const scan: ScanSnapshot = {
      workspaceId: 'fixture',
      revision: 'semantic-revision',
      files,
      index,
      complete: index.complete,
      skippedSourceCount: index.skippedSourceCount,
      skippedSources: index.skippedSources,
      diagnostics: index.diagnostics,
    };
    const result = inspectImpactGraph(scan, { symbols: [{ kind: 'idea', id: 'rationing' }] });
    expect(result.directConsumers.map(({ source }) => source.id)).toEqual(['ration', 'ration']);
    expect(result.transitiveConsumers.map(({ source }) => source.id)).toEqual(['policy.1']);
    expect(result.affectedFiles).toEqual([
      'mod:common/decisions/policy.txt',
      'mod:common/ideas/ideas.txt',
      'mod:events/policy.txt',
    ]);
    expect(result.dynamicReferences).toHaveLength(1);
    expect(result.dynamicReferences[0]!.reason).toContain('event_target:choice');
    expect(result.complete).toBe(false);
  });

  it('tracks observed state-key reads and writes without inventing a winning definition', () => {
    const files = [
      file(
        'events/ledger.txt',
        'country_event = { id = ledger.1 immediate = { set_variable = { reserve = 8 } set_country_flag = funded save_global_event_target_as = recipient event_target:recipient = { add_ideas = ledger_idea } } }',
      ),
      file(
        'common/decisions/ledger.txt',
        'ledger = { spend = { available = { check_variable = { reserve > 2 } has_country_flag = funded has_event_target = recipient } complete_effect = { subtract_from_variable = { reserve = 2 } } } }',
      ),
    ];
    const index = SymbolIndex.build(files);
    const scan: ScanSnapshot = {
      workspaceId: 'fixture',
      revision: 'state-key-revision',
      files,
      index,
      complete: index.complete,
      skippedSourceCount: index.skippedSourceCount,
      skippedSources: index.skippedSources,
      diagnostics: index.diagnostics,
    };
    const variable = inspectImpactGraph(scan, {
      symbols: [{ kind: 'variable', id: 'reserve' }],
    });
    expect(variable.definitions).toEqual([]);
    expect(variable.missingSymbols).toEqual([]);
    expect(
      variable.directConsumers.map(({ source, accessRole, targetStatus }) => [
        source.id,
        accessRole,
        targetStatus,
      ]),
    ).toEqual([
      ['spend', 'read', 'state_key'],
      ['spend', 'write', 'state_key'],
      ['ledger.1', 'write', 'state_key'],
    ]);
    expect(
      inspectImpactGraph(scan, { symbols: [{ kind: 'flag', id: 'country:funded' }] })
        .directConsumers.length,
    ).toBe(2);
    expect(
      inspectImpactGraph(scan, { symbols: [{ kind: 'event_target', id: 'recipient' }] })
        .directConsumers.length,
    ).toBe(3);
  });
});
