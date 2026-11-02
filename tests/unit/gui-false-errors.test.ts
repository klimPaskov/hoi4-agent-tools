import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import {
  buildGuiScene,
  buildGuiSourceGraph,
  parsePreviewScenario,
  validateGuiScene,
} from '../../src/hoi4_agent_tools/gui/index.js';
import { inlineDiagnostics } from '../../src/hoi4_agent_tools/gui/tool-operations.js';

function scanned(relativePath: string, content: Buffer | string): ScannedFile {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
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

const spriteFile = scanned(
  'interface/sprites.gfx',
  `spriteTypes = {
  spriteType = { name = "GFX_tab_plain" texturefile = "gfx/interface/tab_plain.dds" }
  spriteType = { name = "GFX_tab_selected" texturefile = "gfx/interface/tab_selected.dds" }
  spriteType = { name = "GFX_panel" texturefile = "gfx/interface/panel.dds" }
  spriteType = { name = "GFX_fill" texturefile = "gfx/interface/fill.dds" }
}`,
);

function dds(width: number, height: number): Buffer {
  const header = Buffer.alloc(128);
  header.writeUInt32LE(0x2053_4444, 0);
  header.writeUInt32LE(124, 4);
  header.writeUInt32LE(0x100f, 8);
  header.writeUInt32LE(height, 12);
  header.writeUInt32LE(width, 16);
  header.writeUInt32LE(width * 4, 20);
  header.writeUInt32LE(32, 76);
  header.writeUInt32LE(0x41, 80);
  header.writeUInt32LE(32, 88);
  header.writeUInt32LE(0x00ff_0000, 92);
  header.writeUInt32LE(0x0000_ff00, 96);
  header.writeUInt32LE(0x0000_00ff, 100);
  header.writeUInt32LE(0xff00_0000, 104);
  header.writeUInt32LE(0x1000, 108);
  return Buffer.concat([header, Buffer.alloc(width * height * 4, 0xff)]);
}

const textures = [
  scanned('gfx/interface/panel.dds', dds(400, 200)),
  scanned('gfx/interface/fill.dds', dds(256, 12)),
];

function graphFor(files: readonly ScannedFile[]) {
  return buildGuiSourceGraph(files, SymbolIndex.build(files));
}

async function validate(files: readonly ScannedFile[], window: string) {
  const graph = graphFor(files);
  const scene = await buildGuiScene(
    graph,
    files,
    window,
    parsePreviewScenario({ id: 'false-errors', resolution: { width: 640, height: 360 } }),
  );
  return (await validateGuiScene(graph, scene, files)).diagnostics;
}

describe('GUI false errors (#62)', () => {
  const tabs = (key: string) =>
    scanned(
      'common/scripted_localisation/tabs.txt',
      `defined_text = { name = GetTabSprite text = { trigger = { always = no } localization_key = GFX_tab_selected } text = { localization_key = ${key} } }`,
    );

  it('resolves sprite names returned by defined_text against the sprite inventory', () => {
    const graph = graphFor([spriteFile, tabs('GFX_tab_plain')]);
    expect(graph.diagnostics.filter(({ code }) => code === 'GUI_REFERENCE_UNRESOLVED')).toEqual([]);
  });

  it('still reports a defined_text key that is neither localisation nor a sprite', () => {
    const graph = graphFor([spriteFile, tabs('GFX_tab_missing')]);
    const unresolved = graph.diagnostics.filter(({ code }) => code === 'GUI_REFERENCE_UNRESOLVED');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.message).toContain('GFX_tab_missing');
  });

  const window = (body: string) =>
    scanned(
      'interface/test.gui',
      `guiTypes = { containerWindowType = { name = "w" position = { x = 0 y = 0 } size = { width = 400 height = 200 } clipping = yes ${body} } }`,
    );

  it('does not report a background under its title as a visible overlap', async () => {
    const files = [
      spriteFile,
      ...textures,
      window(`iconType = { name = "bg" spriteType = "GFX_panel" position = { x = 0 y = 0 } }
        instantTextBoxType = { name = "title" position = { x = 20 y = 10 } font = "hoi_20b" text = "T" maxWidth = 200 maxHeight = 28 fixedsize = yes }`),
    ];
    const diagnostics = await validate(files, 'w');
    expect(diagnostics.filter(({ code }) => code === 'GUI_VISIBLE_OVERLAP')).toEqual([]);
  });

  it('still reports two overlapping text boxes', async () => {
    const files = [
      spriteFile,
      ...textures,
      window(`instantTextBoxType = { name = "a" position = { x = 20 y = 10 } font = "hoi_20b" text = "A" maxWidth = 200 maxHeight = 28 fixedsize = yes }
        instantTextBoxType = { name = "b" position = { x = 20 y = 10 } font = "hoi_20b" text = "B" maxWidth = 200 maxHeight = 28 fixedsize = yes }`),
    ];
    const diagnostics = await validate(files, 'w');
    expect(diagnostics.filter(({ code }) => code === 'GUI_VISIBLE_OVERLAP')).toHaveLength(1);
  });

  const meter = (x: number) =>
    window(`containerWindowType = { name = "clip" position = { x = 24 y = 53 } size = { width = 128 height = 12 } clipping = yes
          iconType = { name = "fill" spriteType = "GFX_fill" position = { x = ${x} y = 0 } scale = 0.5 }
        }`);

  it('does not report a meter fill parked outside its clip window as accidental clipping', async () => {
    for (const x of [-256, -128]) {
      const diagnostics = await validate([spriteFile, ...textures, meter(x)], 'w');
      expect(diagnostics.filter(({ code }) => code === 'GUI_ACCIDENTAL_CLIPPING')).toEqual([]);
    }
  });

  it('still reports an icon that overflows the far edge of its clip window', async () => {
    const diagnostics = await validate([spriteFile, ...textures, meter(100)], 'w');
    expect(diagnostics.filter(({ code }) => code === 'GUI_ACCIDENTAL_CLIPPING')).toHaveLength(1);
  });
});

describe('inline GUI diagnostics (#62)', () => {
  const make = (severity: 'error' | 'warning', index: number) => ({
    code: `CODE_${severity}_${index}`,
    severity,
    category: 'layout' as const,
    message: 'm',
  });

  it('keeps errors that arrive after a flood of warnings', () => {
    const warnings = Array.from({ length: 150 }, (_unused, index) => make('warning', index));
    const inline = inlineDiagnostics([...warnings, make('error', 0), make('error', 1)]);
    expect(inline).toHaveLength(100);
    expect(inline.slice(0, 2).map(({ code }) => code)).toEqual(['CODE_error_0', 'CODE_error_1']);
  });

  it('leaves a short list in its original order', () => {
    const list = [make('warning', 0), make('error', 0)];
    expect(inlineDiagnostics(list)).toEqual(list);
  });
});
