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
  parseBmFont,
  parsePreviewScenario,
  planGuiHelperCompilation,
  renderGuiScene,
  validateGuiScene,
  type GuiHelperNode,
  type GuiScene,
  type GuiSourceGraph,
} from '../../src/hoi4_agent_tools/gui/index.js';

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
      expect.arrayContaining([
        expect.objectContaining({ field: 'fixedsize' }),
        expect.objectContaining({ field: 'pdx_tooltip' }),
      ]),
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
    expect(firstImage?.svg).toContain('OFFLINE APPROXIMATION · NOT HOI4');
    expect(firstImage?.png.equals(secondImage?.png ?? Buffer.alloc(0))).toBe(true);
    expect(first.layoutJson).toBe(second.layoutJson);
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
        ({ text: value, colour }) => value.includes('[dynamic_loc]') && colour === '#f1c75b',
      ),
    ).toBe(true);
    expect(
      runs.some(({ text: value, colour }) => value.includes('[X]') && colour === '#e05a5a'),
    ).toBe(true);
    const rendered = await renderGuiScene(scene, ['full']);
    expect(rendered.images[0]?.svg).toContain('data-hoi4-colour-runs="true"');
    expect(rendered.images[0]?.svg).toContain('fill="#f1c75b"');
    expect(rendered.images[0]?.svg).toContain('fill="#e05a5a"');
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
\t\t\tsize = { width = 80 height = 36 }
\t\t\ttext = "NATIVE_FONT_PROBE"
\t\t\tfont = "native_font"
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
    expect(full?.svg).toContain('translate(10 13) scale(1 1)');
    expect(full?.svg).not.toMatch(/<text\b|font-family=/u);
    expect(sha256Bytes(full?.png ?? Buffer.alloc(0))).toBe(
      'd17b3953a3a73f110e20fd9465f20fc8c82dcb811cae785354535764c6deb6ea',
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

  it('shares a distinct raster-operation ceiling across asset decode and sprite extraction', async () => {
    const png = await sharp({
      create: { width: 1, height: 1, channels: 4, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const files = [
      scanned(
        'interface/decode-budget.gfx',
        'spriteTypes = { spriteType = { name = "GFX_first" texturefile = "gfx/shared.png" } spriteType = { name = "GFX_second" texturefile = "gfx/shared.png" } }',
      ),
      scanned('gfx/shared.png', png),
    ];
    const graph = sourceGraph(files);
    const first = graph.sprites.find(({ name }) => name === 'GFX_first');
    const second = graph.sprites.find(({ name }) => name === 'GFX_second');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    const budget = new RenderBudget({ maximumDistinctRasterOperations: 2 });
    const catalog = new GuiAssetCatalog(graph, files, budget);
    await expect(catalog.loadSpriteFrame(first, 0)).resolves.toMatchObject({ supported: true });
    await expect(catalog.loadSpriteFrame(first, 0)).resolves.toMatchObject({ supported: true });
    expect(budget.distinctRasterOperations).toBe(2);
    await expect(catalog.loadSpriteFrame(second, 0)).rejects.toMatchObject({
      code: 'RENDER_RASTER_OPERATION_BUDGET_BLOCKED',
    });
  });

  it('reports partial rendering for every flattened special sprite and secondary effect input', async () => {
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
\tcorneredTileSpriteType = { name = "GFX_cornered" texturefile = "gfx/primary.png" }
\tprogressbarType = { name = "GFX_progress" texturefile = "gfx/primary.png" textureFile2 = "gfx/secondary.png" }
\tmaskedShieldType = { name = "GFX_masked" texturefile = "gfx/primary.png" effectFile = "gfx/partial.effect" }
}`,
      ),
      scanned(
        'interface/partial-sprites.gui',
        `guiTypes = { containerWindowType = { name = "partial_sprite_window" size = { width = 80 height = 30 }
\ticonType = { name = "text_sprite" position = { x = 0 y = 0 } size = { width = 16 height = 16 } spriteType = "GFX_text_sprite" }
\ticonType = { name = "cornered" position = { x = 20 y = 0 } size = { width = 16 height = 16 } spriteType = "GFX_cornered" }
\ticonType = { name = "progress" position = { x = 40 y = 0 } size = { width = 16 height = 16 } spriteType = "GFX_progress" }
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
    expect(unsupportedFields).toEqual(
      new Set([
        'text_sprite_semantics',
        'cornered_tile_semantics',
        'progressbar_sprite_semantics',
        'masked_shield_semantics',
        'textureFile2',
        'effectFile',
      ]),
    );
    expect(
      scene.fidelity.approximated.filter(({ field }) => field === 'sprite_frame'),
    ).toHaveLength(4);
    expect(scene.fidelity.modelled.filter(({ field }) => field === 'sprite_frame')).toHaveLength(0);
    expect(
      scene.diagnostics.filter(({ code }) => code === 'GUI_SPRITE_RENDER_PARTIAL'),
    ).toHaveLength(4);
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
