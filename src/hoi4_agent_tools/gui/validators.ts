import type { Diagnostic } from '../core/diagnostics.js';
import { DiagnosticCollector } from '../core/diagnostic-collector.js';
import { sortDiagnostics } from '../core/diagnostics.js';
import { sha256Bytes } from '../core/canonical.js';
import { assertRenderDimensions } from '../core/render-budget.js';
import type { ScannedFile } from '../core/scanner.js';
import { GuiAssetCatalog, type LoadedRaster } from './assets.js';
import {
  GUI_GRAPH_MAX_EDGES,
  GUI_GRAPH_MAX_NODES,
  GUI_SCENE_MAX_ELEMENTS,
  GUI_VALIDATION_MAX_ANCESTOR_HOPS,
  GUI_VALIDATION_MAX_DIAGNOSTICS,
  GUI_VALIDATION_MAX_PAIR_COMPARISONS,
} from './limits.js';
import type {
  GuiPreviewState,
  GuiAnimationSourceManifest,
  GuiRect,
  GuiScene,
  GuiSceneElement,
  GuiSourceGraph,
  GuiValidationResult,
  ScriptedGuiDefinition,
  GuiSpriteDefinition,
} from './types.js';

const allStates: readonly GuiPreviewState[] = [
  'normal',
  'hover',
  'selected',
  'locked',
  'disabled',
  'warning',
  'active',
  'completed',
  'empty-list',
  'full-list',
  'minimum-value',
  'maximum-value',
  'long-text',
  'missing-localisation',
];

function validationCollector(): DiagnosticCollector {
  return new DiagnosticCollector(GUI_VALIDATION_MAX_DIAGNOSTICS, {
    code: 'GUI_VALIDATION_DIAGNOSTICS_TRUNCATED',
    category: 'layout',
    message: 'GUI validation diagnostics exceeded the fixed global result ceiling',
  });
}

class GuiValidationWorkBudget {
  private pairComparisons = 0;
  private ancestorHops = 0;
  private pairBlocked = false;
  private ancestorBlocked = false;

  public admitPairs(comparisons: number, phase: string, diagnostics: DiagnosticCollector): boolean {
    if (
      !Number.isSafeInteger(comparisons) ||
      comparisons < 0 ||
      comparisons > GUI_VALIDATION_MAX_PAIR_COMPARISONS - this.pairComparisons
    ) {
      if (!this.pairBlocked) {
        this.pairBlocked = true;
        diagnostics.push({
          code: 'GUI_VALIDATION_COMPARISON_BUDGET_BLOCKED',
          severity: 'blocker',
          category: 'layout',
          message: `${phase} exceeds the fixed shared pair-comparison ceiling`,
          details: {
            phase,
            usedComparisons: this.pairComparisons,
            requestedComparisons: comparisons,
            maximumComparisons: GUI_VALIDATION_MAX_PAIR_COMPARISONS,
          },
        });
      }
      return false;
    }
    this.pairComparisons += comparisons;
    return true;
  }

  public spendAncestorHop(phase: string, diagnostics: DiagnosticCollector): boolean {
    if (this.ancestorHops >= GUI_VALIDATION_MAX_ANCESTOR_HOPS) {
      if (!this.ancestorBlocked) {
        this.ancestorBlocked = true;
        diagnostics.push({
          code: 'GUI_VALIDATION_ANCESTOR_BUDGET_BLOCKED',
          severity: 'blocker',
          category: 'layout',
          message: `${phase} exceeds the fixed ancestor-hop ceiling`,
          details: {
            phase,
            ancestorHops: this.ancestorHops,
            maximumAncestorHops: GUI_VALIDATION_MAX_ANCESTOR_HOPS,
          },
        });
      }
      return false;
    }
    this.ancestorHops += 1;
    return true;
  }
}

function intersection(left: GuiRect, right: GuiRect): GuiRect | undefined {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  return rightEdge <= x || bottomEdge <= y
    ? undefined
    : { x, y, width: rightEdge - x, height: bottomEdge - y };
}

function area(rect: GuiRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function contains(outer: GuiRect, inner: GuiRect, tolerance = 0.01): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

function sameRect(left: GuiRect, right: GuiRect): boolean {
  return (
    Math.abs(left.x - right.x) < 0.01 &&
    Math.abs(left.y - right.y) < 0.01 &&
    Math.abs(left.width - right.width) < 0.01 &&
    Math.abs(left.height - right.height) < 0.01
  );
}

function issue(
  code: string,
  severity: Diagnostic['severity'],
  category: Diagnostic['category'],
  message: string,
  element?: GuiSceneElement,
  details?: Record<string, unknown>,
): Diagnostic {
  return {
    code,
    severity,
    category,
    message,
    ...(element?.location === undefined ? {} : { location: element.location }),
    ...(details === undefined ? {} : { details }),
  };
}

function hasAncestor(
  left: GuiSceneElement,
  right: GuiSceneElement,
  byId: ReadonlyMap<string, GuiSceneElement>,
  work: GuiValidationWorkBudget,
  diagnostics: DiagnosticCollector,
): boolean | undefined {
  let current = left.parentId;
  while (current !== undefined) {
    if (!work.spendAncestorHop('GUI overlap ancestry validation', diagnostics)) return undefined;
    if (current === right.id || byId.get(current)?.sourceId === right.sourceId) return true;
    current = byId.get(current)?.parentId;
  }
  return false;
}

function actionElementName(action: string): string {
  return action
    .replace(/_(?:alt_|control_|shift_)?(?:left_|right_)?click_enabled$/u, '')
    .replace(/_(?:alt_|control_|shift_)?(?:left_|right_)?click$/u, '')
    .replace(/_(?:visible|enabled)$/u, '');
}

function attachedScriptedGuis(graph: GuiSourceGraph, scene: GuiScene): ScriptedGuiDefinition[] {
  return graph.scriptedGuis.filter(
    (definition) =>
      definition.windowName === scene.windowName ||
      definition.parentWindowName === scene.windowName,
  );
}

function normalizedCostResource(value: string): string {
  const normalized = value.toLowerCase().replace(/_icon$/u, '');
  return normalized === 'political_power' ? 'pol_power' : normalized;
}

function localisationCosts(value: string): Map<string, number> {
  const result = new Map<string, number>();
  const plain = value.replace(/\u00a7./gu, '');
  for (const match of plain.matchAll(
    /\u00a3([A-Za-z0-9_.-]+)\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/gu,
  )) {
    const resource = match[1];
    const amount = match[2];
    if (resource === undefined || amount === undefined) continue;
    result.set(normalizedCostResource(resource), Math.abs(Number(amount)));
  }
  return result;
}

function validateSourceCosts(
  graph: GuiSourceGraph,
  scene: GuiScene,
  diagnostics: DiagnosticCollector,
): void {
  const elementsByName = new Map(graph.elements.map((element) => [element.name, element]));
  const localisationByKey = new Map(
    graph.localisation
      .filter(({ language }) => language === scene.scenario.language)
      .map((entry) => [entry.key, entry]),
  );
  for (const scripted of attachedScriptedGuis(graph, scene)) {
    for (const effect of scripted.effectDefinitions) {
      const element = elementsByName.get(effect.elementName);
      if (element === undefined) continue;
      const advertised = new Map<
        string,
        { amount: number; location?: Diagnostic['location']; key: string }
      >();
      for (const field of ['buttonText', 'pdx_tooltip', 'pdx_tooltip_delayed']) {
        const key = element.attributes[field];
        if (typeof key !== 'string') continue;
        const entry = localisationByKey.get(key);
        if (entry === undefined) continue;
        for (const [resource, amount] of localisationCosts(entry.value)) {
          const previous = advertised.get(resource);
          if (previous !== undefined && previous.amount !== amount) {
            diagnostics.push({
              code: 'GUI_COST_DISPLAY_CONFLICT',
              severity: 'error',
              category: 'design',
              message: `GUI element ${element.name} advertises conflicting ${resource} costs ${previous.amount} and ${amount}.`,
              ...(entry.location === undefined ? {} : { location: entry.location }),
              ...(previous.location === undefined ? {} : { related: [previous.location] }),
              details: { element: element.name, resource, firstKey: previous.key, secondKey: key },
            });
          } else {
            advertised.set(resource, {
              amount,
              ...(entry.location === undefined ? {} : { location: entry.location }),
              key,
            });
          }
        }
      }
      for (const [resource, display] of advertised) {
        const scriptCost = effect.costs[resource];
        if (scriptCost === display.amount) continue;
        diagnostics.push({
          code: 'GUI_COST_MISMATCH',
          severity: 'error',
          category: 'design',
          message:
            scriptCost === undefined
              ? `GUI element ${element.name} advertises a ${display.amount} ${resource} cost, but ${effect.name} has no matching direct cost effect.`
              : `GUI element ${element.name} advertises a ${display.amount} ${resource} cost, but ${effect.name} deducts ${scriptCost}.`,
          ...(display.location === undefined
            ? element.location === undefined
              ? {}
              : { location: element.location }
            : { location: display.location }),
          ...(effect.location === undefined ? {} : { related: [effect.location] }),
          details: {
            element: element.name,
            localisationKey: display.key,
            effect: effect.name,
            resource,
            guiCost: display.amount,
            scriptCost: scriptCost ?? null,
          },
        });
      }
    }
  }
}

function validateOverlapAndGeometry(
  scene: GuiScene,
  diagnostics: DiagnosticCollector,
  work: GuiValidationWorkBudget,
): void {
  const visible = scene.elements.filter((element) => element.visible && area(element.rect) > 0);
  const byId = new Map(scene.elements.map((element) => [element.id, element]));
  for (const element of scene.elements) {
    if (element.unclippedRect.width <= 0 || element.unclippedRect.height <= 0) {
      diagnostics.push(
        issue(
          'GUI_INVALID_SIZE',
          'warning',
          'layout',
          `${element.name} has a non-positive ${element.unclippedRect.width}x${element.unclippedRect.height} size.`,
          element,
        ),
      );
    }
    if (element.clipped)
      diagnostics.push(
        issue(
          'GUI_ACCIDENTAL_CLIPPING',
          'warning',
          'layout',
          `${element.name} is clipped from ${element.unclippedRect.width}x${element.unclippedRect.height} to ${element.rect.width}x${element.rect.height}.`,
          element,
        ),
      );
    if (element.text?.overflowX === true || element.text?.overflowY === true) {
      diagnostics.push(
        issue(
          'GUI_TEXT_OVERFLOW',
          'warning',
          'layout',
          `${element.name} text measures ${element.text.measuredWidth.toFixed(2)}x${element.text.measuredHeight.toFixed(2)} inside ${element.unclippedRect.width.toFixed(2)}x${element.unclippedRect.height.toFixed(2)}.`,
          element,
        ),
      );
    }
    if (
      element.parentId !== undefined &&
      element.clipRect !== undefined &&
      !contains(element.clipRect, element.unclippedRect)
    ) {
      diagnostics.push(
        issue(
          'GUI_CHILD_OUTSIDE_CLIPPED_PARENT',
          'warning',
          'layout',
          `${element.name} extends outside its clipped parent.`,
          element,
        ),
      );
    }
    if (element.clickable && element.visible && !sameRect(element.rect, element.unclippedRect)) {
      diagnostics.push(
        issue(
          'GUI_CLICK_BOUNDS_MISMATCH',
          'warning',
          'design',
          `${element.name} has visible/clipped bounds that differ from its source click rectangle.`,
          element,
        ),
      );
    }
    if (element.clickable && !element.visible)
      diagnostics.push(
        issue(
          'GUI_INVISIBLE_CLICK_BLOCKER',
          'error',
          'design',
          `${element.name} remains clickable while invisible in this scenario.`,
          element,
        ),
      );
  }
  const visiblePairCount = (visible.length * (visible.length - 1)) / 2;
  if (work.admitPairs(visiblePairCount, 'GUI overlap validation', diagnostics)) {
    pairLoop: for (let leftIndex = 0; leftIndex < visible.length; leftIndex += 1) {
      const left = visible[leftIndex];
      if (left === undefined) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < visible.length; rightIndex += 1) {
        const right = visible[rightIndex];
        if (right === undefined) continue;
        const leftAncestor = hasAncestor(left, right, byId, work, diagnostics);
        if (leftAncestor === undefined) break pairLoop;
        const rightAncestor = hasAncestor(right, left, byId, work, diagnostics);
        if (rightAncestor === undefined) break pairLoop;
        if (leftAncestor || rightAncestor) continue;
        const overlap = intersection(left.rect, right.rect);
        if (overlap === undefined) continue;
        const ratio = area(overlap) / Math.max(1, Math.min(area(left.rect), area(right.rect)));
        if (left.clickable && right.clickable && ratio > 0.02) {
          diagnostics.push(
            issue(
              'GUI_CONFLICTING_CLICK_REGIONS',
              'error',
              'design',
              `${left.name} and ${right.name} have overlapping click regions (${(ratio * 100).toFixed(1)}%).`,
              right,
              { left: left.id, right: right.id, ratio },
            ),
          );
        }
        if (left.depth === right.depth && ratio > 0.2) {
          diagnostics.push(
            issue(
              'GUI_VISIBLE_OVERLAP',
              'warning',
              'layout',
              `${left.name} and ${right.name} overlap by ${(ratio * 100).toFixed(1)}% of the smaller element.`,
              right,
              { left: left.id, right: right.id, ratio },
            ),
          );
        }
        const later = left.zIndex > right.zIndex ? left : right;
        const earlier = later === left ? right : left;
        if (earlier.clickable && !later.clickThrough && ratio > 0.9) {
          diagnostics.push(
            issue(
              'GUI_Z_ORDER_RISK',
              'warning',
              'design',
              `${later.name} nearly covers clickable ${earlier.name} at a higher z-order.`,
              later,
            ),
          );
        }
      }
    }
  }
}

function validateAlignmentAndSpacing(
  scene: GuiScene,
  diagnostics: DiagnosticCollector,
  work: GuiValidationWorkBudget,
): void {
  const groups = new Map<string, GuiSceneElement[]>();
  for (const element of scene.elements.filter(({ visible }) => visible)) {
    const group = groups.get(element.parentId ?? '<root>') ?? [];
    group.push(element);
    groups.set(element.parentId ?? '<root>', group);
  }
  const siblingPairCount = [...groups.values()].reduce(
    (total, siblings) => total + (siblings.length * (siblings.length - 1)) / 2,
    0,
  );
  const compareSiblingPairs = work.admitPairs(
    siblingPairCount,
    'GUI sibling validation',
    diagnostics,
  );
  for (const siblings of groups.values()) {
    if (siblings.length < 2) continue;
    if (compareSiblingPairs)
      for (let leftIndex = 0; leftIndex < siblings.length; leftIndex += 1) {
        const left = siblings[leftIndex];
        if (left === undefined) continue;
        for (let rightIndex = leftIndex + 1; rightIndex < siblings.length; rightIndex += 1) {
          const right = siblings[rightIndex];
          if (right === undefined) continue;
          const xDelta = Math.abs(left.unclippedRect.x - right.unclippedRect.x);
          const yDelta = Math.abs(left.unclippedRect.y - right.unclippedRect.y);
          if ((xDelta > 0.25 && xDelta < 3) || (yDelta > 0.25 && yDelta < 3)) {
            diagnostics.push(
              issue(
                'GUI_INCONSISTENT_ALIGNMENT',
                'info',
                'layout',
                `${left.name} and ${right.name} are nearly, but not exactly, aligned (${xDelta.toFixed(2)}px x / ${yDelta.toFixed(2)}px y).`,
                right,
              ),
            );
          }
        }
      }
    const vertical = siblings.toSorted(
      (left, right) => left.unclippedRect.y - right.unclippedRect.y,
    );
    const gaps = vertical.slice(1).map((element, index) => {
      const previous = vertical[index];
      return previous === undefined
        ? 0
        : element.unclippedRect.y - (previous.unclippedRect.y + previous.unclippedRect.height);
    });
    const positive = gaps.filter((gap) => gap >= 0);
    if (positive.length >= 3 && Math.max(...positive) - Math.min(...positive) > 3) {
      diagnostics.push(
        issue(
          'GUI_INCONSISTENT_SPACING',
          'info',
          'layout',
          `Sibling vertical gaps vary from ${Math.min(...positive).toFixed(2)}px to ${Math.max(...positive).toFixed(2)}px.`,
          vertical.at(-1),
        ),
      );
    }
  }
}

function validateReferencesAndScript(
  graph: GuiSourceGraph,
  scene: GuiScene,
  diagnostics: DiagnosticCollector,
): void {
  const sceneSourceIds = new Set(scene.elements.map(({ sourceId }) => sourceId));
  const selectedSpriteNames = new Set(
    scene.elements.flatMap(({ sprite }) => (sprite === undefined ? [] : [sprite.spriteName])),
  );
  const selectedSpriteIds = new Set(
    graph.sprites.filter(({ name }) => selectedSpriteNames.has(name)).map(({ id }) => id),
  );
  const selectedFontNames = new Set(
    scene.elements.flatMap(({ text }) => (text?.fontName === undefined ? [] : [text.fontName])),
  );
  const selectedFontIds = new Set(
    graph.fonts.filter(({ name }) => selectedFontNames.has(name)).map(({ id }) => id),
  );
  const selectedManifestIds = new Set(
    graph.animationSources
      .filter(({ sprite }) => selectedSpriteNames.has(sprite))
      .map(({ id }) => id),
  );
  const unresolved = graph.edges
    .filter(({ resolved }) => !resolved)
    .filter((edge) => {
      if (edge.kind === 'uses_sprite' || edge.kind === 'uses_localisation')
        return sceneSourceIds.has(edge.from);
      if (edge.kind === 'uses_texture') return selectedSpriteIds.has(edge.from);
      if (edge.kind === 'uses_font')
        return edge.metadata.assetPath === undefined
          ? sceneSourceIds.has(edge.from)
          : selectedFontIds.has(edge.from);
      if (edge.kind === 'animation_sheet' || edge.kind === 'animation_source_frame')
        return selectedManifestIds.has(edge.from);
      return true;
    });
  for (const edge of unresolved) {
    const partialInventory = edge.partialInventory === true;
    diagnostics.push({
      code: partialInventory
        ? 'GUI_REFERENCE_UNRESOLVED_PARTIAL'
        : edge.kind === 'uses_sprite'
          ? 'GUI_MISSING_SPRITE'
          : edge.kind === 'uses_texture'
            ? 'GUI_MISSING_TEXTURE'
            : edge.kind === 'uses_font'
              ? 'GUI_MISSING_FONT'
              : edge.kind === 'uses_localisation'
                ? 'GUI_MISSING_LOCALISATION'
                : 'GUI_UNRESOLVED_REFERENCE',
      severity: partialInventory ? 'warning' : 'error',
      category: 'reference',
      message: partialInventory
        ? `The partial GUI inventory cannot resolve ${edge.kind.replaceAll('_', ' ')} reference ${referenceLabel(edge.metadata, edge.to)}; a skipped source could define it.`
        : `Unresolved ${edge.kind.replaceAll('_', ' ')} reference ${referenceLabel(edge.metadata, edge.to)}.`,
      ...(edge.location === undefined ? {} : { location: edge.location }),
      ...(partialInventory ? { details: { partialInventory: true, edgeId: edge.id } } : {}),
    });
  }
  for (const element of scene.elements) {
    if (element.text?.metricSource === 'approximation' && element.text.fontName !== undefined)
      diagnostics.push(
        issue(
          'GUI_MISSING_FONT',
          'warning',
          'reference',
          `${element.name} uses unavailable font metrics for ${element.text.fontName}.`,
          element,
        ),
      );
    if (element.text !== undefined && element.text.unresolvedTokens.length > 0)
      diagnostics.push(
        issue(
          'GUI_UNRESOLVED_DYNAMIC_VALUE',
          'warning',
          'rendering',
          `${element.name} contains unresolved values: ${element.text.unresolvedTokens.join(', ')}.`,
          element,
        ),
      );
    for (const field of element.unsupportedAttributes)
      diagnostics.push(
        issue(
          'GUI_RENDER_FIELD_UNSUPPORTED',
          'info',
          'rendering',
          `${element.name}.${field} is preserved in source but not reliably modelled.`,
          element,
        ),
      );
  }

  const validContexts = new Set([
    'country',
    'state',
    'unit_leader',
    'operative',
    'character',
    'division',
    'decision',
    'decision_category',
    'national_focus',
    'shared_focus',
    'technology',
    'equipment',
    'military_industrial_organization',
    'special_project',
  ]);
  const names = new Set(graph.scriptedGuis.map(({ name }) => name));
  const windowNames = new Set(graph.elements.map(({ name }) => name));
  for (const scripted of graph.scriptedGuis) {
    if (scripted.contextType === undefined) {
      diagnostics.push({
        code: 'GUI_SCRIPTED_CONTEXT_MISSING',
        severity: 'warning',
        category: 'reference',
        message: `Scripted GUI ${scripted.name} does not declare context_type.`,
        ...(scripted.location === undefined ? {} : { location: scripted.location }),
      });
    } else if (!validContexts.has(scripted.contextType)) {
      diagnostics.push({
        code: 'GUI_SCRIPTED_CONTEXT_INVALID',
        severity: 'error',
        category: 'reference',
        message: `Scripted GUI ${scripted.name} uses unknown context_type ${scripted.contextType}.`,
        ...(scripted.location === undefined ? {} : { location: scripted.location }),
      });
    }
    if (scripted.windowName !== undefined && !windowNames.has(scripted.windowName))
      diagnostics.push({
        code: 'GUI_PARENT_WINDOW_INVALID',
        severity: 'error',
        category: 'reference',
        message: `Scripted GUI ${scripted.name} references missing window ${scripted.windowName}.`,
        ...(scripted.location === undefined ? {} : { location: scripted.location }),
      });
    if (scripted.parentWindowName !== undefined && !windowNames.has(scripted.parentWindowName))
      diagnostics.push({
        code: 'GUI_PARENT_WINDOW_INVALID',
        severity: 'error',
        category: 'reference',
        message: `Scripted GUI ${scripted.name} references missing parent window ${scripted.parentWindowName}.`,
        ...(scripted.location === undefined ? {} : { location: scripted.location }),
      });
    if (scripted.parentScriptedGui !== undefined && !names.has(scripted.parentScriptedGui))
      diagnostics.push({
        code: 'GUI_PARENT_SCRIPTED_GUI_INVALID',
        severity: 'error',
        category: 'reference',
        message: `Scripted GUI ${scripted.name} references missing parent scripted GUI ${scripted.parentScriptedGui}.`,
        ...(scripted.location === undefined ? {} : { location: scripted.location }),
      });
  }

  const attached = attachedScriptedGuis(graph, scene);
  if (attached.length > 0) {
    const effects = new Set(attached.flatMap(({ effects }) => effects.map(actionElementName)));
    const triggers = new Set(attached.flatMap(({ triggers }) => triggers.map(actionElementName)));
    for (const button of scene.elements.filter(({ elementType }) => /button/iu.test(elementType))) {
      if (!effects.has(button.name))
        diagnostics.push(
          issue(
            'GUI_BUTTON_EFFECT_MISSING',
            'error',
            'reference',
            `Button ${button.name} has no matching scripted GUI click effect.`,
            button,
          ),
        );
      if (!triggers.has(button.name))
        diagnostics.push(
          issue(
            'GUI_BUTTON_TRIGGER_MISSING',
            'warning',
            'reference',
            `Button ${button.name} has no matching scripted GUI visibility/enabled trigger.`,
            button,
          ),
        );
    }
    for (const scripted of attached.filter(
      ({ effects, aiEnabled }) => effects.length > 0 && !aiEnabled,
    )) {
      diagnostics.push({
        code: 'GUI_AI_EQUIVALENT_MISSING',
        severity: 'warning',
        category: 'design',
        message: `Scripted GUI ${scripted.name} exposes player effects without ai_enabled or ai_check logic.`,
        ...(scripted.location === undefined ? {} : { location: scripted.location }),
      });
    }
  }
  validateSourceCosts(graph, scene, diagnostics);
  for (const [key, guiCost] of Object.entries(scene.scenario.guiCosts)) {
    const scriptCost = scene.scenario.scriptCosts[key];
    if (scriptCost !== undefined && guiCost !== scriptCost)
      diagnostics.push({
        code: 'GUI_COST_MISMATCH',
        severity: 'error',
        category: 'design',
        message: `GUI cost ${key} is ${guiCost}, but the scenario script cost is ${scriptCost}.`,
        details: { key, guiCost, scriptCost },
      });
  }
}

function referenceLabel(
  metadata: GuiSourceGraph['edges'][number]['metadata'],
  fallback: string,
): string {
  const value = metadata.spriteName ?? metadata.texturePath ?? metadata.fontName ?? metadata.key;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return value === undefined ? fallback : JSON.stringify(value);
}

function validateScrollAndTabs(scene: GuiScene, diagnostics: DiagnosticCollector): void {
  for (const element of scene.elements) {
    if (element.rowIndex !== undefined && element.clipped)
      diagnostics.push(
        issue(
          'GUI_SCROLL_ROW_CUTOFF',
          'warning',
          'layout',
          `Row ${element.rowIndex + 1} element ${element.name} is cut off by its container.`,
          element,
        ),
      );
  }
  const groups = new Map<string, GuiSceneElement[]>();
  for (const element of scene.elements.filter(
    ({ visible, name, state }) =>
      visible && /tab/iu.test(name) && (state === 'selected' || state === 'active'),
  )) {
    const group = groups.get(element.parentId ?? '<root>') ?? [];
    group.push(element);
    groups.set(element.parentId ?? '<root>', group);
  }
  for (const tabs of groups.values()) {
    if (tabs.length > 1)
      diagnostics.push(
        issue(
          'GUI_TAB_STATE_CONFLICT',
          'error',
          'design',
          `Conflicting tab state: ${tabs.map(({ name }) => name).join(', ')} are visible and active together.`,
          tabs[1],
        ),
      );
  }
}

function alphaBounds(
  data: Buffer,
  width: number,
  height: number,
  left: number,
  frameWidth: number,
): GuiRect | undefined {
  let minX = frameWidth;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < frameWidth; x += 1) {
      const alpha = data.readUInt8((y * width + left + x) * 4 + 3);
      if (alpha === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < minX
    ? undefined
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function normalizedAssetPath(value: string): string {
  return value
    .replaceAll('\\', '/')
    .replace(/^\/+|^\.\//u, '')
    .toLowerCase();
}

function rasterCell(raster: LoadedRaster, left: number, width: number, height: number): Buffer {
  assertRenderDimensions(width, height, 'GUI animation validation cell');
  const output = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const start = (y * raster.width + left) * 4;
    raster.data.copy(output, y * width * 4, start, start + width * 4);
  }
  return output;
}

function sameNumber(left: number | undefined, right: number | undefined): boolean {
  return left === undefined || right === undefined
    ? left === right
    : Math.abs(left - right) < 0.000_001;
}

async function validateAnimationSourceManifest(
  sprite: GuiSpriteDefinition,
  manifest: GuiAnimationSourceManifest,
  graph: GuiSourceGraph,
  catalog: GuiAssetCatalog,
  diagnostics: DiagnosticCollector,
): Promise<void> {
  const add = (
    code: string,
    severity: Diagnostic['severity'],
    message: string,
    details?: Record<string, unknown>,
  ): void => {
    diagnostics.push({
      code,
      severity,
      category: code.includes('DIMENSION') || code.includes('ANCHOR') ? 'layout' : 'rendering',
      message,
      ...(manifest.location === undefined ? {} : { location: manifest.location }),
      ...(sprite.location === undefined ? {} : { related: [sprite.location] }),
      ...(details === undefined ? {} : { details }),
    });
  };

  if (normalizedAssetPath(sprite.texturePath ?? '') !== normalizedAssetPath(manifest.sheet.path)) {
    add(
      'GUI_ANIMATION_SOURCE_SHEET_REFERENCE_MISMATCH',
      'error',
      `${manifest.sprite} manifest sheet does not match the frameAnimatedSpriteType texturefile.`,
      { manifestSheet: manifest.sheet.path, spriteSheet: sprite.texturePath ?? null },
    );
  }
  if (
    sprite.frameCount !== manifest.animation.frameCount ||
    manifest.sourceFrames.length !== manifest.animation.frameCount
  ) {
    add(
      'GUI_ANIMATION_SOURCE_FRAME_COUNT_MISMATCH',
      'error',
      `${manifest.sprite} manifest, source-frame list, and noOfFrames must have the same count.`,
      {
        spriteFrameCount: sprite.frameCount,
        manifestFrameCount: manifest.animation.frameCount,
        sourceFrameCount: manifest.sourceFrames.length,
      },
    );
  }
  const settingsMatch =
    sameNumber(sprite.animationRateFps, manifest.animation.rateFps) &&
    sprite.looping === manifest.animation.looping &&
    sprite.playOnShow === manifest.animation.playOnShow &&
    sameNumber(sprite.pauseOnLoop, manifest.animation.pauseOnLoop);
  if (!settingsMatch) {
    add(
      'GUI_ANIMATION_SOURCE_SETTINGS_MISMATCH',
      'error',
      `${manifest.sprite} manifest animation settings disagree with the sprite definition.`,
      {
        manifest: manifest.animation,
        sprite: {
          rateFps: sprite.animationRateFps ?? null,
          looping: sprite.looping ?? null,
          playOnShow: sprite.playOnShow ?? null,
          pauseOnLoop: sprite.pauseOnLoop ?? null,
        },
      },
    );
  }

  const sheetFile = catalog.resolveFile(manifest.sheet.path, manifest.sourcePath);
  const sheetRaster = await catalog.loadRaster(manifest.sheet.path, manifest.sourcePath);
  if (sheetFile === undefined) {
    add(
      'GUI_ANIMATION_SOURCE_SHEET_MISSING',
      'error',
      `${manifest.sprite} manifest sheet is missing.`,
    );
  } else if (sheetFile.sha256 !== manifest.sheet.sha256) {
    add(
      'GUI_ANIMATION_SOURCE_HASH_MISMATCH',
      'error',
      `${manifest.sprite} sheet hash does not match its manifest.`,
      { path: manifest.sheet.path, expected: manifest.sheet.sha256, actual: sheetFile.sha256 },
    );
  }
  if (
    !sheetRaster.supported ||
    sheetRaster.width !== manifest.sheet.frameWidth * manifest.animation.frameCount ||
    sheetRaster.height !== manifest.sheet.frameHeight
  ) {
    add(
      'GUI_ANIMATION_SOURCE_SHEET_DIMENSION_MISMATCH',
      'error',
      `${manifest.sprite} sheet dimensions do not equal frame width times count by frame height.`,
      {
        expectedWidth: manifest.sheet.frameWidth * manifest.animation.frameCount,
        expectedHeight: manifest.sheet.frameHeight,
        actualWidth: sheetRaster.width,
        actualHeight: sheetRaster.height,
      },
    );
  }

  const firstAnchor = manifest.sourceFrames[0]?.anchor;
  const fileHashes = new Set<string>();
  const pixelHashes = new Set<string>();
  const sourceRasters: LoadedRaster[] = [];
  for (const [index, frame] of manifest.sourceFrames.entries()) {
    const file = catalog.resolveFile(frame.path, manifest.sourcePath);
    const raster = await catalog.loadRaster(frame.path, manifest.sourcePath);
    sourceRasters.push(raster);
    if (file === undefined) {
      add(
        'GUI_ANIMATION_SOURCE_FRAME_MISSING',
        'error',
        `${manifest.sprite} source frame ${index} is missing.`,
        { index, path: frame.path },
      );
      continue;
    }
    fileHashes.add(file.sha256);
    if (file.sha256 !== frame.sha256) {
      add(
        'GUI_ANIMATION_SOURCE_HASH_MISMATCH',
        'error',
        `${manifest.sprite} source frame ${index} hash does not match its manifest.`,
        { index, path: frame.path, expected: frame.sha256, actual: file.sha256 },
      );
    }
    if (
      !raster.supported ||
      raster.width !== manifest.sheet.frameWidth ||
      raster.height !== manifest.sheet.frameHeight
    ) {
      add(
        'GUI_ANIMATION_SOURCE_FRAME_DIMENSION_MISMATCH',
        'error',
        `${manifest.sprite} source frame ${index} does not match the declared cell dimensions.`,
        {
          index,
          path: frame.path,
          expectedWidth: manifest.sheet.frameWidth,
          expectedHeight: manifest.sheet.frameHeight,
          actualWidth: raster.width,
          actualHeight: raster.height,
        },
      );
    } else {
      const pixelHash = sha256Bytes(raster.data);
      pixelHashes.add(pixelHash);
      if (
        sheetRaster.supported &&
        sheetRaster.width === manifest.sheet.frameWidth * manifest.animation.frameCount &&
        sheetRaster.height === manifest.sheet.frameHeight
      ) {
        const sheetCell = rasterCell(
          sheetRaster,
          index * manifest.sheet.frameWidth,
          manifest.sheet.frameWidth,
          manifest.sheet.frameHeight,
        );
        if (sha256Bytes(sheetCell) !== pixelHash) {
          add(
            'GUI_ANIMATION_SOURCE_SHEET_CELL_MISMATCH',
            'error',
            `${manifest.sprite} sheet cell ${index} does not match its declared independent source frame.`,
            { index, path: frame.path },
          );
        }
      }
    }
    if (
      frame.anchor.x >= manifest.sheet.frameWidth ||
      frame.anchor.y >= manifest.sheet.frameHeight
    ) {
      add(
        'GUI_ANIMATION_SOURCE_ANCHOR_INVALID',
        'error',
        `${manifest.sprite} source frame ${index} anchor is outside its frame.`,
        { index, anchor: frame.anchor },
      );
    }
    if (
      firstAnchor !== undefined &&
      (frame.anchor.x !== firstAnchor.x || frame.anchor.y !== firstAnchor.y)
    ) {
      add(
        'GUI_ANIMATION_SOURCE_ANCHOR_DRIFT',
        'error',
        `${manifest.sprite} source-frame anchors are not stable.`,
        { index, expected: firstAnchor, actual: frame.anchor },
      );
    }
  }
  if (
    fileHashes.size !== manifest.sourceFrames.length ||
    pixelHashes.size !== manifest.sourceFrames.length
  ) {
    add(
      'GUI_ANIMATION_SOURCE_FRAMES_NOT_DISTINCT',
      'error',
      `${manifest.sprite} must use independently authored source frames with distinct source and pixel hashes.`,
      {
        frameCount: manifest.sourceFrames.length,
        distinctSourceHashes: fileHashes.size,
        distinctPixelHashes: pixelHashes.size,
      },
    );
  }

  const fallbackSprite = graph.sprites.find(({ name }) => name === manifest.staticFallback.sprite);
  if (
    sprite.staticFallback !== manifest.staticFallback.sprite ||
    fallbackSprite === undefined ||
    normalizedAssetPath(fallbackSprite.texturePath ?? '') !==
      normalizedAssetPath(manifest.staticFallback.path)
  ) {
    add(
      'GUI_ANIMATION_SOURCE_STATIC_FALLBACK_MISMATCH',
      'error',
      `${manifest.sprite} manifest static fallback does not match a resolvable sprite and texture.`,
      {
        manifestSprite: manifest.staticFallback.sprite,
        declaredSprite: sprite.staticFallback ?? null,
        manifestPath: manifest.staticFallback.path,
        resolvedPath: fallbackSprite?.texturePath ?? null,
      },
    );
  }
  const fallbackFile = catalog.resolveFile(manifest.staticFallback.path, manifest.sourcePath);
  const fallbackRaster = await catalog.loadRaster(
    manifest.staticFallback.path,
    manifest.sourcePath,
  );
  if (fallbackFile?.sha256 !== manifest.staticFallback.sha256) {
    add(
      'GUI_ANIMATION_SOURCE_HASH_MISMATCH',
      'error',
      `${manifest.sprite} static fallback hash does not match its manifest.`,
      {
        path: manifest.staticFallback.path,
        expected: manifest.staticFallback.sha256,
        actual: fallbackFile?.sha256 ?? null,
      },
    );
  }
  const fallbackSource = sourceRasters[manifest.staticFallback.frameIndex];
  if (
    manifest.staticFallback.frameIndex >= manifest.sourceFrames.length ||
    !fallbackRaster.supported ||
    fallbackRaster.width !== manifest.sheet.frameWidth ||
    fallbackRaster.height !== manifest.sheet.frameHeight ||
    fallbackSource?.supported !== true ||
    sha256Bytes(fallbackRaster.data) !== sha256Bytes(fallbackSource.data)
  ) {
    add(
      'GUI_ANIMATION_SOURCE_STATIC_FALLBACK_CONTENT_MISMATCH',
      'error',
      `${manifest.sprite} static fallback must exactly match its declared source frame.`,
      { frameIndex: manifest.staticFallback.frameIndex, path: manifest.staticFallback.path },
    );
  }
}

async function validateGuiAnimationsInto(
  graph: GuiSourceGraph,
  files: readonly ScannedFile[],
  selectedSpriteNames: ReadonlySet<string> | undefined,
  catalog: GuiAssetCatalog,
  diagnostics: DiagnosticCollector,
): Promise<void> {
  const spriteNames = new Set(graph.sprites.map(({ name }) => name));
  const fallbackEdges = new Set(
    graph.edges
      .filter((edge) => edge.kind === 'static_fallback' && edge.resolved)
      .map(({ from }) => from),
  );
  const manifestsBySprite = new Map<string, GuiAnimationSourceManifest[]>();
  for (const manifest of graph.animationSources) {
    const manifests = manifestsBySprite.get(manifest.sprite) ?? [];
    manifests.push(manifest);
    manifestsBySprite.set(manifest.sprite, manifests);
  }
  for (const sprite of graph.sprites) {
    if (selectedSpriteNames !== undefined && !selectedSpriteNames.has(sprite.name)) continue;
    const location = sprite.location;
    const add = (code: string, severity: Diagnostic['severity'], message: string): void => {
      diagnostics.push({
        code,
        severity,
        category: code.includes('DIMENSION') || code.includes('ANCHOR') ? 'layout' : 'rendering',
        message,
        ...(location === undefined ? {} : { location }),
      });
    };
    if (sprite.frameCount < 1)
      add(
        'GUI_SPRITE_FRAME_COUNT_INVALID',
        'error',
        `${sprite.name} has invalid noOfFrames ${sprite.frameCount}.`,
      );
    if (sprite.frameAnimated && sprite.frameCount < 2)
      add(
        'GUI_ANIMATION_FRAME_COUNT_INVALID',
        'error',
        `${sprite.name} is frame-animated but noOfFrames is ${sprite.frameCount}.`,
      );
    if (
      sprite.frameAnimated &&
      (sprite.animationRateFps === undefined ||
        !Number.isFinite(sprite.animationRateFps) ||
        sprite.animationRateFps <= 0)
    )
      add(
        'GUI_ANIMATION_RATE_INVALID',
        'error',
        `${sprite.name} must declare a positive animation_rate_fps; fractional rates are supported.`,
      );
    if (sprite.texturePath === undefined) {
      add(
        sprite.frameAnimated ? 'GUI_ANIMATION_TEXTURE_MISSING' : 'GUI_TEXTURE_MISSING',
        'error',
        `${sprite.name} has no texturefile.`,
      );
      continue;
    }
    const raster = await catalog.loadRaster(sprite.texturePath, sprite.sourcePath);
    if (!raster.supported) {
      add(
        sprite.frameAnimated ? 'GUI_ANIMATION_TEXTURE_UNSUPPORTED' : 'GUI_TEXTURE_UNSUPPORTED',
        'error',
        `${sprite.name}: ${raster.reason ?? 'texture unsupported'}`,
      );
      continue;
    }
    const safeFrameCount = Math.max(1, sprite.frameCount);
    if (raster.width % safeFrameCount !== 0)
      add(
        sprite.frameAnimated
          ? 'GUI_ANIMATION_SHEET_DIMENSION_INVALID'
          : 'GUI_SPRITE_SHEET_DIMENSION_INVALID',
        'error',
        `${sprite.name} sheet width ${raster.width} is not divisible by noOfFrames ${sprite.frameCount}.`,
      );
    const frameWidth = raster.width / safeFrameCount;
    if (
      sprite.declaredSize !== undefined &&
      (sprite.declaredSize.width !== frameWidth || sprite.declaredSize.height !== raster.height)
    ) {
      add(
        'GUI_SPRITE_DECLARED_SIZE_MISMATCH',
        'warning',
        `${sprite.name} declares ${sprite.declaredSize.width}x${sprite.declaredSize.height}, but a frame is ${frameWidth}x${raster.height}.`,
      );
    }
    if (sprite.frameAnimated && Number.isInteger(frameWidth)) {
      const bounds = Array.from({ length: safeFrameCount }, (_unused, index) =>
        alphaBounds(raster.data, raster.width, raster.height, index * frameWidth, frameWidth),
      );
      const centres = bounds.flatMap((bound) =>
        bound === undefined
          ? []
          : [{ x: bound.x + bound.width / 2, y: bound.y + bound.height / 2 }],
      );
      if (centres.length > 1) {
        const spreadX =
          Math.max(...centres.map(({ x }) => x)) - Math.min(...centres.map(({ x }) => x));
        const spreadY =
          Math.max(...centres.map(({ y }) => y)) - Math.min(...centres.map(({ y }) => y));
        if (spreadX > frameWidth * 0.25 || spreadY > raster.height * 0.25)
          add(
            'GUI_ANIMATION_ANCHOR_DRIFT',
            'warning',
            `${sprite.name} visible alpha bounds shift ${spreadX.toFixed(1)}px horizontally and ${spreadY.toFixed(1)}px vertically across equal-size frames.`,
          );
      }
      if (!raster.data.some((value, index) => index % 4 === 3 && value < 255))
        add(
          'GUI_ANIMATION_TRANSPARENCY_ABSENT',
          'info',
          `${sprite.name} has no transparent pixels; verify that an opaque strip is intentional.`,
        );
    }
    if (sprite.frameAnimated) {
      if (!fallbackEdges.has(sprite.id))
        add(
          'GUI_ANIMATION_STATIC_FALLBACK_MISSING',
          'warning',
          `${sprite.name} has no resolvable static fallback sprite.`,
        );
      if (sprite.staticFallback !== undefined && !spriteNames.has(sprite.staticFallback)) {
        const partialFallback = graph.edges.some(
          (edge) =>
            edge.kind === 'static_fallback' &&
            edge.from === sprite.id &&
            !edge.resolved &&
            edge.partialInventory === true,
        );
        add(
          partialFallback
            ? 'GUI_REFERENCE_UNRESOLVED_PARTIAL'
            : 'GUI_ANIMATION_STATIC_FALLBACK_INVALID',
          partialFallback ? 'warning' : 'error',
          partialFallback
            ? `The partial GUI inventory cannot resolve static fallback ${sprite.staticFallback} for ${sprite.name}; a skipped source could define it.`
            : `${sprite.name} references missing static fallback ${sprite.staticFallback}.`,
        );
      }
      if (sprite.looping === undefined)
        add(
          'GUI_ANIMATION_LOOP_UNDECLARED',
          'info',
          `${sprite.name} relies on the engine default for looping.`,
        );
      if (sprite.playOnShow === undefined)
        add(
          'GUI_ANIMATION_PLAY_ON_SHOW_UNDECLARED',
          'info',
          `${sprite.name} relies on the engine default for play_on_show.`,
        );
      const manifests = manifestsBySprite.get(sprite.name) ?? [];
      if (manifests.length === 0) {
        add(
          'GUI_ANIMATION_SOURCE_PROVENANCE_UNAVAILABLE',
          'info',
          `${sprite.name} is validated from its real frame sheet; no project-owned source manifest is present.`,
        );
      } else if (manifests.length > 1) {
        add(
          'GUI_ANIMATION_SOURCE_MANIFEST_DUPLICATE',
          'error',
          `${sprite.name} has more than one animation source manifest.`,
        );
      } else {
        const manifest = manifests[0];
        if (manifest !== undefined)
          await validateAnimationSourceManifest(sprite, manifest, graph, catalog, diagnostics);
      }
    }
  }
}

const animationValidationCodes = [
  'GUI_SPRITE_FRAME_COUNT_INVALID',
  'GUI_SPRITE_SHEET_DIMENSION_INVALID',
  'GUI_ANIMATION_FRAME_COUNT_INVALID',
  'GUI_ANIMATION_RATE_INVALID',
  'GUI_ANIMATION_SHEET_DIMENSION_INVALID',
  'GUI_ANIMATION_STATIC_FALLBACK_MISSING',
  'GUI_ANIMATION_SOURCE_MANIFEST_DUPLICATE',
  'GUI_ANIMATION_SOURCE_HASH_MISMATCH',
  'GUI_ANIMATION_SOURCE_FRAME_COUNT_MISMATCH',
  'GUI_ANIMATION_SOURCE_FRAME_DIMENSION_MISMATCH',
  'GUI_ANIMATION_SOURCE_FRAMES_NOT_DISTINCT',
  'GUI_ANIMATION_SOURCE_SHEET_CELL_MISMATCH',
  'GUI_ANIMATION_SOURCE_SETTINGS_MISMATCH',
  'GUI_ANIMATION_SOURCE_STATIC_FALLBACK_CONTENT_MISMATCH',
  'GUI_ANIMATION_ANCHOR_DRIFT',
  'GUI_ANIMATION_SOURCE_MANIFEST_DUPLICATE',
  'GUI_ANIMATION_SOURCE_HASH_MISMATCH',
  'GUI_ANIMATION_SOURCE_FRAME_COUNT_MISMATCH',
  'GUI_ANIMATION_SOURCE_FRAME_DIMENSION_MISMATCH',
  'GUI_ANIMATION_SOURCE_FRAMES_NOT_DISTINCT',
  'GUI_ANIMATION_SOURCE_SHEET_CELL_MISMATCH',
  'GUI_ANIMATION_SOURCE_SETTINGS_MISMATCH',
  'GUI_ANIMATION_SOURCE_STATIC_FALLBACK_CONTENT_MISMATCH',
] as const;

export async function validateGuiAnimations(
  graph: GuiSourceGraph,
  files: readonly ScannedFile[],
  selectedSpriteNames?: ReadonlySet<string>,
  catalog = new GuiAssetCatalog(graph, files),
): Promise<GuiValidationResult> {
  const diagnostics = validationCollector();
  await validateGuiAnimationsInto(graph, files, selectedSpriteNames, catalog, diagnostics);
  return validationResult(diagnostics.values(), animationValidationCodes);
}

function validateResolutionDriftInto(
  scenes: readonly GuiScene[],
  diagnostics: DiagnosticCollector,
): void {
  const baseline = scenes[0];
  if (baseline !== undefined) {
    for (let sceneIndex = 1; sceneIndex < scenes.length; sceneIndex += 1) {
      const scene = scenes[sceneIndex];
      if (scene === undefined) continue;
      const targets = new Map(
        scene.elements.map((element) => [`${element.sourceId}:${element.rowIndex ?? -1}`, element]),
      );
      for (const element of baseline.elements) {
        const target = targets.get(`${element.sourceId}:${element.rowIndex ?? -1}`);
        if (target === undefined) continue;
        const left = {
          x: element.unclippedRect.x / baseline.resolution.width,
          y: element.unclippedRect.y / baseline.resolution.height,
        };
        const right = {
          x: target.unclippedRect.x / scene.resolution.width,
          y: target.unclippedRect.y / scene.resolution.height,
        };
        const drift = Math.hypot(left.x - right.x, left.y - right.y);
        if (drift > 0.03)
          diagnostics.push(
            issue(
              'GUI_RESOLUTION_DRIFT',
              'warning',
              'layout',
              `${element.name} drifts ${(drift * 100).toFixed(1)}% of normalized viewport position between ${baseline.resolution.width}x${baseline.resolution.height} and ${scene.resolution.width}x${scene.resolution.height}.`,
              target,
            ),
          );
      }
    }
  }
}

export function validateResolutionDrift(scenes: readonly GuiScene[]): GuiValidationResult {
  const diagnostics = validationCollector();
  validateResolutionDriftInto(scenes, diagnostics);
  return validationResult(diagnostics.values(), ['GUI_RESOLUTION_DRIFT']);
}

function validateStateMatrixInto(
  scenes: readonly GuiScene[],
  diagnostics: DiagnosticCollector,
): void {
  const available = new Set(scenes.map(({ scenario }) => scenario.state));
  for (const state of allStates) {
    if (!available.has(state))
      diagnostics.push({
        code: 'GUI_STATE_COVERAGE_MISSING',
        severity: 'warning',
        category: 'design',
        message: `State matrix does not include ${state}.`,
        details: { state },
      });
  }
  for (const scene of scenes) validateScrollAndTabs(scene, diagnostics);
}

export function validateStateMatrix(scenes: readonly GuiScene[]): GuiValidationResult {
  const diagnostics = validationCollector();
  validateStateMatrixInto(scenes, diagnostics);
  return validationResult(diagnostics.values(), [
    'GUI_STATE_COVERAGE_MISSING',
    'GUI_TAB_STATE_CONFLICT',
  ]);
}

function validationResult(
  diagnostics: readonly Diagnostic[],
  codes: readonly string[],
): GuiValidationResult {
  const sorted = sortDiagnostics(diagnostics);
  return {
    diagnostics: sorted,
    checks: codes.map((code) => {
      const count = sorted.filter((diagnostic) => diagnostic.code === code).length;
      return {
        id: code.toLowerCase(),
        passed: count === 0,
        message:
          count === 0
            ? `${code} not detected.`
            : `${code} detected ${count} time${count === 1 ? '' : 's'}.`,
      };
    }),
  };
}

export async function validateGuiScene(
  graph: GuiSourceGraph,
  scene: GuiScene,
  files: readonly ScannedFile[],
  relatedScenes: readonly GuiScene[] = [],
  catalog = new GuiAssetCatalog(graph, files),
): Promise<GuiValidationResult> {
  if (
    graph.nodes.length > GUI_GRAPH_MAX_NODES ||
    scene.elements.length > GUI_SCENE_MAX_ELEMENTS ||
    graph.edges.length > GUI_GRAPH_MAX_EDGES
  ) {
    const diagnostic: Diagnostic = {
      code: 'GUI_VALIDATION_GRAPH_BUDGET_BLOCKED',
      severity: 'blocker',
      category: 'layout',
      message: 'GUI graph exceeds the fixed validation work ceiling',
      details: {
        nodes: graph.nodes.length,
        maximumNodes: GUI_GRAPH_MAX_NODES,
        elements: scene.elements.length,
        maximumElements: GUI_SCENE_MAX_ELEMENTS,
        edges: graph.edges.length,
        maximumEdges: GUI_GRAPH_MAX_EDGES,
      },
    };
    return {
      diagnostics: [diagnostic],
      checks: [{ id: diagnostic.code, passed: false, message: diagnostic.message }],
    };
  }
  const diagnostics = validationCollector();
  const work = new GuiValidationWorkBudget();
  diagnostics.pushMany(scene.diagnostics);
  validateOverlapAndGeometry(scene, diagnostics, work);
  validateAlignmentAndSpacing(scene, diagnostics, work);
  validateReferencesAndScript(graph, scene, diagnostics);
  validateScrollAndTabs(scene, diagnostics);
  const selectedSpriteNames = new Set<string>();
  for (const element of scene.elements)
    if (element.sprite !== undefined) selectedSpriteNames.add(element.sprite.spriteName);
  await validateGuiAnimationsInto(graph, files, selectedSpriteNames, catalog, diagnostics);
  if (relatedScenes.length > 0) validateResolutionDriftInto([scene, ...relatedScenes], diagnostics);
  return validationResult(diagnostics.values(), [
    'GUI_VALIDATION_DIAGNOSTICS_TRUNCATED',
    'GUI_VALIDATION_COMPARISON_BUDGET_BLOCKED',
    'GUI_VALIDATION_ANCESTOR_BUDGET_BLOCKED',
    'GUI_VISIBLE_OVERLAP',
    'GUI_ACCIDENTAL_CLIPPING',
    'GUI_TEXT_OVERFLOW',
    'GUI_INCONSISTENT_ALIGNMENT',
    'GUI_INCONSISTENT_SPACING',
    'GUI_INVALID_SIZE',
    'GUI_CHILD_OUTSIDE_CLIPPED_PARENT',
    'GUI_CLICK_BOUNDS_MISMATCH',
    'GUI_INVISIBLE_CLICK_BLOCKER',
    'GUI_CONFLICTING_CLICK_REGIONS',
    'GUI_MISSING_SPRITE',
    'GUI_MISSING_TEXTURE',
    'GUI_MISSING_FONT',
    'GUI_MISSING_LOCALISATION',
    'GUI_ANIMATION_FRAME_COUNT_INVALID',
    'GUI_ANIMATION_SHEET_DIMENSION_INVALID',
    'GUI_ANIMATION_STATIC_FALLBACK_MISSING',
    'GUI_PARENT_WINDOW_INVALID',
    'GUI_SCRIPTED_CONTEXT_INVALID',
    'GUI_Z_ORDER_RISK',
    'GUI_SCROLL_ROW_CUTOFF',
    'GUI_RESOLUTION_DRIFT',
    'GUI_TAB_STATE_CONFLICT',
    'GUI_BUTTON_EFFECT_MISSING',
    'GUI_BUTTON_TRIGGER_MISSING',
    'GUI_COST_MISMATCH',
    'GUI_COST_DISPLAY_CONFLICT',
    'GUI_AI_EQUIVALENT_MISSING',
    'GUI_RENDER_FIELD_UNSUPPORTED',
  ]);
}
