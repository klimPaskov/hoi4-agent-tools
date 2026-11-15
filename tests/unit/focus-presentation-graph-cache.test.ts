import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { presentationGraph } from '../../src/hoi4_agent_tools/focus/presentation.js';

function file(
  rootKind: 'game' | 'mod',
  relativePath: string,
  text: string,
  bytes = Buffer.from(text, 'utf8'),
): ScannedFile {
  return {
    absolutePath: `/${rootKind}/${relativePath}`,
    displayPath: `${rootKind}:${relativePath}`,
    relativePath,
    rootKind,
    loadOrder: rootKind === 'game' ? 0 : 10,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

const goals = (name: string) =>
  `spriteTypes = {\n\tspriteType = {\n\t\tname = "${name}"\n\t\ttexturefile = "gfx/interface/goals/${name}.dds"\n\t}\n}\n`;

describe('the focus presentation sprite graph', () => {
  it('reuses the graph of the same game file read again', () => {
    const game = file('game', 'interface/goals.gfx', goals('GFX_goal_one'));
    const first = presentationGraph([game], new SymbolIndex());
    // The scanner hands out a new file record around the same retained bytes.
    const again = presentationGraph([{ ...game }], new SymbolIndex());
    expect(again).toBe(first);
    expect(first.sprites.map(({ name }) => name)).toEqual(['GFX_goal_one']);
  });

  it('builds again when a file changed, was added or now shadows another', () => {
    const game = file('game', 'interface/goals.gfx', goals('GFX_goal_two'));
    const first = presentationGraph([game], new SymbolIndex());
    const mod = file('mod', 'interface/mod_goals.gfx', goals('GFX_goal_mod'));
    const withMod = presentationGraph([game, mod], new SymbolIndex());
    expect(withMod).not.toBe(first);
    expect(withMod.sprites.map(({ name }) => name).sort()).toEqual([
      'GFX_goal_mod',
      'GFX_goal_two',
    ]);
    const edited = file('mod', 'interface/mod_goals.gfx', goals('GFX_goal_mod_edited'));
    const afterEdit = presentationGraph([game, edited], new SymbolIndex());
    expect(afterEdit).not.toBe(withMod);
    expect(afterEdit.sprites.map(({ name }) => name)).toContain('GFX_goal_mod_edited');
    const shadowed = presentationGraph(
      [{ ...game, shadowedBy: 'mod:interface/goals.gfx' }],
      new SymbolIndex(),
    );
    expect(shadowed).not.toBe(first);
  });

  it('keeps no graph without a game file and leaves the provided index untouched', () => {
    const mod = file('mod', 'interface/mod_goals.gfx', goals('GFX_goal_only_mod'));
    expect(presentationGraph([mod], new SymbolIndex())).not.toBe(
      presentationGraph([mod], new SymbolIndex()),
    );
    // Building the graph over a provided index leaves that index as it was, so reusing a graph
    // cannot hide anything from the index.
    const game = file('game', 'interface/goals.gfx', goals('GFX_goal_three'));
    const broken = file('mod', 'interface/broken.gfx', 'spriteTypes = {\n');
    const index = new SymbolIndex();
    const first = presentationGraph([game, broken], index);
    expect(index.diagnostics).toEqual([]);
    expect(index.skippedSourceCount).toBe(0);
    // The graph keeps the mod file's own parse diagnostics, also when it is reused.
    const again = presentationGraph([{ ...game }, broken], new SymbolIndex());
    expect(again).toBe(first);
    expect(again.diagnostics.some(({ code }) => code === 'SOURCE_UNCLOSED_BLOCK')).toBe(true);
  });
});
