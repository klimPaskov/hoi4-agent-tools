import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

async function workspace(files: { mod?: Record<string, string>; game?: Record<string, string> }) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-gui-false-unresolved-'));
  temporaryRoots.push(root);
  const modRoot = path.join(root, 'mod'),
    gameRoot = path.join(root, 'game');
  for (const [base, entries] of [
    [modRoot, files.mod ?? {}],
    [gameRoot, files.game ?? {}],
  ] as const) {
    await mkdir(path.join(base, 'interface'), { recursive: true });
    for (const [relative, content] of Object.entries(entries)) {
      await mkdir(path.dirname(path.join(base, relative)), { recursive: true });
      await writeFile(path.join(base, relative), content);
    }
  }
  const engine = new CoreEngine(
    await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        workspaceStorageRoot: path.join(root, 'storage'),
        workspaces: [{ id: 'unresolved', name: 'Unresolved', root: modRoot, gameRoot }],
      }),
    ),
  );
  return new ScriptedGuiStudio(engine);
}

const unresolvedCodes = new Set([
  'GUI_MISSING_SPRITE',
  'GUI_SPRITE_MISSING',
  'GUI_REFERENCE_UNRESOLVED',
  'GUI_REFERENCE_UNRESOLVED_PARTIAL',
  'GUI_MISSING_LOCALISATION',
]);

async function unresolvedMessages(studio: ScriptedGuiStudio, windowName: string) {
  const { validation, scene } = await studio.lint({
    workspaceId: 'unresolved',
    windowName,
    scenario: { id: 'unresolved' },
    generatedScenarios: { enabled: false },
  });
  return [...validation.diagnostics, ...scene.diagnostics]
    .filter(({ code }) => unresolvedCodes.has(code))
    .map(({ code, message }) => `${code}: ${message}`);
}

const icon = (name: string, sprite: string) =>
  `iconType = { name = "${name}" spriteType = "${sprite}" position = { x = 0 y = 0 } }`;

describe('GUI references the game resolves', () => {
  it('resolves the sprites of a sibling window from the game .gfx and a large mod .gfx', async () => {
    // A large generated .gfx: the sprite the sibling window uses is defined on its last lines.
    const manySprites = Array.from(
      { length: 1_200 },
      (_, index) =>
        `  spriteType = { name = "GFX_fixture_tile_${index}" texturefile = "gfx/interface/fixture_tile.dds" }`,
    );
    const studio = await workspace({
      game: {
        'interface/eventlike.gfx': `spriteTypes = {
          spriteType = { name = "GFX_fixture_minimize" texturefile = "gfx/interface/fixture_minimize.dds" }
          spriteType = { name = "GFX_fixture_clip" texturefile = "gfx/interface/fixture_clip.dds" }
        }`,
      },
      mod: {
        'interface/fixture_large.gfx': `# generated\nspriteTypes = {\n${manySprites.join('\n')}\n  spriteType = { name = "GFX_fixture_blank" texturefile = "gfx/interface/fixture_blank.dds" }\n}\n`,
        'interface/fixture_own.gfx': `spriteTypes = {
          spriteType = { name = "GFX_fixture_own" texturefile = "gfx/interface/fixture_own.dds" }
        }`,
        // The mod overrides a game file that holds several windows; only the first is inspected.
        'interface/eventlike.gui': `guiTypes = {
          containerWindowType = { name = "first_window" size = { width = 120 height = 80 }
            ${icon('own', 'GFX_fixture_own')} }
          containerWindowType = { name = "second_window" size = { width = 120 height = 80 }
            ${icon('minimize', 'GFX_fixture_minimize')}
            ${icon('clip', 'GFX_fixture_clip')}
            ${icon('blank', 'GFX_fixture_blank')}
            ${icon('lost', 'GFX_fixture_sibling_never_defined')}
            instantTextBoxType = { name = "title" position = { x = 0 y = 0 } font = "hoi_20b" text = "Title text here!" maxWidth = 100 maxHeight = 20 }
            instantTextBoxType = { name = "missing" position = { x = 0 y = 30 } font = "hoi_20b" text = "FIXTURE_SIBLING_MISSING_KEY" maxWidth = 100 maxHeight = 20 }
          }
        }`,
      },
    });
    const messages = await unresolvedMessages(studio, 'first_window');
    for (const resolved of [
      'GFX_fixture_own',
      'GFX_fixture_minimize',
      'GFX_fixture_clip',
      'GFX_fixture_blank',
      'Title text here!',
    ])
      expect(messages.filter((message) => message.includes(resolved))).toEqual([]);
    // Negative: what no source defines is still reported.
    expect(
      messages.filter((message) => message.includes('GFX_fixture_sibling_never_defined')).length,
    ).toBeGreaterThan(0);
    expect(
      messages.filter((message) => message.includes('FIXTURE_SIBLING_MISSING_KEY')).length,
    ).toBeGreaterThan(0);
  });

  it('resolves a sprite from the game .gfx under a mod .gui that overrides the game window', async () => {
    const studio = await workspace({
      game: {
        'interface/clipwindow.gfx': `spriteTypes = {
          spriteType = { name = "GFX_fixture_clip" texturefile = "gfx/interface/fixture_clip.dds" }
        }`,
        'interface/clipwindow.gui': `guiTypes = { containerWindowType = { name = "clip_window" size = { width = 100 height = 80 }
          ${icon('clip', 'GFX_fixture_clip')} } }`,
      },
      mod: {
        'interface/clipwindow.gui': `guiTypes = { containerWindowType = { name = "clip_window" size = { width = 120 height = 80 }
          ${icon('clip', 'GFX_fixture_clip')}
          ${icon('lost', 'GFX_fixture_never_defined')} } }`,
      },
    });
    const messages = await unresolvedMessages(studio, 'clip_window');
    expect(messages.filter((message) => message.includes('GFX_fixture_clip'))).toEqual([]);
    // Negative: a sprite no .gfx defines is still reported.
    expect(
      messages.filter((message) => message.includes('GFX_fixture_never_defined')).length,
    ).toBeGreaterThan(0);
  });
});
