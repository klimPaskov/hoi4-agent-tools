import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  encodeGuiInspectionArtifact,
  projectGuiGraphForArtifact,
} from '../../src/hoi4_agent_tools/gui/inspection-artifact.js';
import type { GuiSourceGraph } from '../../src/hoi4_agent_tools/gui/types.js';

const gunzipAsync = promisify(gunzip);

describe('GUI inspection artifact encoding', () => {
  it('projects large graphs to workspace and selected connections', () => {
    const graph: GuiSourceGraph = {
      complete: true,
      skippedSourceCount: 0,
      skippedSources: [],
      skippedPossibleSymbolKinds: [],
      nodes: [
        { id: 'mod', kind: 'gui_file', name: 'mod', path: 'mod:interface/a.gui', metadata: {} },
        {
          id: 'linked',
          kind: 'sprite',
          name: 'linked',
          path: 'game:interface/a.gfx',
          metadata: {},
        },
        {
          id: 'selected',
          kind: 'gui_element',
          name: 'selected',
          path: 'game:interface/b.gui',
          metadata: {},
        },
        {
          id: 'unrelated',
          kind: 'sprite',
          name: 'unrelated',
          path: 'game:interface/c.gfx',
          metadata: {},
        },
        {
          id: 'omitted',
          kind: 'sprite',
          name: 'omitted',
          path: 'game:interface/d.gfx',
          metadata: {},
        },
      ],
      edges: [
        { id: 'a', kind: 'uses_sprite', from: 'mod', to: 'linked', resolved: true, metadata: {} },
        {
          id: 'b',
          kind: 'contains',
          from: 'selected',
          to: 'unrelated',
          resolved: true,
          metadata: {},
        },
      ],
      elements: [],
      sprites: [],
      fonts: [],
      scriptedGuis: [],
      animationSources: [],
      scriptedLocalisation: [],
      localisation: [],
      sourceHashes: {},
      filesScanned: [],
      diagnostics: [],
    };
    const projected = projectGuiGraphForArtifact(graph, ['selected'], 1);
    expect(projected.projection).toMatchObject({
      mode: 'workspace-overlay-and-selected',
      fullCounts: { nodes: 5, edges: 2 },
      returnedCounts: { nodes: 4, edges: 2 },
    });
    expect(projected.graph.nodes.map(({ id }) => id)).toEqual([
      'mod',
      'linked',
      'selected',
      'unrelated',
    ]);
  });

  it('keeps small JSON directly readable', async () => {
    const encoded = await encodeGuiInspectionArtifact('inspection.json', '{"ok":true}\n', 100);
    expect(encoded).toMatchObject({
      name: 'inspection.json',
      mimeType: 'application/json',
      compressed: false,
    });
    expect(encoded.content).toBe('{"ok":true}\n');
  });

  it('compresses large JSON deterministically and losslessly', async () => {
    const source = `${JSON.stringify({ nodes: Array.from({ length: 100 }, () => 'same') })}\n`;
    const first = await encodeGuiInspectionArtifact('inspection.json', source, 1);
    const second = await encodeGuiInspectionArtifact('inspection.json', source, 1);
    expect(first).toMatchObject({
      name: 'inspection.json.gz',
      mimeType: 'application/gzip',
      compressed: true,
      uncompressedBytes: Buffer.byteLength(source),
    });
    expect(first.content).toEqual(second.content);
    expect((await gunzipAsync(first.content as Buffer)).toString('utf8')).toBe(source);
  });
});
