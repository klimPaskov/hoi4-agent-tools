/**
 * Accept the argument shorthands coding agents most often send and rewrite them into the
 * canonical request before validation. Every rule maps one unambiguous shorthand to exactly one
 * canonical value; anything ambiguous is left alone so validation can name the field.
 *
 * The rules come from failed calls observed in agent transcripts: an event selector given as a
 * plain string or without its kind, a GUI scenario without an id, a decision inspection without
 * a scenario, a probability scenario set without ids or state, a scenario set sent as a bare
 * array, a namespace wildcard such as `chaosx.nr14.*`, a trace given `from` instead of `selector`,
 * and a script file check that also names the kind and scope its file already fixes.
 */

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const EVENT_ID = /^[A-Za-z0-9_.-]+\.[0-9]+$/u;

/** A selector object that names its kind but uses `id` or `path` for the kind's own field. */
function withKindField(value: JsonObject): JsonObject {
  const { kind, id, path, ...rest } = value;
  const field: Record<string, string> = {
    event: 'eventId',
    namespace: 'namespace',
    file: 'sourcePath',
    source: 'sourcePath',
    node: 'nodeId',
  };
  const target = typeof kind === 'string' ? field[kind] : undefined;
  if (target === undefined || rest[target] !== undefined) return value;
  const given = target === 'sourcePath' ? (path ?? id) : (id ?? path);
  if (typeof given !== 'string') return value;
  const extra = target === 'sourcePath' ? (path === undefined ? {} : { id }) : { path };
  return Object.fromEntries(
    Object.entries({
      kind,
      [target]: kind === 'namespace' ? withoutWildcard(given) : given,
      ...rest,
      ...extra,
    }).filter(([, entry]) => entry !== undefined),
  );
}

/** `chaosx.nr14.*`, `chaosx.nr14.` and `chaosx.nr14*` all name the namespace `chaosx.nr14`. */
function withoutWildcard(value: string): string {
  return value.replace(/\.?\*+$|\.$/u, '');
}

/** An event selector as a string or an object without `kind`. */
export function normalizeEventSelector(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (EVENT_ID.test(trimmed)) return { kind: 'event', eventId: trimmed };
    if (/\.txt$/iu.test(trimmed) || trimmed.includes('/'))
      return { kind: 'file', sourcePath: trimmed };
    return { kind: 'namespace', namespace: withoutWildcard(trimmed) };
  }
  if (isObject(value) && value.kind !== undefined) return withKindField(value);
  if (!isObject(value)) return value;
  const keys = Object.keys(value);
  const only = (...allowed: string[]): boolean => keys.every((key) => allowed.includes(key));
  if (typeof value.eventId === 'string' && only('eventId'))
    return { kind: 'event', eventId: value.eventId };
  if (typeof value.id === 'string' && only('id'))
    return EVENT_ID.test(value.id)
      ? { kind: 'event', eventId: value.id }
      : { kind: 'namespace', namespace: withoutWildcard(value.id) };
  if (typeof value.namespace === 'string' && only('namespace'))
    return { kind: 'namespace', namespace: withoutWildcard(value.namespace) };
  const sourcePath =
    typeof value.sourcePath === 'string'
      ? value.sourcePath
      : typeof value.path === 'string'
        ? value.path
        : undefined;
  if (sourcePath !== undefined && only('sourcePath', 'path', 'line', 'column')) {
    if (typeof value.line === 'number')
      return {
        kind: 'source',
        sourcePath,
        line: value.line,
        ...(typeof value.column === 'number' ? { column: value.column } : {}),
      };
    return { kind: 'file', sourcePath };
  }
  if (typeof value.nodeId === 'string' && only('nodeId'))
    return { kind: 'node', nodeId: value.nodeId };
  return value;
}

/** A scenario object without `id` takes its `name` or `label`, or a positional id. */
function withScenarioId(scenario: unknown, fallback: string): unknown {
  if (!isObject(scenario) || scenario.id !== undefined) return scenario;
  const { name, ...rest } = scenario;
  const id =
    typeof name === 'string' && name.length > 0
      ? name
      : typeof scenario.label === 'string' && scenario.label.length > 0
        ? scenario.label
        : fallback;
  return { id, ...rest };
}

function normalizeGuiScenario(value: unknown, fallback: string): unknown {
  return withScenarioId(value, fallback);
}

function normalizeConditionScenario(value: unknown, index: number): unknown {
  const scenario = withScenarioId(value, `scenario-${index + 1}`);
  if (!isObject(scenario)) return scenario;
  return scenario.state === undefined ? { ...scenario, state: {} } : scenario;
}

/** A probability scenario set as a bare array, or without its id. */
function normalizeScenarioSet(value: unknown): unknown {
  const set = Array.isArray(value) ? { scenarios: value } : value;
  if (!isObject(set) || !Array.isArray(set.scenarios)) return set;
  return {
    ...set,
    ...(set.id === undefined ? { id: 'scenarios' } : {}),
    scenarios: set.scenarios.map((scenario, index) => normalizeConditionScenario(scenario, index)),
  };
}

function normalizeEventArguments(args: JsonObject): JsonObject {
  const result = { ...args };
  // A top-level event ID, namespace or file stands for the selector.
  if (result.selector === undefined)
    for (const key of ['eventId', 'id', 'namespace', 'event'] as const)
      if (typeof result[key] === 'string') {
        result.selector = result[key];
        Reflect.deleteProperty(result, key);
        break;
      }
  // Modes that start from one event take `selector`; `from` alone means the same event.
  if (
    result.selector === undefined &&
    result.to === undefined &&
    result.from !== undefined &&
    result.mode !== 'explain_path'
  ) {
    result.selector = result.from;
    delete result.from;
  }
  for (const key of ['selector', 'from', 'to'] as const)
    if (result[key] !== undefined) result[key] = normalizeEventSelector(result[key]);
  return result;
}

/**
 * A file check reads each block's kind and scope from the file, so a kind or scope sent with
 * `path` is redundant and dropped. `file` names the path and `snippet`, `code` or `text` the
 * source; a snippet without a scope runs in country scope.
 */
function normalizeScriptValidateArguments(args: JsonObject): JsonObject {
  const result = { ...args };
  for (const alias of ['file', 'filePath', 'sourcePath'] as const)
    if (result.path === undefined && typeof result[alias] === 'string') {
      result.path = result[alias];
      Reflect.deleteProperty(result, alias);
    }
  for (const alias of ['snippet', 'code', 'text', 'script', 'body'] as const)
    if (result.source === undefined && typeof result[alias] === 'string') {
      result.source = result[alias];
      Reflect.deleteProperty(result, alias);
    }
  if (typeof result.path === 'string' && result.source === undefined) {
    delete result.kind;
    delete result.scope;
    if (Array.isArray(result.bindings) && result.bindings.length === 0) delete result.bindings;
  }
  if (typeof result.source === 'string' && result.path === undefined && result.scope === undefined)
    result.scope = 'country';
  return result;
}

function normalizeGuiArguments(args: JsonObject, defaultScenario: boolean): JsonObject {
  const result = { ...args };
  const fallback = typeof result.windowName === 'string' ? result.windowName : 'default';
  if (result.scenario !== undefined)
    result.scenario = normalizeGuiScenario(result.scenario, fallback);
  // A window inspection without a scenario reads the window in its default state.
  else if (defaultScenario || typeof result.windowName === 'string')
    result.scenario = { id: fallback };
  if (Array.isArray(result.relatedScenarios))
    result.relatedScenarios = result.relatedScenarios.map((scenario, index) =>
      normalizeGuiScenario(scenario, `${fallback}-${index + 1}`),
    );
  if (isObject(result.generatedScenarios)) {
    const { maxScenarios, ...rest } = result.generatedScenarios;
    result.generatedScenarios =
      typeof maxScenarios === 'number' && rest.count === undefined
        ? { ...rest, count: maxScenarios }
        : result.generatedScenarios;
  }
  return result;
}

function normalizeDecisionArguments(args: JsonObject): JsonObject {
  const result = { ...args };
  for (const alias of ['decisionId', 'decision', 'missionId'] as const)
    if (result.id === undefined && typeof result[alias] === 'string') {
      result.id = result[alias];
      Reflect.deleteProperty(result, alias);
    }
  if (result.mode === undefined && typeof result.id === 'string') result.mode = 'inspect';
  if (Array.isArray(result.scenarios))
    result.scenarios = result.scenarios.map((scenario, index) =>
      normalizeConditionScenario(scenario, index),
    );
  const mode = result.mode ?? 'inventory';
  if (
    (mode === 'inspect' || mode === 'compare') &&
    (result.scenarios === undefined ||
      (Array.isArray(result.scenarios) && result.scenarios.length === 0))
  ) {
    result.scenarios = [
      {
        id: 'no-facts',
        state: {},
        ...(typeof result.actor === 'string' ? { actor: result.actor } : {}),
      },
    ];
    if (typeof result.actor === 'string') delete result.actor;
  }
  return result;
}

function normalizeProbabilityArguments(args: JsonObject): JsonObject {
  const result = { ...args };
  if (result.scenarioSet !== undefined)
    result.scenarioSet = normalizeScenarioSet(result.scenarioSet);
  if (typeof result.source === 'string')
    result.source = /\.txt$/iu.test(result.source)
      ? { path: result.source }
      : { identifier: result.source };
  if (typeof result.candidatePool === 'string') result.candidatePool = [result.candidatePool];
  return result;
}

/** Rewrite known shorthands for one tool; unknown tools and non-object arguments pass through. */
export function normalizeToolArguments(name: string, args: unknown): unknown {
  if (!isObject(args)) return args;
  switch (name) {
    case 'hoi4.event_inspect':
    case 'hoi4.event_render':
      return normalizeEventArguments(args);
    case 'hoi4.gui_inspect':
      return normalizeGuiArguments(args, false);
    case 'hoi4.gui_render':
    case 'hoi4.gui_rewrite':
      return normalizeGuiArguments(args, true);
    case 'hoi4.decision_inspect':
      return normalizeDecisionArguments(args);
    case 'hoi4.script_validate':
      return normalizeScriptValidateArguments(args);
    case 'hoi4.probability_inspect':
    case 'hoi4.probability_analyze':
      return normalizeProbabilityArguments(args);
    default:
      return args;
  }
}
