import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  buildGuiScene,
  buildGuiSourceGraph,
  parsePreviewScenario,
  renderGuiScene,
} from '../../src/hoi4_agent_tools/gui/index.js';
import {
  referencedAssetPatternsForWindow,
  ScriptedGuiStudio,
} from '../../src/hoi4_agent_tools/gui/studio.js';

function scanned(relativePath: string, content: string | Buffer): ScannedFile {
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

async function fixture(
  options: {
    duplicate?: boolean;
    missingLocalisation?: boolean;
    missingSprite?: boolean;
    missingFont?: boolean;
    missingIcon?: boolean;
    unresolvedVisibility?: boolean;
    text?: string;
  } = {},
) {
  const fontAtlas = await sharp({
    create: { width: 8, height: 16, channels: 4, background: { r: 230, g: 220, b: 190, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const texture = await sharp({
    create: { width: 96, height: 96, channels: 4, background: { r: 24, g: 30, b: 36, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const characters = Array.from(
    { length: 95 },
    (_unused, index) =>
      `char id=${index + 32} x=0 y=0 width=8 height=16 xoffset=0 yoffset=0 xadvance=8 page=0 chnl=15`,
  ).join('\n');
  const files = [
    scanned(
      'interface/tooltip.gui',
      `guiTypes = { containerWindowType = { name = "tooltip_window" size = { width = 640 height = 480 }
      buttonType = { name = "action" position = { x = 15 y = 20 } size = { width = 90 height = 24 } pdx_tooltip = "ACTION_TT" }
      ${options.duplicate === true ? 'buttonType = { name = "action" position = { x = 120 y = 20 } size = { width = 90 height = 24 } pdx_tooltip = "ACTION_TT" }' : ''}
    } }`,
    ),
    scanned(
      'interface/tooltip.gfx',
      `spriteTypes = {
      ${options.missingSprite === true ? '' : 'textSpriteType = { name = "ToolTip" texturefile = "gfx/interface/tooltip.png" noOfFrames = 1 }'}
      ${options.missingIcon === true ? '' : 'spriteType = { name = "GFX_pol_power" texturefile = "gfx/interface/tooltip.png" }'}
    }
    bitmapfonts = { ${options.missingFont === true ? '' : 'bitmapfont = { name = "cg_16b" path = "fonts/cg_16b.fnt" }'} }`,
    ),
    scanned(
      'localisation/english/tooltip_l_english.yml',
      options.missingLocalisation === true
        ? '\uFEFFl_english:\nOTHER_TT: "Other"\n'
        : `\uFEFFl_english:\nACTION_TT: ${JSON.stringify(options.text ?? 'Power £pol_power [?cost] [!action_click] [!action_click_enabled]')}\n`,
    ),
    scanned('gfx/interface/tooltip.png', texture),
    ...(options.missingFont === true
      ? []
      : [
          scanned(
            'fonts/cg_16b.fnt',
            `info face="Fixture" size=16\ncommon lineHeight=18 base=14 scaleW=8 scaleH=16 pages=1 packed=0\npage id=0 file="cg_16b.png"\nchars count=95\n${characters}\n`,
          ),
          scanned('fonts/cg_16b.png', fontAtlas),
        ]),
    ...(options.unresolvedVisibility === true
      ? [
          scanned(
            'common/scripted_guis/tooltip.txt',
            'scripted_gui = { tooltip_gui = { context_type = player_context window_name = tooltip_window triggers = { action_visible = { controls_state = 87 } } } }',
          ),
        ]
      : []),
  ];
  const graph = buildGuiSourceGraph(files, SymbolIndex.build(files));
  const scene = async (patch: Record<string, unknown> = {}) =>
    buildGuiScene(
      graph,
      files,
      'tooltip_window',
      parsePreviewScenario({
        id: 'tooltip-preview',
        resolution: { width: 640, height: 480 },
        tooltip: { target: 'action', x: 130, y: 70, width: 120, padding: 8 },
        values: {
          cost: 42,
          '[!action_click]': 'Effect details',
          '[!action_click_enabled]': 'Available',
        },
        ...patch,
      }),
    );
  return { files, graph, scene };
}

describe('immediate GUI tooltip preview', () => {
  it('requires bounded caller padding that leaves room for text', () => {
    const base = { target: 'action', x: 130, y: 70, width: 120 };
    for (const tooltip of [
      base,
      { ...base, padding: -1 },
      { ...base, padding: 60 },
      { ...base, padding: 65_536 },
      { ...base, padding: Infinity },
    ])
      expect(() => parsePreviewScenario({ id: 'invalid-padding', tooltip })).toThrow();
    expect(
      parsePreviewScenario({ id: 'zero-padding', tooltip: { ...base, padding: 0 } }).tooltip,
    ).toMatchObject({ padding: 0 });
  });

  it.each([1, 1.25])(
    'sizes a 96px tooltip sprite around measured short text at UI scale %s',
    async (uiScale) => {
      const { scene } = await fixture({ text: 'Close' });
      for (const padding of [0, 10]) {
        const preview = await scene({
          resolution: { width: 1920, height: 1080 },
          uiScale,
          tooltip: { target: 'action', x: 980, y: 100, width: 160, padding },
        });
        expect(preview.tooltipPreview).toBeDefined();
        const { element: background, textElement } = preview.tooltipPreview!;
        const textHeight = textElement.text!.measuredHeight;
        expect(background.sprite).toMatchObject({ width: 96, height: 96 });
        expect(textElement.text).toMatchObject({ lines: ['Close'], measuredHeight: 18 * uiScale });
        expect(background.rect).toEqual({
          x: 980,
          y: 100,
          width: 160,
          height: textHeight + 2 * padding,
        });
        expect(background.unclippedRect).toEqual(background.rect);
        expect(textElement.rect).toEqual({
          x: 980 + padding,
          y: 100 + padding,
          width: 160 - 2 * padding,
          height: textHeight,
        });
        expect(textElement.unclippedRect).toEqual(textElement.rect);
        expect(textElement.text!.measuredWidth).toBeLessThanOrEqual(textElement.rect.width);
        expect(textElement.rect.y + textElement.rect.height + padding).toBe(
          background.rect.y + background.rect.height,
        );
        expect(textElement.rect.x + textElement.rect.width + padding).toBe(
          background.rect.x + background.rect.width,
        );
        expect(background.text).toBeUndefined();
        expect(textElement.sprite).toBeUndefined();
        expect(preview.fidelity.approximated.map(({ field }) => field)).toContain(
          'tooltip_text_sprite_composition',
        );
        expect(
          preview.fidelity.modelled.some(
            ({ field }) => field === 'tooltip_text_sprite_composition',
          ),
        ).toBe(false);
        const rendered = await renderGuiScene(preview, ['full'], new AbortController().signal);
        expect(
          rendered.images[0]!.svg.includes(
            `<image x="980" y="100" width="160" height="${textHeight + 2 * padding}"`,
          ),
        ).toBe(true);
        expect(
          rendered.images[0]!.svg.includes(
            `<rect x="${980 + padding}" y="${100 + padding}" width="${160 - 2 * padding}" height="${textHeight}"/>`,
          ),
        ).toBe(true);
        const evidence = JSON.parse(rendered.layoutJson) as {
          scene: {
            tooltipPreview: {
              element: { rect: unknown };
              textElement: { rect: unknown; text: string };
            };
          };
        };
        expect(evidence.scene.tooltipPreview.element.rect).toEqual(background.rect);
        expect(evidence.scene.tooltipPreview.textElement).toMatchObject({
          rect: textElement.rect,
          text: 'Close',
        });
      }
    },
  );

  it('validates the opt-in contract and scans linked assets through the studio', async () => {
    expect(() =>
      parsePreviewScenario({
        id: 'invalid',
        tooltip: { target: 'action', x: -1, y: 0, width: 120, padding: 8 },
      }),
    ).toThrow();
    const { files } = await fixture();
    const root = await mkdtemp(path.join(os.tmpdir(), 'hoi4-tooltip-preview-'));
    try {
      const mod = path.join(root, 'mod');
      for (const file of files) {
        const destination = path.join(mod, file.relativePath);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, file.bytes);
      }
      await writeFile(path.join(mod, 'descriptor.mod'), 'name = "Tooltip fixture"');
      const runtime = path.join(root, 'runtime');
      await mkdir(runtime);
      const configuration = serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        storageRoots: [runtime],
        workspaces: [
          {
            id: 'fixture',
            name: 'Fixture',
            root: mod,
            cacheRoot: path.join(runtime, 'cache'),
            artifactRoot: path.join(runtime, 'artifacts'),
          },
        ],
      });
      const studio = new ScriptedGuiStudio(
        new CoreEngine(await WorkspaceResolver.create(configuration)),
      );
      const result = await studio.lint({
        workspaceId: 'fixture',
        windowName: 'tooltip_window',
        scenario: {
          id: 'studio-tooltip',
          resolution: { width: 640, height: 480 },
          tooltip: { target: 'action', x: 130, y: 70, width: 120, padding: 8 },
          values: {
            cost: 42,
            '[!action_click]': 'Effect details',
            '[!action_click_enabled]': 'Available',
          },
        },
      });
      expect(result.scene.tooltipPreview?.element.sprite?.supported).toBe(true);
      expect(result.scene.tooltipPreview?.textElement.text?.metricSource).toBe('bmfont');
      expect(
        result.scene.tooltipPreview?.textElement.text?.inlineIcons?.[0]?.sprite?.supported,
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('loads tooltip sprite, font and localisation icon assets only for opt-in previews', async () => {
    const { graph } = await fixture();
    const ordinary = referencedAssetPatternsForWindow(graph, 'tooltip_window');
    const requested = referencedAssetPatternsForWindow(
      graph,
      'tooltip_window',
      [],
      ['l_english'],
      [],
      true,
    );
    expect(ordinary.some((pattern) => pattern.includes('cg_16b'))).toBe(false);
    expect(requested.some((pattern) => pattern.includes('cg_16b'))).toBe(true);
    expect(requested.some((pattern) => pattern.includes('tooltip.png'))).toBe(true);
  });
  it('uses the selected element key, supplied engine text, sprite, font, inline icon and declared wrapping', async () => {
    const { scene } = await fixture();
    const preview = await scene();
    expect(preview.tooltipPreview).toMatchObject({
      localisationKey: 'ACTION_TT',
      placement: 'caller-declared',
      element: {
        rect: { x: 130, y: 70, width: 120 },
        sprite: { spriteName: 'ToolTip', supported: true },
      },
    });
    expect(preview.tooltipPreview?.textElement.text?.text).toContain('42 Effect details');
    expect(preview.tooltipPreview?.textElement.text?.text).toContain('Available');
    expect(preview.tooltipPreview?.textElement.text?.lines.length).toBeGreaterThan(1);
    expect(preview.tooltipPreview?.textElement.text?.inlineIcons?.[0]?.sprite?.supported).toBe(
      true,
    );
    const { element: background, textElement } = preview.tooltipPreview!;
    expect(background.rect.height).toBe(textElement.text!.measuredHeight + 16);
    expect(textElement.rect).toMatchObject({ x: 138, y: 78, width: 104 });
    expect(textElement.text!.measuredWidth).toBeLessThanOrEqual(textElement.rect.width);
    expect(textElement.rect.y + textElement.rect.height + 8).toBe(
      background.rect.y + background.rect.height,
    );
    expect(preview.fidelity.approximated.map(({ field }) => field)).toContain(
      'immediate_tooltip_preview',
    );
    expect(preview.fidelity.unsupported.map(({ field }) => field)).toEqual(
      expect.arrayContaining(['pdx_tooltip_delayed', 'click_to_front']),
    );
    const rendered = await renderGuiScene(preview, ['full']);
    expect(rendered.images[0]?.svg).toContain('data-inline-icon="pol_power"');
    expect(rendered.images[0]?.svg.includes('gui-font-bitmap-')).toBe(true);
    const scaled = await scene({ uiScale: 1.25 });
    expect(scaled.tooltipPreview?.element.rect).toMatchObject({ x: 130, y: 70, width: 120 });
  });

  it('accepts a visibly disabled target but skips hidden or unresolved visibility', async () => {
    const { scene } = await fixture();
    expect((await scene({ elementStates: { action: 'disabled' } })).tooltipPreview).toBeDefined();
    const hidden = await scene({ visibility: { action: false } });
    expect(hidden.tooltipPreview).toBeUndefined();
    expect(hidden.diagnostics.map(({ code }) => code)).toContain('GUI_TOOLTIP_TARGET_HIDDEN');
    const unresolved = await (await fixture({ unresolvedVisibility: true })).scene();
    expect(unresolved.tooltipPreview).toBeUndefined();
    expect(unresolved.diagnostics.map(({ code }) => code)).toContain(
      'GUI_TOOLTIP_TARGET_UNRESOLVED',
    );
  });

  it('skips missing and ambiguous targets and caller-declared bounds outside the viewport', async () => {
    const { scene } = await fixture();
    const missing = await scene({
      tooltip: { target: 'absent', x: 0, y: 0, width: 120, padding: 8 },
    });
    expect(missing.tooltipPreview).toBeUndefined();
    expect(missing.diagnostics.map(({ code }) => code)).toContain('GUI_TOOLTIP_TARGET_MISSING');
    const ambiguous = await (await fixture({ duplicate: true })).scene();
    expect(ambiguous.tooltipPreview).toBeUndefined();
    expect(ambiguous.diagnostics.map(({ code }) => code)).toContain('GUI_TOOLTIP_TARGET_AMBIGUOUS');
    const bounds = await scene({
      tooltip: { target: 'action', x: 600, y: 70, width: 120, padding: 8 },
    });
    expect(bounds.tooltipPreview).toBeUndefined();
    expect(bounds.diagnostics.map(({ code }) => code)).toContain('GUI_TOOLTIP_BOUNDS');
    const verticalBounds = await scene({
      tooltip: { target: 'action', x: 130, y: 465, width: 120, padding: 8 },
    });
    expect(verticalBounds.tooltipPreview).toBeUndefined();
    expect(verticalBounds.diagnostics.map(({ code }) => code)).toContain('GUI_TOOLTIP_BOUNDS');
  });

  it('checks viewport bounds against measured text plus padding, independently of sprite size', async () => {
    const { scene } = await fixture({ text: 'Close' });
    const atEdge = await scene({
      tooltip: { target: 'action', x: 130, y: 442, width: 160, padding: 10 },
    });
    expect(atEdge.tooltipPreview?.element.rect).toMatchObject({ y: 442, height: 38 });
    const outside = await scene({
      tooltip: { target: 'action', x: 130, y: 443, width: 160, padding: 10 },
    });
    expect(outside.tooltipPreview).toBeUndefined();
    expect(outside.diagnostics.map(({ code }) => code)).toContain('GUI_TOOLTIP_BOUNDS');
    const narrow = await scene({
      tooltip: { target: 'action', x: 130, y: 70, width: 30, padding: 10 },
    });
    expect(narrow.tooltipPreview).toBeUndefined();
    expect(narrow.diagnostics.map(({ code }) => code)).toContain('GUI_TOOLTIP_BOUNDS');
  });

  it('skips missing localisation, sprite, font, icon and unsupplied engine text', async () => {
    for (const [options, code] of [
      [{ missingLocalisation: true }, 'GUI_TOOLTIP_LOCALISATION_MISSING'],
      [{ missingSprite: true }, 'GUI_TOOLTIP_SPRITE_MISSING'],
      [{ missingFont: true }, 'GUI_TOOLTIP_FONT_MISSING'],
      [{ missingIcon: true }, 'GUI_TOOLTIP_ASSET_OR_TEXT_UNRESOLVED'],
    ] as const) {
      const result = await (await fixture(options)).scene();
      expect(result.tooltipPreview === undefined, JSON.stringify(options)).toBe(true);
      expect(result.diagnostics.map(({ code: found }) => found)).toContain(code);
    }
    const unresolved = await (await fixture()).scene({ values: { cost: 42 } });
    expect(unresolved.tooltipPreview).toBeUndefined();
    expect(unresolved.diagnostics.map(({ code }) => code)).toContain('GUI_TOOLTIP_TEXT_UNRESOLVED');
  });
});
