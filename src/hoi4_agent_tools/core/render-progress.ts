/** Internal service progress; phases contain no source text or filesystem paths. */
export interface RenderProgress {
  signal?: AbortSignal;
  progress?: (phase: string) => Promise<void>;
}

export async function renderStage(input: RenderProgress, phase: string): Promise<void> {
  input.signal?.throwIfAborted();
  await new Promise<void>((resolve) => setImmediate(resolve));
  input.signal?.throwIfAborted();
  await input.progress?.(phase);
  input.signal?.throwIfAborted();
}
