import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { GuiSourceGraph, GuiSourceNode } from './types.js';

const gzipAsync = promisify(gzip);

export const GUI_INSPECTION_COMPRESSION_THRESHOLD = 134_217_728;
export const GUI_INSPECTION_FULL_GRAPH_NODE_LIMIT = 50_000;

export interface GuiInspectionGraphProjection {
  mode: 'workspace-overlay-and-selected' | 'selected-window';
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
  const selectedWindow = selectedSourceIds.length > 0;
  if (!selectedWindow && graph.nodes.length <= fullGraphNodeLimit) return { graph };

  const retainedIds = new Set(selectedSourceIds);
  if (selectedWindow) {
    const selectedElementNames = new Set(
      graph.elements.filter(({ id }) => retainedIds.has(id)).map(({ name }) => name),
    );
    const retainedScriptedGuiNames = new Set(
      graph.scriptedGuis
        .filter(
          ({ windowName, parentWindowName }) =>
            (windowName !== undefined && selectedElementNames.has(windowName)) ||
            (parentWindowName !== undefined && selectedElementNames.has(parentWindowName)),
        )
        .map(({ name }) => name),
    );
    let addedRelatedScriptedGui = true;
    while (addedRelatedScriptedGui) {
      addedRelatedScriptedGui = false;
      for (const scripted of graph.scriptedGuis) {
        if (scripted.parentScriptedGui === undefined) continue;
        if (
          retainedScriptedGuiNames.has(scripted.parentScriptedGui) &&
          !retainedScriptedGuiNames.has(scripted.name)
        ) {
          retainedScriptedGuiNames.add(scripted.name);
          addedRelatedScriptedGui = true;
        }
        if (
          retainedScriptedGuiNames.has(scripted.name) &&
          !retainedScriptedGuiNames.has(scripted.parentScriptedGui)
        ) {
          retainedScriptedGuiNames.add(scripted.parentScriptedGui);
          addedRelatedScriptedGui = true;
        }
      }
    }
    for (const scripted of graph.scriptedGuis)
      if (retainedScriptedGuiNames.has(scripted.name)) retainedIds.add(scripted.id);
  } else {
    for (const node of graph.nodes) if (isWorkspaceGraphSeed(node)) retainedIds.add(node.id);
  }
  const retainedEdges: GuiSourceGraph['edges'] = [];
  const retainedEdgeIds = new Set<string>();
  let addedDependency = true;
  while (addedDependency) {
    addedDependency = false;
    for (const edge of graph.edges) {
      if (!retainedIds.has(edge.from) || retainedEdgeIds.has(edge.id)) continue;
      retainedEdges.push(edge);
      retainedEdgeIds.add(edge.id);
      if (!retainedIds.has(edge.to)) {
        retainedIds.add(edge.to);
        addedDependency = true;
      }
    }
  }
  for (const edge of graph.edges) {
    if (
      !retainedIds.has(edge.to) ||
      retainedEdgeIds.has(edge.id) ||
      !['contains', 'decision_category_entry'].includes(edge.kind)
    )
      continue;
    retainedEdges.push(edge);
    retainedEdgeIds.add(edge.id);
    retainedIds.add(edge.from);
  }
  const retainedLocalisation = new Set(
    graph.nodes
      .filter(({ id, kind }) => kind === 'localisation' && retainedIds.has(id))
      .map(({ name, path }) => `${path}\u0000${name}`),
  );
  const retainedPaths = new Set([
    ...graph.elements.filter(({ id }) => retainedIds.has(id)).map(({ sourcePath }) => sourcePath),
    ...graph.sprites.filter(({ id }) => retainedIds.has(id)).map(({ sourcePath }) => sourcePath),
    ...graph.fonts.filter(({ id }) => retainedIds.has(id)).map(({ sourcePath }) => sourcePath),
    ...graph.scriptedGuis
      .filter(({ id }) => retainedIds.has(id))
      .map(({ sourcePath }) => sourcePath),
    ...graph.animationSources
      .filter(({ id }) => retainedIds.has(id))
      .map(({ sourcePath }) => sourcePath),
    ...graph.scriptedLocalisation
      .filter(({ id }) => retainedIds.has(id))
      .map(({ sourcePath }) => sourcePath),
  ]);
  const retainedGraph: GuiSourceGraph = {
    ...graph,
    nodes: graph.nodes.filter(({ id }) => retainedIds.has(id)),
    edges: retainedEdges,
    elements: graph.elements.filter(
      ({ id, sourcePath }) =>
        retainedIds.has(id) || (!selectedWindow && isWorkspaceSource(sourcePath)),
    ),
    sprites: graph.sprites.filter(
      ({ id, sourcePath }) =>
        retainedIds.has(id) || (!selectedWindow && isWorkspaceSource(sourcePath)),
    ),
    fonts: graph.fonts.filter(
      ({ id, sourcePath }) =>
        retainedIds.has(id) || (!selectedWindow && isWorkspaceSource(sourcePath)),
    ),
    scriptedGuis: graph.scriptedGuis.filter(
      ({ id, sourcePath }) =>
        retainedIds.has(id) || (!selectedWindow && isWorkspaceSource(sourcePath)),
    ),
    animationSources: graph.animationSources.filter(
      ({ id, sourcePath }) =>
        retainedIds.has(id) || (!selectedWindow && isWorkspaceSource(sourcePath)),
    ),
    scriptedLocalisation: graph.scriptedLocalisation.filter(
      ({ id, sourcePath }) =>
        retainedIds.has(id) || (!selectedWindow && isWorkspaceSource(sourcePath)),
    ),
    localisation: graph.localisation.filter(({ key, sourcePath }) =>
      retainedLocalisation.has(`${sourcePath}\u0000${key}`),
    ),
    diagnostics: selectedWindow
      ? graph.diagnostics.filter(
          ({ code, location, related }) =>
            (code === 'GUI_ANIMATION_SOURCE_MANIFEST_INVALID' &&
              location?.path.startsWith('mod:hoi4_agent/animation_sources/') === true) ||
            (location !== undefined && retainedPaths.has(location.path)) ||
            related?.some(({ path }) => retainedPaths.has(path)) === true,
        )
      : graph.diagnostics,
  };
  return {
    graph: retainedGraph,
    projection: {
      mode: selectedWindow ? 'selected-window' : 'workspace-overlay-and-selected',
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
