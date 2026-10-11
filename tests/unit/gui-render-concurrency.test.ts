import type * as Sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { buildGuiScene } from '../../src/hoi4_agent_tools/gui/layout.js';
import { buildGuiSourceGraph } from '../../src/hoi4_agent_tools/gui/source-graph.js';
import { parsePreviewScenario } from '../../src/hoi4_agent_tools/gui/scenario.js';
import { renderGuiScene } from '../../src/hoi4_agent_tools/gui/renderer.js';

const counters = vi.hoisted(() => ({ active: 0, peak: 0, total: 0 }));

vi.mock('sharp', async (importOriginal) => {
  const module = await importOriginal<typeof Sharp>();
  const real = module.default;
  const counted = ((...input: Parameters<typeof real>) => {
    const instance = real(...input);
    const toBuffer = instance.toBuffer.bind(instance) as (...rest: unknown[]) => Promise<unknown>;
    (instance as unknown as { toBuffer: unknown }).toBuffer = async (...rest: unknown[]) => {
      counters.active += 1;
      counters.total += 1;
      counters.peak = Math.max(counters.peak, counters.active);
      // Give a concurrent sibling the chance to start before this one settles.
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await toBuffer(...rest);
      } finally {
        counters.active -= 1;
      }
    };
    return instance;
  }) as unknown as typeof real;
  Object.assign(counted, real);
  return { ...module, default: counted };
});

function scanned(displayPath: string, content: string): ScannedFile {
  const bytes = Buffer.from(content);
  return {
    displayPath,
    absolutePath: `/synthetic/${displayPath}`,
    relativePath: displayPath,
    rootKind: 'fixture',
    loadOrder: 0,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

describe('GUI render rasterization', () => {
  it('derives every variant from the base raster one at a time', async () => {
    const files = [
      scanned(
        'interface/window.gui',
        `guiTypes = { containerWindowType = { name = "root" size = { width = 200 height = 120 }
          instantTextBoxType = { name = "label" position = { x = 10 y = 10 } text = "Hello" font = "Arial" maxWidth = 100 maxHeight = 20 } } }`,
      ),
    ];
    const scene = await buildGuiScene(
      buildGuiSourceGraph(files, SymbolIndex.build(files)),
      files,
      'root',
      parsePreviewScenario({ id: 'concurrency', resolution: { width: 320, height: 240 } }),
    );
    counters.active = 0;
    counters.peak = 0;
    counters.total = 0;
    const rendered = await renderGuiScene(scene);
    expect(rendered.images.map(({ variant }) => variant)).toEqual(
      expect.arrayContaining(['full', 'cropped', 'annotated', 'click-regions']),
    );
    // The base raster plus one derived raster per remaining variant, never overlapping.
    expect(counters.total).toBe(rendered.images.length);
    expect(counters.peak).toBe(1);
  });
});
