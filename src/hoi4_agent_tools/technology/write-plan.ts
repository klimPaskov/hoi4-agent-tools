import { z } from 'zod/v4';
import {
  callWritePlan,
  replacementSchema,
  type SourceByteReplacement,
} from '../script-write/engine-plan.js';

/**
 * The edit behind `hoi4.tech_write` (issue 158): add, replace or remove one tech of a `common/technologies/*.txt` file and
 * nothing else. The engine plans it (`hoi4-script-write`, ADR 0089): every byte outside the touched
 * block, its comments, its neighbours, the newline style and the encoding come back as they were
 * read, and a layout the edit cannot place safely is refused with the reason, not guessed.
 */

export type TechWriteOperation = 'add' | 'replace' | 'remove';

export interface TechWriteInput {
  operation: TechWriteOperation;
  /** The tech to add, replace or remove. */
  id: string;
  /** The text between the tech's braces. Required by add and replace, refused by remove. */
  body?: string;
}

export interface TechWritePlan {
  operation: TechWriteOperation;
  id: string;
  path: string;
  /** The source after the edit, decoded. */
  text: string;
  /** The file after the edit, in its own encoding. */
  bytes: Buffer;
  /** The one replacement that was made, in byte offsets of the decoded text. */
  edit: SourceByteReplacement;
  /** A unified diff of the file, empty when nothing changed. */
  diff: string;
  /** The definitions of the file that the edit left untouched, byte for byte. */
  untouchedDefinitions: number;
}

const planSchema = z.object({
  operation: z.enum(['add', 'replace', 'remove']),
  id: z.string(),
  path: z.string(),
  edit: replacementSchema,
  untouchedDefinitions: z.number().int().nonnegative(),
});

async function plan(
  path: string,
  input: TechWriteInput,
  source: Uint8Array | undefined,
): Promise<TechWritePlan> {
  const answer = await callWritePlan({
    op: 'tech_write.plan',
    path,
    input: { ...input },
    ...(source === undefined ? {} : { source }),
    result: planSchema,
  });
  return { ...answer.result, text: answer.text, bytes: answer.bytes, diff: answer.diff };
}

/** The plan that creates a new file holding one new tech, for `createFile: true`. */
export function planNewTechFile(path: string, input: TechWriteInput): Promise<TechWritePlan> {
  return plan(path, input, undefined);
}

export function planTechWrite(
  source: { bytes: Uint8Array; path: string },
  input: TechWriteInput,
): Promise<TechWritePlan> {
  return plan(source.path, input, source.bytes);
}
