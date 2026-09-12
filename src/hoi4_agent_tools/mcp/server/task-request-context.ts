import { AsyncLocalStorage } from 'node:async_hooks';

const taskRequestContext = new AsyncLocalStorage<{ signal: AbortSignal }>();

/** Bind transport cancellation to foreground-compatible task creation only. */
export function withTaskRequestSignal<T>(signal: AbortSignal, action: () => T): T {
  return taskRequestContext.run({ signal }, action);
}

export function currentTaskRequestSignal(): AbortSignal | undefined {
  return taskRequestContext.getStore()?.signal;
}
