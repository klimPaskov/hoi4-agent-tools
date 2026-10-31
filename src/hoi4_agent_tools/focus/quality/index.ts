import type { FocusTreePlan } from '../model.js';
import { buildQualityGraph } from './graph.js';
import { measureLayoutQuality } from './metrics.js';
import { reportLayoutQuality, type QualityReport } from './scorecard.js';
import { STORED_QUALITY_CALIBRATION } from './stored-calibration.js';
import type { QualityCalibration, QualityGraph, QualityMeasurement, QualityNode } from './types.js';

export * from './branches.js';
export * from './calibration.js';
export * from './graph.js';
export * from './metrics.js';
export * from './orthogonal.js';
export * from './positions.js';
export * from './scorecard.js';
export * from './stored-calibration.js';
export * from './types.js';

export interface FocusLayoutQualityEvaluation {
  graph: QualityGraph;
  measurement: QualityMeasurement;
  report: QualityReport;
}

/** Measures one layout of a plan against the vanilla calibration. */
export function evaluateFocusLayoutQuality(
  plan: Pick<FocusTreePlan, 'id' | 'focuses' | 'branchGroups'>,
  nodes: readonly QualityNode[],
  calibration: QualityCalibration = STORED_QUALITY_CALIBRATION,
): FocusLayoutQualityEvaluation {
  const graph = buildQualityGraph(plan, nodes);
  const measurement = measureLayoutQuality(graph);
  const report = reportLayoutQuality(graph, measurement, calibration, { treeId: plan.id });
  return { graph, measurement, report };
}
export * from './delta.js';
export * from './tool-output.js';
export * from './inline-images.js';
export * from './schematic.js';
