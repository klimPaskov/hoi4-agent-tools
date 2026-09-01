import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';

type GarbageCollector = () => void;

/**
 * Ask V8 to reclaim detached analysis graphs after an idle cache release.
 *
 * npm bin shims cannot portably add `--expose-gc`, so the collector is exposed
 * only for the duration of this best-effort idle maintenance call.
 */
export function compactManagedHeap(): boolean {
  const direct = (globalThis as typeof globalThis & { gc?: GarbageCollector }).gc;
  if (direct !== undefined) {
    direct();
    return true;
  }

  try {
    setFlagsFromString('--expose-gc');
    const candidate = runInNewContext('gc') as unknown;
    if (typeof candidate !== 'function') return false;
    (candidate as GarbageCollector)();
    return true;
  } catch {
    return false;
  } finally {
    setFlagsFromString('--no-expose-gc');
  }
}
