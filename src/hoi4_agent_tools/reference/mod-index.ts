import type { z } from 'zod/v4';
import type { CoreEngine } from '../core/engine.js';
import type { SymbolRecord } from '../core/index.js';
import { ServiceError } from '../core/result.js';
import { readModDescriptor } from '../core/workspace.js';
import type { modIndexDataSchema, modIndexRequestSchema } from '../schemas/mod-tools.js';

/**
 * A compact map of what a mod defines, and the next free numbered identifier for a prefix.
 * Identifiers are checked against every source layer, so a new ID never collides with a
 * game or dependency definition.
 */

type Input = z.infer<typeof modIndexRequestSchema>;
type Output = z.infer<typeof modIndexDataSchema>;

const MAX_NAMESPACES = 200;
const MAX_FOLDERS = 60;

/** Event namespaces with their numbered range, from `namespace.N` event IDs. */
function namespaces(symbols: readonly SymbolRecord[]): NonNullable<Output['namespaces']> {
  const byNamespace = new Map<string, { numbers: number[]; files: Set<string> }>();
  for (const symbol of symbols) {
    if (symbol.kind !== 'event') continue;
    const match = /^(.+)\.(\d{1,9})$/u.exec(symbol.id);
    if (match === null) continue;
    const entry = byNamespace.get(match[1]!) ?? { numbers: [], files: new Set<string>() };
    entry.numbers.push(Number(match[2]));
    entry.files.add(symbol.path);
    byNamespace.set(match[1]!, entry);
  }
  return [...byNamespace]
    .map(([namespace, { numbers, files }]) => ({
      namespace,
      events: new Set(numbers).size,
      lowest: Math.min(...numbers),
      highest: Math.max(...numbers),
      files: files.size,
    }))
    .sort((left, right) => left.namespace.localeCompare(right.namespace, 'en'));
}

export async function modIndex(
  engine: CoreEngine,
  workspaceId: string,
  input: Input,
  principal?: string,
  signal?: AbortSignal,
): Promise<Output> {
  if (input.mode === 'next_id') {
    const prefix =
      input.prefix ??
      (input.namespace === undefined ? undefined : `${input.namespace.replace(/\.$/u, '')}.`);
    if (prefix === undefined)
      throw new ServiceError('MOD_INDEX_PREFIX_REQUIRED', 'next_id needs prefix or namespace');
    // Every layer: a new identifier must not collide with game or dependency definitions.
    const snapshot = await engine.scan(workspaceId, {}, principal, signal);
    const used = new Set<number>();
    for (const symbol of snapshot.index.symbols) {
      if (symbol.kind !== input.kind || !symbol.id.startsWith(prefix)) continue;
      const suffix = symbol.id.slice(prefix.length);
      if (/^\d{1,9}$/u.test(suffix)) used.add(Number(suffix));
    }
    const highest = used.size === 0 ? undefined : Math.max(...used);
    let firstGap: number | undefined;
    for (let number = 1; highest !== undefined && number < highest; number += 1)
      if (!used.has(number)) {
        firstGap = number;
        break;
      }
    const next = (highest ?? 0) + 1;
    return {
      mode: 'next_id',
      complete: snapshot.complete,
      next: {
        kind: input.kind,
        prefix,
        used: used.size,
        ...(highest === undefined ? {} : { highest }),
        nextId: `${prefix}${next}`,
        ...(firstGap === undefined ? {} : { firstGapId: `${prefix}${firstGap}` }),
      },
    };
  }
  const snapshot = await engine.scan(
    workspaceId,
    input.layer === 'mod' ? { rootKinds: ['mod'] } : {},
    principal,
    signal,
  );
  const symbols = snapshot.index.symbols.filter(({ overridden }) => !overridden);
  const kinds = new Map<string, number>();
  for (const symbol of symbols) kinds.set(symbol.kind, (kinds.get(symbol.kind) ?? 0) + 1);
  const folders = new Map<string, { files: number; bytes: number }>();
  for (const file of snapshot.files) {
    const parts = file.relativePath.split('/');
    const folder =
      parts.length > 2 && parts[0] === 'common' ? parts.slice(0, 2).join('/') : parts[0]!;
    const totals = folders.get(folder) ?? { files: 0, bytes: 0 };
    totals.files += 1;
    totals.bytes += file.size;
    folders.set(folder, totals);
  }
  const allNamespaces = namespaces(symbols);
  const modRoot = engine.resolver
    .get(workspaceId, principal)
    .roots.find(({ kind }) => kind === 'mod')?.path;
  const descriptor = modRoot === undefined ? undefined : await readModDescriptor(modRoot);
  return {
    mode: 'overview',
    layer: input.layer,
    complete: snapshot.complete,
    ...(descriptor === undefined ? {} : { descriptor }),
    files: snapshot.files.length,
    kinds: [...kinds]
      .map(([kind, count]) => ({ kind, count }))
      .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind)),
    folders: [...folders]
      .map(([folder, totals]) => ({ folder, ...totals }))
      .sort((left, right) => right.files - left.files || left.folder.localeCompare(right.folder))
      .slice(0, MAX_FOLDERS),
    namespaces: allNamespaces.slice(0, MAX_NAMESPACES),
    omittedNamespaces: Math.max(0, allNamespaces.length - MAX_NAMESPACES),
  };
}
