import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { ScriptedGuiStudio } from '../../src/hoi4_agent_tools/gui/studio.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

async function write(file: string, content: string | Buffer) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

describe('GUI asset basename fallback', () => {
  it('searches hundreds of unresolved textures within the wildcard ceiling and still finds moved files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hoi4-gui-fallback-'));
    roots.push(root);
    const mod = path.join(root, 'mod');
    const count = 600;
    const icons = Array.from(
      { length: count },
      (_, index) =>
        `iconType = { name = "icon_${index}" spriteType = "GFX_many_${index}" position = { x = ${index % 40} y = ${Math.floor(index / 40)} } }`,
    ).join('\n');
    await write(
      path.join(mod, 'interface', 'many.gui'),
      `guiTypes = { containerWindowType = { name = "many_window" size = { width = 640 height = 480 }\n${icons}\n} }\n`,
    );
    // Sprite 0 points at a folder that does not exist; its texture lives elsewhere.
    const sprites = Array.from({ length: count }, (_, index) =>
      index === 0
        ? 'spriteType = { name = "GFX_many_0" texturefile = "gfx/interface/moved/found_texture.png" }'
        : `spriteType = { name = "GFX_many_${index}" texturefile = "gfx/interface/missing/many_${index}.dds" }`,
    ).join('\n');
    await write(path.join(mod, 'interface', 'many.gfx'), `spriteTypes = {\n${sprites}\n}\n`);
    await write(
      path.join(mod, 'gfx', 'elsewhere', 'found_texture.png'),
      await sharp({
        create: {
          width: 8,
          height: 8,
          channels: 4,
          background: { r: 200, g: 40, b: 40, alpha: 1 },
        },
      })
        .png()
        .toBuffer(),
    );
    const engine = new CoreEngine(
      await WorkspaceResolver.create(
        serverConfigurationSchema.parse({
          version: 1,
          serverStateRoot: path.join(root, 'state'),
          workspaces: [{ id: 'fallback', name: 'Fallback', root: mod }],
        }),
      ),
    );
    await engine.persistentAnalysisCache;
    const studio = new ScriptedGuiStudio(engine);
    const result = await studio.lint({
      workspaceId: 'fallback',
      windowName: 'many_window',
      scenario: { id: 'fallback', resolution: { width: 640, height: 480 } },
    });
    const sprites0 = result.scene.elements.find(({ name }) => name === 'icon_0')?.sprite;
    const sprites1 = result.scene.elements.find(({ name }) => name === 'icon_1')?.sprite;
    expect(sprites0?.supported).toBe(true);
    expect(sprites1?.supported).toBe(false);
  });
});
