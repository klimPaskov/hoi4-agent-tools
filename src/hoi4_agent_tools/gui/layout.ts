import { compareCodeUnits, hashCanonical } from '../core/canonical.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { assertRenderDimensions } from '../core/render-budget.js';
import { sortDiagnostics } from '../core/diagnostics.js';
import { ServiceError } from '../core/result.js';
import type { ScannedFile } from '../core/scanner.js';
import { GuiAssetCatalog } from './assets.js';
import {
  GUI_GRAPH_MAX_EDGES,
  GUI_GRAPH_MAX_ELEMENTS,
  GUI_GRAPH_MAX_NODES,
  GUI_SCENE_MAX_DEPTH,
  GUI_SCENE_MAX_ELEMENTS,
  GUI_SCENE_MAX_TEXT_CHARACTERS,
  GUI_SCENE_MAX_TEXT_LAYOUT_OPERATIONS,
  GUI_SCENE_MAX_WORK,
  GUI_TEXT_MAX_CHARACTERS,
  GUI_TEXT_MAX_MISSING_GLYPH_SAMPLES,
} from './limits.js';
import { guiElementAttributeFidelity } from './source-graph.js';
import type {
  FidelityCategory,
  FidelityItem,
  FidelityReport,
  GuiElementDefinition,
  GuiPreviewScenario,
  GuiPreviewState,
  GuiPropertyValue,
  GuiRect,
  GuiScene,
  GuiSceneElement,
  GuiSourceGraph,
  GuiTextLayout,
} from './types.js';
import { emptyFidelityReport } from './types.js';

const clickableTypes = /(?:button|checkbox|editbox|scrollbar|progressbar)/iu;

const partialSpriteSemantics: Readonly<Record<string, { field: string; detail: string }>> = {
  textSpriteType: {
    field: 'text_sprite_semantics',
    detail:
      'Engine text-sprite generation is not modelled; only the resolved primary texture is shown.',
  },
  corneredTileSpriteType: {
    field: 'cornered_tile_semantics',
    detail:
      'Corner and edge tiling is not modelled; the primary texture is stretched as one frame.',
  },
  progressbarType: {
    field: 'progressbar_sprite_semantics',
    detail:
      'Progressbar sprite composition is not modelled; only the resolved primary texture is shown.',
  },
  maskedShieldType: {
    field: 'masked_shield_semantics',
    detail:
      'Mask, shield, and secondary-texture composition is not modelled; only the resolved primary texture is shown.',
  },
};

function property(
  attributes: Record<string, GuiPropertyValue>,
  ...names: string[]
): GuiPropertyValue | undefined {
  const lowered = new Set(names.map((name) => name.toLowerCase()));
  const entry = Object.entries(attributes).find(([name]) => lowered.has(name.toLowerCase()));
  return entry?.[1];
}

function objectProperty(
  value: GuiPropertyValue | undefined,
): Record<string, GuiPropertyValue> | undefined {
  return typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function scalarString(value: GuiPropertyValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function visibleHoiText(value: string): string {
  return value.replace(/\u00a7[A-Za-z0-9!]/gu, '').replace(/\u00a3[^\u00a3\s]+/gu, '\u25c6');
}

function scalarNumber(value: GuiPropertyValue | undefined, reference: number): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  if (value.endsWith('%')) {
    const percent = Number(value.slice(0, -1));
    return Number.isFinite(percent) ? (reference * percent) / 100 : undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function scalarBoolean(value: GuiPropertyValue | undefined): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'yes' || value === 'true') return true;
  if (value === 'no' || value === 'false') return false;
  return undefined;
}

function rectIntersection(left: GuiRect, right: GuiRect): GuiRect | undefined {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const edgeX = Math.min(left.x + left.width, right.x + right.width);
  const edgeY = Math.min(left.y + left.height, right.y + right.height);
  return edgeX <= x || edgeY <= y ? undefined : { x, y, width: edgeX - x, height: edgeY - y };
}

function equalRect(left: GuiRect, right: GuiRect): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function unionRects(rectangles: readonly GuiRect[]): GuiRect {
  if (rectangles.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...rectangles.map(({ x }) => x));
  const minY = Math.min(...rectangles.map(({ y }) => y));
  const maxX = Math.max(...rectangles.map(({ x, width }) => x + width));
  const maxY = Math.max(...rectangles.map(({ y, height }) => y + height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function addFidelity(
  report: FidelityReport,
  category: FidelityCategory,
  field: string,
  detail: string,
  element?: GuiElementDefinition,
): void {
  const item: FidelityItem = {
    field,
    detail,
    ...(element === undefined ? {} : { elementId: element.id, sourcePath: element.sourcePath }),
  };
  if (
    !report[category].some(
      (candidate) =>
        candidate.field === item.field &&
        candidate.detail === item.detail &&
        candidate.elementId === item.elementId,
    )
  ) {
    report[category].push(item);
  }
}

function diagnostic(
  code: string,
  severity: Diagnostic['severity'],
  message: string,
  element?: GuiElementDefinition,
): Diagnostic {
  return {
    code,
    severity,
    category: 'rendering',
    message,
    ...(element?.location === undefined ? {} : { location: element.location }),
  };
}

function assertTextLength(text: string, phase: string): void {
  if (text.length <= GUI_TEXT_MAX_CHARACTERS) return;
  throw new ServiceError(
    'GUI_TEXT_BUDGET_BLOCKED',
    `${phase} exceeds the fixed character ceiling`,
    {
      phase,
      characters: text.length,
      maximumCharacters: GUI_TEXT_MAX_CHARACTERS,
    },
  );
}

function replaceTextBounded(
  input: string,
  pattern: RegExp,
  replacement: (match: RegExpMatchArray) => string,
  phase: string,
): string {
  assertTextLength(input, phase);
  const parts: string[] = [];
  let cursor = 0;
  let outputLength = 0;
  for (const match of input.matchAll(pattern)) {
    const start = match.index;
    const prefix = input.slice(cursor, start);
    const value = replacement(match);
    const requested = outputLength + prefix.length + value.length;
    if (requested > GUI_TEXT_MAX_CHARACTERS) {
      throw new ServiceError(
        'GUI_TEXT_BUDGET_BLOCKED',
        `${phase} exceeds the fixed character ceiling`,
        { phase, characters: requested, maximumCharacters: GUI_TEXT_MAX_CHARACTERS },
      );
    }
    parts.push(prefix, value);
    outputLength = requested;
    cursor = start + match[0].length;
  }
  const suffix = input.slice(cursor);
  if (outputLength + suffix.length > GUI_TEXT_MAX_CHARACTERS) {
    throw new ServiceError(
      'GUI_TEXT_BUDGET_BLOCKED',
      `${phase} exceeds the fixed character ceiling`,
      {
        phase,
        characters: outputLength + suffix.length,
        maximumCharacters: GUI_TEXT_MAX_CHARACTERS,
      },
    );
  }
  parts.push(suffix);
  return parts.join('');
}

function resolveTokenText(
  value: string,
  scenario: GuiPreviewScenario,
  localisation: ReadonlyMap<string, string>,
  rowValues?: Readonly<Record<string, string | number | boolean>>,
): { text: string; unresolved: string[]; missingLocalisation: boolean } {
  const unresolved: string[] = [];
  let missingLocalisation = false;
  const localised = scenario.localisation[value] ?? localisation.get(value);
  let text = localised ?? value;
  assertTextLength(text, 'GUI resolved localisation');
  if (
    localised === undefined &&
    /^[A-Za-z0-9_.-]+$/u.test(value) &&
    (value.includes('_') || value === value.toUpperCase())
  )
    missingLocalisation = true;
  text = replaceTextBounded(
    text,
    /\$([A-Za-z0-9_.-]+)\$/gu,
    (match) => {
      const key = match[1] ?? '';
      const replacement = scenario.localisation[key] ?? localisation.get(key);
      if (replacement === undefined) {
        unresolved.push(`$${key}$`);
        return `$${key}$`;
      }
      return replacement;
    },
    'GUI localisation substitution',
  );
  text = replaceTextBounded(
    text,
    /\[\?([A-Za-z0-9_.-]+)(?:\|[^\]]+)?\]/gu,
    (match) => {
      const key = match[1] ?? '';
      const replacement = rowValues?.[key] ?? scenario.variables[key] ?? scenario.scriptedGui[key];
      if (replacement === undefined) {
        unresolved.push(`[?${key}]`);
        return `[?${key}]`;
      }
      return String(replacement);
    },
    'GUI variable substitution',
  );
  text = replaceTextBounded(
    text,
    /\[([A-Za-z0-9_.:-]+)\]/gu,
    (match) => {
      const key = match[1] ?? '';
      const countryKey = key.replace(/^(?:ROOT|This)\./u, '');
      const replacement =
        rowValues?.[countryKey] ??
        scenario.country?.[countryKey] ??
        scenario.stateValues?.[countryKey] ??
        scenario.scriptedGui[key];
      if (replacement === undefined) {
        unresolved.push(match[0]);
        return match[0];
      }
      return String(replacement);
    },
    'GUI scope substitution',
  );
  return { text, unresolved: [...new Set(unresolved)].sort(), missingLocalisation };
}

function wrapText(
  catalog: GuiAssetCatalog,
  fontName: string | undefined,
  text: string,
  fontSize: number,
  maximumWidth: number,
  work: GuiSceneWorkBudget,
): {
  lines: string[];
  widths: number[];
  lineHeight: number;
  metricSource: GuiTextLayout['metricSource'];
  missingGlyphs: number[];
} {
  const paragraphs = text.replaceAll('\\n', '\n').split('\n');
  const lines: string[] = [];
  const widths: number[] = [];
  const missingGlyphs = new Set<number>();
  const retainMissingGlyphs = (values: readonly number[]): void => {
    for (const value of values) {
      if (missingGlyphs.size >= GUI_TEXT_MAX_MISSING_GLYPH_SAMPLES) return;
      missingGlyphs.add(value);
    }
  };
  let lineHeight = fontSize * 1.2;
  let metricSource: GuiTextLayout['metricSource'] = 'approximation';
  for (const paragraph of paragraphs) {
    work.spendTextLayout('text paragraph layout');
    const words = paragraph.split(/\s+/u).filter((word) => word.length > 0);
    if (words.length === 0) {
      lines.push('');
      widths.push(0);
      continue;
    }
    let currentWords: string[] = [];
    let currentWidth = 0;
    let previousWord: string | undefined;
    let previousWordWidth = 0;
    for (const word of words) {
      work.spendTextLayout('text word measurement');
      const measuredWord = catalog.measureText(fontName, word, fontSize);
      retainMissingGlyphs(measuredWord.missingGlyphs);
      let candidateWidth = measuredWord.width;
      if (previousWord !== undefined) {
        work.spendTextLayout('text word-boundary measurement');
        const boundary = catalog.measureText(fontName, `${previousWord} ${word}`, fontSize);
        retainMissingGlyphs(boundary.missingGlyphs);
        candidateWidth = currentWidth + boundary.width - previousWordWidth;
      }
      if (maximumWidth > 0 && candidateWidth > maximumWidth && currentWords.length > 0) {
        const committedText = currentWords.join(' ');
        work.spendTextLayout('committed text line measurement');
        const committed = catalog.measureText(fontName, committedText, fontSize);
        lines.push(committedText);
        widths.push(committed.width);
        retainMissingGlyphs(committed.missingGlyphs);
        currentWords = [word];
        currentWidth = measuredWord.width;
      } else {
        currentWords.push(word);
        currentWidth = candidateWidth;
      }
      previousWord = word;
      previousWordWidth = measuredWord.width;
    }
    const committedText = currentWords.join(' ');
    work.spendTextLayout('committed text line measurement');
    const committed = catalog.measureText(fontName, committedText, fontSize);
    lines.push(committedText);
    widths.push(committed.width);
    retainMissingGlyphs(committed.missingGlyphs);
    lineHeight = committed.lineHeight;
    metricSource = committed.source;
  }
  return {
    lines,
    widths,
    lineHeight,
    metricSource,
    missingGlyphs: [...missingGlyphs].sort((a, b) => a - b),
  };
}

function frameFor(
  element: GuiElementDefinition,
  sprite: GuiSourceGraph['sprites'][number],
  scenario: GuiPreviewScenario,
): number {
  const frameCount = Math.max(1, sprite.frameCount);
  const selected = scenario.selectedFrames[element.name] ?? scenario.selectedFrames[sprite.name];
  if (selected !== undefined) return Math.min(frameCount - 1, selected);
  const explicit = scalarNumber(property(element.attributes, 'frame'), frameCount);
  if (explicit !== undefined)
    return Math.min(
      frameCount - 1,
      Math.max(0, Math.trunc(explicit > 0 ? explicit - 1 : explicit)),
    );
  if (sprite.frameAnimated) {
    const framesPerSecond = Math.max(Number.EPSILON, sprite.animationRateFps ?? 1);
    const clockSeconds =
      sprite.playOnShow === true
        ? (scenario.visibleTimeSeconds ?? scenario.animationTimeSeconds)
        : scenario.animationTimeSeconds;
    const animationDuration = frameCount / framesPerSecond;
    if (sprite.looping === false)
      return Math.min(frameCount - 1, Math.floor(clockSeconds * framesPerSecond));
    const cycleDuration = animationDuration + Math.max(0, sprite.pauseOnLoop ?? 0);
    const phase = cycleDuration === 0 ? 0 : clockSeconds % cycleDuration;
    return phase >= animationDuration
      ? frameCount - 1
      : Math.min(frameCount - 1, Math.floor(phase * framesPerSecond));
  }
  const state = scenario.elementStates[element.name] ?? scenario.state;
  const mapped =
    state === 'hover'
      ? 1
      : state === 'selected' || state === 'active'
        ? 2
        : state === 'locked' || state === 'disabled'
          ? 3
          : 0;
  return Math.min(frameCount - 1, mapped);
}

function alignment(
  attributes: Record<string, GuiPropertyValue>,
): Pick<GuiTextLayout, 'horizontalAlignment' | 'verticalAlignment'> {
  const format = scalarString(property(attributes, 'format'))?.toLowerCase() ?? '';
  const horizontalAlignment = format.includes('center')
    ? 'center'
    : format.includes('right')
      ? 'right'
      : 'left';
  const verticalAlignment = format.includes('bottom')
    ? 'bottom'
    : format.includes('center')
      ? 'center'
      : 'top';
  return { horizontalAlignment, verticalAlignment };
}

interface LayoutContext {
  graph: GuiSourceGraph;
  scenario: GuiPreviewScenario;
  catalog: GuiAssetCatalog;
  fidelity: FidelityReport;
  diagnostics: Diagnostic[];
  elementsById: Map<string, GuiElementDefinition>;
  spritesByName: Map<string, GuiSourceGraph['sprites'][number]>;
  localisation: Map<string, string>;
  output: GuiSceneElement[];
  instancesById: Map<string, GuiSceneElement>;
  work: GuiSceneWorkBudget;
  baseScale: number;
}

class GuiSceneWorkBudget {
  private work = 0;
  private elements = 0;
  private textCharacters = 0;
  private textLayoutOperations = 0;

  public spend(phase: string, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > GUI_SCENE_MAX_WORK - this.work) {
      throw new ServiceError(
        'GUI_SCENE_WORK_BUDGET_BLOCKED',
        'GUI scene expansion exceeds the fixed construction work ceiling',
        { phase, used: this.work, requested: amount, maximumWork: GUI_SCENE_MAX_WORK },
      );
    }
    this.work += amount;
  }

  public admitElement(depth: number): void {
    if (depth > GUI_SCENE_MAX_DEPTH) {
      throw new ServiceError(
        'GUI_SCENE_DEPTH_BUDGET_BLOCKED',
        'GUI scene expansion exceeds the fixed nesting depth ceiling',
        { depth, maximumDepth: GUI_SCENE_MAX_DEPTH },
      );
    }
    if (this.elements >= GUI_SCENE_MAX_ELEMENTS) {
      throw new ServiceError(
        'GUI_SCENE_ELEMENT_BUDGET_BLOCKED',
        'GUI scene expansion exceeds the fixed rendered element ceiling',
        { elements: this.elements + 1, maximumElements: GUI_SCENE_MAX_ELEMENTS },
      );
    }
    this.elements += 1;
    this.spend('scene element construction');
  }

  public admitText(text: string, phase: string): void {
    assertTextLength(text, phase);
    if (text.length > GUI_SCENE_MAX_TEXT_CHARACTERS - this.textCharacters) {
      throw new ServiceError(
        'GUI_SCENE_TEXT_BUDGET_BLOCKED',
        'GUI scene exceeds the fixed aggregate rendered-text ceiling',
        {
          phase,
          usedCharacters: this.textCharacters,
          requestedCharacters: text.length,
          maximumCharacters: GUI_SCENE_MAX_TEXT_CHARACTERS,
        },
      );
    }
    this.textCharacters += text.length;
  }

  public spendTextLayout(phase: string, amount = 1): void {
    if (
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      amount > GUI_SCENE_MAX_TEXT_LAYOUT_OPERATIONS - this.textLayoutOperations
    ) {
      throw new ServiceError(
        'GUI_TEXT_LAYOUT_WORK_BUDGET_BLOCKED',
        'GUI scene text layout exceeds the fixed measurement-operation ceiling',
        {
          phase,
          usedOperations: this.textLayoutOperations,
          requestedOperations: amount,
          maximumOperations: GUI_SCENE_MAX_TEXT_LAYOUT_OPERATIONS,
        },
      );
    }
    this.textLayoutOperations += amount;
  }
}

async function layoutElement(
  definition: GuiElementDefinition,
  parentRect: GuiRect,
  inheritedClip: GuiRect | undefined,
  parentScale: number,
  depth: number,
  context: LayoutContext,
  instanceSuffix = '',
  rowIndex?: number,
  rowValues?: Readonly<Record<string, string | number | boolean>>,
  parentInstanceId?: string,
): Promise<void> {
  context.work.admitElement(depth);
  const { scenario, catalog, fidelity, diagnostics } = context;
  const instanceId =
    instanceSuffix.length === 0 ? definition.id : `${definition.id}${instanceSuffix}`;
  const localScale = scalarNumber(property(definition.attributes, 'scale'), 1) ?? 1;
  const scale = parentScale * localScale;
  const position = objectProperty(property(definition.attributes, 'position'));
  const size = objectProperty(property(definition.attributes, 'size'));
  const localX =
    scalarNumber(position === undefined ? undefined : property(position, 'x'), parentRect.width) ??
    0;
  const localY =
    scalarNumber(position === undefined ? undefined : property(position, 'y'), parentRect.height) ??
    0;
  let width =
    (scalarNumber(
      size === undefined ? undefined : property(size, 'width', 'x'),
      parentRect.width,
    ) ?? 0) * scale;
  let height =
    (scalarNumber(
      size === undefined ? undefined : property(size, 'height', 'y'),
      parentRect.height,
    ) ?? 0) * scale;
  const background = objectProperty(property(definition.attributes, 'background'));
  const spriteName =
    scalarString(property(definition.attributes, 'spriteType', 'quadTextureSprite')) ??
    scalarString(
      background === undefined
        ? undefined
        : property(background, 'spriteType', 'quadTextureSprite'),
    );
  const spriteDefinition =
    spriteName === undefined ? undefined : context.spritesByName.get(spriteName.toLowerCase());
  let sprite: GuiSceneElement['sprite'];
  if (spriteName !== undefined && spriteDefinition === undefined) {
    const partialInventory = context.graph.edges.some(
      (edge) =>
        edge.kind === 'uses_sprite' &&
        edge.from === definition.id &&
        !edge.resolved &&
        edge.partialInventory === true,
    );
    addFidelity(
      fidelity,
      'missing',
      'spriteType',
      `Sprite ${spriteName} is not defined.`,
      definition,
    );
    diagnostics.push(
      diagnostic(
        partialInventory ? 'GUI_REFERENCE_UNRESOLVED_PARTIAL' : 'GUI_SPRITE_MISSING',
        partialInventory ? 'warning' : 'error',
        partialInventory
          ? `The partial GUI inventory cannot resolve sprite ${spriteName} for ${definition.name}; a skipped source could define it.`
          : `Element ${definition.name} references missing sprite ${spriteName}.`,
        definition,
      ),
    );
  } else if (spriteDefinition !== undefined) {
    const partialAppearance: string[] = [];
    const specialSemantics = partialSpriteSemantics[spriteDefinition.spriteType];
    if (specialSemantics !== undefined) {
      addFidelity(
        fidelity,
        'unsupported',
        specialSemantics.field,
        specialSemantics.detail,
        definition,
      );
      partialAppearance.push(specialSemantics.detail);
    }
    if (spriteDefinition.texturePath2 !== undefined) {
      const detail = `Secondary texture ${spriteDefinition.texturePath2} is retained in the source graph but is not composited.`;
      addFidelity(fidelity, 'unsupported', 'textureFile2', detail, definition);
      partialAppearance.push(detail);
    }
    if (spriteDefinition.effectFile !== undefined) {
      const detail = `Effect ${spriteDefinition.effectFile} is retained in the source graph but is not executed by the offline renderer.`;
      addFidelity(fidelity, 'unsupported', 'effectFile', detail, definition);
      partialAppearance.push(detail);
    }
    if (partialAppearance.length > 0)
      diagnostics.push(
        diagnostic(
          'GUI_SPRITE_RENDER_PARTIAL',
          'warning',
          `Element ${definition.name} has a partial sprite appearance: ${partialAppearance.join(' ')}`,
          definition,
        ),
      );
    const frame = frameFor(definition, spriteDefinition, scenario);
    sprite = await catalog.loadSpriteFrame(spriteDefinition, frame);
    if (!sprite?.supported) {
      addFidelity(
        fidelity,
        'unsupported',
        'texture',
        sprite?.reason ?? `Sprite ${spriteDefinition.name} has no texture.`,
        definition,
      );
      diagnostics.push(
        diagnostic(
          'GUI_TEXTURE_UNSUPPORTED',
          'warning',
          sprite?.reason ?? `Sprite ${spriteDefinition.name} has no texture.`,
          definition,
        ),
      );
    } else {
      if (width === 0) width = sprite.width * scale;
      if (height === 0) height = sprite.height * scale;
      addFidelity(
        fidelity,
        partialAppearance.length === 0 ? 'modelled' : 'approximated',
        'sprite_frame',
        partialAppearance.length === 0
          ? `${spriteDefinition.name} frame ${sprite.frame + 1}/${sprite.frameCount}`
          : `${spriteDefinition.name} frame ${sprite.frame + 1}/${sprite.frameCount} shows only the primary resolved texture; additional sprite semantics are omitted.`,
        definition,
      );
      if (spriteDefinition.frameAnimated) {
        addFidelity(
          fidelity,
          spriteDefinition.looping === undefined ? 'approximated' : 'modelled',
          'animation_looping',
          spriteDefinition.looping === false
            ? 'Animation stops on its final frame.'
            : spriteDefinition.looping === true
              ? `Animation loops with a ${spriteDefinition.pauseOnLoop ?? 0}s end pause.`
              : 'Animation uses the renderer looping default because the source omits looping.',
          definition,
        );
        addFidelity(
          fidelity,
          spriteDefinition.playOnShow === undefined ? 'approximated' : 'modelled',
          'animation_clock',
          spriteDefinition.playOnShow === true
            ? 'Animation samples time since the element became visible.'
            : spriteDefinition.playOnShow === false
              ? 'Animation samples the global scenario clock.'
              : 'Animation uses the global scenario clock because the source omits play_on_show.',
          definition,
        );
      }
    }
  }

  const rawText = scalarString(property(definition.attributes, 'text', 'buttonText'));
  let text: GuiTextLayout | undefined;
  if (rawText !== undefined) {
    const resolved = resolveTokenText(rawText, scenario, context.localisation, rowValues);
    let displayText = resolved.text;
    const state = scenario.elementStates[definition.name] ?? scenario.state;
    if (state === 'long-text') displayText = `${displayText} — ${displayText} — ${displayText}`;
    if (state === 'missing-localisation') displayText = `\u00a7R${rawText}_MISSING\u00a7!`;
    displayText = visibleHoiText(displayText);
    context.work.admitText(displayText, `GUI text for ${definition.name}`);
    const fontName = scalarString(property(definition.attributes, 'font', 'buttonFont'));
    const resolvedFontMetrics = catalog.resolvedFontMetrics(fontName);
    const explicitFontSize = scalarNumber(property(definition.attributes, 'fontSize'), 16);
    const fontSize =
      explicitFontSize ??
      resolvedFontMetrics.nativeSize ??
      context.catalog.fontDefinition(fontName ?? '')?.size ??
      16;
    const maxWidth =
      (scalarNumber(property(definition.attributes, 'maxWidth'), width / scale) ?? width / scale) *
      scale;
    const wrapped = wrapText(
      catalog,
      fontName,
      displayText,
      fontSize * scale,
      maxWidth,
      context.work,
    );
    const glyphLines = [];
    for (const line of wrapped.lines)
      glyphLines.push(await catalog.shapeText(fontName, line, fontSize * scale));
    const maximumLineWidth = wrapped.widths.reduce((maximum, value) => Math.max(maximum, value), 0);
    if (width === 0) width = maximumLineWidth;
    if (height === 0) height = wrapped.lines.length * wrapped.lineHeight;
    const measuredWidth = maximumLineWidth;
    const measuredHeight = wrapped.lines.length * wrapped.lineHeight;
    text = {
      text: displayText,
      lines: wrapped.lines,
      lineWidths: wrapped.widths,
      lineHeight: wrapped.lineHeight,
      fontSize: fontSize * scale,
      measuredWidth,
      measuredHeight,
      metricSource: wrapped.metricSource,
      ...alignment(definition.attributes),
      ...(fontName === undefined ? {} : { fontName }),
      glyphLines,
      overflowX: width > 0 && measuredWidth > width + 0.01,
      overflowY: height > 0 && measuredHeight > height + 0.01,
      unresolvedTokens: resolved.unresolved,
    };
    if (wrapped.metricSource === 'approximation')
      addFidelity(
        fidelity,
        'approximated',
        'font_metrics',
        `No supplied font metrics for ${fontName ?? '<default>'}.`,
        definition,
      );
    else
      addFidelity(
        fidelity,
        'modelled',
        'font_metrics',
        `${wrapped.metricSource} metrics for ${fontName ?? '<default>'}.`,
        definition,
      );
    const missingGlyphs = [
      ...new Set([...wrapped.missingGlyphs, ...glyphLines.flatMap((line) => line.missingGlyphs)]),
    ].slice(0, GUI_TEXT_MAX_MISSING_GLYPH_SAMPLES);
    if (missingGlyphs.length > 0)
      addFidelity(
        fidelity,
        'missing',
        'font_glyphs',
        `Missing glyphs: ${missingGlyphs.join(', ')}.`,
        definition,
      );
    const glyphSources = [...new Set(glyphLines.map(({ source }) => source))];
    const glyphsModelled =
      glyphSources.every((source) => source === 'fontkit-path' || source === 'bmfont-atlas') &&
      glyphLines.every(({ baselineModelled }) => baselineModelled);
    addFidelity(
      fidelity,
      glyphsModelled ? 'modelled' : 'approximated',
      'font_glyph_rendering',
      glyphsModelled
        ? `Deterministic ${glyphSources.join('/')} glyphs from scanned font assets.`
        : 'Deterministic project font paths substitute for unavailable workspace glyph data.',
      definition,
    );
    if (resolvedFontMetrics.source === 'bmfont')
      addFidelity(
        fidelity,
        resolvedFontMetrics.baselineModelled ? 'modelled' : 'approximated',
        'font_native_metrics',
        `BMFont native size ${resolvedFontMetrics.nativeSize}, line height ${resolvedFontMetrics.nativeLineHeight}, and baseline ${resolvedFontMetrics.nativeBaseline}${explicitFontSize === undefined ? ' determine this element layout' : ' are scaled to the element fontSize'}.`,
        definition,
      );
    if (resolved.missingLocalisation)
      addFidelity(
        fidelity,
        'missing',
        'localisation',
        `No ${scenario.language} localisation for ${rawText}.`,
        definition,
      );
    if (resolved.unresolved.length > 0)
      addFidelity(
        fidelity,
        'unresolved',
        'dynamic_text',
        `Unresolved tokens: ${resolved.unresolved.join(', ')}.`,
        definition,
      );
  }

  const orientation =
    scalarString(property(definition.attributes, 'orientation'))?.toLowerCase() ?? 'upper_left';
  const origo =
    scalarString(property(definition.attributes, 'origo'))?.toLowerCase() ?? 'upper_left';
  let x = parentRect.x + localX * scale;
  let y = parentRect.y + localY * scale;
  if (orientation.includes('right')) x = parentRect.x + parentRect.width - localX * scale - width;
  else if (orientation.includes('center')) x = parentRect.x + parentRect.width / 2 + localX * scale;
  if (orientation.includes('lower') || orientation.includes('bottom'))
    y = parentRect.y + parentRect.height - localY * scale - height;
  else if (orientation.includes('center'))
    y = parentRect.y + parentRect.height / 2 + localY * scale;
  if (origo.includes('center')) {
    x -= width / 2;
    y -= height / 2;
  } else {
    if (origo.includes('right')) x -= width;
    if (origo.includes('lower') || origo.includes('bottom')) y -= height;
  }
  const scrollOffset =
    (scenario.scrollOffsets[definition.name] ?? scenario.scrollOffsets[definition.id] ?? 0) * scale;
  const unclippedRect = { x, y, width: Math.max(0, width), height: Math.max(0, height) };
  const ownClipping = scalarBoolean(property(definition.attributes, 'clipping')) ?? false;
  const availableClip =
    inheritedClip === undefined ? unclippedRect : rectIntersection(inheritedClip, unclippedRect);
  const clipRect = inheritedClip;
  const clipped =
    clipRect !== undefined &&
    (availableClip === undefined || !equalRect(unclippedRect, availableClip));
  const explicitlyVisible =
    scenario.visibility[definition.name] ?? scenario.visibility[definition.id];
  const visible = explicitlyVisible ?? (availableClip !== undefined || inheritedClip === undefined);
  const clickThrough =
    scalarBoolean(
      property(definition.attributes, 'clickThrough', 'alwaystransparent', 'allwaystransparent'),
    ) ?? false;
  const clickable = clickableTypes.test(definition.elementType) && !clickThrough;
  const state: GuiPreviewState = scenario.elementStates[definition.name] ?? scenario.state;
  const zPriority = scalarNumber(property(definition.attributes, 'priority'), 0) ?? 0;
  let progressRatio: number | undefined;
  if (/progressbar/iu.test(definition.elementType)) {
    const minimum = scalarNumber(property(definition.attributes, 'minValue'), 1) ?? 0;
    const maximum = scalarNumber(property(definition.attributes, 'maxValue'), 1) ?? 100;
    const scriptedValue = scenario.scriptedGui[definition.name];
    let value =
      typeof scriptedValue === 'number'
        ? scriptedValue
        : (scalarNumber(property(definition.attributes, 'startValue'), maximum) ?? minimum);
    if (state === 'minimum-value') value = minimum;
    if (state === 'maximum-value' || state === 'completed') value = maximum;
    progressRatio =
      maximum === minimum ? 0 : Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
  }
  const sceneElement: GuiSceneElement = {
    id: instanceId,
    sourceId: definition.id,
    name: definition.name,
    elementType: definition.elementType,
    ...(parentInstanceId === undefined
      ? definition.parentId === undefined
        ? {}
        : {
            parentId:
              instanceSuffix.length === 0
                ? definition.parentId
                : `${definition.parentId}${instanceSuffix}`,
          }
      : { parentId: parentInstanceId }),
    depth,
    zIndex: Math.trunc(zPriority * 1_000_000 + definition.definitionOrder),
    visible,
    clickable,
    clickThrough,
    rect: availableClip ?? { x: unclippedRect.x, y: unclippedRect.y, width: 0, height: 0 },
    unclippedRect,
    ...(clipRect === undefined ? {} : { clipRect }),
    clipped,
    scale,
    state,
    ...(progressRatio === undefined ? {} : { progressRatio }),
    ...(sprite === undefined ? {} : { sprite }),
    ...(text === undefined ? {} : { text }),
    sourcePath: definition.sourcePath,
    ...(definition.location === undefined ? {} : { location: definition.location }),
    unsupportedAttributes: definition.unsupportedAttributes,
    ...(rowIndex === undefined ? {} : { rowIndex }),
  };
  context.output.push(sceneElement);
  context.instancesById.set(instanceId, sceneElement);
  addFidelity(
    fidelity,
    'modelled',
    'nested_offset',
    `Positioned ${definition.name} at ${x},${y} with scale ${scale}.`,
    definition,
  );
  for (const attribute of Object.keys(definition.attributes).sort((left, right) =>
    compareCodeUnits(left, right),
  )) {
    const classification = guiElementAttributeFidelity(attribute);
    if (classification === 'structural' || classification === 'unsupported') continue;
    addFidelity(
      fidelity,
      classification,
      attribute,
      classification === 'modelled'
        ? 'Parsed and applied by the offline scene model.'
        : 'Parsed and preserved, but intentionally omitted from the offline render.',
      definition,
    );
  }
  if (clipRect !== undefined)
    addFidelity(
      fidelity,
      'modelled',
      'clipping',
      `${definition.name} intersected its inherited clip rectangle.`,
      definition,
    );
  for (const unsupportedAttribute of definition.unsupportedAttributes)
    addFidelity(
      fidelity,
      'unsupported',
      unsupportedAttribute,
      `Parsed and preserved, but not rendered.`,
      definition,
    );

  const childParentRect = { ...unclippedRect, y: unclippedRect.y - scrollOffset };
  const childClip = ownClipping
    ? inheritedClip === undefined
      ? unclippedRect
      : rectIntersection(inheritedClip, unclippedRect)
    : inheritedClip;
  const childDefinitions = definition.childIds
    .map((id) => context.elementsById.get(id))
    .filter((element): element is GuiElementDefinition => element !== undefined);
  let rows = scenario.lists[definition.name] ?? scenario.lists[definition.id];
  if (state === 'empty-list') rows = [];
  if (state === 'full-list' && rows === undefined)
    rows = Array.from({ length: 12 }, (_unused, index) => ({ index }));
  if (
    rows !== undefined &&
    childDefinitions.length > 0 &&
    /(?:grid|listbox|scroll)/iu.test(definition.elementType)
  ) {
    const spacingValue = objectProperty(property(definition.attributes, 'spacing'));
    const spacingY =
      scalarNumber(
        spacingValue === undefined
          ? property(definition.attributes, 'spacing')
          : property(spacingValue, 'y'),
        height,
      ) ?? 0;
    let rowY = 0;
    for (const [index, row] of rows.entries()) {
      context.work.spend('scenario list row expansion');
      let rowHeight = 0;
      for (const child of childDefinitions) {
        context.work.spend('scenario list child expansion');
        const childPosition = objectProperty(property(child.attributes, 'position'));
        const originalY =
          scalarNumber(
            childPosition === undefined ? undefined : property(childPosition, 'y'),
            height,
          ) ?? 0;
        const shiftedParent = {
          ...childParentRect,
          y: childParentRect.y + rowY - originalY * scale,
        };
        await layoutElement(
          child,
          shiftedParent,
          childClip,
          scale,
          depth + 1,
          context,
          `${instanceSuffix}#row-${index}`,
          index,
          row,
          instanceId,
        );
        const rendered = context.instancesById.get(`${child.id}${instanceSuffix}#row-${index}`);
        rowHeight = Math.max(rowHeight, rendered?.unclippedRect.height ?? 0);
      }
      rowY += rowHeight + spacingY * scale;
    }
    addFidelity(
      fidelity,
      'modelled',
      'scroll_rows',
      `Expanded ${rows.length} scenario rows for ${definition.name}.`,
      definition,
    );
  } else {
    for (const child of childDefinitions) {
      context.work.spend('nested child expansion');
      await layoutElement(
        child,
        childParentRect,
        childClip,
        scale,
        depth + 1,
        context,
        instanceSuffix,
        rowIndex,
        rowValues,
        instanceId,
      );
    }
  }
}

/** Build a deterministic, offline approximation of a GUI window without launching HOI4. */
export async function buildGuiScene(
  graph: GuiSourceGraph,
  scannedFiles: readonly ScannedFile[],
  windowName: string,
  scenario: GuiPreviewScenario,
  catalog = new GuiAssetCatalog(graph, scannedFiles),
): Promise<GuiScene> {
  if (
    graph.nodes.length > GUI_GRAPH_MAX_NODES ||
    graph.edges.length > GUI_GRAPH_MAX_EDGES ||
    graph.elements.length > GUI_GRAPH_MAX_ELEMENTS
  ) {
    throw new ServiceError(
      'GUI_SCENE_GRAPH_BUDGET_BLOCKED',
      'GUI source graph exceeds the fixed scene-construction ceiling',
      {
        nodes: graph.nodes.length,
        maximumNodes: GUI_GRAPH_MAX_NODES,
        edges: graph.edges.length,
        maximumEdges: GUI_GRAPH_MAX_EDGES,
        elements: graph.elements.length,
        maximumElements: GUI_GRAPH_MAX_ELEMENTS,
      },
    );
  }
  assertRenderDimensions(
    scenario.resolution.width,
    scenario.resolution.height,
    'GUI scene resolution',
  );
  const fidelity = emptyFidelityReport();
  const diagnostics: Diagnostic[] = [];
  const elementsById = new Map(graph.elements.map((element) => [element.id, element]));
  const candidates = graph.elements.filter((element) => element.name === windowName);
  const root = candidates.toSorted(
    (left, right) =>
      compareCodeUnits(right.sourcePath, left.sourcePath) ||
      right.definitionOrder - left.definitionOrder,
  )[0];
  const baseScale =
    Math.min(scenario.resolution.width / 1920, scenario.resolution.height / 1080) *
    scenario.uiScale;
  addFidelity(
    fidelity,
    'approximated',
    'resolution_scale',
    `Coordinates use a 1920x1080 reference with UI scale ${scenario.uiScale}.`,
  );
  if (root === undefined) {
    diagnostics.push({
      code: 'GUI_WINDOW_MISSING',
      severity: 'error',
      category: 'reference',
      message: `GUI window ${windowName} was not found.`,
    });
    addFidelity(fidelity, 'missing', 'window', `GUI window ${windowName} was not found.`);
    return {
      windowName,
      scenario,
      resolution: scenario.resolution,
      elements: [],
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      fidelity,
      diagnostics: sortDiagnostics(diagnostics),
      sourceRevision: hashCanonical(graph.sourceHashes),
    };
  }
  const localisation = new Map(
    graph.localisation
      .filter(
        (entry) =>
          entry.language.toLowerCase() === scenario.language.toLowerCase() ||
          entry.language.toLowerCase() === `l_${scenario.language.toLowerCase()}`,
      )
      .map((entry) => [entry.key, entry.value]),
  );
  if (localisation.size === 0) {
    for (const entry of graph.localisation)
      if (!localisation.has(entry.key)) localisation.set(entry.key, entry.value);
    addFidelity(
      fidelity,
      'approximated',
      'language',
      `No exact ${scenario.language} bucket; used available localisation entries.`,
    );
  }
  let scriptedWindowVisible = true;
  for (const scripted of graph.scriptedGuis.filter(
    (definition) =>
      definition.windowName === windowName || definition.parentWindowName === windowName,
  )) {
    addFidelity(
      fidelity,
      'modelled',
      'scripted_gui_context',
      `${scripted.name} uses ${scripted.contextType ?? '<unspecified>'} context.`,
    );
    if (scripted.visibleExpression === undefined) continue;
    const mockedVisibility =
      scenario.visibility[scripted.name] ?? scenario.scriptedGui[`${scripted.name}.visible`];
    if (typeof mockedVisibility === 'boolean') {
      scriptedWindowVisible &&= mockedVisibility;
      addFidelity(
        fidelity,
        'modelled',
        'scripted_gui_visibility',
        `${scripted.name}.visible was supplied by the preview scenario.`,
      );
    } else {
      addFidelity(
        fidelity,
        'unresolved',
        'scripted_gui_visibility',
        `${scripted.name}.visible requires an explicit scenario mock; the offline renderer leaves it visible.`,
      );
    }
  }
  const layoutScenario = scriptedWindowVisible
    ? scenario
    : { ...scenario, visibility: { ...scenario.visibility, [root.name]: false } };
  const output: GuiSceneElement[] = [];
  const context: LayoutContext = {
    graph,
    scenario: layoutScenario,
    catalog,
    fidelity,
    diagnostics,
    elementsById,
    spritesByName: new Map(graph.sprites.map((sprite) => [sprite.name.toLowerCase(), sprite])),
    localisation,
    output,
    instancesById: new Map(),
    work: new GuiSceneWorkBudget(),
    baseScale,
  };
  const viewport = {
    x: 0,
    y: 0,
    width: scenario.resolution.width,
    height: scenario.resolution.height,
  };
  await layoutElement(root, viewport, viewport, baseScale, 0, context);
  output.sort((left, right) => left.zIndex - right.zIndex || compareCodeUnits(left.id, right.id));
  const bounds = unionRects(
    output.filter(({ visible }) => visible).map(({ unclippedRect }) => unclippedRect),
  );
  return {
    windowName,
    scenario,
    resolution: scenario.resolution,
    elements: output,
    bounds,
    fidelity,
    diagnostics: sortDiagnostics(diagnostics),
    sourceRevision: hashCanonical(graph.sourceHashes),
  };
}
