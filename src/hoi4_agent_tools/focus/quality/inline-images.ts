import type { Diagnostic } from '../../core/diagnostics.js';
import type { RenderBudget } from '../../core/render-budget.js';
import { summarizeBranches } from './branches.js';
import { qualityMetricInfo } from './calibration.js';
import {
  INLINE_IMAGE_LIMIT,
  regionAround,
  renderSchematicPng,
  sortedUnique,
  treeRegion,
  type InlineImagePlan,
  type SchematicSeverity,
} from './schematic.js';
import type { QualityReport } from './scorecard.js';
import type { QualityGraph, QualityRegion } from './types.js';

/** One image as the response carries it. */
export interface InlineImage {
  data: string;
  mimeType: 'image/png';
}

export interface InlineImageDescription {
  kind: InlineImagePlan['kind'];
  label: string;
  focusIds: string[];
  region: QualityRegion;
  width: number;
  height: number;
  bytes: number;
}

export interface InlineImageRequest {
  cropBranchIds?: readonly string[];
  cropFocusIds?: readonly string[];
  budget?: RenderBudget;
}

export interface InlineImageResult {
  images: InlineImage[];
  descriptions: InlineImageDescription[];
  diagnostics: Diagnostic[];
}

const SEVERITY_RANK: Record<SchematicSeverity, number> = { review: 0, revise: 1, blocked: 2 };

function highlightMap(graph: QualityGraph, report: QualityReport): Map<string, SchematicSeverity> {
  const highlight = new Map<string, SchematicSeverity>();
  for (const row of report.scorecard) {
    if (!row.inVerdict) continue;
    const severity: SchematicSeverity | undefined =
      row.status === 'blocked'
        ? 'blocked'
        : row.status === 'revise'
          ? 'revise'
          : row.status === 'review'
            ? 'review'
            : undefined;
    if (severity === undefined) continue;
    for (const id of row.where) {
      if (!graph.position.has(id)) continue;
      const known = highlight.get(id);
      if (known === undefined || SEVERITY_RANK[severity] > SEVERITY_RANK[known])
        highlight.set(id, severity);
    }
  }
  return highlight;
}

function sameRegion(left: QualityRegion, right: QualityRegion): boolean {
  return (
    left.minimumX === right.minimumX &&
    left.maximumX === right.maximumX &&
    left.minimumY === right.minimumY &&
    left.maximumY === right.maximumY
  );
}

/** Which images to draw: the overview, then requested branches and focuses, then the worst findings. */
export function planInlineImages(
  graph: QualityGraph,
  report: QualityReport,
  request: InlineImageRequest,
): { plans: InlineImagePlan[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const plans: InlineImagePlan[] = [];
  const add = (plan: InlineImagePlan | undefined): void => {
    if (plan === undefined || plans.length >= INLINE_IMAGE_LIMIT) return;
    if (plans.some(({ region }) => sameRegion(region, plan.region))) return;
    plans.push(plan);
  };
  add({
    kind: 'overview',
    label: 'overview',
    focusIds: [],
    region: treeRegion(graph),
  });
  const branches = summarizeBranches(graph);
  for (const branchId of request.cropBranchIds ?? []) {
    const branch = branches.find(({ id }) => id === branchId);
    if (branch === undefined) {
      diagnostics.push({
        code: 'FOCUS_CROP_BRANCH_UNKNOWN',
        severity: 'warning',
        category: 'rendering',
        message: `No branch ${branchId} in this tree; branches are ${
          sortedUnique(branches.map(({ id }) => id))
            .slice(0, 12)
            .join(', ') || 'not declared'
        }`,
        details: { branchId, branchIds: sortedUnique(branches.map(({ id }) => id)).slice(0, 50) },
      });
      continue;
    }
    add({
      kind: 'branch',
      label: `branch ${branch.id}`,
      focusIds: branch.focusIds.slice(0, 50),
      region: regionAround(
        graph,
        branch.focusIds,
        { columns: 2, rows: 1 },
        { columns: 14, rows: 3 },
      )!,
    });
  }
  for (const focusId of request.cropFocusIds ?? []) {
    add({
      kind: 'focus',
      label: `around ${focusId}`,
      focusIds: [focusId],
      region: regionAround(graph, [focusId])!,
    });
  }
  const explicit = (request.cropBranchIds?.length ?? 0) + (request.cropFocusIds?.length ?? 0) > 0;
  if (!explicit) {
    // Without a request, show the places the scorecard blames, worst first.
    for (const row of report.scorecard) {
      if (plans.length >= 4) break;
      if (!row.inVerdict || !['blocked', 'revise', 'review'].includes(row.status)) continue;
      const focusIds = row.where.filter((id) => graph.position.has(id));
      const region = regionAround(graph, focusIds.slice(0, 12));
      if (region === undefined) continue;
      add({
        kind: 'problem',
        label: `${row.id} ${qualityMetricInfo(row.id).name}`,
        focusIds: focusIds.slice(0, 12),
        region,
      });
    }
  }
  return { plans, diagnostics };
}

/** Draws the planned images; each is a PNG of at most about 700 KB. */
export async function renderInlineImages(
  graph: QualityGraph,
  report: QualityReport,
  request: InlineImageRequest,
  title: string,
): Promise<InlineImageResult> {
  if (graph.nodes.length === 0) return { images: [], descriptions: [], diagnostics: [] };
  const { plans, diagnostics } = planInlineImages(graph, report, request);
  const highlight = highlightMap(graph, report);
  const images: InlineImage[] = [];
  const descriptions: InlineImageDescription[] = [];
  for (const plan of plans) {
    const rendered = await renderSchematicPng(graph, {
      region: plan.region,
      highlight,
      title: plan.kind === 'overview' ? title : `${title} · ${plan.label}`,
      ...(request.budget === undefined ? {} : { budget: request.budget }),
      maximumEdge: plan.kind === 'overview' ? 1500 : 1000,
    });
    images.push({ data: rendered.png.toString('base64'), mimeType: 'image/png' });
    descriptions.push({
      kind: plan.kind,
      label: plan.label,
      focusIds: plan.focusIds,
      region: rendered.region,
      width: rendered.width,
      height: rendered.height,
      bytes: rendered.png.length,
    });
  }
  return { images, descriptions, diagnostics };
}
