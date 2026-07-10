import { canonicalJson, sha256Bytes } from '../core/canonical.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { ServiceError } from '../core/result.js';
import { focusPlanningSidecarSchema } from '../schemas/focus.js';
import {
  assignments,
  firstScalar,
  nodeLocation,
  type SourceDocument,
} from '../core/source/index.js';
import {
  focusPlanHash,
  type ContinuousFocusPalettePlan,
  type FocusGeneratedSourceMap,
  type FocusPlanningNodeMetadata,
  type FocusPlanningSidecar,
  type FocusTreePlan,
} from './model.js';

export function focusPlanningSidecarPath(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/');
  return normalized.toLowerCase().endsWith('.txt')
    ? `${normalized.slice(0, -4)}.focus-plan.json`
    : `${normalized}.focus-plan.json`;
}

function planningNode(focus: FocusTreePlan['focuses'][number]): FocusPlanningNodeMetadata {
  return {
    id: focus.id,
    label: focus.label,
    ...(focus.branchId === undefined ? {} : { branchId: focus.branchId }),
    ...(focus.laneId === undefined ? {} : { laneId: focus.laneId }),
    pinned: focus.position.pinned,
    visibility: focus.visibility,
    ...(focus.reveal === undefined ? {} : { reveal: structuredClone(focus.reveal) }),
    convergence: focus.convergence,
    sharedSupport: focus.sharedSupport,
    ...(focus.localisation.workingLabel === undefined
      ? {}
      : { workingLabel: focus.localisation.workingLabel }),
    aiMajorRoute: focus.ai.majorRoute,
    aiStrategyIds: [...focus.ai.strategyIds],
    ...(focus.payoff === undefined ? {} : { payoff: focus.payoff }),
    ...(focus.terminalKind === undefined ? {} : { terminalKind: focus.terminalKind }),
  };
}

export function createFocusPlanningSidecar(
  plan: FocusTreePlan,
  sourceHash = plan.provenance.sourceHash,
): FocusPlanningSidecar {
  return {
    schemaVersion: 1,
    treeId: plan.id,
    sourcePath: plan.provenance.sourcePath,
    sourceHash,
    branchGroups: structuredClone(plan.branchGroups),
    laneGroups: structuredClone(plan.laneGroups),
    entryFocusIds: [...plan.entryFocusIds],
    continuousFocusPaletteIds: [...plan.continuousFocusPaletteIds],
    continuousFocusIds: [...plan.continuousFocusIds],
    ...(plan.runtimeAssignment === undefined
      ? {}
      : { runtimeAssignment: structuredClone(plan.runtimeAssignment) }),
    focuses: plan.focuses.map(planningNode),
  };
}

export function serializeFocusPlanningSidecar(sidecar: FocusPlanningSidecar): string {
  return `${canonicalJson(sidecar)}\n`;
}

export function parseFocusPlanningSidecar(value: string | Uint8Array): FocusPlanningSidecar {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof value === 'string' ? value : Buffer.from(value).toString('utf8'));
  } catch (error) {
    throw new ServiceError('FOCUS_PLANNING_SIDECAR_INVALID', 'Planning sidecar is not valid JSON', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const validated = focusPlanningSidecarSchema.safeParse(parsed);
  if (!validated.success) {
    throw new ServiceError(
      'FOCUS_PLANNING_SIDECAR_INVALID',
      'Planning sidecar does not match focus-planning-sidecar.v1',
      { issues: validated.error.issues },
    );
  }
  return validated.data as FocusPlanningSidecar;
}

export function enrichFocusPlanFromSidecar(
  plan: FocusTreePlan,
  sidecar: FocusPlanningSidecar,
): { plan: FocusTreePlan; diagnostics: Diagnostic[]; applied: boolean } {
  if (sidecar.treeId !== plan.id) {
    return {
      plan,
      applied: false,
      diagnostics: [
        {
          code: 'FOCUS_PLANNING_SIDECAR_TREE_MISMATCH',
          severity: 'error',
          category: 'reference',
          message: `Planning sidecar targets ${sidecar.treeId}, not ${plan.id}`,
          ...(plan.sourceLocation === undefined ? {} : { location: plan.sourceLocation }),
        },
      ],
    };
  }
  if (sidecar.sourcePath !== plan.provenance.sourcePath) {
    return {
      plan,
      applied: false,
      diagnostics: [
        {
          code: 'FOCUS_PLANNING_SIDECAR_SOURCE_MISMATCH',
          severity: 'error',
          category: 'reference',
          message: `Planning sidecar targets ${sidecar.sourcePath}, not ${plan.provenance.sourcePath}`,
          ...(plan.sourceLocation === undefined ? {} : { location: plan.sourceLocation }),
        },
      ],
    };
  }
  if (sidecar.sourceHash !== plan.provenance.sourceHash) {
    return {
      plan,
      applied: false,
      diagnostics: [
        {
          code: 'FOCUS_PLANNING_SIDECAR_STALE',
          severity: 'warning',
          category: 'reference',
          message: `Planning sidecar for ${plan.id} does not match the active source hash`,
          ...(plan.sourceLocation === undefined ? {} : { location: plan.sourceLocation }),
          details: {
            sidecarSourceHash: sidecar.sourceHash,
            activeSourceHash: plan.provenance.sourceHash,
          },
        },
      ],
    };
  }
  const enriched = structuredClone(plan);
  enriched.branchGroups = structuredClone(sidecar.branchGroups);
  enriched.laneGroups = structuredClone(sidecar.laneGroups);
  enriched.entryFocusIds = [...sidecar.entryFocusIds];
  enriched.continuousFocusPaletteIds = [...sidecar.continuousFocusPaletteIds];
  enriched.continuousFocusIds = [...sidecar.continuousFocusIds];
  if (sidecar.runtimeAssignment === undefined) delete enriched.runtimeAssignment;
  else enriched.runtimeAssignment = structuredClone(sidecar.runtimeAssignment);
  const metadata = new Map(sidecar.focuses.map((focus) => [focus.id, focus]));
  for (const focus of enriched.focuses) {
    const saved = metadata.get(focus.id);
    if (saved === undefined) continue;
    focus.label = saved.label;
    if (saved.branchId === undefined) delete focus.branchId;
    else focus.branchId = saved.branchId;
    if (saved.laneId === undefined) delete focus.laneId;
    else focus.laneId = saved.laneId;
    if (focus.position.mode !== 'auto') focus.position.pinned = saved.pinned;
    focus.visibility = saved.visibility;
    if (saved.reveal === undefined) delete focus.reveal;
    else focus.reveal = structuredClone(saved.reveal);
    focus.convergence = saved.convergence;
    focus.sharedSupport = saved.sharedSupport;
    if (saved.workingLabel === undefined) delete focus.localisation.workingLabel;
    else focus.localisation.workingLabel = saved.workingLabel;
    focus.ai.majorRoute = saved.aiMajorRoute;
    focus.ai.strategyIds = [...saved.aiStrategyIds];
    if (saved.payoff === undefined) delete focus.payoff;
    else focus.payoff = saved.payoff;
    if (saved.terminalKind === undefined) delete focus.terminalKind;
    else focus.terminalKind = saved.terminalKind;
  }
  enriched.provenance.importedPlanHash = focusPlanHash(enriched);
  return {
    plan: enriched,
    applied: true,
    diagnostics: [
      {
        code: 'FOCUS_PLANNING_SIDECAR_APPLIED',
        severity: 'info',
        category: 'reference',
        message: `Applied source-hash-bound planning metadata for ${plan.id}`,
        ...(plan.sourceLocation === undefined ? {} : { location: plan.sourceLocation }),
      },
    ],
  };
}

export function focusSourceMapForDocument(
  document: SourceDocument,
  plan: FocusTreePlan,
  generatedPath = document.path,
): FocusGeneratedSourceMap {
  const tree = assignments(document.root, 'focus_tree').find(
    (assignment) =>
      assignment.value.type === 'block' && firstScalar(assignment.value, 'id')?.value === plan.id,
  );
  const planById = new Map(plan.focuses.map((focus) => [focus.id, focus]));
  const mappings =
    tree?.value.type === 'block'
      ? assignments(tree.value, 'focus').flatMap((assignment) => {
          if (assignment.value.type !== 'block') return [];
          const focusId = firstScalar(assignment.value, 'id')?.value;
          if (focusId === undefined) return [];
          const focus = planById.get(focusId);
          return [
            {
              focusId,
              generatedLocation: nodeLocation(document, assignment, focusId),
              ...(focus?.sourceLocation === undefined
                ? {}
                : { planNodeLocation: focus.sourceLocation }),
            },
          ];
        })
      : [];
  return {
    schemaVersion: 1,
    treeId: plan.id,
    generatedPath,
    generatedSha256: sha256Bytes(document.bytes),
    mappings,
  };
}

export function continuousFocusSourceMapForDocument(
  document: SourceDocument,
  plan: ContinuousFocusPalettePlan,
  generatedPath = document.path,
): FocusGeneratedSourceMap {
  const palette = assignments(document.root, 'continuous_focus_palette').find(
    (assignment) =>
      assignment.value.type === 'block' && firstScalar(assignment.value, 'id')?.value === plan.id,
  );
  const planById = new Map(plan.focuses.map((focus) => [focus.id, focus]));
  const mappings =
    palette?.value.type === 'block'
      ? assignments(palette.value, 'focus').flatMap((assignment) => {
          if (assignment.value.type !== 'block') return [];
          const focusId = firstScalar(assignment.value, 'id')?.value;
          if (focusId === undefined) return [];
          const focus = planById.get(focusId);
          return [
            {
              focusId,
              generatedLocation: nodeLocation(document, assignment, focusId),
              ...(focus?.sourceLocation === undefined
                ? {}
                : { planNodeLocation: focus.sourceLocation }),
            },
          ];
        })
      : [];
  return {
    schemaVersion: 1,
    treeId: plan.id,
    generatedPath,
    generatedSha256: sha256Bytes(document.bytes),
    mappings,
  };
}
