import { canonicalJson, compareCodeUnits } from './canonical.js';
import { ServiceError } from './result.js';
import { TRANSACTION_MAX_MANIFEST_BYTES } from './transaction-limits.js';

/** A request-local snapshot of canonical immutable fields, without shared writable references. */
export class TransactionCanonicalSnapshot {
  private readonly immutable = new Map<string, string>();
  private readonly mutable: ReadonlySet<string>;

  constructor(source: object, mutableKeys: readonly string[]) {
    this.mutable = new Set(mutableKeys);
    let bytes = 2;
    for (const [key, value] of Object.entries(source)) {
      if (this.mutable.has(key) || value === undefined) continue;
      const encoded = canonicalJson(value);
      bytes += Buffer.byteLength(JSON.stringify(key)) + Buffer.byteLength(encoded) + 2;
      this.assertBound(bytes);
      this.immutable.set(key, encoded);
    }
  }

  serialize(source: object, excludedKeys: readonly string[] = []): string {
    const mutable = source as Record<string, unknown>;
    const excluded = new Set(excludedKeys);
    const keys = [...new Set([...this.immutable.keys(), ...this.mutable])]
      .filter(
        (key) => !excluded.has(key) && (this.immutable.has(key) || mutable[key] !== undefined),
      )
      .sort(compareCodeUnits);
    // JSON objects emit integer keys before other keys, including after canonical insertion.
    const orderedKeys = Object.keys(Object.fromEntries(keys.map((key) => [key, null])));
    let bytes = 2;
    const entries = orderedKeys.map((key) => {
      const value = this.immutable.get(key) ?? canonicalJson(mutable[key]);
      const entry = `${JSON.stringify(key)}:${value}`;
      bytes += Buffer.byteLength(entry) + 1;
      this.assertBound(bytes);
      return entry;
    });
    return `{${entries.join(',')}}`;
  }

  private assertBound(bytes: number): void {
    if (bytes > TRANSACTION_MAX_MANIFEST_BYTES) {
      throw new ServiceError(
        'TRANSACTION_MANIFEST_LIMIT',
        'Transaction manifest exceeds its fixed byte limit',
      );
    }
  }
}
