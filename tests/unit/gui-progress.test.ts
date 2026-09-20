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
import {
  compileGuiProgressEffect,
  GUI_SHADER_MAX_BYTES,
} from '../../src/hoi4_agent_tools/gui/shader.js';

// Small project-owned threshold programs; no installed game source is shipped in this fixture.
function shader(textured: boolean): string {
  const sample = (first: boolean) =>
    textured
      ? `tex2D(Texture${first ? 'One' : 'Two'}, point.vTexCoord0.xy)`
      : `v${first ? 'First' : 'Second'}Color`;
  const samplers = ['One', 'Two']
    .map(
      (name, index) =>
        `Texture${name} = { Index = ${index} MinFilter = "Point" MagFilter = "Point" MipFilter = "None" AddressU = "Wrap" AddressV = "Wrap" }`,
    )
    .join('\n');
  return `VertexShader = { MainCode Place [[
    VS_OUTPUT main(VS_INPUT point) {
      VS_OUTPUT placed;
      placed.vPosition = mul(WorldViewProjectionMatrix, point.vPosition);
      placed.vTexCoord0 = point.vTexCoord;
      placed.vTexCoord0.y = -placed.vTexCoord0.y;
      return placed;
    }
  ]] }
  PixelShader = { Samplers = { ${samplers} } MainCode Select [[
    float4 main(VS_OUTPUT point) : PDX_COLOR {
      if (point.vTexCoord0.x <= CurrentState) return ${sample(true)};
      else return ${sample(false)};
    }
  ]] }
  BlendState Alpha { BlendEnable = yes SourceBlend = "SRC_ALPHA" DestBlend = "INV_SRC_ALPHA" }
  Effect ${textured ? 'Texture' : 'Color'} { VertexShader = "Place" PixelShader = "Select" }`;
}
const provenance = { path: 'fixture:gfx/FX/threshold.shader', sha256: 'f'.repeat(64) };
function file(relativePath: string, source: string | Buffer): ScannedFile {
  const bytes = typeof source === 'string' ? Buffer.from(source) : source;
  return {
    relativePath,
    absolutePath: path.join('C:/synthetic', relativePath),
    displayPath: `fixture:${relativePath}`,
    rootKind: 'fixture',
    loadOrder: 0,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

describe('native progress composition', () => {
  it.each([false, true])(
    'verifies the selected colour/texture entry point from source (%s)',
    (textured) => {
      const effect = textured ? 'Texture' : 'Color';
      expect(compileGuiProgressEffect(shader(textured), provenance, effect)).toMatchObject({
        supported: true,
        shader: {
          sourcePath: provenance.path,
          sourceHash: provenance.sha256,
          effect,
          entryPoint: 'Select',
          composition: 'threshold',
        },
      });
    },
  );

  it.each([
    ['geometry', (source: string) => source.replace('point.vPosition)', 'point.vPosition * 2)')],
    ['threshold', (source: string) => source.replace('<= CurrentState', '> CurrentState')],
    [
      'nonlinear texture program',
      (source: string) =>
        source.replace(
          'return tex2D(TextureOne, point.vTexCoord0.xy)',
          'return tex2D(TextureOne, point.vTexCoord0.xy) * 0.5',
        ),
    ],
    ['sampler slot', (source: string) => source.replace('Index = 1', 'Index = 7')],
    [
      'different texture filters',
      (source: string) => source.replace('MagFilter = "Point"', 'MagFilter = "Linear"'),
    ],
    ['blend', (source: string) => source.replace('"SRC_ALPHA"', '"ONE"')],
    ['unbound features', (source: string) => `#define ALTER 1\n${source}`],
    ['unbound include', (source: string) => `Includes = { "unknown.fxh" }\n${source}`],
    ['byte budget', () => 'x'.repeat(GUI_SHADER_MAX_BYTES + 1)],
  ])('reports unsupported %s instead of accepting guessed progress pixels', (_name, change) => {
    expect(compileGuiProgressEffect(change(shader(true)), provenance, 'Texture').supported).toBe(
      false,
    );
  });

  it.each([true, false])(
    'paints texture-free colours at declared size with dynamic progress, horizontal=%s',
    async (horizontal) => {
      const files = [
        file(
          'interface/progress.gui',
          'guiTypes = { containerWindowType = { name = "root" size = { width = 80 height = 60 } iconType = { name = "meter" spriteType = "GFX_meter" position = { x = 10 y = 10 } } } }',
        ),
        file(
          'interface/progress.gfx',
          `spriteTypes = { progressbartype = { name = "GFX_meter" color = { 0 1 0 } colortwo = { 1 0 0 } size = { x = 20 y = 20 } horizontal = ${horizontal ? 'yes' : 'no'} effectFile = "gfx/FX/threshold.lua" } }`,
        ),
        file('gfx/FX/threshold.shader', shader(false)),
      ];
      const graph = buildGuiSourceGraph(files, SymbolIndex.build(files));
      for (const ratio of [0, 0.25, 0.5, 1]) {
        const scene = await buildGuiScene(
          graph,
          files,
          'root',
          parsePreviewScenario({
            id: `ratio-${ratio}`,
            resolution: { width: 320, height: 200 },
            values: { 'meter.progress': ratio },
          }),
        );
        const meter = scene.elements.find(({ name }) => name === 'meter')!;
        expect(meter).toMatchObject({
          unclippedRect: { x: 10, y: 10, width: 20, height: 20 },
          progressRatio: ratio,
          progressColours: { first: '#00ff00ff', second: '#ff0000ff' },
          progressShader: { effect: 'Color' },
        });
        expect(scene.fidelity.unsupported).toEqual([]);
        const { data, info } = await sharp((await renderGuiScene(scene, ['full'])).images[0]!.png)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        for (let axis = 0; axis < 20; axis++) {
          const x = 10 + (horizontal ? axis : 10),
            y = 10 + (horizontal ? 10 : axis);
          const filled = horizontal ? axis < ratio * 20 : axis >= (1 - ratio) * 20;
          expect([
            ...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4),
          ]).toEqual(filled ? [0, 255, 0, 255] : [255, 0, 0, 255]);
        }
        expect(scene.bounds).toEqual({ x: 10, y: 10, width: 20, height: 20 });
      }
    },
  );

  it('selects one semi-transparent texture per pixel instead of blending the two layers together', async () => {
    const files = [
      file(
        'interface/progress.gui',
        'guiTypes = { containerWindowType = { name = "root" size = { width = 50 height = 30 } iconType = { name = "meter" spriteType = "GFX_meter" position = { x = 5 y = 5 } } } }',
      ),
      file(
        'interface/progress.gfx',
        'spriteTypes = { progressbartype = { name = "GFX_meter" textureFile1 = "gfx/first.png" textureFile2 = "gfx/second.png" effectFile = "gfx/FX/threshold.lua" } }',
      ),
      file('gfx/FX/threshold.shader', shader(true)),
    ];
    for (const [name, colour] of [
      ['first', '#ff000080'],
      ['second', '#0000ff80'],
    ])
      files.push(
        file(
          `gfx/${name}.png`,
          await sharp({ create: { width: 20, height: 10, channels: 4, background: colour! } })
            .png()
            .toBuffer(),
        ),
      );
    const scene = await buildGuiScene(
      buildGuiSourceGraph(files, SymbolIndex.build(files)),
      files,
      'root',
      parsePreviewScenario({
        id: 'alpha',
        resolution: { width: 320, height: 200 },
        values: { 'meter.progress': 0.5 },
      }),
    );
    expect(scene.elements.find(({ name }) => name === 'meter')!.progressShader).toMatchObject({
      effect: 'Texture',
      textureFiltering: { minification: 'nearest', magnification: 'nearest' },
    });
    const { data, info } = await sharp((await renderGuiScene(scene, ['full'])).images[0]!.png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [
      ...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4),
    ];
    const background = pixel(1, 1);
    for (const [x, foreground] of [
      [8, [255, 0, 0]],
      [22, [0, 0, 255]],
    ] as const) {
      const rendered = pixel(x, 8);
      for (let channel = 0; channel < 3; channel++)
        expect(
          Math.abs(
            rendered[channel]! -
              ((foreground[channel]! * 128) / 255 + (background[channel]! * 127) / 255),
          ),
        ).toBeLessThanOrEqual(1);
      expect(rendered[3]).toBe(255);
    }
  });
});
