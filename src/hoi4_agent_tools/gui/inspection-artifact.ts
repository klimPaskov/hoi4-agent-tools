import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { GuiSourceGraph, GuiSourceNode } from './types.js';

const gzipAsync = promisify(gzip);

export const GUI_INSPECTION_COMPRESSION_THRESHOLD = 134_217_728;
export const GUI_INSPECTION_FULL_GRAPH_NODE_LIMIT = 50_000;

export interface GuiInspectionGraphProjection {
  mode: 'workspace-overlay-and-selected';
  fullCounts: Record<string, number>;
  returnedCounts: Record<string, number>;
}

export interface GuiInspectionGraphArtifact {
  graph: GuiSourceGraph;
  projection?: GuiInspectionGraphProjection;
}

export interface EncodedGuiInspectionArtifact {
  name: string;
  mimeType: 'application/json' | 'application/gzip';
  content: string | Buffer;
  compressed: boolean;
  uncompressedBytes: number;
}

function isWorkspaceSource(path: string): boolean {
  return path.startsWith('mod:') || path.startsWith('fixture:');
}

const workspaceSeedKinds = new Set<GuiSourceNode['kind']>([
  'gui_file',
  'gfx_file',
  'scripted_gui_file',
  'scripted_localisation_file',
  'gui_element',
  'sprite',
  'texture',
  'font',
  'scripted_gui',
  'scripted_localisation',
  'animation_source_manifest',
  'animation_source_frame',
]);

function isWorkspaceGraphSeed(node: GuiSourceNode): boolean {
  return isWorkspaceSource(node.path) && workspaceSeedKinds.has(node.kind);
}

function graphCounts(graph: GuiSourceGraph): Record<string, number> {
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    elements: graph.elements.length,
    sprites: graph.sprites.length,
    fonts: graph.fonts.length,
    scriptedGuis: graph.scriptedGuis.length,
    animationSources: graph.animationSources.length,
    scriptedLocalisation: graph.scriptedLocalisation.length,
    localisation: graph.localisation.length,
  };
}

/**
 * A complete vanilla GUI inventory is useful for linking but wasteful to repeat in every
 * artifact. Large reports retain the workspace overlay, the selected scene, and every
 * directly connected node while recording exact full-inventory counts.
 */
export function projectGuiGraphForArtifact(
  graph: GuiSourceGraph,
  selectedSourceIds: readonly string[] = [],
  fullGraphNodeLimit = GUI_INSPECTION_FULL_GRAPH_NODE_LIMIT,
): GuiInspectionGraphArtifact {
  if (graph.nodes.length <= fullGraphNodeLimit) return { graph };

  const retainedIds = new Set(selectedSourceIds);
  for (const node of graph.nodes) if (isWorkspaceGraphSeed(node)) retainedIds.add(node.id);
  const retainedEdges = graph.edges.filter(
    ({ from, to }) => retainedIds.has(from) || retainedIds.has(to),
  );
  for (const edge of retainedEdges) {
    retainedIds.add(edge.from);
    retainedIds.add(edge.to);
  }
  const retainedLocalisation = new Set(
    graph.nodes
      .filter(({ id, kind }) => kind === 'localisation' && retainedIds.has(id))
      .map(({ name, path }) => `${path}\u0000${name}`),
  );
  const retainedGraph: GuiSourceGraph = {
    ...graph,
    nodes: graph.nodes.filter(({ id }) => retainedIds.has(id)),
    edges: retainedEdges,
    elements: graph.elements.filter(
      ({ id, sourcePath }) => retainedIds.has(id) || isWorkspaceSource(sourcePath),
    ),
    sprites: graph.sprites.filter(
      ({ id, sourcePath }) => retainedIds.has(id) || isWorkspaceSource(sourcePath),
    ),
    fonts: graph.fonts.filter(
      ({ id, sourcePath }) => retainedIds.has(id) || isWorkspaceSource(sourcePath),
    ),
    scriptedGuis: graph.scriptedGuis.filter(
      ({ id, sourcePath }) => retainedIds.has(id) || isWorkspaceSource(sourcePath),
    ),
    animationSources: graph.animationSources.filter(
      ({ id, sourcePath }) => retainedIds.has(id) || isWorkspaceSource(sourcePath),
    ),
    scriptedLocalisation: graph.scriptedLocalisation.filter(
      ({ id, sourcePath }) => retainedIds.has(id) || isWorkspaceSource(sourcePath),
    ),
    localisation: graph.localisation.filter(({ key, sourcePath }) =>
      retainedLocalisation.has(`${sourcePath}\u0000${key}`),
    ),
  };
  return {
    graph: retainedGraph,
    projection: {
      mode: 'workspace-overlay-and-selected',
      fullCounts: graphCounts(graph),
      returnedCounts: graphCounts(retainedGraph),
    },
  };
}

/** Keeps small reports directly readable and compresses very large source graphs deterministically. */
export async function encodeGuiInspectionArtifact(
  name: string,
  json: string,
  compressionThreshold = GUI_INSPECTION_COMPRESSION_THRESHOLD,
): Promise<EncodedGuiInspectionArtifact> {
  const uncompressedBytes = Buffer.byteLength(json);
  if (uncompressedBytes <= compressionThreshold) {
    return {
      name,
      mimeType: 'application/json',
      content: json,
      compressed: false,
      uncompressedBytes,
    };
  }
  return {
    name: `${name}.gz`,
    mimeType: 'application/gzip',
    content: await gzipAsync(Buffer.from(json), { level: 1 }),
    compressed: true,
    uncompressedBytes,
  };
}
