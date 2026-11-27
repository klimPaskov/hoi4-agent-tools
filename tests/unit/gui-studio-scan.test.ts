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
  it('loads a public game scrollbar even when the mod contains a private namesake', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-gui-scroll-scope-'));
    temporaryRoots.push(root);
    const modRoot = path.join(root, 'mod'),
      gameRoot = path.join(root, 'game');
    for (const base of [modRoot, gameRoot])
      await mkdir(path.join(base, 'interface'), { recursive: true });
    await writeFile(
      path.join(modRoot, 'interface/window.gui'),
      `guiTypes = {
      containerWindowType = { name = "requested" size = { width = 100 height = 80 } verticalScrollbar = "public_bar"
        containerWindowType = { name = "content" size = { width = 60 height = 160 } }
      }
      containerWindowType = { name = "unrelated" iconType = { name = "public_bar" size = { width = 2 height = 2 } } }
    }`,
    );
    await writeFile(
      path.join(gameRoot, 'interface/core.gui'),
      `guiTypes = {
      extendedScrollbarType = { name = "public_bar" size = { width = 10 height = 10 } orientation = upper_right origo = upper_right
        slider = { name = "thumb" size = { width = 8 height = 8 } }
        decreaseButton = { name = "up" size = { width = 8 height = 8 } }
        increaseButton = { name = "down" size = { width = 8 height = 8 } }
      }
    }`,
    );
    const engine = new CoreEngine(
      await WorkspaceResolver.create(
        serverConfigurationSchema.parse({
          version: 1,
          serverStateRoot: path.join(root, 'state'),
          workspaceStorageRoot: path.join(root, 'storage'),
          workspaces: [{ id: 'scoped', name: 'Scoped templates', root: modRoot, gameRoot }],
        }),
      ),
    );
    const { graph, scene } = await new ScriptedGuiStudio(engine).lint({
      workspaceId: 'scoped',
      windowName: 'requested',
      scenario: { id: 'scoped' },
      generatedScenarios: { enabled: false },
    });
    expect(graph.filesScanned).toContain('game:interface/core.gui');
    expect(scene.diagnostics.some(({ code }) => code === 'GUI_SCROLLBAR_TEMPLATE_MISSING')).toBe(
      false,
    );
    expect(scene.elements.find(({ name }) => name === 'public_bar')).toMatchObject({
      elementType: 'extendedScrollbarType',
      visible: true,
    });
  });

  it("draws the mod's localisation/replace text over the game's", async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-gui-loc-replace-'));
    temporaryRoots.push(root);
    const modRoot = path.join(root, 'mod'),
      gameRoot = path.join(root, 'game');
    const write = async (base: string, relative: string, content: string) => {
      await mkdir(path.dirname(path.join(base, relative)), { recursive: true });
      await writeFile(path.join(base, relative), content);
    };
    await write(
      modRoot,
      'interface/tabs.gui',
      `guiTypes = { containerWindowType = { name = "tabs" size = { width = 300 height = 120 }
        instantTextBoxType = { name = "trade" position = { x = 0 y = 0 } text = "TRADE" maxWidth = 200 maxHeight = 20 }
        instantTextBoxType = { name = "politics" position = { x = 0 y = 30 } text = "POLITICS" maxWidth = 200 maxHeight = 20 }
        instantTextBoxType = { name = "production" position = { x = 0 y = 60 } text = "PRODUCTION" maxWidth = 200 maxHeight = 20 }
        instantTextBoxType = { name = "army" position = { x = 0 y = 90 } text = "ARMY" maxWidth = 200 maxHeight = 20 }
      } }`,
    );
    await write(
      gameRoot,
      'localisation/english/core_l_english.yml',
      '﻿l_english:\n TRADE:0 "Trade"\n POLITICS:0 "Political"\n PRODUCTION:0 "Production"\n ARMY:0 "Army"\n',
    );
    // The mod's own ordinary file repeats one key; its replace folders win over it.
    await write(
      modRoot,
      'localisation/english/mod_l_english.yml',
      '﻿l_english:\n PRODUCTION:0 "Workshops (ordinary file)"\n',
    );
    await write(
      modRoot,
      'localisation/replace/tabs_l_english.yml',
      '﻿l_english:\n TRADE:0 "Commerce"\n POLITICS:0 "Court"\n',
    );
    await write(
      modRoot,
      'localisation/english/replace/tabs_l_english.yml',
      '﻿l_english:\n PRODUCTION:0 "Workshops"\n',
    );
    const engine = new CoreEngine(
      await WorkspaceResolver.create(
        serverConfigurationSchema.parse({
          version: 1,
          serverStateRoot: path.join(root, 'state'),
          workspaceStorageRoot: path.join(root, 'storage'),
          workspaces: [{ id: 'replace', name: 'Replace', root: modRoot, gameRoot }],
        }),
      ),
    );
    const { graph, scene } = await new ScriptedGuiStudio(engine).lint({
      workspaceId: 'replace',
      windowName: 'tabs',
      scenario: { id: 'replace' },
      generatedScenarios: { enabled: false },
    });
    expect(graph.filesScanned).toContain('mod:localisation/replace/tabs_l_english.yml');
    const text = (name: string) =>
      scene.elements.find((element) => element.name === name)?.text?.text;
    expect(text('trade')).toBe('Commerce');
    expect(text('politics')).toBe('Court');
    expect(text('production')).toBe('Workshops');
    expect(text('army')).toBe('Army');
  });

  it("reads only the preview language's replace files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-gui-loc-replace-languages-'));
    temporaryRoots.push(root);
    const modRoot = path.join(root, 'mod');
    const write = async (relative: string, content: string) => {
      await mkdir(path.dirname(path.join(modRoot, relative)), { recursive: true });
      await writeFile(path.join(modRoot, relative), content);
    };
    await write(
      'interface/tabs.gui',
      `guiTypes = { containerWindowType = { name = "tabs" size = { width = 300 height = 40 }
        instantTextBoxType = { name = "trade" position = { x = 0 y = 0 } text = "TRADE" maxWidth = 200 maxHeight = 20 }
      } }`,
    );
    await write('localisation/replace/tabs_l_english.yml', '﻿l_english:\n TRADE:0 "Commerce"\n');
    // Nine other languages, together over the 500,000-candidate ceiling, in both replace layouts.
    const languages = [
      'braz_por',
      'french',
      'german',
      'japanese',
      'korean',
      'polish',
      'russian',
      'simp_chinese',
      'spanish',
    ];
    const entries = 60_000;
    for (const [index, language] of languages.entries()) {
      const lines = [
        String.fromCharCode(0xfeff) + `l_${language}:`,
        ` TRADE:0 "Trade ${language}"`,
      ];
      for (let key = 0; key < entries; key += 1) lines.push(` K${key}:0 "v"`);
      await write(
        index % 2 === 0
          ? `localisation/replace/${language}/big_l_${language}.yml`
          : `localisation/replace/big_l_${language}.yml`,
        `${lines.join('\n')}\n`,
      );
    }
    const engine = new CoreEngine(
      await WorkspaceResolver.create(
        serverConfigurationSchema.parse({
          version: 1,
          serverStateRoot: path.join(root, 'state'),
          workspaceStorageRoot: path.join(root, 'storage'),
          workspaces: [{ id: 'languages', name: 'Languages', root: modRoot }],
        }),
      ),
    );
    const { graph, scene } = await new ScriptedGuiStudio(engine).lint({
      workspaceId: 'languages',
      windowName: 'tabs',
      scenario: { id: 'languages' },
      generatedScenarios: { enabled: false },
    });
    expect(graph.filesScanned).toContain('mod:localisation/replace/tabs_l_english.yml');
    expect(graph.filesScanned.filter((file) => file.includes('big_l_'))).toEqual([]);
    expect(scene.elements.find((element) => element.name === 'trade')?.text?.text).toBe('Commerce');
  }, 60_000);

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
      'guiTypes = { containerWindowType = { name = "custom_window" size = { width = 128 height = 96 } buttonType = { name = "custom_button" size = { width = 64 height = 24 } spriteType = "GFX_custom_used" buttonText = "CUSTOM_BUTTON" } gridBoxType = { name = "custom_list" position = { x = 0 y = 48 } size = { width = 64 height = 32 } slotsize = { width = 64 height = 16 } } } containerWindowType = { name = "custom_child_window" position = { x = 64 y = 24 } size = { width = 32 height = 32 } iconType = { name = "custom_child_icon" spriteType = "GFX_custom_child" } } containerWindowType = { name = "custom_entry" size = { width = 64 height = 16 } iconType = { name = "custom_entry_icon" spriteType = "GFX_custom_entry" } } }\n',
    );
    await writeFile(
      path.join(root, 'custom_art', 'definitions.gfx'),
      'spriteTypes = { spriteType = { name = "GFX_custom_used" texturefile = "custom_art/used.png" } spriteType = { name = "GFX_custom_child" texturefile = "custom_art/child.tga" } spriteType = { name = "GFX_custom_entry" texturefile = "custom_art/entry.png" } spriteType = { name = "GFX_custom_unused" texturefile = "custom_art/unused.png" } }\n',
    );
    await writeFile(
      path.join(root, 'custom_logic', 'controller.txt'),
      'scripted_gui = { custom_controller = { context_type = player_context window_name = custom_window effects = { custom_button_click = { } } triggers = { custom_button_click_enabled = { always = yes } } dynamic_lists = { custom_list = { entry_container = "custom_entry" } } } custom_child_controller = { context_type = player_context parent_scripted_gui = custom_controller window_name = custom_child_window visible = { always = yes } } }\n',
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
      writeFile(path.join(root, 'custom_art', 'child.png'), used),
      writeFile(path.join(root, 'custom_art', 'entry.png'), used),
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
      scenario: {
        id: 'custom',
        resolution: { width: 320, height: 200 },
        scriptedGui: { 'custom_child_controller.visible': true },
        lists: { custom_list: [{ id: 1 }] },
      },
    });
    expect(linted.graph.filesScanned.some((file) => file.endsWith('custom_art/used.png'))).toBe(
      true,
    );
    expect(linted.graph.filesScanned.some((file) => file.endsWith('custom_art/unused.png'))).toBe(
      false,
    );
    expect(linted.graph.filesScanned.some((file) => file.endsWith('custom_art/child.png'))).toBe(
      true,
    );
    expect(linted.graph.filesScanned.some((file) => file.endsWith('custom_art/entry.png'))).toBe(
      true,
    );
    expect(
      linted.scene.elements.find(({ name }) => name === 'custom_button')?.sprite?.supported,
    ).toBe(true);
    expect(
      linted.scene.elements.find(({ name }) => name === 'custom_child_icon')?.sprite?.supported,
    ).toBe(true);
    expect(
      linted.scene.elements.find(({ name }) => name === 'custom_entry_icon')?.sprite?.supported,
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
