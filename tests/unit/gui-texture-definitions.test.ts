import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import {
  buildGuiScene,
  buildGuiSourceGraph,
  parsePreviewScenario,
  renderGuiScene,
} from '../../src/hoi4_agent_tools/gui/index.js';

function scanned(relativePath: string, content: string | Buffer): ScannedFile {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  return {
    absolutePath: path.join('C:/fixture', relativePath),
    displayPath: `fixture:${relativePath}`,
    relativePath,
    rootKind: 'fixture',
    loadOrder: 0,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

/** A 64x64 nine-slice texture: an 8-pixel red border around a blue centre. */
async function nineSliceTexture(): Promise<Buffer> {
  const size = 64;
  const border = 8;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const edge = x < border || y < border || x >= size - border || y >= size - border;
      pixels.set(edge ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * size + x) * 4);
    }
  return sharp(pixels, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer();
}

describe('GUI SVG texture definitions', () => {
  it('writes a texture once however many nine-slice elements draw it', async () => {
    const count = 40;
    const buttons = Array.from(
      { length: count },
      (_unused, index) =>
        `buttonType = { name = "panel_${index}" position = { x = ${(index % 8) * 100} y = ${Math.floor(index / 8) * 90} } size = { width = 90 height = 80 } spriteType = "GFX_panel" }`,
    ).join('\n');
    const files = [
      scanned(
        'interface/panels.gui',
        `guiTypes = { containerWindowType = { name = "panels" size = { width = 800 height = 450 }\n${buttons}\n} }`,
      ),
      scanned(
        'interface/panels.gfx',
        'spriteTypes = { corneredTileSpriteType = { name = "GFX_panel" texturefile = "gfx/panel.png" size = { x = 64 y = 64 } borderSize = { x = 8 y = 8 } } }',
      ),
      scanned('gfx/panel.png', await nineSliceTexture()),
    ];
    const scene = await buildGuiScene(
      buildGuiSourceGraph(files, SymbolIndex.build(files)),
      files,
      'panels',
      parsePreviewScenario({ id: 'panels', resolution: { width: 800, height: 450 } }),
    );
    const dataUri = scene.elements.find(({ name }) => name === 'panel_0')?.sprite?.dataUri;
    expect(dataUri).toMatch(/^data:image\/png;base64,/u);
    const image = (await renderGuiScene(scene, ['full'])).images[0]!;
    // Nine slices per element used to write the texture's bytes nine times each.
    expect(image.svg.split(dataUri!).length - 1).toBe(1);
    expect(image.svg.match(/<use href="#gui-texture-[0-9a-f]{20}"/gu)?.length).toBe(count * 9);

    // The referenced texture still draws: border corners red, centres blue, in every panel.
    const { data, info } = await sharp(image.png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) =>
      [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 3)].join(',');
    for (const index of [0, 17, count - 1]) {
      const left = (index % 8) * 100;
      const top = Math.floor(index / 8) * 90;
      expect(pixel(left + 2, top + 2)).toBe('255,0,0');
      expect(pixel(left + 87, top + 77)).toBe('255,0,0');
      expect(pixel(left + 45, top + 40)).toBe('0,0,255');
    }
  });
});
