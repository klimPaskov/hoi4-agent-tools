import type { SourceDocument } from './source/index.js';
import type { SourceLocation } from './diagnostics.js';

export type TriState = 'true' | 'false' | 'unresolved';
export type ScenarioScalar = string | number | boolean | null;
export type ScenarioValue = ScenarioScalar | ScenarioScalar[];

export interface ConditionScopeBinding {
  id: string;
  type?:
    | 'country'
    | 'state'
    | 'character'
    | 'unit_leader'
    | 'operative'
    | 'strategic_region'
    | 'province'
    | 'unknown';
  actor?: string;
  state: Record<string, ScenarioValue>;
  flags?: string[];
  eventTargets?: Record<string, string>;
  weight?: number | string;
}

/** Shared declared state; generated previews are not verified campaign facts. */
export interface ConditionScenario {
  id: string;
  actor?: string;
  date?: string;
  state: Record<string, ScenarioValue>;
  flags?: string[];
  eventTargets?: Record<string, string>;
  scopes?: Record<string, ConditionScopeBinding>;
  candidateOverrides?: Record<string, boolean>;
  /** Legacy probability scenarios declare a closed flag catalog by default. */
  closedFlags?: boolean;
}

export interface ConditionProvenance {
  path: string;
  rootKind: string;
  loadOrder: number;
  sourceHash: string;
  location?: SourceLocation;
  astPath?: string[];
  symbol?: string;
  helperChain?: string[];
}

export interface ConditionUnresolved {
  code: string;
  message: string;
  path?: string;
  candidateId?: string;
  provenance?: ConditionProvenance;
  details?: Record<string, unknown>;
}

export interface ConditionSubject {
  id: string;
  document?: SourceDocument;
  provenance: ConditionProvenance[];
}

export interface ConditionTraceStep {
  operation: 'eligibility';
  expression: string;
  applied: TriState;
  provenance?: ConditionProvenance;
}
