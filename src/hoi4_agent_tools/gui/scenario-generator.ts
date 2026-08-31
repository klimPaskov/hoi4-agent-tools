import { sha256Bytes } from '../core/canonical.js';
import { parsePreviewScenario } from './scenario.js';
import type {
  GuiElementDefinition,
  GuiGeneratedScenarioOptions,
  GuiPreviewScenario,
  GuiPreviewState,
  GuiPropertyValue,
  GuiSourceGraph,
  ScriptedGuiDefinition,
} from './types.js';

const countryNames = ['Germany', 'France', 'Poland', 'Italy', 'Brazil', 'India', 'Canada'];
const countryTags = ['GER', 'FRA', 'POL', 'ITA', 'BRA', 'RAJ', 'CAN'];
const countryIdeologies = [
  'fascism',
  'democratic',
  'democratic',
  'fascism',
  'democratic',
  'neutrality',
  'democratic',
];
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
const monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const variedStates: readonly GuiPreviewState[] = [
  'normal',
  'selected',
  'active',
  'warning',
  'disabled',
  'completed',
];
const transientWindowPattern =
  /(?:confirm|details|dialog|dropdown|menu|modal|overlay|popup|tooltip)/iu;

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

  public ordinary(): number {
    return (this.next() + this.next() + this.next()) / 3;
  }

  public pick<T>(values: readonly T[]): T {
    return values[Math.min(values.length - 1, Math.floor(this.next() * values.length))]!;
  }
}

function relatedScriptedGuis(graph: GuiSourceGraph, windowName: string): ScriptedGuiDefinition[] {
  const names = new Set(
    graph.scriptedGuis
      .filter(
        (definition) =>
          definition.windowName === windowName || definition.parentWindowName === windowName,
      )
      .map(({ name }) => name),
  );
  let added = true;
  while (added) {
    added = false;
    for (const definition of graph.scriptedGuis) {
      if (
        definition.parentScriptedGui === undefined ||
        !names.has(definition.parentScriptedGui) ||
        names.has(definition.name)
      )
        continue;
      names.add(definition.name);
      added = true;
    }
  }
  return graph.scriptedGuis.filter(({ name }) => names.has(name));
}

function relevantElements(
  graph: GuiSourceGraph,
  windowName: string,
  scripted: readonly ScriptedGuiDefinition[],
): GuiElementDefinition[] {
  const rootNames = new Set([windowName]);
  for (const definition of scripted) {
    if (definition.windowName !== undefined) rootNames.add(definition.windowName);
    for (const dynamicList of definition.dynamicListDefinitions) {
      if (dynamicList.entryContainer !== undefined) rootNames.add(dynamicList.entryContainer);
      if (dynamicList.countryScopeEntryContainer !== undefined)
        rootNames.add(dynamicList.countryScopeEntryContainer);
    }
  }
  const byId = new Map(graph.elements.map((element) => [element.id, element]));
  const pending = graph.elements.filter(({ name }) => rootNames.has(name)).map(({ id }) => id);
  const selected = new Map<string, GuiElementDefinition>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || selected.has(id)) continue;
    const element = byId.get(id);
    if (element === undefined) continue;
    selected.set(id, element);
    pending.push(...element.childIds);
  }
  return [...selected.values()];
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
  const normalizedLanguage = language.toLocaleLowerCase('en-US');
  return graph.localisation.find(
    (entry) =>
      entry.key === key && entry.language.toLocaleLowerCase('en-US') === normalizedLanguage,
  )?.value;
}

function sourceTexts(
  graph: GuiSourceGraph,
  elements: readonly GuiElementDefinition[],
  language: string,
  scripted: readonly ScriptedGuiDefinition[],
): string[] {
  const values = elements.flatMap((element) =>
    Object.values(element.attributes).flatMap(stringsIn),
  );
  const resolvedValues = values.flatMap((value) => [
    value,
    localisationText(graph, language, value) ?? '',
  ]);
  const relatedScriptedLocalisationKeys = new Set(
    graph.scriptedLocalisation
      .filter((definition) =>
        resolvedValues.some((value) => value.includes(`[${definition.name}]`)),
      )
      .flatMap(({ localisationKeys }) => localisationKeys),
  );
  const propertyValues = scripted.flatMap(({ propertyDefinitions }) =>
    propertyDefinitions.flatMap(({ attributes }) => Object.values(attributes).flatMap(stringsIn)),
  );
  const normalizedLanguage = language.toLocaleLowerCase('en-US');
  return [
    ...resolvedValues,
    ...propertyValues,
    ...graph.localisation
      .filter(
        ({ language: entryLanguage, key }) =>
          entryLanguage.toLocaleLowerCase('en-US') === normalizedLanguage &&
          relatedScriptedLocalisationKeys.has(key),
      )
      .map(({ value }) => value),
  ];
}

function expressionToken(value: GuiPropertyValue): string | undefined {
  if (typeof value !== 'string') return undefined;
  const variable = /^\[\?([^\]|]+)(?:\|[^\]]+)?\]$/u.exec(value);
  const dynamic = /^\[([^\]]+)\]$/u.exec(value);
  return variable?.[1] ?? dynamic?.[1];
}

function tokensIn(texts: readonly string[]): { numeric: Set<string>; textual: Set<string> } {
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
  return { numeric, textual };
}

function plausibleText(
  key: string,
  random: ScenarioRandom,
  samples: readonly string[],
  scopedCountries: Map<string, string>,
): string {
  const lower = key.toLocaleLowerCase('en-US');
  if (lower.includes('date'))
    return `${random.integer(1, 28)} ${random.pick(monthNames)} ${random.integer(1936, 1950)}`;
  if (lower.includes('adjective')) return random.pick(countryAdjectives);
  if (lower.includes('leader') || lower.includes('character')) return random.pick(leaderNames);
  if (lower.includes('country') || lower.endsWith('getname') || lower.includes('.getname')) {
    const scope = key.includes('.') ? key.slice(0, key.indexOf('.')) : 'ROOT';
    const existing = scopedCountries.get(scope);
    if (existing !== undefined) return existing;
    const used = new Set(scopedCountries.values());
    const choices = countryNames.filter((candidate) => !used.has(candidate));
    const value = random.pick(choices.length === 0 ? countryNames : choices);
    scopedCountries.set(scope, value);
    return value;
  }
  return random.pick(samples);
}

function generatedNumber(
  options: GuiGeneratedScenarioOptions,
  random: ScenarioRandom,
  minimum = options.numericMinimum,
  maximum = options.numericMaximum,
): number {
  const boundedMinimum = Math.max(options.numericMinimum, minimum);
  const boundedMaximum = Math.min(options.numericMaximum, maximum);
  const [low, high] =
    boundedMinimum <= boundedMaximum
      ? [boundedMinimum, boundedMaximum]
      : maximum < options.numericMinimum
        ? [maximum, maximum]
        : [minimum, minimum];
  const value = low + random.ordinary() * (high - low);
  return options.integerValues ? Math.round(value) : Math.round(value * 100) / 100;
}

interface NumericRange {
  minimum?: number;
  maximum?: number;
}

interface NumericRelationship {
  value: string;
  limit: string;
}

function sourceNumericConstraints(texts: readonly string[]): {
  ranges: Map<string, NumericRange>;
  relationships: NumericRelationship[];
} {
  const ranges = new Map<string, NumericRange>();
  const relationships: NumericRelationship[] = [];
  const update = (key: string, range: NumericRange): void => {
    const current = ranges.get(key) ?? {};
    const minimum =
      range.minimum === undefined
        ? current.minimum
        : current.minimum === undefined
          ? range.minimum
          : Math.max(current.minimum, range.minimum);
    const maximum =
      range.maximum === undefined
        ? current.maximum
        : current.maximum === undefined
          ? range.maximum
          : Math.min(current.maximum, range.maximum);
    ranges.set(key, {
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
    });
  };
  const token = String.raw`\[\?([^\]|]+)(?:\|[^\]]+)?\]`;
  for (const text of texts) {
    for (const match of text.matchAll(
      new RegExp(`${token}\\s*(?:/|of)\\s*(-?(?:\\d+\\.?\\d*|\\.\\d+))`, 'giu'),
    )) {
      const key = match[1];
      const maximum = Number(match[2]);
      if (key !== undefined && Number.isFinite(maximum)) update(key, { maximum });
    }
    for (const match of text.matchAll(
      new RegExp(`(-?(?:\\d+\\.?\\d*|\\.\\d+))\\s*(?:-|to)\\s*${token}`, 'giu'),
    )) {
      const minimum = Number(match[1]);
      const key = match[2];
      if (key !== undefined && Number.isFinite(minimum)) update(key, { minimum });
    }
    for (const match of text.matchAll(new RegExp(`${token}\\s*(?:/|of)\\s*${token}`, 'giu'))) {
      const value = match[1];
      const limit = match[2];
      if (value !== undefined && limit !== undefined) relationships.push({ value, limit });
    }
  }
  return { ranges, relationships };
}

function generatedNumberForKey(
  key: string,
  options: GuiGeneratedScenarioOptions,
  random: ScenarioRandom,
  inferred: NumericRange = {},
): number {
  const lower = key.toLocaleLowerCase('en-US');
  if (/(?:ratio|fraction|progress)$/u.test(lower))
    return generatedNumber(options, random, inferred.minimum ?? 0, inferred.maximum ?? 1);
  if (/(?:percent|percentage|support|stability|war_support|legitimacy|threat|charge)/u.test(lower))
    return generatedNumber(options, random, inferred.minimum ?? 0, inferred.maximum ?? 100);
  return generatedNumber(
    options,
    random,
    inferred.minimum ?? options.numericMinimum,
    inferred.maximum ?? options.numericMaximum,
  );
}

function setIfMissing(
  target: Record<string, string | number | boolean>,
  key: string,
  value: string | number | boolean,
): void {
  target[key] ??= value;
}

function scriptedLocalisationValue(
  graph: GuiSourceGraph,
  token: string,
  language: string,
  random: ScenarioRandom,
  kind: 'image' | 'text',
  values: Readonly<Record<string, string | number | boolean>>,
): string | undefined {
  const shortToken = token.slice(token.lastIndexOf('.') + 1);
  const definitions = graph.scriptedLocalisation.filter(
    ({ name }) => name === token || name === shortToken,
  );
  if (definitions.length === 0) return undefined;
  const sprites = new Set(graph.sprites.map(({ name }) => name.toLocaleLowerCase('en-US')));
  const choices = definitions.flatMap(({ choices }) => choices);
  const eligible = choices.filter(({ localisationKey }) =>
    kind === 'image'
      ? sprites.has(localisationKey.toLocaleLowerCase('en-US'))
      : localisationText(graph, language, localisationKey) !== undefined,
  );
  if (eligible.length === 0) return undefined;
  const evaluated = eligible.map((choice) => ({
    choice,
    result: evaluateSimpleTrigger(choice.triggerExpression, values),
  }));
  const matched = evaluated.find(({ result }) => result === true)?.choice;
  const firstThreshold = evaluated
    .map(({ choice }) => simpleThreshold(choice.triggerExpression))
    .find((threshold) => threshold !== undefined && typeof values[threshold.variable] === 'number');
  const unknownExists = evaluated.some(({ result }) => result === undefined);
  const ranked =
    matched === undefined && unknownExists && firstThreshold !== undefined
      ? eligible[
          Math.min(
            eligible.length - 1,
            Math.max(
              0,
              Math.round(
                (1 - Math.max(0, Math.min(100, Number(values[firstThreshold.variable]))) / 100) *
                  (eligible.length - 1),
              ),
            ),
          )
        ]
      : undefined;
  const fallback = evaluated.find(({ result }) => result === 'fallback')?.choice;
  const selected = matched ?? ranked ?? fallback ?? random.pick(eligible);
  if (kind === 'image') return selected.localisationKey;
  return localisationText(graph, language, selected.localisationKey);
}

function simpleThreshold(
  triggerExpression: string | undefined,
): { variable: string; operator: '>' | '<'; threshold: number } | undefined {
  if (triggerExpression === undefined) return undefined;
  const direct = /([A-Za-z_][A-Za-z0-9_.:^]*)\s*([<>])\s*(-?(?:\d+\.?\d*|\.\d+))/u.exec(
    triggerExpression,
  );
  if (direct !== null)
    return {
      variable: direct[1]!,
      operator: direct[2] as '>' | '<',
      threshold: Number(direct[3]),
    };
  const variable = /\bvar\s*=\s*([A-Za-z_][A-Za-z0-9_.:^]*)/u.exec(triggerExpression)?.[1];
  const threshold = /\bvalue\s*=\s*(-?(?:\d+\.?\d*|\.\d+))/u.exec(triggerExpression)?.[1];
  const compare = /\bcompare\s*=\s*(greater_than|less_than)/u.exec(triggerExpression)?.[1];
  if (variable === undefined || threshold === undefined || compare === undefined) return undefined;
  return {
    variable,
    operator: compare === 'greater_than' ? '>' : '<',
    threshold: Number(threshold),
  };
}

function evaluateSimpleTrigger(
  triggerExpression: string | undefined,
  values: Readonly<Record<string, string | number | boolean>>,
): boolean | 'fallback' | undefined {
  if (triggerExpression === undefined || /\balways\s*=\s*yes\b/u.test(triggerExpression))
    return 'fallback';
  if (/\balways\s*=\s*no\b/u.test(triggerExpression)) return false;
  const threshold = simpleThreshold(triggerExpression);
  if (threshold === undefined) return undefined;
  const value = values[threshold.variable];
  if (typeof value !== 'number') return undefined;
  return threshold.operator === '>' ? value > threshold.threshold : value < threshold.threshold;
}

function materializeDynamicText(
  template: string,
  values: Readonly<Record<string, string | number | boolean>>,
): string {
  const valueFor = (key: string): string | undefined => {
    const value = values[key] ?? values[key.slice(key.lastIndexOf('.') + 1)];
    return value === undefined ? undefined : String(value);
  };
  return template
    .replace(/\[\?([^\]|]+)(?:\|[^\]]+)?\]/gu, (match, key: string) => valueFor(key) ?? match)
    .replace(/\[([A-Za-z][A-Za-z0-9_.:-]+)\]/gu, (match, key: string) => {
      if (key === 'X' || key === 'dynamic_loc') return match;
      return valueFor(key) ?? match;
    });
}

function scalarNumber(value: GuiPropertyValue | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !/^-?(?:\d+\.?\d*|\.\d+)$/u.test(value)) return undefined;
  return Number(value);
}

function pointOrSize(
  element: GuiElementDefinition,
  attribute: 'position' | 'size',
): { x: number; y: number } | undefined {
  const value = element.attributes[attribute];
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const x = scalarNumber(value.x ?? value.width);
  const y = scalarNumber(value.y ?? value.height);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function rootRect(
  graph: GuiSourceGraph,
  windowName: string | undefined,
): { x: number; y: number; width: number; height: number } | undefined {
  if (windowName === undefined) return undefined;
  const root = graph.elements.find(
    (element) => element.name === windowName && element.parentId === undefined,
  );
  if (root === undefined) return undefined;
  const position = pointOrSize(root, 'position') ?? { x: 0, y: 0 };
  const size = pointOrSize(root, 'size');
  if (size === undefined || size.x <= 0 || size.y <= 0) return undefined;
  return { x: position.x, y: position.y, width: size.x, height: size.y };
}

function substantiallyOverlaps(
  left: ReturnType<typeof rootRect>,
  right: ReturnType<typeof rootRect>,
): boolean {
  if (left === undefined || right === undefined) return false;
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  const smallerArea = Math.min(left.width * left.height, right.width * right.height);
  return smallerArea > 0 && (width * height) / smallerArea >= 0.5;
}

function generatedVisibility(
  graph: GuiSourceGraph,
  scripted: readonly ScriptedGuiDefinition[],
  options: GuiGeneratedScenarioOptions,
  random: ScenarioRandom,
  base: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  const visibility = { ...base };
  const dynamic = scripted.filter(({ visibleExpression }) => visibleExpression !== undefined);
  if (options.visibility === 'show-all') {
    for (const definition of dynamic) visibility[definition.name] ??= true;
    return visibility;
  }
  for (const definition of dynamic) {
    if (visibility[definition.name] !== undefined) continue;
    visibility[definition.name] =
      definition.parentScriptedGui === undefined ||
      !transientWindowPattern.test(`${definition.name} ${definition.windowName ?? ''}`);
  }
  const siblingGroups = new Map<string, ScriptedGuiDefinition[]>();
  for (const definition of dynamic) {
    if (definition.parentScriptedGui === undefined) continue;
    const siblings = siblingGroups.get(definition.parentScriptedGui) ?? [];
    siblings.push(definition);
    siblingGroups.set(definition.parentScriptedGui, siblings);
  }
  for (const siblings of siblingGroups.values()) {
    const unvisited = new Set(siblings);
    while (unvisited.size > 0) {
      const first = unvisited.values().next().value;
      if (first === undefined) break;
      unvisited.delete(first);
      const component = [first];
      for (const current of component) {
        for (const candidate of [...unvisited]) {
          if (
            substantiallyOverlaps(
              rootRect(graph, current.windowName),
              rootRect(graph, candidate.windowName),
            )
          ) {
            component.push(candidate);
            unvisited.delete(candidate);
          }
        }
      }
      if (component.length < 2) continue;
      const selectable = component.filter(
        (definition) =>
          !transientWindowPattern.test(`${definition.name} ${definition.windowName ?? ''}`),
      );
      const selected = random.pick(selectable.length === 0 ? component : selectable);
      for (const definition of component) {
        if (base[definition.name] === undefined)
          visibility[definition.name] = definition === selected;
      }
    }
  }
  const visiblePageNames = dynamic
    .filter(({ name }) => visibility[name] === true)
    .flatMap(({ name, windowName: visibleWindowName }) => [name, visibleWindowName ?? ''])
    .map((name) => name.toLocaleLowerCase('en-US'));
  const triggerVisibilityTargets = [
    ...new Set(
      scripted.flatMap(({ triggerDefinitions }) =>
        triggerDefinitions
          .filter(({ name }) => name.endsWith('_visible'))
          .map(({ elementName }) => elementName),
      ),
    ),
  ];
  const triggerGroups = new Map<string, string[]>();
  for (const target of triggerVisibilityTargets) {
    const key = target.replace(
      /_(?:active|disabled|enabled|idle|off|on|selected|unselected)$/iu,
      '',
    );
    const group = triggerGroups.get(key) ?? [];
    group.push(target);
    triggerGroups.set(key, group);
  }
  for (const [baseName, targets] of triggerGroups) {
    if (targets.length === 1) {
      visibility[targets[0]!] ??= !transientWindowPattern.test(targets[0]!);
      continue;
    }
    const topic = baseName.replace(/_(?:tab_)?button$/iu, '').toLocaleLowerCase('en-US');
    const pageSelected = visiblePageNames.some((name) => name.includes(topic));
    const preferredSuffix = pageSelected
      ? /_(?:active|on|selected)$/iu
      : /_(?:idle|off|unselected)$/iu;
    const preferred =
      targets.find((target) => preferredSuffix.test(target)) ?? random.pick(targets);
    for (const target of targets)
      if (base[target] === undefined) visibility[target] = target === preferred;
  }
  return visibility;
}

function generatedRows(
  count: number,
  random: ScenarioRandom,
  options: GuiGeneratedScenarioOptions,
): Record<string, string | number | boolean>[] {
  const countryOffset = random.integer(0, countryNames.length - 1);
  return Array.from({ length: count }, (_unused, index) => {
    const countryIndex = (countryOffset + index) % countryNames.length;
    const name = countryNames[countryIndex]!;
    const tag = countryTags[countryIndex]!;
    const ideology = countryIdeologies[countryIndex]!;
    const value = generatedNumber(options, random);
    return {
      index: index + 1,
      id: index + 1,
      label: name,
      name,
      GetName: name,
      GetAdjective: countryAdjectives[countryIndex]!,
      GetTag: tag,
      tag,
      countryTag: tag,
      ideology,
      countryIdeology: ideology,
      countryScope: true,
      value,
      amount: value,
      percentage: Math.max(0, Math.min(100, value)),
      selected: index === 0,
      enabled: true,
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
  const scripted = relatedScriptedGuis(graph, windowName);
  const elements = relevantElements(graph, windowName, scripted);
  const relevantSourceTexts = sourceTexts(graph, elements, base.language, scripted);
  const tokens = tokensIn(relevantSourceTexts);
  const numericConstraints = sourceNumericConstraints(relevantSourceTexts);
  const imageTokens = new Set<string>();
  const booleanTokens = new Set<string>();
  const frameTokens = new Set<string>();
  for (const definition of scripted) {
    for (const property of definition.propertyDefinitions) {
      for (const [attribute, expression] of Object.entries(property.attributes)) {
        const token = expressionToken(expression);
        if (token === undefined) continue;
        const normalized = attribute.toLocaleLowerCase('en-US');
        if (normalized === 'image') imageTokens.add(token);
        else if (normalized === 'visible' || normalized === 'enabled') booleanTokens.add(token);
        else if (normalized === 'frame') frameTokens.add(token);
        else tokensIn(stringsIn(expression)).numeric.forEach((value) => tokens.numeric.add(value));
      }
    }
  }
  for (const token of [...imageTokens, ...booleanTokens, ...frameTokens]) {
    tokens.numeric.delete(token);
    tokens.textual.delete(token);
  }
  const relevantDynamicTokens = new Set([...tokens.textual, ...imageTokens]);
  for (const definition of graph.scriptedLocalisation) {
    if (
      ![...relevantDynamicTokens].some(
        (token) => token === definition.name || token.endsWith(`.${definition.name}`),
      )
    )
      continue;
    for (const choice of definition.choices) {
      const threshold = simpleThreshold(choice.triggerExpression);
      if (threshold !== undefined) tokens.numeric.add(threshold.variable);
    }
  }
  const progressRanges = new Map<string, { minimum: number; maximum: number }>();
  for (const element of elements) {
    if (!/progressbar/iu.test(element.elementType)) continue;
    const minimum = scalarNumber(element.attributes.minValue) ?? 0;
    const maximum = scalarNumber(element.attributes.maxValue) ?? 100;
    progressRanges.set(element.name, { minimum, maximum });
    const startValue = element.attributes.startValue;
    if (typeof startValue === 'string' && !/^-?(?:\d+\.?\d*|\.\d+)$/u.test(startValue))
      tokens.numeric.add(startValue);
  }
  const dynamicLists = [...new Set(scripted.flatMap(({ dynamicLists }) => dynamicLists))].sort();
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
  const sourceSeed =
    options.seed === 'auto' ? `${windowName}:${base.id}:${hashSourceGraph(graph)}` : options.seed;
  return Array.from({ length: options.count }, (_unused, scenarioIndex) => {
    const random = new ScenarioRandom(`${sourceSeed}:${scenarioIndex}`);
    const values = { ...base.values };
    const lists = Object.fromEntries(
      Object.entries(base.lists).map(([key, rows]) => [key, rows.map((row) => ({ ...row }))]),
    );
    const visibility = generatedVisibility(graph, scripted, options, random, base.visibility);
    const elementStates = { ...base.elementStates };
    const scopedCountries = new Map<string, string>();
    const generatedCountryIndex = random.integer(0, countryNames.length - 1);
    const generatedCountryTag = countryTags[generatedCountryIndex]!;
    for (const key of tokens.numeric)
      setIfMissing(
        values,
        key,
        generatedNumberForKey(key, options, random, numericConstraints.ranges.get(key)),
      );
    for (const [elementName, { minimum, maximum }] of progressRanges) {
      const element = elements.find(({ name }) => name === elementName);
      const startValueToken =
        typeof element?.attributes.startValue === 'string'
          ? element.attributes.startValue
          : undefined;
      const existingElementValue = values[elementName];
      const existingTokenValue =
        startValueToken === undefined ? undefined : values[startValueToken];
      const value =
        typeof existingElementValue === 'number'
          ? existingElementValue
          : typeof existingTokenValue === 'number'
            ? existingTokenValue
            : generatedNumber(options, random, minimum, maximum);
      setIfMissing(values, elementName, value);
      if (startValueToken !== undefined) setIfMissing(values, startValueToken, value);
    }
    for (const key of tokens.numeric) {
      if (!key.endsWith('_bar') || base.values[key] !== undefined) continue;
      const sourceKey = key.slice(0, -'_bar'.length);
      const sourceValue = values[sourceKey];
      if (typeof sourceValue === 'number') values[key] = sourceValue;
    }
    for (const { value: valueKey, limit: limitKey } of numericConstraints.relationships) {
      if (base.values[valueKey] !== undefined) continue;
      const value = values[valueKey];
      const limit = values[limitKey];
      if (typeof value !== 'number' || typeof limit !== 'number') continue;
      const minimum = Math.min(
        numericConstraints.ranges.get(valueKey)?.minimum ?? options.numericMinimum,
        limit,
      );
      values[valueKey] = Math.max(minimum, Math.min(value, limit));
    }
    for (const key of tokens.textual)
      setIfMissing(values, key, plausibleText(key, random, options.textSamples, scopedCountries));
    const scriptedTextTemplates = new Map<string, string>();
    for (const key of tokens.textual) {
      const scriptedValue = scriptedLocalisationValue(
        graph,
        key,
        base.language,
        random,
        'text',
        values,
      );
      if (scriptedValue !== undefined && base.values[key] === undefined)
        scriptedTextTemplates.set(key, scriptedValue);
    }
    for (let pass = 0; pass < 3; pass += 1)
      for (const [key, template] of scriptedTextTemplates)
        values[key] = materializeDynamicText(template, values);
    for (const key of imageTokens) {
      if (/(?:^|\.)GetFlag$/u.test(key)) {
        setIfMissing(values, key, generatedCountryTag);
        continue;
      }
      const sprite = scriptedLocalisationValue(graph, key, base.language, random, 'image', values);
      if (sprite !== undefined) setIfMissing(values, key, sprite);
    }
    for (const key of booleanTokens)
      setIfMissing(values, key, random.boolean(options.trueProbability));
    for (const key of frameTokens) setIfMissing(values, key, 1);
    if (options.elementStates === 'varied') {
      for (const elementName of enabledTargets)
        elementStates[elementName] ??= random.pick(variedStates);
    }
    for (const listName of dynamicLists) {
      if (lists[listName] !== undefined) continue;
      const count = random.integer(options.listRowsMinimum, options.listRowsMaximum);
      lists[listName] = generatedRows(count, random, options);
    }
    return parsePreviewScenario({
      ...base,
      id: `${base.id}-${options.idPrefix}-${scenarioIndex + 1}`,
      description: `Generated source-aware scenario ${scenarioIndex + 1} (seed ${sourceSeed})`,
      values,
      country: [...imageTokens].some((key) => /(?:^|\.)GetFlag$/u.test(key))
        ? {
            GetName: countryNames[generatedCountryIndex]!,
            GetAdjective: countryAdjectives[generatedCountryIndex]!,
            GetTag: generatedCountryTag,
            tag: generatedCountryTag,
            countryTag: generatedCountryTag,
            ideology: countryIdeologies[generatedCountryIndex]!,
            countryIdeology: countryIdeologies[generatedCountryIndex]!,
            ...base.country,
          }
        : base.country,
      lists,
      visibility,
      elementStates,
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
