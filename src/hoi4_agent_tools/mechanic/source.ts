import type { ScanSnapshot } from '../core/engine.js';
import { assignments, firstScalar, parseClausewitz, type BlockNode } from '../core/source/index.js';
import { ServiceError } from '../core/result.js';
import { decisionSourceInventory } from '../decision/source-inventory.js';
import type { MechanicCase } from '../schemas/scenarios.js';
import type { MechanicSource } from './interpreter.js';

type Selector = Extract<MechanicCase['steps'][number], { kind: 'effect' }>['source'];
const eventKinds = new Set([
  'country_event',
  'state_event',
  'news_event',
  'unit_leader_event',
  'operative_leader_event',
]);
const optionMetadata = new Set([
  'name',
  'ai_chance',
  'trigger',
  'highlighted',
  'original_tag_only',
  'show_but_dont_execute',
]);

function activeDocument(snapshot: ScanSnapshot, path: string) {
  const file = snapshot.files.find(
    (candidate) => candidate.displayPath === path && candidate.shadowedBy === undefined,
  );
  return file === undefined ? undefined : parseClausewitz(file.bytes, file.displayPath);
}

function source(id: string, path: string, block: BlockNode | undefined): MechanicSource {
  if (block === undefined)
    throw new ServiceError('MECHANIC_SOURCE_MISSING', 'Selected source has no effect block', {
      id,
      path,
    });
  return { id, path, block };
}

export function selectMechanicSource(snapshot: ScanSnapshot, selector: Selector): MechanicSource {
  if (selector.kind === 'decision') {
    const decision = decisionSourceInventory(snapshot).decisions.find(
      ({ id }) => id === selector.id,
    );
    return source(
      selector.id,
      decision?.path ?? '',
      decision?.fields.complete_effect[0]?.value.type === 'block'
        ? decision.fields.complete_effect[0].value
        : undefined,
    );
  }
  const indexedKind =
    selector.kind === 'focus_reward'
      ? 'focus'
      : selector.kind === 'event_option'
        ? 'event'
        : 'scripted_effect';
  const symbol = snapshot.index.find(indexedKind, selector.id);
  const document = symbol === undefined ? undefined : activeDocument(snapshot, symbol.path);
  if (document === undefined)
    throw new ServiceError(
      'MECHANIC_SOURCE_MISSING',
      'Selected source definition is absent',
      selector,
    );
  if (selector.kind === 'scripted_effect') {
    const block = assignments(document.root, selector.id)[0]?.value;
    return source(selector.id, symbol!.path, block?.type === 'block' ? block : undefined);
  }
  if (selector.kind === 'event_option') {
    if (selector.option === undefined)
      throw new ServiceError('MECHANIC_OPTION_REQUIRED', 'Event option selector requires option');
    const event = assignments(document.root).find(
      (candidate) =>
        eventKinds.has(candidate.key.value) &&
        candidate.value.type === 'block' &&
        firstScalar(candidate.value, 'id')?.value === selector.id,
    );
    const option =
      event?.value.type === 'block'
        ? assignments(event.value, 'option').find(
            (candidate) =>
              candidate.value.type === 'block' &&
              firstScalar(candidate.value, 'name')?.value === selector.option,
          )
        : undefined;
    if (option?.value.type !== 'block')
      throw new ServiceError(
        'MECHANIC_OPTION_MISSING',
        'Selected event option is absent',
        selector,
      );
    return source(selector.id + ':' + selector.option, symbol!.path, {
      ...option.value,
      entries: option.value.entries.filter(
        (entry) => entry.type !== 'assignment' || !optionMetadata.has(entry.key.value),
      ),
    });
  }
  const focusTree = assignments(document.root, 'focus_tree');
  const focus = focusTree
    .flatMap((tree) => (tree.value.type === 'block' ? assignments(tree.value, 'focus') : []))
    .find(
      (candidate) =>
        candidate.value.type === 'block' &&
        firstScalar(candidate.value, 'id')?.value === selector.id,
    );
  const reward =
    focus?.value.type === 'block'
      ? assignments(focus.value, 'completion_reward')[0]?.value
      : undefined;
  return source(selector.id, symbol!.path, reward?.type === 'block' ? reward : undefined);
}

export function scriptedEffectSources(snapshot: ScanSnapshot): Map<string, MechanicSource> {
  const result = new Map<string, MechanicSource>();
  for (const symbol of snapshot.index.symbols) {
    if (symbol.kind !== 'scripted_effect' || symbol.overridden || symbol.sourceShadowed) continue;
    const document = activeDocument(snapshot, symbol.path);
    const block =
      document === undefined ? undefined : assignments(document.root, symbol.id)[0]?.value;
    if (block?.type === 'block') result.set(symbol.id, { id: symbol.id, path: symbol.path, block });
  }
  return result;
}
