import type { ScannedFile } from '../core/scanner.js';
import { assignments, parseClausewitz, type SourceEntry } from '../core/source/index.js';
import type { GuiPreviewScenario } from './types.js';

/**
 * Engine-controlled GUI state.
 *
 * Some vanilla windows are not scripted: the game itself shows one branch of a window and
 * picks an icon frame from the player's country. This module models those decisions from the
 * scenario country, so a render shows the branch the game would show instead of every branch.
 * An explicit scenario value, visibility entry or selected frame always wins over this state.
 */

export type NativeFactionRole = 'none' | 'member' | 'leader';

export interface NativeCountryState {
  tag: string | undefined;
  /** Ruling ideology group, such as `democratic`; undefined when it cannot be determined. */
  ideology: string | undefined;
  faction: NativeFactionRole;
  balanceOfPower: boolean;
  /** Where each fact came from, for the fidelity report. */
  sources: {
    ideology: 'scenario' | 'history' | 'unknown';
    faction: 'scenario' | 'history' | 'default';
    balanceOfPower: 'scenario' | 'history' | 'default';
  };
}

export interface NativeWindowState {
  /** Element visibility the game decides; combined below explicit scenario visibility. */
  visibility: Record<string, boolean>;
  /** One-based frame values for icons whose frame the game picks from country state. */
  values: Record<string, number>;
  /** Fixed-vocabulary sentences describing each decision for the fidelity report. */
  notes: string[];
  state: NativeCountryState;
}

interface NativeBranchRule {
  /** Container elements shown exactly when `shown` holds, and hidden otherwise. */
  elements: readonly string[];
  shown: (state: NativeCountryState) => boolean;
  describe: string;
}

/** Windows whose branches the engine selects, keyed by the window's root element name. */
const NATIVE_BRANCHES: Readonly<Record<string, readonly NativeBranchRule[]>> = {
  countrypoliticsview: [
    {
      elements: ['no_faction'],
      shown: (state) => state.faction === 'none',
      describe: 'the country is not in a faction',
    },
    {
      elements: ['original_in_faction'],
      shown: (state) => state.faction === 'leader',
      describe: 'the country leads its faction',
    },
    {
      elements: ['in_faction'],
      shown: (state) => state.faction === 'member',
      describe: 'the country is a member of a faction it does not lead',
    },
    {
      elements: ['power_balance_button'],
      shown: (state) => state.balanceOfPower,
      describe: 'the country has an active balance of power',
    },
  ],
};

/**
 * Icons whose frame the game picks from the ruling ideology, as the ideology group at each
 * one-based frame. `pol_factions_strip` holds fascism, communism, democratic and neutrality.
 */
const IDEOLOGY_FRAME_ICONS: Readonly<Record<string, readonly string[]>> = {
  pol_faction_icon: ['fascism', 'communism', 'democratic', 'neutrality'],
};

const DEFAULT_SCENARIO_DATE = '1936.1.1';

function scenarioDate(scenario: GuiPreviewScenario): number {
  const parts = (scenario.date ?? DEFAULT_SCENARIO_DATE).split('.').map(Number);
  return dateKey(parts[0] ?? 1936, parts[1] ?? 1, parts[2] ?? 1);
}

function dateKey(year: number, month: number, day: number): number {
  return year * 10_000 + month * 100 + day;
}

function scenarioCountryTag(scenario: GuiPreviewScenario): string | undefined {
  const candidate = [
    scenario.country?.tag,
    scenario.country?.countryTag,
    scenario.country?.GetTag,
  ].find(
    (value): value is string => typeof value === 'string' && /^[A-Za-z0-9_]{2,64}$/u.test(value),
  );
  return candidate?.toUpperCase();
}

function scenarioString(
  scenario: GuiPreviewScenario,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = scenario.country?.[key];
    if (typeof value === 'string' && /^[A-Za-z0-9_]{2,64}$/u.test(value))
      return value.toLowerCase();
  }
  return undefined;
}

function scenarioBoolean(
  scenario: GuiPreviewScenario,
  ...keys: readonly string[]
): boolean | undefined {
  for (const key of keys) {
    const value = scenario.country?.[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string' && /^(?:yes|true)$/iu.test(value)) return true;
    if (typeof value === 'string' && /^(?:no|false)$/iu.test(value)) return false;
  }
  return undefined;
}

function explicitFaction(scenario: GuiPreviewScenario): NativeFactionRole | undefined {
  const named = scenarioString(scenario, 'faction', 'factionRole');
  if (named === 'none' || named === 'member' || named === 'leader') return named;
  const leader = scenarioBoolean(scenario, 'factionLeader', 'isFactionLeader');
  if (leader === true) return 'leader';
  const member = scenarioBoolean(scenario, 'inFaction', 'isInFaction', 'faction');
  if (member === false) return 'none';
  if (member === true) return 'member';
  return undefined;
}

/** What history says about one country: ruling party, faction creation and balance of power. */
interface HistoryFacts {
  ideology?: string;
  createsFaction: boolean;
  powerBalance: boolean;
}

const FACTION_CREATION = new Set(['create_faction', 'create_faction_from_template']);

function visitHistory(
  entries: readonly SourceEntry[],
  cutoff: number,
  facts: HistoryFacts,
  members: Map<string, Set<string>>,
  owner: string,
): void {
  for (const entry of entries) {
    if (entry.type !== 'assignment') continue;
    const key = entry.key.value;
    const dated = /^(\d{1,4})\.(\d{1,2})\.(\d{1,2})$/u.exec(key);
    if (dated !== null) {
      // A dated block applies from its date; later blocks have not happened yet.
      if (entry.value.type === 'block' && dateKey(+dated[1]!, +dated[2]!, +dated[3]!) <= cutoff)
        visitHistory(entry.value.entries, cutoff, facts, members, owner);
      continue;
    }
    if (key === 'set_politics' && entry.value.type === 'block') {
      const party = assignments(entry.value, 'ruling_party')[0]?.value;
      if (party?.type === 'scalar') facts.ideology = party.value.toLowerCase();
    } else if (FACTION_CREATION.has(key)) {
      facts.createsFaction = true;
    } else if (key === 'set_power_balance') {
      facts.powerBalance = true;
    } else if (key === 'remove_power_balance') {
      facts.powerBalance = false;
    } else if (
      key === 'add_to_faction' &&
      entry.value.type === 'scalar' &&
      entry.value.value.toUpperCase() !== owner
    ) {
      const tag = entry.value.value.toUpperCase();
      const joined = members.get(tag) ?? new Set<string>();
      joined.add(owner);
      members.set(tag, joined);
    } else if (
      (key === 'if' || key === 'else' || key === 'else_if') &&
      entry.value.type === 'block'
    ) {
      // Conditions such as DLC checks cannot be evaluated here; their content is treated as
      // part of the start, which matches a fully owned game.
      visitHistory(entry.value.entries, cutoff, facts, members, owner);
    }
  }
}

function historyTag(file: ScannedFile): string | undefined {
  const match = /^history\/countries\/([A-Za-z0-9_]{2,64})(?:\s*-[^/]*)?\.txt$/u.exec(
    file.relativePath.replaceAll('\\', '/'),
  );
  return match?.[1]?.toUpperCase();
}

function historyState(
  tag: string,
  files: readonly ScannedFile[],
  cutoff: number,
): { facts: HistoryFacts; found: boolean; memberOfFaction: boolean } {
  const facts: HistoryFacts = {
    createsFaction: false,
    powerBalance: false,
  };
  // `add_to_faction = X` in a leader's history adds X to that leader's faction, so a country
  // is a member when another country's history adds it.
  const additions = new Map<string, Set<string>>();
  let found = false;
  for (const file of files) {
    if (file.shadowedBy !== undefined) continue;
    const fileTag = historyTag(file);
    if (fileTag === undefined) continue;
    const owned = fileTag === tag;
    if (owned) found = true;
    // Only the country's own history carries its other facts; every other file can matter
    // solely through the members it adds to a faction.
    else if (!file.bytes.includes('add_to_faction')) continue;
    const document = parseClausewitz(file.bytes, file.displayPath);
    const own: HistoryFacts = {
      createsFaction: false,
      powerBalance: false,
    };
    visitHistory(document.root.entries, cutoff, owned ? facts : own, additions, fileTag);
  }
  const memberOfFaction = (additions.get(tag)?.size ?? 0) > 0;
  return { facts, found, memberOfFaction };
}

/** Resolve the country facts the engine would use, explicit scenario values first. */
export function resolveNativeCountryState(
  scenario: GuiPreviewScenario,
  files: readonly ScannedFile[],
): NativeCountryState {
  const tag = scenarioCountryTag(scenario);
  const history =
    tag === undefined
      ? undefined
      : historyState(
          tag,
          files.filter(({ relativePath }) => relativePath.startsWith('history/countries/')),
          scenarioDate(scenario),
        );
  const knownHistory = history?.found === true ? history : undefined;
  const ideologyFromScenario = scenarioString(
    scenario,
    'ideology',
    'rulingIdeology',
    'countryIdeology',
  );
  const factionFromScenario = explicitFaction(scenario);
  const bopFromScenario = scenarioBoolean(
    scenario,
    'balanceOfPower',
    'hasBalanceOfPower',
    'powerBalance',
  );
  const ideology = ideologyFromScenario ?? knownHistory?.facts.ideology;
  const faction: NativeFactionRole =
    factionFromScenario ??
    (knownHistory === undefined
      ? 'none'
      : knownHistory.facts.createsFaction
        ? 'leader'
        : knownHistory.memberOfFaction
          ? 'member'
          : 'none');
  return {
    tag,
    ideology,
    faction,
    balanceOfPower: bopFromScenario ?? knownHistory?.facts.powerBalance ?? false,
    sources: {
      ideology:
        ideologyFromScenario !== undefined
          ? 'scenario'
          : knownHistory?.facts.ideology !== undefined
            ? 'history'
            : 'unknown',
      faction:
        factionFromScenario !== undefined
          ? 'scenario'
          : knownHistory !== undefined
            ? 'history'
            : 'default',
      balanceOfPower:
        bopFromScenario !== undefined
          ? 'scenario'
          : knownHistory !== undefined
            ? 'history'
            : 'default',
    },
  };
}

/** Whether any native decision can apply to this window, so the country state is worth resolving. */
export function windowHasNativeState(
  windowName: string,
  elementNames: ReadonlySet<string>,
): boolean {
  return (
    NATIVE_BRANCHES[windowName] !== undefined ||
    Object.keys(IDEOLOGY_FRAME_ICONS).some((name) => elementNames.has(name))
  );
}

/** The engine-selected branches and frames for a scene, below any explicit scenario input. */
export function nativeWindowState(
  windowName: string,
  elementNames: ReadonlySet<string>,
  scenario: GuiPreviewScenario,
  files: readonly ScannedFile[],
): NativeWindowState | undefined {
  if (!windowHasNativeState(windowName, elementNames)) return undefined;
  const state = resolveNativeCountryState(scenario, files);
  const visibility: Record<string, boolean> = {};
  const values: Record<string, number> = {};
  const notes: string[] = [];
  const subject = state.tag ?? 'the scenario country';
  for (const rule of NATIVE_BRANCHES[windowName] ?? []) {
    const shown = rule.shown(state);
    for (const name of rule.elements) visibility[name] = shown;
    notes.push(
      `${rule.elements.join(', ')} ${shown ? 'is shown' : 'is hidden'} for ${subject}; the game shows it only when ${rule.describe}.`,
    );
  }
  for (const [name, order] of Object.entries(IDEOLOGY_FRAME_ICONS)) {
    if (!elementNames.has(name) || state.ideology === undefined) continue;
    const index = order.indexOf(state.ideology);
    if (index < 0) continue;
    values[`${name}.frame`] = index + 1;
    notes.push(`${name} shows the ${state.ideology} frame for ${subject}.`);
  }
  return { visibility, values, notes, state };
}

/** Whether the scenario needs history to resolve its native state, and so to be scanned. */
export function scenarioNeedsCountryHistory(scenario: GuiPreviewScenario): boolean {
  if (scenarioCountryTag(scenario) === undefined) return false;
  return (
    scenarioString(scenario, 'ideology', 'rulingIdeology', 'countryIdeology') === undefined ||
    explicitFaction(scenario) === undefined ||
    scenarioBoolean(scenario, 'balanceOfPower', 'hasBalanceOfPower', 'powerBalance') === undefined
  );
}
