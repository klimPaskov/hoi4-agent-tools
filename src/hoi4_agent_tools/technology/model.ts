import type { JsonValue } from '../core/canonical.js';
import type { Diagnostic, DiagnosticSeverity, SourceLocation } from '../core/diagnostics.js';
import type { IndexSkippedSource } from '../core/index.js';

export const TECHNOLOGY_GRAPH_SCHEMA_VERSION = 1 as const;
export const TECHNOLOGY_PARSER_VERSION = 'clausewitz-cst.v1' as const;

export type TechnologyConfidence = 'confirmed' | 'high' | 'medium' | 'low' | 'unresolved';

export type TechnologyDefectClass =
  'confirmed_error' | 'probable_defect' | 'design_warning' | 'unresolved_analysis';

export interface TechnologySourceProvenance {
  path: string;
  rootKind: 'game' | 'dependency' | 'mod' | 'fixture' | 'artifact' | 'cache';
  loadOrder: number;
  location: SourceLocation;
  sourceHash: string;
}

export interface TechnologyAiMetadata {
  present: boolean;
  base?: string;
  factor?: string;
  zero: boolean | 'unknown';
  researchWeights: Record<string, string>;
  expression?: string;
}

export interface TechnologyIconStatus {
  sprite: string;
  spritePath?: string;
  texturePath?: string;
  status: 'resolved' | 'missing_sprite' | 'missing_texture' | 'partial';
}

export interface TechnologyDefinition {
  id: string;
  kind: 'technology' | 'legacy_doctrine';
  source: TechnologySourceProvenance;
  rawSource: string;
  startYear?: string;
  researchCost?: string;
  doctrineName?: string;
  hidden: boolean | 'unknown';
  folders: string[];
  categories: string[];
  tags: string[];
  subTechnologies: string[];
  ai: TechnologyAiMetadata;
  icon: TechnologyIconStatus;
  localisation: {
    language: string;
    nameKey: string;
    descriptionKey: string;
    name?: string;
    description?: string;
    status: 'resolved' | 'missing' | 'partial';
  };
  effectKeys: string[];
  effectSignature: string;
  unsupportedFields: Array<{
    field: string;
    expression: string;
    location: SourceLocation;
    reason: string;
  }>;
}

export interface TechnologyFolder {
  id: string;
  doctrine: boolean;
  ledger?: string;
  availableExpression?: string;
  source: TechnologySourceProvenance;
  localisation: {
    language: string;
    name?: string;
    description?: string;
    status: 'resolved' | 'missing' | 'partial';
  };
}

export interface TechnologyPlacement {
  id: string;
  technologyId: string;
  folderId: string;
  x?: number;
  y?: number;
  xExpression?: string;
  yExpression?: string;
  branchRootId?: string;
  gridboxId?: string;
  pixelX?: number;
  pixelY?: number;
  geometryStatus?: 'source_pixel' | 'source_coordinate' | 'unresolved';
  sourceAccurate: true;
  location: SourceLocation;
}

export interface TechnologyGridbox {
  id: string;
  name: string;
  folderId?: string;
  position: { x?: number; y?: number; xExpression?: string; yExpression?: string };
  slotSize: {
    width?: number;
    height?: number;
    widthExpression?: string;
    heightExpression?: string;
  };
  format?: string;
  location: SourceLocation;
  sourcePath: string;
  loadOrder: number;
}

export type TechnologyEdgeKind = 'prerequisite' | 'exclusive' | 'sub_technology';

export interface TechnologyEdge {
  id: string;
  kind: TechnologyEdgeKind;
  from: string;
  to: string;
  coefficient?: string;
  ignoreForLayout?: boolean;
  location: SourceLocation;
  confidence: TechnologyConfidence;
}

export type TechnologyUnlockKind =
  'equipment' | 'equipment_module' | 'sub_unit' | 'building' | 'ability' | 'tactic' | 'other';

export interface TechnologyUnlockTarget {
  id: string;
  kind: TechnologyUnlockKind;
  targetId: string;
  source?: TechnologySourceProvenance;
}

export interface TechnologyUnlock {
  id: string;
  technologyId: string;
  kind: TechnologyUnlockKind;
  targetId: string;
  level?: string;
  location: SourceLocation;
  confidence: TechnologyConfidence;
  resolved: boolean | 'unknown';
}

export interface TechnologyCategory {
  id: string;
  kind: 'category' | 'tag';
  source: TechnologySourceProvenance;
  localisation?: string;
}

export type TechnologyExternalSourceKind =
  | 'focus'
  | 'event'
  | 'decision'
  | 'mission'
  | 'on_action'
  | 'scripted_effect'
  | 'country_history'
  | 'startup_effect'
  | 'idea'
  | 'character'
  | 'technology_sharing'
  | 'other';

export type TechnologyExternalReferenceKind =
  | 'grant'
  | 'remove'
  | 'research_bonus'
  | 'starting_technology'
  | 'technology_sharing'
  | 'reference';

export interface TechnologyExternalReference {
  id: string;
  kind: TechnologyExternalReferenceKind;
  sourceKind: TechnologyExternalSourceKind;
  sourceId: string;
  technologyId?: string;
  categoryId?: string;
  expression: string;
  location: SourceLocation;
  helperStack: string[];
  confidence: TechnologyConfidence;
  dynamic: boolean;
  metadata: Record<string, JsonValue>;
}

export interface TechnologyHelperCall {
  id: string;
  sourceKind: TechnologyExternalSourceKind;
  sourceId: string;
  helperId: string;
  location: SourceLocation;
  confidence: TechnologyConfidence;
}

export interface DoctrineDefinition {
  id: string;
  kind: 'folder' | 'grand_doctrine' | 'track' | 'subdoctrine' | 'reward';
  folderId?: string;
  trackIds: string[];
  parentId?: string;
  exclusiveIds: string[];
  nameKey?: string;
  descriptionKey?: string;
  icon?: TechnologyIconStatus;
  xpCost?: string;
  xpType?: string;
  ai: TechnologyAiMetadata;
  effectKeys: string[];
  source: TechnologySourceProvenance;
}

export interface TechnologyUnresolvedAnalysis {
  id: string;
  kind:
    | 'dynamic_reference'
    | 'missing_technology'
    | 'missing_folder'
    | 'missing_category'
    | 'missing_unlock'
    | 'partial_source'
    | 'unsupported_construct';
  expression: string;
  ownerId?: string;
  location?: SourceLocation;
  confidence: TechnologyConfidence;
  blockers: Array<{
    code: string;
    message: string;
    location?: SourceLocation;
    details?: Record<string, JsonValue>;
  }>;
}

export interface TechnologyIssue {
  code: string;
  classification: TechnologyDefectClass;
  severity: DiagnosticSeverity;
  message: string;
  confidence: TechnologyConfidence;
  location?: SourceLocation;
  related?: SourceLocation[];
  blockers: TechnologyUnresolvedAnalysis['blockers'];
  details: Record<string, JsonValue>;
}

export interface TechnologyGraphStatistics {
  technologyCount: number;
  legacyDoctrineCount: number;
  folderCount: number;
  placementCount: number;
  gridboxCount: number;
  prerequisiteCount: number;
  exclusiveCount: number;
  categoryCount: number;
  doctrineDefinitionCount: number;
  unlockCount: number;
  externalReferenceCount: number;
  issueCount: number;
  unresolvedCount: number;
}

export interface TechnologyGraphSnapshot {
  schemaVersion: typeof TECHNOLOGY_GRAPH_SCHEMA_VERSION;
  parserVersion: typeof TECHNOLOGY_PARSER_VERSION;
  workspaceId: string;
  workspaceIdentity: string;
  revision: string;
  complete: boolean;
  analysisBoundary: {
    staticAnalysis: true;
    language: string;
    loadOrder: string;
    generatedLayoutsLabelled: true;
    unsupportedConstructs: string[];
    assumptions: string[];
  };
  sourceHashes: Record<string, string>;
  filesScanned: string[];
  skippedSourceCount: number;
  skippedSources: readonly IndexSkippedSource[];
  technologies: TechnologyDefinition[];
  folders: TechnologyFolder[];
  placements: TechnologyPlacement[];
  gridboxes: TechnologyGridbox[];
  edges: TechnologyEdge[];
  categories: TechnologyCategory[];
  doctrineDefinitions: DoctrineDefinition[];
  unlockTargets: TechnologyUnlockTarget[];
  unlocks: TechnologyUnlock[];
  externalReferences: TechnologyExternalReference[];
  helperCalls: TechnologyHelperCall[];
  issues: TechnologyIssue[];
  diagnostics: Diagnostic[];
  unresolved: TechnologyUnresolvedAnalysis[];
  statistics: TechnologyGraphStatistics;
}

export interface TechnologySourceFragment {
  sourcePath: string;
  sourceHash: string;
  technologies: Array<
    Omit<TechnologyDefinition, 'icon' | 'localisation' | 'effectSignature'> & {
      iconSprite: string;
      effectSignatureFields: string[];
    }
  >;
  folders: TechnologyFolder[];
  placements: TechnologyPlacement[];
  gridboxes: TechnologyGridbox[];
  edges: TechnologyEdge[];
  categories: TechnologyCategory[];
  doctrineDefinitions: Array<Omit<DoctrineDefinition, 'icon'> & { iconSprite?: string }>;
  unlockTargets: TechnologyUnlockTarget[];
  unlocks: TechnologyUnlock[];
  externalReferences: TechnologyExternalReference[];
  helperCalls: TechnologyHelperCall[];
  unresolved: TechnologyUnresolvedAnalysis[];
  diagnostics: Diagnostic[];
}
