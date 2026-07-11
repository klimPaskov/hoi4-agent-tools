import { compareCodeUnits, deterministicId } from '../core/canonical.js';
import { ServiceError } from '../core/result.js';
import {
  assignments,
  parseClausewitz,
  SOURCE_MAX_BYTES,
  type BlockNode,
} from '../core/source/index.js';
import type { TransactionManager, TransactionManifest } from '../core/transactions.js';
import { z } from 'zod';

const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const guiAttributeKeySchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, 'GUI helper attribute keys must be safe identifiers');
const attributesSchema = z.record(guiAttributeKeySchema, scalarSchema).default({});
const insetSchema = z.union([
  z.number(),
  z
    .object({
      top: z.number().default(0),
      right: z.number().default(0),
      bottom: z.number().default(0),
      left: z.number().default(0),
    })
    .strict(),
]);

export const guiAnchorPoints = [
  'center',
  'center_up',
  'center_upper',
  'center_down',
  'center_lower',
  'center_left',
  'center_right',
  'upper_left',
  'lower_left',
  'upper_right',
  'lower_right',
] as const;

const anchorPointSet = new Set<string>(guiAnchorPoints);

export const guiHelperKinds = [
  'raw',
  'template',
  'anchor',
  'row',
  'column',
  'stack',
  'grid',
  'card',
  'tabs',
  'scroll-list',
  'target-row',
  'meter',
  'status-panel',
  'modal',
  'overlay',
  'element',
] as const;

export type GuiHelperKind = (typeof guiHelperKinds)[number];

export type GuiHelperScalar = string | number | boolean;

export interface GuiHelperStateVariant {
  state: string;
  frame?: number;
  sprite?: string;
  text?: string;
  font?: string;
  attributes?: Record<string, GuiHelperScalar>;
}

export interface GuiHelperNode {
  id: string;
  kind: GuiHelperKind;
  templateId?: string;
  name?: string;
  elementType?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  gap?: number;
  columns?: number;
  padding?: number | { top: number; right: number; bottom: number; left: number };
  margin?: number | { top: number; right: number; bottom: number; left: number };
  orientation?: string;
  origo?: string;
  flow?: 'horizontal' | 'vertical';
  sprite?: string;
  backgroundSprite?: string;
  scrollbar?: string;
  text?: string;
  font?: string;
  state?: string;
  stateVariants?: GuiHelperStateVariant[];
  minValue?: number;
  maxValue?: number;
  value?: number;
  frames?: number;
  attributes?: Record<string, GuiHelperScalar>;
  raw?: string;
  children: GuiHelperNode[];
}

export interface GuiHelperTemplate {
  id: string;
  root: GuiHelperNode;
}

export const GUI_HELPER_MAX_DEPTH = 128;
export const GUI_HELPER_MAX_NODES = 10_000;
export const GUI_HELPER_MAX_TEMPLATES = 1_024;
export const GUI_HELPER_MAX_STATE_VARIANTS = 64;
export const GUI_HELPER_MAX_EXPANDED_IDENTIFIER_BYTES = 1_024;
export const GUI_HELPER_MAX_GENERATED_SOURCE_WORK = SOURCE_MAX_BYTES * 2;
export const GUI_HELPER_MAX_GENERATED_SOURCE_BYTES = SOURCE_MAX_BYTES;

function helperInputRoots(input: unknown): unknown[] {
  if (input === null || typeof input !== 'object') return [];
  const document = input as { root?: unknown; templates?: unknown };
  const roots: unknown[] = document.root === undefined ? [] : [document.root];
  if (!Array.isArray(document.templates)) return roots;
  for (const template of document.templates) {
    if (template !== null && typeof template === 'object' && 'root' in template)
      roots.push((template as { root: unknown }).root);
  }
  return roots;
}

function assertGuiHelperInputBudget(input: unknown): void {
  if (input !== null && typeof input === 'object') {
    const templates = (input as { templates?: unknown }).templates;
    if (Array.isArray(templates) && templates.length > GUI_HELPER_MAX_TEMPLATES) {
      throw new ServiceError(
        'GUI_HELPER_TEMPLATE_BUDGET_BLOCKED',
        'GUI helper input exceeds the fixed template ceiling',
        { templates: templates.length, maximumTemplates: GUI_HELPER_MAX_TEMPLATES },
      );
    }
  }
  const pending = helperInputRoots(input).map((value) => ({ value, depth: 1 }));
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.value === null || typeof current.value !== 'object') continue;
    if (seen.has(current.value)) {
      throw new ServiceError(
        'GUI_HELPER_GRAPH_BLOCKED',
        'GUI helper input must contain independent acyclic trees',
      );
    }
    seen.add(current.value);
    nodes += 1;
    if (nodes > GUI_HELPER_MAX_NODES) {
      throw new ServiceError(
        'GUI_HELPER_NODE_BUDGET_BLOCKED',
        'GUI helper input exceeds the fixed source-node ceiling',
        { nodes, maximumNodes: GUI_HELPER_MAX_NODES, stage: 'source' },
      );
    }
    if (current.depth > GUI_HELPER_MAX_DEPTH) {
      throw new ServiceError(
        'GUI_HELPER_DEPTH_BUDGET_BLOCKED',
        'GUI helper input exceeds the fixed source nesting ceiling',
        { depth: current.depth, maximumDepth: GUI_HELPER_MAX_DEPTH, stage: 'source' },
      );
    }
    const children = (current.value as { children?: unknown }).children;
    if (!Array.isArray(children)) continue;
    for (let index = children.length - 1; index >= 0; index -= 1)
      pending.push({ value: children[index], depth: current.depth + 1 });
  }
}

const GuiHelperStateVariantSchema = z
  .object({
    state: z.string().min(1).max(128),
    frame: z.number().int().min(0).optional(),
    sprite: z.string().min(1).optional(),
    text: z.string().optional(),
    font: z.string().min(1).optional(),
    attributes: attributesSchema,
  })
  .strict()
  .superRefine((variant, context) => {
    if (
      variant.frame === undefined &&
      variant.sprite === undefined &&
      variant.text === undefined &&
      variant.font === undefined &&
      Object.keys(variant.attributes).length === 0
    )
      context.addIssue({
        code: 'custom',
        message: 'A GUI helper state variant must change a frame, sprite, text, font, or attribute',
      });
  });

const GuiHelperNodeSchema: z.ZodType<GuiHelperNode> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1).max(256),
      kind: z.enum(guiHelperKinds),
      templateId: z.string().min(1).max(256).optional(),
      name: z.string().min(1).max(256).optional(),
      elementType: z.string().min(1).max(256).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().nonnegative().optional(),
      height: z.number().nonnegative().optional(),
      gap: z.number().nonnegative().optional(),
      columns: z.number().int().positive().max(GUI_HELPER_MAX_NODES).optional(),
      padding: insetSchema.optional(),
      margin: insetSchema.optional(),
      orientation: z.string().min(1).max(64).optional(),
      origo: z.string().min(1).max(64).optional(),
      flow: z.enum(['horizontal', 'vertical']).optional(),
      sprite: z.string().min(1).optional(),
      backgroundSprite: z.string().min(1).optional(),
      scrollbar: z.string().min(1).optional(),
      text: z.string().optional(),
      font: z.string().min(1).optional(),
      state: z.string().min(1).max(128).optional(),
      stateVariants: z
        .array(GuiHelperStateVariantSchema)
        .max(GUI_HELPER_MAX_STATE_VARIANTS)
        .default([]),
      minValue: z.number().optional(),
      maxValue: z.number().optional(),
      value: z.number().optional(),
      frames: z.number().int().min(2).max(10_000).optional(),
      attributes: attributesSchema,
      raw: z.string().optional(),
      children: z.array(GuiHelperNodeSchema).default([]),
    })
    .strict(),
) as z.ZodType<GuiHelperNode>;

const GuiHelperTemplateSchema = z
  .object({
    id: z.string().min(1).max(256),
    root: GuiHelperNodeSchema,
  })
  .strict();

export const GuiHelperDocumentSchema = z.preprocess(
  (input) => {
    assertGuiHelperInputBudget(input);
    return input;
  },
  z
    .object({
      version: z.literal(1).default(1),
      templates: z.array(GuiHelperTemplateSchema).max(GUI_HELPER_MAX_TEMPLATES).default([]),
      root: GuiHelperNodeSchema,
    })
    .strict(),
);

export interface GuiHelperDocument {
  version: 1;
  templates: GuiHelperTemplate[];
  root: GuiHelperNode;
}

interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface CompiledNode {
  node: GuiHelperNode;
  x: number;
  y: number;
  width: number;
  height: number;
  children: CompiledNode[];
}

export interface GuiHelperCompileResult {
  document: GuiHelperDocument;
  source: string;
  nodeCount: number;
  templateInstanceCount: number;
  rawEscapeCount: number;
}

export interface PlanGuiHelperInput {
  workspaceId: string;
  relativePath: string;
  helper: unknown;
  principal?: string;
  signal?: AbortSignal;
}

function normalizedAnchorPoint(value: string): string {
  return value.toLowerCase();
}

function isAnchorPoint(value: string): boolean {
  return anchorPointSet.has(normalizedAnchorPoint(value));
}

function insets(value: GuiHelperNode['padding']): Insets {
  return typeof value === 'number'
    ? { top: value, right: value, bottom: value, left: value }
    : (value ?? { top: 0, right: 0, bottom: 0, left: 0 });
}

function walkNodes(root: GuiHelperNode): GuiHelperNode[] {
  const output: GuiHelperNode[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    output.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1)
      pending.push(node.children[index]!);
  }
  return output;
}

function assertUniqueNodeIds(root: GuiHelperNode, scope: string): void {
  const seen = new Set<string>();
  for (const node of walkNodes(root)) {
    if (seen.has(node.id))
      throw new ServiceError(
        'GUI_HELPER_DUPLICATE_ID',
        `GUI helper ${scope} contains duplicate node id ${node.id}`,
        { id: node.id, scope },
      );
    seen.add(node.id);
  }
}

function templateReferences(root: GuiHelperNode): string[] {
  return walkNodes(root).flatMap((node) =>
    node.kind === 'template' && node.templateId !== undefined ? [node.templateId] : [],
  );
}

function assertTemplateGraph(document: GuiHelperDocument): Map<string, GuiHelperTemplate> {
  const templates = new Map<string, GuiHelperTemplate>();
  for (const template of document.templates) {
    if (templates.has(template.id))
      throw new ServiceError(
        'GUI_HELPER_TEMPLATE_DUPLICATE',
        `GUI helper template ${template.id} is declared more than once`,
        { templateId: template.id },
      );
    templates.set(template.id, template);
  }
  const assertReferencesExist = (root: GuiHelperNode, scope: string): void => {
    for (const reference of templateReferences(root))
      if (!templates.has(reference))
        throw new ServiceError(
          'GUI_HELPER_TEMPLATE_MISSING',
          `GUI helper ${scope} references missing template ${reference}`,
          { templateId: reference, scope },
        );
  };
  assertReferencesExist(document.root, 'root');
  for (const template of document.templates) assertReferencesExist(template.root, template.id);

  const visiting = new Set<string>();
  const longestPaths = new Map<string, number>();
  const visit = (templateId: string, stack: string[]): number => {
    if (visiting.has(templateId)) {
      const start = stack.indexOf(templateId);
      const cycle = [...stack.slice(Math.max(0, start)), templateId];
      throw new ServiceError(
        'GUI_HELPER_TEMPLATE_CYCLE',
        `GUI helper template cycle: ${cycle.join(' -> ')}`,
        { cycle },
      );
    }
    const cached = longestPaths.get(templateId);
    if (cached !== undefined) {
      if (stack.length + cached > GUI_HELPER_MAX_DEPTH)
        throw new ServiceError(
          'GUI_HELPER_DEPTH_BUDGET_BLOCKED',
          'GUI helper template reference depth exceeds the fixed nesting ceiling',
          {
            depth: stack.length + cached,
            maximumDepth: GUI_HELPER_MAX_DEPTH,
            stage: 'template-graph',
          },
        );
      return cached;
    }
    if (stack.length >= GUI_HELPER_MAX_DEPTH)
      throw new ServiceError(
        'GUI_HELPER_DEPTH_BUDGET_BLOCKED',
        'GUI helper template reference depth exceeds the fixed nesting ceiling',
        { depth: stack.length + 1, maximumDepth: GUI_HELPER_MAX_DEPTH, stage: 'template-graph' },
      );
    visiting.add(templateId);
    const template = templates.get(templateId)!;
    let longestPath = 1;
    for (const dependency of new Set(templateReferences(template.root)))
      longestPath = Math.max(longestPath, 1 + visit(dependency, [...stack, templateId]));
    visiting.delete(templateId);
    if (longestPath > GUI_HELPER_MAX_DEPTH)
      throw new ServiceError(
        'GUI_HELPER_DEPTH_BUDGET_BLOCKED',
        'GUI helper template reference depth exceeds the fixed nesting ceiling',
        {
          depth: longestPath,
          maximumDepth: GUI_HELPER_MAX_DEPTH,
          stage: 'template-graph',
        },
      );
    longestPaths.set(templateId, longestPath);
    return longestPath;
  };
  for (const templateId of templates.keys()) visit(templateId, []);
  return templates;
}

const buttonElementTypes = new Set(['buttonType']);
const iconElementTypes = new Set(['iconType']);
const textElementTypes = new Set(['instantTextBoxType']);
const containerElementTypes = new Set(['containerWindowType', 'windowType']);
const leafElementTypes = new Set([...buttonElementTypes, ...iconElementTypes, ...textElementTypes]);
const supportedElementTypes = new Set([...leafElementTypes, ...containerElementTypes]);
const runtimeButtonStates = new Set(['normal', 'hover', 'pressed', 'disabled']);
const controlledAttributeKeys = new Set(
  [
    'name',
    'position',
    'size',
    'orientation',
    'origo',
    'spriteType',
    'quadTextureSprite',
    'text',
    'font',
    'buttonText',
    'buttonFont',
    'frame',
    'background',
    'minValue',
    'maxValue',
    'startValue',
    'maxWidth',
    'maxHeight',
  ].map((key) => key.toLowerCase()),
);
const scrollListControlledAttributeKeys = new Set(
  [
    'clipping',
    'horizontalScrollbar',
    'verticalScrollbar',
    'scroll_wheel_factor',
    'smooth_scrolling',
    'gridBoxType',
  ].map((key) => key.toLowerCase()),
);
const containerAttributeKeys = new Set(
  ['clipping', 'moveable', 'fullScreen'].map((key) => key.toLowerCase()),
);
const iconAttributeKeys = new Set(
  ['alwaystransparent', 'hint_tag', 'pdx_tooltip', 'pdx_tooltip_delayed', 'centerposition'].map(
    (key) => key.toLowerCase(),
  ),
);
const textAttributeKeys = new Set(
  [
    'format',
    'fixedsize',
    'alwaystransparent',
    'scrollbarType',
    'pdx_tooltip',
    'pdx_tooltip_delayed',
  ].map((key) => key.toLowerCase()),
);
const buttonAttributeKeys = new Set(
  [
    'alwaystransparent',
    'shortcut',
    'clicksound',
    'oversound',
    'hint_tag',
    'pdx_tooltip',
    'pdx_tooltip_delayed',
    'scale',
    'web_link',
  ].map((key) => key.toLowerCase()),
);

function allowedAttributeKeys(node: GuiHelperNode): ReadonlySet<string> | undefined {
  if (node.kind === 'template') return undefined;
  if (node.kind === 'raw') return new Set<string>();
  const elementType = typeFor(node);
  if (containerElementTypes.has(elementType)) return containerAttributeKeys;
  if (iconElementTypes.has(elementType)) return iconAttributeKeys;
  if (textElementTypes.has(elementType)) return textAttributeKeys;
  if (buttonElementTypes.has(elementType)) return buttonAttributeKeys;
  return new Set<string>();
}

function assertStructuredElementFields(
  node: GuiHelperNode,
  elementType: string,
  variant: GuiHelperStateVariant | undefined,
  scope: string,
): void {
  const sprite = variant?.sprite ?? node.sprite;
  const text = variant?.text ?? node.text;
  const font = variant?.font ?? node.font;
  const frame = variant?.frame;
  if (iconElementTypes.has(elementType) && (text !== undefined || font !== undefined))
    throw new ServiceError(
      'GUI_HELPER_ICON_TEXT_UNSUPPORTED',
      `GUI helper icon ${node.id} cannot emit text or font fields`,
      { id: node.id, elementType, state: variant?.state, scope },
    );
  if (textElementTypes.has(elementType) && (sprite !== undefined || frame !== undefined))
    throw new ServiceError(
      'GUI_HELPER_TEXT_SPRITE_UNSUPPORTED',
      `GUI helper text box ${node.id} cannot emit sprite or frame fields`,
      { id: node.id, elementType, state: variant?.state, scope },
    );
  if (
    containerElementTypes.has(elementType) &&
    node.kind !== 'card' &&
    node.kind !== 'modal' &&
    node.kind !== 'meter' &&
    (sprite !== undefined || text !== undefined || font !== undefined || frame !== undefined)
  )
    throw new ServiceError(
      'GUI_HELPER_CONTAINER_FIELDS_UNSUPPORTED',
      `GUI helper container ${node.id} cannot emit sprite, text, font, or frame fields directly`,
      { id: node.id, elementType, state: variant?.state, scope },
    );
  if (
    (node.kind === 'card' || node.kind === 'modal') &&
    (text !== undefined || font !== undefined || frame !== undefined)
  )
    throw new ServiceError(
      'GUI_HELPER_BACKGROUND_STATE_UNSUPPORTED',
      `GUI helper ${node.kind} ${node.id} supports sprite-only background state variants`,
      { id: node.id, state: variant?.state, scope },
    );
  if (node.kind === 'meter' && (text !== undefined || font !== undefined))
    throw new ServiceError(
      'GUI_HELPER_METER_FIELDS_UNSUPPORTED',
      `GUI helper meter ${node.id} supports sprite, frame, and scalar-attribute state changes, but not text or font fields`,
      { id: node.id, state: variant?.state, scope },
    );
}

const kindSpecificFields = [
  ['columns', ['grid']],
  ['flow', ['scroll-list']],
  ['backgroundSprite', ['card', 'scroll-list', 'meter', 'modal']],
  ['scrollbar', ['scroll-list']],
  ['minValue', ['meter']],
  ['maxValue', ['meter']],
  ['value', ['meter']],
  ['frames', ['meter']],
] as const satisfies readonly (readonly [keyof GuiHelperNode, readonly GuiHelperKind[]])[];

function assertNodeSemantics(root: GuiHelperNode, scope: string): void {
  for (const node of walkNodes(root)) {
    const variants = new Set<string>();
    for (const variant of node.stateVariants ?? []) {
      if (variants.has(variant.state))
        throw new ServiceError(
          'GUI_HELPER_STATE_VARIANT_DUPLICATE',
          `GUI helper node ${node.id} declares state ${variant.state} more than once`,
          { id: node.id, state: variant.state, scope },
        );
      variants.add(variant.state);
    }
    if (node.kind === 'template') {
      if (node.templateId === undefined)
        throw new ServiceError(
          'GUI_HELPER_TEMPLATE_ID_MISSING',
          `GUI helper template instance ${node.id} must name templateId`,
          { id: node.id, scope },
        );
      if (node.children.length > 0)
        throw new ServiceError(
          'GUI_HELPER_TEMPLATE_CHILDREN_UNSUPPORTED',
          `GUI helper template instance ${node.id} cannot append children`,
          { id: node.id, scope },
        );
    } else if (node.templateId !== undefined) {
      throw new ServiceError(
        'GUI_HELPER_TEMPLATE_ID_UNEXPECTED',
        `GUI helper node ${node.id} is not a template instance but declares templateId`,
        { id: node.id, scope },
      );
    }
    if (node.kind !== 'template')
      for (const [field, allowedKinds] of kindSpecificFields)
        if (
          node[field] !== undefined &&
          !(allowedKinds as readonly GuiHelperKind[]).includes(node.kind)
        )
          throw new ServiceError(
            'GUI_HELPER_FIELD_UNSUPPORTED',
            `GUI helper ${node.kind} node ${node.id} cannot use ${field}`,
            { id: node.id, kind: node.kind, field, allowedKinds, scope },
          );
    if (node.kind === 'raw' && node.raw === undefined)
      throw new ServiceError(
        'GUI_HELPER_RAW_MISSING',
        `GUI helper raw node ${node.id} must provide raw source`,
        { id: node.id, scope },
      );
    if ((node.kind === 'raw' || node.kind === 'meter') && node.children.length > 0)
      throw new ServiceError(
        'GUI_HELPER_CHILDREN_UNSUPPORTED',
        `GUI helper ${node.kind} node ${node.id} cannot contain children`,
        { id: node.id, kind: node.kind, scope },
      );
    if (node.kind === 'anchor') {
      for (const [field, value] of [
        ['orientation', node.orientation ?? 'upper_left'],
        ['origo', node.origo ?? 'upper_left'],
      ] as const)
        if (!isAnchorPoint(value))
          throw new ServiceError(
            'GUI_HELPER_ANCHOR_POINT_INVALID',
            `GUI helper anchor ${node.id} has invalid ${field} ${value}`,
            { id: node.id, field, value, scope },
          );
    } else if (node.orientation !== undefined && !isAnchorPoint(node.orientation)) {
      throw new ServiceError(
        'GUI_HELPER_ORIENTATION_INVALID',
        `GUI helper node ${node.id} has invalid orientation ${node.orientation}`,
        { id: node.id, value: node.orientation, scope },
      );
    }
    if (node.kind !== 'anchor' && node.origo !== undefined && !isAnchorPoint(node.origo)) {
      throw new ServiceError(
        'GUI_HELPER_ORIGO_INVALID',
        `GUI helper node ${node.id} has invalid origo ${node.origo}`,
        { id: node.id, value: node.origo, scope },
      );
    }
    if (node.kind === 'meter') {
      const minimum = node.minValue ?? 0;
      const maximum = node.maxValue ?? 100;
      const value = node.value ?? minimum;
      if (
        maximum <= minimum ||
        value < minimum ||
        value > maximum ||
        node.sprite === undefined ||
        node.frames === undefined ||
        node.width === undefined ||
        node.width <= 0 ||
        node.height === undefined ||
        node.height <= 0 ||
        (node.stateVariants ?? []).some(({ frame }) => frame !== undefined && frame > node.frames!)
      )
        throw new ServiceError(
          'GUI_HELPER_METER_RANGE_INVALID',
          `GUI helper meter ${node.id} requires positive layout dimensions, a sprite with at least two frames, minValue < maxValue, and minValue <= value <= maxValue`,
          {
            id: node.id,
            minValue: minimum,
            maxValue: maximum,
            value,
            sprite: node.sprite,
            frames: node.frames,
            scope,
          },
        );
    }
    if (node.kind === 'scroll-list') {
      if (
        node.children.length !== 1 ||
        node.backgroundSprite === undefined ||
        node.scrollbar === undefined ||
        node.width === undefined ||
        node.width <= 0 ||
        node.height === undefined ||
        node.height <= 0
      )
        throw new ServiceError(
          'GUI_HELPER_SCROLL_LIST_BINDING_INCOMPLETE',
          `GUI helper scroll-list ${node.id} requires width, height, backgroundSprite, scrollbar, and exactly one entry-container child`,
          { id: node.id, children: node.children.length, scope },
        );
      const entryNode = node.children[0]!;
      const entryType = typeFor(entryNode);
      if (
        entryNode.kind !== 'template' &&
        (entryNode.kind === 'raw' || !containerElementTypes.has(entryType))
      )
        throw new ServiceError(
          'GUI_HELPER_SCROLL_ENTRY_INVALID',
          `GUI helper scroll-list ${node.id} entry must compile to a container`,
          { id: node.id, entryKind: entryNode.kind, entryType, scope },
        );
    }
    if (node.kind !== 'template' && node.elementType !== undefined && node.kind !== 'element')
      throw new ServiceError(
        'GUI_HELPER_ELEMENT_TYPE_UNEXPECTED',
        `GUI helper ${node.kind} node ${node.id} cannot override elementType`,
        { id: node.id, kind: node.kind, scope },
      );
    if (node.kind !== 'template' && node.kind !== 'raw') {
      if (
        node.kind === 'element' &&
        node.elementType === undefined &&
        node.sprite !== undefined &&
        (node.text !== undefined || node.font !== undefined)
      )
        throw new ServiceError(
          'GUI_HELPER_ELEMENT_FIELDS_AMBIGUOUS',
          `GUI helper element ${node.id} combines icon and text fields without an explicit buttonType`,
          { id: node.id, scope },
        );
      const elementType = typeFor(node);
      if (!supportedElementTypes.has(elementType))
        throw new ServiceError(
          'GUI_HELPER_ELEMENT_TYPE_UNSUPPORTED',
          `GUI helper node ${node.id} uses unsupported structured element type ${elementType}; use a raw node for advanced types`,
          { id: node.id, elementType, scope },
        );
      if (leafElementTypes.has(elementType) && node.children.length > 0)
        throw new ServiceError(
          'GUI_HELPER_LEAF_CHILDREN_UNSUPPORTED',
          `GUI helper leaf element ${node.id} cannot contain child GUI elements`,
          { id: node.id, elementType, children: node.children.length, scope },
        );
      if (leafElementTypes.has(elementType) && node.origo !== undefined)
        throw new ServiceError(
          'GUI_HELPER_LEAF_ORIGO_UNSUPPORTED',
          `GUI helper leaf element ${node.id} cannot use container-only origo`,
          { id: node.id, elementType, origo: node.origo, scope },
        );
      const selected = node.stateVariants?.find(({ state }) => state === node.state);
      if (
        node.state !== undefined &&
        selected === undefined &&
        !(buttonElementTypes.has(elementType) && runtimeButtonStates.has(node.state))
      )
        throw new ServiceError(
          'GUI_HELPER_STATE_VARIANT_MISSING',
          `GUI helper node ${node.id} selects state ${node.state} without an explicit variant`,
          { id: node.id, state: node.state, elementType, scope },
        );
      assertStructuredElementFields(node, elementType, undefined, scope);
      for (const variant of node.stateVariants ?? [])
        assertStructuredElementFields(node, elementType, variant, scope);
    }
    const attributeCasing = new Map<string, string>();
    const allowedAttributes = allowedAttributeKeys(node);
    for (const [owner, attributes] of [
      ['node', node.attributes ?? {}],
      ...(node.stateVariants ?? []).map(
        (variant) => [`state ${variant.state}`, variant.attributes ?? {}] as const,
      ),
    ] as const)
      for (const key of Object.keys(attributes)) {
        const normalizedKey = key.toLowerCase();
        const previousCasing = attributeCasing.get(normalizedKey);
        if (previousCasing !== undefined && previousCasing !== key)
          throw new ServiceError(
            'GUI_HELPER_ATTRIBUTE_CASE_CONFLICT',
            `GUI helper node ${node.id} uses conflicting casing for attribute ${key}`,
            { id: node.id, key, previousCasing, owner, scope },
          );
        attributeCasing.set(normalizedKey, key);
        if (
          controlledAttributeKeys.has(normalizedKey) ||
          (node.kind === 'scroll-list' && scrollListControlledAttributeKeys.has(normalizedKey))
        )
          throw new ServiceError(
            'GUI_HELPER_CONTROLLED_ATTRIBUTE',
            `GUI helper node ${node.id} must express ${key} through its structured fields or raw escape hatch`,
            { id: node.id, key, owner, scope },
          );
        if (allowedAttributes !== undefined && !allowedAttributes.has(normalizedKey))
          throw new ServiceError(
            'GUI_HELPER_ATTRIBUTE_UNSUPPORTED',
            `GUI helper node ${node.id} cannot emit unsupported scalar attribute ${key}`,
            { id: node.id, key, owner, elementType: typeFor(node), scope },
          );
      }
  }
}

function mergeStateVariants(
  base: readonly GuiHelperStateVariant[],
  overrides: readonly GuiHelperStateVariant[],
): GuiHelperStateVariant[] {
  const variants = new Map(base.map((variant) => [variant.state, variant]));
  for (const variant of overrides) variants.set(variant.state, variant);
  return [...variants.values()].sort((left, right) => compareCodeUnits(left.state, right.state));
}

const templateOverrideKeys = [
  'elementType',
  'x',
  'y',
  'width',
  'height',
  'gap',
  'columns',
  'padding',
  'margin',
  'orientation',
  'origo',
  'flow',
  'sprite',
  'backgroundSprite',
  'scrollbar',
  'text',
  'font',
  'state',
  'minValue',
  'maxValue',
  'value',
  'frames',
  'raw',
] as const satisfies readonly (keyof GuiHelperNode)[];

interface ExpansionContext {
  templates: ReadonlyMap<string, GuiHelperTemplate>;
  expandedNodes: number;
  templateInstances: number;
}

function boundedExpandedIdentifier(
  prefix: string | undefined,
  value: string,
  owner: string,
): string {
  const expanded = prefix === undefined ? value : `${prefix}__${value}`;
  const bytes = Buffer.byteLength(expanded, 'utf8');
  if (bytes > GUI_HELPER_MAX_EXPANDED_IDENTIFIER_BYTES)
    throw new ServiceError(
      'GUI_HELPER_IDENTIFIER_BUDGET_BLOCKED',
      `Expanded GUI helper identifier for ${owner} exceeds the fixed byte ceiling`,
      {
        owner,
        bytes,
        maximumBytes: GUI_HELPER_MAX_EXPANDED_IDENTIFIER_BYTES,
      },
    );
  return expanded;
}

function applyTemplateOverrides(
  expanded: GuiHelperNode,
  instance: GuiHelperNode,
  prefix: string,
): GuiHelperNode {
  const stateVariants = mergeStateVariants(
    expanded.stateVariants ?? [],
    instance.stateVariants ?? [],
  );
  if (stateVariants.length > GUI_HELPER_MAX_STATE_VARIANTS)
    throw new ServiceError(
      'GUI_HELPER_STATE_VARIANT_BUDGET_BLOCKED',
      `GUI helper template instance ${instance.id} exceeds the expanded state-variant ceiling`,
      {
        id: instance.id,
        stateVariants: stateVariants.length,
        maximumStateVariants: GUI_HELPER_MAX_STATE_VARIANTS,
      },
    );
  const result: GuiHelperNode = {
    ...expanded,
    ...(instance.name === undefined
      ? {}
      : { name: boundedExpandedIdentifier(prefix, instance.name, `template ${instance.id} name`) }),
    attributes: { ...(expanded.attributes ?? {}), ...(instance.attributes ?? {}) },
    stateVariants,
  };
  for (const key of templateOverrideKeys) {
    const value = instance[key];
    if (value !== undefined) (result as unknown as Record<string, unknown>)[key] = value;
  }
  return result;
}

function expandNode(
  node: GuiHelperNode,
  context: ExpansionContext,
  prefix: string | undefined,
  templateStack: readonly string[],
  depth: number,
): GuiHelperNode {
  if (node.kind === 'template') {
    const templateId = node.templateId!;
    const template = context.templates.get(templateId)!;
    if (templateStack.includes(templateId)) {
      const cycle = [...templateStack, templateId];
      throw new ServiceError(
        'GUI_HELPER_TEMPLATE_CYCLE',
        `GUI helper template cycle: ${cycle.join(' -> ')}`,
        { cycle },
      );
    }
    context.templateInstances += 1;
    const instancePrefix = boundedExpandedIdentifier(prefix, node.id, `template ${node.id}`);
    const expanded = expandNode(
      template.root,
      context,
      instancePrefix,
      [...templateStack, templateId],
      depth,
    );
    return applyTemplateOverrides(expanded, node, instancePrefix);
  }
  if (depth > GUI_HELPER_MAX_DEPTH)
    throw new ServiceError(
      'GUI_HELPER_DEPTH_BUDGET_BLOCKED',
      'Expanded GUI helper tree exceeds the fixed nesting ceiling',
      { depth, maximumDepth: GUI_HELPER_MAX_DEPTH, stage: 'expanded' },
    );
  context.expandedNodes += 1;
  if (context.expandedNodes > GUI_HELPER_MAX_NODES)
    throw new ServiceError(
      'GUI_HELPER_NODE_BUDGET_BLOCKED',
      'Expanded GUI helper tree exceeds the fixed node ceiling',
      {
        nodes: context.expandedNodes,
        maximumNodes: GUI_HELPER_MAX_NODES,
        stage: 'expanded',
      },
    );
  const expandedId = boundedExpandedIdentifier(prefix, node.id, `node ${node.id}`);
  const expandedName =
    node.name === undefined
      ? undefined
      : boundedExpandedIdentifier(prefix, node.name, `node ${node.id} name`);
  return {
    ...node,
    id: expandedId,
    ...(expandedName === undefined ? {} : { name: expandedName }),
    children: node.children.map((child) =>
      expandNode(child, context, prefix, templateStack, depth + 1),
    ),
  };
}

function expandDocument(document: GuiHelperDocument): {
  root: GuiHelperNode;
  nodeCount: number;
  templateInstanceCount: number;
} {
  assertUniqueNodeIds(document.root, 'root');
  for (const template of document.templates) {
    assertUniqueNodeIds(template.root, `template ${template.id}`);
    assertNodeSemantics(template.root, `template ${template.id}`);
  }
  assertNodeSemantics(document.root, 'root');
  const templates = assertTemplateGraph(document);
  const context: ExpansionContext = { templates, expandedNodes: 0, templateInstances: 0 };
  const root = expandNode(document.root, context, undefined, [], 1);
  assertUniqueNodeIds(root, 'expanded tree');
  assertNodeSemantics(root, 'expanded tree');
  if (root.kind !== 'raw' && !containerElementTypes.has(typeFor(root)))
    throw new ServiceError(
      'GUI_HELPER_ROOT_INVALID',
      'A structured GUI helper root must compile to a container; use a container helper or an explicit raw root',
      { id: root.id, kind: root.kind, elementType: typeFor(root) },
    );
  return {
    root,
    nodeCount: context.expandedNodes,
    templateInstanceCount: context.templateInstances,
  };
}

function typeFor(node: GuiHelperNode): string {
  if (node.elementType !== undefined) return node.elementType;
  if (node.kind === 'modal') return 'windowType';
  if (
    node.kind === 'element' &&
    node.sprite !== undefined &&
    node.text === undefined &&
    node.font === undefined
  )
    return 'iconType';
  if (
    node.kind === 'element' &&
    node.sprite === undefined &&
    (node.text !== undefined || node.font !== undefined)
  )
    return 'instantTextBoxType';
  return 'containerWindowType';
}

function positioned(compiled: CompiledNode, x: number, y: number): CompiledNode {
  return { ...compiled, x, y };
}

function layoutHelper(node: GuiHelperNode, forcedWidth?: number): CompiledNode {
  const padding = insets(node.padding);
  const ownX = node.x ?? 0;
  const ownY = node.y ?? 0;
  const requestedWidth = node.width ?? forcedWidth;
  const gap = node.gap ?? 0;
  const children: CompiledNode[] = [];
  const flow =
    node.kind === 'row' || node.kind === 'target-row' || node.kind === 'tabs'
      ? 'horizontal'
      : node.kind === 'column' || node.kind === 'status-panel'
        ? 'vertical'
        : node.kind === 'scroll-list'
          ? (node.flow ?? 'vertical')
          : 'stack';

  if (node.kind === 'grid') {
    const columns = Math.max(1, node.columns ?? 1);
    const cellWidth =
      requestedWidth === undefined
        ? undefined
        : Math.max(
            0,
            (requestedWidth - padding.left - padding.right - gap * (columns - 1)) / columns,
          );
    const entries = node.children.map((child, index) => {
      const margin = insets(child.margin);
      const width =
        cellWidth === undefined || child.width !== undefined
          ? undefined
          : Math.max(0, cellWidth - margin.left - margin.right);
      return {
        child,
        index,
        margin,
        compiled: layoutHelper(child, width),
        column: index % columns,
        row: Math.floor(index / columns),
      };
    });
    const rowCount = entries.reduce((maximum, entry) => Math.max(maximum, entry.row + 1), 0);
    const usedColumns = Math.min(columns, entries.length);
    const columnWidths = Array.from({ length: usedColumns }, () => cellWidth ?? 0);
    const rowHeights = Array.from({ length: rowCount }, () => 0);
    for (const entry of entries) {
      if (cellWidth === undefined)
        columnWidths[entry.column] = Math.max(
          columnWidths[entry.column]!,
          entry.margin.left + entry.compiled.x + entry.compiled.width + entry.margin.right,
        );
      rowHeights[entry.row] = Math.max(
        rowHeights[entry.row]!,
        entry.margin.top + entry.compiled.y + entry.compiled.height + entry.margin.bottom,
      );
    }
    let columnOffset = 0;
    const columnOffsets = columnWidths.map((width) => {
      const offset = columnOffset;
      columnOffset += width + gap;
      return offset;
    });
    let rowOffset = 0;
    const rowOffsets = rowHeights.map((height) => {
      const offset = rowOffset;
      rowOffset += height + gap;
      return offset;
    });
    for (const entry of entries) {
      children.push(
        positioned(
          entry.compiled,
          padding.left + columnOffsets[entry.column]! + entry.margin.left + entry.compiled.x,
          padding.top + rowOffsets[entry.row]! + entry.margin.top + entry.compiled.y,
        ),
      );
    }
  } else {
    let cursorX = padding.left;
    let cursorY = padding.top;
    for (const child of node.children) {
      const margin = insets(child.margin);
      const compiled = layoutHelper(child);
      const x =
        flow === 'horizontal'
          ? cursorX + margin.left + compiled.x
          : padding.left + margin.left + compiled.x;
      const y =
        flow === 'vertical'
          ? cursorY + margin.top + compiled.y
          : padding.top + margin.top + compiled.y;
      children.push(positioned(compiled, x, y));
      if (flow === 'horizontal')
        cursorX += margin.left + compiled.x + compiled.width + margin.right + gap;
      if (flow === 'vertical')
        cursorY += margin.top + compiled.y + compiled.height + margin.bottom + gap;
    }
  }

  const inferredWidth =
    children.length === 0
      ? 0
      : Math.max(
          ...children.map(
            (child, index) => child.x + child.width + insets(node.children[index]?.margin).right,
          ),
        ) + padding.right;
  const inferredHeight =
    children.length === 0
      ? 0
      : Math.max(
          ...children.map(
            (child, index) => child.y + child.height + insets(node.children[index]?.margin).bottom,
          ),
        ) + padding.bottom;
  return {
    node,
    x: ownX,
    y: ownY,
    width: requestedWidth ?? inferredWidth,
    height: node.height ?? inferredHeight,
    children,
  };
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function scalar(value: GuiHelperScalar): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number')
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
  return /^[A-Za-z0-9_@.:-]+$/u.test(value) ? value : quote(value);
}

function indentRaw(raw: string, depth: number): string {
  const indentation = '\t'.repeat(depth);
  return raw
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => `${indentation}${line}`)
    .join('\n');
}

function selectedStateVariant(node: GuiHelperNode): GuiHelperStateVariant | undefined {
  if (node.state === undefined) return undefined;
  return node.stateVariants?.find(({ state }) => state === node.state);
}

interface CompiledSource {
  inline: string;
  hoisted: string[];
}

function backgroundLines(name: string, sprite: string, childIndentation: string): string[] {
  const backgroundName = boundedExpandedIdentifier(
    undefined,
    `${name}__background`,
    `${name} background`,
  );
  return [
    `${childIndentation}background = {`,
    `${childIndentation}\tname = ${quote(backgroundName)}`,
    `${childIndentation}\tspriteType = ${scalar(sprite)}`,
    `${childIndentation}}`,
  ];
}

function compileNode(compiled: CompiledNode, depth: number): CompiledSource {
  const { node } = compiled;
  if (node.kind === 'raw') return { inline: indentRaw(node.raw!, depth), hoisted: [] };
  if (node.kind === 'template')
    throw new ServiceError(
      'GUI_HELPER_TEMPLATE_UNEXPANDED',
      `GUI helper template instance ${node.id} reached source compilation`,
    );
  const indentation = '\t'.repeat(depth);
  const childIndentation = '\t'.repeat(depth + 1);
  const name = node.name ?? node.id;
  const state = selectedStateVariant(node);
  const attributes: Record<string, GuiHelperScalar> = {
    ...(node.attributes ?? {}),
    ...(state?.attributes ?? {}),
  };
  const requestedOrientation =
    node.kind === 'anchor'
      ? (node.orientation ?? 'upper_left')
      : node.kind === 'modal'
        ? (node.orientation ?? 'center')
        : (node.orientation ?? 'upper_left');
  const requestedOrigo =
    node.kind === 'anchor'
      ? (node.origo ?? 'upper_left')
      : node.kind === 'modal'
        ? (node.origo ?? 'center')
        : node.origo;
  const orientation = normalizedAnchorPoint(requestedOrientation);
  const origo = requestedOrigo === undefined ? undefined : normalizedAnchorPoint(requestedOrigo);
  const sprite = state?.sprite ?? node.sprite;
  const text = state?.text ?? node.text;
  const font = state?.font ?? node.font;
  const frame = state?.frame;
  const elementType = typeFor(node);
  const lines = [
    `${indentation}${elementType} = {`,
    `${childIndentation}name = ${quote(name)}`,
    `${childIndentation}position = { x = ${scalar(compiled.x)} y = ${scalar(compiled.y)} }`,
  ];
  if (containerElementTypes.has(elementType))
    lines.push(
      `${childIndentation}size = { width = ${scalar(compiled.width)} height = ${scalar(compiled.height)} }`,
    );
  if (textElementTypes.has(elementType)) {
    if (compiled.width > 0) lines.push(`${childIndentation}maxWidth = ${scalar(compiled.width)}`);
    if (compiled.height > 0)
      lines.push(`${childIndentation}maxHeight = ${scalar(compiled.height)}`);
  }
  lines.push(`${childIndentation}orientation = ${scalar(orientation)}`);
  if (origo !== undefined) lines.push(`${childIndentation}origo = ${scalar(origo)}`);
  if (node.kind === 'card' || node.kind === 'modal') {
    const background = state?.sprite ?? node.backgroundSprite ?? node.sprite;
    if (background !== undefined)
      lines.push(...backgroundLines(name, background, childIndentation));
  } else if (iconElementTypes.has(elementType) && sprite !== undefined) {
    lines.push(`${childIndentation}spriteType = ${scalar(sprite)}`);
  } else if (buttonElementTypes.has(elementType) && sprite !== undefined) {
    lines.push(`${childIndentation}spriteType = ${scalar(sprite)}`);
  }
  if (textElementTypes.has(elementType)) {
    if (text !== undefined) lines.push(`${childIndentation}text = ${scalar(text)}`);
    if (font !== undefined) lines.push(`${childIndentation}font = ${scalar(font)}`);
  }
  if (buttonElementTypes.has(elementType)) {
    if (text !== undefined) lines.push(`${childIndentation}buttonText = ${scalar(text)}`);
    if (font !== undefined) lines.push(`${childIndentation}buttonFont = ${scalar(font)}`);
  }
  if (
    (iconElementTypes.has(elementType) || buttonElementTypes.has(elementType)) &&
    frame !== undefined
  )
    lines.push(`${childIndentation}frame = ${scalar(frame)}`);
  if (node.kind === 'scroll-list') {
    const horizontal = node.flow === 'horizontal';
    const scrollbarKey = horizontal ? 'horizontalScrollbar' : 'verticalScrollbar';
    const entry = compiled.children[0]!;
    const gridName = boundedExpandedIdentifier(undefined, `${name}__grid`, `${name} grid`);
    if (entry.width <= 0 || entry.height <= 0)
      throw new ServiceError(
        'GUI_HELPER_SCROLL_ENTRY_INVALID',
        `GUI helper scroll-list ${node.id} entry must have positive inferred or explicit dimensions`,
        { id: node.id, entryWidth: entry.width, entryHeight: entry.height },
      );
    const slotWidth = entry.width + (horizontal ? (node.gap ?? 0) : 0);
    const slotHeight = entry.height + (horizontal ? 0 : (node.gap ?? 0));
    lines.push(
      ...backgroundLines(name, node.backgroundSprite!, childIndentation),
      `${childIndentation}clipping = yes`,
      `${childIndentation}${scrollbarKey} = ${scalar(node.scrollbar!)}`,
      `${childIndentation}scroll_wheel_factor = 40`,
      `${childIndentation}smooth_scrolling = yes`,
      `${childIndentation}gridBoxType = {`,
      `${childIndentation}\tname = ${quote(gridName)}`,
      `${childIndentation}\tposition = { x = 0 y = 0 }`,
      `${childIndentation}\torientation = upper_left`,
      `${childIndentation}\tsize = { width = ${scalar(compiled.width)} height = ${scalar(compiled.height)} }`,
      `${childIndentation}\tslotsize = { width = ${scalar(slotWidth)} height = ${scalar(slotHeight)} }`,
      `${childIndentation}\tformat = upper_left`,
      horizontal
        ? `${childIndentation}\tmax_slots_vertical = 1`
        : `${childIndentation}\tmax_slots_horizontal = 1`,
      `${childIndentation}}`,
    );
  }
  if (node.kind === 'meter') {
    const minimum = node.minValue ?? 0;
    const maximum = node.maxValue ?? 100;
    const value = node.value ?? minimum;
    const ratio = (value - minimum) / (maximum - minimum);
    const meterFrame = state?.frame ?? 1 + Math.round(ratio * (node.frames! - 1));
    const fillSprite = state?.sprite ?? node.sprite!;
    const fillName = boundedExpandedIdentifier(undefined, `${name}__fill`, `${name} meter fill`);
    if (node.backgroundSprite !== undefined)
      lines.push(...backgroundLines(name, node.backgroundSprite, childIndentation));
    lines.push(
      `${childIndentation}iconType = {`,
      `${childIndentation}\tname = ${quote(fillName)}`,
      `${childIndentation}\tposition = { x = 0 y = 0 }`,
      `${childIndentation}\torientation = upper_left`,
      `${childIndentation}\tspriteType = ${scalar(fillSprite)}`,
      `${childIndentation}\tframe = ${scalar(meterFrame)}`,
      `${childIndentation}}`,
    );
  }
  if (
    node.kind === 'overlay' &&
    !Object.keys(attributes).some((key) => key.toLowerCase() === 'clipping')
  )
    lines.push(`${childIndentation}clipping = no`);
  for (const [key, value] of Object.entries(attributes).sort(([left], [right]) =>
    compareCodeUnits(left, right),
  ))
    lines.push(`${childIndentation}${key} = ${scalar(value)}`);
  if (node.raw !== undefined) lines.push(indentRaw(node.raw, depth + 1));
  const hoisted: string[] = [];
  if (node.kind === 'scroll-list') {
    const entry = compiled.children[0]!;
    const entryName = boundedExpandedIdentifier(undefined, `${name}__entry`, `${name} entry`);
    const entrySource = compileNode(
      {
        ...entry,
        x: 0,
        y: 0,
        node: { ...entry.node, name: entryName },
      },
      1,
    );
    hoisted.push(entrySource.inline, ...entrySource.hoisted);
  } else {
    for (const child of compiled.children) {
      const source = compileNode(child, depth + 1);
      if (source.inline.length > 0) lines.push(source.inline);
      hoisted.push(...source.hoisted);
    }
  }
  lines.push(`${indentation}}`);
  return { inline: lines.join('\n'), hoisted };
}

function countRaw(root: GuiHelperNode): number {
  return walkNodes(root).filter(({ raw }) => raw !== undefined).length;
}

function assertGeneratedSourceWork(root: GuiHelperNode): void {
  const pending = [{ node: root, depth: 1 }];
  let work = 256;
  const spend = (amount: number): void => {
    work += amount;
    if (work > GUI_HELPER_MAX_GENERATED_SOURCE_WORK)
      throw new ServiceError(
        'GUI_HELPER_SOURCE_WORK_BUDGET_BLOCKED',
        'Expanded GUI helper source exceeds the fixed pre-compilation work ceiling',
        { work, maximumWork: GUI_HELPER_MAX_GENERATED_SOURCE_WORK },
      );
  };
  const spendString = (value: string | undefined): void => {
    if (value !== undefined) spend(Buffer.byteLength(value, 'utf8') * 8 + 64);
  };
  const spendAttributes = (attributes: Record<string, GuiHelperScalar> | undefined): void => {
    for (const [key, value] of Object.entries(attributes ?? {})) {
      spendString(key);
      if (typeof value === 'string') spendString(value);
      else spend(64);
    }
  };
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    spend(384 + depth * 32);
    for (const value of [
      node.id,
      node.name,
      node.elementType,
      node.orientation,
      node.origo,
      node.sprite,
      node.backgroundSprite,
      node.scrollbar,
      node.text,
      node.font,
      node.state,
    ])
      spendString(value);
    spendAttributes(node.attributes);
    for (const variant of node.stateVariants ?? []) {
      spendString(variant.state);
      spendString(variant.sprite);
      spendString(variant.text);
      spendString(variant.font);
      spendAttributes(variant.attributes);
      spend(64);
    }
    if (node.raw !== undefined) {
      spend(Buffer.byteLength(node.raw, 'utf8'));
      let lineCount = 1;
      for (let index = 0; index < node.raw.length; index += 1)
        if (node.raw.charCodeAt(index) === 10) lineCount += 1;
      spend((depth + 1) * lineCount);
    }
    if (node.kind === 'scroll-list' || node.kind === 'meter') spend(1_024);
    for (let index = node.children.length - 1; index >= 0; index -= 1)
      pending.push({ node: node.children[index]!, depth: depth + 1 });
  }
}

function assertUniqueCompiledNames(source: string): void {
  const document = parseClausewitz(Buffer.from(source), 'generated:gui-helper.gui');
  const blocking = document.diagnostics.filter(
    ({ severity }) => severity === 'error' || severity === 'blocker',
  );
  if (blocking.length > 0)
    throw new ServiceError(
      'GUI_HELPER_GENERATED_SOURCE_INVALID',
      'GUI helper compilation produced malformed explicit GUI source',
      { diagnosticCodes: blocking.map(({ code }) => code) },
    );
  const pending: BlockNode[] = [document.root];
  const names = new Set<string>();
  while (pending.length > 0) {
    const block = pending.pop()!;
    for (const assignment of assignments(block)) {
      if (assignment.value.type !== 'block') continue;
      pending.push(assignment.value);
      const name = assignments(assignment.value).find(
        (child) => child.key.value.toLowerCase() === 'name' && child.value.type === 'scalar',
      )?.value;
      if (name === undefined) continue;
      const nameValue = name.type === 'scalar' ? name.value : undefined;
      if (nameValue === undefined) continue;
      if (names.has(nameValue))
        throw new ServiceError(
          'GUI_HELPER_DUPLICATE_NAME',
          `GUI helper compilation produced duplicate GUI name ${nameValue}`,
          { name: nameValue },
        );
      names.add(nameValue);
    }
  }
}

export function assertGuiHelperGeneratedSourceBytes(
  source: string,
  maximumBytes = GUI_HELPER_MAX_GENERATED_SOURCE_BYTES,
): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new Error('GUI helper generated-source byte limit must be a non-negative safe integer');
  const sourceBytes = Buffer.byteLength(source, 'utf8');
  if (sourceBytes > maximumBytes)
    throw new ServiceError(
      'GUI_HELPER_SOURCE_BYTE_BUDGET_BLOCKED',
      'Compiled GUI helper source exceeds the Clausewitz parser byte ceiling',
      { sourceBytes, maximumBytes },
    );
}

export function compileGuiHelpers(input: unknown): GuiHelperCompileResult {
  const document = GuiHelperDocumentSchema.parse(input);
  const expanded = expandDocument(document);
  assertGeneratedSourceWork(expanded.root);
  const compiled = layoutHelper(expanded.root);
  const compiledSource = compileNode(compiled, 1);
  const source = `# Generated as explicit HOI4 GUI source; the game has no dependency on hoi4-agent-tools.\nguiTypes = {\n${[compiledSource.inline, ...compiledSource.hoisted].join('\n')}\n}\n`;
  assertGuiHelperGeneratedSourceBytes(source);
  assertUniqueCompiledNames(source);
  return {
    document,
    source,
    nodeCount: expanded.nodeCount,
    templateInstanceCount: expanded.templateInstanceCount,
    rawEscapeCount: countRaw(expanded.root),
  };
}

export async function planGuiHelperCompilation(
  transactions: TransactionManager,
  input: PlanGuiHelperInput,
): Promise<{ transaction: TransactionManifest; compilation: GuiHelperCompileResult }> {
  input.signal?.throwIfAborted();
  if (!input.relativePath.replaceAll('\\', '/').toLowerCase().endsWith('.gui'))
    throw new Error('GUI helper output must target a .gui file.');
  const compilation = compileGuiHelpers(input.helper);
  const operationId = deterministicId('gui_helper_compile', {
    relativePath: input.relativePath,
    source: compilation.source,
  });
  const transaction = await transactions.plan({
    workspaceId: input.workspaceId,
    ...(input.principal === undefined ? {} : { principal: input.principal }),
    operationKind: 'gui-helper-compilation',
    operations: [
      {
        id: operationId,
        kind: 'compile-gui-helper',
        summary: `Compile declarative GUI helper to ${input.relativePath}`,
        data: {
          relativePath: input.relativePath,
          nodeCount: compilation.nodeCount,
          templateInstanceCount: compilation.templateInstanceCount,
          rawEscapeCount: compilation.rawEscapeCount,
        },
      },
    ],
    changes: [
      {
        relativePath: input.relativePath,
        content: Buffer.from(compilation.source, 'utf8'),
        operationIds: [operationId],
        mediaType: 'text/plain',
      },
    ],
    validate: (proposed) => {
      input.signal?.throwIfAborted();
      const bytes = proposed.get(input.relativePath);
      if (bytes === undefined || bytes === null)
        return Promise.resolve({
          diagnostics: [
            {
              code: 'GUI_HELPER_OUTPUT_MISSING',
              severity: 'blocker' as const,
              category: 'transaction' as const,
              message: `Proposed source is missing ${input.relativePath}`,
              operationId,
            },
          ],
          checks: [
            {
              id: 'gui-helper-output-present',
              passed: false,
              message: 'Compiled GUI source is present.',
            },
          ],
        });
      const document = parseClausewitz(bytes, `mod:${input.relativePath}`);
      const blocking = document.diagnostics.some(
        ({ severity }) => severity === 'error' || severity === 'blocker',
      );
      return Promise.resolve({
        diagnostics: document.diagnostics.map((diagnostic) => ({ ...diagnostic, operationId })),
        checks: [
          {
            id: 'gui-helper-output-present',
            passed: true,
            message: 'Compiled GUI source is present.',
          },
          {
            id: 'gui-helper-source-syntax',
            passed: !blocking,
            message: 'Compiled explicit GUI source parses safely.',
          },
        ],
      });
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return { transaction, compilation };
}
