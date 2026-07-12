import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { ScriptedGuiStudio } from '../../src/hoi4_agent_tools/gui/index.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Scripted GUI Studio configured roots and lazy assets', () => {
  it('indexes configured definition roots and loads only selected-window assets', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-gui-custom-roots-'));
    temporaryRoots.push(root);
    await Promise.all(
      [
        'custom_ui',
        'custom_art',
        'custom_logic',
        'custom_loc/english',
        'custom_loc/french',
        'common/scripted_guis',
      ].map((relative) => mkdir(path.join(root, ...relative.split('/')), { recursive: true })),
    );
    await writeFile(
      path.join(root, 'custom_ui', 'window.gui'),
      'guiTypes = { containerWindowType = { name = "custom_window" size = { width = 128 height = 64 } buttonType = { name = "custom_button" size = { width = 64 height = 24 } spriteType = "GFX_custom_used" buttonText = "CUSTOM_BUTTON" } } }\n',
    );
    await writeFile(
      path.join(root, 'custom_art', 'definitions.gfx'),
      'spriteTypes = { spriteType = { name = "GFX_custom_used" texturefile = "custom_art/used.png" } spriteType = { name = "GFX_custom_unused" texturefile = "custom_art/unused.png" } }\n',
    );
    await writeFile(
      path.join(root, 'custom_logic', 'controller.txt'),
      'scripted_gui = { custom_controller = { context_type = country window_name = custom_window effects = { custom_button_click = { } } triggers = { custom_button_click_enabled = { always = yes } } } }\n',
    );
    await writeFile(
      path.join(root, 'common', 'scripted_guis', 'ignored.txt'),
      'scripted_gui = { ignored_controller = { context_type = country window_name = ignored_window } }\n',
    );
    await writeFile(
      path.join(root, 'custom_loc', 'english', 'custom_l_english.yml'),
      '\uFEFFl_english:\nCUSTOM_BUTTON: "Custom"\n',
    );
    await writeFile(
      path.join(root, 'custom_loc', 'french', 'custom_l_french.yml'),
      '\uFEFFl_french:\nCUSTOM_BUTTON: "Personnalisé"\n',
    );
    const used = await sharp({
      create: { width: 16, height: 16, channels: 4, background: '#55d6be' },
    })
      .png()
      .toBuffer();
    const unused = await sharp({
      create: { width: 16, height: 16, channels: 4, background: '#ff3355' },
    })
      .png()
      .toBuffer();
    await Promise.all([
      writeFile(path.join(root, 'custom_art', 'used.png'), used),
      writeFile(path.join(root, 'custom_art', 'unused.png'), unused),
    ]);

    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(path.dirname(root), `${path.basename(root)}-server-state`),
      workspaces: [
        {
          id: 'custom',
          name: 'Custom roots',
          root,
          roots: {
            interface: ['custom_ui'],
            gfx: ['custom_art'],
            scriptedGui: ['custom_logic'],
            localisation: ['custom_loc'],
          },
        },
      ],
    });
    const resolver = await WorkspaceResolver.create(configuration);
    const engine = new CoreEngine(resolver);
    const studio = new ScriptedGuiStudio(
      resolver,
      engine.transactions,
      engine.scanner,
      engine.artifacts,
    );
    const scanned = await studio.scan('custom');
    expect(scanned.graph.elements.some(({ name }) => name === 'custom_window')).toBe(true);
    expect(scanned.graph.scriptedGuis.some(({ name }) => name === 'custom_controller')).toBe(true);
    expect(scanned.graph.scriptedGuis.some(({ name }) => name === 'ignored_controller')).toBe(
      false,
    );
    expect(scanned.files.some(({ relativePath }) => relativePath.endsWith('.png'))).toBe(false);
    expect(scanned.files.some(({ relativePath }) => relativePath.includes('/french/'))).toBe(false);

    const linted = await studio.lint({
      workspaceId: 'custom',
      windowName: 'custom_window',
      scenario: { id: 'custom', resolution: { width: 320, height: 200 } },
    });
    expect(linted.graph.filesScanned.some((file) => file.endsWith('custom_art/used.png'))).toBe(
      true,
    );
    expect(linted.graph.filesScanned.some((file) => file.endsWith('custom_art/unused.png'))).toBe(
      false,
    );
    expect(
      linted.scene.elements.find(({ name }) => name === 'custom_button')?.sprite?.supported,
    ).toBe(true);

    const french = await studio.lint({
      workspaceId: 'custom',
      windowName: 'custom_window',
      scenario: {
        id: 'custom-french',
        language: 'l_french',
        resolution: { width: 320, height: 200 },
      },
    });
    expect(french.graph.filesScanned.some((file) => file.includes('/french/'))).toBe(true);
    expect(french.scene.elements.find(({ name }) => name === 'custom_button')?.text?.text).toBe(
      'Personnalisé',
    );
  });
});
