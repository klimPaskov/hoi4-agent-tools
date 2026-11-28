import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import {
  buildGuiScene,
  buildGuiSourceGraph,
  GuiAssetCatalog,
  parsePreviewScenario,
  sceneToSvg,
} from '../../src/hoi4_agent_tools/gui/index.js';

function scanned(relativePath: string, content: Buffer | string): ScannedFile {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return {
    absolutePath: path.join('C:/fixture', relativePath),
    displayPath: `mod:${relativePath}`,
    relativePath,
    rootKind: 'mod',
    loadOrder: 0,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

const solid = (width: number, height: number, r: number, g: number, b: number, alpha: number) =>
  sharp({ create: { width, height, channels: 4, background: { r, g, b, alpha } } })
    .png()
    .toBuffer();

async function pixel(dataUri: string | undefined, x: number, y: number): Promise<number[]> {
  const bytes = Buffer.from(dataUri!.replace(/^data:image\/png;base64,/u, ''), 'base64');
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * 4;
  return [...data.subarray(offset, offset + 4)];
}

/** A masked shield whose mask is black with full alpha, as the game's small flag mask is. */
async function flagFiles(maskAlpha: number): Promise<ScannedFile[]> {
  return [
    scanned(
      'interface/flags.gfx',
      `spriteTypes = { maskedShieldType = { name = "GFX_fixture_flag_small" textureFile1 = "gfx/interface/fixture_overlay.png" textureFile2 = "gfx/interface/fixture_mask.png" effectFile = "gfx/FX/maskedflag.lua" } }`,
    ),
    // A faint grey shading overlay, mostly transparent.
    scanned('gfx/interface/fixture_overlay.png', await solid(26, 21, 60, 60, 60, 0.2)),
    scanned('gfx/interface/fixture_mask.png', await solid(26, 21, 0, 0, 0, maskAlpha)),
    scanned('gfx/flags/FXA.png', await solid(82, 52, 200, 20, 10, 1)),
  ];
}

describe('masked country flags', () => {
  it('cuts the flag by the mask alpha, not by the mask colour', async () => {
    const files = await flagFiles(1);
    const graph = buildGuiSourceGraph(files, SymbolIndex.build(files));
    const sprite = graph.sprites.find(({ name }) => name === 'GFX_fixture_flag_small');
    const flag = await new GuiAssetCatalog(graph, files).loadCountryFlag('FXA', sprite);
    expect(flag).toMatchObject({ supported: true, width: 26, height: 21 });
    const [red, green, blue, alpha] = await pixel(flag.dataUri, 13, 10);
    // The flag's red shows through, under the faint overlay.
    expect(red).toBeGreaterThan(150);
    expect(green).toBeLessThan(60);
    expect(blue).toBeLessThan(60);
    expect(alpha).toBe(255);
  });

  it('still hides the flag where the mask alpha is zero', async () => {
    const files = await flagFiles(0);
    const graph = buildGuiSourceGraph(files, SymbolIndex.build(files));
    const sprite = graph.sprites.find(({ name }) => name === 'GFX_fixture_flag_small');
    const flag = await new GuiAssetCatalog(graph, files).loadCountryFlag('FXA', sprite);
    const [red, , , alpha] = await pixel(flag.dataUri, 13, 10);
    // Only the overlay remains: grey and mostly transparent, no flag red.
    expect(red).toBeLessThan(100);
    expect(alpha).toBeLessThan(100);
  });

  it('masks a static masked shield by alpha in the rendered SVG', async () => {
    const files = [
      ...(await flagFiles(1)),
      scanned(
        'interface/shield.gui',
        `guiTypes = { containerWindowType = { name = "shield_window" position = { x = 0 y = 0 } size = { width = 40 height = 40 }
          iconType = { name = "shield" position = { x = 0 y = 0 } spriteType = "GFX_fixture_flag_small" } } }`,
      ),
    ];
    const graph = buildGuiSourceGraph(files, SymbolIndex.build(files));
    const scene = await buildGuiScene(
      graph,
      files,
      'shield_window',
      parsePreviewScenario({ id: 'shield', resolution: { width: 320, height: 200 } }),
    );
    const svg = sceneToSvg(scene, 'full');
    expect(svg).toMatch(/<mask id="gui-mask-[^"]+"[^>]*style="mask-type:alpha"/u);
  });
});
