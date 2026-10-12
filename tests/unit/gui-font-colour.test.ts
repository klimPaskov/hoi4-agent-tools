import { describe, expect, it } from 'vitest';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { buildGuiScene } from '../../src/hoi4_agent_tools/gui/layout.js';
import { buildGuiSourceGraph } from '../../src/hoi4_agent_tools/gui/source-graph.js';
import { parsePreviewScenario } from '../../src/hoi4_agent_tools/gui/scenario.js';

function scanned(displayPath: string, content: string): ScannedFile {
  const bytes = Buffer.from(content);
  return {
    displayPath,
    absolutePath: `/synthetic/${displayPath}`,
    relativePath: displayPath,
    rootKind: 'fixture',
    loadOrder: 0,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

const fonts = `bitmapfont = {
  name = "dark_font"
  fontfiles = { "gfx/fonts/dark" "gfx/fonts/dark_extra" }
  color = 0xff000000
  textcolors = { G = { 86 172 91 } }
}
bitmapfont_override = {
  name = "dark_font"
  fontfiles = { "gfx/fonts/dark_extra" }
  languages = { "l_russian" "l_polish" }
}
bitmapfont_override = {
  name = "dark_font"
  fontfiles = { "gfx/fonts/japanese/dark" }
  languages = { "l_japanese" }
}`;

describe('GUI font default colour', () => {
  it('uses the colour of the base font definition when language overrides repeat the name', async () => {
    const files = [
      scanned(
        'interface/window.gui',
        `guiTypes = { containerWindowType = { name = "root" size = { width = 200 height = 100 }
          instantTextBoxType = { name = "body" position = { x = 0 y = 0 } font = "dark_font" text = "Plain body" maxWidth = 150 maxHeight = 40 } } }`,
      ),
      scanned('interface/core.gfx', `bitmapfonts = {\n${fonts}\n}`),
    ];
    const scene = await buildGuiScene(
      buildGuiSourceGraph(files, SymbolIndex.build(files)),
      files,
      'root',
      parsePreviewScenario({ id: 'font', resolution: { width: 320, height: 240 } }),
    );
    const body = scene.elements.find(({ name }) => name === 'body')!;
    expect(body.text?.colour).toBe('#000000ff');
  });
});
