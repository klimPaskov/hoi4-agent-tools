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
  GuiTextColourRun,
  GuiTextGlyphLine,
  GuiTextInlineIcon,
  GuiTextLayout,
  ScriptedGuiDynamicListDefinition,
} from './types.js';
import { emptyFidelityReport } from './types.js';

const clickableTypes = /(?:button|checkbox|editbox|scrollbar|progressbar)/iu;
const numericDynamicPlaceholder = '[X]';
const textDynamicPlaceholder = '[dynamic_loc]';

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

const defaultTextColour = '#f5f2e8';
const hoi4TextColours: Readonly<Record<string, string>> = {
  C: '#23ceff',
  L: '#c3b091',
  W: '#ffffff',
  B: '#0000ff',
  G: '#009f03',
  R: '#ff3232',
  b: '#000000',
  g: '#b0b0b0',
  Y: '#ffbd00',
  H: '#ffbd00',
  T: '#ffffff',
  O: '#ff7019',
  '0': '#cb00cb',
  '1': '#8078d3',
  '2': '#5170f3',
  '3': '#518fdc',
  '4': '#5abee7',
  '5': '#3fb5c2',
  '6': '#77ccba',
  '7': '#99d199',
  '8': '#d1d175',
  '9': '#d1a675',
};

interface VisibleHoiText {
  text: string;
  colours: Array<string | undefined>;
  hasColourMarkup: boolean;
  inlineIcons: Array<{ marker: string; token: string }>;
}

const inlineIconMarkerStart = 0xe000;
const inlineIconMarkerEnd = 0xf8ff;

function visibleHoiText(
  value: string,
  fontTextColours: Readonly<Record<string, string>> = {},
): VisibleHoiText {
  const characters: string[] = [];
  const colours: Array<string | undefined> = [];
  const inlineIcons: Array<{ marker: string; token: string }> = [];
  let colour: string | undefined;
  let hasColourMarkup = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? '';
    const next = value[index + 1];
    if (character === '\u00a7' && next !== undefined && /^[A-Za-z0-9!]$/u.test(next)) {
      hasColourMarkup = true;
      colour = next === '!' ? undefined : (fontTextColours[next] ?? hoi4TextColours[next]);
      index += 1;
      continue;
    }
    if (character === '\u00a3') {
      let cursor = index + 1;
      while (cursor < value.length && !/[\s\u00a3]/u.test(value[cursor] ?? '')) cursor += 1;
      const token = value.slice(index + 1, cursor);
      const markerCodePoint = inlineIconMarkerStart + inlineIcons.length;
      if (token.length === 0 || markerCodePoint > inlineIconMarkerEnd) {
        characters.push('\u25c6');
        colours.push(colour);
      } else {
        const marker = String.fromCodePoint(markerCodePoint);
        inlineIcons.push({ marker, token });
        characters.push(marker);
        colours.push(colour);
      }
      index = cursor - 1;
      continue;
    }
    if (character === '\\' && next === 'n') {
      characters.push('\n');
      colours.push(colour);
      index += 1;
      continue;
    }
    characters.push(character);
    colours.push(colour);
  }
  return { text: characters.join(''), colours, hasColourMarkup, inlineIcons };
}

function scalarNumber(value: GuiPropertyValue | undefined, reference: number): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  if (/%%?$/u.test(value)) {
    const percent = Number(value.replace(/%%?$/u, ''));
    return Number.isFinite(percent) ? (reference * percent) / 100 : undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function scaledNumber(
  value: GuiPropertyValue | undefined,
  reference: number,
  scale: number,
): number | undefined {
  const resolved = scalarNumber(value, reference);
  if (resolved === undefined) return undefined;
  return typeof value === 'string' && /%%?$/u.test(value) ? resolved : resolved * scale;
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
    /\[\?([^\]|]+)(?:\|[^\]]+)?\]/gu,
    (match) => {
      const key = match[1] ?? '';
      const shortKey = key.slice(key.lastIndexOf('.') + 1);
      const replacement =
        rowValues?.[key] ??
        rowValues?.[shortKey] ??
        scenario.values[key] ??
        scenario.values[shortKey] ??
        scenario.variables[key] ??
        scenario.variables[shortKey] ??
        scenario.scriptedGui[key] ??
        scenario.scriptedGui[shortKey];
      if (replacement === undefined) {
        unresolved.push(match[0]);
        return /(?:^|\.)Get[A-Za-z0-9_]+$/u.test(key)
          ? textDynamicPlaceholder
          : numericDynamicPlaceholder;
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
      if (key === 'X' || key === 'dynamic_loc') return match[0];
      const countryKey = key.replace(/^(?:ROOT|This)\./u, '');
      const replacement =
        rowValues?.[key] ??
        rowValues?.[countryKey] ??
        scenario.values[key] ??
        scenario.values[countryKey] ??
        scenario.country?.[countryKey] ??
        scenario.stateValues?.[countryKey] ??
        scenario.scriptedGui[key];
      if (replacement === undefined) {
        unresolved.push(match[0]);
        return textDynamicPlaceholder;
      }
      return String(replacement);
    },
    'GUI scope substitution',
  );
  return { text, unresolved: [...new Set(unresolved)].sort(), missingLocalisation };
}

function scenarioExpressionValue(
  expression: GuiPropertyValue,
  values: Readonly<Record<string, string | number | boolean>>,
): string | number | boolean | undefined {
  if (typeof expression !== 'string') return undefined;
  const variableMatch = /^\[\?([^\]|]+)(?:\|[^\]]+)?\]$/u.exec(expression);
  const localisationMatch = /^\[([^\]]+)\]$/u.exec(expression);
  const token = variableMatch?.[1] ?? localisationMatch?.[1] ?? expression;
  const shortToken = token.slice(token.lastIndexOf('.') + 1);
  return values[token] ?? values[shortToken];
}

interface ResolvedInlineIcon {
  marker: string;
  token: string;
  spriteName: string;
  width: number;
  height: number;
  sprite?: GuiTextInlineIcon['sprite'];
}

function measureTextWithInlineIcons(
  catalog: GuiAssetCatalog,
  fontName: string | undefined,
  text: string,
  fontSize: number,
  inlineIcons: ReadonlyMap<string, ResolvedInlineIcon>,
) {
  if (inlineIcons.size === 0 || ![...inlineIcons.keys()].some((marker) => text.includes(marker)))
    return catalog.measureText(fontName, text, fontSize);
  let width = 0;
  let lineHeight = fontSize * 1.2;
  let source: GuiTextLayout['metricSource'] = 'approximation';
  const missingGlyphs = new Set<number>();
  let segment = '';
  const commit = (): void => {
    if (segment.length === 0) return;
    const measured = catalog.measureText(fontName, segment, fontSize);
    width += measured.width;
    lineHeight = Math.max(lineHeight, measured.lineHeight);
    source = measured.source;
    for (const codePoint of measured.missingGlyphs) missingGlyphs.add(codePoint);
    segment = '';
  };
  for (const character of text) {
    const icon = inlineIcons.get(character);
    if (icon === undefined) segment += character;
    else {
      commit();
      width += icon.width;
      lineHeight = Math.max(lineHeight, icon.height);
    }
  }
  commit();
  return { width, lineHeight, source, missingGlyphs: [...missingGlyphs] };
}

async function shapeTextWithInlineIcons(
  catalog: GuiAssetCatalog,
  fontName: string | undefined,
  text: string,
  fontSize: number,
  lineIndex: number,
  inlineIcons: ReadonlyMap<string, ResolvedInlineIcon>,
): Promise<{ glyphLine: GuiTextGlyphLine; icons: GuiTextInlineIcon[] }> {
  if (inlineIcons.size === 0 || ![...inlineIcons.keys()].some((marker) => text.includes(marker)))
    return { glyphLine: await catalog.shapeText(fontName, text, fontSize), icons: [] };
  const base = await catalog.shapeText(
    fontName,
    Array.from(text)
      .filter((character) => !inlineIcons.has(character))
      .join(''),
    fontSize,
  );
  const glyphs: GuiTextGlyphLine['glyphs'] = [];
  const missingGlyphs = new Set<number>();
  const sourceHashes = new Set<string>([base.sourceHash]);
  const sources = new Set<GuiTextGlyphLine['source']>([base.source]);
  let baseline = base.baseline;
  let baselineModelled = base.baselineModelled;
  let penX = 0;
  let segment = '';
  const icons: GuiTextInlineIcon[] = [];
  const commit = async (): Promise<void> => {
    if (segment.length === 0) return;
    const shaped = await catalog.shapeText(fontName, segment, fontSize);
    sourceHashes.add(shaped.sourceHash);
    sources.add(shaped.source);
    baseline = Math.max(baseline, shaped.baseline);
    baselineModelled &&= shaped.baselineModelled;
    for (const codePoint of shaped.missingGlyphs) missingGlyphs.add(codePoint);
    glyphs.push(...shaped.glyphs.map((glyph) => ({ ...glyph, x: glyph.x + penX })));
    penX += shaped.width;
    segment = '';
  };
  for (const character of text) {
    const icon = inlineIcons.get(character);
    if (icon === undefined) segment += character;
    else {
      await commit();
      icons.push({
        token: icon.token,
        spriteName: icon.spriteName,
        lineIndex,
        offsetX: penX,
        width: icon.width,
        height: icon.height,
        ...(icon.sprite === undefined ? {} : { sprite: icon.sprite }),
      });
      penX += icon.width;
    }
  }
  await commit();
  return {
    glyphLine: {
      source: sources.size === 1 ? [...sources][0]! : 'deterministic-fallback',
      sourceHash:
        sourceHashes.size === 1 ? [...sourceHashes][0]! : hashCanonical([...sourceHashes].sort()),
      width: penX,
      baseline,
      baselineModelled,
      glyphs,
      missingGlyphs: [...missingGlyphs].sort((left, right) => left - right),
    },
    icons,
  };
}

function wrapText(
  catalog: GuiAssetCatalog,
  fontName: string | undefined,
  text: string,
  colours: readonly (string | undefined)[],
  fontSize: number,
  maximumWidth: number,
  work: GuiSceneWorkBudget,
  inlineIcons: ReadonlyMap<string, ResolvedInlineIcon> = new Map(),
): {
  lines: string[];
  widths: number[];
  colourLines: Array<Array<string | undefined>>;
  lineHeight: number;
  metricSource: GuiTextLayout['metricSource'];
  missingGlyphs: number[];
} {
  interface StyledWord {
    text: string;
    colours: Array<string | undefined>;
  }

  const lines: string[] = [];
  const widths: number[] = [];
  const colourLines: Array<Array<string | undefined>> = [];
  const missingGlyphs = new Set<number>();
  const retainMissingGlyphs = (values: readonly number[]): void => {
    for (const value of values) {
      if (missingGlyphs.size >= GUI_TEXT_MAX_MISSING_GLYPH_SAMPLES) return;
      missingGlyphs.add(value);
    }
  };
  let lineHeight = fontSize * 1.2;
  let metricSource: GuiTextLayout['metricSource'] = 'approximation';
  const commitLine = (words: readonly StyledWord[]): void => {
    const characters: string[] = [];
    const lineColours: Array<string | undefined> = [];
    for (const [index, word] of words.entries()) {
      if (index > 0) {
        characters.push(' ');
        lineColours.push(lineColours.at(-1) ?? word.colours[0]);
      }
      characters.push(word.text);
      lineColours.push(...word.colours);
    }
    const committedText = characters.join('');
    work.spendTextLayout('committed text line measurement');
    const committed = measureTextWithInlineIcons(
      catalog,
      fontName,
      committedText,
      fontSize,
      inlineIcons,
    );
    lines.push(committedText);
    widths.push(committed.width);
    colourLines.push(lineColours);
    retainMissingGlyphs(committed.missingGlyphs);
    lineHeight = committed.lineHeight;
    metricSource = committed.source;
  };

  let paragraphStart = 0;
  for (let paragraphEnd = 0; paragraphEnd <= text.length; paragraphEnd += 1) {
    if (paragraphEnd < text.length && text[paragraphEnd] !== '\n') continue;
    work.spendTextLayout('text paragraph layout');
    const paragraph = text.slice(paragraphStart, paragraphEnd);
    const paragraphColours = colours.slice(paragraphStart, paragraphEnd);
    const words = [...paragraph.matchAll(/\S+/gu)].map((match): StyledWord => {
      const start = match.index;
      const word = match[0];
      return { text: word, colours: paragraphColours.slice(start, start + word.length) };
    });
    paragraphStart = paragraphEnd + 1;
    if (words.length === 0) {
      lines.push('');
      widths.push(0);
      colourLines.push([]);
      continue;
    }
    let currentWords: StyledWord[] = [];
    let currentWidth = 0;
    let previousWord: string | undefined;
    let previousWordWidth = 0;
    for (const word of words) {
      work.spendTextLayout('text word measurement');
      const measuredWord = measureTextWithInlineIcons(
        catalog,
        fontName,
        word.text,
        fontSize,
        inlineIcons,
      );
      retainMissingGlyphs(measuredWord.missingGlyphs);
      let candidateWidth = measuredWord.width;
      if (previousWord !== undefined) {
        work.spendTextLayout('text word-boundary measurement');
        const boundary = measureTextWithInlineIcons(
          catalog,
          fontName,
          `${previousWord} ${word.text}`,
          fontSize,
          inlineIcons,
        );
        retainMissingGlyphs(boundary.missingGlyphs);
        candidateWidth = currentWidth + boundary.width - previousWordWidth;
      }
      if (maximumWidth > 0 && candidateWidth > maximumWidth && currentWords.length > 0) {
        commitLine(currentWords);
        currentWords = [word];
        currentWidth = measuredWord.width;
      } else {
        currentWords.push(word);
        currentWidth = candidateWidth;
      }
      previousWord = word.text;
      previousWordWidth = measuredWord.width;
    }
    commitLine(currentWords);
  }
  return {
    lines,
    widths,
    colourLines,
    lineHeight,
    metricSource,
    missingGlyphs: [...missingGlyphs].sort((a, b) => a - b),
  };
}

function colourRunsForLine(
  catalog: GuiAssetCatalog,
  fontName: string | undefined,
  line: string,
  colours: readonly (string | undefined)[],
  fontSize: number,
  work: GuiSceneWorkBudget,
  inlineIcons: ReadonlyMap<string, ResolvedInlineIcon> = new Map(),
  defaultColour = defaultTextColour,
): GuiTextColourRun[] {
  if (!colours.some((colour) => colour !== undefined) || line.length === 0) return [];
  const runs: GuiTextColourRun[] = [];
  let start = 0;
  while (start < line.length) {
    const inlineIcon = inlineIcons.get(line[start] ?? '');
    if (inlineIcon !== undefined) {
      start += 1;
      continue;
    }
    const colour = colours[start] ?? defaultColour;
    let end = start + 1;
    while (
      end < line.length &&
      !inlineIcons.has(line[end] ?? '') &&
      (colours[end] ?? defaultColour) === colour
    )
      end += 1;
    const text = line.slice(start, end);
    work.spendTextLayout('localisation colour-run prefix measurement');
    const offsetX = measureTextWithInlineIcons(
      catalog,
      fontName,
      line.slice(0, start),
      fontSize,
      inlineIcons,
    ).width;
    work.spendTextLayout('localisation colour-run end measurement');
    const endX = measureTextWithInlineIcons(
      catalog,
      fontName,
      line.slice(0, end),
      fontSize,
      inlineIcons,
    ).width;
    const width = Math.max(0, endX - offsetX);
    runs.push({ text, colour, offsetX, width });
    start = end;
  }
  return runs;
}

function frameFor(
  element: GuiElementDefinition,
  sprite: GuiSourceGraph['sprites'][number],
  scenario: GuiPreviewScenario,
  rowValues?: Readonly<Record<string, string | number | boolean>>,
): number {
  const frameCount = Math.max(1, sprite.frameCount);
  const selected = scenario.selectedFrames[element.name] ?? scenario.selectedFrames[sprite.name];
  if (selected !== undefined) return Math.min(frameCount - 1, selected);
  const scriptedFrame =
    rowValues?.[`${element.name}.frame`] ??
    scenario.values[`${element.name}.frame`] ??
    scenario.scriptedGui[`${element.name}.frame`];
  if (typeof scriptedFrame === 'number' && Number.isFinite(scriptedFrame))
    return Math.min(
      frameCount - 1,
      Math.max(0, Math.trunc(scriptedFrame > 0 ? scriptedFrame - 1 : scriptedFrame)),
    );
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

function textIconSpriteCandidates(token: string): string[] {
  const normalized = token.startsWith('GFX_') ? token : `GFX_${token}`;
  return [normalized, `${normalized}_texticon`, `${normalized}_text_icon`];
}

function alignment(
  attributes: Record<string, GuiPropertyValue>,
  buttonText: boolean,
): Pick<GuiTextLayout, 'horizontalAlignment' | 'verticalAlignment'> {
  const explicitFormat = scalarString(property(attributes, 'format'))?.toLowerCase();
  const format = explicitFormat ?? '';
  const horizontalAlignment = format.includes('center')
    ? 'center'
    : format.includes('right')
      ? 'right'
      : buttonText && explicitFormat === undefined
        ? 'center'
        : 'left';
  const verticalAlignment = format.includes('bottom')
    ? 'bottom'
    : format.includes('center')
      ? 'center'
      : buttonText && explicitFormat === undefined
        ? 'center'
        : 'top';
  return { horizontalAlignment, verticalAlignment };
}

type HorizontalAnchor = 'left' | 'center' | 'right';
type VerticalAnchor = 'top' | 'center' | 'bottom';

function anchorAxes(value: string): {
  horizontal: HorizontalAnchor;
  vertical: VerticalAnchor;
} {
  const normalized = value.toLowerCase().replaceAll('-', '_');
  if (normalized === 'center_left') return { horizontal: 'left', vertical: 'center' };
  if (normalized === 'center_right') return { horizontal: 'right', vertical: 'center' };
  if (normalized === 'center_up' || normalized === 'center_upper')
    return { horizontal: 'center', vertical: 'top' };
  if (normalized === 'center_down' || normalized === 'center_lower')
    return { horizontal: 'center', vertical: 'bottom' };
  if (normalized === 'upper_right') return { horizontal: 'right', vertical: 'top' };
  if (normalized === 'lower_left') return { horizontal: 'left', vertical: 'bottom' };
  if (normalized === 'lower_right') return { horizontal: 'right', vertical: 'bottom' };
  if (normalized === 'center') return { horizontal: 'center', vertical: 'center' };
  return { horizontal: 'left', vertical: 'top' };
}

function anchoredCoordinate(
  start: number,
  span: number,
  offset: number,
  anchor: HorizontalAnchor | VerticalAnchor,
): number {
  return anchor === 'right' || anchor === 'bottom'
    ? start + span + offset
    : anchor === 'center'
      ? start + span / 2 + offset
      : start + offset;
}

interface LayoutContext {
  graph: GuiSourceGraph;
  scenario: GuiPreviewScenario;
  catalog: GuiAssetCatalog;
  fidelity: FidelityReport;
  diagnostics: Diagnostic[];
  elementsById: Map<string, GuiElementDefinition>;
  elementsByName: Map<string, GuiElementDefinition>;
  dynamicListsByName: Map<string, ScriptedGuiDynamicListDefinition>;
  constantElementEnabled: Readonly<Record<string, boolean>>;
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
  inheritedOrientation = 'upper_left',
  inheritedVisible = true,
): Promise<void> {
  context.work.admitElement(depth);
  const { scenario, catalog, fidelity, diagnostics } = context;
  const instanceId =
    instanceSuffix.length === 0 ? definition.id : `${definition.id}${instanceSuffix}`;
  const localScale = scalarNumber(property(definition.attributes, 'scale'), 1) ?? 1;
  const scale = parentScale * localScale;
  const position = objectProperty(property(definition.attributes, 'position'));
  const size = objectProperty(property(definition.attributes, 'size'));
  const scriptedX =
    rowValues?.[`${definition.name}.x`] ??
    scenario.values[`${definition.name}.x`] ??
    scenario.scriptedGui[`${definition.name}.x`];
  const scriptedY =
    rowValues?.[`${definition.name}.y`] ??
    scenario.values[`${definition.name}.y`] ??
    scenario.scriptedGui[`${definition.name}.y`];
  const localX =
    (typeof scriptedX === 'number' && Number.isFinite(scriptedX)
      ? scriptedX * parentScale
      : undefined) ??
    scaledNumber(
      position === undefined ? undefined : property(position, 'x'),
      parentRect.width,
      parentScale,
    ) ??
    0;
  const localY =
    (typeof scriptedY === 'number' && Number.isFinite(scriptedY)
      ? scriptedY * parentScale
      : undefined) ??
    scaledNumber(
      position === undefined ? undefined : property(position, 'y'),
      parentRect.height,
      parentScale,
    ) ??
    0;
  let width =
    scaledNumber(
      size === undefined ? undefined : property(size, 'width', 'x'),
      parentRect.width,
      scale,
    ) ?? 0;
  let height =
    scaledNumber(
      size === undefined ? undefined : property(size, 'height', 'y'),
      parentRect.height,
      scale,
    ) ?? 0;
  const background = objectProperty(property(definition.attributes, 'background'));
  const scriptedImage =
    rowValues?.[`${definition.name}.image`] ??
    rowValues?.[definition.name] ??
    scenario.values[`${definition.name}.image`] ??
    scenario.values[definition.name] ??
    scenario.scriptedGui[`${definition.name}.image`] ??
    scenario.scriptedGui[definition.name];
  const spriteName =
    (typeof scriptedImage === 'string' && scriptedImage.length > 0 ? scriptedImage : undefined) ??
    scalarString(property(definition.attributes, 'spriteType', 'quadTextureSprite')) ??
    scalarString(
      background === undefined
        ? undefined
        : property(background, 'spriteType', 'quadTextureSprite'),
    );
  const spriteDefinition =
    spriteName === undefined ? undefined : context.spritesByName.get(spriteName.toLowerCase());
  let sprite: GuiSceneElement['sprite'];
  let secondarySprite: GuiSceneElement['secondarySprite'];
  let spriteRenderMode: GuiSceneElement['spriteRenderMode'];
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
    const spriteType = spriteDefinition.spriteType.toLowerCase();
    spriteRenderMode =
      spriteType === 'corneredtilespritetype'
        ? 'cornered-tile'
        : spriteType === 'progressbartype'
          ? 'progressbar'
          : spriteType === 'maskedshieldtype'
            ? 'masked-shield'
            : 'stretch';
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
    const frame = frameFor(definition, spriteDefinition, scenario, rowValues);
    sprite = await catalog.loadSpriteFrame(spriteDefinition, frame);
    if (spriteDefinition.texturePath2 !== undefined)
      secondarySprite = await catalog.loadSecondarySpriteFrame(spriteDefinition, frame);
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
      if (spriteRenderMode === 'cornered-tile')
        addFidelity(
          fidelity,
          spriteDefinition.borderSize === undefined ? 'approximated' : 'modelled',
          'cornered_tile_composition',
          spriteDefinition.borderSize === undefined
            ? `${spriteDefinition.name} has no borderSize, so the full texture fills the element.`
            : `${spriteDefinition.name} uses fixed corners and edges with a ${spriteDefinition.borderSize.width}x${spriteDefinition.borderSize.height} source border${spriteDefinition.tilingCenter === true ? ' and a tiled center' : ''}.`,
          definition,
        );
      if (spriteRenderMode === 'progressbar' || spriteRenderMode === 'masked-shield') {
        const detail =
          secondarySprite?.supported === true
            ? `Primary and secondary textures for ${spriteDefinition.name} are composited.`
            : `Secondary texture for ${spriteDefinition.name} could not be rendered.`;
        addFidelity(
          fidelity,
          secondarySprite?.supported === true ? 'modelled' : 'missing',
          spriteRenderMode === 'progressbar'
            ? 'progressbar_composition'
            : 'masked_shield_composition',
          detail,
          definition,
        );
        if (secondarySprite !== undefined && !secondarySprite.supported)
          diagnostics.push(
            diagnostic(
              'GUI_SECONDARY_TEXTURE_UNSUPPORTED',
              'warning',
              secondarySprite.reason ?? detail,
              definition,
            ),
          );
      }
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
  if (typeof scriptedImage === 'string' && scriptedImage.length > 0)
    addFidelity(
      fidelity,
      'modelled',
      'scripted_gui_image',
      `Scenario property selected ${scriptedImage} for ${definition.name}.`,
      definition,
    );
  if (typeof scriptedX === 'number' || typeof scriptedY === 'number')
    addFidelity(
      fidelity,
      'modelled',
      'scripted_gui_position',
      `Scenario properties positioned ${definition.name} at ${localX},${localY} before anchoring.`,
      definition,
    );

  const rawButtonText = scalarString(property(definition.attributes, 'buttonText'));
  const rawText = scalarString(property(definition.attributes, 'text')) ?? rawButtonText;
  const embeddedButtonText =
    rawText !== undefined &&
    (rawButtonText !== undefined || definition.elementType.toLowerCase().includes('button'));
  let text: GuiTextLayout | undefined;
  if (rawText !== undefined) {
    const resolved = resolveTokenText(rawText, scenario, context.localisation, rowValues);
    let displayText = resolved.text;
    const state = scenario.elementStates[definition.name] ?? scenario.state;
    if (state === 'long-text') displayText = `${displayText} — ${displayText} — ${displayText}`;
    if (state === 'missing-localisation') displayText = `\u00a7R${rawText}_MISSING\u00a7!`;
    const fontName = scalarString(property(definition.attributes, 'font', 'buttonFont'));
    const fontDefinition = fontName === undefined ? undefined : catalog.fontDefinition(fontName);
    const visibleText = visibleHoiText(displayText, {
      ...context.graph.textColours,
      ...fontDefinition?.textColours,
    });
    displayText = visibleText.text;
    context.work.admitText(displayText, `GUI text for ${definition.name}`);
    const resolvedFontMetrics = catalog.resolvedFontMetrics(fontName);
    const explicitFontSize = scalarNumber(property(definition.attributes, 'fontSize'), 16);
    const fontSize =
      explicitFontSize ??
      resolvedFontMetrics.nativeSize ??
      context.catalog.fontDefinition(fontName ?? '')?.size ??
      16;
    const resolvedInlineIcons = new Map<string, ResolvedInlineIcon>();
    for (const inlineIcon of visibleText.inlineIcons) {
      const candidates = textIconSpriteCandidates(inlineIcon.token);
      const iconDefinition = candidates
        .map((candidate) => context.spritesByName.get(candidate.toLowerCase()))
        .find((candidate) => candidate !== undefined);
      const iconHeight = fontSize * scale;
      const iconSprite =
        iconDefinition === undefined ? undefined : await catalog.loadSpriteFrame(iconDefinition, 0);
      const iconWidth =
        iconSprite?.supported === true && iconSprite.height > 0
          ? iconHeight * (iconSprite.width / iconSprite.height)
          : iconHeight;
      const spriteName = iconDefinition?.name ?? candidates[0]!;
      resolvedInlineIcons.set(inlineIcon.marker, {
        marker: inlineIcon.marker,
        token: inlineIcon.token,
        spriteName,
        width: iconWidth,
        height: iconHeight,
        ...(iconSprite === undefined ? {} : { sprite: iconSprite }),
      });
      if (iconSprite?.supported === true)
        addFidelity(
          fidelity,
          'modelled',
          'inline_text_icon',
          `Localisation icon £${inlineIcon.token} uses ${spriteName}.`,
          definition,
        );
      else {
        addFidelity(
          fidelity,
          'missing',
          'inline_text_icon',
          iconSprite?.reason ?? `No sprite resolves localisation icon £${inlineIcon.token}.`,
          definition,
        );
        diagnostics.push(
          diagnostic(
            'GUI_TEXT_ICON_MISSING',
            'warning',
            iconSprite?.reason ?? `No sprite resolves localisation icon £${inlineIcon.token}.`,
            definition,
          ),
        );
      }
    }
    const declaredMaxWidth = scaledNumber(
      property(definition.attributes, 'maxWidth'),
      parentRect.width,
      scale,
    );
    const declaredMaxHeight = scaledNumber(
      property(definition.attributes, 'maxHeight'),
      parentRect.height,
      scale,
    );
    if (width === 0 && declaredMaxWidth !== undefined) width = declaredMaxWidth;
    if (height === 0 && declaredMaxHeight !== undefined) height = declaredMaxHeight;
    const maxWidth = declaredMaxWidth ?? width;
    const wrapped = wrapText(
      catalog,
      fontName,
      displayText,
      visibleText.colours,
      fontSize * scale,
      maxWidth,
      context.work,
      resolvedInlineIcons,
    );
    const glyphLines: GuiTextGlyphLine[] = [];
    const inlineIcons: GuiTextInlineIcon[] = [];
    for (const [lineIndex, line] of wrapped.lines.entries()) {
      const shaped = await shapeTextWithInlineIcons(
        catalog,
        fontName,
        line,
        fontSize * scale,
        lineIndex,
        resolvedInlineIcons,
      );
      glyphLines.push(shaped.glyphLine);
      inlineIcons.push(...shaped.icons);
    }
    const colourRuns = visibleText.hasColourMarkup
      ? wrapped.lines.map((line, index) =>
          colourRunsForLine(
            catalog,
            fontName,
            line,
            wrapped.colourLines[index] ?? [],
            fontSize * scale,
            context.work,
            resolvedInlineIcons,
            fontDefinition?.colour ?? defaultTextColour,
          ),
        )
      : undefined;
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
      ...alignment(definition.attributes, embeddedButtonText),
      ...(fontName === undefined ? {} : { fontName }),
      ...(fontDefinition?.colour === undefined ? {} : { colour: fontDefinition.colour }),
      ...(fontDefinition?.borderColour === undefined
        ? {}
        : { borderColour: fontDefinition.borderColour }),
      glyphLines,
      overflowX: width > 0 && measuredWidth > width + 0.01,
      overflowY: height > 0 && measuredHeight > height + 0.01,
      fixedSize: scalarBoolean(property(definition.attributes, 'fixedsize')) ?? false,
      unresolvedTokens: resolved.unresolved,
      ...(colourRuns === undefined ? {} : { colourRuns }),
      ...(inlineIcons.length === 0 ? {} : { inlineIcons }),
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
    if (fontDefinition?.colour !== undefined || fontDefinition?.borderColour !== undefined)
      addFidelity(
        fidelity,
        'modelled',
        'font_definition_style',
        `Font ${fontDefinition.name} uses its declared face and colour styling.`,
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
    scalarString(property(definition.attributes, 'orientation'))?.toLowerCase() ??
    inheritedOrientation;
  const origo =
    scalarString(property(definition.attributes, 'origo'))?.toLowerCase() ?? 'upper_left';
  const orientationAxes = anchorAxes(orientation);
  let x = anchoredCoordinate(parentRect.x, parentRect.width, localX, orientationAxes.horizontal);
  let y = anchoredCoordinate(parentRect.y, parentRect.height, localY, orientationAxes.vertical);
  const centerPosition = scalarBoolean(property(definition.attributes, 'centerposition')) ?? false;
  const origoAxes = centerPosition
    ? { horizontal: 'center' as const, vertical: 'center' as const }
    : anchorAxes(origo);
  if (origoAxes.horizontal === 'center') {
    x -= width / 2;
  } else if (origoAxes.horizontal === 'right') x -= width;
  if (origoAxes.vertical === 'center') y -= height / 2;
  else if (origoAxes.vertical === 'bottom') y -= height;
  const scrollOffset =
    (scenario.scrollOffsets[definition.name] ?? scenario.scrollOffsets[definition.id] ?? 0) * scale;
  const unclippedRect = { x, y, width: Math.max(0, width), height: Math.max(0, height) };
  const ownClipping =
    scalarBoolean(property(definition.attributes, 'clipping')) ??
    (background !== undefined && /(?:containerwindow|windowtype)/iu.test(definition.elementType));
  const availableClip =
    inheritedClip === undefined ? unclippedRect : rectIntersection(inheritedClip, unclippedRect);
  const clipRect = inheritedClip;
  const clipped =
    clipRect !== undefined &&
    (availableClip === undefined || !equalRect(unclippedRect, availableClip));
  const scriptedVisible =
    rowValues?.[`${definition.name}.visible`] ??
    scenario.values[`${definition.name}.visible`] ??
    scenario.scriptedGui[`${definition.name}.visible`];
  const explicitlyVisible =
    scenario.visibility[definition.name] ??
    scenario.visibility[definition.id] ??
    (typeof scriptedVisible === 'boolean' ? scriptedVisible : undefined);
  const visible =
    inheritedVisible &&
    (explicitlyVisible ?? (availableClip !== undefined || inheritedClip === undefined));
  const clickThrough =
    scalarBoolean(
      property(definition.attributes, 'clickThrough', 'alwaystransparent', 'allwaystransparent'),
    ) ?? false;
  const scriptedEnabled =
    rowValues?.[`${definition.name}.enabled`] ??
    scenario.values[`${definition.name}.enabled`] ??
    scenario.scriptedGui[`${definition.name}.enabled`] ??
    context.constantElementEnabled[definition.name];
  const clickable =
    clickableTypes.test(definition.elementType) && !clickThrough && scriptedEnabled !== false;
  const state: GuiPreviewState = scenario.elementStates[definition.name] ?? scenario.state;
  const zPriority = scalarNumber(property(definition.attributes, 'priority'), 0) ?? 0;
  let progressRatio: number | undefined;
  if (/progressbar/iu.test(definition.elementType)) {
    const minimum = scalarNumber(property(definition.attributes, 'minValue'), 1) ?? 0;
    const maximum = scalarNumber(property(definition.attributes, 'maxValue'), 1) ?? 100;
    const startValueToken = scalarString(property(definition.attributes, 'startValue'));
    const shortStartValueToken = startValueToken?.slice(startValueToken.lastIndexOf('.') + 1);
    const scriptedValue =
      rowValues?.[definition.name] ??
      scenario.values[definition.name] ??
      (startValueToken === undefined ? undefined : scenario.values[startValueToken]) ??
      (shortStartValueToken === undefined ? undefined : scenario.values[shortStartValueToken]) ??
      (startValueToken === undefined ? undefined : scenario.variables[startValueToken]) ??
      (shortStartValueToken === undefined ? undefined : scenario.variables[shortStartValueToken]) ??
      scenario.scriptedGui[definition.name];
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
    ...(secondarySprite === undefined ? {} : { secondarySprite }),
    ...(spriteRenderMode === undefined ? {} : { spriteRenderMode }),
    ...(spriteDefinition?.borderSize === undefined
      ? {}
      : { spriteBorderSize: spriteDefinition.borderSize }),
    ...(spriteDefinition?.tilingCenter === undefined
      ? {}
      : { spriteTilingCenter: spriteDefinition.tilingCenter }),
    ...(spriteDefinition === undefined
      ? {}
      : { progressHorizontal: spriteDefinition.horizontal ?? true }),
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
  const dynamicList = context.dynamicListsByName.get(definition.name);
  const listElement = /(?:grid|listbox|scroll)/iu.test(definition.elementType);
  const slotSize = objectProperty(property(definition.attributes, 'slotsize'));
  const slotHeight = scaledNumber(
    slotSize === undefined ? undefined : property(slotSize, 'height', 'y'),
    height,
    scale,
  );
  if (rows !== undefined && childDefinitions.length > 0 && listElement) {
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
          origo,
          visible,
        );
        const rendered = context.instancesById.get(`${child.id}${instanceSuffix}#row-${index}`);
        rowHeight = Math.max(rowHeight, rendered?.unclippedRect.height ?? 0);
      }
      rowY += (slotHeight ?? rowHeight) + spacingY * scale;
    }
    addFidelity(
      fidelity,
      'modelled',
      'scroll_rows',
      `Expanded ${rows.length} scenario rows for ${definition.name}.`,
      definition,
    );
  } else if (rows !== undefined && dynamicList !== undefined && listElement) {
    let rowY = 0;
    let renderedRows = 0;
    for (const [index, row] of rows.entries()) {
      context.work.spend('scripted GUI dynamic-list row expansion');
      const explicitTemplate = row.entryContainer;
      const templateName =
        (typeof explicitTemplate === 'string' && explicitTemplate.length > 0
          ? explicitTemplate
          : undefined) ??
        (row.countryScope === true
          ? (dynamicList.countryScopeEntryContainer ?? dynamicList.entryContainer)
          : (dynamicList.entryContainer ?? dynamicList.countryScopeEntryContainer));
      const template =
        templateName === undefined ? undefined : context.elementsByName.get(templateName);
      if (template === undefined) {
        diagnostics.push(
          diagnostic(
            'GUI_DYNAMIC_LIST_TEMPLATE_MISSING',
            'error',
            templateName === undefined
              ? `Dynamic list ${definition.name} has no entry container for scenario row ${index}.`
              : `Dynamic list ${definition.name} cannot resolve entry container ${templateName}.`,
            definition,
          ),
        );
        continue;
      }
      const templatePosition = objectProperty(property(template.attributes, 'position'));
      const originalY =
        scalarNumber(
          templatePosition === undefined ? undefined : property(templatePosition, 'y'),
          height,
        ) ?? 0;
      const shiftedParent = {
        ...childParentRect,
        y: childParentRect.y + rowY - originalY * scale,
      };
      await layoutElement(
        template,
        shiftedParent,
        childClip,
        scale,
        depth + 1,
        context,
        `${instanceSuffix}#row-${index}`,
        index,
        row,
        instanceId,
        origo,
        visible,
      );
      const rendered = context.instancesById.get(`${template.id}${instanceSuffix}#row-${index}`);
      rowY += slotHeight ?? rendered?.unclippedRect.height ?? 0;
      renderedRows += 1;
    }
    addFidelity(
      fidelity,
      renderedRows === rows.length ? 'modelled' : 'missing',
      'scripted_gui_dynamic_list',
      `Expanded ${renderedRows}/${rows.length} scenario rows for ${definition.name} through its scripted-GUI entry containers.`,
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
        origo,
        visible,
      );
    }
  }
}

/** Build a deterministic GUI scene from the connected source graph and scenario. */
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
  const relevantScriptedGuiNames = new Set(
    graph.scriptedGuis
      .filter(
        (definition) =>
          definition.windowName === windowName || definition.parentWindowName === windowName,
      )
      .map(({ name }) => name),
  );
  let addedRelatedScriptedGui = true;
  while (addedRelatedScriptedGui) {
    addedRelatedScriptedGui = false;
    for (const definition of graph.scriptedGuis) {
      if (
        definition.parentScriptedGui === undefined ||
        !relevantScriptedGuiNames.has(definition.parentScriptedGui) ||
        relevantScriptedGuiNames.has(definition.name)
      )
        continue;
      relevantScriptedGuiNames.add(definition.name);
      addedRelatedScriptedGui = true;
    }
  }
  const scriptedWindowVisibility: Record<string, boolean> = {};
  const constantElementVisibility: Record<string, boolean> = {};
  const constantElementEnabled: Record<string, boolean> = {};
  const resolvedScriptedProperties: Record<string, string | number | boolean> = {};
  const dynamicListsByName = new Map<string, ScriptedGuiDynamicListDefinition>();
  for (const scripted of graph.scriptedGuis.filter(({ name }) =>
    relevantScriptedGuiNames.has(name),
  )) {
    for (const dynamicList of scripted.dynamicListDefinitions)
      dynamicListsByName.set(dynamicList.name, dynamicList);
    for (const propertyDefinition of scripted.propertyDefinitions) {
      for (const [attribute, expression] of Object.entries(propertyDefinition.attributes)) {
        const suffix = attribute.toLowerCase();
        if (!['image', 'frame', 'x', 'y', 'visible', 'enabled'].includes(suffix)) continue;
        const resolved = scenarioExpressionValue(expression, scenario.values);
        if (resolved === undefined) continue;
        const key = `${propertyDefinition.elementName}.${suffix}`;
        if (scenario.values[key] === undefined) resolvedScriptedProperties[key] = resolved;
        addFidelity(
          fidelity,
          'modelled',
          'scripted_gui_scenario_property',
          `${key} resolved from a scenario runtime value.`,
        );
      }
    }
    for (const trigger of scripted.triggerDefinitions) {
      if (trigger.constantResult === undefined) continue;
      if (trigger.name.endsWith('_visible'))
        constantElementVisibility[trigger.elementName] = trigger.constantResult;
      if (trigger.name.endsWith('_click_enabled'))
        constantElementEnabled[trigger.elementName] = trigger.constantResult;
      addFidelity(
        fidelity,
        'modelled',
        'scripted_gui_constant_trigger',
        `${trigger.name} resolves to ${trigger.constantResult ? 'yes' : 'no'}.`,
      );
    }
    addFidelity(
      fidelity,
      'modelled',
      'scripted_gui_context',
      `${scripted.name} uses ${scripted.contextType ?? '<unspecified>'} context.`,
    );
    if (scripted.visibleExpression === undefined) continue;
    const mockedVisibility =
      scenario.visibility[scripted.name] ??
      scenario.values[`${scripted.name}.visible`] ??
      scenario.scriptedGui[`${scripted.name}.visible`];
    if (typeof mockedVisibility === 'boolean') {
      if (scripted.windowName !== undefined)
        scriptedWindowVisibility[scripted.windowName] =
          (scriptedWindowVisibility[scripted.windowName] ?? true) && mockedVisibility;
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
  const layoutScenario = {
    ...scenario,
    values: {
      ...resolvedScriptedProperties,
      ...scenario.values,
    },
    visibility: {
      ...scriptedWindowVisibility,
      ...constantElementVisibility,
      ...scenario.visibility,
    },
  };
  const output: GuiSceneElement[] = [];
  const elementsByName = new Map<string, GuiElementDefinition>();
  for (const element of [...graph.elements].sort(
    (left, right) =>
      compareCodeUnits(right.sourcePath, left.sourcePath) ||
      right.definitionOrder - left.definitionOrder,
  ))
    if (!elementsByName.has(element.name)) elementsByName.set(element.name, element);
  const context: LayoutContext = {
    graph,
    scenario: layoutScenario,
    catalog,
    fidelity,
    diagnostics,
    elementsById,
    elementsByName,
    dynamicListsByName,
    constantElementEnabled,
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
  const scriptedByName = new Map(graph.scriptedGuis.map((scripted) => [scripted.name, scripted]));
  const pendingAttached = graph.scriptedGuis
    .filter(
      ({ name, parentScriptedGui, windowName: scriptedWindowName }) =>
        relevantScriptedGuiNames.has(name) &&
        parentScriptedGui !== undefined &&
        scriptedWindowName !== undefined &&
        scriptedWindowName !== windowName,
    )
    .sort((left, right) => compareCodeUnits(left.name, right.name));
  let attachmentProgress = true;
  while (pendingAttached.length > 0 && attachmentProgress) {
    attachmentProgress = false;
    for (let index = pendingAttached.length - 1; index >= 0; index -= 1) {
      const scripted = pendingAttached[index]!;
      const parentScripted =
        scripted.parentScriptedGui === undefined
          ? undefined
          : scriptedByName.get(scripted.parentScriptedGui);
      const parentWindowName = parentScripted?.windowName;
      const parentDefinition =
        parentWindowName === undefined ? undefined : elementsByName.get(parentWindowName);
      const parentScene =
        parentDefinition === undefined ? undefined : context.instancesById.get(parentDefinition.id);
      const attachedDefinition =
        scripted.windowName === undefined ? undefined : elementsByName.get(scripted.windowName);
      if (parentScene === undefined || attachedDefinition === undefined) continue;
      if (!context.instancesById.has(attachedDefinition.id)) {
        await layoutElement(
          attachedDefinition,
          parentScene.unclippedRect,
          parentScene.unclippedRect,
          parentScene.scale,
          parentScene.depth + 1,
          context,
          '',
          undefined,
          undefined,
          parentScene.id,
          'upper_left',
          parentScene.visible,
        );
        addFidelity(
          fidelity,
          'modelled',
          'parent_scripted_gui_attachment',
          `${scripted.windowName} is attached to ${parentWindowName} through ${scripted.parentScriptedGui}.`,
          attachedDefinition,
        );
      }
      pendingAttached.splice(index, 1);
      attachmentProgress = true;
    }
  }
  for (const scripted of pendingAttached) {
    diagnostics.push({
      code: 'GUI_PARENT_SCRIPTED_WINDOW_UNRESOLVED',
      severity: 'error',
      category: 'reference',
      message: `Could not attach ${scripted.windowName ?? '<missing window>'} through parent scripted GUI ${scripted.parentScriptedGui ?? '<missing parent>'}.`,
      ...(scripted.location === undefined ? {} : { location: scripted.location }),
    });
  }
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
