import { sha256Bytes } from '../core/canonical.js';
import { parsePreviewScenario } from './scenario.js';
import type {
  GuiElementDefinition,
  GuiGeneratedScenarioOptions,
  GuiPreviewScenario,
  GuiPreviewState,
  GuiPropertyValue,
  GuiSourceGraph,
} from './types.js';

const countryNames = ['Germany', 'France', 'Poland', 'Italy', 'Brazil', 'India', 'Canada'];
const countryAdjectives = [
  'German',
  'French',
  'Polish',
  'Italian',
  'Brazilian',
  'Indian',
  'Canadian',
];
const leaderNames = ['Anna Keller', 'Michael Byrne', 'Elena Rossi', 'Jan Kowalski', 'Rafael Silva'];
const variedStates: readonly GuiPreviewState[] = [
  'normal',
  'selected',
  'active',
  'warning',
  'disabled',
  'completed',
];

class ScenarioRandom {
  #state: number;

  public constructor(seed: string) {
    this.#state = Number.parseInt(sha256Bytes(seed).slice(0, 8), 16) || 0x6d2b_79f5;
  }

  public next(): number {
    this.#state = (this.#state + 0x6d2b_79f5) >>> 0;
    let value = this.#state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  public boolean(probability: number): boolean {
    return this.next() < probability;
  }

  public integer(minimum: number, maximum: number): number {
    return Math.floor(this.next() * (maximum - minimum + 1)) + minimum;
  }

  public pick<T>(values: readonly T[]): T {
    return values[Math.min(values.length - 1, Math.floor(this.next() * values.length))]!;
  }
}

function relevantElements(graph: GuiSourceGraph, windowName: string): GuiElementDefinition[] {
  const root = graph.elements.find(
    (element) => element.parentId === undefined && element.name === windowName,
  );
  if (root === undefined) return graph.elements.filter(({ name }) => name === windowName);
  const byId = new Map(graph.elements.map((element) => [element.id, element]));
  const pending = [root.id];
  const selected: GuiElementDefinition[] = [];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const element = byId.get(id);
    if (element === undefined) continue;
    selected.push(element);
    pending.push(...element.childIds);
  }
  return selected;
}

function stringsIn(value: GuiPropertyValue): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object') return [];
  return Object.values(value).flatMap(stringsIn);
}

function localisationText(
  graph: GuiSourceGraph,
  language: string,
  key: string,
): string | undefined {
  return graph.localisation.find((entry) => entry.language === language && entry.key === key)
    ?.value;
}

function sourceTexts(
  graph: GuiSourceGraph,
  elements: readonly GuiElementDefinition[],
  language: string,
  scripted: readonly GuiSourceGraph['scriptedGuis'][number][],
): string[] {
  const values = elements.flatMap((element) =>
    Object.values(element.attributes).flatMap(stringsIn),
  );
  const propertyValues = scripted.flatMap((definition) =>
    definition.propertyDefinitions.flatMap((property) =>
      Object.values(property.attributes).flatMap(stringsIn),
    ),
  );
  return [...values, ...propertyValues].flatMap((value) => [
    value,
    localisationText(graph, language, value) ?? '',
  ]);
}

function dynamicTokens(texts: readonly string[]): {
  numeric: string[];
  textual: string[];
} {
  const numeric = new Set<string>();
  const textual = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/\[\?([^\]|]+)(?:\|[^\]]+)?\]/gu)) {
      const key = match[1] ?? '';
      if (/(?:^|\.)Get[A-Za-z0-9_]+$/u.test(key)) textual.add(key);
      else numeric.add(key);
    }
    for (const match of text.matchAll(/\[([A-Za-z][A-Za-z0-9_.:-]+)\]/gu)) {
      const key = match[1] ?? '';
      if (key !== 'X' && key !== 'dynamic_loc') textual.add(key);
    }
  }
  return {
    numeric: [...numeric].sort(),
    textual: [...textual].sort(),
  };
}

function plausibleText(key: string, random: ScenarioRandom, samples: readonly string[]): string {
  const lower = key.toLocaleLowerCase('en-US');
  if (lower.includes('adjective')) return random.pick(countryAdjectives);
  if (lower.includes('leader') || lower.includes('character')) return random.pick(leaderNames);
  if (lower.includes('country') || lower.endsWith('getname') || lower.includes('.getname'))
    return random.pick(countryNames);
  return random.pick(samples);
}

function generatedNumber(options: GuiGeneratedScenarioOptions, random: ScenarioRandom): number {
  const value =
    options.numericMinimum + random.next() * (options.numericMaximum - options.numericMinimum);
  return options.integerValues ? Math.round(value) : Math.round(value * 100) / 100;
}

function setIfMissing(
  target: Record<string, string | number | boolean>,
  key: string,
  value: string | number | boolean,
): void {
  target[key] ??= value;
  const shortKey = key.slice(key.lastIndexOf('.') + 1);
  target[shortKey] ??= value;
}

function generatedRows(
  count: number,
  random: ScenarioRandom,
  options: GuiGeneratedScenarioOptions,
): Record<string, string | number | boolean>[] {
  return Array.from({ length: count }, (_unused, index) => {
    const name = plausibleText('GetName', random, options.textSamples);
    const value = generatedNumber(options, random);
    return {
      index: index + 1,
      id: index + 1,
      label: name,
      name,
      GetName: name,
      value,
      amount: value,
      percentage: Math.max(0, Math.min(100, value)),
      selected: index === 0,
      enabled: random.boolean(options.trueProbability),
    };
  });
}

export function generateGuiPreviewScenarios(
  graph: GuiSourceGraph,
  windowName: string,
  base: GuiPreviewScenario,
  options: GuiGeneratedScenarioOptions,
): GuiPreviewScenario[] {
  if (!options.enabled) return [];
  const elements = relevantElements(graph, windowName);
  const scripted = graph.scriptedGuis.filter(
    (definition) =>
      definition.windowName === windowName || definition.parentWindowName === windowName,
  );
  const tokens = dynamicTokens(sourceTexts(graph, elements, base.language, scripted));
  const dynamicLists = [...new Set(scripted.flatMap(({ dynamicLists }) => dynamicLists))].sort();
  const visibilityTargets = new Set(
    scripted.flatMap((definition) =>
      definition.propertyDefinitions
        .filter((property) =>
          Object.keys(property.attributes).some(
            (key) => key.toLocaleLowerCase('en-US') === 'visible',
          ),
        )
        .map(({ elementName }) => elementName),
    ),
  );
  const enabledTargets = new Set(
    scripted.flatMap((definition) => [
      ...definition.triggerDefinitions.map(({ elementName }) => elementName),
      ...definition.propertyDefinitions
        .filter((property) =>
          Object.keys(property.attributes).some(
            (key) => key.toLocaleLowerCase('en-US') === 'enabled',
          ),
        )
        .map(({ elementName }) => elementName),
    ]),
  );
  const spritesByName = new Map(
    graph.sprites.map((sprite) => [sprite.name.toLocaleLowerCase('en-US'), sprite]),
  );
  const sourceSeed =
    options.seed === 'auto' ? `${windowName}:${base.id}:${hashSourceGraph(graph)}` : options.seed;
  return Array.from({ length: options.count }, (_unused, scenarioIndex) => {
    const random = new ScenarioRandom(`${sourceSeed}:${scenarioIndex}`);
    const values = { ...base.values };
    const lists = Object.fromEntries(
      Object.entries(base.lists).map(([key, rows]) => [key, rows.map((row) => ({ ...row }))]),
    );
    const visibility = { ...base.visibility };
    const elementStates = { ...base.elementStates };
    const selectedFrames = { ...base.selectedFrames };
    for (const key of tokens.numeric) setIfMissing(values, key, generatedNumber(options, random));
    for (const key of tokens.textual)
      setIfMissing(values, key, plausibleText(key, random, options.textSamples));
    for (const element of elements) {
      if (values[element.name] === undefined && /progressbar/iu.test(element.elementType))
        values[element.name] = generatedNumber(options, random);
      if (visibilityTargets.has(element.name) && visibility[element.name] === undefined)
        visibility[element.name] =
          options.visibility === 'show-all' || random.boolean(options.trueProbability);
      elementStates[element.name] ??= enabledTargets.has(element.name)
        ? random.boolean(options.trueProbability)
          ? options.elementStates === 'normal'
            ? 'normal'
            : random.pick(variedStates)
          : 'disabled'
        : options.elementStates === 'normal'
          ? 'normal'
          : random.pick(variedStates);
      const spriteName = [
        element.attributes.spriteType,
        element.attributes.quadTextureSprite,
        element.attributes.background,
      ].find((candidate): candidate is string => typeof candidate === 'string');
      const frameCount =
        spriteName === undefined
          ? 1
          : (spritesByName.get(spriteName.toLocaleLowerCase('en-US'))?.frameCount ?? 1);
      if (
        Number.isFinite(frameCount) &&
        frameCount > 1 &&
        selectedFrames[element.name] === undefined
      )
        selectedFrames[element.name] = random.integer(0, Math.trunc(frameCount) - 1);
    }
    for (const listName of dynamicLists) {
      if (lists[listName] !== undefined) continue;
      const count = random.integer(options.listRowsMinimum, options.listRowsMaximum);
      lists[listName] = generatedRows(count, random, options);
    }
    return parsePreviewScenario({
      ...base,
      id: `${base.id}-${options.idPrefix}-${scenarioIndex + 1}`,
      description: `Generated plausible scenario ${scenarioIndex + 1} (seed ${sourceSeed})`,
      values,
      lists,
      visibility,
      elementStates,
      selectedFrames,
    });
  });
}

function hashSourceGraph(graph: GuiSourceGraph): string {
  return sha256Bytes(
    Object.entries(graph.sourceHashes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, hash]) => `${path}:${hash}`)
      .join('\n'),
  );
}
