import { sha256Bytes } from '../core/canonical.js';
import { ServiceError } from '../core/result.js';
import type { SourceDocument } from '../core/source/index.js';
import { importContinuousFocusPalettes, importFocusTrees } from './importer.js';
import {
  focusPlanHash,
  type ContinuousFocusPalettePlan,
  type FocusReferenceCatalog,
  type FocusTreePlan,
} from './model.js';

export type FocusDriftStatus =
  | 'clean'
  | 'plan_changed'
  | 'source_changed_formatting'
  | 'source_changed_semantically'
  | 'converged'
  | 'conflict'
  | 'target_missing'
  | 'tree_removed';

export interface FocusDriftResult {
  status: FocusDriftStatus;
  sourceChanged: boolean;
  planChanged: boolean;
  requiresAuthority: boolean;
  savedPlanHash: string;
  currentPlanHash: string;
  importedPlanHash: string;
  savedSourceHash: string;
  currentSourceHash: string;
  currentSourcePlan?: FocusTreePlan;
}

export interface ContinuousFocusDriftResult extends Omit<FocusDriftResult, 'currentSourcePlan'> {
  currentSourcePlan?: ContinuousFocusPalettePlan;
}

export function detectFocusDrift(
  savedPlan: FocusTreePlan,
  currentDocument: SourceDocument,
  references?: FocusReferenceCatalog,
): FocusDriftResult {
  const currentSourceHash = sha256Bytes(currentDocument.bytes);
  const savedPlanHash = focusPlanHash(savedPlan);
  const planChanged = savedPlanHash !== savedPlan.provenance.importedPlanHash;
  const sourceChanged = currentSourceHash !== savedPlan.provenance.sourceHash;
  const importedPlans = importFocusTrees(
    currentDocument,
    references === undefined ? {} : { references },
  ).plans;
  const currentSourcePlan =
    importedPlans.find(({ id }) => id === savedPlan.id) ??
    importedPlans.find(
      ({ sourceLocation }) =>
        sourceLocation?.start.offset === savedPlan.sourceLocation?.start.offset,
    ) ??
    (importedPlans.length === 1 ? importedPlans[0] : undefined);
  if (currentSourcePlan === undefined) {
    return {
      status: 'tree_removed',
      sourceChanged,
      planChanged,
      requiresAuthority: true,
      savedPlanHash,
      currentPlanHash: '',
      importedPlanHash: savedPlan.provenance.importedPlanHash,
      savedSourceHash: savedPlan.provenance.sourceHash,
      currentSourceHash,
    };
  }
  const currentPlanHash = focusPlanHash(currentSourcePlan);
  let status: FocusDriftStatus;
  if (!sourceChanged && !planChanged) status = 'clean';
  else if (!sourceChanged) status = 'plan_changed';
  else if (!planChanged && currentPlanHash === savedPlan.provenance.importedPlanHash) {
    status = 'source_changed_formatting';
  } else if (!planChanged) status = 'source_changed_semantically';
  else if (currentPlanHash === savedPlanHash) status = 'converged';
  else status = 'conflict';
  return {
    status,
    sourceChanged,
    planChanged,
    requiresAuthority: sourceChanged && status !== 'converged',
    savedPlanHash,
    currentPlanHash,
    importedPlanHash: savedPlan.provenance.importedPlanHash,
    savedSourceHash: savedPlan.provenance.sourceHash,
    currentSourceHash,
    currentSourcePlan,
  };
}

export function assertFocusPlanAuthority(
  drift: FocusDriftResult | ContinuousFocusDriftResult,
  authority: 'plan' | 'source' | undefined,
): void {
  if (!drift.requiresAuthority) return;
  if (authority === 'plan') return;
  if (authority === 'source') {
    throw new ServiceError(
      'FOCUS_SOURCE_AUTHORITATIVE',
      'The current source is authoritative; import it before planning source changes',
      {
        status: drift.status,
        currentSourceHash: drift.currentSourceHash,
        currentPlanHash: drift.currentPlanHash,
      },
    );
  }
  throw new ServiceError(
    'FOCUS_DRIFT_AUTHORITY_REQUIRED',
    'Focus plan and source have drifted; select plan or source as authoritative before regeneration',
    {
      status: drift.status,
      savedSourceHash: drift.savedSourceHash,
      currentSourceHash: drift.currentSourceHash,
      savedPlanHash: drift.savedPlanHash,
      currentPlanHash: drift.currentPlanHash,
    },
  );
}

export function detectContinuousFocusDrift(
  savedPlan: ContinuousFocusPalettePlan,
  currentDocument: SourceDocument,
): ContinuousFocusDriftResult {
  const currentSourceHash = sha256Bytes(currentDocument.bytes);
  const savedPlanHash = focusPlanHash(savedPlan);
  const planChanged = savedPlanHash !== savedPlan.provenance.importedPlanHash;
  const sourceChanged = currentSourceHash !== savedPlan.provenance.sourceHash;
  const importedPlans = importContinuousFocusPalettes(currentDocument).continuousFocusPalettes;
  const currentSourcePlan =
    importedPlans.find(({ id }) => id === savedPlan.id) ??
    importedPlans.find(
      ({ sourceLocation }) =>
        sourceLocation?.start.offset === savedPlan.sourceLocation?.start.offset,
    ) ??
    (importedPlans.length === 1 ? importedPlans[0] : undefined);
  if (currentSourcePlan === undefined) {
    return {
      status: 'tree_removed',
      sourceChanged,
      planChanged,
      requiresAuthority: true,
      savedPlanHash,
      currentPlanHash: '',
      importedPlanHash: savedPlan.provenance.importedPlanHash,
      savedSourceHash: savedPlan.provenance.sourceHash,
      currentSourceHash,
    };
  }
  const currentPlanHash = focusPlanHash(currentSourcePlan);
  let status: FocusDriftStatus;
  if (!sourceChanged && !planChanged) status = 'clean';
  else if (!sourceChanged) status = 'plan_changed';
  else if (!planChanged && currentPlanHash === savedPlan.provenance.importedPlanHash)
    status = 'source_changed_formatting';
  else if (!planChanged) status = 'source_changed_semantically';
  else if (currentPlanHash === savedPlanHash) status = 'converged';
  else status = 'conflict';
  return {
    status,
    sourceChanged,
    planChanged,
    requiresAuthority: sourceChanged && status !== 'converged',
    savedPlanHash,
    currentPlanHash,
    importedPlanHash: savedPlan.provenance.importedPlanHash,
    savedSourceHash: savedPlan.provenance.sourceHash,
    currentSourceHash,
    currentSourcePlan,
  };
}
