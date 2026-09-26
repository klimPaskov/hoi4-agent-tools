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
  referencedAssetPatternsForWindow,
  scenarioCountryFlagPatterns,
} from '../../src/hoi4_agent_tools/gui/studio.js';

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

async function fixture(gui: string): Promise<ScannedFile[]> {
  return [
    scanned('interface/native.gui', `guiTypes = { ${gui} }`),
    scanned(
      'interface/native.gfx',
      `spriteTypes = {
      spriteType = { name = "GFX_fixed" texturefile = "gfx/fixed.png" }
      corneredTileSpriteType = { name = "GFX_tile" texturefile = "gfx/tile.png" size = { x = 16 y = 16 } borderSize = { x = 4 y = 4 } }
    }`,
    ),
    scanned(
      'gfx/fixed.png',
      await sharp({ create: { width: 280, height: 190, channels: 4, background: '#123456' } })
        .png()
        .toBuffer(),
    ),
    scanned(
      'gfx/tile.png',
      await sharp({ create: { width: 16, height: 16, channels: 4, background: '#987654' } })
        .png()
        .toBuffer(),
    ),
  ];
}

async function sceneFor(files: ScannedFile[], scenario: unknown = {}) {
  return buildGuiScene(
    buildGuiSourceGraph(files, SymbolIndex.build(files)),
    files,
    'native_window',
    parsePreviewScenario({ id: 'native', ...(scenario as object) }),
  );
}

describe('native GUI geometry and composition', () => {
  it('keeps multiline=no labels on one line while reporting horizontal overflow', async () => {
    const files =
      await fixture(`containerWindowType = { name = "native_window" size = { width = 550 height = 300 }
      instantTextboxType = { name = "single_line" text = "Show non-resisting countries" maxWidth = 80 multiline = no }
      instantTextboxType = { name = "wrapped" text = "Show non-resisting countries" maxWidth = 80 multiline = yes }
    }`);
    const scene = await sceneFor(files);
    expect(scene.elements.find(({ name }) => name === 'single_line')?.text).toMatchObject({
      lines: ['Show non-resisting countries'],
      overflowX: true,
    });
    expect(
      scene.elements.find(({ name }) => name === 'wrapped')?.text?.lines.length,
    ).toBeGreaterThan(1);
  });

  it('retains one inferred font line without enlarging an explicit fixed-size text box', async () => {
    const files =
      await fixture(`containerWindowType = { name = "native_window" size = { width = 550 height = 300 }
      instantTextboxType = { name = "inferred" text = "Title" fontSize = 36 maxWidth = 400 maxHeight = 20 fixedsize = yes }
      instantTextboxType = { name = "explicit" text = "Title" fontSize = 36 size = { width = 400 height = 20 } fixedsize = yes }
    }`);
    const scene = await sceneFor(files);
    const inferred = scene.elements.find(({ name }) => name === 'inferred')!;
    expect(inferred.unclippedRect.height).toBe(inferred.text!.lineHeight);
    expect(inferred.text?.overflowY).toBe(false);
    expect(scene.elements.find(({ name }) => name === 'explicit')).toMatchObject({
      unclippedRect: { height: 20 },
      text: { overflowY: true },
    });
    expect(scene.fidelity.approximated).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'text_minimum_line_height' })]),
    );
  });

  it('renders a requested native window at its settled show position', async () => {
    const files = await fixture(`containerWindowType = { name = "native_window"
      position = { x = -606 y = 78 } show_position = { x = -6 y = 78 }
      animation_time = 300 size = { width = 550 height = 100%% }
      background = { name = "panel" spriteType = "GFX_tile" }
    }`);
    const scene = await sceneFor(files);
    const root = scene.elements.find(({ name }) => name === 'native_window')!;
    expect(root.unclippedRect.x).toBe(-6);
    expect(root.unclippedRect.y).toBe(78);
    expect(root.rect.width).toBeGreaterThan(500);
    expect(root.visible).toBe(true);
  });

  it('stacks variable-height native entries in a one-column pixel grid', async () => {
    const files =
      await fixture(`containerWindowType = { name = "native_window" size = { width = 550 height = 300 }
      gridboxtype = { name = "rows" size = { width = 502 height = 300 } slotsize = { width = 502 height = 1 } max_slots_horizontal = 1 }
    }
    containerWindowType = { name = "category" size = { width = 502 height = 58 } }
    containerWindowType = { name = "entry" size = { width = 502 height = 41 } }`);
    const scene = await sceneFor(files, {
      lists: {
        rows: [
          { entryContainer: 'category' },
          { entryContainer: 'entry' },
          { entryContainer: 'entry' },
        ],
      },
    });
    expect(scene.elements.filter(({ name }) => name === 'entry').map(({ rect }) => rect.y)).toEqual(
      [58, 99],
    );
  });

  it('uses declared native control dimensions for engine-populated containers', async () => {
    const files =
      await fixture(`containerWindowType = { name = "native_window" size = { width = 550 height = 300 }
      containerWindowType = { name = "native_list" position = { x = 0 y = 40 } size = { width = 100%% height = 0 } }
    }`);
    const scene = await sceneFor(files, {
      values: { 'native_list.height': 120, 'native_list.width': 500 },
    });
    expect(scene.elements.find(({ name }) => name === 'native_list')?.unclippedRect).toMatchObject({
      width: 500,
      height: 120,
    });
  });

  it('binds an explicit native row template to its owning GUI file', async () => {
    const files =
      await fixture(`containerWindowType = { name = "native_window" size = { width = 300 height = 150 }
      gridboxtype = { name = "rows" size = { width = 300 height = 150 } slotsize = { width = 300 height = 1 } max_slots_horizontal = 1 }
    }
    containerWindowType = { name = "shared_entry" size = { width = 300 height = 58 }
      instantTextBoxType = { name = "owned_text" text = "Correct source" maxWidth = 250 maxHeight = 20 }
    }`);
    files.push(
      scanned(
        'interface/zzz_other.gui',
        'guiTypes = { containerWindowType = { name = "shared_entry" size = { width = 100 height = 44 } } }',
      ),
    );
    const scene = await sceneFor(files, { lists: { rows: [{ entryContainer: 'shared_entry' }] } });
    expect(scene.elements.find(({ name }) => name === 'shared_entry')?.unclippedRect.height).toBe(
      58,
    );
    expect(scene.elements.find(({ name }) => name === 'owned_text')?.text?.text).toBe(
      'Correct source',
    );
  });

  it('instantiates an explicit native template at a source position anchor', async () => {
    const files =
      await fixture(`containerWindowType = { name = "native_window" size = { width = 300 height = 150 }
      positionType = { name = "native_anchor" position = { x = 70 y = 30 } }
    }
    containerWindowType = { name = "status_template" position = { x = 300 y = 40 } size = { width = 45 height = 31 } }`);
    const scene = await sceneFor(files, {
      lists: { native_anchor: [{ entryContainer: 'status_template' }] },
    });
    expect(
      scene.elements.find(({ name }) => name === 'status_template')?.unclippedRect,
    ).toMatchObject({ x: 70, y: 30, width: 45, height: 31 });
  });

  it('isolates reused row-template ids and clipping across sibling native lists', async () => {
    const files =
      await fixture(`containerWindowType = { name = "native_window" size = { width = 300 height = 200 }
      containerWindowType = { name = "left" size = { width = 100 height = 70 } clipping = yes
        gridboxtype = { name = "left_rows" size = { width = 100%% height = 100%% } slotsize = { width = 80 height = 30 } }
      }
      containerWindowType = { name = "right" position = { x = 150 y = 0 } size = { width = 100 height = 70 } clipping = yes
        gridboxtype = { name = "right_rows" size = { width = 100%% height = 100%% } slotsize = { width = 80 height = 30 } }
      }
    }
    containerWindowType = { name = "entry" size = { width = 80 height = 30 }
      iconType = { name = "entry_icon" spriteType = "GFX_tile" }
    }`);
    const scene = await sceneFor(files, {
      lists: {
        left_rows: [{ entryContainer: 'entry' }],
        right_rows: [{ entryContainer: 'entry' }],
      },
    });
    expect(new Set(scene.elements.map(({ id }) => id)).size).toBe(scene.elements.length);
    const entries = scene.elements.filter(({ name }) => name === 'entry');
    expect(entries.every(({ visible }) => visible)).toBe(true);
    expect(entries.map(({ clipRect }) => clipRect?.x)).toEqual([0, 150]);
    expect(
      scene.elements.filter(({ name }) => name === 'entry_icon').map(({ rect }) => rect.x),
    ).toEqual([0, 150]);
  });

  it('preserves three-slice borders when either cornered-sprite border axis is zero', async () => {
    const files =
      await fixture(`containerWindowType = { name = "native_window" size = { width = 100 height = 80 }
      iconType = { name = "vertical" size = { width = 8 height = 40 } spriteType = "GFX_vertical" }
      iconType = { name = "horizontal" position = { x = 20 y = 0 } size = { width = 40 height = 8 } spriteType = "GFX_horizontal" }
    }`);
    files.push(
      scanned(
        'interface/three-slice.gfx',
        `spriteTypes = {
      corneredTileSpriteType = { name = "GFX_vertical" texturefile = "gfx/vertical.png" borderSize = { x = 0 y = 4 } tilingCenter = yes }
      corneredTileSpriteType = { name = "GFX_horizontal" texturefile = "gfx/horizontal.png" borderSize = { x = 4 y = 0 } tilingCenter = yes }
    }`,
      ),
    );
    for (const horizontal of [false, true]) {
      const width = horizontal ? 12 : 8;
      const height = horizontal ? 8 : 12;
      const bytes = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4;
          bytes[offset + Math.floor((horizontal ? x : y) / 4)] = 255;
          bytes[offset + 3] = 255;
        }
      files.push(
        scanned(
          `gfx/${horizontal ? 'horizontal' : 'vertical'}.png`,
          await sharp(bytes, { raw: { width, height, channels: 4 } })
            .png()
            .toBuffer(),
        ),
      );
    }
    const image = (await renderGuiScene(await sceneFor(files), ['full'])).images[0]!;
    const { data, info } = await sharp(image.png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [
      ...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 3),
    ];
    for (const coordinate of [3, 4, 35, 36]) {
      const expected = coordinate < 4 ? [255, 0, 0] : coordinate < 36 ? [0, 255, 0] : [0, 0, 255];
      expect(pixel(2, coordinate)).toEqual(expected);
      expect(pixel(20 + coordinate, 2)).toEqual(expected);
    }
  });

  it('resolves explicitly bound native country flags without replacing unrelated icons or accepting paths', async () => {
    const files =
      await fixture(`containerWindowType = { name = "native_window" size = { width = 300 height = 200 }
      gridboxtype = { name = "countries" size = { width = 100%% height = 100%% } slotsize = { width = 120 height = 40 } max_slots_horizontal = 1 }
      iconType = { name = "decoration" spriteType = "GFX_tile" }
    }
    containerWindowType = { name = "country_row" size = { width = 120 height = 40 }
      iconType = { name = "country_flag" spriteType = "GFX_tile" }
      iconType = { name = "row_decoration" spriteType = "GFX_tile" }
    }`);
    for (const [tag, colour] of [
      ['AAA_fascism', '#ff0000'],
      ['BBB_neutrality', '#0000ff'],
    ]) {
      files.push(
        scanned(
          `gfx/flags/medium/${tag}.png`,
          await sharp({
            create: {
              width: 40,
              height: 25,
              channels: 4,
              background: colour!,
            },
          })
            .png()
            .toBuffer(),
        ),
      );
    }
    const scenario = parsePreviewScenario({
      id: 'native-flags',
      country: { tag: 'ZZZ' },
      lists: {
        countries: [
          {
            entryContainer: 'country_row',
            'country_flag.countryTag': 'AAA',
            'country_flag.ideology': 'fascism',
          },
          {
            entryContainer: 'country_row',
            'country_flag.countryTag': 'BBB',
            'country_flag.ideology': 'neutrality',
          },
          { entryContainer: 'country_row', 'country_flag.countryTag': '../AAA' },
        ],
      },
    });
    const scene = await sceneFor(files, scenario);
    expect(
      scene.elements
        .filter(({ name }) => name === 'country_flag')
        .map(({ sprite }) => [sprite?.spriteName, sprite?.supported]),
    ).toEqual([
      ['GFX_flag_AAA', true],
      ['GFX_flag_BBB', true],
      ['GFX_flag_../AAA', false],
    ]);
    expect(
      scene.elements
        .filter(({ name }) => name.includes('decoration'))
        .every(({ sprite }) => sprite?.spriteName === 'GFX_tile'),
    ).toBe(true);
    const patterns = scenarioCountryFlagPatterns([scenario]);
    expect(patterns).toHaveLength(12);
    expect(patterns).toContain('gfx/flags/medium/AAA_*.{bmp,dds,png,tga}');
    expect(patterns.every((pattern) => !pattern.includes('..') && !pattern.includes('ZZZ'))).toBe(
      true,
    );
    expect(
      scenarioCountryFlagPatterns([
        parsePreviewScenario({
          id: 'invalid-flags',
          values: {
            'flag.countryTag': '*',
            'other.countryTag': '{AAA,BBB}',
            'integer.countryTag': 7,
          },
        }),
      ]),
    ).toEqual([]);
  });

  it('keeps lowercase and mixed-case native widget types in their declared hierarchy', async () => {
    const files =
      await fixture(`CONTAINERWINDOWTYPE = { name = "native_window" size = { width = 300 height = 200 }
      gridboxtype = { name = "native_rows" size = { width = 100%% height = 100%% } slotsize = { width = 100 height = 30 } max_slots_horizontal = 1 }
    }
    containerwindowtype = { name = "native_row" size = { width = 100 height = 30 }
      instanttextboxtype = { name = "label" text = "" maxWidth = 100 maxHeight = 20 }
    }`);
    const scene = await sceneFor(files, {
      lists: {
        native_rows: [
          { entryContainer: 'native_row', 'label.text': 'First' },
          { entryContainer: 'native_row', 'label.text': 'Second' },
        ],
      },
    });
    expect(scene.elements.find(({ name }) => name === 'native_rows')?.elementType).toBe(
      'gridboxtype',
    );
    expect(
      scene.elements
        .filter(({ name }) => name === 'native_row')
        .map(({ unclippedRect }) => unclippedRect.y),
    ).toEqual([0, 30]);
    expect(
      scene.elements.filter(({ name }) => name === 'label').map(({ text }) => text?.text),
    ).toEqual(['First', 'Second']);
  });

  it('distinguishes proportional extents from percentage far edges after resolving anchors', async () => {
    const files = await fixture(`containerWindowType = {
      name = "native_window" position = { x = -200 y = -100 } orientation = center
      size = { width = 400 height = 90%% }
      containerWindowType = { name = "fill" position = { x = 20 y = 80 } size = { width = 100%% height = 95%% } }
      containerWindowType = { name = "proportion" position = { x = 20 y = 80 } size = { width = 100% height = 95% } }
      containerWindowType = { name = "negative_inset" position = { x = 20 y = 80 } size = { width = -10 height = -30 } }
    }`);
    for (const [width, height, uiScale] of [
      [1600, 1000, 1],
      [2560, 1440, 1],
      [1600, 1000, 0.5],
    ]) {
      const scene = await sceneFor(files, { resolution: { width, height }, uiScale });
      const root = scene.elements.find(({ name }) => name === 'native_window')!.unclippedRect;
      expect(root.x).toBe(width! / 2 - 200 * uiScale!);
      expect(root.y).toBe(height! / 2 - 100 * uiScale!);
      expect(root.width).toBe(400 * uiScale!);
      expect(root.y + root.height).toBeCloseTo(height! * 0.9);
      const fill = scene.elements.find(({ name }) => name === 'fill')!.unclippedRect;
      const proportion = scene.elements.find(({ name }) => name === 'proportion')!.unclippedRect;
      const inset = scene.elements.find(({ name }) => name === 'negative_inset')!.unclippedRect;
      expect(fill.width).toBeCloseTo(root.width - 20 * uiScale!);
      expect(fill.y + fill.height).toBeCloseTo(root.y + root.height * 0.95);
      expect(proportion.width).toBeCloseTo(root.width);
      expect(proportion.height).toBeCloseTo(root.height * 0.95);
      expect(inset.width).toBeCloseTo(root.width - 30 * uiScale!);
      expect(inset.y + inset.height).toBeCloseTo(root.y + root.height - 30 * uiScale!);
    }
  });

  it('binds external native row templates, horizontal grids, and distinct nested lists without scripted-GUI wiring', async () => {
    const files =
      await fixture(`containerWindowType = { name = "native_window" size = { width = 300 height = 200 }
      gridBoxType = { name = "native_rows" position = { x = 10 y = 20 } size = { width = 240 height = 120 } slotsize = { width = 80 height = 40 } max_slots_horizontal = 2 }
    }
    containerWindowType = { name = "native_row_template" size = { width = 80 height = 40 }
      instantTextBoxType = { name = "name_label" text = "" size = { width = 80 height = 18 } }
      gridBoxType = { name = "badges" position = { x = 0 y = 20 } size = { width = 80 height = 20 } slotsize = { width = 16 height = 16 } max_slots_vertical = 1 }
    }
    containerWindowType = { name = "badge_template" size = { width = 16 height = 16 } iconType = { name = "badge_icon" spriteType = "GFX_tile" } }`);
    const lists = {
      native_rows: [
        {
          entryContainer: 'native_row_template',
          'name_label.text': 'Alpha',
          'badges.list': 'alpha_badges',
        },
        {
          entryContainer: 'native_row_template',
          'name_label.text': 'Beta',
          'badges.list': 'beta_badges',
        },
        {
          entryContainer: 'native_row_template',
          'name_label.text': 'Gamma',
          'badges.list': 'empty_badges',
        },
      ],
      alpha_badges: [{ entryContainer: 'badge_template' }, { entryContainer: 'badge_template' }],
      beta_badges: [{ entryContainer: 'badge_template' }],
      empty_badges: [],
    };
    const scene = await sceneFor(files, { lists });
    expect(
      scene.elements
        .filter(({ name }) => name === 'native_row_template')
        .map(({ unclippedRect }) => [unclippedRect.x, unclippedRect.y]),
    ).toEqual([
      [10, 20],
      [90, 20],
      [10, 60],
    ]);
    expect(
      scene.elements
        .filter(({ name }) => name === 'badge_icon')
        .map(({ unclippedRect }) => [unclippedRect.x, unclippedRect.y]),
    ).toEqual([
      [10, 40],
      [26, 40],
      [90, 40],
    ]);
    expect(
      scene.elements.filter(({ name }) => name === 'name_label').map(({ text }) => text?.text),
    ).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(
      referencedAssetPatternsForWindow(
        buildGuiSourceGraph(files, SymbolIndex.build(files)),
        'native_window',
        [],
        ['l_english'],
        ['native_row_template', 'badge_template'],
      ),
    ).toContain('gfx/tile.png');
  });

  it('evaluates focus-inlay first-match sprites, absent branches, progress, and button availability from source', async () => {
    const files =
      await fixture(`containerWindowType = { name = "native_window" size = { width = 400 height = 250 }
      iconType = { name = "selected" spriteType = "GFX_fixed" }
      iconType = { name = "unselected" spriteType = "GFX_tile" }
      iconType = { name = "meter" spriteType = "GFX_progress" }
      buttonType = { name = "action" spriteType = "GFX_tile" position = { x = 290 y = 20 } }
      instantTextBoxType = { name = "context_label" context_aware_text = "CONTEXT_VALUE" }
    }`);
    files.push(
      scanned(
        'interface/progress.gfx',
        'spriteTypes = { progressbartype = { name = "GFX_progress" texturefile = "gfx/tile.png" texturefile2 = "gfx/fixed.png" } }',
      ),
    );
    files.push(
      scanned(
        'localisation/english/native_l_english.yml',
        '\ufeffl_english:\nCONTEXT_VALUE: "[?meter_value]"\n',
      ),
    );
    files.push(
      scanned(
        'common/focus_inlay_windows/native.txt',
        `native_inlay = {
      window_name = native_window internal = yes visible = { always = yes }
      scripted_images = {
        selected = { GFX_tile = { check_variable = { selection = 1 } } }
        unselected = { GFX_fixed = { NOT = { check_variable = { selection = 1 } } } }
      }
      scripted_buttons = { action = { available = { check_variable = { meter_value > 0.5 } } click_effect = { add_stability = 0.1 } } }
      scripted_progressbars = { meter = { progress = meter_value } }
    }`,
      ),
    );
    const graph = buildGuiSourceGraph(files, SymbolIndex.build(files));
    expect(graph.scriptedGuis[0]).toMatchObject({
      interfaceKind: 'focus-inlay',
      windowName: 'native_window',
      internal: true,
    });
    expect(referencedAssetPatternsForWindow(graph, 'native_window')).toEqual(
      expect.arrayContaining(['gfx/tile.png', 'gfx/fixed.png']),
    );
    for (const [selection, meterValue] of [
      [1, 0.25],
      [0, 0.75],
    ]) {
      const scene = await sceneFor(files, { values: { selection, meter_value: meterValue } });
      expect(scene.elements.find(({ name }) => name === 'selected')!.visible).toBe(selection === 1);
      expect(scene.elements.find(({ name }) => name === 'unselected')!.visible).toBe(
        selection !== 1,
      );
      expect(scene.elements.find(({ name }) => name === 'meter')!.progressRatio).toBe(meterValue);
      expect(scene.elements.find(({ name }) => name === 'action')!.clickable).toBe(
        meterValue! > 0.5,
      );
      expect(scene.elements.find(({ name }) => name === 'context_label')!.text!.text).toBe(
        String(meterValue),
      );
    }
    const explicit = await sceneFor(files, {
      values: { selection: 1, 'selected.image': 'GFX_fixed' },
      visibility: { selected: false },
    });
    expect(explicit.elements.find(({ name }) => name === 'selected')!.visible).toBe(false);
  });

  it('does not skip an unknown earlier inlay image condition to claim a later default was selected', async () => {
    const files = await fixture(
      'containerWindowType = { name = "native_window" size = { width = 300 height = 200 } iconType = { name = "image" spriteType = "GFX_fixed" } }',
    );
    files.push(
      scanned(
        'common/focus_inlay_windows/native.txt',
        `native_inlay = { window_name = native_window scripted_images = { image = { GFX_tile = { has_country_flag = unspecified } GFX_fixed = yes } } }`,
      ),
    );
    const unresolved = await sceneFor(files);
    expect(unresolved.fidelity.unresolved.some(({ field }) => field === 'focus_inlay_image')).toBe(
      true,
    );
    expect(unresolved.fidelity.modelled.some(({ field }) => field === 'focus_inlay_image')).toBe(
      false,
    );
    const resolved = await sceneFor(files, { flags: { unspecified: false } });
    expect(resolved.fidelity.unresolved.some(({ field }) => field === 'focus_inlay_image')).toBe(
      false,
    );
    expect(
      resolved.fidelity.modelled.find(({ field }) => field === 'focus_inlay_image')!.detail,
    ).toContain('GFX_fixed');
  });

  it('lays out horizontal and vertical scrollbar roles within the track at both endpoints', async () => {
    for (const horizontal of [0, 1]) {
      const files =
        await fixture(`containerWindowType = { name = "native_window" size = { width = 300 height = 300 }
        scrollbarType = { name = "slider_control" position = { x = 20 y = 30 } size = { width = ${horizontal ? 160 : 16} height = ${horizontal ? 16 : 160} }
          horizontal = ${horizontal} borderSize = { x = 16 y = 16 } minValue = 10 maxValue = 90 startValue = 50
          slider = "thumb" track = "rail" leftbutton = "decrease" rightbutton = "increase"
          guiButtonType = { name = "thumb" spriteType = "GFX_tile" position = { x = 900 y = 900 } }
          guiButtonType = { name = "rail" spriteType = "GFX_tile" position = { x = 0 y = 22 } }
          guiButtonType = { name = "decrease" spriteType = "GFX_tile" position = { x = 0 y = 0 } }
          guiButtonType = { name = "increase" spriteType = "GFX_tile" position = { x = 0 y = 120 } }
        }
      }`);
      for (const [value, expectedAxis] of [
        [-10, 16],
        [10, 16],
        [50, 72],
        [90, 128],
        [200, 128],
      ]) {
        const scene = await sceneFor(files, { values: { slider_control: value } });
        const parts = Object.fromEntries(scene.elements.map((element) => [element.name, element]));
        const origin = horizontal ? 20 : 30;
        const axis = horizontal ? 'x' : 'y';
        expect(parts.thumb!.unclippedRect[axis]).toBe(origin + expectedAxis!);
        expect(parts.increase!.unclippedRect[axis]).toBe(origin + 144);
        expect(parts.rail!.unclippedRect[axis]).toBe(origin + 16);
        expect(parts.rail!.unclippedRect[horizontal ? 'width' : 'height']).toBe(128);
        expect(parts.thumb!.clipped).toBe(false);
        expect(parts.rail!.zIndex).toBeLessThan(parts.thumb!.zIndex);
      }
    }
  });

  it('reports absent scrollbar role templates and handles a zero value range without invalid geometry', async () => {
    const scene = await sceneFor(
      await fixture(`containerWindowType = { name = "native_window" size = { width = 200 height = 100 }
      scrollbarType = { name = "empty_range" size = { width = 100 height = 16 } horizontal = 1 minValue = 20 maxValue = 20
        slider = "thumb" track = "missing_track"
        guiButtonType = { name = "thumb" spriteType = "GFX_tile" }
      }
    }`),
    );
    expect(scene.diagnostics.map(({ code }) => code)).toContain('GUI_SCROLLBAR_ROLE_MISSING');
    const thumb = scene.elements.find(({ name }) => name === 'thumb')!;
    expect(thumb.clickable).toBe(false);
    expect(Object.values(thumb.unclippedRect).every(Number.isFinite)).toBe(true);
  });

  it('keeps fixed panel pixels independent of the logical container and screen resolution', async () => {
    const files = await fixture(`containerWindowType = {
      name = "native_window" position = { x = 20 y = 30 } size = { width = 200 height = 140 } clipping = no
      background = { name = "fixed_panel" quadTextureSprite = "GFX_fixed" }
    }`);
    for (const uiScale of [0.5, 1, 1.5]) {
      for (const resolution of [
        { width: 1280, height: 720 },
        { width: 2560, height: 1440 },
      ]) {
        const scene = await sceneFor(files, { uiScale, resolution });
        const panel = scene.elements.find(({ name }) => name === 'fixed_panel')!;
        expect(panel.unclippedRect).toEqual({
          x: 20 * uiScale,
          y: 30 * uiScale,
          width: 280 * uiScale,
          height: 190 * uiScale,
        });
        expect(scene.elements[0]!.unclippedRect).toEqual({
          x: 20 * uiScale,
          y: 30 * uiScale,
          width: 200 * uiScale,
          height: 140 * uiScale,
        });
        expect(panel.sourceId).toBe(scene.elements[0]!.sourceId);
        expect(scene.bounds).toEqual(panel.unclippedRect);
      }
    }
    const scene = await sceneFor(files, { resolution: { width: 640, height: 360 } });
    const rendered = await renderGuiScene(scene, ['full']);
    const { data, info } = await sharp(rendered.images[0]!.png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [
      ...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4),
    ];
    expect(pixel(299, 219)).toEqual([0x12, 0x34, 0x56, 255]);
    expect(pixel(300, 220)).not.toEqual([0x12, 0x34, 0x56, 255]);
  });

  it('composes repeated backgrounds in order with independent positions and native tiled sizing', async () => {
    const scene = await sceneFor(
      await fixture(`containerWindowType = {
      name = "native_window" size = { width = 200 height = 140 }
      background = { name = "fixed_panel" quadTextureSprite = "GFX_fixed" position = { x = -5 y = 4 } }
      background = { name = "tiled_overlay" spriteType = "GFX_tile" position = { x = 2 y = 3 } }
      iconType = { name = "foreground" spriteType = "GFX_tile" position = { x = 10 y = 10 } }
    }`),
    );
    const backgrounds = scene.elements.filter(({ elementType }) => elementType === 'background');
    expect(backgrounds.map(({ name }) => name)).toEqual(['fixed_panel', 'tiled_overlay']);
    expect(backgrounds[0]!.unclippedRect).toEqual({ x: -5, y: 4, width: 280, height: 190 });
    expect(backgrounds[1]).toMatchObject({
      unclippedRect: { x: 2, y: 3, width: 200, height: 140 },
      spriteRenderMode: 'cornered-tile',
    });
    expect(backgrounds[1]!.zIndex).toBeLessThan(
      scene.elements.find(({ name }) => name === 'foreground')!.zIndex,
    );
    // A native panel may paint beyond the logical container even when its contents are clipped.
    expect(backgrounds[0]!.clipRect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it('honours native centre spelling, explicit vertical alignment, and literal visibility', async () => {
    const files =
      await fixture(`containerWindowType = { name = "native_window" size = { width = 200 height = 140 }
      instantTextBoxType = { name = "title" text = "Title" format = centre vertical_alignment = top size = { width = 180 height = 40 } }
      buttonType = { name = "top_label" text = "Top" vertical_alignment = top size = { width = 100 height = 50 } }
      iconType = { name = "hidden_icon" spriteType = "GFX_tile" hide = 1 }
      iconType = { name = "invisible_icon" spriteType = "GFX_tile" visible = no }
      containerWindowType = { name = "hidden_parent" hide = yes size = { width = 100 height = 100 }
        iconType = { name = "hidden_child" spriteType = "GFX_tile" }
      }
    }`);
    const base = await sceneFor(files);
    expect(base.elements.find(({ name }) => name === 'title')!.text).toMatchObject({
      horizontalAlignment: 'center',
      verticalAlignment: 'top',
    });
    expect(base.elements.find(({ name }) => name === 'top_label')!.text).toMatchObject({
      horizontalAlignment: 'center',
      verticalAlignment: 'top',
    });
    for (const name of ['hidden_icon', 'invisible_icon', 'hidden_child'])
      expect(base.elements.find((element) => element.name === name)!.visible).toBe(false);
    const explicit = await sceneFor(files, {
      visibility: { hidden_icon: true, hidden_child: true },
    });
    expect(explicit.elements.find(({ name }) => name === 'hidden_icon')!.visible).toBe(true);
    expect(explicit.elements.find(({ name }) => name === 'hidden_child')!.visible).toBe(false);
  });

  it('resolves negative extents as far-edge insets instead of zero-sized containers', async () => {
    const scene = await sceneFor(
      await fixture(`containerWindowType = { name = "native_window" size = { width = 300 height = 400 }
      containerWindowType = { name = "remaining" position = { x = 20 y = 80 } size = { width = -15 height = -30 }
        background = { name = "remaining_panel" spriteType = "GFX_tile" }
      }
    }`),
    );
    expect(scene.elements.find(({ name }) => name === 'remaining')!.unclippedRect).toEqual({
      x: 20,
      y: 80,
      width: 265,
      height: 290,
    });
    expect(scene.elements.find(({ name }) => name === 'remaining_panel')!.unclippedRect).toEqual({
      x: 20,
      y: 80,
      width: 265,
      height: 290,
    });
  });

  it('clips descendants independently when an unclipped logical ancestor is outside the viewport', async () => {
    const files =
      await fixture(`containerWindowType = { name = "native_window" position = { x = -100 y = 0 } size = { width = 20 height = 20 } clipping = no
      iconType = { name = "outside_child" spriteType = "GFX_tile" position = { x = 120 y = 10 } }
      containerWindowType = { name = "clipped_parent" size = { width = 20 height = 20 } clipping = yes
        iconType = { name = "clipped_child" spriteType = "GFX_tile" position = { x = 120 y = 10 } }
      }
      containerWindowType = { name = "hidden_parent" size = { width = 20 height = 20 } hide = yes clipping = no
        iconType = { name = "hidden_child" spriteType = "GFX_tile" position = { x = 120 y = 10 } }
      }
    }`);
    const scene = await sceneFor(files);
    expect(scene.elements.find(({ name }) => name === 'native_window')!.visible).toBe(false);
    expect(scene.elements.find(({ name }) => name === 'outside_child')).toMatchObject({
      visible: true,
      unclippedRect: { x: 20, y: 10, width: 16, height: 16 },
    });
    expect(scene.elements.find(({ name }) => name === 'clipped_child')!.visible).toBe(false);
    expect(scene.elements.find(({ name }) => name === 'hidden_child')!.visible).toBe(false);
    expect(scene.bounds).toEqual({ x: 20, y: 10, width: 16, height: 16 });
  });

  it('keeps child priorities inside their row rather than lifting them across later rows', async () => {
    const scene = await sceneFor(
      await fixture(`containerWindowType = { name = "native_window" size = { width = 300 height = 400 }
      gridBoxType = { name = "rows" size = { width = 300 height = 400 } slotsize = { width = 100 height = 40 }
        containerWindowType = { name = "row" size = { width = 100 height = 40 }
          iconType = { name = "priority_icon" spriteType = "GFX_tile" priority = 100 }
          iconType = { name = "base_icon" spriteType = "GFX_tile" }
        }
      }
    }`),
      { lists: { rows: [{ index: 0 }, { index: 1 }] } },
    );
    const sprites = scene.elements.filter(({ sprite }) => sprite !== undefined);
    expect(sprites.map(({ name, rowIndex }) => [name, rowIndex])).toEqual([
      ['base_icon', 0],
      ['priority_icon', 0],
      ['base_icon', 1],
      ['priority_icon', 1],
    ]);
  });
});
