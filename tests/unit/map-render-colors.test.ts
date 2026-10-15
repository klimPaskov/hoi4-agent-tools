import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { createBmp } from '../../src/hoi4_agent_tools/map/bmp.js';
import { MapWorkspaceIndex } from '../../src/hoi4_agent_tools/map/model.js';
import { renderMap, type MapBaseLayer } from '../../src/hoi4_agent_tools/map/render.js';

type Color = readonly [number, number, number];

function fixture(owner = 'AAA'): MapWorkspaceIndex {
  const colors = [
    { r: 10, g: 20, b: 30 },
    { r: 40, g: 50, b: 60 },
    { r: 70, g: 80, b: 90 },
    { r: 100, g: 110, b: 120 },
  ];
  const entries: Record<string, string | Buffer> = {
    'map/provinces.bmp': createBmp({
      width: 16,
      height: 8,
      bitsPerPixel: 24,
      rgbPixels: Array.from({ length: 128 }, (_, offset) => colors[Math.floor((offset % 16) / 4)]!),
    }),
    'map/definition.csv':
      '1;10;20;30;land;false;plains;1\n2;40;50;60;land;false;forest;2\n3;70;80;90;land;false;plains;1\n',
    'history/states/1.txt': `state={id=1 name="STATE_1" provinces={1 2} history={owner=${owner} controller=BBB add_core_of=CCC add_core_of=AAA}}`,
    'history/states/2.txt':
      'state={id=2 name="STATE_2" provinces={3} history={owner=DDD add_core_of=EEE add_claim_by=FFF}}',
    'map/strategicregions/1.txt': 'strategic_region={id=1 name="REGION_1" provinces={1 3}}',
    'map/strategicregions/2.txt': 'strategic_region={id=2 name="REGION_2" provinces={2}}',
  };
  const files: ScannedFile[] = Object.entries(entries).map(([relativePath, content]) => {
    const bytes = Buffer.from(content);
    return {
      absolutePath: `virtual://${relativePath}`,
      relativePath,
      displayPath: `mod:${relativePath}`,
      rootKind: 'mod',
      loadOrder: 0,
      modifiedMs: 0,
      size: bytes.length,
      sha256: sha256Bytes(bytes),
      bytes,
    };
  });
  return MapWorkspaceIndex.build(files);
}

const layerColors: Record<MapBaseLayer, readonly [Color, Color, Color]> = {
  province: [
    [10, 20, 30],
    [40, 50, 60],
    [70, 80, 90],
  ],
  state: [
    [127, 111, 203],
    [127, 111, 203],
    [89, 85, 81],
  ],
  'strategic-region': [
    [133, 203, 223],
    [126, 96, 208],
    [133, 203, 223],
  ],
  terrain: [
    [76, 209, 84],
    [61, 168, 67],
    [76, 209, 84],
  ],
  continent: [
    [166, 180, 69],
    [173, 113, 132],
    [166, 180, 69],
  ],
  owner: [
    [154, 153, 75],
    [154, 153, 75],
    [102, 188, 49],
  ],
  controller: [
    [218, 222, 86],
    [218, 222, 86],
    [176, 55, 85],
  ],
  cores: [
    [217, 52, 118],
    [217, 52, 118],
    [75, 88, 67],
  ],
  claims: [
    [88, 182, 136],
    [88, 182, 136],
    [124, 146, 120],
  ],
  coast: [
    [45, 51, 58],
    [45, 51, 58],
    [45, 51, 58],
  ],
};

describe('map base-layer colors', () => {
  it('preserves exact pixel colors and deterministic artifact hashes across every base layer', async () => {
    const index = fixture();
    for (const layer of Object.keys(layerColors) as MapBaseLayer[]) {
      const rendered = await renderMap(index, { layer });
      const pixels = await sharp(rendered.png).ensureAlpha().raw().toBuffer();
      const expected = Buffer.from(
        Array.from({ length: 128 }, (_, offset) => {
          const province = Math.floor((offset % 16) / 4);
          return [...(layerColors[layer][province] ?? [255, 0, 255]), 255];
        }).flat(),
      );
      expect(pixels, layer).toEqual(expected);
      expect((await renderMap(index, { layer })).hashes, layer).toEqual(rendered.hashes);
    }
  });

  it('isolates colors between workspaces and still rejects an aborted render', async () => {
    await renderMap(fixture(), { layer: 'owner' });
    const rendered = await renderMap(fixture('XXX'), { layer: 'owner' });
    const pixels = await sharp(rendered.png).ensureAlpha().raw().toBuffer();
    expect([...pixels.subarray(0, 4)]).toEqual([139, 99, 168, 255]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      renderMap(fixture(), { layer: 'state', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
