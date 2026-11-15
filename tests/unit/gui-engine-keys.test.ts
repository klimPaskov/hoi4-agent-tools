import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { RootKind } from '../../src/hoi4_agent_tools/core/workspace.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { parseClausewitz } from '../../src/hoi4_agent_tools/core/source/index.js';
import {
  guiEngineKeyDiagnostics,
  guiEngineKeyInventory,
} from '../../src/hoi4_agent_tools/gui/engine-keys.js';
import { guiElementKeyUses } from '../../src/hoi4_agent_tools/gui/source-graph.js';

function file(rootKind: RootKind, relativePath: string, content: string): ScannedFile {
  const bytes = Buffer.from(content, 'utf8');
  return {
    absolutePath: path.join(`C:/${rootKind}`, relativePath),
    displayPath: `${rootKind}:${relativePath}`,
    relativePath,
    rootKind,
    loadOrder: rootKind === 'game' ? 0 : 1,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

// A synthetic stand-in for the installed game's interface files: the keys each element type
// writes, in the shapes the game uses.
const game = file(
  'game',
  'interface/core.gui',
  `guiTypes = {
  containerWindowType = {
    name = "game_window"
    position = { x = 0 y = 0 }
    size = { width = 100 height = 100 }
    background = { name = "bg" quadTextureSprite = "GFX_bg" position = { x = 0 y = 0 } size = { x = 1 y = 1 } }
    iconType = { name = "game_icon" spriteType = "GFX_icon" position = { x = 1 y = 1 } alwaystransparent = yes }
  }
  scrollbarType = {
    name = "game_slider"
    slider = "SliderButton"
    track = "TrackButton"
    size = { x = 18 y = 18 }
    guiButtonType = { name = "SliderButton" quadTextureSprite = "GFX_thumb" position = { x = 0 y = 0 } }
  }
}
`,
);

const mod = file(
  'mod',
  'interface/mod.gui',
  `guiTypes = {
  @width = 10
  containerWindowType = {
    name = "mod_window"
    position = { x = 0 y = 0 }
    size = { width = 100 height = 100 }
    alwaystransparent = yes
    background = { name = "bg" quadTextureSprite = "GFX_bg" size = { width = 1 height = 1 } }
    iconType = { name = "stretched" spriteType = "GFX_icon" position = { x = 1 y = 1 } size = { width = 9 height = 9 } }
    iconType = { name = "fine" spriteType = "GFX_icon" position = { x = 1 y = 1 } }
    browserType = { name = "unknown_to_game" anything = yes }
  }
  scrollbarType = {
    name = "mod_slider"
    size = { width = 18 height }
    orientation = upper_right
    slider = { name = "Slider" quadTextureSprite = "GFX_thumb" }
  }
}
`,
);

function elementsOf(...files: ScannedFile[]) {
  return files.flatMap((source) =>
    guiElementKeyUses(parseClausewitz(source.bytes, source.displayPath)).map((use) => ({
      name: use.elementName,
      sourcePath: source.displayPath,
      location: use.elementLocation,
    })),
  );
}

describe('GUI keys the game refuses at load (issue 220)', () => {
  it('reads keys per element type and nested block, without nested elements or constants', () => {
    const uses = guiElementKeyUses(parseClausewitz(mod.bytes, mod.displayPath));
    const window = uses.filter(({ elementName }) => elementName === 'mod_window');
    expect(window.map(({ parents, key }) => [...parents, key].join('.'))).toEqual([
      'name',
      'position',
      'position.x',
      'position.y',
      'size',
      'size.width',
      'size.height',
      'alwaystransparent',
      'background',
      'background.name',
      'background.quadTextureSprite',
      'background.size',
      'background.size.width',
      'background.size.height',
    ]);
    expect(uses.some(({ key }) => key.startsWith('@'))).toBe(false);
    expect(uses.find(({ key }) => key === 'height')?.elementName).toBe('mod_window');
    const bare = uses.find(({ bareWord }) => bareWord === true);
    expect(bare).toMatchObject({ elementName: 'mod_slider', parents: ['size'], key: 'height' });
    expect(uses.find(({ key }) => key === 'slider')?.block).toBe(true);
  });

  it('reports each refused key, malformed coordinate and block-for-value once, at its line', () => {
    const inventory = guiEngineKeyInventory([game, mod]);
    expect(inventory?.fileCount).toBe(1);
    const diagnostics = guiEngineKeyDiagnostics([game, mod], elementsOf(game, mod), inventory);
    const found = diagnostics.map(({ code, details, location }) => [
      code,
      `${String(details?.elementType)}.${String(details?.key)}`,
      location?.start.line,
    ]);
    expect(found).toEqual([
      ['GUI_KEY_REFUSED_BY_ENGINE', 'containerWindowType.alwaystransparent', 7],
      ['GUI_VALUE_MALFORMED', 'containerWindowType.background.size.width', 8],
      ['GUI_VALUE_MALFORMED', 'containerWindowType.background.size.height', 8],
      ['GUI_KEY_REFUSED_BY_ENGINE', 'iconType.size', 9],
      ['GUI_VALUE_MALFORMED', 'scrollbarType.size.width', 15],
      ['GUI_VALUE_MALFORMED', 'scrollbarType.size.height', 15],
      ['GUI_KEY_REFUSED_BY_ENGINE', 'scrollbarType.orientation', 16],
      ['GUI_KEY_REFUSED_BY_ENGINE', 'scrollbarType.slider', 17],
    ]);
    // The refused key's own children are not reported again; the browserType is a type the
    // game's files never use, so it is not checked; game files are never checked.
    expect(diagnostics.every(({ severity }) => severity === 'error')).toBe(true);
    expect(diagnostics.find(({ details }) => details?.key === 'size.width')?.message).toContain(
      'x and y',
    );
    expect(diagnostics.find(({ details }) => details?.key === 'slider')?.message).toContain(
      'as a block',
    );
  });

  it('checks only the requested elements, and nothing without the installed game', () => {
    const inventory = guiEngineKeyInventory([game]);
    const onlyFine = elementsOf(mod).filter(({ name }) => name === 'fine');
    expect(guiEngineKeyDiagnostics([mod], onlyFine, inventory)).toEqual([]);
    expect(guiEngineKeyInventory([mod])).toBeUndefined();
    expect(guiEngineKeyDiagnostics([mod], elementsOf(mod), undefined)).toEqual([]);
  });

  it('caches the inventory by the content of the game files', () => {
    const first = guiEngineKeyInventory([game]);
    expect(guiEngineKeyInventory([game])).toBe(first);
    const changed = file('game', 'interface/core.gui', `${game.bytes.toString('utf8')}\n`);
    expect(guiEngineKeyInventory([changed])).not.toBe(first);
  });
});
