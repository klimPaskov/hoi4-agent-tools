import path from 'node:path';
import { compareCodeUnits, deterministicId } from '../core/canonical.js';
import { DiagnosticCollector } from '../core/diagnostic-collector.js';
import type { Diagnostic, SourceLocation } from '../core/diagnostics.js';
import { sortDiagnostics } from '../core/diagnostics.js';
import type { SymbolIndex } from '../core/index.js';
import type { ScannedFile } from '../core/scanner.js';
import { ServiceError } from '../core/result.js';
import { GUI_GRAPH_MAX_EDGES, GUI_GRAPH_MAX_ELEMENTS, GUI_GRAPH_MAX_NODES } from './limits.js';
import {
  assignments,
  childBlocks,
  firstScalar,
  locationFor,
  nodeLocation,
  parseClausewitz,
  parseLocalisation,
  type AssignmentNode,
  type BlockNode,
  type SourceDocument,
  type SourceValue,
} from '../core/source/index.js';
import { GuiAnimationSourceManifestSchema } from './animation-manifest.js';
import type {
  GuiAnimationSourceManifest,
  GuiEdgeKind,
  GuiElementDefinition,
  GuiFontDefinition,
  GuiLocalisationValue,
  GuiPropertyValue,
  GuiScriptedLocalisationDefinition,
  GuiSize,
  GuiSourceEdge,
  GuiSourceGraph,
  GuiSourceKind,
  GuiSourceNode,
  GuiSpriteDefinition,
  ScriptedGuiDefinition,
} from './types.js';

const explicitGuiElementTypes = new Set([
  'containerWindowType',
  'windowType',
  'eu3dialogtype',
  'iconType',
  'buttonType',
  'guiButtonType',
  'instantTextBoxType',
  'textBoxType',
  'gridBoxType',
  'dynamicGridBoxType',
  'listboxType',
  'smoothListboxType',
  'scrollbarType',
  'extendedScrollbarType',
  'checkboxType',
  'editBoxType',
  'OverlappingElementsBoxType',
  'shieldtype',
  'progressbarType',
  'scrollableTextBoxType',
  'browserType',
  'mapIconType',
]);

const spriteTypes = new Set([
  'spriteType',
  'textSpriteType',
  'frameAnimatedSpriteType',
  'corneredTileSpriteType',
  'progressbarType',
  'maskedShieldType',
]);

const modelledElementAttributes = new Set([
  'name',
  'position',
  'size',
  'orientation',
  'origo',
  'scale',
  'clipping',
  'background',
  'spriteType',
  'quadTextureSprite',
  'frame',
  'text',
  'font',
  'fontSize',
  'maxWidth',
  'format',
  'buttonText',
  'buttonFont',
  'alwaystransparent',
  'allwaystransparent',
  'clickThrough',
  'spacing',
  'priority',
  'minValue',
  'maxValue',
  'startValue',
]);

const ignoredElementAttributes = new Set([
  'margin',
  'maxHeight',
  'fixedsize',
  'pdx_tooltip',
  'pdx_tooltip_delayed',
  'hint_tag',
  'horizontal',
  'verticalScrollbar',
  'horizontalScrollbar',
  'scrollbartype',
  'scrollbarType',
  'drag_scroll',
  'autohide_scrollbars',
  'scroll_wheel_factor',
  'smooth_scrolling',
  'borderSize',
  'stepSize',
  'centerposition',
  'fullScreen',
  'moveable',
  'show_position',
  'hide_position',
  'show_animation_type',
  'hide_animation_type',
  'animation_type',
  'animation_time',
  'fade_time',
  'fade_type',
  'show_sound',
  'hide_sound',
  'clicksound',
  'oversound',
  'shortcut',
  'web_link',
  'cost',
]);

export type GuiElementAttributeFidelity = 'modelled' | 'ignored' | 'unsupported' | 'structural';

export function guiElementAttributeFidelity(key: string): GuiElementAttributeFidelity {
  const modelled = [...modelledElementAttributes].find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  if (modelled !== undefined) return 'modelled';
  const ignored = [...ignoredElementAttributes].find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  if (ignored !== undefined) return 'ignored';
  if (/type$/iu.test(key)) return 'structural';
  return 'unsupported';
}

function normalizeAssetPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/^\//u, '').toLowerCase();
}

function scalarValue(value: string, constants: ReadonlyMap<string, string>): GuiPropertyValue {
  const expanded = constants.get(value) ?? value;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/u.test(expanded)) return Number(expanded);
  if (expanded === 'yes') return true;
  if (expanded === 'no') return false;
  return expanded;
}

function sourceValueToProperty(
  value: SourceValue,
  constants: ReadonlyMap<string, string>,
): GuiPropertyValue {
  if (value.type === 'scalar') return scalarValue(value.value, constants);
  const result: Record<string, GuiPropertyValue> = {};
  const unnamed: GuiPropertyValue[] = [];
  for (const entry of value.entries) {
    if (entry.type === 'scalar') {
      unnamed.push(scalarValue(entry.value, constants));
      continue;
    }
    if (entry.type === 'block') {
      unnamed.push(sourceValueToProperty(entry, constants));
      continue;
    }
    const next = sourceValueToProperty(entry.value, constants);
    const previous = result[entry.key.value];
    if (previous === undefined) result[entry.key.value] = next;
    else if (Array.isArray(previous)) previous.push(next);
    else result[entry.key.value] = [previous, next];
  }
  if (unnamed.length > 0) result.$values = unnamed;
  return result;
}

function constantsFor(document: SourceDocument): Map<string, string> {
  const result = new Map<string, string>();
  for (const assignment of assignments(document.root)) {
    if (!assignment.key.value.startsWith('@') || assignment.value.type !== 'scalar') continue;
    result.set(assignment.key.value, assignment.value.value);
  }
  return result;
}

function firstScalarInsensitive(block: BlockNode, ...keys: string[]): string | undefined {
  const lower = new Set(keys.map((key) => key.toLowerCase()));
  for (const assignment of assignments(block)) {
    if (!lower.has(assignment.key.value.toLowerCase()) || assignment.value.type !== 'scalar')
      continue;
    return assignment.value.value;
  }
  return undefined;
}

function numberScalar(block: BlockNode, ...keys: string[]): number | undefined {
  const value = firstScalarInsensitive(block, ...keys);
  if (value === undefined || !/^-?(?:\d+\.?\d*|\.\d+)$/u.test(value)) return undefined;
  return Number(value);
}

function boolScalar(block: BlockNode, ...keys: string[]): boolean | undefined {
  const value = firstScalarInsensitive(block, ...keys);
  if (value === 'yes') return true;
  if (value === 'no') return false;
  return undefined;
}

function sizeFrom(block: BlockNode): GuiSize | undefined {
  const size = childBlocks(block, 'size')[0];
  if (size === undefined) return undefined;
  const width = numberScalar(size, 'width', 'x');
  const height = numberScalar(size, 'height', 'y');
  return width === undefined || height === undefined ? undefined : { width, height };
}

function raw(document: SourceDocument, node: { start: number; end: number }): string {
  return document.text.slice(node.start, node.end);
}

function isGuiElement(assignment: AssignmentNode): boolean {
  if (assignment.value.type !== 'block') return false;
  if (explicitGuiElementTypes.has(assignment.key.value)) return true;
  return (
    assignment.key.value.endsWith('Type') && firstScalar(assignment.value, 'name') !== undefined
  );
}

function fileKind(file: ScannedFile): GuiSourceKind | undefined {
  const lower = file.relativePath.toLowerCase();
  if (lower.startsWith('hoi4_agent/animation_sources/') && lower.endsWith('.json'))
    return 'animation_source_manifest';
  if (lower.endsWith('.gui')) return 'gui_file';
  if (lower.endsWith('.gfx')) return 'gfx_file';
  if (lower.includes('common/scripted_guis/') && lower.endsWith('.txt')) return 'scripted_gui_file';
  if (lower.includes('common/scripted_localisation/') && lower.endsWith('.txt'))
    return 'scripted_localisation_file';
  if (lower.endsWith('.txt')) {
    const source = file.bytes.toString('utf8');
    if (/(?:^|\s)scripted_gui\s*=/u.test(source)) return 'scripted_gui_file';
    if (/(?:^|\s)defined_text\s*=/u.test(source)) return 'scripted_localisation_file';
  }
  if (lower.endsWith('.yml')) return 'localisation_file';
  return undefined;
}

function addNode(nodes: GuiSourceNode[], node: GuiSourceNode): void {
  if (nodes.length >= GUI_GRAPH_MAX_NODES) {
    throw new ServiceError(
      'GUI_GRAPH_NODE_BUDGET_BLOCKED',
      'GUI source graph exceeds the fixed node ceiling during construction',
      { nodes: nodes.length + 1, maximumNodes: GUI_GRAPH_MAX_NODES },
    );
  }
  nodes.push(node);
}

function addEdge(
  edges: GuiSourceEdge[],
  kind: GuiEdgeKind,
  from: string,
  to: string,
  resolved: boolean,
  metadata: Record<string, GuiPropertyValue> = {},
  location?: SourceLocation,
): void {
  if (edges.length >= GUI_GRAPH_MAX_EDGES) {
    throw new ServiceError(
      'GUI_GRAPH_EDGE_BUDGET_BLOCKED',
      'GUI source graph exceeds the fixed edge ceiling during construction',
      { edges: edges.length + 1, maximumEdges: GUI_GRAPH_MAX_EDGES },
    );
  }
  edges.push({
    id: deterministicId('gui_edge', { kind, from, to, metadata }),
    kind,
    from,
    to,
    resolved,
    ...(location === undefined ? {} : { location }),
    metadata,
  });
}

function addDomainEntry<T>(
  entries: T[],
  entry: T,
  domain: string,
  maximum = GUI_GRAPH_MAX_NODES,
): void {
  if (entries.length >= maximum) {
    throw new ServiceError(
      'GUI_GRAPH_DOMAIN_BUDGET_BLOCKED',
      `GUI source graph exceeds the fixed ${domain} ceiling during construction`,
      { domain, entries: entries.length + 1, maximumEntries: maximum },
    );
  }
  entries.push(entry);
}

function elementNodeId(
  element: Pick<GuiElementDefinition, 'sourcePath' | 'name' | 'definitionOrder'>,
): string {
  return deterministicId('gui_element', element);
}

function indexGuiElements(
  document: SourceDocument,
  file: ScannedFile,
  fileNodeId: string,
  nodes: GuiSourceNode[],
  edges: GuiSourceEdge[],
  elements: GuiElementDefinition[],
): void {
  const constants = constantsFor(document);
  const firstFileElement = elements.length;
  let order = 0;
  const walk = (block: BlockNode, parentId?: string): void => {
    for (const assignment of assignments(block)) {
      if (assignment.value.type !== 'block') continue;
      if (isGuiElement(assignment)) {
        const name = firstScalar(assignment.value, 'name')?.value;
        if (name === undefined) continue;
        order += 1;
        const attributes = sourceValueToProperty(assignment.value, constants);
        if (typeof attributes !== 'object' || Array.isArray(attributes)) continue;
        const id = elementNodeId({ sourcePath: file.displayPath, name, definitionOrder: order });
        const element: GuiElementDefinition = {
          id,
          name,
          elementType: assignment.key.value,
          sourcePath: file.displayPath,
          location: nodeLocation(document, assignment, name),
          ...(parentId === undefined ? {} : { parentId }),
          childIds: [],
          attributes: attributes,
          unsupportedAttributes: assignments(assignment.value)
            .filter((child) => !isGuiElement(child))
            .map(({ key }) => key.value)
            .filter((key) => guiElementAttributeFidelity(key) === 'unsupported')
            .sort((a, b) => compareCodeUnits(a, b)),
          rawSource: raw(document, assignment),
          definitionOrder: order,
        };
        addDomainEntry(elements, element, 'element', GUI_GRAPH_MAX_ELEMENTS);
        addNode(nodes, {
          id,
          kind: 'gui_element',
          name,
          path: file.displayPath,
          ...(element.location === undefined ? {} : { location: element.location }),
          metadata: {
            elementType: element.elementType,
            definitionOrder: order,
            unsupportedAttributes: element.unsupportedAttributes,
          },
        });
        addEdge(edges, 'contains', parentId ?? fileNodeId, id, true, {}, element.location);
        if (parentId !== undefined)
          addEdge(edges, 'parent', id, parentId, true, {}, element.location);
        walk(assignment.value, id);
      } else {
        walk(assignment.value, parentId);
      }
    }
  };
  walk(document.root);
  const fileElements = elements.slice(firstFileElement);
  const byId = new Map(fileElements.map((element) => [element.id, element]));
  for (const element of fileElements) {
    if (element.parentId !== undefined) {
      const parent = byId.get(element.parentId);
      if (parent !== undefined)
        addDomainEntry(parent.childIds, element.id, 'element child', GUI_GRAPH_MAX_ELEMENTS);
    }
  }
}

function indexSpritesAndFonts(
  document: SourceDocument,
  file: ScannedFile,
  fileNodeId: string,
  nodes: GuiSourceNode[],
  edges: GuiSourceEdge[],
  sprites: GuiSpriteDefinition[],
  fonts: GuiFontDefinition[],
): void {
  const walk = (block: BlockNode): void => {
    for (const assignment of assignments(block)) {
      if (assignment.value.type !== 'block') continue;
      const child = assignment.value;
      if (spriteTypes.has(assignment.key.value)) {
        const name = firstScalarInsensitive(child, 'name');
        if (name !== undefined) {
          const id = deterministicId('gui_sprite', { path: file.displayPath, name });
          const texturePath = firstScalarInsensitive(child, 'texturefile', 'textureFile');
          const texturePath2 = firstScalarInsensitive(child, 'textureFile2');
          const staticFallback = firstScalarInsensitive(child, 'static_fallback', 'staticFallback');
          const animationRateFps = numberScalar(child, 'animation_rate_fps');
          const looping = boolScalar(child, 'looping');
          const playOnShow = boolScalar(child, 'play_on_show');
          const pauseOnLoop = numberScalar(child, 'pause_on_loop');
          const effectFile = firstScalarInsensitive(child, 'effectFile');
          const declaredSize = sizeFrom(child);
          const definition: GuiSpriteDefinition = {
            id,
            name,
            sourcePath: file.displayPath,
            location: nodeLocation(document, assignment, name),
            spriteType: assignment.key.value,
            ...(texturePath === undefined ? {} : { texturePath }),
            ...(texturePath2 === undefined ? {} : { texturePath2 }),
            frameCount: Math.trunc(numberScalar(child, 'noOfFrames', 'noofframes') ?? 1),
            frameAnimated: assignment.key.value === 'frameAnimatedSpriteType',
            ...(animationRateFps === undefined ? {} : { animationRateFps }),
            ...(looping === undefined ? {} : { looping }),
            ...(playOnShow === undefined ? {} : { playOnShow }),
            ...(pauseOnLoop === undefined ? {} : { pauseOnLoop }),
            ...(effectFile === undefined ? {} : { effectFile }),
            ...(staticFallback === undefined ? {} : { staticFallback }),
            ...(declaredSize === undefined ? {} : { declaredSize }),
            rawSource: raw(document, assignment),
          };
          addDomainEntry(sprites, definition, 'sprite');
          addNode(nodes, {
            id,
            kind: 'sprite',
            name,
            path: file.displayPath,
            ...(definition.location === undefined ? {} : { location: definition.location }),
            metadata: {
              spriteType: definition.spriteType,
              frameCount: definition.frameCount,
              frameAnimated: definition.frameAnimated,
              ...(definition.animationRateFps === undefined
                ? {}
                : { animationRateFps: definition.animationRateFps }),
            },
          });
          addEdge(edges, 'contains', fileNodeId, id, true, {}, definition.location);
        }
      } else if (
        assignment.key.value === 'bitmapfont' ||
        assignment.key.value === 'bitmapfont_override'
      ) {
        const name = firstScalarInsensitive(child, 'name');
        if (name !== undefined) {
          const assetPaths = [firstScalarInsensitive(child, 'path')]
            .filter((value): value is string => value !== undefined)
            .concat(
              childBlocks(child, 'fontfiles').flatMap((fontFiles) =>
                fontFiles.entries
                  .filter((entry) => entry.type === 'scalar')
                  .map((entry) => entry.value),
              ),
            );
          const id = deterministicId('gui_font', { path: file.displayPath, name });
          const font: GuiFontDefinition = {
            id,
            name,
            sourcePath: file.displayPath,
            location: nodeLocation(document, assignment, name),
            kind: 'bitmapfont',
            assetPaths,
            rawSource: raw(document, assignment),
          };
          addDomainEntry(fonts, font, 'font');
          addNode(nodes, {
            id,
            kind: 'font',
            name,
            path: file.displayPath,
            ...(font.location === undefined ? {} : { location: font.location }),
            metadata: { kind: font.kind, assetPaths },
          });
          addEdge(edges, 'contains', fileNodeId, id, true, {}, font.location);
        }
      }
      walk(child);
    }
  };
  walk(document.root);
}

function actionElementName(action: string): string {
  return action
    .replace(/_(?:alt_|control_|shift_)?(?:left_|right_)?click_enabled$/u, '')
    .replace(/_(?:alt_|control_|shift_)?(?:left_|right_)?click$/u, '')
    .replace(/_(?:visible|enabled)$/u, '');
}

function namedAssignments(block: BlockNode, key: string): AssignmentNode[] {
  return childBlocks(block, key).flatMap((child) => assignments(child));
}

const directCostEffects = new Map<string, string>([
  ['add_political_power', 'pol_power'],
  ['add_command_power', 'command_power'],
  ['add_manpower', 'manpower'],
  ['add_stability', 'stability'],
  ['add_war_support', 'war_support'],
]);

function directEffectCosts(block: BlockNode): Record<string, number> {
  const costs: Record<string, number> = {};
  for (const assignment of assignments(block)) {
    const resource = directCostEffects.get(assignment.key.value);
    if (resource === undefined || assignment.value.type !== 'scalar') continue;
    const value = Number(assignment.value.value);
    if (!Number.isFinite(value) || value >= 0) continue;
    costs[resource] = (costs[resource] ?? 0) + -value;
  }
  return costs;
}

function indexScriptedGuis(
  document: SourceDocument,
  file: ScannedFile,
  fileNodeId: string,
  nodes: GuiSourceNode[],
  edges: GuiSourceEdge[],
  scriptedGuis: ScriptedGuiDefinition[],
): void {
  for (const root of childBlocks(document.root, 'scripted_gui')) {
    for (const assignment of assignments(root)) {
      if (assignment.value.type !== 'block') continue;
      const block = assignment.value;
      const name = assignment.key.value;
      const id = deterministicId('scripted_gui', { path: file.displayPath, name });
      const effectAssignments = namedAssignments(block, 'effects');
      const effectDefinitions = effectAssignments.map((effect) => ({
        name: effect.key.value,
        elementName: actionElementName(effect.key.value),
        costs: effect.value.type === 'block' ? directEffectCosts(effect.value) : {},
        rawSource: raw(document, effect),
        location: nodeLocation(document, effect, effect.key.value),
      }));
      const effects = effectDefinitions.map(({ name: effect }) => effect);
      const triggers = namedAssignments(block, 'triggers').map(({ key }) => key.value);
      const properties = namedAssignments(block, 'properties').map(({ key }) => key.value);
      const dynamicLists = namedAssignments(block, 'dynamic_lists').map(({ key }) => key.value);
      const aiWeights = namedAssignments(block, 'ai_weights').map(({ key }) => key.value);
      const contextType = firstScalarInsensitive(block, 'context_type');
      const windowName = firstScalarInsensitive(block, 'window_name');
      const parentWindowToken = firstScalarInsensitive(block, 'parent_window_token');
      const parentWindowName = firstScalarInsensitive(
        block,
        'parent_window_window',
        'parent_window_name',
      );
      const parentScriptedGui = firstScalarInsensitive(block, 'parent_scripted_gui');
      const visible = childBlocks(block, 'visible')[0];
      const definition: ScriptedGuiDefinition = {
        id,
        name,
        sourcePath: file.displayPath,
        location: nodeLocation(document, assignment, name),
        ...(contextType === undefined ? {} : { contextType }),
        ...(windowName === undefined ? {} : { windowName }),
        ...(parentWindowToken === undefined ? {} : { parentWindowToken }),
        ...(parentWindowName === undefined ? {} : { parentWindowName }),
        ...(parentScriptedGui === undefined ? {} : { parentScriptedGui }),
        ...(visible === undefined ? {} : { visibleExpression: raw(document, visible) }),
        effects: effects.sort((a, b) => compareCodeUnits(a, b)),
        effectDefinitions: effectDefinitions.sort((a, b) => compareCodeUnits(a.name, b.name)),
        triggers: triggers.sort((a, b) => compareCodeUnits(a, b)),
        properties: properties.sort((a, b) => compareCodeUnits(a, b)),
        dynamicLists: dynamicLists.sort((a, b) => compareCodeUnits(a, b)),
        aiWeights: aiWeights.sort((a, b) => compareCodeUnits(a, b)),
        aiEnabled:
          childBlocks(block, 'ai_enabled').length > 0 || childBlocks(block, 'ai_check').length > 0,
        rawSource: raw(document, assignment),
      };
      addDomainEntry(scriptedGuis, definition, 'scripted GUI');
      addNode(nodes, {
        id,
        kind: 'scripted_gui',
        name,
        path: file.displayPath,
        ...(definition.location === undefined ? {} : { location: definition.location }),
        metadata: {
          effects: definition.effects,
          triggers: definition.triggers,
          properties: definition.properties,
          dynamicLists: definition.dynamicLists,
          aiWeights: definition.aiWeights,
          aiEnabled: definition.aiEnabled,
        },
      });
      addEdge(edges, 'contains', fileNodeId, id, true, {}, definition.location);
      if (contextType !== undefined) {
        const target = deterministicId('gui_context', contextType);
        if (!nodes.some((node) => node.id === target)) {
          addNode(nodes, {
            id: target,
            kind: 'context',
            name: contextType,
            path: file.displayPath,
            metadata: {},
          });
        }
        addEdge(edges, 'context', id, target, true, {}, definition.location);
      }
      for (const effect of effects) {
        const effectId = deterministicId('gui_effect', { id, effect });
        addNode(nodes, {
          id: effectId,
          kind: 'scripted_effect',
          name: effect,
          path: file.displayPath,
          metadata: { scriptedGui: name, element: actionElementName(effect) },
        });
        addEdge(edges, 'contains', id, effectId, true);
      }
      for (const trigger of triggers) {
        const triggerId = deterministicId('gui_trigger', { id, trigger });
        addNode(nodes, {
          id: triggerId,
          kind: 'scripted_trigger',
          name: trigger,
          path: file.displayPath,
          metadata: { scriptedGui: name, element: actionElementName(trigger) },
        });
        addEdge(edges, 'contains', id, triggerId, true);
      }
    }
  }
}

function indexAnimationSourceManifest(
  file: ScannedFile,
  fileNodeId: string,
  nodes: GuiSourceNode[],
  edges: GuiSourceEdge[],
  manifests: GuiAnimationSourceManifest[],
  diagnostics: DiagnosticCollector,
): void {
  const text = file.bytes.toString('utf8');
  const location = locationFor(file.displayPath, text, 0, text.length);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    diagnostics.push({
      code: 'GUI_ANIMATION_SOURCE_MANIFEST_INVALID',
      severity: 'error',
      category: 'syntax',
      message: `Animation source manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      location,
    });
    return;
  }
  const parsed = GuiAnimationSourceManifestSchema.safeParse(value);
  if (!parsed.success) {
    diagnostics.push({
      code: 'GUI_ANIMATION_SOURCE_MANIFEST_INVALID',
      severity: 'error',
      category: 'syntax',
      message: `Animation source manifest does not match schema v1: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
      location,
    });
    return;
  }
  const id = deterministicId('gui_animation_source_manifest', {
    path: file.displayPath,
    sprite: parsed.data.sprite,
  });
  const manifest: GuiAnimationSourceManifest = {
    ...parsed.data,
    id,
    sourcePath: file.displayPath,
    relativePath: file.relativePath,
    location,
  };
  addDomainEntry(manifests, manifest, 'animation source manifest');
  addNode(nodes, {
    id,
    kind: 'animation_source_manifest',
    name: parsed.data.sprite,
    path: file.displayPath,
    location,
    metadata: {
      schemaVersion: parsed.data.schemaVersion,
      projectOwned: parsed.data.projectOwned,
      sheet: parsed.data.sheet.path,
      frameCount: parsed.data.sourceFrames.length,
    },
  });
  addEdge(edges, 'contains', fileNodeId, id, true, {}, location);
}

function linkAnimationSources(
  nodes: GuiSourceNode[],
  edges: GuiSourceEdge[],
  manifests: readonly GuiAnimationSourceManifest[],
  sprites: readonly GuiSpriteDefinition[],
  textureNodes: ReadonlyMap<string, string>,
  frameNodes: ReadonlyMap<string, string>,
): void {
  const spritesByName = new Map(sprites.map((sprite) => [sprite.name, sprite]));
  for (const manifest of manifests) {
    const sprite = spritesByName.get(manifest.sprite);
    addEdge(
      edges,
      'animation_provenance',
      sprite?.id ?? `sprite:${manifest.sprite}`,
      manifest.id,
      sprite !== undefined,
      { sprite: manifest.sprite },
      manifest.location,
    );
    const sheet = textureNodes.get(normalizeAssetPath(manifest.sheet.path));
    addEdge(
      edges,
      'animation_sheet',
      manifest.id,
      sheet ?? `texture:${normalizeAssetPath(manifest.sheet.path)}`,
      sheet !== undefined,
      { texturePath: manifest.sheet.path },
      manifest.location,
    );
    for (const frame of manifest.sourceFrames) {
      const normalized = normalizeAssetPath(frame.path);
      const target = frameNodes.get(normalized);
      addEdge(
        edges,
        'animation_source_frame',
        manifest.id,
        target ?? `animation_source_frame:${normalized}`,
        target !== undefined,
        { texturePath: frame.path },
        manifest.location,
      );
    }
  }
}

function indexScriptedLocalisation(
  document: SourceDocument,
  file: ScannedFile,
  fileNodeId: string,
  nodes: GuiSourceNode[],
  edges: GuiSourceEdge[],
  definitions: GuiScriptedLocalisationDefinition[],
): void {
  for (const assignment of assignments(document.root, 'defined_text')) {
    if (assignment.value.type !== 'block') continue;
    const name = firstScalar(assignment.value, 'name')?.value;
    if (name === undefined) continue;
    const localisationKeys = childBlocks(assignment.value, 'text')
      .flatMap((textBlock) => firstScalar(textBlock, 'localisation_key')?.value ?? [])
      .sort((left, right) => compareCodeUnits(left, right));
    const id = deterministicId('scripted_localisation', { path: file.displayPath, name });
    const location = nodeLocation(document, assignment, name);
    addDomainEntry(
      definitions,
      {
        id,
        name,
        sourcePath: file.displayPath,
        location,
        localisationKeys,
        rawSource: raw(document, assignment),
      },
      'scripted localisation',
    );
    addNode(nodes, {
      id,
      kind: 'scripted_localisation',
      name,
      path: file.displayPath,
      location,
      metadata: { localisationKeys },
    });
    addEdge(edges, 'contains', fileNodeId, id, true, {}, location);
  }
}

function indexDecisionEntries(
  document: SourceDocument,
  file: ScannedFile,
  nodes: GuiSourceNode[],
  pendingDecisionEdges: { from: string; target: string; location: SourceLocation }[],
): void {
  if (file.relativePath.toLowerCase().includes('common/scripted_guis/')) return;
  const walk = (block: BlockNode, owner?: string): void => {
    for (const assignment of assignments(block)) {
      const nextOwner =
        assignment.value.type === 'block'
          ? (firstScalar(assignment.value, 'id')?.value ?? assignment.key.value)
          : owner;
      if (assignment.key.value === 'scripted_gui' && assignment.value.type === 'scalar') {
        const category = owner ?? `${file.displayPath}:${assignment.start}`;
        const categoryId = deterministicId('decision_category', {
          path: file.displayPath,
          category,
        });
        if (!nodes.some((node) => node.id === categoryId)) {
          addNode(nodes, {
            id: categoryId,
            kind: 'decision_category',
            name: category,
            path: file.displayPath,
            location: nodeLocation(document, assignment, category),
            metadata: {},
          });
        }
        addDomainEntry(
          pendingDecisionEdges,
          {
            from: categoryId,
            target: assignment.value.value,
            location: nodeLocation(document, assignment, category),
          },
          'pending decision edge',
          GUI_GRAPH_MAX_EDGES,
        );
      }
      if (assignment.value.type === 'block') walk(assignment.value, nextOwner);
    }
  };
  walk(document.root);
}

function linkGraph(
  nodes: GuiSourceNode[],
  edges: GuiSourceEdge[],
  elements: GuiElementDefinition[],
  sprites: GuiSpriteDefinition[],
  fonts: GuiFontDefinition[],
  scriptedGuis: ScriptedGuiDefinition[],
  scriptedLocalisation: GuiScriptedLocalisationDefinition[],
  localisation: GuiLocalisationValue[],
  textureNodes: ReadonlyMap<string, string>,
  fontAssetNodes: ReadonlyMap<string, string>,
  pendingDecisionEdges: { from: string; target: string; location: SourceLocation }[],
): void {
  const spriteByName = new Map(sprites.map((sprite) => [sprite.name, sprite]));
  const fontByName = new Map(fonts.map((font) => [font.name, font]));
  const elementByName = new Map<string, GuiElementDefinition>();
  for (const element of [...elements].sort((a, b) => a.definitionOrder - b.definitionOrder)) {
    if (!elementByName.has(element.name)) elementByName.set(element.name, element);
  }
  const scriptedByName = new Map(scriptedGuis.map((gui) => [gui.name, gui]));
  const localisationByKey = new Map<string, GuiLocalisationValue>();
  for (const entry of localisation)
    if (!localisationByKey.has(entry.key)) localisationByKey.set(entry.key, entry);
  for (const definition of scriptedLocalisation) {
    for (const key of definition.localisationKeys) {
      const entry = localisationByKey.get(key);
      addEdge(
        edges,
        'uses_localisation',
        definition.id,
        entry === undefined ? `localisation:${key}` : deterministicId('gui_loc', entry),
        entry !== undefined,
        { key },
        definition.location,
      );
    }
  }

  for (const sprite of sprites) {
    for (const [index, texturePath] of [sprite.texturePath, sprite.texturePath2].entries()) {
      if (texturePath === undefined) continue;
      const textureId = textureNodes.get(normalizeAssetPath(texturePath));
      addEdge(
        edges,
        'uses_texture',
        sprite.id,
        textureId ?? `texture:${normalizeAssetPath(texturePath)}`,
        textureId !== undefined,
        { texturePath, slot: index + 1 },
        sprite.location,
      );
    }
    const candidates = [
      sprite.staticFallback,
      `${sprite.name}_static`,
      `${sprite.name}_fallback`,
    ].filter((value): value is string => value !== undefined);
    const fallback = candidates
      .map((name) => spriteByName.get(name))
      .find((value) => value !== undefined);
    if (fallback !== undefined)
      addEdge(edges, 'static_fallback', sprite.id, fallback.id, true, {}, sprite.location);
    else if (sprite.staticFallback !== undefined)
      addEdge(
        edges,
        'static_fallback',
        sprite.id,
        `sprite:${sprite.staticFallback}`,
        false,
        { spriteName: sprite.staticFallback },
        sprite.location,
      );
  }

  for (const font of fonts) {
    for (const assetPath of font.assetPaths) {
      const normalizedAssetPath = normalizeAssetPath(assetPath);
      const assetId =
        fontAssetNodes.get(normalizedAssetPath) ??
        fontAssetNodes.get(`${normalizedAssetPath}.fnt`) ??
        fontAssetNodes.get(`${normalizedAssetPath}.ttf`) ??
        fontAssetNodes.get(`${normalizedAssetPath}.otf`);
      addEdge(
        edges,
        'uses_font',
        font.id,
        assetId ?? `font_asset:${normalizedAssetPath}`,
        assetId !== undefined,
        { assetPath },
        font.location,
      );
    }
  }

  for (const element of elements) {
    const spriteName = [element.attributes.spriteType, element.attributes.quadTextureSprite].find(
      (value): value is string => typeof value === 'string',
    );
    if (spriteName !== undefined) {
      const sprite = spriteByName.get(spriteName);
      addEdge(
        edges,
        'uses_sprite',
        element.id,
        sprite?.id ?? `sprite:${spriteName}`,
        sprite !== undefined,
        { spriteName },
        element.location,
      );
    }
    const fontName = [element.attributes.font, element.attributes.buttonFont].find(
      (value): value is string => typeof value === 'string',
    );
    if (fontName !== undefined) {
      const font = fontByName.get(fontName);
      addEdge(
        edges,
        'uses_font',
        element.id,
        font?.id ?? `font:${fontName}`,
        font !== undefined,
        { fontName },
        element.location,
      );
    }
    for (const key of ['text', 'buttonText', 'pdx_tooltip', 'pdx_tooltip_delayed', 'hint_tag']) {
      const value = element.attributes[key];
      if (typeof value !== 'string') continue;
      const entry = localisationByKey.get(value);
      addEdge(
        edges,
        'uses_localisation',
        element.id,
        entry === undefined ? `localisation:${value}` : deterministicId('gui_loc', entry),
        entry !== undefined,
        { field: key, key: value },
        element.location,
      );
    }
  }

  for (const gui of scriptedGuis) {
    if (gui.windowName !== undefined) {
      const window = elementByName.get(gui.windowName);
      addEdge(
        edges,
        'window',
        gui.id,
        window?.id ?? `gui_element:${gui.windowName}`,
        window !== undefined,
        { windowName: gui.windowName },
        gui.location,
      );
    }
    const parentName = gui.parentWindowName ?? gui.parentWindowToken;
    if (parentName !== undefined) {
      const parent = elementByName.get(parentName);
      const parentId = parent?.id ?? deterministicId('parent_window', parentName);
      if (parent === undefined && !nodes.some((node) => node.id === parentId)) {
        addNode(nodes, {
          id: parentId,
          kind: 'parent_window',
          name: parentName,
          path: gui.sourcePath,
          metadata: {},
        });
      }
      addEdge(
        edges,
        'parent_window',
        gui.id,
        parentId,
        true,
        { token: parent === undefined },
        gui.location,
      );
    }
    if (gui.parentScriptedGui !== undefined) {
      const parent = scriptedByName.get(gui.parentScriptedGui);
      addEdge(
        edges,
        'parent_scripted_gui',
        gui.id,
        parent?.id ?? `scripted_gui:${gui.parentScriptedGui}`,
        parent !== undefined,
        {},
        gui.location,
      );
    }
    for (const effect of gui.effects) {
      const elementName = actionElementName(effect);
      const element = elementByName.get(elementName);
      const effectNode = deterministicId('gui_effect', { id: gui.id, effect });
      addEdge(
        edges,
        'button_effect',
        effectNode,
        element?.id ?? `gui_element:${elementName}`,
        element !== undefined,
        { action: effect },
        gui.location,
      );
    }
    for (const trigger of gui.triggers) {
      const elementName = actionElementName(trigger);
      const element = elementByName.get(elementName);
      const triggerNode = deterministicId('gui_trigger', { id: gui.id, trigger });
      addEdge(
        edges,
        'button_trigger',
        triggerNode,
        element?.id ?? `gui_element:${elementName}`,
        element !== undefined,
        { action: trigger },
        gui.location,
      );
    }
    for (const property of gui.properties) {
      const element = elementByName.get(property);
      addEdge(
        edges,
        'property_target',
        gui.id,
        element?.id ?? `gui_element:${property}`,
        element !== undefined,
        { property },
        gui.location,
      );
    }
  }

  for (const pending of pendingDecisionEdges) {
    const target = scriptedByName.get(pending.target);
    addEdge(
      edges,
      'decision_category_entry',
      pending.from,
      target?.id ?? `scripted_gui:${pending.target}`,
      target !== undefined,
      { scriptedGui: pending.target },
      pending.location,
    );
  }
}

function skippedInventoryCouldResolve(edge: GuiSourceEdge, sharedIndex: SymbolIndex): boolean {
  switch (edge.kind) {
    case 'uses_sprite':
    case 'static_fallback':
      return sharedIndex.hasSkippedSourceForKind('sprite');
    case 'uses_localisation':
      return sharedIndex.hasSkippedSourceForKind('localisation');
    case 'uses_font':
      // GFX definition files can contain both sprite and bitmap/outline font definitions.
      return sharedIndex.hasSkippedSourceForKind('sprite');
    case 'window':
    case 'button_effect':
    case 'button_trigger':
    case 'property_target':
      return sharedIndex.hasSkippedSourceForKind('gui_element');
    case 'parent_scripted_gui':
    case 'decision_category_entry':
      return sharedIndex.hasSkippedSourceForKind('scripted_gui');
    default:
      return false;
  }
}

function markPartialReferenceEdges(edges: GuiSourceEdge[], sharedIndex: SymbolIndex): void {
  for (const edge of edges) {
    if (!edge.resolved && skippedInventoryCouldResolve(edge, sharedIndex)) {
      edge.partialInventory = true;
    }
  }
}

function* referenceDiagnostics(edges: readonly GuiSourceEdge[]): Iterable<Diagnostic> {
  for (const edge of edges) {
    if (
      edge.resolved ||
      edge.kind === 'uses_texture' ||
      edge.kind === 'animation_sheet' ||
      edge.kind === 'animation_source_frame' ||
      (edge.kind === 'uses_font' && edge.metadata.assetPath !== undefined)
    )
      continue;
    const partial = edge.partialInventory === true;
    yield {
      code: partial ? 'GUI_REFERENCE_UNRESOLVED_PARTIAL' : 'GUI_REFERENCE_UNRESOLVED',
      severity: partial ? ('warning' as const) : ('error' as const),
      category: 'reference' as const,
      message: partial
        ? `The partial GUI inventory cannot resolve ${edge.kind.replaceAll('_', ' ')} reference ${referenceLabel(edge)}; a skipped source could define it`
        : `Unresolved GUI ${edge.kind.replaceAll('_', ' ')} reference: ${referenceLabel(edge)}`,
      ...(edge.location === undefined ? {} : { location: edge.location }),
      details: {
        edgeId: edge.id,
        edgeKind: edge.kind,
        from: edge.from,
        to: edge.to,
        ...(partial ? { partialInventory: true } : {}),
      },
    };
  }
}

function referenceLabel(edge: GuiSourceEdge): string {
  const value =
    edge.metadata.texturePath ??
    edge.metadata.spriteName ??
    edge.metadata.fontName ??
    edge.metadata.key;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return value === undefined ? edge.to : JSON.stringify(value);
}

export function buildGuiSourceGraph(
  files: readonly ScannedFile[],
  sharedIndex: SymbolIndex,
): GuiSourceGraph {
  const activeFiles = files.filter(({ shadowedBy }) => shadowedBy === undefined);
  const nodes: GuiSourceNode[] = [];
  const edges: GuiSourceEdge[] = [];
  const elements: GuiElementDefinition[] = [];
  const sprites: GuiSpriteDefinition[] = [];
  const fonts: GuiFontDefinition[] = [];
  const scriptedGuis: ScriptedGuiDefinition[] = [];
  const animationSources: GuiAnimationSourceManifest[] = [];
  const scriptedLocalisation: GuiScriptedLocalisationDefinition[] = [];
  const localisation: GuiLocalisationValue[] = [];
  const diagnostics = new DiagnosticCollector(2_000, {
    code: 'GUI_GRAPH_DIAGNOSTICS_TRUNCATED',
    category: 'layout',
    message: 'GUI source graph diagnostics exceeded the fixed global result ceiling',
  });
  diagnostics.pushMany(sharedIndex.diagnostics);
  if (!sharedIndex.complete) {
    diagnostics.push({
      code: 'GUI_INVENTORY_PARTIAL',
      severity: 'warning',
      category: 'reference',
      message:
        sharedIndex.skippedSourceCount === 0
          ? 'The GUI inventory is incomplete because the shared index reached a fixed record limit'
          : `The GUI inventory skipped ${sharedIndex.skippedSourceCount} over-limit source${sharedIndex.skippedSourceCount === 1 ? '' : 's'}`,
      details: {
        skippedSourceCount: sharedIndex.skippedSourceCount,
        retainedSkippedSources: sharedIndex.skippedSources.length,
        skippedSources: sharedIndex.skippedSources.slice(0, 10).map(({ path, reasonCodes }) => ({
          path,
          reasonCodes,
        })),
      },
    });
  }
  const sourceHashes: Record<string, string> = {};
  const textureNodes = new Map<string, string>();
  const fontAssetNodes = new Map<string, string>();
  const animationFrameNodes = new Map<string, string>();
  const pendingDecisionEdges: { from: string; target: string; location: SourceLocation }[] = [];

  for (const file of [...activeFiles].sort((a, b) =>
    compareCodeUnits(a.displayPath, b.displayPath),
  )) {
    sourceHashes[file.displayPath] = file.sha256;
    if (sharedIndex.isSourceSkipped(file.displayPath)) continue;
    const kind = fileKind(file);
    let fileNodeId: string | undefined;
    if (kind !== undefined) {
      fileNodeId = deterministicId('gui_file', { kind, path: file.displayPath });
      addNode(nodes, {
        id: fileNodeId,
        kind,
        name: path.posix.basename(file.relativePath),
        path: file.displayPath,
        metadata: { rootKind: file.rootKind, loadOrder: file.loadOrder, sha256: file.sha256 },
      });
    }
    const normalized = normalizeAssetPath(file.relativePath);
    if (normalized.startsWith('hoi4_agent/animation_sources/') && !normalized.endsWith('.json')) {
      const id = deterministicId('gui_animation_source_frame', { path: file.displayPath });
      animationFrameNodes.set(normalized, id);
      addNode(nodes, {
        id,
        kind: 'animation_source_frame',
        name: path.posix.basename(normalized),
        path: file.displayPath,
        metadata: { relativePath: file.relativePath, sha256: file.sha256 },
      });
    }
    if (/\.(?:png|tga|bmp|dds)$/u.test(normalized)) {
      const id = deterministicId('gui_texture', { path: file.displayPath });
      textureNodes.set(normalized, id);
      addNode(nodes, {
        id,
        kind: 'texture',
        name: path.posix.basename(normalized),
        path: file.displayPath,
        metadata: {
          relativePath: file.relativePath,
          format: path.posix.extname(normalized).slice(1),
        },
      });
    }
    if (/\.(?:ttf|otf|ttc|woff|woff2|fnt)$/u.test(normalized)) {
      const id = deterministicId('gui_font_asset', { path: file.displayPath });
      fontAssetNodes.set(normalized, id);
      addNode(nodes, {
        id,
        kind: 'font',
        name: path.posix.basename(normalized),
        path: file.displayPath,
        metadata: { asset: true, relativePath: file.relativePath },
      });
      if (normalized.endsWith('.fnt')) {
        addDomainEntry(
          fonts,
          {
            id,
            name: path.posix.basename(normalized, '.fnt'),
            sourcePath: file.displayPath,
            kind: 'bmfont',
            assetPaths: [file.relativePath],
          },
          'font',
        );
      }
    }
    if (kind === 'localisation_file' && fileNodeId !== undefined) {
      const document = parseLocalisation(file.bytes, file.displayPath);
      diagnostics.pushMany(document.diagnostics);
      for (const entry of document.entries) {
        const value: GuiLocalisationValue = {
          key: entry.key,
          language: entry.language,
          value: entry.value,
          sourcePath: file.displayPath,
          location: locationFor(file.displayPath, document.lineIndex, entry.start, entry.end),
        };
        addDomainEntry(localisation, value, 'localisation');
        const id = deterministicId('gui_loc', value);
        addNode(nodes, {
          id,
          kind: 'localisation',
          name: entry.key,
          path: file.displayPath,
          ...(value.location === undefined ? {} : { location: value.location }),
          metadata: { language: entry.language, value: entry.value },
        });
        addEdge(edges, 'contains', fileNodeId, id, true, {}, value.location);
      }
      continue;
    }
    if (kind === 'animation_source_manifest' && fileNodeId !== undefined) {
      indexAnimationSourceManifest(file, fileNodeId, nodes, edges, animationSources, diagnostics);
      continue;
    }
    if (kind === undefined || fileNodeId === undefined) {
      if (/\.(?:txt|gui|gfx)$/u.test(normalized)) {
        const document = parseClausewitz(file.bytes, file.displayPath);
        diagnostics.pushMany(document.diagnostics);
        indexDecisionEntries(document, file, nodes, pendingDecisionEdges);
      }
      continue;
    }
    const document = parseClausewitz(file.bytes, file.displayPath);
    diagnostics.pushMany(document.diagnostics);
    if (kind === 'gui_file') indexGuiElements(document, file, fileNodeId, nodes, edges, elements);
    if (kind === 'gfx_file') {
      indexSpritesAndFonts(document, file, fileNodeId, nodes, edges, sprites, fonts);
    }
    if (kind === 'scripted_gui_file') {
      indexScriptedGuis(document, file, fileNodeId, nodes, edges, scriptedGuis);
    }
    if (kind === 'scripted_localisation_file') {
      indexScriptedLocalisation(document, file, fileNodeId, nodes, edges, scriptedLocalisation);
    }
    indexDecisionEntries(document, file, nodes, pendingDecisionEdges);
  }

  linkGraph(
    nodes,
    edges,
    elements,
    sprites,
    fonts,
    scriptedGuis,
    scriptedLocalisation,
    localisation,
    textureNodes,
    fontAssetNodes,
    pendingDecisionEdges,
  );
  linkAnimationSources(nodes, edges, animationSources, sprites, textureNodes, animationFrameNodes);
  markPartialReferenceEdges(edges, sharedIndex);
  diagnostics.pushMany(referenceDiagnostics(edges));
  if (
    nodes.length > GUI_GRAPH_MAX_NODES ||
    edges.length > GUI_GRAPH_MAX_EDGES ||
    elements.length > GUI_GRAPH_MAX_ELEMENTS
  ) {
    diagnostics.push({
      code: 'GUI_GRAPH_BUDGET_BLOCKED',
      severity: 'blocker',
      category: 'layout',
      message: 'GUI source graph exceeds the fixed graph work ceiling',
      details: {
        nodes: nodes.length,
        maximumNodes: GUI_GRAPH_MAX_NODES,
        edges: edges.length,
        maximumEdges: GUI_GRAPH_MAX_EDGES,
        elements: elements.length,
        maximumElements: GUI_GRAPH_MAX_ELEMENTS,
      },
    });
  }
  nodes.sort((a, b) => compareCodeUnits(a.id, b.id));
  edges.sort((a, b) => compareCodeUnits(a.id, b.id));
  elements.sort((a, b) => a.definitionOrder - b.definitionOrder || compareCodeUnits(a.id, b.id));
  sprites.sort(
    (a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.sourcePath, b.sourcePath),
  );
  fonts.sort(
    (a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.sourcePath, b.sourcePath),
  );
  scriptedGuis.sort((a, b) => compareCodeUnits(a.name, b.name));
  animationSources.sort(
    (a, b) => compareCodeUnits(a.sprite, b.sprite) || compareCodeUnits(a.sourcePath, b.sourcePath),
  );
  scriptedLocalisation.sort((a, b) => compareCodeUnits(a.name, b.name));
  localisation.sort(
    (a, b) => compareCodeUnits(a.language, b.language) || compareCodeUnits(a.key, b.key),
  );
  return {
    complete: sharedIndex.complete,
    skippedSourceCount: sharedIndex.skippedSourceCount,
    skippedSources: sharedIndex.skippedSources,
    skippedPossibleSymbolKinds: sharedIndex.skippedPossibleSymbolKinds,
    nodes,
    edges,
    elements,
    sprites,
    fonts,
    scriptedGuis,
    animationSources,
    scriptedLocalisation,
    localisation,
    sourceHashes: Object.fromEntries(
      Object.entries(sourceHashes).sort(([left], [right]) => compareCodeUnits(left, right)),
    ),
    filesScanned: [...activeFiles]
      .map(({ displayPath }) => displayPath)
      .sort((a, b) => compareCodeUnits(a, b)),
    diagnostics: sortDiagnostics(diagnostics.values()),
  };
}
