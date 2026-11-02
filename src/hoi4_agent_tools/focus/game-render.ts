import type { ResolvedWorkspace } from '../core/workspace.js';
import type { SymbolIndex } from '../core/index.js';
import {
  sharedResidentEngine,
  type ResidentEngine,
  type ResidentEngineOutcome,
} from '../core/resident-engine.js';
import type { FocusLayoutResult, FocusTreePlan } from './model.js';

/**
 * The game view of a focus tree (issue #75): the Rust engine (`hoi4-preview`) draws it from the
 * game's own sprites, textures, bitmap font and `nationalfocusview.gui`, with the layout this
 * server computed. The engine runs resident (ADR 0077) and keeps decoded assets between calls.
 */

export interface FocusGameViewBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FocusGameViewMissing {
  kind: string;
  name: string;
  message: string;
  focusIds: string[];
}

export interface FocusGameViewReport {
  width: number;
  height: number;
  scale: number;
  fullWidth: number;
  fullHeight: number;
  focuses: FocusGameViewBox[];
  missing: FocusGameViewMissing[];
  drawn: Record<string, number>;
}

export type FocusGameViewOutcome =
  | {
      ok: true;
      png: Buffer;
      report: FocusGameViewReport;
      cache: Record<string, unknown>;
      timings: Record<string, unknown>;
      titles: Record<string, { text: string; resolved: boolean }>;
    }
  | { ok: false; code: string; message: string };

const MAX_LOCALISATION_DEPTH = 4;

/** A localisation value with `$KEY$` references resolved, or undefined when the key has none. */
function localised(
  index: SymbolIndex,
  language: string,
  key: string,
  depth = 0,
): string | undefined {
  const entry = index.find('localisation', `${language}:${key}`);
  const value = typeof entry?.metadata.value === 'string' ? entry.metadata.value : undefined;
  if (value === undefined || depth >= MAX_LOCALISATION_DEPTH) return value;
  return value.replace(/\$([A-Za-z0-9_.-]+)(?:\|[^$]*)?\$/gu, (whole, inner: string) =>
    inner === key ? whole : (localised(index, language, inner, depth + 1) ?? whole),
  );
}

/** The game's layers in load order: game, DLC, dependencies, then the mod. */
export function gameLayers(
  workspace: ResolvedWorkspace,
): Array<{ name: string; path: string; replacePaths: string[] }> {
  return workspace.roots
    .filter(
      ({ kind }) => kind === 'game' || kind === 'dlc' || kind === 'dependency' || kind === 'mod',
    )
    .sort((left, right) => left.loadOrder - right.loadOrder)
    .map((root) => ({
      name: 'label' in root && typeof root.label === 'string' ? root.label : root.kind,
      path: root.path,
      replacePaths: root.replacePaths,
    }));
}

export async function renderFocusGameView(input: {
  workspace: ResolvedWorkspace;
  plan: FocusTreePlan;
  layout: FocusLayoutResult;
  index: SymbolIndex;
  language: string;
  scale: number;
  maxPixels: number;
  engine?: ResidentEngine;
  signal?: AbortSignal;
}): Promise<FocusGameViewOutcome> {
  const positions = new Map(input.layout.nodes.map((node) => [node.id, node]));
  const titles: Record<string, { text: string; resolved: boolean }> = {};
  const focuses = input.plan.focuses.flatMap((focus) => {
    const node = positions.get(focus.id);
    if (node === undefined) return [];
    const value = localised(input.index, input.language, focus.localisation.titleKey);
    // The game shows the raw key when a title has no localisation.
    const title = value ?? focus.localisation.titleKey;
    titles[focus.id] = { text: title, resolved: value !== undefined };
    return [
      {
        id: focus.id,
        x: node.x,
        y: node.y,
        ...(focus.icons[0] === undefined ? {} : { icon: focus.icons[0].sprite }),
        title,
        prerequisites: focus.prerequisites.groups.map(({ focusIds }) => focusIds),
        mutuallyExclusive: focus.mutuallyExclusive,
      },
    ];
  });
  const engine = input.engine ?? sharedResidentEngine();
  const outcome: ResidentEngineOutcome = await engine.request(
    'focus.render',
    {
      layers: gameLayers(input.workspace),
      request: { focuses, scale: input.scale, maxPixels: input.maxPixels },
    },
    undefined,
    input.signal === undefined ? {} : { signal: input.signal },
  );
  if (!outcome.ok)
    return outcome.kind === 'error'
      ? { ok: false, code: outcome.code, message: outcome.message }
      : { ok: false, code: outcome.reason, message: outcome.message };
  const result = outcome.response.result;
  const report = result.report as FocusGameViewReport | undefined;
  if (
    report === undefined ||
    typeof report.width !== 'number' ||
    !Array.isArray(report.focuses) ||
    !Array.isArray(report.missing) ||
    outcome.response.payload.length === 0
  )
    return { ok: false, code: 'invalid_output', message: 'The engine returned no focus render' };
  return {
    ok: true,
    png: outcome.response.payload,
    report,
    cache: (result.cache as Record<string, unknown> | undefined) ?? {},
    timings: (result.timings as Record<string, unknown> | undefined) ?? {},
    titles,
  };
}
