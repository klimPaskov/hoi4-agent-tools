import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { focusDomainScanPatterns } from '../../src/hoi4_agent_tools/core/domain-scan-patterns.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { parseClausewitz } from '../../src/hoi4_agent_tools/core/source/index.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  importFocusTrees,
  layoutFocusTree,
  renderFocusTree,
  resolveFocusPresentation,
} from '../../src/hoi4_agent_tools/focus/index.js';
import { defaultPreviewScenario, ScriptedGuiStudio } from '../../src/hoi4_agent_tools/gui/index.js';

const workspaceId = 'layered-rendering';
let temporaryRoot: string;
let gameRoot: string;
let modRoot: string;
let engine: CoreEngine;

async function put(root: string, relativePath: string, content: string | Buffer): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'hoi4-layered-icons-'));
  gameRoot = path.join(temporaryRoot, 'game');
  modRoot = path.join(temporaryRoot, 'mod');
  const texturePath = 'gfx/interface/layered/vanilla_shared.png';
  await put(
    gameRoot,
    'interface/vanilla_shared.gfx',
    [
      'spriteTypes = {',
      `\tSpriteType = { name = GFX_vanilla_focus_shared texturefile = "${texturePath}" }`,
      `\tSpriteType = { name = GFX_vanilla_gui_shared texturefile = "${texturePath}" }`,
      '}',
      '',
    ].join('\n'),
  );
  await put(
    gameRoot,
    texturePath,
    await sharp({ create: { width: 64, height: 64, channels: 4, background: '#4c9a72' } })
      .png()
      .toBuffer(),
  );
  await put(
    modRoot,
    'common/national_focus/layered_focus.txt',
    [
      'focus_tree = {',
      '\tid = layered_focus_tree',
      '\tcountry = { factor = 0 }',
      '\tfocus = {',
      '\t\tid = layered_focus',
      '\t\ticon = GFX_vanilla_focus_shared',
      '\t\tx = 0',
      '\t\ty = 0',
      '\t\tcost = 10',
      '\t\tcompletion_reward = { add_political_power = 1 }',
      '\t}',
      '}',
      '',
    ].join('\n'),
  );
  await put(
    modRoot,
    'interface/layered_window.gui',
    [
      'guiTypes = {',
      '\tcontainerWindowType = {',
      '\t\tname = layered_window',
      '\t\tposition = { x = 0 y = 0 }',
      '\t\tsize = { width = 160 height = 120 }',
      '\t\ticonType = {',
      '\t\t\tname = layered_icon',
      '\t\t\tposition = { x = 24 y = 20 }',
      '\t\t\tsize = { width = 64 height = 64 }',
      '\t\t\tspriteType = GFX_vanilla_gui_shared',
      '\t\t}',
      '\t}',
      '}',
      '',
    ].join('\n'),
  );
  await put(
    modRoot,
    'localisation/english/layered_l_english.yml',
    '\ufeffl_english:\nlayered_focus: "Layered Focus"\nlayered_focus_desc: "Uses a vanilla sprite."\n',
  );
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    gameRoot,
    serverStateRoot: path.join(temporaryRoot, 'server-state'),
    workspaceStorageRoot: path.join(temporaryRoot, 'storage'),
    workspaces: [{ id: workspaceId, name: 'Layered rendering', root: modRoot, kind: 'mod' }],
  });
  engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  await engine.initialize();
});

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('layered icon rendering', () => {
  it('embeds a game-root sprite in a mod focus raster', async () => {
    const workspace = engine.resolver.get(workspaceId);
    const snapshot = await engine.scan(workspaceId, {
      patterns: focusDomainScanPatterns(workspace),
    });
    const source = snapshot.files.find(
      ({ displayPath }) => displayPath === 'mod:common/national_focus/layered_focus.txt',
    );
    expect(source).toBeDefined();
    const imported = importFocusTrees(parseClausewitz(source!.bytes, source!.displayPath));
    const plan = imported.plans[0];
    expect(plan).toBeDefined();
    const presentation = await resolveFocusPresentation({
      plans: [plan!],
      files: snapshot.files,
      index: snapshot.index,
      scanner: engine.scanner,
      workspace,
      decodeIcons: true,
    });
    expect(presentation.icons.GFX_vanilla_focus_shared).toMatchObject({
      sourcePath: 'game:interface/vanilla_shared.gfx',
      texturePath: 'gfx/interface/layered/vanilla_shared.png',
      format: 'png',
    });
    const rendered = await renderFocusTree(plan!, layoutFocusTree(plan!), [], { presentation });
    expect(rendered.svg).toContain('href="data:image/png;base64,');
    expect(rendered.png.subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('embeds a game-root sprite in a mod scripted-GUI render', async () => {
    const studio = new ScriptedGuiStudio(engine);
    const rendered = await studio.renderAndStore({
      workspaceId,
      windowName: 'layered_window',
      scenario: defaultPreviewScenario('layered-window'),
      states: ['normal'],
      resolutions: [{ width: 1280, height: 720, uiScale: 1 }],
    });
    const sprite = rendered.render.scene.elements.find(
      ({ name }) => name === 'layered_icon',
    )?.sprite;
    expect(sprite).toMatchObject({
      spriteName: 'GFX_vanilla_gui_shared',
      texturePath: 'gfx/interface/layered/vanilla_shared.png',
      supported: true,
    });
    expect(sprite?.dataUri).toMatch(/^data:image\/png;base64,/u);
    expect(rendered.render.images[0]?.svg).toContain('href="data:image/png;base64,');
  });
});
