import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { ScriptedGuiStudio, renderGuiScene } from '../../src/hoi4_agent_tools/gui/index.js';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import {
  compileGuiProgressEffect,
  compileGuiShaderEffect,
} from '../../src/hoi4_agent_tools/gui/shader.js';

// All game files are read from an explicitly opted-in installation. No proprietary fixtures are distributed.
const gameRoot = process.env.HOI4_GAME_ROOT;
const outputRoot = process.env.HOI4_GUI_FIDELITY_OUTPUT;
const local = gameRoot === undefined ? describe.skip : describe;

local('installed native GUI fidelity', () => {
  it('anchors the native percentage-height war window inside the declared viewport', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-native-war-'));
    try {
      const modRoot = path.join(temporary, 'empty-mod');
      await mkdir(modRoot);
      const configuration = serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(temporary, 'state'),
        workspaces: [{ id: 'native-war', name: 'Native war geometry', root: modRoot, gameRoot }],
      });
      const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
      const studio = new ScriptedGuiStudio(engine);
      const { scene } = await studio.lint({
        workspaceId: 'native-war',
        windowName: 'waroverview_window',
        scenario: {
          id: 'native-war-overview',
          resolution: { width: 2560, height: 1440 },
          uiScale: 1,
          values: {
            'header_desc.text': 'Italian War on Ethiopia',
            'warscore_progressbar.progress': 0.5,
            'attacker_fielded_man.text': 'Fielded Manpower: §Y146K - 370K§!',
            'defender_fielded_man.text': 'Fielded Manpower: §Y73.0K - 139K§!',
            'attacker_losses.text': 'Losses: §Y0§!',
            'defender_losses.text': 'Losses: §Y0§!',
            'filter_minors.frame': 2,
            'filter_capitulated.frame': 2,
            'filter_callable.frame': 2,
          },
          visibility: { warscore_progressbar_disabled: false },
          elementStates: { attacker_window: 'maximum-value', defender_window: 'maximum-value' },
          lists: {
            attacker_grid: [
              {
                entryContainer: 'war_ally_entry',
                'country_name.text': 'Italy',
                'country_flag.countryTag': 'ITA',
                'country_flag.ideology': 'fascism',
                'warscore.text': '0%',
                'divisions.text': '18 - 68',
                'ic.text': '44 - 67',
                'casualties.text': '0',
                'surrender_progressbar.progress': 0,
                'call.visible': false,
                'major_country_overlay.visible': false,
                'surrender_flag.visible': false,
              },
            ],
            defender_grid: [
              {
                entryContainer: 'war_ally_entry',
                'country_name.text': 'Ethiopia',
                'country_flag.countryTag': 'ETH',
                'country_flag.ideology': 'neutrality',
                'warscore.text': '0%',
                'divisions.text': '6 - 36',
                'ic.text': '4',
                'casualties.text': '0',
                'surrender_progressbar.progress': 0,
                'call.visible': false,
                'wargoal.visible': false,
                'major_country_overlay.visible': false,
                'surrender_flag.visible': false,
              },
            ],
          },
        },
        generatedScenarios: { enabled: false },
      });
      if (outputRoot !== undefined) {
        await mkdir(outputRoot, { recursive: true });
        const rendered = await renderGuiScene(scene, ['full', 'cropped']);
        for (const output of rendered.images)
          await writeFile(
            path.join(outputRoot, `native-war-overview-${output.variant}.png`),
            output.png,
          );
        await writeFile(
          path.join(outputRoot, 'native-war-overview.json'),
          JSON.stringify(
            {
              bounds: scene.bounds,
              fidelity: scene.fidelity,
              diagnostics: scene.diagnostics,
              elements: scene.elements.map(({ sprite, secondarySprite, text, ...element }) => ({
                ...element,
                sprite:
                  sprite === undefined
                    ? undefined
                    : {
                        name: sprite.spriteName,
                        width: sprite.width,
                        height: sprite.height,
                        supported: sprite.supported,
                      },
                secondarySprite: secondarySprite?.spriteName,
                text: text?.text,
              })),
            },
            null,
            2,
          ),
        );
      }
      const root = scene.elements.find(({ name }) => name === 'waroverview_window')!.unclippedRect;
      expect(root).toEqual({ x: 697, y: 423, width: 1167, height: 801 });
      const panels = scene.elements.filter(
        ({ name, elementType }) =>
          ['attacker_window', 'defender_window'].includes(name) &&
          elementType.toLowerCase() === 'containerwindowtype',
      );
      expect(panels).toHaveLength(2);
      expect(
        scene.elements
          .filter(({ name }) => name === 'country_flag')
          .map(({ sprite }) => [sprite?.spriteName, sprite?.supported]),
      ).toEqual([
        ['GFX_flag_ITA', true],
        ['GFX_flag_ETH', true],
      ]);
      expect(
        scene.elements.filter(({ name, visible }) => name === 'war_ally_entry' && visible),
      ).toHaveLength(2);
      expect(
        scene.elements.find(({ name }) => name === 'warscore_progressbar')?.progressShader,
      ).toMatchObject({
        effect: 'Texture',
        entryPoint: 'PixelTexture',
        composition: 'threshold',
      });
      const progressSource = await readFile(path.join(gameRoot!, 'gfx/FX/progress.shader'), 'utf8');
      for (const effect of ['Color', 'Texture'] as const)
        expect(
          compileGuiProgressEffect(
            progressSource,
            {
              path: 'game:gfx/FX/progress.shader',
              sha256: sha256Bytes(Buffer.from(progressSource)),
            },
            effect,
          ),
        ).toMatchObject({ supported: true });
      for (const panel of panels) {
        expect(panel.unclippedRect.y).toBe(615);
        expect(panel.unclippedRect.height).toBeCloseTo(576.96);
        expect(panel.unclippedRect.y + panel.unclippedRect.height).toBeCloseTo(1191.96);
      }
      studio.clearCaches();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 240_000);

  it('compiles installed native button colour branches from their actual source', async () => {
    for (const name of ['buttonstate', 'buttonstate_nodowneffect']) {
      const shaderPath = path.join(gameRoot!, 'gfx/FX', `${name}.shader`);
      const bytes = await readFile(shaderPath);
      for (const effect of ['Up', 'Over', 'Down', 'Disable'] as const) {
        const result = compileGuiShaderEffect(
          bytes.toString('utf8'),
          { path: shaderPath, sha256: sha256Bytes(bytes) },
          effect,
          { time: 1, animationTime: 0 },
        );
        expect(result, `${name} ${effect}`).toMatchObject({ supported: true });
        if (!result.supported) throw new Error(result.reason);
        if (effect === 'Disable')
          expect(result.shader.colourMatrix.slice(0, 5)).toEqual([
            0.212671, 0.71516, 0.072169, 0, 0,
          ]);
      }
    }
  });

  it('renders the native focus-inlay geometry without modifying or rescaling installed source', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-native-gui-'));
    try {
      const modRoot = path.join(temporary, 'empty-mod');
      await mkdir(modRoot);
      const configuration = serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(temporary, 'state'),
        storageRoots: [path.join(temporary, 'artifacts'), path.join(temporary, 'cache')],
        workspaces: [
          {
            id: 'native',
            name: 'Native GUI fidelity',
            root: modRoot,
            gameRoot,
            artifactRoot: path.join(temporary, 'artifacts'),
            cacheRoot: path.join(temporary, 'cache'),
          },
        ],
      });
      const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
      const studio = new ScriptedGuiStudio(engine);
      const { scene } = await studio.lint({
        workspaceId: 'native',
        windowName: 'cze_industry_focus_ui_window',
        scenario: {
          id: 'native-focus-inlay',
          resolution: { width: 2560, height: 1440 },
          uiScale: 1,
          country: { tag: 'CZE' },
          values: {
            'cze_industry_focus_ui_window.x': 16,
            'cze_industry_focus_ui_window.y': -1424,
            skoda_focus_var: 0,
            skoda_optimization_tier: 2,
          },
          flags: { CZE_unlock_skoda_naval_focus: false, CZE_skoda_focus_activation: true },
          visibility: { cze_industry_focus_inlay_window: true },
        },
        generatedScenarios: { enabled: false },
      });
      expect(
        scene.elements.find(({ elementType }) => elementType === 'background')!.unclippedRect,
      ).toEqual({ x: 16, y: 16, width: 552, height: 516 });
      expect(scene.bounds).toEqual({ x: 16, y: 16, width: 552, height: 516 });
      expect(
        scene.elements.find(({ name }) => name === 'CZE_skoda_infantry_focus_image_selected')!
          .visible,
      ).toBe(false);
      expect(
        scene.elements.find(({ name }) => name === 'CZE_skoda_no_focus_image_selected')!.visible,
      ).toBe(true);
      expect(
        scene.elements.find(({ name }) => name === 'CZE_skoda_optimization_tier')!.text!.text,
      ).toBe('2');
      const rendered = await renderGuiScene(scene, ['cropped']);
      if (outputRoot !== undefined) {
        await mkdir(outputRoot, { recursive: true });
        await writeFile(path.join(outputRoot, 'native-focus-inlay.png'), rendered.images[0]!.png);
        await writeFile(
          path.join(outputRoot, 'native-focus-inlay.json'),
          JSON.stringify(
            {
              bounds: scene.bounds,
              fidelity: scene.fidelity,
              diagnostics: scene.diagnostics,
              elements: scene.elements.map(({ sprite, text, ...element }) => ({
                ...element,
                ...(sprite === undefined
                  ? {}
                  : {
                      sprite: {
                        name: sprite.spriteName,
                        width: sprite.width,
                        height: sprite.height,
                        frame: sprite.frame,
                      },
                    }),
                ...(text === undefined
                  ? {}
                  : {
                      text: {
                        text: text.text,
                        lines: text.lines,
                        fontSize: text.fontSize,
                        lineHeight: text.lineHeight,
                        horizontalAlignment: text.horizontalAlignment,
                        verticalAlignment: text.verticalAlignment,
                      },
                    }),
              })),
            },
            null,
            2,
          ),
        );
      }
      const video = await studio.lint({
        workspaceId: 'native',
        windowName: 'menu_settings_ingame',
        scenario: {
          id: 'native-video-settings',
          resolution: { width: 2560, height: 1440 },
          uiScale: 1,
          values: {
            'menu_settings_ingame.x': -1264,
            'menu_settings_ingame.y': -704,
            'mode_value.text': 'Windowed',
            'resolution_value.text': '2560x1440',
            'refreshrate_value.text': 'Desktop',
            'multisample_value.text': '8',
            'tex_quality_value.text': 'High',
            'ui_scaling_value.text': '1.0x',
            gamma_slider: 50,
          },
          visibility: {
            menu_settings_AUDIO: false,
            menu_settings_CONTROLS: false,
            menu_settings_GAME: false,
            menu_settings_VIDEO: true,
          },
          elementStates: Object.fromEntries([
            ...[
              'shadows',
              'trees',
              'vsync',
              'weather',
              'water_refl',
              'cities',
              'units',
              'buildings',
              'rivers',
              'hq_shaders',
              'full_map_res',
            ].map((name) => [`${name}_checkbox`, 'selected']),
            ...[
              'decrease_refreshrate_button',
              'increase_refreshrate_button',
              'landslider_upButton',
              'landslider_downButton',
            ].map((name) => [name, 'disabled']),
          ]),
        },
        generatedScenarios: { enabled: false },
      });
      const gamma = video.scene.elements.find(({ name }) => name === 'gamma_slider')!;
      const roles = video.scene.elements.filter(({ parentId }) => parentId === gamma.id);
      if (outputRoot !== undefined) {
        const videoRender = await renderGuiScene(video.scene, ['cropped']);
        await writeFile(
          path.join(outputRoot, 'native-video-settings.png'),
          videoRender.images[0]!.png,
        );
        await writeFile(
          path.join(outputRoot, 'native-video-settings-controls.json'),
          JSON.stringify(
            {
              gamma: gamma.unclippedRect,
              roles: roles.map(({ name, unclippedRect, sprite }) => ({
                name,
                unclippedRect,
                nativeSize: sprite === undefined ? undefined : [sprite.width, sprite.height],
              })),
            },
            null,
            2,
          ),
        );
      }
      for (const name of [
        'decrease_refreshrate_button',
        'increase_refreshrate_button',
        'landslider_upButton',
        'landslider_downButton',
      ]) {
        // Hidden settings tabs reuse these native control names.
        expect(
          video.scene.elements.find((element) => element.name === name && element.visible),
          name,
        ).toMatchObject({
          state: 'disabled',
          clickable: false,
          spriteShader: { effect: 'Disable' },
        });
      }
      expect(
        roles.every(
          ({ unclippedRect }) =>
            unclippedRect.y + unclippedRect.height / 2 ===
            gamma.unclippedRect.y + gamma.unclippedRect.height / 2,
        ),
      ).toBe(true);
      expect(
        roles.find(({ name }) => name === 'landslider_downButton')!.unclippedRect.x,
      ).toBeGreaterThan(gamma.unclippedRect.x + 100);
      studio.clearCaches();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 240_000);

  it('composes installed container scrollbar templates at both content endpoints', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-native-scrollbars-'));
    try {
      const modRoot = path.join(temporary, 'synthetic-mod');
      await mkdir(path.join(modRoot, 'interface'), { recursive: true });
      // Project-owned layout only. Native templates, textures and shaders are read from gameRoot.
      const sourcePath = path.join(modRoot, 'interface/native_scroll_regression.gui');
      const source = Buffer.from(`guiTypes = {
        containerWindowType = { name = "native_scroll_regression" position = { x = 16 y = 16 } size = { width = 400 height = 400 }
          background = { name = "panel" spriteType = "GFX_tiled_plain_bg" }
          containerWindowType = { name = "viewport" position = { x = 20 y = 20 } size = { width = 340 height = 320 }
            background = { name = "content_panel" spriteType = "GFX_tiled_window_transparent" }
            margin = { left = 5 right = 5 top = 5 bottom = 5 }
            verticalScrollbar = "right_vertical_slider" horizontalScrollbar = "bottom_horizontal_slider"
            containerWindowType = { name = "content_extent" size = { width = 600 height = 600 } }
          }
        }
      }`);
      await writeFile(sourcePath, source);
      const configuration = serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(temporary, 'state'),
        storageRoots: [path.join(temporary, 'artifacts'), path.join(temporary, 'cache')],
        workspaces: [
          {
            id: 'native-scrollbars',
            name: 'Native scrollbar qualification',
            root: modRoot,
            gameRoot,
            artifactRoot: path.join(temporary, 'artifacts'),
            cacheRoot: path.join(temporary, 'cache'),
          },
        ],
      });
      const studio = new ScriptedGuiStudio(
        new CoreEngine(await WorkspaceResolver.create(configuration)),
      );
      for (const state of ['minimum-value', 'maximum-value']) {
        const { scene } = await studio.lint({
          workspaceId: 'native-scrollbars',
          windowName: 'native_scroll_regression',
          scenario: {
            id: `native-container-scroll-${state}`,
            resolution: { width: 2560, height: 1440 },
            uiScale: 1,
            state,
          },
          generatedScenarios: { enabled: false },
        });
        const owner = scene.elements.find(({ name }) => name === 'viewport')!;
        expect(owner.scroll).toMatchObject({
          maximumX: 265,
          maximumY: 285,
          offsetX: state === 'minimum-value' ? 0 : 265,
          offsetY: state === 'minimum-value' ? 0 : 285,
        });
        const vertical = scene.elements.find(({ name }) => name === 'right_vertical_slider')!;
        const horizontal = scene.elements.find(({ name }) => name === 'bottom_horizontal_slider')!;
        expect(vertical.unclippedRect).toEqual({ x: 353, y: 36, width: 18, height: 296 });
        expect(horizontal.unclippedRect).toEqual({ x: 36, y: 332, width: 317, height: 18 });
        for (const bar of [vertical, horizontal]) {
          const parts = scene.elements.filter(({ parentId }) => parentId === bar.id);
          expect(parts.map(({ name }) => name)).toEqual([
            'Background',
            'Track',
            'Slider',
            'Decrease',
            'Increase',
          ]);
          expect(parts.every(({ visible, sprite }) => visible && sprite?.supported === true)).toBe(
            true,
          );
          expect(parts.find(({ name }) => name === 'Slider')).toMatchObject({
            sprite: { width: 16, height: 16 },
            spriteShader: {
              effect: 'Up',
              textureFiltering: { magnification: 'nearest', minification: 'nearest' },
            },
          });
        }
        if (outputRoot !== undefined) {
          await mkdir(outputRoot, { recursive: true });
          const rendered = await renderGuiScene(scene, ['cropped']);
          await writeFile(
            path.join(outputRoot, `${scene.scenario.id}.png`),
            rendered.images[0]!.png,
          );
          await writeFile(
            path.join(outputRoot, `${scene.scenario.id}.json`),
            JSON.stringify(
              {
                sourceHash: sha256Bytes(source),
                scroll: owner.scroll,
                fidelity: scene.fidelity,
                diagnostics: scene.diagnostics,
                elements: scene.elements.map(({ sprite, text, ...element }) => ({
                  ...element,
                  ...(sprite === undefined
                    ? {}
                    : {
                        sprite: {
                          name: sprite.spriteName,
                          width: sprite.width,
                          height: sprite.height,
                        },
                      }),
                  ...(text === undefined ? {} : { text: text.text }),
                })),
              },
              null,
              2,
            ),
          );
        }
      }
      expect(await readFile(sourcePath)).toEqual(source);
      studio.clearCaches();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 240_000);
});
