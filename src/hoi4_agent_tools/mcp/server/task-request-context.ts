import { AsyncLocalStorage } from 'node:async_hooks';

export type TaskRequestProgress = (
  completed: number,
  total: number,
  message: string,
) => Promise<void>;
const taskRequestContext = new AsyncLocalStorage<{
  signal: AbortSignal;
  progress?: TaskRequestProgress;
}>();

/** Bind transport cancellation to foreground-compatible task creation only. */
export function withTaskRequestSignal<T>(
  signal: AbortSignal,
  action: () => T,
  progress?: TaskRequestProgress,
): T {
  return taskRequestContext.run(
    { signal, ...(progress === undefined ? {} : { progress }) },
    action,
  );
}

export function currentTaskRequestSignal(): AbortSignal | undefined {
  return taskRequestContext.getStore()?.signal;
}

export function currentTaskRequestProgress(): TaskRequestProgress | undefined {
  return taskRequestContext.getStore()?.progress;
}
