import { z } from 'zod/v4';
import {
  callSourceQuery,
  callWritePlan,
  replacementSchema,
  type SourceByteReplacement,
} from '../script-write/engine-plan.js';

/**
 * The edit behind `hoi4.decision_write` (issue 159): add, replace or remove one decision of a `common/decisions/*.txt` file and
 * nothing else. The engine plans it (`hoi4-script-write`, ADR 0089): every byte outside the touched
 * block, its comments, its neighbours, the newline style and the encoding come back as they were
 * read, and a layout the edit cannot place safely is refused with the reason, not guessed.
 */

export type DecisionWriteOperation = 'add' | 'replace' | 'remove';

export interface DecisionWriteInput {
  operation: DecisionWriteOperation;
  /** The decision to add, replace or remove. */
  id: string;
  /** The category block the decision lives in. */
  category?: string;
  /** add only: put the decision in a category block the file does not have yet, creating it. */
  createCategory?: boolean;
  /** The text between the decision's braces. Required by add and replace, refused by remove. */
  body?: string;
}

export interface DecisionWritePlan {
  operation: DecisionWriteOperation;
  id: string;
  category: string;
  path: string;
  /** The source after the edit, decoded. */
  text: string;
  /** The file after the edit, in its own encoding. */
  bytes: Buffer;
  /** The one replacement that was made, in byte offsets of the source. */
  edit: SourceByteReplacement;
  /** A unified diff of the file, empty when nothing changed. */
  diff: string;
  /** The definitions of the file that the edit left untouched, byte for byte. */
  untouchedDefinitions: number;
}

const planSchema = z.object({
  operation: z.enum(['add', 'replace', 'remove']),
  id: z.string(),
  category: z.string(),
  path: z.string(),
  edit: replacementSchema,
  untouchedDefinitions: z.number().int().nonnegative(),
});

async function plan(
  path: string,
  input: DecisionWriteInput,
  source: Uint8Array | undefined,
): Promise<DecisionWritePlan> {
  const answer = await callWritePlan({
    op: 'decision_write.plan',
    path,
    input: { ...input },
    ...(source === undefined ? {} : { source }),
    result: planSchema,
  });
  return { ...answer.result, text: answer.text, bytes: answer.bytes, diff: answer.diff };
}

/** The plan that creates a new file holding one new decision, for `createFile: true`. */
export function planNewDecisionFile(
  path: string,
  input: DecisionWriteInput,
): Promise<DecisionWritePlan> {
  return plan(path, input, undefined);
}

export function planDecisionWrite(
  source: { bytes: Uint8Array; path: string },
  input: DecisionWriteInput,
): Promise<DecisionWritePlan> {
  return plan(source.path, input, source.bytes);
}

/** The category blocks of a `common/decisions` file, or none when the file cannot be parsed. */
export async function decisionCategories(source: {
  bytes: Uint8Array;
  path: string;
}): Promise<string[]> {
  const answer = await callSourceQuery(
    'decision_write.categories',
    source.path,
    source.bytes,
    z.object({ categories: z.array(z.string()) }),
  );
  return answer.categories;
}
