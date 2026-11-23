import { z } from 'zod/v4';
import { canonicalJson } from '../core/canonical.js';
import { callEngineOperation } from '../core/engine-operation.js';
import { ServiceError } from '../core/result.js';
import type { ScanSnapshot } from '../core/engine.js';
import type { ScannedFile } from '../core/scanner.js';
import type { TechnologyGraphSnapshot } from './model.js';

/**
 * The technology graph and its read-only queries on the Rust engine (ADR 0089, packet P5).
 * `tech.analyze` reads the sources and answers which sprites and localisation keys the graph
 * needs, `tech.graph` assembles the graph from the index lookups sent back, and `tech.query`
 * answers one query of a graph the engine holds by revision. The graph is the same snapshot the
 * TypeScript builder produced, so rendering and comparison read it unchanged.
 */

const analyzeSchema = z
  .object({
    session: z.string(),
    wants: z.object({ sprites: z.array(z.string()), localisation: z.array(z.string()) }).strict(),
  })
  .strict();

const answerSchema = z.object({ format: z.literal('json') }).strict();

const querySchema = z.object({ report: z.unknown(), summary: z.unknown().optional() }).strict();

export interface TechnologyEngineAnswer {
  report: unknown;
  /** Mode explain: the inline summary of the technology. */
  summary?: unknown;
}

export type TechnologyEngineQuery = {
  mode: 'scan' | 'folders' | 'trace' | 'explain' | 'unlocks' | 'bonus_coverage' | 'lint' | 'impact';
  folderId?: string;
  technologyId?: string;
  categoryId?: string;
  targetKind?: string;
  targetId?: string;
  direction?: string;
  maxDepth?: number;
  maxNodes?: number;
  includeSubTechnologies?: boolean;
  classifications?: string[];
  codes?: string[];
  impact?: { kind: string; id: string; operation: string; replacementId?: string };
};

function wireFile(file: ScannedFile): Record<string, unknown> {
  return {
    absolutePath: file.absolutePath,
    displayPath: file.displayPath,
    relativePath: file.relativePath,
    rootKind: file.rootKind,
    loadOrder: file.loadOrder,
    size: Math.trunc(file.size),
    modifiedMs: Math.trunc(file.modifiedMs),
    sha256: file.sha256,
    ...(file.shadowedBy === undefined ? {} : { shadowedBy: file.shadowedBy }),
  };
}

interface Analysis {
  session: string;
  wants: z.infer<typeof analyzeSchema>['wants'];
}

const analyses = new WeakMap<ScanSnapshot, Analysis>();

function helperIds(snapshot: ScanSnapshot): string[] {
  return snapshot.index
    .findAll('scripted_effect')
    .filter(({ overridden, sourceShadowed }) => !overridden && !sourceShadowed)
    .map(({ id }) => id);
}

async function analyze(snapshot: ScanSnapshot): Promise<Analysis> {
  const { result } = await callEngineOperation({
    op: 'tech.analyze',
    body: { files: snapshot.files.map(wireFile), helperIds: helperIds(snapshot) },
    result: analyzeSchema,
  });
  analyses.set(snapshot, result);
  return result;
}

export interface EngineGraphOptions {
  workspaceIdentity: string;
  assetFiles?: readonly ScannedFile[];
  analysisMode?: 'full' | 'focused';
}

/** `buildTechnologyGraph` on the engine. */
export async function buildTechnologyGraphOnEngine(
  snapshot: ScanSnapshot,
  options: EngineGraphOptions,
): Promise<TechnologyGraphSnapshot> {
  const lookups = (analysis: Analysis): Record<string, unknown> => {
    const sprites: Record<string, [string, string | null]> = {};
    for (const name of analysis.wants.sprites) {
      const sprite = snapshot.index.find('sprite', name);
      if (sprite === undefined) continue;
      const texture = sprite.metadata.texture;
      sprites[name] = [sprite.path, typeof texture === 'string' ? texture : null];
    }
    const localisation: Record<string, string> = {};
    for (const key of analysis.wants.localisation) {
      const value = snapshot.index.find('localisation', `l_english:${key}`)?.metadata.value;
      if (typeof value === 'string') localisation[key] = value;
    }
    return {
      sprites,
      skippedSpriteSource: snapshot.index.hasSkippedSourceForKind('sprite'),
      localisation,
      skippedLocalisationSource: snapshot.index.hasSkippedSourceForKind('localisation'),
    };
  };
  const request = (analysis: Analysis) => ({
    op: 'tech.graph',
    body: {
      session: analysis.session,
      scan: {
        workspaceId: snapshot.workspaceId,
        workspaceIdentity: options.workspaceIdentity,
        revision: snapshot.revision,
        complete: snapshot.complete,
        skippedSourceCount: snapshot.skippedSourceCount,
        skippedSources: snapshot.skippedSources,
        diagnostics: snapshot.diagnostics,
        assetFiles: (options.assetFiles ?? []).map(wireFile),
        ...(options.analysisMode === undefined ? {} : { analysisMode: options.analysisMode }),
      },
      lookups: lookups(analysis),
    },
    result: answerSchema,
  });
  const graphOf = (answer: { payload: Buffer }): TechnologyGraphSnapshot => {
    const graph = JSON.parse(answer.payload.toString('utf8')) as TechnologyGraphSnapshot;
    if (graph.schemaVersion !== 2 || !Array.isArray(graph.technologies))
      throw new ServiceError('ENGINE_UNAVAILABLE', 'hoi4-engine tech.graph answered out of shape', {
        op: 'tech.graph',
        reason: 'invalid_response',
      });
    return graph;
  };
  let analysis = analyses.get(snapshot) ?? (await analyze(snapshot));
  try {
    return graphOf(await callEngineOperation(request(analysis)));
  } catch (error) {
    if (!(error instanceof Error) || (error as { code?: string }).code !== 'TECH_SESSION_EXPIRED')
      throw error;
    analysis = await analyze(snapshot);
    return graphOf(await callEngineOperation(request(analysis)));
  }
}

/** One read-only query of a graph, answered by the engine; the graph is sent again if it expired. */
export async function queryTechnologyGraph(
  graph: TechnologyGraphSnapshot,
  query: TechnologyEngineQuery,
): Promise<TechnologyEngineAnswer> {
  const body = { revision: graph.revision, ...query };
  const answerOf = (answer: { payload: Buffer }): TechnologyEngineAnswer =>
    querySchema.parse(JSON.parse(answer.payload.toString('utf8')));
  try {
    return answerOf(await callEngineOperation({ op: 'tech.query', body, result: answerSchema }));
  } catch (error) {
    if (!(error instanceof Error) || (error as { code?: string }).code !== 'TECH_GRAPH_EXPIRED')
      throw error;
  }
  return answerOf(
    await callEngineOperation({
      op: 'tech.query',
      body: { ...body, graphInPayload: true },
      payload: Buffer.from(canonicalJson(graph), 'utf8'),
      result: answerSchema,
    }),
  );
}
