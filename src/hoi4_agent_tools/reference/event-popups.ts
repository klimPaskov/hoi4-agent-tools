import { parseClausewitz, type AssignmentNode, type BlockNode } from '../core/source/index.js';
import type { PlayerTextFinding } from './player-text.js';

/** How an event reaches players: hidden events never open a window. */
export interface EventPopupDefinition {
  hidden: boolean;
  /** `major = yes` shows the event to every country; `fire_only_once` overrides it. */
  major: boolean;
  fireOnlyOnce: boolean;
}

const eventEffects = new Set(['country_event', 'news_event']);
const eventTypes = new Set([
  'country_event',
  'news_event',
  'state_event',
  'unit_leader_event',
  'operative_leader_event',
]);
/** Scopes that name the same target on every iteration of an enclosing loop. */
const fixedScope =
  /^(?:root|from(?:\.from)*|prev(?:\.prev)*|global|event_target:.+|var:.+|[A-Z][A-Z0-9]{2})$/u;
const notTags = new Set(['AND', 'NOT', 'NOR', 'XOR']);

function assignmentsOf(block: BlockNode): AssignmentNode[] {
  return block.entries.filter((entry): entry is AssignmentNode => entry.type === 'assignment');
}

function scalar(block: BlockNode, key: string): string | undefined {
  const entry = assignmentsOf(block).find((child) => child.key.value === key);
  return entry?.value.type === 'scalar' ? entry.value.value : undefined;
}

/** Event definitions of one events file, keyed by id. */
export function eventPopupDefinitions(
  bytes: Uint8Array,
  path: string,
): Map<string, EventPopupDefinition> {
  const definitions = new Map<string, EventPopupDefinition>();
  for (const event of assignmentsOf(parseClausewitz(bytes, path).root)) {
    if (!eventTypes.has(event.key.value) || event.value.type !== 'block') continue;
    const id = scalar(event.value, 'id');
    if (id === undefined) continue;
    definitions.set(id, {
      hidden: scalar(event.value, 'hidden') === 'yes',
      major: scalar(event.value, 'major') === 'yes',
      fireOnlyOnce: scalar(event.value, 'fire_only_once') === 'yes',
    });
  }
  return definitions;
}

/**
 * Visible events fired inside an `every_*` loop that reach the same player once per
 * iteration: a fixed recipient (ROOT, FROM, PREV, a tag, a target) receives one window per
 * loop member, and a major event is shown to every country once per loop member.
 */
export function repeatedPopupFindings(
  document: { root: BlockNode },
  events: ReadonlyMap<string, EventPopupDefinition>,
): PlayerTextFinding[] {
  const findings: PlayerTextFinding[] = [];
  const visit = (block: BlockNode, loops: readonly string[], fixed: string | undefined) => {
    for (const entry of assignmentsOf(block)) {
      const key = entry.key.value;
      if (key === 'limit') continue;
      if (eventEffects.has(key) && loops.length > 0) {
        const id = entry.value.type === 'block' ? scalar(entry.value, 'id') : entry.value.value;
        const definition = id === undefined ? undefined : events.get(id);
        if (definition === undefined || definition.hidden) continue;
        const loop = loops.join(' inside ');
        if (fixed !== undefined)
          findings.push({
            code: 'SCRIPT_EVENT_POPUP_REPEATED',
            command: key,
            offset: entry.start,
            end: entry.end,
            message: `${id} is sent to ${fixed} once per member of ${loop}, so that player receives one window per iteration; fire it once outside the loop or mark it hidden`,
          });
        else if (definition.major && !definition.fireOnlyOnce)
          findings.push({
            code: 'SCRIPT_EVENT_POPUP_REPEATED',
            command: key,
            offset: entry.start,
            end: entry.end,
            message: `${id} is a major event fired once per member of ${loop}, so every player receives one window per iteration; fire it once outside the loop`,
          });
        continue;
      }
      if (entry.value.type !== 'block') continue;
      if (key.startsWith('every_')) visit(entry.value, [...loops, key], undefined);
      else if (
        loops.length > 0 &&
        !notTags.has(key) &&
        (fixedScope.test(key) || fixedScope.test(key.toLowerCase()))
      )
        visit(entry.value, loops, key);
      else visit(entry.value, loops, fixed);
    }
  };
  visit(document.root, [], undefined);
  return findings;
}
