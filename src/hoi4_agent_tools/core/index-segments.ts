import { compareCodeUnits } from './canonical.js';
import type { ReferenceRecord, SymbolKind, SymbolRecord } from './index.js';

/** Reverse edges are derived from typed source references, never matching arbitrary strings. */
export class ReverseSourceDependencies {
  readonly #consumers = new Map<string, Set<string>>();
  readonly #definitions = new Map<string, Set<string>>();

  constructor(
    symbols: readonly Pick<SymbolRecord, 'kind' | 'id' | 'path'>[],
    references: readonly Pick<ReferenceRecord, 'toKind' | 'to' | 'path'>[],
  ) {
    for (const symbol of symbols) {
      const definitions = this.#definitions.get(symbol.path) ?? new Set<string>();
      definitions.add(`${symbol.kind}:${symbol.id}`);
      this.#definitions.set(symbol.path, definitions);
    }
    for (const reference of references) {
      const key = `${reference.toKind}:${reference.to}`;
      const consumers = this.#consumers.get(key) ?? new Set<string>();
      consumers.add(reference.path);
      this.#consumers.set(key, consumers);
    }
  }

  affectedFiles(changedFiles: readonly string[]): string[] {
    const affected = new Set(changedFiles);
    const queue = [...affected];
    for (const source of queue) {
      for (const definition of this.#definitions.get(source) ?? []) {
        for (const consumer of this.#consumers.get(definition) ?? []) {
          if (affected.has(consumer)) continue;
          affected.add(consumer);
          queue.push(consumer);
        }
      }
    }
    return [...affected].sort(compareCodeUnits);
  }

  consumers(kind: SymbolKind, id: string): string[] {
    return [...(this.#consumers.get(`${kind}:${id}`) ?? [])].sort(compareCodeUnits);
  }
}
