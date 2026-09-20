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
  compileGuiShaderEffect,
  GUI_SHADER_MAX_BYTES,
} from '../../src/hoi4_agent_tools/gui/shader.js';
import type { GuiShaderEffect } from '../../src/hoi4_agent_tools/gui/shader.js';
import { referencedAssetPatternsForWindow } from '../../src/hoi4_agent_tools/gui/studio.js';

// Project-owned miniature programs, not copies of installed game shader files.
function source(body: string, effect: GuiShaderEffect = 'Disable'): string {
  return `VertexShader = { MainCode Position [[
    VS_OUTPUT main(VS_INPUT input) {
      VS_OUTPUT result;
      result.vPosition = mul(WorldViewProjectionMatrix, float4(input.vPosition.xyz, 1));
      result.vTexCoord = input.vTexCoord;
      result.vTexCoord += Offset;
      return result;
    }
  ]] }
  PixelShader = { Samplers = { MapTexture = { Index = 0 MagFilter = "Linear" MinFilter = "Linear" MipFilter = "None" AddressU = "Clamp" AddressV = "Clamp" } } MainCode Colour [[
    float4 main(VS_OUTPUT input) : PDX_COLOR { ${body} }
  ]] }
  BlendState Blend { BlendEnable = yes SourceBlend = "src_alpha" DestBlend = "inv_src_alpha" }
  Effect ${effect} { VertexShader = "Position" PixelShader = "Colour" }`;
}

const sample = 'float4 colour = tex2D(MapTexture, input.vTexCoord);';
const gray = `${sample} float luminance = dot(colour.rgb, float3(0.2f, 0.7f, 0.1f)); colour.rgb = float3(luminance); colour *= Color; return colour;`;
const provenance = { path: 'fixture:gfx/FX/custom.shader', sha256: 'a'.repeat(64) };
function compile(body: string, effect: GuiShaderEffect = 'Disable', time = 1) {
  return compileGuiShaderEffect(source(body, effect), provenance, effect, {
    time,
    animationTime: 0,
  });
}

function scanned(relativePath: string, content: string | Buffer, loadOrder = 0): ScannedFile {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  return {
    absolutePath: path.join('C:/fixture', relativePath),
    displayPath: `fixture${loadOrder}:${relativePath}`,
    relativePath,
    rootKind: 'fixture',
    loadOrder,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

describe('source-backed GUI colour shaders', () => {
  it('derives luminance and tint from source with alpha preserved', () => {
    const result = compileGuiShaderEffect(source(gray), provenance, 'Disable', {
      time: 1,
      animationTime: 0,
      colour: [1, 0.5, 0.25, 0.75],
    });
    expect(result).toMatchObject({
      supported: true,
      shader: {
        ...{ sourcePath: provenance.path, sourceHash: provenance.sha256 },
        effect: 'Disable',
        entryPoint: 'Colour',
      },
    });
    if (!result.supported) throw new Error(result.reason);
    expect(result.shader.colourMatrix).toEqual([
      0.2, 0.7, 0.1, 0, 0, 0.1, 0.35, 0.05, 0, 0, 0.05, 0.175, 0.025, 0, 0, 0, 0, 0, 0.75, 0,
    ]);
    const changed = compile(gray.replace('0.7f', '0.6f'));
    expect(changed.supported && changed.shader.colourMatrix[1]).toBe(0.6);
  });

  it('evaluates clock-dependent hover/press arithmetic without guessing an atlas frame', () => {
    const body = `${sample} float clock = saturate((Time - AnimationTime) * 4); clock *= clock; float3 amount = float3(0.1) * clock; colour.rgb += (0.5 + colour.rgb) * amount; return colour;`;
    const initial = compile(body, 'Over', 0);
    const middle = compile(body, 'Over', 0.125);
    const settled = compile(body, 'Over', 1);
    expect(initial.supported && initial.shader.colourMatrix.slice(0, 5)).toEqual([1, 0, 0, 0, 0]);
    expect(middle.supported && middle.shader.colourMatrix.slice(0, 5)).toEqual([
      1.025, 0, 0, 0, 0.0125,
    ]);
    expect(settled.supported && settled.shader.colourMatrix.slice(0, 5)).toEqual([
      1.1, 0, 0, 0, 0.05,
    ]);
    const pressed = compile(body.replace('colour.rgb +=', 'colour.rgb -='), 'Down', 1);
    expect(pressed.supported && pressed.shader.colourMatrix.slice(0, 5)).toEqual([
      0.9, 0, 0, 0, -0.05,
    ]);
  });

  it('supports vector arithmetic, swizzles and constant interpolation', () => {
    const result = compile(
      `${sample} float3 mixed = lerp(colour.bgr, colour.rgb, 0.25); colour.rgb = mixed / 2; colour.a *= max(0.1, pow(0.5, 2)); return colour;`,
    );
    expect(result.supported && result.shader.colourMatrix).toEqual([
      0.125, 0, 0.375, 0, 0, 0, 0.5, 0, 0, 0, 0.375, 0, 0.125, 0, 0, 0, 0, 0, 0.25, 0,
    ]);
  });

  it('excludes inactive known features but rejects unknown feature branches', () => {
    const body = `${sample}\n#ifdef ANIMATED\ncolour = Animate(colour);\n#else\ncolour.rgb *= 0.5;\n#endif\nreturn colour;`;
    const result = compile(body);
    expect(result.supported && result.shader.colourMatrix[0]).toBe(0.5);
    expect(compile(body.replace('ANIMATED', 'UNBOUND_FEATURE'))).toMatchObject({
      supported: false,
      reason: expect.stringContaining('UNBOUND_FEATURE'),
    });
    expect(compile(body.replace('#endif', ''))).toMatchObject({ supported: false });
  });

  it.each(
    [
      `${sample} colour.rgb *= colour.rgb; return colour;`,
      `${sample} colour = tex2D(OtherTexture, input.vTexCoord); return colour;`,
      `${sample} colour = tex2D(MapTexture, input.vTexCoord + float2(0.1)); return colour;`,
      `${sample} colour.rgb = saturate(colour.rgb); return colour;`,
      `${sample} colour.rgb = float2(1, 2); return colour;`,
      `${sample} colour.rr = float2(1, 2); return colour;`,
      `${sample} colour /= 0; return colour;`,
      `${sample} colour *= Missing; return colour;`,
      `${sample} colour *= ${'Unbound'.repeat(1000)}; return colour;`,
      `${sample} Color *= 0.5; return colour;`,
      `${sample} if (colour.a > 0) { colour.rgb *= 2; } return colour;`,
      `${sample} return colour; colour.rgb *= 2;`,
      `${sample} return process.exit();`,
      `${sample} colour.rgb = float3(1e100); return colour;`,
      `${sample} colour *= ${'('.repeat(70)}1${')'.repeat(70)}; return colour;`,
      `${sample} ${'colour *= 1;'.repeat(128)} return colour;`,
      `${sample} return colour; ${' '.repeat(GUI_SHADER_MAX_BYTES)}`,
    ].map((body, index) => [index, body] as const),
  )('rejects unsupported or over-budget source without execution (case %i)', (_index, body) => {
    expect(compile(body).supported).toBe(false);
  });

  it('does not claim modelled rendering for changed geometry, blending or absent entry points', () => {
    for (const shaderSource of [
      source(gray).replace('result.vTexCoord += Offset;', 'result.vTexCoord *= 0.5;'),
      source(gray).replace('"inv_src_alpha"', '"one"'),
      source(gray).replace('BlendEnable = yes', 'BlendEnable = yes BlendOp = "subtract"'),
      source(gray).replace('BlendEnable = yes', 'BlendEnable = yes BlendEnable = no'),
      source(gray).replace(
        'PixelShader = "Colour"',
        'PixelShader = "Colour" PixelShader = "Colour"',
      ),
      source(gray).replace('PixelShader = "Colour"', 'PixelShader = "Missing"'),
      source(gray).replace('Effect Disable', 'Effect Down'),
      source(gray).replace('Index = 0', 'Index = 1'),
      source(gray).replace('AddressU = "Clamp"', 'AddressU = "Wrap"'),
      source(gray).replace('MipFilter = "None"', 'MipFilter = "Linear"'),
      source(gray).replace('MagFilter = "Linear"', 'MagFilter = "Anisotropic"'),
    ])
      expect(
        compileGuiShaderEffect(shaderSource, provenance, 'Disable', { time: 1, animationTime: 0 })
          .supported,
      ).toBe(false);
  });

  it('resolves legacy effect aliases and shades disabled pixels through the actual scene/render pipeline', async () => {
    const texture = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#c86432' },
    })
      .png()
      .toBuffer();
    const files = [
      scanned(
        'interface/shader.gui',
        `guiTypes = { containerWindowType = { name = "shader_window" size = { width = 120 height = 80 }
        buttonType = { name = "control" position = { x = 20 y = 20 } quadTextureSprite = "GFX_control" enabled = no }
      } }`,
      ),
      scanned(
        'interface/shader.gfx',
        'spriteTypes = { spriteType = { name = "GFX_control" texturefile = "gfx/control.png" noOfFrames = 1 effectFile = "gfx/FX/custom.lua" } }',
      ),
      scanned('gfx/control.png', texture),
      scanned('gfx/FX/custom.shader', source(gray)),
    ];
    const graph = buildGuiSourceGraph(files, SymbolIndex.build(files));
    expect(referencedAssetPatternsForWindow(graph, 'shader_window')).toEqual(
      expect.arrayContaining(['gfx/FX/custom.lua', 'gfx/FX/custom.shader']),
    );
    const scene = await buildGuiScene(
      graph,
      files,
      'shader_window',
      parsePreviewScenario({ id: 'disabled', resolution: { width: 480, height: 320 }, uiScale: 1 }),
    );
    const control = scene.elements.find(({ name }) => name === 'control')!;
    expect(control).toMatchObject({
      state: 'disabled',
      clickable: false,
      sprite: { frame: 0 },
      spriteShader: { effect: 'Disable', sourceHash: files[3]!.sha256 },
    });
    expect(scene.fidelity.unsupported.filter(({ field }) => field === 'effectFile')).toEqual([]);
    const render = await renderGuiScene(scene, ['full']);
    const decoded = await sharp(render.images[0]!.png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const offset = (22 * decoded.info.width + 22) * 4;
    expect([...decoded.data.subarray(offset, offset + 4)]).toEqual([115, 115, 115, 255]);
    expect(render.images[0]!.svg).toContain('color-interpolation-filters="sRGB"');
  });

  it('keeps explicit frames, checked state and shader state independent, including row overrides', async () => {
    const texture = await sharp({
      create: { width: 32, height: 8, channels: 4, background: '#c86432' },
    })
      .png()
      .toBuffer();
    const multiEffect =
      source(gray) +
      ['Up', 'Over', 'Down']
        .map((effect) => `Effect ${effect} { VertexShader = "Position" PixelShader = "Colour" }`)
        .join('\n');
    const files = [
      scanned(
        'interface/shader.gui',
        `guiTypes = { containerWindowType = { name = "shader_window" size = { width = 120 height = 80 }
        buttonType = { name = "explicit" quadTextureSprite = "GFX_control" }
        checkBoxType = { name = "check" quadTextureSprite = "GFX_control" frame = 0 }
        buttonType = { name = "pressed" quadTextureSprite = "GFX_control" }
        gridBoxType = { name = "rows" position = { x = 0 y = 20 } size = { width = 120 height = 40 } slotsize = { width = 120 height = 20 }
          buttonType = { name = "row_button" quadTextureSprite = "GFX_control" }
        }
      } }`,
      ),
      scanned(
        'interface/shader.gfx',
        'spriteTypes = { spriteType = { name = "GFX_control" texturefile = "gfx/control.png" noOfFrames = 4 effectFile = "gfx/FX/custom.shader" } }',
      ),
      scanned('gfx/control.png', texture),
      scanned('gfx/FX/custom.shader', multiEffect),
    ];
    const graph = buildGuiSourceGraph(files, SymbolIndex.build(files));
    const scene = await buildGuiScene(
      graph,
      files,
      'shader_window',
      parsePreviewScenario({
        id: 'states',
        elementStates: { explicit: 'disabled', check: 'disabled' },
        values: { 'explicit.frame': 3, 'check.checked': true, 'pressed.pressed': true },
        lists: {
          rows: [
            { 'row_button.pressed': true, 'row_button.frame': 2 },
            { 'row_button.enabled': false, 'row_button.frame': 3 },
          ],
        },
      }),
    );
    expect(scene.elements.find(({ name }) => name === 'explicit')).toMatchObject({
      sprite: { frame: 2 },
      spriteShader: { effect: 'Disable' },
    });
    expect(scene.elements.find(({ name }) => name === 'check')).toMatchObject({
      sprite: { frame: 1 },
      spriteShader: { effect: 'Disable' },
    });
    expect(scene.elements.find(({ name }) => name === 'pressed')).toMatchObject({
      sprite: { frame: 0 },
      spriteShader: { effect: 'Down' },
    });
    expect(scene.elements.filter(({ name }) => name === 'row_button')).toMatchObject([
      { sprite: { frame: 1 }, spriteShader: { effect: 'Down' } },
      { clickable: false, sprite: { frame: 2 }, spriteShader: { effect: 'Disable' } },
    ]);
    const hover = await buildGuiScene(
      graph,
      files,
      'shader_window',
      parsePreviewScenario({ id: 'hover', elementStates: { check: 'hover' } }),
    );
    expect(hover.elements.find(({ name }) => name === 'check')).toMatchObject({
      sprite: { frame: 0 },
      spriteShader: { effect: 'Over' },
    });
  });

  it('honours source point sampling at enlarged pixel boundaries', async () => {
    const png = await sharp(Buffer.from([200, 0, 0, 255, 0, 0, 200, 255]), {
      raw: { width: 2, height: 1, channels: 4 },
    })
      .png()
      .toBuffer();
    const files = [
      scanned(
        'interface/pixels.gui',
        'guiTypes = { containerWindowType = { name = "pixels" size = { width = 100 height = 80 } iconType = { name = "image" position = { x = 20 y = 20 } size = { width = 8 height = 4 } spriteType = "GFX_pixels" } } }',
      ),
      scanned(
        'interface/pixels.gfx',
        'spriteTypes = { spriteType = { name = "GFX_pixels" texturefile = "gfx/pixels.png" effectFile = "gfx/FX/pixels.shader" } }',
      ),
      scanned('gfx/pixels.png', png),
      scanned(
        'gfx/FX/pixels.shader',
        source(`${sample} return colour;`, 'Up').replaceAll('"Linear"', '"Point"'),
      ),
    ];
    const scene = await buildGuiScene(
      buildGuiSourceGraph(files, SymbolIndex.build(files)),
      files,
      'pixels',
      parsePreviewScenario({ id: 'point', resolution: { width: 480, height: 320 } }),
    );
    expect(
      scene.elements.find(({ name }) => name === 'image')?.spriteShader?.textureFiltering,
    ).toEqual({ magnification: 'nearest', minification: 'nearest' });
    const output = await renderGuiScene(scene, ['full']);
    const { data, info } = await sharp(output.images[0]!.png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (x: number) => [
      ...data.subarray((21 * info.width + x) * 4, (21 * info.width + x) * 4 + 4),
    ];
    expect(pixel(23)).toEqual([200, 0, 0, 255]);
    expect(pixel(24)).toEqual([0, 0, 200, 255]);
    expect(pixel(19)).toEqual([23, 32, 42, 255]);
  });
});
