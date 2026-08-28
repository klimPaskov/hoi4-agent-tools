import type { Diagnostic, SourceLocation } from '../core/diagnostics.js';
import type { StoredArtifact } from '../core/artifacts.js';
import type { IndexSkippedSource, SymbolKind } from '../core/index.js';
import type { GuiAnimationSourceManifestDocument } from './animation-manifest.js';

export type GuiSourceKind =
  | 'gui_file'
  | 'gfx_file'
  | 'scripted_gui_file'
  | 'scripted_localisation_file'
  | 'localisation_file'
  | 'gui_element'
  | 'sprite'
  | 'texture'
  | 'font'
  | 'localisation'
  | 'scripted_gui'
  | 'scripted_localisation'
  | 'scripted_effect'
  | 'scripted_trigger'
  | 'context'
  | 'parent_window'
  | 'decision_category'
  | 'animation_source_manifest'
  | 'animation_source_frame';

export type GuiEdgeKind =
  | 'contains'
  | 'parent'
  | 'uses_sprite'
  | 'uses_texture'
  | 'uses_font'
  | 'uses_localisation'
  | 'window'
  | 'context'
  | 'parent_window'
  | 'parent_scripted_gui'
  | 'button_effect'
  | 'button_trigger'
  | 'property_target'
  | 'dynamic_list_template'
  | 'decision_category_entry'
  | 'static_fallback'
  | 'animation_provenance'
  | 'animation_source_frame'
  | 'animation_sheet';

export type GuiPropertyValue =
  string | number | boolean | GuiPropertyValue[] | { [key: string]: GuiPropertyValue };

export interface GuiSourceNode {
  id: string;
  kind: GuiSourceKind;
  name: string;
  path: string;
  location?: SourceLocation;
  metadata: Record<string, GuiPropertyValue>;
}

export interface GuiSourceEdge {
  id: string;
  kind: GuiEdgeKind;
  from: string;
  to: string;
  resolved: boolean;
  partialInventory?: boolean;
  location?: SourceLocation;
  metadata: Record<string, GuiPropertyValue>;
}

export interface GuiSpriteDefinition {
  id: string;
  name: string;
  sourcePath: string;
  location?: SourceLocation;
  spriteType: string;
  texturePath?: string;
  texturePath2?: string;
  frameCount: number;
  frameAnimated: boolean;
  animationRateFps?: number;
  looping?: boolean;
  playOnShow?: boolean;
  pauseOnLoop?: number;
  effectFile?: string;
  staticFallback?: string;
  declaredSize?: GuiSize;
  borderSize?: GuiSize;
  tilingCenter?: boolean;
  horizontal?: boolean;
  steps?: number;
  rawSource: string;
}

export type GuiFontKind = 'outline' | 'bmfont' | 'bitmapfont' | 'unknown';

export interface GuiFontDefinition {
  id: string;
  name: string;
  sourcePath: string;
  location?: SourceLocation;
  kind: GuiFontKind;
  override: boolean;
  languages: string[];
  assetPaths: string[];
  size?: number;
  colour?: string;
  borderColour?: string;
  textColours?: Record<string, string>;
  rawSource?: string;
}

export interface GuiPoint {
  x: number;
  y: number;
}

export interface GuiSize {
  width: number;
  height: number;
}

export interface GuiInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface GuiElementDefinition {
  id: string;
  name: string;
  elementType: string;
  sourcePath: string;
  location?: SourceLocation;
  parentId?: string;
  childIds: string[];
  attributes: Record<string, GuiPropertyValue>;
  unsupportedAttributes: string[];
  rawSource: string;
  definitionOrder: number;
}

export interface ScriptedGuiDefinition {
  id: string;
  name: string;
  sourcePath: string;
  location?: SourceLocation;
  contextType?: string;
  windowName?: string;
  parentWindowToken?: string;
  parentWindowName?: string;
  parentScriptedGui?: string;
  visibleExpression?: string;
  effects: string[];
  effectDefinitions: ScriptedGuiEffectDefinition[];
  triggers: string[];
  triggerDefinitions: ScriptedGuiTriggerDefinition[];
  properties: string[];
  propertyDefinitions: ScriptedGuiPropertyDefinition[];
  dynamicLists: string[];
  dynamicListDefinitions: ScriptedGuiDynamicListDefinition[];
  aiWeights: string[];
  aiEnabled: boolean;
  rawSource: string;
}

export interface ScriptedGuiPropertyDefinition {
  elementName: string;
  attributes: Record<string, GuiPropertyValue>;
  rawSource: string;
  location?: SourceLocation;
}

export interface ScriptedGuiDynamicListDefinition {
  name: string;
  entryContainer?: string;
  countryScopeEntryContainer?: string;
  rawSource: string;
  location?: SourceLocation;
}

export interface ScriptedGuiEffectDefinition {
  name: string;
  elementName: string;
  costs: Record<string, number>;
  rawSource: string;
  location?: SourceLocation;
}

export interface ScriptedGuiTriggerDefinition {
  name: string;
  elementName: string;
  constantResult?: boolean;
  rawSource: string;
  location?: SourceLocation;
}

export interface GuiAnimationSourceManifest extends GuiAnimationSourceManifestDocument {
  id: string;
  sourcePath: string;
  relativePath: string;
  location?: SourceLocation;
}

export interface GuiLocalisationValue {
  key: string;
  language: string;
  value: string;
  sourcePath: string;
  location?: SourceLocation;
}

export interface GuiScriptedLocalisationDefinition {
  id: string;
  name: string;
  sourcePath: string;
  location?: SourceLocation;
  localisationKeys: string[];
  choices: GuiScriptedLocalisationChoice[];
  rawSource: string;
}

export interface GuiScriptedLocalisationChoice {
  localisationKey: string;
  triggerExpression?: string;
  rawSource: string;
}

export interface GuiSourceGraph {
  complete: boolean;
  skippedSourceCount: number;
  skippedSources: readonly IndexSkippedSource[];
  skippedPossibleSymbolKinds: readonly SymbolKind[];
  nodes: GuiSourceNode[];
  edges: GuiSourceEdge[];
  elements: GuiElementDefinition[];
  sprites: GuiSpriteDefinition[];
  fonts: GuiFontDefinition[];
  textColours: Record<string, string>;
  scriptedGuis: ScriptedGuiDefinition[];
  animationSources: GuiAnimationSourceManifest[];
  scriptedLocalisation: GuiScriptedLocalisationDefinition[];
  localisation: GuiLocalisationValue[];
  sourceHashes: Record<string, string>;
  filesScanned: string[];
  diagnostics: Diagnostic[];
}

export type GuiPreviewState =
  | 'normal'
  | 'hover'
  | 'selected'
  | 'locked'
  | 'disabled'
  | 'warning'
  | 'active'
  | 'completed'
  | 'empty-list'
  | 'full-list'
  | 'minimum-value'
  | 'maximum-value'
  | 'long-text'
  | 'missing-localisation';

export interface GuiScenarioExpectations {
  visible: string[];
  hidden: string[];
  containedBy: Record<string, string>;
  centeredOn: Record<string, string>;
}

export interface GuiPreviewScenario {
  id: string;
  description?: string;
  resolution: GuiSize;
  uiScale: number;
  state: GuiPreviewState;
  language: string;
  animationTimeSeconds: number;
  visibleTimeSeconds?: number;
  country?: Record<string, string | number | boolean>;
  stateValues?: Record<string, string | number | boolean>;
  variables: Record<string, number>;
  flags: Record<string, boolean>;
  lists: Record<string, Record<string, string | number | boolean>[]>;
  localisation: Record<string, string>;
  values: Record<string, string | number | boolean>;
  scriptedGui: Record<string, string | number | boolean>;
  visibility: Record<string, boolean>;
  elementStates: Record<string, GuiPreviewState>;
  selectedFrames: Record<string, number>;
  scrollOffsets: Record<string, number>;
  guiCosts: Record<string, number>;
  scriptCosts: Record<string, number>;
  expectations: GuiScenarioExpectations;
}

export interface GuiGeneratedScenarioOptions {
  enabled: boolean;
  count: number;
  seed: string;
  idPrefix: string;
  preservePlaceholder: boolean;
  numericMinimum: number;
  numericMaximum: number;
  integerValues: boolean;
  listRowsMinimum: number;
  listRowsMaximum: number;
  trueProbability: number;
  visibility: 'show-all' | 'varied';
  elementStates: 'normal' | 'varied';
  textSamples: string[];
}

export interface GuiRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GuiTextLayout {
  text: string;
  lines: string[];
  lineWidths: number[];
  lineHeight: number;
  fontSize: number;
  measuredWidth: number;
  measuredHeight: number;
  metricSource: 'fontkit' | 'bmfont' | 'approximation';
  horizontalAlignment: 'left' | 'center' | 'right';
  verticalAlignment: 'top' | 'center' | 'bottom';
  fontName?: string;
  colour?: string;
  borderColour?: string;
  glyphLines: GuiTextGlyphLine[];
  overflowX: boolean;
  overflowY: boolean;
  fixedSize: boolean;
  unresolvedTokens: string[];
  colourRuns?: GuiTextColourRun[][];
  inlineIcons?: GuiTextInlineIcon[];
}

export interface GuiTextInlineIcon {
  token: string;
  spriteName: string;
  lineIndex: number;
  offsetX: number;
  width: number;
  height: number;
  sprite?: GuiTextureFrame;
}

export interface GuiTextColourRun {
  text: string;
  colour: string;
  offsetX: number;
  width: number;
}

export interface GuiOutlineTextGlyph {
  kind: 'outline';
  key: string;
  path: string;
  x: number;
  y: number;
  scale: number;
}

export interface GuiBitmapTextGlyph {
  kind: 'bitmap';
  key: string;
  dataUri: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GuiTextGlyphLine {
  source: 'fontkit-path' | 'bmfont-atlas' | 'deterministic-fallback';
  sourceHash: string;
  width: number;
  baseline: number;
  baselineModelled: boolean;
  glyphs: Array<GuiOutlineTextGlyph | GuiBitmapTextGlyph>;
  missingGlyphs: number[];
}

export interface GuiTextureFrame {
  spriteName: string;
  texturePath: string;
  frame: number;
  frameCount: number;
  width: number;
  height: number;
  dataUri?: string;
  format: string;
  supported: boolean;
  reason?: string;
}

export type GuiSpriteRenderMode = 'stretch' | 'cornered-tile' | 'progressbar' | 'masked-shield';

export interface GuiSceneElement {
  id: string;
  sourceId: string;
  name: string;
  elementType: string;
  parentId?: string;
  depth: number;
  zIndex: number;
  visible: boolean;
  clickable: boolean;
  clickThrough: boolean;
  rect: GuiRect;
  unclippedRect: GuiRect;
  clipRect?: GuiRect;
  clipped: boolean;
  scale: number;
  state: GuiPreviewState;
  progressRatio?: number;
  sprite?: GuiTextureFrame;
  secondarySprite?: GuiTextureFrame;
  spriteRenderMode?: GuiSpriteRenderMode;
  spriteBorderSize?: GuiSize;
  spriteTilingCenter?: boolean;
  progressHorizontal?: boolean;
  text?: GuiTextLayout;
  sourcePath: string;
  location?: SourceLocation;
  unsupportedAttributes: string[];
  rowIndex?: number;
}

export type FidelityCategory =
  'modelled' | 'approximated' | 'ignored' | 'missing' | 'unsupported' | 'unresolved';

export interface FidelityItem {
  field: string;
  detail: string;
  elementId?: string;
  sourcePath?: string;
}

export type FidelityReport = Record<FidelityCategory, FidelityItem[]>;

export interface GuiScene {
  windowName: string;
  scenario: GuiPreviewScenario;
  resolution: GuiSize;
  elements: GuiSceneElement[];
  bounds: GuiRect;
  fidelity: FidelityReport;
  diagnostics: Diagnostic[];
  sourceRevision: string;
}

export type GuiRenderVariant = 'full' | 'cropped' | 'annotated' | 'click-regions' | 'source-map';

export interface GuiRenderedImage {
  variant: GuiRenderVariant;
  svg: string;
  png: Buffer;
  width: number;
  height: number;
}

export interface GuiRenderResult {
  scene: GuiScene;
  images: GuiRenderedImage[];
  hierarchySvg: string;
  layoutJson: string;
  scenarioJson: string;
  diagnostics: Diagnostic[];
  fidelity: FidelityReport;
}

export interface GuiComparisonResult {
  width: number;
  height: number;
  changedPixels: number;
  changedRatio: number;
  png: Buffer;
  json: string;
}

export interface GuiArtifactSet {
  artifacts: StoredArtifact[];
  filesScanned: string[];
  render: GuiRenderResult;
  scenarioScenes: GuiScene[];
  stateScenes: GuiScene[];
  resolutionScenes: GuiScene[];
  comparison: GuiComparisonResult;
  validation: GuiValidationResult;
}

export interface GuiValidationResult {
  diagnostics: Diagnostic[];
  checks: { id: string; passed: boolean; message: string }[];
}

export const fidelityCategories: readonly FidelityCategory[] = [
  'modelled',
  'approximated',
  'ignored',
  'missing',
  'unsupported',
  'unresolved',
];

export function emptyFidelityReport(): FidelityReport {
  return {
    modelled: [],
    approximated: [],
    ignored: [],
    missing: [],
    unsupported: [],
    unresolved: [],
  };
}
