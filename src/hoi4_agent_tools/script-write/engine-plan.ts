import { z } from 'zod/v4';
import { callEngineOperation } from '../core/engine-operation.js';
import { DIFF_CONTEXT_LINES, unifiedTextDiff } from '../core/diff.js';
import { decodeSource } from '../core/source/encoding.js';

/**
 * The call every script writer makes (ADR 0089, ADR 0091, packet P10): the engine plans the edit of
 * one definition and answers with the plan's JSON and the bytes of the file after the edit. The
 * writer never touches the disk. This side adds the decoded text and the unified diff, which move to
 * the engine with the diff service.
 */

/** One replacement. `start` and `end` are byte offsets of the decoded text (UTF-8 after the byte order mark), not UTF-16 offsets. */
export const replacementSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  text: z.string(),
  description: z.string(),
});
export type SourceByteReplacement = z.infer<typeof replacementSchema>;

export interface EnginePlanCall<S extends z.ZodType> {
  op: string;
  path: string;
  input: Record<string, unknown>;
  /** The source file the edit starts from, absent when the call creates the file. */
  source?: Uint8Array;
  result: S;
}

export interface EnginePlanAnswer<T> {
  result: T;
  /** The file after the edit, in its own encoding. */
  bytes: Buffer;
  /** The source after the edit, decoded. */
  text: string;
  /** A unified diff of the file, empty when nothing changed. */
  diff: string;
}

export async function callWritePlan<S extends z.ZodType>(
  call: EnginePlanCall<S>,
): Promise<EnginePlanAnswer<z.infer<S>>> {
  const answer = await callEngineOperation<z.infer<S>>({
    op: call.op,
    body: { input: call.input, path: call.path, newFile: call.source === undefined },
    ...(call.source === undefined ? {} : { payload: Buffer.from(call.source) }),
    result: call.result as z.ZodType<z.infer<S>>,
  });
  const text = decodeSource(answer.payload).text;
  const before = call.source === undefined ? '' : decodeSource(call.source).text;
  return {
    result: answer.result,
    bytes: answer.payload,
    text,
    diff: unifiedTextDiff(before, text, `a/${call.path}`, `b/${call.path}`, {
      context: DIFF_CONTEXT_LINES,
    }),
  };
}

/** Asks the engine a question about one source file, such as the categories it has. */
export async function callSourceQuery<S extends z.ZodType>(
  op: string,
  path: string,
  source: Uint8Array,
  result: S,
): Promise<z.infer<S>> {
  const answer = await callEngineOperation<z.infer<S>>({
    op,
    body: { path },
    payload: Buffer.from(source),
    result: result as z.ZodType<z.infer<S>>,
  });
  return answer.result;
}
