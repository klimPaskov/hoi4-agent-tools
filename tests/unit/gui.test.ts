import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import { RenderBudget } from '../../src/hoi4_agent_tools/core/render-budget.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import type {
  TransactionManager,
  TransactionManifest,
} from '../../src/hoi4_agent_tools/core/transactions.js';
import {
  GuiAssetCatalog,
  GUI_BMFONT_MAX_BYTES,
  GUI_BMFONT_MAX_CHARACTERS,
  GUI_BMFONT_MAX_FIELDS_PER_RECORD,
  GUI_BMFONT_MAX_KERNING_PAIRS,
  GUI_BMFONT_MAX_PAGES,
  GUI_BMFONT_MAX_RECORDS,
  GUI_GRAPH_MAX_EDGES,
  GUI_GRAPH_MAX_ELEMENTS,
  GUI_GRAPH_MAX_NODES,
  GUI_SCENE_MAX_ELEMENTS,
  GUI_SCENE_MAX_TEXT_CHARACTERS,
  GUI_SCENE_MAX_TEXT_LAYOUT_OPERATIONS,
  GUI_TEXT_MAX_CHARACTERS,
  GUI_TEXT_MAX_MISSING_GLYPH_SAMPLES,
  buildGuiScene,
  buildGuiSourceGraph,
  compileGuiHelpers,
  decodeDds,
  decodeTga,
  emptyFidelityReport,
  generateGuiPreviewScenarios,
  parseBmFont,
  parseGeneratedScenarioOptions,
  parsePreviewScenario,
  planGuiHelperCompilation,
  renderGuiScene,
  validateGuiScene,
  type GuiHelperNode,
  type GuiScene,
  type GuiSourceGraph,
} from '../../src/hoi4_agent_tools/gui/index.js';
import { referencedAssetPatternsForWindow } from '../../src/hoi4_agent_tools/gui/studio.js';

function scanned(relativePath: string, content: Buffer | string): ScannedFile {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
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

function sourceGraph(files: readonly ScannedFile[]) {
  return buildGuiSourceGraph(files, SymbolIndex.build(files));
}

function ddsHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(128);
  bytes.writeUInt32LE(0x2053_4444, 0);
  bytes.writeUInt32LE(124, 4);
  bytes.writeUInt32LE(0x100f, 8);
  bytes.writeUInt32LE(height, 12);
  bytes.writeUInt32LE(width, 16);
  bytes.writeUInt32LE(width * 4, 20);
  bytes.writeUInt32LE(32, 76);
  bytes.writeUInt32LE(0x1000, 108);
  return bytes;
}

function rgb32Dds(): Buffer {
  const header = ddsHeader(1, 1);
  header.writeUInt32LE(0x41, 80);
  header.writeUInt32LE(32, 88);
  header.writeUInt32LE(0x00ff_0000, 92);
  header.writeUInt32LE(0x0000_ff00, 96);
  header.writeUInt32LE(0x0000_00ff, 100);
  header.writeUInt32LE(0xff00_0000, 104);
  return Buffer.concat([header, Buffer.from([1, 2, 3, 255])]);
}

function dxt1Dds(): Buffer {
  const header = ddsHeader(4, 4);
  header.writeUInt32LE(0x4, 80);
  header.write('DXT1', 84, 'ascii');
  const block = Buffer.alloc(8);
  block.writeUInt16LE(0xf800, 0);
  block.writeUInt16LE(0, 2);
  return Buffer.concat([header, block]);
}

function dx10Dds(): Buffer {
  const header = ddsHeader(1, 1);
  header.writeUInt32LE(0x4, 80);
  header.write('DX10', 84, 'ascii');
  const extension = Buffer.alloc(20);
  extension.writeUInt32LE(29, 0);
  extension.writeUInt32LE(3, 4);
  extension.writeUInt32LE(1, 12);
  return Buffer.concat([header, extension, Buffer.from([4, 5, 6, 7])]);
}

function fourCcDds(code: string, block: Buffer, width = 4, height = 4): Buffer {
  const header = ddsHeader(width, height);
  header.writeUInt32LE(0x4, 80);
  header.write(code, 84, 'ascii');
  return Buffer.concat([header, block]);
}

function rgbDds(bitCount: 24 | 32, pixels: Buffer, pitch = 0): Buffer {
  const header = ddsHeader(1, 1);
  header.writeUInt32LE(0x40, 80);
  header.writeUInt32LE(pitch, 20);
  header.writeUInt32LE(bitCount, 88);
  header.writeUInt32LE(0x00ff_0000, 92);
  header.writeUInt32LE(0x0000_ff00, 96);
  header.writeUInt32LE(0x0000_00ff, 100);
  header.writeUInt32LE(bitCount === 32 ? 0xff00_0000 : 0, 104);
  return Buffer.concat([header, pixels]);
}

function tgaHeader(options: {
  type: number;
  width?: number;
  height?: number;
  depth: number;
  descriptor?: number;
  idLength?: number;
  colourMapType?: number;
  colourMapFirst?: number;
  colourMapLength?: number;
  colourMapDepth?: number;
}): Buffer {
  const header = Buffer.alloc(18);
  header[0] = options.idLength ?? 0;
  header[1] = options.colourMapType ?? 0;
  header[2] = options.type;
  header.writeUInt16LE(options.colourMapFirst ?? 0, 3);
  header.writeUInt16LE(options.colourMapLength ?? 0, 5);
  header[7] = options.colourMapDepth ?? 0;
  header.writeUInt16LE(options.width ?? 1, 12);
  header.writeUInt16LE(options.height ?? 1, 14);
  header[16] = options.depth;
  header[17] = options.descriptor ?? 0x20;
  return header;
}

async function fixtureFiles(): Promise<ScannedFile[]> {
  const strip = await sharp({
    create: { width: 8, height: 4, channels: 4, background: { r: 220, g: 40, b: 30, alpha: 0.8 } },
  })
    .png()
    .toBuffer();
  const icons = Array.from({ length: 150 }, (_unused, index) => {
    const x = (index % 15) * 35;
    const y = 170 + Math.floor(index / 15) * 28;
    return `\t\ticonType = { name = "icon_${index}" position = { x = ${x} y = ${y} } size = { width = 20 height = 20 } spriteType = "GFX_test"${index === 0 ? ' rotation = 5' : ''} }`;
  }).join('\n');
  const gui = `guiTypes = {
\tcontainerWindowType = {
\t\tname = "test_window"
\t\tposition = { x = 0 y = 0 }
\t\tsize = { width = 600 height = 500 }
\t\tclipping = yes
\t\tbuttonType = { name = "tab_1" position = { x = 10 y = 10 } size = { width = 80 height = 24 } spriteType = "GFX_test" }
\t\tbuttonType = { name = "tab_2" position = { x = 10 y = 10 } size = { width = 80 height = 24 } spriteType = "GFX_test" }
\t\tbuttonType = { name = "tab_3" position = { x = 100 y = 10 } size = { width = 80 height = 24 } spriteType = "GFX_test" }
\t\tbuttonType = { name = "tab_4" position = { x = 190 y = 10 } size = { width = 80 height = 24 } spriteType = "GFX_test" }
\t\tbuttonType = { name = "tab_5" position = { x = 280 y = 10 } size = { width = 80 height = 24 } spriteType = "GFX_test" }
\t\tinstantTextBoxType = { name = "title" position = { x = 10 y = 42 } size = { width = 40 height = 10 } text = "LONG_TITLE" font = "fixture_font" fixedsize = yes }
\t\tinstantTextBoxType = { name = "missing_loc" position = { x = 10 y = 60 } size = { width = 100 height = 20 } text = "UNLOC_KEY" font = "fixture_font" }
\t\ticonType = { name = "animated" position = { x = 120 y = 55 } size = { width = 32 height = 16 } spriteType = "GFX_anim" }
\t\ticonType = { name = "missing_sprite" position = { x = 160 y = 55 } size = { width = 32 height = 16 } spriteType = "GFX_missing" }
\t\tprogressbarType = { name = "meter" position = { x = 10 y = 90 } size = { width = 200 height = 16 } spriteType = "GFX_test" }
\t\tlistboxType = {
\t\t\tname = "target_list"
\t\t\tposition = { x = 10 y = 112 }
\t\t\tsize = { width = 220 height = 45 }
\t\t\tclipping = yes
\t\t\tspacing = { x = 0 y = 2 }
\t\t\tbuttonType = { name = "target_row" position = { x = 0 y = 0 } size = { width = 210 height = 18 } spriteType = "GFX_test" instantTextBoxType = { name = "target_label" position = { x = 4 y = 1 } size = { width = 180 height = 16 } text = "[label]" font = "fixture_font" } }
\t\t}
\t\tcontainerWindowType = { name = "confirmation_modal" position = { x = 300 y = 90 } size = { width = 180 height = 70 } buttonType = { name = "confirm" position = { x = 10 y = 35 } size = { width = 70 height = 20 } spriteType = "GFX_test" pdx_tooltip = "CONFIRM_COST_TT" } }
\t\ticonType = { name = "clipped_icon" position = { x = 590 y = 490 } size = { width = 30 height = 30 } spriteType = "GFX_test" }
${icons}
\t}
}
`;
  const gfx = `spriteTypes = {
\tspriteType = { name = "GFX_test" texturefile = "gfx/interface/test.png" noOfFrames = 2 }
\tframeAnimatedSpriteType = { name = "GFX_anim" texturefile = "gfx/interface/test.png" noOfFrames = 2 animation_rate_fps = 2.5 looping = yes play_on_show = yes }
}
bitmapfonts = { bitmapfont = { name = "fixture_font" path = "fonts/fixture_font.fnt" } }
`;
  const effects = ['tab_1', 'tab_2', 'tab_3', 'tab_4', 'target_row']
    .map((name) => `\t\t\t${name}_click = { }`)
    .join('\n');
  const triggers = ['tab_1', 'tab_2', 'tab_3', 'tab_4', 'target_row']
    .map((name) => `\t\t\t${name}_click_enabled = { always = yes }`)
    .join('\n');
  const scripted = `scripted_gui = {
\tdemo_gui = {
\t\tcontext_type = country
\t\twindow_name = test_window
\t\teffects = {
${effects}
\t\t\tconfirm_click = { add_political_power = -15 }
\t\t}
\t\ttriggers = {
${triggers}
\t\t}
\t}
}
`;
  const characters = Array.from(
    { length: 95 },
    (_unused, index) =>
      `char id=${index + 32} x=0 y=0 width=8 height=16 xoffset=0 yoffset=0 xadvance=8 page=0 chnl=15`,
  ).join('\n');
  const font = `info face="Fixture" size=16\ncommon lineHeight=18 base=14 scaleW=8 scaleH=8 pages=1 packed=0\npage id=0 file="fixture_font.png"\nchars count=95\n${characters}\nkerning first=65 second=86 amount=-2\n`;
  return [
    scanned('interface/test.gui', gui),
    scanned('interface/test.gfx', gfx),
    scanned('common/scripted_guis/test.txt', scripted),
    scanned(
      'common/scripted_localisation/test.txt',
      'defined_text = { name = GetFixtureText text = { trigger = { always = yes } localisation_key = LONG_TITLE } }\n',
    ),
    scanned(
      'localisation/english/test_l_english.yml',
      '\uFEFFl_english:\nLONG_TITLE: "A deliberately long title for overflow validation"\nCONFIRM_COST_TT: "Cost: £pol_power 10"\n',
    ),
    scanned('gfx/interface/test.png', strip),
    scanned('fonts/fixture_font.fnt', font),
  ];
}

describe('GUI raster decoders', () => {
  it('decodes RGB32, DXT1, and DX10 vanilla DDS variants', () => {
    const rgb = decodeDds(rgb32Dds());
    expect('unsupported' in rgb).toBe(false);
    if (!('unsupported' in rgb)) expect([...rgb.data]).toEqual([3, 2, 1, 255]);
    const dxt = decodeDds(dxt1Dds());
    expect('unsupported' in dxt).toBe(false);
    if (!('unsupported' in dxt)) expect([...dxt.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    const dx10 = decodeDds(dx10Dds());
    expect('unsupported' in dx10).toBe(false);
    if (!('unsupported' in dx10)) expect([...dx10.data]).toEqual([4, 5, 6, 7]);
  });

  it('decodes top-origin 24-bit TGA assets', () => {
    const header = Buffer.alloc(18);
    header[2] = 2;
    header.writeUInt16LE(2, 12);
    header.writeUInt16LE(1, 14);
    header[16] = 24;
    header[17] = 0x20;
    const result = decodeTga(Buffer.concat([header, Buffer.from([1, 2, 3, 4, 5, 6])]));
    expect('unsupported' in result).toBe(false);
    if (!('unsupported' in result)) expect([...result.data]).toEqual([3, 2, 1, 255, 6, 5, 4, 255]);
  });

  it('decodes the supported DDS surface variants and refuses malformed headers and payloads', () => {
    const invalidHeader = ddsHeader(1, 1);
    invalidHeader.writeUInt32LE(0, 4);
    const invalidDimensions = ddsHeader(0, 1);
    const nonRgb = ddsHeader(1, 1);
    const invalidDepth = ddsHeader(1, 1);
    invalidDepth.writeUInt32LE(0x40, 80);
    invalidDepth.writeUInt32LE(16, 88);

    expect(decodeDds(Buffer.alloc(4))).toMatchObject({ unsupported: true, format: 'not-dds' });
    expect(decodeDds(invalidHeader)).toMatchObject({
      unsupported: true,
      format: 'invalid-header',
    });
    expect(decodeDds(invalidDimensions)).toMatchObject({
      unsupported: true,
      format: 'invalid-dimensions',
    });
    expect(decodeDds(nonRgb)).toMatchObject({ unsupported: true, format: 'non-rgb' });
    expect(decodeDds(invalidDepth)).toMatchObject({ unsupported: true, format: 'rgb16' });

    const rgb24 = decodeDds(rgbDds(24, Buffer.from([1, 2, 3])));
    expect(rgb24).toMatchObject({ width: 1, height: 1, format: 'rgb24' });
    if (!('unsupported' in rgb24)) expect([...rgb24.data]).toEqual([3, 2, 1, 255]);
    expect(decodeDds(rgbDds(24, Buffer.alloc(0)))).toMatchObject({
      unsupported: true,
      format: 'rgb24',
    });

    const noMasks = ddsHeader(1, 1);
    noMasks.writeUInt32LE(0x40, 80);
    noMasks.writeUInt32LE(32, 88);
    const noMaskDecoded = decodeDds(Buffer.concat([noMasks, Buffer.from([9, 8, 7, 6])]));
    expect(noMaskDecoded).toMatchObject({ format: 'rgba32' });
    if (!('unsupported' in noMaskDecoded)) expect([...noMaskDecoded.data]).toEqual([0, 0, 0, 255]);

    const linearSizeHeader = ddsHeader(2, 2);
    linearSizeHeader.writeUInt32LE(0x81_007, 8);
    linearSizeHeader.writeUInt32LE(16, 20);
    linearSizeHeader.writeUInt32LE(0x41, 80);
    linearSizeHeader.writeUInt32LE(32, 88);
    linearSizeHeader.writeUInt32LE(0x00ff_0000, 92);
    linearSizeHeader.writeUInt32LE(0x0000_ff00, 96);
    linearSizeHeader.writeUInt32LE(0x0000_00ff, 100);
    linearSizeHeader.writeUInt32LE(0xff00_0000, 104);
    const linearSizeDecoded = decodeDds(Buffer.concat([linearSizeHeader, Buffer.alloc(16, 0xff)]));
    expect(linearSizeDecoded).toMatchObject({ width: 2, height: 2, format: 'rgba32' });

    const dxt3 = Buffer.alloc(16, 0xff);
    dxt3.writeUInt16LE(0xf800, 8);
    dxt3.writeUInt16LE(0x001f, 10);
    dxt3.writeUInt32LE(0, 12);
    const dxt3Decoded = decodeDds(fourCcDds('DXT3', dxt3));
    expect(dxt3Decoded).toMatchObject({ format: 'dxt3' });
    if (!('unsupported' in dxt3Decoded))
      expect([...dxt3Decoded.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);

    for (const [alpha0, alpha1] of [
      [200, 100],
      [10, 20],
    ] as const) {
      const dxt5 = Buffer.alloc(16);
      dxt5[0] = alpha0;
      dxt5[1] = alpha1;
      dxt5.writeUInt16LE(0x07e0, 8);
      dxt5.writeUInt16LE(0x001f, 10);
      const decoded = decodeDds(fourCcDds('DXT5', dxt5));
      expect(decoded).toMatchObject({ format: 'dxt5' });
      if (!('unsupported' in decoded)) expect(decoded.data[3]).toBe(alpha0);
    }

    const croppedDxt1 = decodeDds(fourCcDds('DXT1', dxt1Dds().subarray(128), 1, 1));
    expect(croppedDxt1).toMatchObject({ width: 1, height: 1, format: 'dxt1' });
    expect(decodeDds(fourCcDds('DXT1', Buffer.alloc(7)))).toMatchObject({
      unsupported: true,
      format: 'dxt1',
    });
    expect(decodeDds(fourCcDds('RXGB', Buffer.alloc(16)))).toMatchObject({
      unsupported: true,
      format: 'RXGB',
    });
    expect(decodeDds(fourCcDds('ABCD', Buffer.alloc(16)))).toMatchObject({
      unsupported: true,
      format: 'ABCD',
    });

    const dx10Truncated = fourCcDds('DX10', Buffer.alloc(0), 1, 1);
    expect(decodeDds(dx10Truncated)).toMatchObject({ unsupported: true, format: 'DX10' });
    for (const [dxgiFormat, arraySize, pixel, expected] of [
      [29, 2, Buffer.alloc(4), 'DX10/29'],
      [2, 1, Buffer.alloc(4), 'DX10/2'],
      [29, 1, Buffer.alloc(0), 'dx10-rgba8-srgb'],
    ] as const) {
      const extension = Buffer.alloc(20);
      extension.writeUInt32LE(dxgiFormat, 0);
      extension.writeUInt32LE(arraySize, 12);
      expect(decodeDds(fourCcDds('DX10', Buffer.concat([extension, pixel]), 1, 1))).toMatchObject({
        unsupported: true,
        format: expected,
      });
    }
    const bgraExtension = Buffer.alloc(20);
    bgraExtension.writeUInt32LE(91, 0);
    bgraExtension.writeUInt32LE(1, 12);
    const bgra = decodeDds(
      fourCcDds('DX10', Buffer.concat([bgraExtension, Buffer.from([1, 2, 3, 4])]), 1, 1),
    );
    expect(bgra).toMatchObject({ format: 'dx10-bgra8-srgb' });
    if (!('unsupported' in bgra)) expect([...bgra.data]).toEqual([3, 2, 1, 4]);
  });

  it('decodes indexed, greyscale, true-colour, RLE, and origin TGA variants', () => {
    const indexed24 = decodeTga(
      Buffer.concat([
        tgaHeader({
          type: 1,
          depth: 8,
          colourMapType: 1,
          colourMapLength: 1,
          colourMapDepth: 24,
        }),
        Buffer.from([1, 2, 3, 0]),
      ]),
    );
    expect(indexed24).toMatchObject({ format: 'tga-indexed8' });
    if (!('unsupported' in indexed24)) expect([...indexed24.data]).toEqual([3, 2, 1, 255]);

    const indexed16 = decodeTga(
      Buffer.concat([
        tgaHeader({
          type: 1,
          depth: 16,
          descriptor: 0x21,
          colourMapType: 1,
          colourMapFirst: 1,
          colourMapLength: 1,
          colourMapDepth: 16,
        }),
        Buffer.from([0x00, 0xfc, 0x01, 0x00]),
      ]),
    );
    expect(indexed16).toMatchObject({ format: 'tga-indexed16' });

    const indexed32 = decodeTga(
      Buffer.concat([
        tgaHeader({
          type: 1,
          depth: 8,
          colourMapType: 1,
          colourMapLength: 1,
          colourMapDepth: 32,
        }),
        Buffer.from([1, 2, 3, 4, 0]),
      ]),
    );
    expect(indexed32).toMatchObject({ format: 'tga-indexed8' });
    if (!('unsupported' in indexed32)) expect([...indexed32.data]).toEqual([3, 2, 1, 4]);

    for (const [depth, payload, expected] of [
      [8, Buffer.from([17]), [17, 17, 17, 255]],
      [16, Buffer.from([17, 23]), [17, 17, 17, 23]],
    ] as const) {
      const decoded = decodeTga(Buffer.concat([tgaHeader({ type: 3, depth }), payload]));
      expect(decoded).toMatchObject({ format: `tga-gray${depth}` });
      if (!('unsupported' in decoded)) expect([...decoded.data]).toEqual(expected);
    }

    for (const [depth, descriptor, payload] of [
      [16, 0x21, Buffer.from([0x00, 0xfc])],
      [32, 0x20, Buffer.from([1, 2, 3, 4])],
    ] as const) {
      const decoded = decodeTga(
        Buffer.concat([tgaHeader({ type: 2, depth, descriptor }), payload]),
      );
      expect(decoded).toMatchObject({ format: `tga-rgba${depth}` });
    }

    const rightBottom = decodeTga(
      Buffer.concat([
        tgaHeader({ type: 2, width: 2, depth: 24, descriptor: 0x10, idLength: 1 }),
        Buffer.from([99, 1, 2, 3, 4, 5, 6]),
      ]),
    );
    expect(rightBottom).toMatchObject({ width: 2, height: 1 });
    if (!('unsupported' in rightBottom))
      expect([...rightBottom.data]).toEqual([6, 5, 4, 255, 3, 2, 1, 255]);

    const rleRun = decodeTga(
      Buffer.concat([tgaHeader({ type: 10, width: 2, depth: 24 }), Buffer.from([0x81, 1, 2, 3])]),
    );
    expect(rleRun).toMatchObject({ format: 'tga-rle-rgba24' });
    const rleRaw = decodeTga(
      Buffer.concat([tgaHeader({ type: 11, width: 2, depth: 8 }), Buffer.from([0x01, 10, 20])]),
    );
    expect(rleRaw).toMatchObject({ format: 'tga-rle-gray8' });
  });

  it('reports every unsafe or truncated TGA form without decoding partial pixels', () => {
    const cases: Array<[Buffer, string]> = [
      [Buffer.alloc(0), 'tga'],
      [tgaHeader({ type: 2, width: 0, depth: 24 }), 'tga'],
      [tgaHeader({ type: 7, depth: 24 }), 'tga-type-7'],
      [tgaHeader({ type: 1, depth: 8 }), 'tga-indexed'],
      [tgaHeader({ type: 2, depth: 8 }), 'tga-rgb8'],
      [tgaHeader({ type: 3, depth: 24 }), 'tga-gray24'],
      [tgaHeader({ type: 1, depth: 24, colourMapType: 1, colourMapLength: 1 }), 'tga-index24'],
      [
        tgaHeader({
          type: 1,
          depth: 8,
          colourMapType: 1,
          colourMapLength: 1,
          colourMapDepth: 8,
        }),
        'tga-palette8',
      ],
      [
        tgaHeader({
          type: 1,
          depth: 8,
          colourMapType: 1,
          colourMapLength: 1,
          colourMapDepth: 24,
        }),
        'tga-palette',
      ],
      [tgaHeader({ type: 2, depth: 24 }), 'tga'],
      [Buffer.concat([tgaHeader({ type: 10, depth: 24 }), Buffer.from([0x80])]), 'tga-rle'],
      [Buffer.concat([tgaHeader({ type: 10, depth: 24 }), Buffer.from([0x00])]), 'tga-rle'],
    ];
    for (const [bytes, format] of cases)
      expect(decodeTga(bytes)).toMatchObject({ unsupported: true, format });
  });

  it('blocks oversized DDS, TGA, and Sharp-decoded SVG assets before pixel allocation', async () => {
    expect(() => decodeDds(ddsHeader(4_097, 4_096))).toThrowError(
      expect.objectContaining({ code: 'RENDER_PIXELS_BLOCKED' }),
    );
    expect(() =>
      decodeTga(tgaHeader({ type: 2, width: 4_097, height: 4_096, depth: 24 })),
    ).toThrowError(expect.objectContaining({ code: 'RENDER_PIXELS_BLOCKED' }));

    const files = [
      scanned(
        'gfx/interface/oversized.svg',
        '<svg xmlns="http://www.w3.org/2000/svg" width="4097" height="4096"></svg>',
      ),
      scanned(
        'gfx/interface/nested-raster.svg',
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image href="data:image/png;base64,iVBORw0KGgo=" width="4096" height="4096"/></svg>',
      ),
    ];
    const catalog = new GuiAssetCatalog(sourceGraph(files), files);
    await expect(catalog.loadRaster('gfx/interface/oversized.svg')).rejects.toMatchObject({
      code: 'RENDER_ASSET_SVG_BLOCKED',
    });
    await expect(catalog.loadRaster('gfx/interface/nested-raster.svg')).rejects.toMatchObject({
      code: 'RENDER_ASSET_SVG_BLOCKED',
    });
  });
});

describe('Scripted GUI source graph, layout, rendering, and validation', () => {
  it('builds a connected 150+ element scene and renders deterministically', async () => {
    const files = await fixtureFiles();
    const graph = sourceGraph(files);
    expect(graph.elements.length).toBeGreaterThan(160);
    expect(graph.sprites.map(({ name }) => name)).toContain('GFX_anim');
    expect(graph.scriptedGuis[0]?.windowName).toBe('test_window');
    expect(graph.scriptedLocalisation[0]?.name).toBe('GetFixtureText');
    expect(graph.edges.some(({ kind, resolved }) => kind === 'uses_texture' && resolved)).toBe(
      true,
    );
    const scenario = parsePreviewScenario({
      id: 'fixture',
      resolution: { width: 640, height: 480 },
      animationTimeSeconds: 0.6,
      lists: {
        target_list: Array.from({ length: 5 }, (_unused, index) => ({
          id: index,
          label: `Target ${index}`,
        })),
      },
      elementStates: { tab_1: 'selected', tab_2: 'selected' },
    });
    const scene = await buildGuiScene(graph, files, 'test_window', scenario);
    expect(scene.elements.length).toBeGreaterThan(160);
    expect(scene.elements.find(({ name }) => name === 'title')?.text?.metricSource).toBe('bmfont');
    expect(scene.elements.find(({ name }) => name === 'animated')?.sprite?.frame).toBe(1);
    expect(scene.fidelity.ignored).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'pdx_tooltip' })]),
    );
    expect(scene.fidelity.modelled).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'fixedsize' })]),
    );
    expect(
      scene.elements.find(({ name, rowIndex }) => name === 'target_label' && rowIndex === 2)?.text
        ?.text,
    ).toBe('Target 2');
    expect(Object.keys(scene.fidelity).sort()).toEqual([
      'approximated',
      'ignored',
      'missing',
      'modelled',
      'unresolved',
      'unsupported',
    ]);
    const first = await renderGuiScene(scene);
    const second = await renderGuiScene(scene);
    expect(first.images.map(({ variant }) => variant)).toEqual([
      'full',
      'cropped',
      'annotated',
      'click-regions',
      'source-map',
    ]);
    const firstImage = first.images[0];
    const secondImage = second.images[0];
    expect(firstImage?.svg).not.toContain('OFFLINE APPROXIMATION');
    expect(firstImage?.svg).not.toContain('NOT HOI4');
    expect(firstImage?.png.equals(secondImage?.png ?? Buffer.alloc(0))).toBe(true);
    expect(first.layoutJson).toBe(second.layoutJson);
  });

  it('applies scripted image, frame, position, and inherited visibility scenario properties', async () => {
    const files = await fixtureFiles();
    const graph = sourceGraph(files);
    const scene = await buildGuiScene(
      graph,
      files,
      'test_window',
      parsePreviewScenario({
        id: 'scripted-properties',
        resolution: { width: 1920, height: 1080 },
        scriptedGui: {
          animated: 'GFX_test',
          'animated.frame': 2,
          'animated.x': 42,
          'animated.y': 77,
          'confirmation_modal.visible': false,
        },
      }),
    );
    expect(scene.elements.find(({ name }) => name === 'animated')).toMatchObject({
      rect: { x: 42, y: 77 },
      sprite: { spriteName: 'GFX_test', frame: 1 },
    });
    expect(scene.elements.find(({ name }) => name === 'confirmation_modal')?.visible).toBe(false);
    expect(scene.elements.find(({ name }) => name === 'confirm')?.visible).toBe(false);
    expect(scene.fidelity.modelled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'scripted_gui_image', elementId: expect.any(String) }),
        expect.objectContaining({ field: 'scripted_gui_position', elementId: expect.any(String) }),
      ]),
    );
  });

  it('applies parent-scripted-GUI visibility to the owned child window without hiding the shell', async () => {
    const files = [
      scanned(
        'interface/scripted-children.gui',
        'guiTypes = { containerWindowType = { name = "shell_window" position = { x = 100 y = 50 } size = { width = 200 height = 100 } } containerWindowType = { name = "child_window" position = { x = 12 y = 20 } size = { width = 100 height = 50 } instantTextBoxType = { name = "child_label" text = "LABEL" } } }',
      ),
      scanned(
        'common/scripted_guis/scripted-children.txt',
        'scripted_gui = { shell_gui = { context_type = player_context window_name = shell_window visible = { always = yes } } child_gui = { context_type = player_context parent_scripted_gui = shell_gui window_name = child_window visible = { always = yes } } }',
      ),
      scanned(
        'localisation/english/scripted_children_l_english.yml',
        '\uFEFFl_english:\nLABEL: "Child"\n',
      ),
    ];
    const scene = await buildGuiScene(
      sourceGraph(files),
      files,
      'shell_window',
      parsePreviewScenario({
        id: 'scripted-child-hidden',
        resolution: { width: 1920, height: 1080 },
        scriptedGui: {
          'shell_gui.visible': true,
          'child_gui.visible': false,
        },
      }),
    );
    expect(scene.elements.find(({ name }) => name === 'shell_window')?.visible).toBe(true);
    expect(scene.elements.find(({ name }) => name === 'child_window')?.visible).toBe(false);
    expect(scene.elements.find(({ name }) => name === 'child_label')?.visible).toBe(false);
    expect(scene.elements.find(({ name }) => name === 'child_window')?.unclippedRect).toMatchObject(
      {
        x: 112,
        y: 70,
      },
    );
    expect(scene.fidelity.modelled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'parent_scripted_gui_attachment' }),
      ]),
    );
  });

  it('applies literal scripted-GUI visibility and enabled triggers without scenario mocks', async () => {
    const files = [
      scanned(
        'interface/constant-triggers.gui',
        'guiTypes = { containerWindowType = { name = "constant_window" size = { width = 200 height = 100 } buttonType = { name = "hidden_action" size = { width = 80 height = 20 } } buttonType = { name = "disabled_action" position = { y = 30 } size = { width = 80 height = 20 } } } }',
      ),
      scanned(
        'common/scripted_guis/constant-triggers.txt',
        'scripted_gui = { constant_gui = { context_type = player_context window_name = constant_window effects = { disabled_action_click = { } } triggers = { hidden_action_visible = { always = no } disabled_action_click_enabled = { always = no } } } }',
      ),
    ];
    const graph = sourceGraph(files);
    expect(
      graph.scriptedGuis[0]?.triggerDefinitions.map(({ name, elementName, constantResult }) => ({
        name,
        elementName,
        constantResult,
      })),
    ).toEqual([
      {
        name: 'disabled_action_click_enabled',
        elementName: 'disabled_action',
        constantResult: false,
      },
      { name: 'hidden_action_visible', elementName: 'hidden_action', constantResult: false },
    ]);
    const scene = await buildGuiScene(
      graph,
      files,
      'constant_window',
      parsePreviewScenario({ id: 'constant-triggers', resolution: { width: 1920, height: 1080 } }),
    );
    expect(scene.elements.find(({ name }) => name === 'hidden_action')?.visible).toBe(false);
    expect(scene.elements.find(({ name }) => name === 'disabled_action')).toMatchObject({
      visible: true,
      clickable: false,
    });
  });

  it('expands scripted-GUI external dynamic-list entry containers with declared slot spacing', async () => {
    const files = [
      scanned(
        'interface/external-list.gui',
        `guiTypes = {
	containerWindowType = {
		name = "external_list_window"
		size = { width = 300 height = 200 }
		gridBoxType = {
			name = "external_list"
			position = { x = 20 y = 30 }
			size = { width = 200 height = 100 }
			slotsize = { width = 200 height = 24 }
			max_slots_horizontal = 1
		}
	}
	containerWindowType = {
		name = "generic_entry"
		position = { x = 3 y = 2 }
		size = { width = 180 height = 20 }
		instantTextBoxType = { name = "generic_label" text = "[?global.entries^entry_index.GetName]" }
	}
	containerWindowType = {
		name = "country_entry"
		position = { x = 3 y = 2 }
		size = { width = 180 height = 20 }
		iconType = { name = "country_flag" quadTextureSprite = "GFX_flag_small2" }
		instantTextBoxType = { name = "country_label" text = "[label]" }
	}
}`,
      ),
      scanned(
        'common/scripted_guis/external-list.txt',
        `scripted_gui = {
	external_list_gui = {
		context_type = country
		window_name = external_list_window
			dynamic_lists = {
			external_list = {
				entry_container = "generic_entry"
				country_scope_entry_container = "country_entry"
			}
			}
			properties = { country_flag = { image = "[?global.entries^entry_index.GetFlag]" } }
		}
}`,
      ),
      scanned(
        'interface/flags.gfx',
        'spriteTypes = { maskedShieldType = { name = "GFX_flag_small2" textureFile1 = "gfx/interface/flag_overlay.png" textureFile2 = "gfx/interface/flag_mask.png" effectFile = "gfx/FX/maskedflag.lua" } }',
      ),
      scanned(
        'gfx/interface/flag_overlay.png',
        await sharp({
          create: {
            width: 37,
            height: 22,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          },
        })
          .png()
          .toBuffer(),
      ),
      scanned(
        'gfx/interface/flag_mask.png',
        await sharp({
          create: {
            width: 37,
            height: 22,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 1 },
          },
        })
          .png()
          .toBuffer(),
      ),
      scanned(
        'gfx/flags/medium/FRA_democratic.png',
        await sharp({
          create: {
            width: 37,
            height: 22,
            channels: 4,
            background: { r: 25, g: 80, b: 220, alpha: 1 },
          },
        })
          .png()
          .toBuffer(),
      ),
      scanned(
        'gfx/flags/FRA_democratic.png',
        await sharp({
          create: {
            width: 82,
            height: 52,
            channels: 4,
            background: { r: 220, g: 40, b: 40, alpha: 1 },
          },
        })
          .png()
          .toBuffer(),
      ),
    ];
    const graph = sourceGraph(files);
    const scripted = graph.scriptedGuis.find(({ name }) => name === 'external_list_gui');
    expect(scripted?.dynamicListDefinitions).toEqual([
      expect.objectContaining({
        name: 'external_list',
        entryContainer: 'generic_entry',
        countryScopeEntryContainer: 'country_entry',
      }),
    ]);
    expect(
      graph.edges.filter(({ kind, resolved }) => kind === 'dynamic_list_template' && resolved),
    ).toHaveLength(2);

    const scene = await buildGuiScene(
      graph,
      files,
      'external_list_window',
      parsePreviewScenario({
        id: 'external-list',
        resolution: { width: 1920, height: 1080 },
        values: { 'global.entries^entry_index.GetFlag': 'FRA' },
        lists: {
          external_list: [
            { GetName: 'Generic row' },
            {
              label: 'Country row',
              countryScope: true,
              countryTag: 'FRA',
              ideology: 'democratic',
            },
          ],
        },
      }),
    );
    expect(scene.elements.find(({ name }) => name === 'generic_label')?.text?.text).toBe(
      'Generic row',
    );
    expect(scene.elements.find(({ name }) => name === 'country_label')?.text?.text).toBe(
      'Country row',
    );
    expect(scene.elements.find(({ name }) => name === 'generic_entry')?.unclippedRect.y).toBe(30);
    expect(scene.elements.find(({ name }) => name === 'country_entry')?.unclippedRect.y).toBe(54);
    const renderedFlag = scene.elements.find(
      ({ name, rowIndex }) => name === 'country_flag' && rowIndex === 1,
    )?.sprite;
    expect(renderedFlag).toMatchObject({
      spriteName: 'GFX_flag_FRA',
      texturePath: 'gfx/flags/medium/FRA_democratic.png',
      width: 37,
      height: 22,
      supported: true,
    });
    expect(renderedFlag?.dataUri).toMatch(/^data:image\/png;base64,/u);
    await expect(
      new GuiAssetCatalog(graph, files).loadCountryFlag(
        'FRA',
        undefined,
        'democratic',
        'GFX_flag_small2',
      ),
    ).resolves.toMatchObject({
      texturePath: 'gfx/flags/medium/FRA_democratic.png',
      width: 37,
      height: 22,
      supported: true,
    });
    expect(scene.fidelity.modelled).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'scripted_gui_dynamic_list' })]),
    );
  });

  it('distinguishes numeric and text dynamic placeholders and renders HOI4 localisation colour runs', async () => {
    const files = [
      scanned(
        'interface/colour-probe.gui',
        'guiTypes = { containerWindowType = { name = "colour_window" size = { width = 400 height = 100 } instantTextBoxType = { name = "colour_text" size = { width = 380 height = 30 } text = "DYNAMIC_COLOUR" } } }',
      ),
      scanned(
        'localisation/english/colour_probe_l_english.yml',
        '\uFEFFl_english:\nDYNAMIC_COLOUR: "Leader: §Y[GetDynamicLeader]§! Country: [FROM.GetName] Scoped: [?leader_scope.GetName] Risk: §R[?missing_risk|.0]§! Literal: [X]"\n',
      ),
    ];
    const scene = await buildGuiScene(
      sourceGraph(files),
      files,
      'colour_window',
      parsePreviewScenario({ id: 'colour-probe', resolution: { width: 640, height: 360 } }),
    );
    const text = scene.elements.find(({ name }) => name === 'colour_text')?.text;
    expect(text?.text).toBe(
      'Leader: [dynamic_loc] Country: [dynamic_loc] Scoped: [dynamic_loc] Risk: [X] Literal: [X]',
    );
    expect(text?.unresolvedTokens).toEqual([
      '[?leader_scope.GetName]',
      '[?missing_risk|.0]',
      '[FROM.GetName]',
      '[GetDynamicLeader]',
    ]);
    const runs = text?.colourRuns?.flat() ?? [];
    expect(
      runs.some(
        ({ text: value, colour }) => value.includes('[dynamic_loc]') && colour === '#ffbd00',
      ),
    ).toBe(true);
    expect(
      runs.some(({ text: value, colour }) => value.includes('[X]') && colour === '#ff3232'),
    ).toBe(true);
    const rendered = await renderGuiScene(scene, ['full']);
    expect(rendered.images[0]?.svg).toContain('data-hoi4-colour-runs="true"');
    expect(rendered.images[0]?.svg).toContain('fill="#ffbd00"');
    expect(rendered.images[0]?.svg).toContain('fill="#ff3232"');
  });

  it('generates deterministic source-aware scenarios with coherent panes, scopes, sprites, and values', () => {
    const files = [
      scanned(
        'interface/generated-scenario.gui',
        'guiTypes = { containerWindowType = { name = "generated_window" size = { width = 400 height = 180 } instantTextBoxType = { name = "generated_text" text = "GENERATED_TEXT" } iconType = { name = "threat_icon" } iconType = { name = "country_flag" quadTextureSprite = "GFX_flag_small2" } progressbarType = { name = "threat_meter" size = { width = 100 height = 10 } minValue = 10 maxValue = 20 startValue = threat_value } buttonType = { name = "status_tab_button_idle" } buttonType = { name = "status_tab_button_active" } buttonType = { name = "history_tab_button_idle" } buttonType = { name = "history_tab_button_active" } } containerWindowType = { name = "status_pane" position = { x = 20 y = 40 } size = { width = 300 height = 100 } } containerWindowType = { name = "history_pane" position = { x = 20 y = 40 } size = { width = 300 height = 100 } } containerWindowType = { name = "target_row" size = { width = 200 height = 20 } } }',
      ),
      scanned(
        'common/scripted_guis/generated-scenario.txt',
        'scripted_gui = { generated_gui = { context_type = country window_name = generated_window visible = { always = yes } dynamic_lists = { target_list = { entry_container = "target_row" } } properties = { threat_icon = { image = "[GetThreatSprite]" } country_flag = { image = "[ROOT.GetFlag]" } } triggers = { status_tab_button_idle_visible = { always = yes } status_tab_button_active_visible = { always = yes } history_tab_button_idle_visible = { always = yes } history_tab_button_active_visible = { always = yes } } } status_gui = { context_type = country parent_scripted_gui = generated_gui window_name = status_pane visible = { has_country_flag = show_status } } history_gui = { context_type = country parent_scripted_gui = generated_gui window_name = history_pane visible = { has_country_flag = show_history } } }',
      ),
      scanned(
        'common/scripted_localisation/generated-scenario.txt',
        'defined_text = { name = GetThreatSprite text = { trigger = { threat_bar > 79 } localization_key = GFX_threat_high } text = { trigger = { always = yes } localization_key = GFX_threat_low } } defined_text = { name = GetThreatStatus text = { trigger = { threat > 79 } localization_key = THREAT_ESCALATING } text = { trigger = { always = yes } localization_key = THREAT_CONTAINED } }',
      ),
      scanned(
        'interface/generated-scenario.gfx',
        'spriteTypes = { spriteType = { name = "GFX_threat_low" textureFile = "gfx/interface/threat_low.dds" } spriteType = { name = "GFX_threat_high" textureFile = "gfx/interface/threat_high.dds" } }',
      ),
      scanned(
        'localisation/english/generated_scenario_l_english.yml',
        '\uFEFFl_english:\nGENERATED_TEXT: "Status: [GetThreatStatus] Leader: [GetDynamicLeader] Risk: [?risk|.0] Country: [ROOT.GetName] Donor: [FROM.GetName]"\nTHREAT_CONTAINED: "§GContained§!"\nTHREAT_ESCALATING: "§REscalating§!"\n',
      ),
    ];
    const graph = sourceGraph(files);
    const base = parsePreviewScenario({
      id: 'placeholder',
      resolution: { width: 640, height: 360 },
      values: { risk: 42, threat: 85 },
    });
    const options = parseGeneratedScenarioOptions({
      count: 2,
      seed: 'fixed-seed',
      numericMinimum: 10,
      numericMaximum: 20,
      listRowsMinimum: 2,
      listRowsMaximum: 2,
    });
    expect(options.preservePlaceholder).toBe(false);
    const first = generateGuiPreviewScenarios(graph, 'generated_window', base, options);
    const second = generateGuiPreviewScenarios(graph, 'generated_window', base, options);
    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({
      id: 'placeholder-generated-1',
      values: {
        risk: 42,
        GetDynamicLeader: expect.any(String),
        'ROOT.GetName': expect.any(String),
        'FROM.GetName': expect.any(String),
        GetThreatStatus: '§REscalating§!',
        GetThreatSprite: 'GFX_threat_high',
        'ROOT.GetFlag': expect.stringMatching(/^[A-Z]{3}$/u),
        threat_meter: expect.any(Number),
        threat_value: expect.any(Number),
      },
      lists: { target_list: [expect.any(Object), expect.any(Object)] },
      country: {
        countryTag: expect.stringMatching(/^[A-Z]{3}$/u),
        ideology: expect.stringMatching(/^(?:communism|democratic|fascism|neutrality)$/u),
        countryIdeology: expect.stringMatching(/^(?:communism|democratic|fascism|neutrality)$/u),
      },
    });
    expect(first[0]?.values.GetDynamicLeader).not.toBe('[dynamic_loc]');
    expect(first[0]?.values['ROOT.GetName']).not.toBe('[dynamic_loc]');
    expect(first[0]?.values['ROOT.GetName']).not.toBe(first[0]?.values['FROM.GetName']);
    expect(first[0]?.values.GetName).toBeUndefined();
    expect(first[0]?.values.GetThreatSprite).not.toBe('In Progress');
    expect(first[0]?.values.threat_bar).toBe(85);
    expect(first[0]?.selectedFrames).toEqual({});
    expect(first[0]?.visibility.generated_gui).toBe(true);
    expect(
      [first[0]?.visibility.status_gui, first[0]?.visibility.history_gui].filter(Boolean),
    ).toHaveLength(1);
    expect(
      [
        first[0]?.visibility.status_tab_button_idle,
        first[0]?.visibility.status_tab_button_active,
      ].filter(Boolean),
    ).toHaveLength(1);
    expect(
      [
        first[0]?.visibility.history_tab_button_idle,
        first[0]?.visibility.history_tab_button_active,
      ].filter(Boolean),
    ).toHaveLength(1);
    expect(first[0]?.values.threat_meter).toBeGreaterThanOrEqual(10);
    expect(first[0]?.values.threat_meter).toBeLessThanOrEqual(20);
    expect(first[0]?.values.threat_value).toBe(first[0]?.values.threat_meter);

    const sampled = Array.from(
      { length: 128 },
      (_unused, index) =>
        generateGuiPreviewScenarios(
          graph,
          'generated_window',
          parsePreviewScenario({ id: `sample-${index}` }),
          parseGeneratedScenarioOptions({ count: 1, seed: `sample-${index}` }),
        )[0]!,
    );
    const sampledThreats = sampled.map(({ values }) => Number(values.threat));
    expect(new Set(sampledThreats).size).toBeGreaterThan(50);
    expect(sampledThreats.some((value) => value <= 79)).toBe(true);
    expect(sampledThreats.some((value) => value > 79)).toBe(true);
    for (const generated of sampled) {
      const threat = Number(generated.values.threat);
      expect(generated.values.threat_bar).toBe(threat);
      expect(generated.values.GetThreatStatus).toBe(
        threat > 79 ? '§REscalating§!' : '§GContained§!',
      );
      expect(generated.values.GetThreatSprite).toBe(
        threat > 79 ? 'GFX_threat_high' : 'GFX_threat_low',
      );
      expect(
        [generated.visibility.status_gui, generated.visibility.history_gui].filter(Boolean),
      ).toHaveLength(1);
    }
  });

  it('keeps generated values within displayed limits and favours ordinary values', () => {
    const files = [
      scanned(
        'interface/bounded-scenario.gui',
        'guiTypes = { containerWindowType = { name = "bounded_window" size = { width = 300 height = 100 } instantTextBoxType = { name = "bounded_text" text = "BOUNDED_TEXT" } } }',
      ),
      scanned(
        'localisation/english/bounded_scenario_l_english.yml',
        '\ufeffl_english:\nBOUNDED_TEXT: "Capacity: [?capacity|.0]/10 Used: [?used|.0]/[?limit|.0]"\n',
      ),
    ];
    const graph = sourceGraph(files);
    const generated = Array.from(
      { length: 128 },
      (_unused, index) =>
        generateGuiPreviewScenarios(
          graph,
          'bounded_window',
          parsePreviewScenario({ id: `bounded-${index}` }),
          parseGeneratedScenarioOptions({ count: 1, seed: `bounded-${index}` }),
        )[0]!,
    );
    for (const scenario of generated) {
      expect(Number(scenario.values.capacity)).toBeGreaterThanOrEqual(0);
      expect(Number(scenario.values.capacity)).toBeLessThanOrEqual(10);
      expect(Number(scenario.values.used)).toBeLessThanOrEqual(Number(scenario.values.limit));
    }
    const capacities = generated.map(({ values }) => Number(values.capacity));
    expect(capacities.filter((value) => value >= 3 && value <= 7).length).toBeGreaterThan(80);
    expect(capacities.filter((value) => value === 0 || value === 10).length).toBeLessThan(8);
    const conflictingBounds = generateGuiPreviewScenarios(
      graph,
      'bounded_window',
      parsePreviewScenario({ id: 'bounded-conflict' }),
      parseGeneratedScenarioOptions({
        count: 1,
        seed: 'bounded-conflict',
        numericMinimum: 50,
        numericMaximum: 100,
      }),
    )[0]!;
    expect(conflictingBounds.values.capacity).toBe(10);
  });

  it('scans dynamic scripted-localisation sprites and only relevant language font atlases', () => {
    const files = [
      scanned(
        'interface/referenced-assets.gui',
        'guiTypes = { containerWindowType = { name = "asset_window" size = { width = 200 height = 100 } iconType = { name = "dynamic_icon" } instantTextBoxType = { name = "label" text = "LABEL" font = "hoi_font" } } }',
      ),
      scanned(
        'common/scripted_guis/referenced-assets.txt',
        'scripted_gui = { asset_gui = { context_type = country window_name = asset_window properties = { dynamic_icon = { image = "[GetDynamicSprite]" } country_flag = { image = "[ROOT.GetFlag]" } } } }',
      ),
      scanned(
        'common/scripted_localisation/referenced-assets.txt',
        'defined_text = { name = GetDynamicSprite text = { trigger = { always = yes } localization_key = GFX_dynamic_low } text = { trigger = { always = no } localization_key = GFX_dynamic_high } }',
      ),
      scanned(
        'interface/referenced-assets.gfx',
        'spriteTypes = { spriteType = { name = "GFX_dynamic_low" textureFile = "gfx//interface//dynamic_low.tga" } spriteType = { name = "GFX_dynamic_high" textureFile = "gfx/interface/dynamic_high.dds" } } bitmapfonts = { bitmapfont = { name = "hoi_font" path = "fonts/hoi_font.fnt" } bitmapfont_override = { name = "hoi_font" languages = { l_english } path = "fonts/hoi_font_english.fnt" } bitmapfont_override = { name = "hoi_font" languages = { l_simp_chinese } path = "fonts/hoi_font_chinese.fnt" } }',
      ),
      scanned('gfx/interface/dynamic_low.dds', rgb32Dds()),
      scanned(
        'localisation/english/referenced_assets_l_english.yml',
        '\uFEFFl_english:\nLABEL: "Assets"\n',
      ),
    ];
    const patterns = referencedAssetPatternsForWindow(
      sourceGraph(files),
      'asset_window',
      [],
      ['l_english'],
    );
    expect(patterns).toEqual(
      expect.arrayContaining([
        'gfx/interface/dynamic_low.dds',
        'gfx/interface/dynamic_high.dds',
        'fonts/hoi_font.fnt',
        'fonts/hoi_font_english.fnt',
        'gfx/flags/*.{bmp,dds,png,tga}',
        'gfx/flags/medium/*.{bmp,dds,png,tga}',
        'gfx/flags/small/*.{bmp,dds,png,tga}',
      ]),
    );
    expect(patterns).not.toContain('fonts/hoi_font_chinese.fnt');
    expect(
      sourceGraph(files).edges.find(
        ({ kind, metadata }) =>
          kind === 'uses_texture' && metadata.texturePath === 'gfx//interface//dynamic_low.tga',
      ),
    ).toMatchObject({ resolved: true });
  });

  it('blocks aggregate scenario rows and nested list scene multiplication before expansion', async () => {
    expect(() =>
      parsePreviewScenario({
        id: 'too-many-rows',
        lists: {
          first: Array.from({ length: 6_000 }, () => ({})),
          second: Array.from({ length: 5_000 }, () => ({})),
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'GUI_SCENARIO_ROWS_BLOCKED' }));

    const files = [
      scanned(
        'interface/nested-list.gui',
        `guiTypes = {
	containerWindowType = {
		name = "nested_window"
		size = { width = 640 height = 480 }
		listboxType = {
			name = "outer"
			size = { width = 200 height = 200 }
			listboxType = {
				name = "inner"
				size = { width = 100 height = 100 }
				iconType = { name = "leaf" size = { width = 1 height = 1 } }
			}
		}
	}
}
`,
      ),
    ];
    const rows = Array.from({ length: 100 }, (_unused, index) => ({ index }));
    const innerRows = rows.map((row) => ({ ...row }));
    await expect(
      buildGuiScene(
        sourceGraph(files),
        files,
        'nested_window',
        parsePreviewScenario({ id: 'nested-list', lists: { outer: rows, inner: innerRows } }),
      ),
    ).rejects.toMatchObject({ code: 'GUI_SCENE_ELEMENT_BUDGET_BLOCKED' });
  });

  it('caps source-graph diagnostics with one explicit truncation blocker', () => {
    const malformed = Array.from({ length: 2_100 }, (_unused, index) =>
      scanned(`interface/malformed-${index}.gui`, 'guiTypes = {'),
    );
    const graph = sourceGraph(malformed);
    expect(graph.diagnostics).toHaveLength(2_000);
    expect(graph.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'GUI_GRAPH_DIAGNOSTICS_TRUNCATED' }),
      ]),
    );
  });

  it('rejects source-graph domain overflow before retaining the excess element', () => {
    let remaining = GUI_GRAPH_MAX_ELEMENTS + 1;
    let identifier = 0;
    const files: ScannedFile[] = [];
    while (remaining > 0) {
      const count = Math.min(1_000, remaining);
      const source = `guiTypes = { ${Array.from({ length: count }, () => {
        const entry = `iconType = { name = "icon_${identifier}" }`;
        identifier += 1;
        return entry;
      }).join(' ')} }`;
      files.push(scanned(`interface/domain-budget-${files.length}.gui`, source));
      remaining -= count;
    }
    expect(() => buildGuiSourceGraph(files, SymbolIndex.build([]))).toThrowError(
      expect.objectContaining({
        code: 'GUI_GRAPH_DOMAIN_BUDGET_BLOCKED',
        details: expect.objectContaining({
          domain: 'element',
          maximumEntries: GUI_GRAPH_MAX_ELEMENTS,
        }),
      }),
    );
  });

  it('retains bounded headroom over the current installed-data source graph', () => {
    expect(GUI_GRAPH_MAX_ELEMENTS).toBeGreaterThanOrEqual(24_146);
    expect(GUI_GRAPH_MAX_NODES).toBeGreaterThanOrEqual(198_135);
    expect(GUI_GRAPH_MAX_EDGES).toBeGreaterThanOrEqual(262_585);
  });

  it('links each parent-child relationship once across multiple GUI files', () => {
    const first = scanned(
      'interface/first.gui',
      'guiTypes = { containerWindowType = { name = "parent" iconType = { name = "child" } } }',
    );
    const second = scanned(
      'interface/second.gui',
      'guiTypes = { containerWindowType = { name = "unrelated" } }',
    );
    const graph = buildGuiSourceGraph([first, second], SymbolIndex.build([]));
    const parent = graph.elements.find(({ name }) => name === 'parent');
    const child = graph.elements.find(({ name }) => name === 'child');
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    if (parent === undefined || child === undefined) return;
    expect(parent.childIds).toEqual([child.id]);
    expect(new Set(parent.childIds).size).toBe(parent.childIds.length);
  });

  it('indexes only referenced localisation with mod precedence and suppresses baseline unresolved noise', () => {
    const rooted = (
      relativePath: string,
      content: string,
      rootKind: 'game' | 'mod',
      loadOrder: number,
    ): ScannedFile => ({
      ...scanned(relativePath, content),
      absolutePath: path.join(`C:/${rootKind}`, relativePath),
      displayPath: `${rootKind}:${relativePath}`,
      rootKind,
      loadOrder,
    });
    const files = [
      rooted(
        'interface/game.gui',
        'guiTypes = { iconType = { name = "game_icon" spriteType = "MISSING_GAME" } }',
        'game',
        0,
      ),
      rooted(
        'interface/mod.gui',
        'guiTypes = { instantTextBoxType = { name = "mod_text" text = "TITLE" } iconType = { name = "mod_icon" spriteType = "MISSING_MOD" } }',
        'mod',
        10,
      ),
      rooted(
        'localisation/english/game_l_english.yml',
        '\uFEFFl_english:\nTITLE: "Game title"\nUNUSED: "Not a GUI key"\n',
        'game',
        0,
      ),
      rooted(
        'localisation/english/mod_l_english.yml',
        '\uFEFFl_english:\nTITLE: "Mod title"\n',
        'mod',
        10,
      ),
    ];
    const graph = buildGuiSourceGraph(files, SymbolIndex.build(files.slice(0, 2)));
    expect(graph.localisation.map(({ key }) => key)).toEqual(['TITLE', 'TITLE']);
    const modLocalisationNode = graph.nodes.find(
      ({ kind, name, path: sourcePath }) =>
        kind === 'localisation' && name === 'TITLE' && sourcePath.startsWith('mod:'),
    );
    expect(modLocalisationNode).toBeDefined();
    expect(
      graph.edges.find(
        ({ kind, metadata }) => kind === 'uses_localisation' && metadata.key === 'TITLE',
      )?.to,
    ).toBe(modLocalisationNode?.id);
    expect(
      graph.diagnostics.some(
        ({ code, location }) =>
          code === 'GUI_REFERENCE_UNRESOLVED' && location?.path.startsWith('game:'),
      ),
    ).toBe(false);
    expect(
      graph.diagnostics.some(
        ({ code, location }) =>
          code === 'GUI_REFERENCE_UNRESOLVED' && location?.path.startsWith('mod:'),
      ),
    ).toBe(true);
  });

  it('samples non-looping, visible-clock, global-clock, and paused-loop animation timing', async () => {
    const files = await fixtureFiles();
    const graph = sourceGraph(files);
    const animated = graph.sprites.find(({ name }) => name === 'GFX_anim');
    expect(animated).toBeDefined();
    if (animated === undefined) return;
    const variants = [
      { name: 'GFX_non_looping', looping: false, playOnShow: true, pauseOnLoop: 0 },
      { name: 'GFX_visible_clock', looping: true, playOnShow: true, pauseOnLoop: 0 },
      { name: 'GFX_global_clock', looping: true, playOnShow: false, pauseOnLoop: 0 },
      { name: 'GFX_paused_loop', looping: true, playOnShow: true, pauseOnLoop: 1 },
    ].map((variant, index) => ({ ...animated, ...variant, id: `${animated.id}-${index}` }));
    graph.sprites.push(...variants);
    const animatedElement = graph.elements.find(({ name }) => name === 'animated');
    expect(animatedElement).toBeDefined();
    if (animatedElement === undefined) return;
    const sample = async (
      spriteName: string,
      animationTimeSeconds: number,
      visibleTimeSeconds: number,
    ) => {
      const previous = animatedElement.attributes.spriteType;
      animatedElement.attributes.spriteType = spriteName;
      const scene = await buildGuiScene(
        graph,
        files,
        'test_window',
        parsePreviewScenario({
          id: `animation-${spriteName}`,
          animationTimeSeconds,
          visibleTimeSeconds,
        }),
      );
      if (previous === undefined) delete animatedElement.attributes.spriteType;
      else animatedElement.attributes.spriteType = previous;
      return scene.elements.find(({ name }) => name === 'animated')?.sprite?.frame;
    };
    expect(await sample('GFX_non_looping', 10, 10)).toBe(1);
    expect(await sample('GFX_visible_clock', 0, 0.6)).toBe(1);
    expect(await sample('GFX_global_clock', 0.6, 0)).toBe(1);
    expect(await sample('GFX_paused_loop', 0, 1)).toBe(1);
  });

  it('detects intentional visual, reference, animation, script, and cost defects', async () => {
    const files = await fixtureFiles();
    const graph = sourceGraph(files);
    const scenario = parsePreviewScenario({
      id: 'defects',
      resolution: { width: 640, height: 480 },
      lists: { target_list: Array.from({ length: 6 }, (_unused, index) => ({ id: index })) },
      elementStates: { tab_1: 'selected', tab_2: 'selected' },
    });
    const scene = await buildGuiScene(graph, files, 'test_window', scenario);
    const validation = await validateGuiScene(graph, scene, files);
    const codes = new Set(validation.diagnostics.map(({ code }) => code));
    for (const expected of [
      'GUI_CONFLICTING_CLICK_REGIONS',
      'GUI_ACCIDENTAL_CLIPPING',
      'GUI_TEXT_OVERFLOW',
      'GUI_MISSING_SPRITE',
      'GUI_ANIMATION_STATIC_FALLBACK_MISSING',
      'GUI_TAB_STATE_CONFLICT',
      'GUI_BUTTON_EFFECT_MISSING',
      'GUI_COST_MISMATCH',
      'GUI_AI_EQUIVALENT_MISSING',
      'GUI_RENDER_FIELD_UNSUPPORTED',
    ])
      expect(codes.has(expected)).toBe(true);
    const costMismatch = validation.diagnostics.find(({ code }) => code === 'GUI_COST_MISMATCH');
    expect(costMismatch?.location?.path).toBe('fixture:localisation/english/test_l_english.yml');
    expect(costMismatch?.related?.map(({ path: sourcePath }) => sourcePath)).toContain(
      'fixture:common/scripted_guis/test.txt',
    );
  });

  it('centres native button text and validates value-driven visibility, panel, and label contracts', async () => {
    const files = [
      scanned(
        'interface/contracts.gui',
        `guiTypes = {
	containerWindowType = {
		name = "contract_window"
		size = { width = 240 height = 140 }
		background = { spriteType = "GFX_contract_panel" }
		buttonType = { name = "native_button" position = { x = 20 y = 20 } size = { width = 100 height = 30 } spriteType = "GFX_contract_button" buttonText = "NATIVE_BUTTON" }
		buttonType = { name = "text_button" position = { x = 130 y = 20 } size = { width = 100 height = 30 } spriteType = "GFX_contract_button" text = "TEXT_BUTTON" }
		buttonType = {
			name = "overlay_button"
			position = { x = 20 y = 60 }
			size = { width = 100 height = 30 }
			spriteType = "GFX_contract_button"
			instantTextBoxType = { name = "overlay_label" position = { x = 0 y = 0 } size = { width = 100 height = 30 } text = "OVERLAY_LABEL" format = left }
		}
		buttonType = { name = "outside_button" position = { x = 220 y = 105 } size = { width = 40 height = 24 } spriteType = "GFX_contract_button" }
	}
}`,
      ),
      scanned(
        'interface/contracts.gfx',
        `spriteTypes = {
	spriteType = { name = "GFX_contract_panel" texturefile = "gfx/interface/panel.png" }
	spriteType = { name = "GFX_contract_button" texturefile = "gfx/interface/button.png" }
}`,
      ),
      scanned(
        'localisation/english/contracts_l_english.yml',
        '\uFEFFl_english:\nNATIVE_BUTTON: "Native"\nTEXT_BUTTON: "Text"\nOVERLAY_LABEL: "Overlay"\n',
      ),
    ];
    const graph = sourceGraph(files);
    const base = await buildGuiScene(
      graph,
      files,
      'contract_window',
      parsePreviewScenario({ id: 'contract-base', resolution: { width: 640, height: 360 } }),
    );
    expect(base.elements.find(({ name }) => name === 'native_button')?.text).toMatchObject({
      horizontalAlignment: 'center',
      verticalAlignment: 'center',
    });
    expect(base.elements.find(({ name }) => name === 'text_button')?.text).toMatchObject({
      horizontalAlignment: 'center',
      verticalAlignment: 'center',
    });
    const variant = await buildGuiScene(
      graph,
      files,
      'contract_window',
      parsePreviewScenario({
        id: 'contract-variant',
        resolution: { width: 640, height: 360 },
        expectations: {
          visible: ['native_button', 'missing_button'],
          hidden: ['outside_button'],
          containedBy: { outside_button: 'contract_window' },
          centeredOn: { overlay_label: 'overlay_button' },
        },
      }),
    );
    const validation = await validateGuiScene(graph, base, files, [variant]);
    const codes = new Set(validation.diagnostics.map(({ code }) => code));
    for (const code of [
      'GUI_BUTTON_LABEL_OFF_CENTER',
      'GUI_CONTENT_CROSSES_BACKGROUND_EDGE',
      'GUI_EXPECTED_ELEMENT_MISSING',
      'GUI_EXPECTED_ELEMENT_VISIBLE',
      'GUI_CONTENT_OUTSIDE_EXPECTED_BACKGROUND',
      'GUI_EXPECTED_CENTERING_MISMATCH',
    ])
      expect(codes.has(code), code).toBe(true);
    expect(
      validation.diagnostics.find(({ code }) => code === 'GUI_EXPECTED_ELEMENT_VISIBLE')?.details,
    ).toMatchObject({ scenarioId: 'contract-variant', element: 'outside_button' });
  });

  it('uses BMFont xadvance and kerning from supplied font files', async () => {
    const files = await fixtureFiles();
    const graph = sourceGraph(files);
    const catalog = new GuiAssetCatalog(graph, files);
    const measured = catalog.measureText('fixture_font', 'AV', 16);
    expect(measured.source).toBe('bmfont');
    expect(measured.width).toBe(14);
  });

  it('uses non-16 BMFont native size, line height, baseline, atlas glyphs, and overflow', async () => {
    const atlas = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="7" height="9"><path d="M0 9 3.5 0 7 9 5 9 3.5 5 2 9Z" fill="white"/></svg>',
          ),
          left: 0,
          top: 1,
        },
        {
          input: Buffer.from(
            '<svg width="7" height="9"><path d="M0 0h4a3 3 0 0 1 0 5H0Zm0 5h4a2 2 0 0 1 0 4H0Z" fill="white"/></svg>',
          ),
          left: 8,
          top: 1,
        },
      ])
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer();
    const gui = `guiTypes = {
\tcontainerWindowType = {
\t\tname = "native_font_window"
\t\tsize = { width = 120 height = 60 }
\t\tinstantTextBoxType = {
\t\t\tname = "native_text"
\t\t\tposition = { x = 10 y = 10 }
\t\t\tsize = { width = 79 height = 36 }
\t\t\ttext = "NATIVE_FONT_PROBE"
\t\t\tfont = "native_font"
\t\t\tformat = center
\t\t}
\t}
}`;
    const gfx = `bitmapfonts = {
\tbitmapfont = { name = "native_font" path = "fonts/native_font.fnt" }
}`;
    const font = `info face="Native fixture" size=30
common lineHeight=37 base=19 scaleW=16 scaleH=16 pages=1 packed=0
page id=0 file="native_font.png"
chars count=2
char id=65 x=0 y=0 width=8 height=12 xoffset=0 yoffset=3 xadvance=9 page=0 chnl=15
char id=66 x=8 y=0 width=8 height=12 xoffset=0 yoffset=3 xadvance=9 page=0 chnl=15
kernings count=0
`;
    const files = [
      scanned('interface/native-font.gui', gui),
      scanned('interface/native-font.gfx', gfx),
      scanned(
        'localisation/english/native_font_l_english.yml',
        '\uFEFFl_english:\nNATIVE_FONT_PROBE: "AB"\n',
      ),
      scanned('fonts/native_font.fnt', font),
      scanned('fonts/native_font.png', atlas),
    ];
    const scene = await buildGuiScene(
      sourceGraph(files),
      files,
      'native_font_window',
      parsePreviewScenario({
        id: 'native-font',
        resolution: { width: 480, height: 270 },
        uiScale: 4,
      }),
    );
    const text = scene.elements.find(({ name }) => name === 'native_text')?.text;
    expect(text).toMatchObject({
      fontSize: 30,
      lineHeight: 37,
      measuredWidth: 18,
      measuredHeight: 37,
      overflowY: true,
    });
    expect(text?.glyphLines[0]).toMatchObject({
      source: 'bmfont-atlas',
      baseline: 19,
      baselineModelled: true,
    });
    expect(scene.fidelity.modelled.some(({ field }) => field === 'font_native_metrics')).toBe(true);
    const rendered = await renderGuiScene(scene, ['full']);
    const full = rendered.images[0];
    expect(full?.svg).toContain('<image id="gui-font-bitmap-');
    expect(full?.svg).toContain('translate(41 13) scale(1 1)');
    expect(full?.svg).not.toMatch(/<text\b|font-family=/u);
    expect(sha256Bytes(full?.png ?? Buffer.alloc(0))).toBe(
      'efd1eb086846506c4b2fa7532fe6b4fa2fbc93fb3a26de30ca0d06d15ae1dd80',
    );
  });

  it('uses scanned outline-font ascent instead of a guessed line-height baseline', async () => {
    const fontBytes = await readFile(
      new URL(
        import.meta.resolve('@fontsource-variable/roboto/files/roboto-latin-wght-normal.woff2'),
      ),
    );
    const files = [
      scanned(
        'interface/outline-font.gui',
        'guiTypes = { containerWindowType = { name = "outline_window" size = { width = 100 height = 50 } instantTextBoxType = { name = "outline_text" position = { x = 5 y = 5 } size = { width = 80 height = 30 } text = "OUTLINE_PROBE" font = "outline_font" fontSize = 20 } } }',
      ),
      scanned(
        'interface/outline-font.gfx',
        'bitmapfonts = { bitmapfont = { name = "outline_font" fontfiles = { "fonts/outline.woff2" } } }',
      ),
      scanned(
        'localisation/english/outline_font_l_english.yml',
        '\uFEFFl_english:\nOUTLINE_PROBE: "Ag"\n',
      ),
      scanned('fonts/outline.woff2', fontBytes),
    ];
    const scene = await buildGuiScene(
      sourceGraph(files),
      files,
      'outline_window',
      parsePreviewScenario({
        id: 'outline-font',
        resolution: { width: 480, height: 270 },
        uiScale: 4,
      }),
    );
    const text = scene.elements.find(({ name }) => name === 'outline_text')?.text;
    const glyphLine = text?.glyphLines[0];
    expect(glyphLine?.source).toBe('fontkit-path');
    expect(glyphLine?.baselineModelled).toBe(true);
    expect(glyphLine?.baseline).not.toBeCloseTo((text?.lineHeight ?? 0) * 0.8, 4);
    const firstGlyph = glyphLine?.glyphs.find((glyph) => glyph.kind === 'outline');
    expect(firstGlyph?.kind).toBe('outline');
    if (firstGlyph?.kind !== 'outline' || glyphLine === undefined || text === undefined) return;
    const finite = (value: number): number => Math.round(value * 1_000) / 1_000;
    const expectedY = finite(5 + glyphLine.baseline + firstGlyph.y);
    const guessedY = finite(5 + text.lineHeight * 0.8 + firstGlyph.y);
    const rendered = await renderGuiScene(scene, ['full']);
    expect(rendered.images[0]?.svg).toContain(` ${expectedY}) scale(`);
    expect(rendered.images[0]?.svg).not.toContain(` ${guessedY}) scale(`);
  });

  it('keeps distinct HOI4 font atlases, face colours, and native glyphs in localisation colour runs', async () => {
    const redAtlasPixels = Buffer.alloc(16 * 12 * 4);
    for (const [startX, startY, glyphWidth, glyphHeight, insetX, insetY] of [
      [0, 0, 7, 11, 0, 1],
      [9, 1, 6, 10, 2, 2],
    ] as const) {
      for (let y = startY; y < startY + glyphHeight; y += 1)
        for (let x = startX; x < startX + glyphWidth; x += 1)
          redAtlasPixels[(y * 16 + x) * 4 + 3] = 255;
      for (let y = startY + insetY; y < startY + glyphHeight - insetY; y += 1)
        for (let x = startX + insetX; x < startX + glyphWidth - insetX; x += 1) {
          const offset = (y * 16 + x) * 4;
          redAtlasPixels[offset] = 255;
          redAtlasPixels[offset + 1] = 255;
          redAtlasPixels[offset + 2] = 255;
        }
    }
    const redAtlas = await sharp(redAtlasPixels, {
      raw: { width: 16, height: 12, channels: 4 },
    })
      .png()
      .toBuffer();
    const greenAtlas = await sharp({
      create: { width: 16, height: 12, channels: 4, background: '#00000000' },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="16" height="12"><circle cx="4" cy="6" r="4" fill="black"/><path d="M9 2h6v8H9Z" fill="black"/></svg>',
          ),
        },
      ])
      .png()
      .toBuffer();
    const font = (page: string): string => `info size=16
common lineHeight=16 base=12 scaleW=16 scaleH=12 pages=1 packed=0 alphaChnl=1 redChnl=0 greenChnl=0 blueChnl=0
page id=0 file="${page}"
chars count=2
char id=65 x=0 y=0 width=8 height=12 xadvance=8 page=0
char id=66 x=8 y=0 width=8 height=12 xadvance=8 page=0
`;
    const files = [
      scanned(
        'interface/font-faces.gui',
        'guiTypes = { containerWindowType = { name = "font_faces" size = { width = 160 height = 60 } instantTextBoxType = { name = "red_face" position = { x = 4 y = 4 } size = { width = 80 height = 20 } text = "FONT_FACE_TEXT" font = "red_font" } instantTextBoxType = { name = "green_face" position = { x = 4 y = 28 } size = { width = 80 height = 20 } text = "FONT_FACE_TEXT" font = "green_font" } } }',
      ),
      scanned(
        'interface/font-faces.gfx',
        'bitmapfonts = { textcolors = { R = { 200 30 40 } } bitmapfont = { name = "red_font" path = "fonts/red.fnt" color = 0xffff0000 border_color = 0x00000000 textcolors = { Y = { 250 170 10 } } } bitmapfont = { name = "green_font" path = "fonts/green.fnt" color = 0xff00ff00 border_color = 0xff000000 } }',
      ),
      scanned(
        'localisation/english/font_faces_l_english.yml',
        '\uFEFFl_english:\nFONT_FACE_TEXT: "ABBA §YBABA§! §RA§!BAB"\n',
      ),
      scanned('fonts/red.fnt', font('red.png')),
      scanned('fonts/red.png', redAtlas),
      scanned('fonts/green.fnt', font('green.png')),
      scanned('fonts/green.png', greenAtlas),
    ];
    const graph = sourceGraph(files);
    expect(graph.fonts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'red_font',
          colour: '#ff0000ff',
          borderColour: '#00000000',
          textColours: { Y: '#faaa0a' },
        }),
        expect.objectContaining({
          name: 'green_font',
          colour: '#00ff00ff',
          borderColour: '#000000ff',
        }),
      ]),
    );
    expect(graph.textColours).toEqual({ R: '#c81e28' });
    const scene = await buildGuiScene(
      graph,
      files,
      'font_faces',
      parsePreviewScenario({ id: 'font-faces', resolution: { width: 320, height: 200 } }),
    );
    const redText = scene.elements.find(({ name }) => name === 'red_face')?.text;
    const greenText = scene.elements.find(({ name }) => name === 'green_face')?.text;
    expect(redText).toMatchObject({ colour: '#ff0000ff', borderColour: '#00000000' });
    expect(greenText).toMatchObject({ colour: '#00ff00ff', borderColour: '#000000ff' });
    expect(redText?.glyphLines[0]?.source).toBe('bmfont-atlas');
    expect(greenText?.glyphLines[0]?.source).toBe('bmfont-atlas');
    expect(redText?.glyphLines[0]?.glyphs).toEqual(
      expect.arrayContaining([expect.objectContaining({ borderDataUri: expect.any(String) })]),
    );
    expect(redText?.glyphLines[0]?.sourceHash).not.toBe(greenText?.glyphLines[0]?.sourceHash);
    expect(redText?.colourRuns?.[0]?.[0]?.colour).toBe('#ff0000ff');
    expect(redText?.colourRuns?.flat().some(({ colour }) => colour === '#faaa0a')).toBe(true);
    expect(redText?.colourRuns?.flat().some(({ colour }) => colour === '#c81e28')).toBe(true);
    const redGlyph = redText?.glyphLines[0]?.glyphs.find((glyph) => glyph.kind === 'bitmap');
    expect(redGlyph?.kind).toBe('bitmap');
    if (redGlyph?.kind !== 'bitmap' || redGlyph.borderDataUri === undefined) return;
    const decodeDataUri = async (dataUri: string): Promise<{ data: Buffer; width: number }> => {
      const encoded = dataUri.slice(dataUri.indexOf(',') + 1);
      const decoded = await sharp(Buffer.from(encoded, 'base64'))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return { data: decoded.data, width: decoded.info.width };
    };
    const faceMask = await decodeDataUri(redGlyph.dataUri);
    const borderMask = await decodeDataUri(redGlyph.borderDataUri);
    expect(faceMask.data[3]).toBe(0);
    expect(borderMask.data[3]).toBe(255);
    expect(faceMask.data[(2 * faceMask.width + 2) * 4 + 3]).toBe(255);
    expect(borderMask.data[(2 * borderMask.width + 2) * 4 + 3]).toBe(255);
    const secondRedGlyph = redText?.glyphLines
      .flatMap(({ glyphs }) => glyphs)
      .filter((glyph) => glyph.kind === 'bitmap')[1];
    expect(secondRedGlyph?.kind).toBe('bitmap');
    if (secondRedGlyph?.kind !== 'bitmap') return;
    const secondFaceMask = await decodeDataUri(secondRedGlyph.dataUri);
    expect(secondFaceMask.data[3]).toBe(0);
    expect(secondFaceMask.data[(3 * secondFaceMask.width + 3) * 4 + 3]).toBe(255);
    const rendered = await renderGuiScene(scene, ['full']);
    const svg = rendered.images[0]?.svg ?? '';
    expect(svg.match(/data-hoi4-colour-runs="true"/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(svg).toContain(`data-font-sha256="${redText?.glyphLines[0]?.sourceHash}"`);
    expect(svg).toContain(`data-font-sha256="${greenText?.glyphLines[0]?.sourceHash}"`);
    expect(svg).toContain('data-font-colour="#ff0000ff"');
    expect(svg).toContain('data-font-colour="#00ff00ff"');
    expect(svg).not.toContain('<feColorMatrix');
    expect(svg).toContain('gui-font-bitmap-border-');
    expect(svg).toContain('image-rendering="optimizeSpeed"');
    expect(svg).toContain('style="image-rendering:pixelated"');
    expect(svg).toContain('style="mask-type:alpha"');
    expect(svg).toContain('<mask id="gui-font-face-');
    expect(svg).toMatch(/data-hoi4-colour-runs="true"[\s\S]*?<use href="#gui-font-bitmap-/u);
    const png = rendered.images[0]?.png;
    expect(png).toBeDefined();
    if (png === undefined) return;
    const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels = Array.from({ length: data.length / 4 }, (_unused, index) => ({
      red: data[index * 4] ?? 0,
      green: data[index * 4 + 1] ?? 0,
      blue: data[index * 4 + 2] ?? 0,
      alpha: data[index * 4 + 3] ?? 0,
    }));
    expect(
      pixels.some(
        ({ red, green, blue, alpha }) => red > 160 && green < 80 && blue < 80 && alpha > 100,
      ),
    ).toBe(true);
    expect(
      pixels.some(
        ({ red, green, blue, alpha }) => red < 80 && green > 160 && blue < 80 && alpha > 100,
      ),
    ).toBe(true);
    expect(
      pixels.some(
        ({ red, green, blue, alpha }) => red > 160 && green > 100 && blue < 120 && alpha > 100,
      ),
    ).toBe(true);
    expect(
      pixels.some(
        ({ red, green, blue, alpha }) => red < 70 && green < 70 && blue < 70 && alpha > 100,
      ),
    ).toBe(true);

    const enlargedScene = await buildGuiScene(
      graph,
      files,
      'font_faces',
      parsePreviewScenario({
        id: 'font-faces-enlarged',
        resolution: { width: 1920, height: 1080 },
        uiScale: 4,
      }),
    );
    const enlargedGlyph = enlargedScene.elements
      .find(({ name }) => name === 'red_face')
      ?.text?.glyphLines[0]?.glyphs.find((glyph) => glyph.kind === 'bitmap');
    expect(enlargedGlyph?.kind).toBe('bitmap');
    if (enlargedGlyph?.kind !== 'bitmap') return;
    expect(enlargedGlyph.width).toBe(32);
    expect(enlargedGlyph.height).toBe(48);
    const enlargedMask = await decodeDataUri(enlargedGlyph.dataUri);
    expect(enlargedMask.width).toBe(32);
    const enlargedAlphaValues = new Set(
      Array.from(
        { length: enlargedMask.data.length / 4 },
        (_unused, index) => enlargedMask.data[index * 4 + 3],
      ),
    );
    expect(enlargedAlphaValues).toEqual(new Set([0, 255]));
    const enlargedRender = await renderGuiScene(enlargedScene, ['cropped']);
    expect(enlargedRender.images[0]?.svg).toContain('style="mask-type:alpha"');
    expect(enlargedRender.images[0]?.svg).not.toContain('<feColorMatrix');
  });

  it('separates a shipped-style RGB face from an alpha outline when channel declarations lie', async () => {
    const pixels = Buffer.alloc(8 * 8 * 4);
    for (let y = 1; y <= 6; y += 1)
      for (let x = 1; x <= 5; x += 1) pixels[(y * 8 + x) * 4 + 3] = 255;
    for (let y = 2; y <= 5; y += 1)
      for (let x = 2; x <= 4; x += 1) {
        const offset = (y * 8 + x) * 4;
        pixels[offset] = 255;
        pixels[offset + 1] = 255;
        pixels[offset + 2] = 255;
      }
    const atlas = await sharp(pixels, { raw: { width: 8, height: 8, channels: 4 } })
      .png()
      .toBuffer();
    const files = [
      scanned(
        'interface/lying-font.gfx',
        'bitmapfonts = { bitmapfont = { name = "lying_font" path = "fonts/lying.fnt" } }',
      ),
      scanned(
        'fonts/lying.fnt',
        'info size=8\ncommon lineHeight=8 base=7 scaleW=8 scaleH=8 pages=1 packed=0 alphaChnl=0 redChnl=4 greenChnl=4 blueChnl=4\npage id=0 file="lying.png"\nchar id=65 x=0 y=0 width=8 height=8 xadvance=8 page=0 chnl=15\n',
      ),
      scanned('fonts/lying.png', atlas),
    ];
    const catalog = new GuiAssetCatalog(sourceGraph(files), files);
    const shaped = await catalog.shapeText('lying_font', 'A', 8);
    const glyph = shaped.glyphs[0];
    expect(glyph?.kind).toBe('bitmap');
    if (glyph?.kind !== 'bitmap' || glyph.borderDataUri === undefined) return;
    const alphaPixels = async (dataUri: string): Promise<number> => {
      const decoded = await sharp(Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64'))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return Array.from(
        { length: decoded.info.width * decoded.info.height },
        (_unused, index) => decoded.data[index * 4 + 3] ?? 0,
      ).filter((value) => value > 0).length;
    };
    expect(await alphaPixels(glyph.dataUri)).toBe(12);
    expect(await alphaPixels(glyph.borderDataUri)).toBe(30);
  });

  it('bounds BMFont bytes, records, fields, pages, character maps, and kerning maps', () => {
    expect(() => parseBmFont('x'.repeat(GUI_BMFONT_MAX_BYTES + 1))).toThrowError(
      expect.objectContaining({ code: 'GUI_FONT_BYTES_BLOCKED' }),
    );
    expect(() =>
      parseBmFont(Array.from({ length: GUI_BMFONT_MAX_RECORDS + 1 }, () => 'x').join('\n')),
    ).toThrowError(expect.objectContaining({ code: 'GUI_FONT_RECORD_BUDGET_BLOCKED' }));
    expect(() =>
      parseBmFont(
        `info ${Array.from(
          { length: GUI_BMFONT_MAX_FIELDS_PER_RECORD + 1 },
          (_unused, index) => `field${index}=${index}`,
        ).join(' ')}`,
      ),
    ).toThrowError(expect.objectContaining({ code: 'GUI_FONT_FIELD_BUDGET_BLOCKED' }));
    expect(() => parseBmFont(`page id=${GUI_BMFONT_MAX_PAGES} file="page.png"`)).toThrowError(
      expect.objectContaining({ code: 'GUI_FONT_PAGE_BUDGET_BLOCKED' }),
    );
    expect(() =>
      parseBmFont(
        Array.from(
          { length: GUI_BMFONT_MAX_CHARACTERS + 1 },
          (_unused, index) => `char id=${index} xadvance=1`,
        ).join('\n'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'GUI_FONT_CHARACTER_BUDGET_BLOCKED' }));
    expect(() =>
      parseBmFont(
        Array.from(
          { length: GUI_BMFONT_MAX_KERNING_PAIRS + 1 },
          (_unused, index) => `kerning first=65 second=${index} amount=0`,
        ).join('\n'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'GUI_FONT_KERNING_BUDGET_BLOCKED' }));
  });

  it('retains only bounded missing-glyph samples from supplied fonts', () => {
    const files = [
      scanned(
        'interface/limited-font.gfx',
        'bitmapfont = { name = "limited_font" path = "fonts/limited.fnt" }',
      ),
      scanned('fonts/limited.fnt', 'info size=16\ncommon lineHeight=18\nchar id=65 xadvance=8\n'),
    ];
    const catalog = new GuiAssetCatalog(sourceGraph(files), files);
    const missingText = Array.from(
      { length: GUI_TEXT_MAX_MISSING_GLYPH_SAMPLES + 40 },
      (_unused, index) => String.fromCodePoint(0x400 + index),
    ).join('');
    const measured = catalog.measureText('limited_font', missingText, 16);
    expect(measured.missingGlyphs).toHaveLength(GUI_TEXT_MAX_MISSING_GLYPH_SAMPLES);
    expect(new Set(measured.missingGlyphs).size).toBe(GUI_TEXT_MAX_MISSING_GLYPH_SAMPLES);
  });

  it('selects and validates only the bitmap font for the preview language', async () => {
    const files = [
      scanned(
        'interface/fonts.gfx',
        `bitmapfonts = {
	bitmapfont = { name = "hoi_font" fontfiles = { "gfx/fonts/base_font.fnt" } color = 0xff112233 border_color = 0xff010203 }
	bitmapfont_override = { name = "hoi_font" fontfiles = { "gfx/fonts/japanese/font.fnt" } languages = { "l_japanese" } }
}`,
      ),
      scanned(
        'interface/fonts.gui',
        'guiTypes = { containerWindowType = { name = "font_window" size = { width = 200 height = 100 } instantTextBoxType = { name = "label" text = "FONT_LABEL" font = "hoi_font" size = { width = 160 height = 40 } } } }',
      ),
      scanned(
        'localisation/english/fonts_l_english.yml',
        '\ufeffl_english:\nFONT_LABEL: "English"\n',
      ),
      scanned('gfx/fonts/base_font.fnt', 'info size=16\ncommon lineHeight=16\n'),
    ];
    const graph = sourceGraph(files);
    const english = new GuiAssetCatalog(graph, files, new RenderBudget(), 'l_english');
    const japanese = new GuiAssetCatalog(graph, files, new RenderBudget(), 'l_japanese');
    expect(english.fontDefinition('hoi_font')).toMatchObject({
      override: false,
      assetPaths: ['gfx/fonts/base_font.fnt'],
      colour: '#112233ff',
      borderColour: '#010203ff',
    });
    expect(japanese.fontDefinition('hoi_font')).toMatchObject({
      override: true,
      languages: ['l_japanese'],
      assetPaths: ['gfx/fonts/japanese/font.fnt'],
      colour: '#112233ff',
      borderColour: '#010203ff',
    });
    const englishScene = await buildGuiScene(
      graph,
      files,
      'font_window',
      parsePreviewScenario({ id: 'english-font', language: 'l_english' }),
      english,
    );
    const englishValidation = await validateGuiScene(graph, englishScene, files, [], english);
    expect(englishValidation.diagnostics.map(({ code }) => code)).not.toContain('GUI_MISSING_FONT');
    const japaneseScene = await buildGuiScene(
      graph,
      files,
      'font_window',
      parsePreviewScenario({ id: 'japanese-font', language: 'l_japanese' }),
      japanese,
    );
    const japaneseValidation = await validateGuiScene(graph, japaneseScene, files, [], japanese);
    expect(japaneseValidation.diagnostics.map(({ code }) => code)).toContain('GUI_MISSING_FONT');
  });

  it('uses the highest-load-order font and never selects an unrelated language override', () => {
    const vanilla = {
      ...scanned(
        'interface/vanilla-fonts.gfx',
        'bitmapfonts = { bitmapfont = { name = "priority_font" path = "fonts/vanilla.fnt" color = 0xffffffff } bitmapfont_override = { name = "orphan_font" path = "fonts/japanese.fnt" languages = { l_japanese } } }',
      ),
      displayPath: 'game:interface/vanilla-fonts.gfx',
      rootKind: 'game' as const,
      loadOrder: 0,
    };
    const mod = {
      ...scanned(
        'interface/mod-fonts.gfx',
        'bitmapfonts = { bitmapfont = { name = "priority_font" path = "fonts/mod.fnt" color = { 0.2 0.4 0.6 1.0 } border_color = 0x112233 } }',
      ),
      displayPath: 'mod:interface/mod-fonts.gfx',
      rootKind: 'mod' as const,
      loadOrder: 10,
    };
    const files = [vanilla, mod];
    const catalog = new GuiAssetCatalog(sourceGraph(files), files, new RenderBudget(), 'l_english');
    expect(catalog.fontDefinition('priority_font')).toMatchObject({
      sourcePath: 'mod:interface/mod-fonts.gfx',
      assetPaths: ['fonts/mod.fnt'],
      colour: '#336699ff',
      borderColour: '#112233ff',
    });
    expect(catalog.fontDefinition('orphan_font')).toBeUndefined();
  });

  it('measures colour runs from shaped prefixes so kerning does not shift later colours', async () => {
    const fontBytes = await readFile(
      new URL(
        import.meta.resolve('@fontsource-variable/roboto/files/roboto-latin-wght-normal.woff2'),
      ),
    );
    const files = [
      scanned(
        'interface/kerned-colours.gui',
        'guiTypes = { containerWindowType = { name = "kerned_window" size = { width = 240 height = 50 } instantTextBoxType = { name = "kerned_text" size = { width = 220 height = 30 } text = "KERNED_TEXT" font = "kerned_font" fontSize = 20 } } }',
      ),
      scanned(
        'interface/kerned-colours.gfx',
        'bitmapfonts = { textcolors = { Y = { 238 201 35 } } bitmapfont = { name = "kerned_font" path = "fonts/kerned.woff2" color = 0xffffffff } }',
      ),
      scanned(
        'localisation/english/kerned_colours_l_english.yml',
        '\ufeffl_english:\nKERNED_TEXT: "AV§YATAR§!"\n',
      ),
      scanned('fonts/kerned.woff2', fontBytes),
    ];
    const scene = await buildGuiScene(
      sourceGraph(files),
      files,
      'kerned_window',
      parsePreviewScenario({ id: 'kerned-colours' }),
    );
    const text = scene.elements.find(({ name }) => name === 'kerned_text')?.text;
    const runs = text?.colourRuns?.[0] ?? [];
    expect(runs).toHaveLength(2);
    expect(runs[0]?.offsetX).toBe(0);
    expect((runs[0]?.width ?? 0) + (runs[1]?.width ?? 0)).toBeCloseTo(text?.lineWidths[0] ?? 0, 5);
  });

  it('uses the BMFont source-stem atlas when the declared first page is absent', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const files = [
      scanned(
        'interface/fonts.gfx',
        'bitmapfont = { name = "mismatched_font" fontfiles = { "gfx/fonts/mismatched_font" } }',
      ),
      scanned(
        'gfx/fonts/mismatched_font.fnt',
        'info size=16\ncommon lineHeight=16 base=12\npage id=0 file="mismatched_font_0.dds"\nchar id=65 x=0 y=0 width=4 height=5 xadvance=4 page=0\n',
      ),
      scanned('gfx/fonts/mismatched_font.png', png),
    ];
    const catalog = new GuiAssetCatalog(sourceGraph(files), files);
    await expect(catalog.shapeText('mismatched_font', 'A', 16)).resolves.toMatchObject({
      source: 'bmfont-atlas',
      missingGlyphs: [],
      glyphs: [expect.objectContaining({ kind: 'bitmap' })],
    });
  });

  it('deduplicates shared texture frames and keeps a ceiling for distinct raster work', async () => {
    const png = await sharp({
      create: { width: 1, height: 1, channels: 4, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const files = [
      scanned(
        'interface/decode-budget.gfx',
        'spriteTypes = { spriteType = { name = "GFX_first" texturefile = "gfx/shared.png" } spriteType = { name = "GFX_second" texturefile = "gfx/shared.png" } spriteType = { name = "GFX_third" texturefile = "gfx/distinct.png" } }',
      ),
      scanned('gfx/shared.png', png),
      scanned('gfx/distinct.png', png),
    ];
    const graph = sourceGraph(files);
    const first = graph.sprites.find(({ name }) => name === 'GFX_first');
    const second = graph.sprites.find(({ name }) => name === 'GFX_second');
    const third = graph.sprites.find(({ name }) => name === 'GFX_third');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    if (first === undefined || second === undefined || third === undefined) return;
    const budget = new RenderBudget({ maximumDistinctRasterOperations: 2 });
    const catalog = new GuiAssetCatalog(graph, files, budget);
    await expect(catalog.loadSpriteFrame(first, 0)).resolves.toMatchObject({ supported: true });
    await expect(catalog.loadSpriteFrame(first, 0)).resolves.toMatchObject({ supported: true });
    expect(budget.distinctRasterOperations).toBe(2);
    await expect(catalog.loadSpriteFrame(second, 0)).resolves.toMatchObject({
      spriteName: 'GFX_second',
      supported: true,
    });
    expect(budget.distinctRasterOperations).toBe(2);
    await expect(catalog.loadSpriteFrame(third, 0)).rejects.toMatchObject({
      code: 'RENDER_RASTER_OPERATION_BUDGET_BLOCKED',
    });
  });

  it('matches Clausewitz anchor inheritance, centerposition, percentages, clipping defaults, and local scale placement', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const files = [
      scanned(
        'interface/anchors.gfx',
        'spriteTypes = { spriteType = { name = "GFX_anchor" texturefile = "gfx/anchor.png" } }',
      ),
      scanned(
        'interface/anchors.gui',
        `guiTypes = { containerWindowType = {
\tname = "anchor_window"
\tsize = { width = 200 height = 100 }
\tbackground = { spriteType = "GFX_anchor" }
\ticonType = { name = "center_left" orientation = CENTER_LEFT position = { x = 10 y = 5 } size = { width = 20 height = 10 } spriteType = "GFX_anchor" }
\ticonType = { name = "center_right" orientation = CENTER_RIGHT position = { x = -30 y = 5 } size = { width = 20 height = 10 } spriteType = "GFX_anchor" }
\ticonType = { name = "center_up" orientation = CENTER_UP position = { x = 10 y = 5 } size = { width = 20 height = 10 } spriteType = "GFX_anchor" }
\ticonType = { name = "center_down" orientation = CENTER_DOWN position = { x = 10 y = -15 } size = { width = 20 height = 10 } spriteType = "GFX_anchor" }
\ticonType = { name = "centered" position = { x = 50 y = 50 } centerposition = yes size = { width = 20 height = 10 } spriteType = "GFX_anchor" }
\ticonType = { name = "scaled" position = { x = 10 y = 10 } scale = 2 size = { width = 10 height = 5 } spriteType = "GFX_anchor" }
\ticonType = { name = "percent" position = { x = 50%% y = 0 } size = { width = 50%% height = 10 } spriteType = "GFX_anchor" }
\ticonType = { name = "clipped_by_default" position = { x = 195 y = 95 } size = { width = 20 height = 20 } spriteType = "GFX_anchor" }
\tinstantTextBoxType = { name = "bounded_text" position = { x = 0 y = 70 } text = "A long line of text that wraps into several lines" maxWidth = 100 maxHeight = 20 fixedsize = yes }
\tcontainerWindowType = { name = "inherited_parent" orientation = CENTER origo = CENTER position = { x = 0 y = 0 } size = { width = 200 height = 100 } iconType = { name = "inherited_center" position = { x = 0 y = 0 } size = { width = 20 height = 10 } spriteType = "GFX_anchor" } }
} }`,
      ),
      scanned('gfx/anchor.png', png),
    ];
    const scene = await buildGuiScene(
      sourceGraph(files),
      files,
      'anchor_window',
      parsePreviewScenario({ id: 'anchors' }),
    );
    const rect = (name: string) =>
      scene.elements.find((element) => element.name === name)?.unclippedRect;
    expect(rect('center_left')).toEqual({ x: 10, y: 55, width: 20, height: 10 });
    expect(rect('center_right')).toEqual({ x: 170, y: 55, width: 20, height: 10 });
    expect(rect('center_up')).toEqual({ x: 110, y: 5, width: 20, height: 10 });
    expect(rect('center_down')).toEqual({ x: 110, y: 85, width: 20, height: 10 });
    expect(rect('centered')).toEqual({ x: 40, y: 45, width: 20, height: 10 });
    expect(rect('scaled')).toEqual({ x: 10, y: 10, width: 20, height: 10 });
    expect(rect('percent')).toEqual({ x: 100, y: 0, width: 100, height: 10 });
    expect(rect('inherited_center')).toEqual({ x: 100, y: 50, width: 20, height: 10 });
    expect(scene.elements.find(({ name }) => name === 'bounded_text')).toMatchObject({
      unclippedRect: { x: 0, y: 70, width: 100, height: 20 },
      text: { fixedSize: true, overflowY: true },
    });
    expect(scene.elements.find(({ name }) => name === 'clipped_by_default')).toMatchObject({
      clipped: true,
      rect: { x: 195, y: 95, width: 5, height: 5 },
    });
    expect((await renderGuiScene(scene, ['full'])).images[0]?.svg).toContain('gui-text-clip-');
  });

  it('composites cornered tiles, progress bars, and masked sprites instead of flattening them', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#55d6be' },
    })
      .png()
      .toBuffer();
    const files = [
      scanned(
        'interface/partial-sprites.gfx',
        `spriteTypes = {
\ttextSpriteType = { name = "GFX_text_sprite" texturefile = "gfx/primary.png" }
\tcorneredTileSpriteType = { name = "GFX_cornered" texturefile = "gfx/primary.png" borderSize = { x = 2 y = 2 } tilingCenter = yes }
\tprogressbarType = { name = "GFX_progress" textureFile1 = "gfx/primary.png" textureFile2 = "gfx/secondary.png" horizontal = yes steps = 10 }
\tmaskedShieldType = { name = "GFX_masked" textureFile1 = "gfx/primary.png" textureFile2 = "gfx/secondary.png" effectFile = "gfx/partial.effect" }
}`,
      ),
      scanned(
        'interface/partial-sprites.gui',
        `guiTypes = { containerWindowType = { name = "partial_sprite_window" size = { width = 80 height = 30 }
\ticonType = { name = "text_sprite" position = { x = 0 y = 0 } size = { width = 16 height = 16 } spriteType = "GFX_text_sprite" }
\ticonType = { name = "cornered" position = { x = 20 y = 0 } size = { width = 16 height = 16 } spriteType = "GFX_cornered" }
\tprogressbarType = { name = "progress" position = { x = 40 y = 0 } size = { width = 16 height = 16 } spriteType = "GFX_progress" minValue = 0 maxValue = 100 startValue = 50 }
\ticonType = { name = "masked" position = { x = 60 y = 0 } size = { width = 16 height = 16 } spriteType = "GFX_masked" }
} }`,
      ),
      scanned('gfx/primary.png', png),
      scanned('gfx/secondary.png', png),
    ];
    const scene = await buildGuiScene(
      sourceGraph(files),
      files,
      'partial_sprite_window',
      parsePreviewScenario({
        id: 'partial-sprites',
        resolution: { width: 480, height: 270 },
        uiScale: 4,
      }),
    );
    const unsupportedFields = new Set(scene.fidelity.unsupported.map(({ field }) => field));
    expect(unsupportedFields).toEqual(new Set(['effectFile']));
    expect(scene.fidelity.modelled.map(({ field }) => field)).toEqual(
      expect.arrayContaining([
        'cornered_tile_composition',
        'progressbar_composition',
        'masked_shield_composition',
      ]),
    );
    expect(
      scene.fidelity.approximated.filter(({ field }) => field === 'sprite_frame'),
    ).toHaveLength(1);
    expect(scene.fidelity.modelled.filter(({ field }) => field === 'sprite_frame')).toHaveLength(3);
    expect(
      scene.diagnostics.filter(({ code }) => code === 'GUI_SPRITE_RENDER_PARTIAL'),
    ).toHaveLength(1);
    expect(scene.elements.find(({ name }) => name === 'cornered')).toMatchObject({
      spriteRenderMode: 'cornered-tile',
      spriteBorderSize: { width: 2, height: 2 },
      spriteTilingCenter: true,
    });
    expect(scene.elements.find(({ name }) => name === 'progress')).toMatchObject({
      spriteRenderMode: 'progressbar',
      progressRatio: 0.5,
      secondarySprite: { supported: true },
    });
    expect(scene.elements.find(({ name }) => name === 'masked')).toMatchObject({
      spriteRenderMode: 'masked-shield',
      secondarySprite: { supported: true },
    });
    const rendered = await renderGuiScene(scene, ['full']);
    expect(rendered.images[0]?.svg).toContain('<pattern');
    expect(rendered.images[0]?.svg).toContain('<mask');
  });

  it('applies one scenario values map to runtime text, progress fills, and element state', async () => {
    const files = [
      scanned(
        'interface/value-scenario.gui',
        `guiTypes = { containerWindowType = { name = "value_window" size = { width = 240 height = 80 }
\tinstantTextBoxType = { name = "status_text" text = "VALUE_STATUS" size = { width = 220 height = 24 } }
\tprogressbarType = { name = "threat_meter" position = { y = 30 } size = { width = 200 height = 16 } minValue = 0 maxValue = 100 startValue = threat }
\tbuttonType = { name = "conditional_action" position = { y = 52 } size = { width = 100 height = 20 } text = "ACTION" }
} }`,
      ),
      scanned(
        'localisation/english/value_scenario_l_english.yml',
        '\uFEFFl_english:\nVALUE_STATUS: "Threat: [?threat|0] — [GetThreatLabel]"\nACTION: "Respond"\n',
      ),
      scanned(
        'common/scripted_guis/value-scenario.txt',
        'scripted_gui = { value_gui = { context_type = player_context window_name = value_window properties = { status_text = { x = threat_offset } } } }',
      ),
    ];
    const scene = await buildGuiScene(
      sourceGraph(files),
      files,
      'value_window',
      parsePreviewScenario({
        id: 'high-threat',
        values: {
          threat: 73,
          threat_offset: 18,
          GetThreatLabel: 'High',
          'conditional_action.visible': false,
        },
      }),
    );
    expect(scene.elements.find(({ name }) => name === 'status_text')?.text?.text).toBe(
      'Threat: 73 — High',
    );
    expect(scene.elements.find(({ name }) => name === 'threat_meter')?.progressRatio).toBe(0.73);
    expect(scene.elements.find(({ name }) => name === 'status_text')?.rect.x).toBe(18);
    expect(scene.elements.find(({ name }) => name === 'conditional_action')?.visible).toBe(false);
  });

  it('wraps text incrementally and blocks per-text, aggregate-text, and layout work excess', async () => {
    const phrase = Array.from({ length: 200 }, () => 'word').join(' ');
    const linearFiles = [
      scanned(
        'interface/linear-text.gui',
        `guiTypes = { containerWindowType = { name = "linear_window" size = { width = 20000 height = 100 } instantTextBoxType = { name = "copy" size = { width = 20000 height = 20 } maxWidth = 20000 text = "${phrase}" } } }`,
      ),
    ];
    const linearGraph = sourceGraph(linearFiles);
    const linearCatalog = new GuiAssetCatalog(linearGraph, linearFiles);
    const measure = vi.spyOn(linearCatalog, 'measureText');
    await buildGuiScene(
      linearGraph,
      linearFiles,
      'linear_window',
      parsePreviewScenario({ id: 'linear-wrap' }),
      linearCatalog,
    );
    expect(measure.mock.calls.length).toBeLessThanOrEqual(phrase.split(' ').length * 2 + 1);
    expect(
      measure.mock.calls.reduce((characters, call) => characters + call[1].length, 0),
    ).toBeLessThan(phrase.length * 5);

    expect(() =>
      linearCatalog.measureText(undefined, 'x'.repeat(GUI_TEXT_MAX_CHARACTERS + 1), 16),
    ).toThrowError(expect.objectContaining({ code: 'GUI_TEXT_BUDGET_BLOCKED' }));

    const maximumText = 'x'.repeat(GUI_TEXT_MAX_CHARACTERS);
    const aggregateCount = Math.floor(GUI_SCENE_MAX_TEXT_CHARACTERS / maximumText.length) + 1;
    const aggregateFiles = [
      scanned(
        'interface/aggregate-text.gui',
        `guiTypes = { containerWindowType = { name = "aggregate_window" size = { width = 100 height = 100 } ${Array.from(
          { length: aggregateCount },
          (_unused, index) =>
            `instantTextBoxType = { name = "copy_${index}" size = { width = 20 height = 20 } text = "${maximumText}" }`,
        ).join(' ')} } }`,
      ),
    ];
    const aggregateGraph = sourceGraph(aggregateFiles);
    const aggregateCatalog = new GuiAssetCatalog(aggregateGraph, aggregateFiles);
    vi.spyOn(aggregateCatalog, 'measureText').mockImplementation((_font, text) => ({
      width: text.length,
      lineHeight: 16,
      source: 'approximation',
      missingGlyphs: [],
    }));
    await expect(
      buildGuiScene(
        aggregateGraph,
        aggregateFiles,
        'aggregate_window',
        parsePreviewScenario({ id: 'aggregate-text' }),
        aggregateCatalog,
      ),
    ).rejects.toMatchObject({ code: 'GUI_SCENE_TEXT_BUDGET_BLOCKED' });

    const wordsPerText = Math.floor((GUI_TEXT_MAX_CHARACTERS + 1) / 2);
    const wordHeavyText = Array.from({ length: wordsPerText }, () => 'a').join(' ');
    const layoutTextCount =
      Math.floor(GUI_SCENE_MAX_TEXT_LAYOUT_OPERATIONS / (wordsPerText + 1)) + 1;
    const layoutFiles = [
      scanned(
        'interface/layout-work.gui',
        `guiTypes = { containerWindowType = { name = "layout_work_window" size = { width = 100 height = 100 } ${Array.from(
          { length: layoutTextCount },
          (_unused, index) =>
            `instantTextBoxType = { name = "copy_${index}" size = { width = 20 height = 20 } text = "${wordHeavyText}" }`,
        ).join(' ')} } }`,
      ),
    ];
    const layoutGraph = sourceGraph(layoutFiles);
    const layoutCatalog = new GuiAssetCatalog(layoutGraph, layoutFiles);
    vi.spyOn(layoutCatalog, 'measureText').mockImplementation((_font, text) => ({
      width: text.length,
      lineHeight: 16,
      source: 'approximation',
      missingGlyphs: [],
    }));
    await expect(
      buildGuiScene(
        layoutGraph,
        layoutFiles,
        'layout_work_window',
        parsePreviewScenario({ id: 'layout-work' }),
        layoutCatalog,
      ),
    ).rejects.toMatchObject({ code: 'GUI_TEXT_LAYOUT_WORK_BUDGET_BLOCKED' });
  });

  it('cancels cooperatively during one large deterministic render', async () => {
    const files = await fixtureFiles();
    const graph = sourceGraph(files);
    const scene = await buildGuiScene(
      graph,
      files,
      'test_window',
      parsePreviewScenario({ id: 'cancel-render', resolution: { width: 640, height: 480 } }),
    );
    const baseline = await renderGuiScene(scene, ['full']);
    const activeController = new AbortController();
    const active = await renderGuiScene(scene, ['full'], activeController.signal);
    expect(active.images[0]?.svg).toBe(baseline.images[0]?.svg);
    expect(active.images[0]?.png.equals(baseline.images[0]?.png ?? Buffer.alloc(0))).toBe(true);

    const cancelledController = new AbortController();
    setImmediate(() => cancelledController.abort());
    await expect(renderGuiScene(scene, ['full'], cancelledController.signal)).rejects.toMatchObject(
      {
        name: 'AbortError',
      },
    );
  });

  it('blocks oversized renderer canvases and excessive validation pair work deterministically', async () => {
    const scenario = parsePreviewScenario({
      id: 'bounded',
      resolution: { width: 640, height: 480 },
    });
    const oversized = {
      windowName: 'oversized',
      scenario,
      resolution: { width: 8_192, height: 6_145 },
      elements: [],
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      fidelity: emptyFidelityReport(),
      diagnostics: [],
      sourceRevision: 'oversized',
    } satisfies GuiScene;
    await expect(renderGuiScene(oversized, ['full'])).rejects.toMatchObject({
      code: 'RENDER_PIXELS_BLOCKED',
    });

    const elements = Array.from({ length: 2_500 }, (_unused, index) => ({
      id: `element-${index}`,
      sourceId: `source-${index}`,
      name: `element-${index}`,
      elementType: 'buttonType',
      depth: 0,
      zIndex: index,
      visible: true,
      clickable: false,
      clickThrough: false,
      rect: { x: index * 2, y: 0, width: 1, height: 1 },
      unclippedRect: { x: index * 2, y: 0, width: 0, height: 1 },
      clipped: false,
      scale: 1,
      state: 'normal' as const,
      sourcePath: 'fixture:interface/bounded.gui',
      unsupportedAttributes: [],
    }));
    const scene = { ...oversized, resolution: scenario.resolution, elements } satisfies GuiScene;
    const graph = {
      complete: true,
      skippedSourceCount: 0,
      skippedSources: [],
      skippedPossibleSymbolKinds: [],
      nodes: [],
      edges: [],
      elements: [],
      sprites: [],
      fonts: [],
      textColours: {},
      scriptedGuis: [],
      animationSources: [],
      scriptedLocalisation: [],
      localisation: [],
      sourceHashes: {},
      filesScanned: [],
      diagnostics: [],
    } satisfies GuiSourceGraph;
    const validation = await validateGuiScene(graph, scene, []);
    expect(validation.diagnostics).toHaveLength(2_000);
    expect(validation.diagnostics.map(({ code }) => code)).toContain(
      'GUI_VALIDATION_COMPARISON_BUDGET_BLOCKED',
    );
    expect(validation.diagnostics.map(({ code }) => code)).toContain(
      'GUI_VALIDATION_DIAGNOSTICS_TRUNCATED',
    );

    const excessiveScene = {
      ...scene,
      elements: Array.from({ length: GUI_SCENE_MAX_ELEMENTS + 1 }, (_unused, index) => ({
        ...elements[0]!,
        id: `excessive-${index}`,
        sourceId: `excessive-source-${index}`,
      })),
    } satisfies GuiScene;
    await expect(renderGuiScene(excessiveScene, ['full'])).rejects.toMatchObject({
      code: 'GUI_RENDER_ELEMENT_BUDGET_BLOCKED',
    });
  });

  it('bounds ancestor traversal and shares pair admission across validation phases', async () => {
    const scenario = parsePreviewScenario({
      id: 'ancestor-budget',
      resolution: { width: 640, height: 480 },
    });
    const elements = Array.from({ length: 2_000 }, (_unused, index) => ({
      id: `element-${index}`,
      sourceId: `source-${index}`,
      name: `element-${index}`,
      elementType: 'iconType',
      ...(index === 0 ? {} : { parentId: `element-${index - 1}` }),
      depth: index,
      zIndex: index,
      visible: true,
      clickable: false,
      clickThrough: false,
      rect: { x: index * 2, y: 0, width: 1, height: 1 },
      unclippedRect: { x: index * 2, y: 0, width: 1, height: 1 },
      clipped: false,
      scale: 1,
      state: 'normal' as const,
      sourcePath: 'fixture:interface/ancestor-budget.gui',
      unsupportedAttributes: [],
    }));
    const scene = {
      windowName: 'ancestor-budget',
      scenario,
      resolution: scenario.resolution,
      elements,
      bounds: { x: 0, y: 0, width: 4_000, height: 1 },
      fidelity: emptyFidelityReport(),
      diagnostics: [],
      sourceRevision: 'ancestor-budget',
    } satisfies GuiScene;
    const graph = {
      complete: true,
      skippedSourceCount: 0,
      skippedSources: [],
      skippedPossibleSymbolKinds: [],
      nodes: [],
      edges: [],
      elements: [],
      sprites: [],
      fonts: [],
      textColours: {},
      scriptedGuis: [],
      animationSources: [],
      scriptedLocalisation: [],
      localisation: [],
      sourceHashes: {},
      filesScanned: [],
      diagnostics: [],
    } satisfies GuiSourceGraph;
    const validation = await validateGuiScene(graph, scene, []);
    const codes = validation.diagnostics.map(({ code }) => code);
    expect(codes).toContain('GUI_VALIDATION_ANCESTOR_BUDGET_BLOCKED');

    const sharedPairScene = {
      ...scene,
      elements: elements.slice(0, 1_500).map(({ parentId: _parentId, ...element }) => element),
    } satisfies GuiScene;
    const sharedPairValidation = await validateGuiScene(graph, sharedPairScene, []);
    expect(sharedPairValidation.diagnostics.map(({ code }) => code)).toContain(
      'GUI_VALIDATION_COMPARISON_BUDGET_BLOCKED',
    );
  });
});

describe('GUI declarative helper compiler', () => {
  const helper = {
    version: 1,
    root: {
      id: 'root',
      kind: 'column',
      name: 'helper_window',
      width: 400,
      height: 300,
      gap: 8,
      padding: 12,
      children: [
        { id: 'card', kind: 'card', width: 376, height: 80, raw: 'pdx_tooltip = CUSTOM_TOOLTIP' },
        {
          id: 'row',
          kind: 'row',
          width: 376,
          height: 40,
          children: [
            {
              id: 'button',
              kind: 'element',
              elementType: 'buttonType',
              width: 100,
              height: 30,
              sprite: 'GFX_test',
            },
          ],
        },
        {
          id: 'escape',
          kind: 'raw',
          raw: 'iconType = { name = "advanced_raw" position = { x = 7 y = 9 } }',
        },
      ],
    },
  };

  it('compiles helpers into explicit source with a raw HOI4 escape hatch', () => {
    const result = compileGuiHelpers(helper);
    expect(result.source).toContain('containerWindowType = {');
    expect(result.source).toContain('position = { x = 12 y = 12 }');
    expect(result.source).toContain('pdx_tooltip = CUSTOM_TOOLTIP');
    expect(result.source).toContain('advanced_raw');
    expect(result.rawEscapeCount).toBe(2);
  });

  it('routes helper writes through the shared TransactionManager plan API', async () => {
    const plan = vi.fn((input: Parameters<TransactionManager['plan']>[0]) =>
      Promise.resolve({
        transactionId: 'txn_fixture',
        planHash: 'hash',
        operationKind: input.operationKind,
      } as unknown as TransactionManifest),
    );
    const manager = { plan } as unknown as TransactionManager;
    const result = await planGuiHelperCompilation(manager, {
      workspaceId: 'fixture',
      relativePath: 'interface/helper.gui',
      helper,
    });
    expect(plan).toHaveBeenCalledOnce();
    expect(plan.mock.calls[0]?.[0].operationKind).toBe('gui-helper-compilation');
    expect(result.compilation.source).toContain('guiTypes = {');
  });

  it('blocks adversarial helper depth and node counts before recursive schema parsing', () => {
    let deep: GuiHelperNode = { id: 'leaf', kind: 'element', children: [] };
    for (let index = 0; index < 5_000; index += 1) {
      deep = { id: `depth-${index}`, kind: 'column', children: [deep] };
    }
    expect(() => compileGuiHelpers({ version: 1, root: deep })).toThrowError(
      expect.objectContaining({ code: 'GUI_HELPER_DEPTH_BUDGET_BLOCKED' }),
    );

    const wide: GuiHelperNode = {
      id: 'wide',
      kind: 'row',
      children: Array.from({ length: 10_001 }, (_unused, index) => ({
        id: `child-${index}`,
        kind: 'element' as const,
        children: [],
      })),
    };
    expect(() => compileGuiHelpers({ version: 1, root: wide })).toThrowError(
      expect.objectContaining({ code: 'GUI_HELPER_NODE_BUDGET_BLOCKED' }),
    );
  });
});
