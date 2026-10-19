import type { EventScopeKind, EventStateAccess } from './model.js';

type StateIdentity = Pick<EventStateAccess, 'kind' | 'name' | 'scope' | 'metadata'>;

const SCOPE_KINDS: readonly EventScopeKind[] = [
  'country',
  'state',
  'province',
  'unit_leader',
  'operative',
  'character',
  'global',
  'unknown',
];

/** Identity of one stored value: variables and arrays live per scope, saved scopes per storage. */
export function stateKey(value: StateIdentity): string {
  const scope = value.kind === 'variable' || value.kind === 'array' ? `:${value.scope}` : '';
  const storage =
    value.kind === 'saved_scope'
      ? `:${
          value.metadata.storage === 'global' || value.metadata.storage === 'local'
            ? value.metadata.storage
            : 'unknown'
        }`
      : '';
  return `${value.kind}:${value.name}${scope}${storage}`;
}

/** Keys of every write that a read of this value can observe. */
export function compatibleProducerKeys(value: StateIdentity): string[] {
  // `event_target:name` reads local and global targets alike, whereas
  // `global_event_target:name` reads only global ones.
  if (value.kind === 'event_target') {
    return [stateKey(value), `global_event_target:${value.name}`];
  }
  // A helper body runs in whatever scope calls it, so its scope is unknown. A write there can
  // reach a read in any scope, and a read there can observe a write in any scope.
  if (value.kind === 'variable' || value.kind === 'array') {
    const scopes = value.scope === 'unknown' ? SCOPE_KINDS : [value.scope, 'unknown'];
    const keys = scopes.map((scope) => `${value.kind}:${value.name}:${scope}`);
    // `entries^num` and `entries^3` read the array `entries`; `GER.value` and `ROOT.value` read
    // `value` in another scope, which may be written under its bare name in any scope.
    const element = /^([^^]+)\^/u.exec(value.name)?.[1];
    if (element !== undefined)
      keys.push(...SCOPE_KINDS.map((scope) => `array:${unscopedName(element)}:${scope}`));
    const bare = unscopedName(value.name);
    if (bare !== value.name)
      keys.push(...SCOPE_KINDS.map((scope) => `${value.kind}:${bare}:${scope}`));
    return [...new Set(keys)];
  }
  if (
    value.kind !== 'saved_scope' ||
    value.metadata.storage === 'global' ||
    value.metadata.storage === 'local'
  ) {
    return [stateKey(value)];
  }
  return [
    `saved_scope:${value.name}:global`,
    `saved_scope:${value.name}:local`,
    `saved_scope:${value.name}:unknown`,
  ];
}

/** `GER.value`, `ROOT.FROM.value` or `var:target.value` without its scope prefix. */
function unscopedName(name: string): string {
  const scoped =
    /^(?:(?:[A-Z][A-Z0-9]{2}|ROOT|FROM|PREV|THIS|OWNER|CONTROLLER|CAPITAL)\.|(?:var|event_target):[A-Za-z0-9_]+\.)+(.+)$/u.exec(
      name,
    );
  return scoped?.[1] ?? name;
}

export function hasUnknownSavedScopeStorage(
  value: Pick<EventStateAccess, 'kind' | 'metadata'>,
): boolean {
  return (
    value.kind === 'saved_scope' &&
    value.metadata.storage !== 'global' &&
    value.metadata.storage !== 'local'
  );
}
