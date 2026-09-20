import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { buildGuiScene } from '../../src/hoi4_agent_tools/gui/layout.js';
import { buildGuiSourceGraph } from '../../src/hoi4_agent_tools/gui/source-graph.js';
import { parsePreviewScenario } from '../../src/hoi4_agent_tools/gui/scenario.js';
import { renderGuiScene } from '../../src/hoi4_agent_tools/gui/renderer.js';
import { referencedAssetPatternsForWindow } from '../../src/hoi4_agent_tools/gui/studio.js';

function scanned(displayPath: string, content: string | Buffer): ScannedFile {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
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

function scrollbar(name: string, horizontal = false) {
  return `extendedScrollbarType = {
    name = "${name}" position = { x = ${horizontal ? 0 : -2} y = ${horizontal ? -2 : 0} }
    size = { width = 12 height = 12 } horizontal = ${horizontal ? 'yes' : 'no'}
    orientation = ${horizontal ? 'lower_left' : 'upper_right'} origo = ${horizontal ? 'lower_left' : 'upper_right'}
    background = { name = "scroll_background" spriteType = "GFX_tile" }
    track = { name = "rail" spriteType = "GFX_track" position = { x = ${horizontal ? 1 : 4} y = ${horizontal ? 4 : 1} } alwaystransparent = yes }
    slider = { name = "thumb" spriteType = "GFX_thumb" position = { x = ${horizontal ? 0 : -2} y = ${horizontal ? -2 : 0} } }
    decreaseButton = { name = "decrease" spriteType = "GFX_arrow" position = { x = ${horizontal ? 2 : 1} y = ${horizontal ? 1 : 2} } }
    increaseButton = { name = "increase" spriteType = "GFX_arrow" position = { x = ${horizontal ? -12 : -11} y = ${horizontal ? -11 : -12} } }
  }`;
}

async function fixture(
  contents: string,
  extra = `${scrollbar('vertical')} ${scrollbar('horizontal', true)}`,
) {
  const files = [
    scanned(
      'interface/scroll.gui',
      `guiTypes = { containerWindowType = { name = "root" size = { width = 300 height = 240 } ${contents} } ${extra} }`,
    ),
    scanned(
      'interface/scroll.gfx',
      `spriteTypes = {
      corneredTileSpriteType = { name = "GFX_tile" texturefile = "gfx/tile.png" size = { x = 16 y = 16 } borderSize = { x = 2 y = 2 } }
      corneredTileSpriteType = { name = "GFX_track" texturefile = "gfx/track.png" size = { x = 4 y = 4 } borderSize = { x = 1 y = 1 } }
      spriteType = { name = "GFX_thumb" texturefile = "gfx/thumb.png" }
      spriteType = { name = "GFX_arrow" texturefile = "gfx/arrow.png" }
    }`,
    ),
  ];
  for (const [name, size, colour] of [
    ['tile', 16, '#102030'],
    ['track', 4, '#506070'],
    ['thumb', 8, '#ff0000'],
    ['arrow', 10, '#00ff00'],
  ] as const)
    files.push(
      scanned(
        `gfx/${name}.png`,
        await sharp({ create: { width: size, height: size, channels: 4, background: colour } })
          .png()
          .toBuffer(),
      ),
    );
  return files;
}

async function sceneFor(files: ScannedFile[], scenario: Record<string, unknown> = {}) {
  return buildGuiScene(
    buildGuiSourceGraph(files, SymbolIndex.build(files)),
    files,
    'root',
    parsePreviewScenario({ id: 'scrolling', resolution: { width: 320, height: 240 }, ...scenario }),
  );
}

describe('native container scrolling', () => {
  it('reserves gutters only for visible axes and honours explicit visibility over native autohide', async () => {
    const files =
      await fixture(`containerWindowType = { name = "owner" size = { width = 100 height = 80 }
      background = { name = "panel" spriteType = "GFX_tile" } verticalScrollbar = "vertical" horizontalScrollbar = "horizontal"
      containerWindowType = { name = "content" size = { width = 180 height = 160 } }
    }`);
    const hiddenAxis = await sceneFor(files, { visibility: { vertical: false } });
    expect(hiddenAxis.elements.find(({ name }) => name === 'vertical')!.visible).toBe(false);
    expect(hiddenAxis.elements.find(({ name }) => name === 'horizontal')!.unclippedRect.width).toBe(
      100,
    );
    const forced = await sceneFor(files, { visibility: { content: false, vertical: true } });
    expect(forced.elements.find(({ name }) => name === 'vertical')).toMatchObject({
      visible: true,
      state: 'disabled',
    });
    expect(forced.elements.find(({ name }) => name === 'horizontal')!.visible).toBe(false);
    expect(forced.elements.find(({ name }) => name === 'vertical')!.unclippedRect.height).toBe(80);
  });

  it('retains declared grid bounds as the minimum extent when populated rows are shorter', async () => {
    const files =
      await fixture(`containerWindowType = { name = "owner" size = { width = 100 height = 80 }
      background = { name = "panel" spriteType = "GFX_tile" } margin = { top = 5 bottom = 5 } verticalScrollbar = "vertical"
      gridBoxType = { name = "rows" size = { width = 100%% height = 100%% } slotsize = { width = 80 height = 20 } max_slots_horizontal = 1
        containerWindowType = { name = "row" size = { width = 80 height = 20 } }
      }
    }`);
    for (const rows of [[], [{ index: 0 }]]) {
      const scene = await sceneFor(files, { lists: { rows } });
      expect(scene.elements.find(({ name }) => name === 'owner')!.scroll!.maximumY).toBe(5);
      expect(
        scene.elements.find(({ elementType }) => elementType === 'extendedScrollbarType')!.visible,
      ).toBe(true);
    }
  });

  it('reserves orthogonal gutters at either corner, including source insets, without reducing the content range', async () => {
    for (const reverse of [false, true]) {
      const horizontal = reverse
        ? scrollbar('across', true)
            .replaceAll('lower_left', 'upper_left')
            .replace('y = -2', 'y = 2')
        : scrollbar('across', true);
      const vertical = reverse
        ? scrollbar('down').replaceAll('upper_right', 'upper_left').replace('x = -2', 'x = 2')
        : scrollbar('down');
      const files = await fixture(
        `containerWindowType = { name = "owner" position = { x = 10 y = 20 } size = { width = 100 height = 80 }
        background = { name = "panel" spriteType = "GFX_tile" } verticalScrollbar = "down" horizontalScrollbar = "across"
        containerWindowType = { name = "content" size = { width = 180 height = 160 } }
      }`,
        `${horizontal} ${vertical}`,
      );
      const scene = await sceneFor(files, { state: 'maximum-value' });
      expect(scene.elements.find(({ name }) => name === 'owner')!.scroll).toMatchObject({
        offsetX: 80,
        offsetY: 80,
        maximumX: 80,
        maximumY: 80,
      });
      const across = scene.elements.find(({ name }) => name === 'across')!;
      const down = scene.elements.find(({ name }) => name === 'down')!;
      expect(across.unclippedRect).toEqual({
        x: reverse ? 24 : 10,
        y: reverse ? 22 : 86,
        width: 86,
        height: 12,
      });
      expect(down.unclippedRect).toEqual({
        x: reverse ? 12 : 96,
        y: reverse ? 34 : 20,
        width: 12,
        height: 66,
      });
      const corners = scene.elements.filter(({ name }) => name === 'increase');
      expect(corners).toHaveLength(2);
      const first = corners[0]!.unclippedRect;
      const second = corners[1]!.unclippedRect;
      expect(
        first.x + first.width <= second.x ||
          second.x + second.width <= first.x ||
          first.y + first.height <= second.y ||
          second.y + second.height <= first.y,
      ).toBe(true);
      expect(
        scene.fidelity.modelled.some(({ field }) => field === 'orthogonal_scrollbar_gutters'),
      ).toBe(true);
    }
  });

  it('does not reserve an auto-hidden axis and retains unique ids for extra children in reused templates', async () => {
    const vertical = scrollbar('vertical').replace(
      /\}\s*$/u,
      'iconType = { name = "extra_marker" spriteType = "GFX_thumb" } }',
    );
    const files = await fixture(
      ['first', 'second']
        .map(
          (
            name,
            index,
          ) => `containerWindowType = { name = "${name}" position = { x = ${index * 130} y = 0 } size = { width = 100 height = 80 }
      background = { name = "panel" spriteType = "GFX_tile" } verticalScrollbar = "vertical" horizontalScrollbar = "horizontal"
      containerWindowType = { name = "content_${name}" size = { width = 180 height = 40 } }
    }`,
        )
        .join('\n'),
      `${vertical} ${scrollbar('horizontal', true)}`,
    );
    const scene = await sceneFor(files);
    expect(
      scene.elements
        .filter(({ name }) => name === 'horizontal')
        .map(({ unclippedRect }) => unclippedRect.width),
    ).toEqual([100, 100]);
    expect(scene.elements.filter(({ name }) => name === 'extra_marker')).toHaveLength(2);
    expect(new Set(scene.elements.map(({ id }) => id)).size).toBe(scene.elements.length);
    expect(
      scene.fidelity.modelled.some(({ field }) => field === 'orthogonal_scrollbar_gutters'),
    ).toBe(false);
  });

  it('reports ambiguous inline role blocks and non-positive scrollbar scales instead of producing invalid geometry', async () => {
    for (const scale of [0, -1]) {
      const scene = await sceneFor(
        await fixture(`containerWindowType = { name = "owner" size = { width = 100 height = 80 }
        background = { name = "panel" spriteType = "GFX_tile" } autohide_scrollbars = no
        ${scrollbar('bad').replace('name = "bad"', `name = "bad" scale = ${scale}`)}
      }`),
      );
      expect(scene.fidelity.unsupported.map(({ field }) => field)).toContain(
        'attached_scrollbar_scale',
      );
      expect(
        scene.elements.every(({ unclippedRect }) =>
          Object.values(unclippedRect).every(Number.isFinite),
        ),
      ).toBe(true);
    }
    const duplicate = scrollbar('duplicate').replace(
      'track = {',
      'track = { name = "duplicate_track" spriteType = "GFX_track" } track = {',
    );
    const scene = await sceneFor(
      await fixture(
        `containerWindowType = { name = "owner" size = { width = 100 height = 80 } background = { name = "panel" spriteType = "GFX_tile" } autohide_scrollbars = no ${duplicate} }`,
      ),
    );
    expect(scene.fidelity.unsupported.map(({ field }) => field)).toContain(
      'extended_scrollbar_role',
    );
    expect(scene.elements.some(({ name }) => name === 'rail' || name === 'duplicate_track')).toBe(
      false,
    );
  });

  it('composes attached artwork, clamps content offsets, and makes scrolled-in rows visible inside fixed margins', async () => {
    const files = await fixture(`containerWindowType = {
      name = "viewport" position = { x = 20 y = 30 } size = { width = 100 height = 80 }
      background = { name = "panel" spriteType = "GFX_tile" }
      margin = { top = 5 bottom = 5 } verticalScrollbar = "vertical"
      iconType = { name = "fixed_header" spriteType = "GFX_thumb" size = { width = 50 height = 4 } }
      gridBoxType = { name = "rows" size = { width = 90 height = 75 } slotsize = { width = 80 height = 30 } max_slots_horizontal = 1
        containerWindowType = { name = "row" size = { width = 80 height = 30 }
          iconType = { name = "row_icon" spriteType = "GFX_thumb" position = { x = 3 y = 5 } }
        }
      }
    }`);
    const original = files.map(({ sha256 }) => sha256);
    for (const [requested, offset] of [
      [0, 0],
      [40, 40],
      [1000, 75],
    ]) {
      const scene = await sceneFor(files, {
        lists: { rows: Array.from({ length: 5 }, (_, index) => ({ index })) },
        scrollOffsets: { viewport: requested },
      });
      const viewport = scene.elements.find(({ name }) => name === 'viewport')!;
      expect(viewport.scroll).toEqual({
        viewport: { x: 20, y: 35, width: 100, height: 70 },
        contentWidth: 100,
        contentHeight: 145,
        offsetX: 0,
        offsetY: offset,
        maximumX: 0,
        maximumY: 75,
      });
      const bar = scene.elements.find(
        ({ elementType }) => elementType === 'extendedScrollbarType',
      )!;
      expect(bar).toMatchObject({
        visible: true,
        unclippedRect: { x: 106, y: 35, width: 12, height: 70 },
      });
      expect(scene.elements.find(({ name }) => name === 'rail')!.unclippedRect).toEqual({
        x: 110,
        y: 48,
        width: 4,
        height: 45,
      });
      expect(scene.elements.find(({ name }) => name === 'thumb')!.unclippedRect.y).toBeCloseTo(
        48 + (37 * offset!) / 75,
      );
      expect(scene.elements.find(({ name }) => name === 'increase')!.unclippedRect).toEqual({
        x: 107,
        y: 93,
        width: 10,
        height: 10,
      });
      expect(scene.elements.find(({ name }) => name === 'fixed_header')).toMatchObject({
        visible: true,
        unclippedRect: { x: 20, y: 30, width: 50, height: 4 },
        clipRect: { x: 20, y: 30, width: 100, height: 80 },
      });
      const lastRow = scene.elements.find(
        ({ name, rowIndex }) => name === 'row' && rowIndex === 4,
      )!;
      expect(lastRow.unclippedRect.y).toBe(150 - offset!);
      expect(lastRow.visible).toBe(offset === 75);
      if (offset === 75) {
        const lastIcon = scene.elements.find(
          ({ name, rowIndex }) => name === 'row_icon' && rowIndex === 4,
        )!;
        expect(lastIcon.visible).toBe(true);
        expect(lastIcon.clipRect).toEqual({ x: 20, y: 35, width: 100, height: 70 });
        const rendered = await renderGuiScene(scene, ['full']);
        const { data, info } = await sharp(rendered.images[0]!.png)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const pixel = (x: number, y: number) => [
          ...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4),
        ];
        expect(pixel(24, 81)).toEqual([255, 0, 0, 255]);
        expect(pixel(24, 106)).toEqual([16, 32, 48, 255]);
        expect(pixel(24, 31)).toEqual([255, 0, 0, 255]);
      }
    }
    expect(files.map(({ sha256 }) => sha256)).toEqual(original);
    expect(
      referencedAssetPatternsForWindow(
        buildGuiSourceGraph(files, SymbolIndex.build(files)),
        'root',
      ),
    ).toEqual(expect.arrayContaining(['gfx/track.png', 'gfx/arrow.png', 'gfx/thumb.png']));
  });

  it('keeps reused scrollbar instances independent and auto-hides only the non-overflowing container', async () => {
    const files = await fixture(
      ['first', 'second']
        .map(
          (name, index) => `containerWindowType = {
      name = "${name}" position = { x = ${index * 130} y = 0 } size = { width = 100 height = 80 }
      background = { name = "panel" spriteType = "GFX_tile" } verticalScrollbar = "vertical"
      containerWindowType = { name = "content_${name}" size = { width = 70 height = ${index === 0 ? 40 : 160} } }
    }`,
        )
        .join('\n'),
    );
    const scene = await sceneFor(files, { scrollOffsets: { first: 50, second: 80 } });
    const bars = scene.elements.filter(
      ({ elementType }) => elementType === 'extendedScrollbarType',
    );
    expect(bars.map(({ visible }) => visible)).toEqual([false, true]);
    expect(new Set(scene.elements.map(({ id }) => id)).size).toBe(scene.elements.length);
    expect(scene.elements.find(({ name }) => name === 'first')!.scroll!.offsetY).toBe(0);
    expect(scene.elements.find(({ name }) => name === 'second')!.scroll!.offsetY).toBe(80);
    expect(
      scene.elements.filter(({ name }) => name === 'thumb').map(({ visible }) => visible),
    ).toEqual([false, true]);
  });

  it('attaches inline horizontal scrollbars and uses per-row horizontal offsets at fractional UI scale', async () => {
    const files =
      await fixture(`gridBoxType = { name = "owners" size = { width = 280 height = 200 } slotsize = { width = 120 height = 90 } max_slots_horizontal = 1
      containerWindowType = { name = "owner" size = { width = 100 height = 80 }
        background = { name = "panel" spriteType = "GFX_tile" }
        ${scrollbar('inline', true)}
        containerWindowType = { name = "wide" size = { width = 180 height = 50 } }
      }
    }`);
    const scene = await sceneFor(files, {
      uiScale: 0.5,
      lists: { owners: [{ 'owner.scrollX': 0 }, { 'owner.scrollX': 1000 }] },
    });
    const owners = scene.elements.filter(({ name }) => name === 'owner');
    expect(owners.map(({ scroll }) => scroll!.offsetX)).toEqual([0, 40]);
    const bars = scene.elements.filter(
      ({ elementType }) => elementType === 'extendedScrollbarType',
    );
    expect(bars.map(({ unclippedRect }) => [unclippedRect.width, unclippedRect.height])).toEqual([
      [50, 6],
      [50, 6],
    ]);
    const thumbs = scene.elements.filter(({ name }) => name === 'thumb');
    expect(thumbs[0]!.unclippedRect.x).toBe(6.5);
    expect(thumbs[1]!.unclippedRect.x).toBe(40);
    expect(
      scene.elements
        .filter(({ name }) => name === 'wide')
        .map(({ unclippedRect }) => unclippedRect.x),
    ).toEqual([0, -40]);
  });

  it('measures nested containers by their own bounds, not by overflowing child artwork', async () => {
    const files = await fixture(`containerWindowType = {
      name = "owner" size = { width = 100 height = 80 }
      background = { name = "panel" spriteType = "GFX_tile" } verticalScrollbar = "vertical"
      containerWindowType = { name = "small" size = { width = 40 height = 40 } clipping = no
        iconType = { name = "overflow" spriteType = "GFX_thumb" position = { x = 0 y = 400 } }
      }
      containerWindowType = { name = "hidden" size = { width = 40 height = 900 } hide = yes }
    }`);
    const scene = await sceneFor(files);
    expect(scene.elements.find(({ name }) => name === 'owner')!.scroll!.maximumY).toBe(0);
    expect(
      scene.elements.find(({ elementType }) => elementType === 'extendedScrollbarType')!.visible,
    ).toBe(false);
  });

  it('retains nested content clips after both an inner and an outer container scroll', async () => {
    const files = await fixture(`containerWindowType = {
      name = "outer" position = { x = 10 y = 10 } size = { width = 150 height = 100 }
      background = { name = "outer_panel" spriteType = "GFX_tile" } verticalScrollbar = "vertical"
      containerWindowType = { name = "inner" position = { x = 5 y = 130 } size = { width = 100 height = 60 }
        background = { name = "inner_panel" spriteType = "GFX_tile" } verticalScrollbar = "vertical"
        containerWindowType = { name = "content" size = { width = 60 height = 120 }
          iconType = { name = "target" position = { x = 0 y = 70 } spriteType = "GFX_thumb" }
        }
      }
    }`);
    const scene = await sceneFor(files, { scrollOffsets: { outer: 90, inner: 60 } });
    expect(scene.elements.find(({ name }) => name === 'inner')!.unclippedRect).toEqual({
      x: 15,
      y: 50,
      width: 100,
      height: 60,
    });
    expect(scene.elements.find(({ name }) => name === 'target')).toMatchObject({
      visible: true,
      unclippedRect: { x: 15, y: 60, width: 8, height: 8 },
      clipRect: { x: 15, y: 50, width: 100, height: 60 },
    });
    expect(scene.elements.find(({ name }) => name === 'inner')!.scroll!.viewport).toEqual({
      x: 15,
      y: 50,
      width: 100,
      height: 60,
    });
  });

  it('shows disabled artwork when autohide is off and the content fits', async () => {
    const files = await fixture(`containerWindowType = {
      name = "owner" size = { width = 100 height = 80 } margin = { top = 5 bottom = 5 }
      background = { name = "panel" spriteType = "GFX_tile" } verticalScrollbar = "vertical" autohide_scrollbars = no
    }`);
    const scene = await sceneFor(files);
    expect(
      scene.elements.find(({ elementType }) => elementType === 'extendedScrollbarType'),
    ).toMatchObject({
      visible: true,
      clickable: false,
      state: 'disabled',
      unclippedRect: { x: 86, y: 5, width: 12, height: 70 },
    });
  });

  it('does not paint or activate a zero-area scrollbar and keeps excessive margins finite', async () => {
    const files = await fixture(`containerWindowType = {
      name = "owner" size = { width = 100 height = 80 } margin = { top = 100 bottom = 100 left = 100 right = 100 }
      background = { name = "panel" spriteType = "GFX_tile" } verticalScrollbar = "vertical" autohide_scrollbars = no
    }`);
    const scene = await sceneFor(files);
    expect(
      scene.elements.find(({ elementType }) => elementType === 'extendedScrollbarType'),
    ).toMatchObject({
      visible: false,
      clickable: false,
      state: 'disabled',
      unclippedRect: { height: 0 },
    });
    expect(
      scene.elements
        .filter(({ name }) => ['thumb', 'decrease', 'increase'].includes(name))
        .every(({ clickable }) => !clickable),
    ).toBe(true);
    expect(
      scene.elements.every(({ unclippedRect }) =>
        Object.values(unclippedRect).every(Number.isFinite),
      ),
    ).toBe(true);
  });

  it('reports missing, private, duplicate, wrong-axis and unclipped scrollbar bindings', async () => {
    const cases = [
      ['verticalScrollbar = "absent"', 'GUI_SCROLLBAR_TEMPLATE_MISSING'],
      ['verticalScrollbar = "horizontal"', 'GUI_SCROLLBAR_AXIS_MISMATCH'],
      ['verticalScrollbar = "vertical" clipping = no', 'GUI_SCROLLBAR_CONTAINER_BOUNDARY_MISSING'],
      [`verticalScrollbar = "vertical" ${scrollbar('inline')}`, 'GUI_SCROLLBAR_AXIS_DUPLICATE'],
      ['verticalScrollbar = "private"', 'GUI_SCROLLBAR_TEMPLATE_MISSING'],
    ];
    for (const [binding, expected] of cases) {
      const scene = await sceneFor(
        await fixture(`containerWindowType = { name = "owner" size = { width = 100 height = 80 } background = { name = "panel" spriteType = "GFX_tile" } ${binding} }
        containerWindowType = { name = "private_owner" ${scrollbar('private')} }`),
      );
      expect(scene.diagnostics.map(({ code }) => code)).toContain(expected);
    }
    const missingBackground = await sceneFor(
      await fixture(
        'containerWindowType = { name = "owner" size = { width = 100 height = 80 } clipping = yes verticalScrollbar = "vertical" }',
      ),
    );
    expect(missingBackground.diagnostics.map(({ code }) => code)).toContain(
      'GUI_SCROLLBAR_CONTAINER_BOUNDARY_MISSING',
    );
  });
});
