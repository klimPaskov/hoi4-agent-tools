import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import {
  SOURCE_LINE_LIMIT,
  SOURCE_TOKEN_LIMIT,
} from '../../src/hoi4_agent_tools/core/source/index.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  ScriptedGuiStudio,
  buildGuiScene,
  buildGuiSourceGraph,
  parsePreviewScenario,
  validateGuiScene,
} from '../../src/hoi4_agent_tools/gui/index.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function scanned(relativePath: string, content: Buffer | string): ScannedFile {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  return {
    absolutePath: path.join('C:/fixture', relativePath),
    displayPath: `mod:${relativePath}`,
    relativePath,
    rootKind: 'mod',
    loadOrder: 0,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

function tokenLimitedSource(prefix: string): Buffer {
  return Buffer.from(`${prefix}\n${'value = yes '.repeat(Math.ceil(SOURCE_TOKEN_LIMIT / 3) + 1)}`);
}

async function studioFor(source: Buffer): Promise<{
  studio: ScriptedGuiStudio;
  sourcePath: string;
}> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-gui-partial-index-'));
  temporaryRoots.push(temporary);
  const mod = path.join(temporary, 'mod');
  const sourcePath = path.join(mod, 'interface', 'partial.gui');
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, source);
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    workspaces: [{ id: 'partial', name: 'Partial GUI inventory', root: mod }],
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  return { studio: new ScriptedGuiStudio(engine), sourcePath };
}

describe('partial GUI inventories', () => {
  it('keeps representative validation usable when a skipped GFX source could define a sprite', async () => {
    const files = [
      scanned(
        'interface/partial.gui',
        'guiTypes = { containerWindowType = { name = "partial_window" size = { width = 100 height = 100 } iconType = { name = "partial_icon" position = { x = 10 y = 10 } size = { width = 20 height = 20 } spriteType = "GFX_from_skipped" } } }\n',
      ),
      scanned(
        'interface/partial.gfx',
        tokenLimitedSource(
          'spriteTypes = { spriteType = { name = "GFX_from_skipped" texturefile = "gfx/interface/partial.png" } }',
        ),
      ),
    ];
    const graph = buildGuiSourceGraph(files, SymbolIndex.build(files));

    expect(graph).toMatchObject({ complete: false, skippedSourceCount: 1 });
    expect(graph.sprites.some(({ name }) => name === 'GFX_from_skipped')).toBe(false);
    expect(graph.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'GUI_INVENTORY_PARTIAL', severity: 'warning' }),
        expect.objectContaining({
          code: 'GUI_REFERENCE_UNRESOLVED_PARTIAL',
          severity: 'warning',
        }),
      ]),
    );
    expect(graph.diagnostics.some(({ severity }) => severity === 'error')).toBe(false);

    const scene = await buildGuiScene(
      graph,
      files,
      'partial_window',
      parsePreviewScenario({
        id: 'partial',
        resolution: { width: 1920, height: 1080 },
      }),
    );
    const validation = await validateGuiScene(graph, scene, files);
    expect(validation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'GUI_REFERENCE_UNRESOLVED_PARTIAL',
          severity: 'warning',
        }),
      ]),
    );
    expect(validation.diagnostics.some(({ severity }) => severity === 'error')).toBe(false);
    expect(validation.checks.filter(({ passed }) => !passed)).toEqual([]);
  });

  it('does not weaken a missing sprite error for an unrelated skipped localisation source', () => {
    const files = [
      scanned(
        'interface/partial.gui',
        'guiTypes = { containerWindowType = { name = "partial_window" size = { width = 100 height = 100 } iconType = { name = "partial_icon" size = { width = 20 height = 20 } spriteType = "GFX_still_missing" } } }\n',
      ),
      scanned(
        'localisation/english/partial_l_english.yml',
        Buffer.from(`\uFEFFl_english:\n${'\n'.repeat(SOURCE_LINE_LIMIT)}`),
      ),
    ];
    const graph = buildGuiSourceGraph(files, SymbolIndex.build(files));

    expect(graph).toMatchObject({
      complete: false,
      skippedPossibleSymbolKinds: ['localisation'],
    });
    expect(graph.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'GUI_REFERENCE_UNRESOLVED', severity: 'error' }),
      ]),
    );
    expect(graph.diagnostics.some(({ code }) => code === 'GUI_REFERENCE_UNRESOLVED_PARTIAL')).toBe(
      false,
    );
  });

  it('blocks a missing targeted window when an over-limit GUI source could define it', async () => {
    const source = tokenLimitedSource(
      'guiTypes = { containerWindowType = { name = "partial_window" size = { width = 100 height = 100 } } }',
    );
    const { studio } = await studioFor(source);

    await expect(
      studio.lint({
        workspaceId: 'partial',
        windowName: 'partial_window',
        scenario: { id: 'partial', resolution: { width: 320, height: 200 } },
      }),
    ).rejects.toMatchObject({ code: 'GUI_TARGET_SOURCE_SKIPPED_LIMIT' });
  });

  it('blocks targeted patches before walking an over-limit source document', async () => {
    const source = tokenLimitedSource(
      'guiTypes = { containerWindowType = { name = "partial_window" size = { width = 100 height = 100 } } }',
    );
    const { studio } = await studioFor(source);
    const sourceText = source.toString('utf8');
    const expectedText = '"partial_window"';
    const start = sourceText.indexOf(expectedText);

    await expect(
      studio.planSource({
        workspaceId: 'partial',
        relativePath: 'interface/partial.gui',
        expectedSourceHash: sha256Bytes(source),
        patches: [
          {
            start,
            end: start + expectedText.length,
            expectedText,
            text: '"changed_window"',
            description: 'Change the target name',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'GUI_TARGET_SOURCE_SKIPPED_LIMIT' });
  });
});
