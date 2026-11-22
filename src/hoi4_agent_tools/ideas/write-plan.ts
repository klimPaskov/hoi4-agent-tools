import { z } from 'zod/v4';
import {
  callSourceQuery,
  callWritePlan,
  replacementSchema,
  type SourceByteReplacement,
} from '../script-write/engine-plan.js';

/**
 * The edit behind `hoi4.idea_write` (issue 158): add, replace or remove one idea definition of a
 * `common/ideas/*.txt` file and nothing else. The engine plans it (`hoi4-script-write`, ADR 0089):
 * every byte outside the touched block, its comments, its neighbours, the newline style and the
 * encoding come back as they were read, and a layout the edit cannot place safely is refused with
 * the reason, not guessed.
 */

export type IdeaWriteOperation = 'add' | 'replace' | 'remove';

export interface IdeaWriteInput {
  operation: IdeaWriteOperation;
  /** The idea to add, replace or remove. */
  id: string;
  /** The category block the idea lives in (`country`, `hidden_ideas`, an advisor slot). */
  category?: string;
  /** add only: put the idea in a category the file does not have yet, creating it. */
  createCategory?: boolean;
  /** The text between the idea's braces. Required by add and replace, refused by remove. */
  body?: string;
}

export interface IdeaWritePlan {
  operation: IdeaWriteOperation;
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
  input: IdeaWriteInput,
  source: Uint8Array | undefined,
): Promise<IdeaWritePlan> {
  const answer = await callWritePlan({
    op: 'idea_write.plan',
    path,
    input: { ...input },
    ...(source === undefined ? {} : { source }),
    result: planSchema,
  });
  return { ...answer.result, text: answer.text, bytes: answer.bytes, diff: answer.diff };
}

/**
 * The plan that creates a new `common/ideas` file holding one new idea in one category, for
 * `createFile: true`. The file is UTF-8 without a byte order mark and uses tabs and LF, as the
 * game's own ideas files do.
 */
export function planNewIdeaFile(path: string, input: IdeaWriteInput): Promise<IdeaWritePlan> {
  return plan(path, input, undefined);
}

export function planIdeaWrite(
  source: { bytes: Uint8Array; path: string },
  input: IdeaWriteInput,
): Promise<IdeaWritePlan> {
  return plan(source.path, input, source.bytes);
}

/** The category blocks of a `common/ideas` file, or none when the file cannot be parsed. */
export async function ideaCategories(source: {
  bytes: Uint8Array;
  path: string;
}): Promise<string[]> {
  const answer = await callSourceQuery(
    'idea_write.categories',
    source.path,
    source.bytes,
    z.object({ categories: z.array(z.string()) }),
  );
  return answer.categories;
}
