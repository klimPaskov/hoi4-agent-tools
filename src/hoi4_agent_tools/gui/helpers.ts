import { compareCodeUnits, deterministicId } from '../core/canonical.js';
import { ServiceError } from '../core/result.js';
import { parseClausewitz } from '../core/source/index.js';
import type { TransactionManager, TransactionManifest } from '../core/transactions.js';
import { z } from 'zod';

const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);
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

export const guiHelperKinds = [
  'raw',
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

export interface GuiHelperNode {
  id: string;
  kind: GuiHelperKind;
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
  sprite?: string;
  text?: string;
  font?: string;
  state?: string;
  attributes?: Record<string, string | number | boolean>;
  raw?: string;
  children: GuiHelperNode[];
}

export const GUI_HELPER_MAX_DEPTH = 128;
export const GUI_HELPER_MAX_NODES = 10_000;

function assertGuiHelperInputBudget(input: unknown): void {
  if (input === null || typeof input !== 'object') return;
  const root = (input as { root?: unknown }).root;
  if (root === undefined) return;
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 1 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.value === null || typeof current.value !== 'object') continue;
    if (seen.has(current.value)) {
      throw new ServiceError(
        'GUI_HELPER_GRAPH_BLOCKED',
        'GUI helper input must be an acyclic tree',
      );
    }
    seen.add(current.value);
    nodes += 1;
    if (nodes > GUI_HELPER_MAX_NODES) {
      throw new ServiceError(
        'GUI_HELPER_NODE_BUDGET_BLOCKED',
        'GUI helper input exceeds the fixed node ceiling',
        { nodes, maximumNodes: GUI_HELPER_MAX_NODES },
      );
    }
    if (current.depth > GUI_HELPER_MAX_DEPTH) {
      throw new ServiceError(
        'GUI_HELPER_DEPTH_BUDGET_BLOCKED',
        'GUI helper input exceeds the fixed nesting ceiling',
        { depth: current.depth, maximumDepth: GUI_HELPER_MAX_DEPTH },
      );
    }
    const children = (current.value as { children?: unknown }).children;
    if (!Array.isArray(children)) continue;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ value: children[index], depth: current.depth + 1 });
    }
  }
}

const GuiHelperNodeSchema: z.ZodType<GuiHelperNode> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1),
      kind: z.enum(guiHelperKinds),
      name: z.string().min(1).optional(),
      elementType: z.string().min(1).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().nonnegative().optional(),
      height: z.number().nonnegative().optional(),
      gap: z.number().default(0),
      columns: z.number().int().positive().default(1),
      padding: insetSchema.optional(),
      margin: insetSchema.optional(),
      orientation: z.string().optional(),
      sprite: z.string().optional(),
      text: z.string().optional(),
      font: z.string().optional(),
      state: z.string().optional(),
      attributes: z.record(z.string(), scalarSchema).default({}),
      raw: z.string().optional(),
      children: z.array(GuiHelperNodeSchema).default([]),
    })
    .strict(),
) as z.ZodType<GuiHelperNode>;

export const GuiHelperDocumentSchema = z.preprocess(
  (input) => {
    assertGuiHelperInputBudget(input);
    return input;
  },
  z
    .object({
      version: z.literal(1).default(1),
      root: GuiHelperNodeSchema,
    })
    .strict(),
);

export interface GuiHelperDocument {
  version: 1;
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
  rawEscapeCount: number;
}

export interface PlanGuiHelperInput {
  workspaceId: string;
  relativePath: string;
  helper: unknown;
  principal?: string;
  signal?: AbortSignal;
}

function insets(value: GuiHelperNode['padding']): Insets {
  return typeof value === 'number'
    ? { top: value, right: value, bottom: value, left: value }
    : (value ?? { top: 0, right: 0, bottom: 0, left: 0 });
}

function typeFor(node: GuiHelperNode): string {
  if (node.elementType !== undefined) return node.elementType;
  if (node.kind === 'meter') return 'progressbarType';
  if (node.kind === 'scroll-list') return 'listboxType';
  if (node.kind === 'modal') return 'eu3dialogtype';
  if (node.kind === 'element' && node.sprite !== undefined) return 'iconType';
  if (node.kind === 'element' && node.text !== undefined) return 'instantTextBoxType';
  return 'containerWindowType';
}

function layoutHelper(node: GuiHelperNode): CompiledNode {
  const padding = insets(node.padding);
  const ownX = node.x ?? 0;
  const ownY = node.y ?? 0;
  const width = node.width ?? 0;
  const height = node.height ?? 0;
  const gap = node.gap ?? 0;
  const children: CompiledNode[] = [];
  let cursorX = padding.left;
  let cursorY = padding.top;
  const columns = Math.max(1, node.columns ?? 1);
  const gridCellWidth =
    width > 0
      ? Math.max(0, (width - padding.left - padding.right - gap * (columns - 1)) / columns)
      : 0;
  for (const [index, child] of node.children.entries()) {
    const margin = insets(child.margin);
    let x = cursorX + margin.left;
    let y = cursorY + margin.top;
    if (
      node.kind === 'stack' ||
      node.kind === 'tabs' ||
      node.kind === 'overlay' ||
      node.kind === 'modal' ||
      node.kind === 'status-panel' ||
      node.kind === 'card'
    ) {
      x = padding.left + margin.left;
      y = padding.top + margin.top;
    } else if (node.kind === 'grid') {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const rowHeight = child.height ?? 0;
      x = padding.left + column * (gridCellWidth + gap) + margin.left;
      y = padding.top + row * (rowHeight + gap) + margin.top;
    }
    const childWithDefaults: GuiHelperNode = {
      ...child,
      ...(node.kind === 'grid' && child.width === undefined
        ? { width: gridCellWidth - margin.left - margin.right }
        : {}),
      x,
      y,
    };
    const compiled = layoutHelper(childWithDefaults);
    children.push(compiled);
    if (node.kind === 'row' || node.kind === 'target-row')
      cursorX += margin.left + compiled.width + margin.right + gap;
    if (node.kind === 'column' || node.kind === 'scroll-list')
      cursorY += margin.top + compiled.height + margin.bottom + gap;
  }
  const inferredWidth =
    children.length === 0
      ? 0
      : Math.max(...children.map((child) => child.x + child.width)) + padding.right;
  const inferredHeight =
    children.length === 0
      ? 0
      : Math.max(...children.map((child) => child.y + child.height)) + padding.bottom;
  return {
    node,
    x: ownX,
    y: ownY,
    width: width || inferredWidth,
    height: height || inferredHeight,
    children,
  };
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function scalar(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number')
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
  return /^[A-Za-z0-9_@.:-]+$/u.test(value) ? value : quote(value);
}

function frameForState(state: string): number | undefined {
  if (state === 'normal') return 1;
  if (state === 'hover') return 2;
  if (state === 'selected' || state === 'active' || state === 'completed') return 3;
  if (state === 'disabled' || state === 'locked') return 4;
  return undefined;
}

function indentRaw(raw: string, depth: number): string {
  const indentation = '\t'.repeat(depth);
  return raw
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => `${indentation}${line}`)
    .join('\n');
}

function compileNode(compiled: CompiledNode, depth: number): string {
  const { node } = compiled;
  if (node.kind === 'raw') return node.raw === undefined ? '' : indentRaw(node.raw, depth);
  const indentation = '\t'.repeat(depth);
  const childIndentation = '\t'.repeat(depth + 1);
  const name = node.name ?? node.id;
  const lines = [
    `${indentation}${typeFor(node)} = {`,
    `${childIndentation}name = ${quote(name)}`,
    `${childIndentation}position = { x = ${scalar(compiled.x)} y = ${scalar(compiled.y)} }`,
    `${childIndentation}size = { width = ${scalar(compiled.width)} height = ${scalar(compiled.height)} }`,
  ];
  if (node.orientation !== undefined)
    lines.push(`${childIndentation}orientation = ${scalar(node.orientation)}`);
  if (node.sprite !== undefined)
    lines.push(`${childIndentation}spriteType = ${scalar(node.sprite)}`);
  if (node.text !== undefined) lines.push(`${childIndentation}text = ${scalar(node.text)}`);
  if (node.font !== undefined) lines.push(`${childIndentation}font = ${scalar(node.font)}`);
  if (node.state !== undefined) {
    const frame = frameForState(node.state);
    lines.push(`${childIndentation}# helper preview state: ${node.state}`);
    if (frame !== undefined) lines.push(`${childIndentation}frame = ${frame}`);
  }
  for (const [key, value] of Object.entries(node.attributes ?? {}).sort(([left], [right]) =>
    compareCodeUnits(left, right),
  ))
    lines.push(`${childIndentation}${key} = ${scalar(value)}`);
  if (node.raw !== undefined) lines.push(indentRaw(node.raw, depth + 1));
  for (const child of compiled.children) {
    const source = compileNode(child, depth + 1);
    if (source.length > 0) lines.push(source);
  }
  lines.push(`${indentation}}`);
  return lines.join('\n');
}

function countNodes(node: GuiHelperNode): number {
  return 1 + node.children.reduce((total, child) => total + countNodes(child), 0);
}

function countRaw(node: GuiHelperNode): number {
  return (
    (node.raw === undefined ? 0 : 1) +
    node.children.reduce((total, child) => total + countRaw(child), 0)
  );
}

export function compileGuiHelpers(input: unknown): GuiHelperCompileResult {
  const document = GuiHelperDocumentSchema.parse(input);
  const compiled = layoutHelper(document.root);
  const source = `# Generated as explicit HOI4 GUI source; the game has no dependency on hoi4-agent-tools.\nguiTypes = {\n${compileNode(compiled, 1)}\n}\n`;
  return {
    document,
    source,
    nodeCount: countNodes(document.root),
    rawEscapeCount: countRaw(document.root),
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
