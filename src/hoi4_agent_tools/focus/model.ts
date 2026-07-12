import { hashCanonical } from '../core/canonical.js';
import type { Diagnostic, SourceLocation } from '../core/diagnostics.js';

export const FOCUS_PLAN_SCHEMA_VERSION = 1 as const;

export interface RawClausewitzBlock {
  text: string;
  referencedFocusIds: string[];
  sourceLocation?: SourceLocation;
}

export interface RawPassthroughEntry {
  kind: 'assignment' | 'scalar' | 'block';
  key?: string;
  order: number;
  text: string;
  sourceLocation?: SourceLocation;
}

export interface FocusPrerequisiteGroup {
  /** A Clausewitz prerequisite block is an OR group. */
  operator: 'or';
  focusIds: string[];
  rawPassthrough: RawPassthroughEntry[];
  sourceLocation?: SourceLocation;
}

export interface FocusPrerequisites {
  /** Separate Clausewitz prerequisite blocks are combined as AND. */
  operator: 'and';
  groups: FocusPrerequisiteGroup[];
}

export type FocusPosition =
  | { mode: 'fixed'; x: number; y: number; pinned: boolean }
  | { mode: 'relative'; x: number; y: number; relativeTo: string; pinned: boolean }
  | { mode: 'auto'; pinned: false; preferredX?: number; preferredY?: number };

export type FocusVisibility = 'normal' | 'hidden' | 'crisis' | 'conditional';

export interface FocusReveal {
  kind: 'allow_branch' | 'event' | 'decision' | 'scripted_trigger' | 'manual';
  references: string[];
  description?: string;
  /** Engine-valid allow_branch trigger used to implement non-normal visibility. */
  trigger?: RawClausewitzBlock;
}

export interface FocusRouteLock {
  id: string;
  field?: 'available' | 'allow_branch';
  mode: 'all' | 'any';
  requiredFocusIds: string[];
  excludedFocusIds: string[];
  alwaysImpossible?: boolean;
  sourceLocation?: SourceLocation;
}

export type FocusIcon =
  | { kind: 'static'; sprite: string; sourceLocation?: SourceLocation }
  | {
      kind: 'dynamic';
      sprite: string;
      trigger?: RawClausewitzBlock;
      sourceLocation?: SourceLocation;
    };

export type FocusReferenceKind =
  'decision' | 'decision_category' | 'event' | 'idea' | 'leader' | 'formable' | 'helper';

export interface FocusReferenceLink {
  kind: FocusReferenceKind;
  target: string;
  sourceLocation?: SourceLocation;
}

export interface FocusLocalisation {
  titleKey: string;
  descriptionKey: string;
  workingLabel?: string;
}

export interface FocusAiMetadata {
  raw?: RawClausewitzBlock;
  majorRoute: boolean;
  strategyIds: string[];
}

export type FocusTerminalKind =
  'capstone' | 'convergence' | 'failure' | 'route_lock' | 'formable' | 'side_payoff';

/** A source-safe Clausewitz file constant such as `@focus_cost_standard`. */
export const FOCUS_COST_CONSTANT_PATTERN = /^@[A-Za-z_][A-Za-z0-9_]*$/u;
export type FocusCostConstant = `@${string}`;
export type FocusCost = number | FocusCostConstant;

export interface FocusNodePlan {
  id: string;
  label: string;
  branchId?: string;
  laneId?: string;
  prerequisites: FocusPrerequisites;
  mutuallyExclusive: string[];
  routeLocks: FocusRouteLock[];
  availability?: RawClausewitzBlock;
  bypass?: RawClausewitzBlock;
  allowBranch?: RawClausewitzBlock;
  position: FocusPosition;
  visibility: FocusVisibility;
  reveal?: FocusReveal;
  convergence: boolean;
  sharedSupport: boolean;
  /** @deprecated Continuous focuses belong to common/continuous_focus palettes. */
  continuous?: false;
  icons: FocusIcon[];
  localisation: FocusLocalisation;
  ai: FocusAiMetadata;
  filters: string[];
  links: FocusReferenceLink[];
  cost?: FocusCost;
  completionReward?: RawClausewitzBlock;
  payoff?: string;
  terminalKind?: FocusTerminalKind;
  rawPassthrough: RawPassthroughEntry[];
  sourceLocation?: SourceLocation;
}

export interface FocusBranchGroup {
  id: string;
  label: string;
  family: string;
  focusIds: string[];
  laneId?: string;
  major: boolean;
  hidden: boolean;
  crisis: boolean;
  conditional: boolean;
  aiStrategyIds: string[];
}

export interface FocusLaneGroup {
  id: string;
  label: string;
  order: number;
  minimumX?: number;
  maximumX?: number;
}

export interface FocusCountryAssignment {
  raw: RawClausewitzBlock;
  countryTags: string[];
}

export interface FocusRuntimeAssignment {
  replacesExistingCountryTree: boolean;
  eventCreatedGuard?: string;
}

export interface ContinuousFocusDefinition {
  id: string;
  icons: FocusIcon[];
  localisation: FocusLocalisation;
  rawPassthrough: RawPassthroughEntry[];
  sourceLocation?: SourceLocation;
}

export interface ContinuousFocusPalettePlan {
  schemaVersion: typeof FOCUS_PLAN_SCHEMA_VERSION;
  id: string;
  countryAssignment?: FocusCountryAssignment;
  default: boolean;
  resetOnCivilWar?: boolean;
  position?: { x: number; y: number };
  focuses: ContinuousFocusDefinition[];
  rawPassthrough: RawPassthroughEntry[];
  provenance: FocusPlanProvenance;
  sourceLocation?: SourceLocation;
}

export interface FocusPlanningNodeMetadata {
  id: string;
  label: string;
  branchId?: string;
  laneId?: string;
  pinned: boolean;
  visibility: FocusVisibility;
  reveal?: FocusReveal;
  convergence: boolean;
  sharedSupport: boolean;
  workingLabel?: string;
  aiMajorRoute: boolean;
  aiStrategyIds: string[];
  payoff?: string;
  terminalKind?: FocusTerminalKind;
}

export interface FocusPlanningSidecar {
  schemaVersion: 1;
  treeId: string;
  sourcePath: string;
  sourceHash: string;
  branchGroups: FocusBranchGroup[];
  laneGroups: FocusLaneGroup[];
  entryFocusIds: string[];
  continuousFocusPaletteIds: string[];
  continuousFocusIds: string[];
  runtimeAssignment?: FocusRuntimeAssignment;
  focuses: FocusPlanningNodeMetadata[];
}

export interface FocusGeneratedSourceMapping {
  focusId: string;
  generatedLocation: SourceLocation;
  planNodeLocation?: SourceLocation;
}

export interface FocusGeneratedSourceMap {
  schemaVersion: 1;
  treeId: string;
  generatedPath: string;
  generatedSha256: string;
  mappings: FocusGeneratedSourceMapping[];
}

export interface FocusCompiledSource {
  source: string;
  sourceMap: FocusGeneratedSourceMap;
}

export interface FocusResolvedPresentationEntry {
  id: string;
  title: string;
  description?: string;
  titleKey: string;
  descriptionKey: string;
  titleSourceLocation?: SourceLocation;
  descriptionSourceLocation?: SourceLocation;
  iconSprite?: string;
}

export interface FocusResolvedIcon {
  sprite: string;
  sourcePath: string;
  texturePath: string;
  frame: number;
  frameCount: number;
  width: number;
  height: number;
  format: string;
  dataUri: string;
}

export interface FocusPresentationResolution {
  language: string;
  entries: Record<string, FocusResolvedPresentationEntry>;
  icons: Record<string, FocusResolvedIcon>;
  diagnostics: Diagnostic[];
  sourceHashes: Record<string, string>;
  filesScanned: string[];
}

export interface FocusPlanProvenance {
  sourcePath: string;
  sourceHash: string;
  importedPlanHash: string;
}

export interface FocusTreePlan {
  schemaVersion: typeof FOCUS_PLAN_SCHEMA_VERSION;
  id: string;
  countryAssignment?: FocusCountryAssignment;
  default: boolean;
  branchGroups: FocusBranchGroup[];
  laneGroups: FocusLaneGroup[];
  entryFocusIds: string[];
  focuses: FocusNodePlan[];
  sharedFocusIds: string[];
  continuousFocusPaletteIds: string[];
  continuousFocusIds: string[];
  continuousFocusPosition?: { x: number; y: number };
  initialShowPosition?: RawClausewitzBlock;
  runtimeAssignment?: FocusRuntimeAssignment;
  rawPassthrough: RawPassthroughEntry[];
  provenance: FocusPlanProvenance;
  sourceLocation?: SourceLocation;
}

export interface FocusImportResult {
  plans: FocusTreePlan[];
  continuousFocusPalettes: ContinuousFocusPalettePlan[];
  diagnostics: Diagnostic[];
}

export interface FocusLayoutNode {
  id: string;
  x: number;
  y: number;
  laneId: string;
  preserved: boolean;
  sourceMode: FocusPosition['mode'];
}

export interface FocusLayoutDecision {
  focusId: string;
  kind:
    | 'preserved'
    | 'relative'
    | 'placed'
    | 'moved_for_collision'
    | 'moved_for_mutual_exclusion'
    | 'moved_to_reduce_crossings';
  message: string;
}

export interface FocusLayoutResult {
  treeId: string;
  nodes: FocusLayoutNode[];
  decisions: FocusLayoutDecision[];
  diagnostics: Diagnostic[];
  layoutHash: string;
}

export interface FocusLayoutOptions {
  previous?: FocusLayoutResult;
  laneSpacing?: number;
  nodeSpacing?: number;
  /** Cooperative cancellation for callers laying out large focus graphs. */
  signal?: AbortSignal;
}

export type FocusReferenceCatalog = Partial<
  Record<FocusReferenceKind, ReadonlySet<string> | readonly string[]>
>;

function withoutTransientFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTransientFields);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(object)
        .filter(([key]) => key !== 'provenance' && key !== 'sourceLocation')
        .map(([key, child]) => [key, withoutTransientFields(child)]),
    );
  }
  return value;
}

export function focusPlanHash(plan: FocusTreePlan | ContinuousFocusPalettePlan): string {
  return hashCanonical(withoutTransientFields(plan));
}

export function layoutNodeMap(layout: FocusLayoutResult): Map<string, FocusLayoutNode> {
  return new Map(layout.nodes.map((node) => [node.id, node]));
}
