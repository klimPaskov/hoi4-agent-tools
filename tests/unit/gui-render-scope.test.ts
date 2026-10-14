import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { ClausewitzEvaluationDefinitions } from '../../src/hoi4_agent_tools/core/clausewitz-evaluation.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { renderStage } from '../../src/hoi4_agent_tools/core/render-progress.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  buildGuiScene,
  buildGuiSourceGraph,
  parsePreviewScenario,
} from '../../src/hoi4_agent_tools/gui/index.js';
import {
  ScriptedGuiStudio,
  scenarioCountryFlagPatterns,
} from '../../src/hoi4_agent_tools/gui/studio.js';

import { renderGui } from '../../src/hoi4_agent_tools/gui/tool-operations.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function scanned(relativePath: string, text: string): ScannedFile {
  const bytes = Buffer.from(text);
  return {
    relativePath,
    absolutePath: `/fixture/${relativePath}`,
    displayPath: `fixture:${relativePath}`,
    rootKind: 'fixture',
    loadOrder: 0,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

describe('bounded GUI render source selection', () => {
  it('retains transitive localisation across files and reports cycles and missing tokens', async () => {
    const files = [
      scanned(
        'interface/test.gui',
        'guiTypes = { containerWindowType = { name = test size = { width = 300 height = 150 } instantTextBoxType = { name = title text = TITLE maxWidth = 300 maxHeight = 50 } instantTextBoxType = { name = cycle text = CYCLE maxWidth = 300 maxHeight = 50 } } }',
      ),
      scanned(
        'localisation/english/a.yml',
        'l_english:\n LEAF: "Resolved"\n UNUSED: "Unrelated"\n',
      ),
      scanned(
        'localisation/english/b.yml',
        'l_english:\n TITLE: "$MIDDLE$ $COUNT$"\n MIDDLE: "$LEAF$"\n CYCLE: "$LOOP$ $MISSING$"\n LOOP: "$CYCLE$"\n',
      ),
    ];
    const graph = buildGuiSourceGraph(files);
    expect(graph.localisation.map(({ key }) => key)).toContain('LEAF');
    expect(graph.localisation.map(({ key }) => key)).not.toContain('UNUSED');
    const scene = await buildGuiScene(
      graph,
      files,
      'test',
      parsePreviewScenario({ id: 'tokens', variables: { COUNT: 7 } }),
    );
    expect(scene.elements.find(({ name }) => name === 'title')?.text?.text).toBe('Resolved 7');
    expect(scene.elements.find(({ name }) => name === 'cycle')?.text?.unresolvedTokens).toEqual([
      '$CYCLE$',
      '$MISSING$',
    ]);
  });

  it('uses mod localisation values rather than lower-priority game aliases', async () => {
    const game = {
      ...scanned('localisation/english/game.yml', 'l_english:\n TITLE: "Game"\n'),
      rootKind: 'game' as const,
      displayPath: 'game:localisation/english/game.yml',
    };
    const mod = {
      ...scanned('localisation/english/mod.yml', 'l_english:\n TITLE: "Mod"\n'),
      loadOrder: 1,
    };
    const files = [
      game,
      mod,
      scanned(
        'interface/test.gui',
        'guiTypes = { containerWindowType = { name = test size = { width = 200 height = 100 } instantTextBoxType = { name = title text = TITLE maxWidth = 200 maxHeight = 40 } } }',
      ),
    ];
    const scene = await buildGuiScene(
      buildGuiSourceGraph(files),
      files,
      'test',
      parsePreviewScenario({ id: 'precedence' }),
    );
    expect(scene.elements.find(({ name }) => name === 'title')?.text?.text).toBe('Mod');
  });

  it('blocks oversized localisation inventories before retaining their entries', () => {
    const files = [
      scanned('localisation/english/test.yml', 'l_english:\n ONE: "one"\n TWO: "two"\n'),
    ];
    expect(() =>
      buildGuiSourceGraph(files, undefined, [], { maximumLocalisationCandidates: 1 }),
    ).toThrowError(expect.objectContaining({ code: 'GUI_LOCALISATION_BUDGET_BLOCKED' }));
    expect(() =>
      buildGuiSourceGraph(files, undefined, [], { maximumLocalisationCandidates: 0 }),
    ).toThrowError(expect.objectContaining({ code: 'GUI_LOCALISATION_BUDGET_INVALID' }));
  });

  it('reuses condition definitions for the same source snapshot without reusing changed sources', () => {
    const files = [scanned('common/scripted_triggers/test.txt', 'helper = { always = yes }')];
    const first = ClausewitzEvaluationDefinitions.build({ files });
    expect(ClausewitzEvaluationDefinitions.build({ files })).toBe(first);
    const changed = [scanned('common/scripted_triggers/test.txt', 'helper = { always = no }')];
    expect(ClausewitzEvaluationDefinitions.build({ files: changed })).not.toBe(first);
    expect(first.scriptedTriggers.has('helper')).toBe(true);
  });

  it('binds only declared country flags and rejects pattern and path injection', () => {
    const patterns = scenarioCountryFlagPatterns([
      parsePreviewScenario({
        id: 'flags',
        country: { tag: 'GER' },
        lists: { countries: [{ countryTag: 'FRA' }, { tag: '../escape' }] },
        values: { 'ROOT.GetFlag': 'ITA', 'bad.countryTag': '*' },
      }),
    ]);
    expect(patterns).toContain('gfx/flags/GER.{bmp,dds,png,tga}');
    expect(patterns).toContain('gfx/flags/FRA.{bmp,dds,png,tga}');
    expect(patterns).toContain('gfx/flags/ITA.{bmp,dds,png,tga}');
    expect(patterns).toHaveLength(18);
    expect(patterns.some((pattern) => pattern.includes('escape'))).toBe(false);
  });

  it('does not index unrelated symbols, search documentation assets or load every flag', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-render-scope-'));
    roots.push(temporary);
    const root = path.join(temporary, 'mod');
    for (const directory of [
      'interface',
      'gfx',
      'gfx/flags',
      'docs/assets',
      'common/scripted_guis',
    ])
      await mkdir(path.join(root, directory), { recursive: true });
    const texture = await sharp({
      create: { width: 2, height: 2, channels: 4, background: '#123456' },
    })
      .png()
      .toBuffer();
    await writeFile(
      path.join(root, 'interface/test.gui'),
      'guiTypes = { containerWindowType = { name = test size = { width = 40 height = 40 } iconType = { name = icon spriteType = GFX_test } iconType = { name = missing spriteType = GFX_missing } iconType = { name = meter spriteType = GFX_colour_only } } }',
    );
    await writeFile(
      path.join(root, 'interface/test.gfx'),
      'spriteTypes = { spriteType = { name = GFX_test texturefile = "gfx/test.dds" } spriteType = { name = GFX_missing texturefile = "gfx/missing.png" } }',
    );
    await writeFile(
      path.join(root, 'common/scripted_guis/test.txt'),
      'scripted_gui = { test_gui = { window_name = test properties = { flag = { image = "[ROOT.GetFlag]" } } } }',
    );
    await writeFile(
      path.join(root, 'interface/colour.gfx'),
      'spriteTypes = { progressbarType = { name = GFX_colour_only size = { x = 20 y = 4 } color = { 1 0 0 } colortwo = { 0 0 0 } } }',
    );
    await writeFile(path.join(root, 'gfx/test.png'), texture);
    await writeFile(path.join(root, 'gfx/flags/UNRELATED.png'), texture);
    await writeFile(path.join(root, 'docs/assets/missing.png'), texture);
    const engine = new CoreEngine(
      await WorkspaceResolver.create(
        serverConfigurationSchema.parse({
          version: 1,
          serverStateRoot: path.join(temporary, 'state'),
          workspaces: [{ id: 'scope', name: 'Scope', root }],
        }),
      ),
    );
    const index = vi.spyOn(engine, 'indexFiles');
    const scan = vi.spyOn(engine.scanner, 'scan');
    const phases: string[] = [];
    const result = await new ScriptedGuiStudio(engine).lint({
      workspaceId: 'scope',
      windowName: 'test',
      scenario: { id: 'scope' },
      progress: async (phase) => {
        phases.push(phase);
      },
    });
    expect(index).not.toHaveBeenCalled();
    expect(result.graph.sprites.some(({ name }) => name === 'GFX_colour_only')).toBe(true);
    expect(result.scene.elements.find(({ name }) => name === 'icon')?.sprite?.supported).toBe(true);
    expect(result.scene.elements.find(({ name }) => name === 'missing')?.sprite?.supported).toBe(
      false,
    );
    expect(
      result.graph.filesScanned.some(
        (file) => file.includes('UNRELATED') || file.includes('docs/assets'),
      ),
    ).toBe(false);
    const patterns = scan.mock.calls.flatMap(([, options]) => options.patterns);
    expect(patterns.some((pattern) => pattern.startsWith('**/'))).toBe(false);
    expect(
      patterns.some((pattern) => pattern.includes('test.tga') && pattern.includes('**/')),
    ).toBe(false);
    expect(phases).toContain('Loading selected GUI assets');
  });

  it('does not replace a supplied scenario with generated visibility or values', async () => {
    const stop = new Error('captured input');
    const renderAndStore = vi.fn(async () => {
      throw stop;
    });
    await expect(
      renderGui(
        { renderAndStore } as unknown as ScriptedGuiStudio,
        {
          workspaceId: 'test',
          windowName: 'window',
          scenario: parsePreviewScenario({ id: 'declared', visibility: { hidden_panel: false } }),
        },
        { workspaceId: 'test', progress: async () => undefined },
      ),
    ).rejects.toBe(stop);
    expect(renderAndStore).toHaveBeenCalledWith(
      expect.not.objectContaining({ generatedScenarios: expect.anything() }),
    );
  });

  it('checks cancellation before a phase and after asynchronous progress', async () => {
    const controller = new AbortController();
    const progress = vi.fn(async () => {
      controller.abort(new Error('stop'));
    });
    await expect(
      renderStage({ signal: controller.signal, progress }, 'Loading assets'),
    ).rejects.toThrow('stop');
    expect(progress).toHaveBeenCalledTimes(1);
    await expect(
      renderStage({ signal: controller.signal, progress }, 'Rasterizing'),
    ).rejects.toThrow('stop');
    expect(progress).toHaveBeenCalledTimes(1);
  });
});
