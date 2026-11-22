import { z } from 'zod/v4';
import {
  callWritePlan,
  replacementSchema,
  type SourceByteReplacement,
} from '../script-write/engine-plan.js';

/**
 * The edit behind `hoi4.character_write` (issue 158): add, replace or remove one character of a `common/characters/*.txt` file and
 * nothing else. The engine plans it (`hoi4-script-write`, ADR 0089): every byte outside the touched
 * block, its comments, its neighbours, the newline style and the encoding come back as they were
 * read, and a layout the edit cannot place safely is refused with the reason, not guessed.
 */

export type CharacterWriteOperation = 'add' | 'replace' | 'remove';

export interface CharacterWriteInput {
  operation: CharacterWriteOperation;
  /** The character to add, replace or remove. */
  id: string;
  /** The text between the character's braces. Required by add and replace, refused by remove. */
  body?: string;
}

export interface CharacterWritePlan {
  operation: CharacterWriteOperation;
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
  input: CharacterWriteInput,
  source: Uint8Array | undefined,
): Promise<CharacterWritePlan> {
  const answer = await callWritePlan({
    op: 'character_write.plan',
    path,
    input: { ...input },
    ...(source === undefined ? {} : { source }),
    result: planSchema,
  });
  return { ...answer.result, text: answer.text, bytes: answer.bytes, diff: answer.diff };
}

/** The plan that creates a new file holding one new character, for `createFile: true`. */
export function planNewCharacterFile(
  path: string,
  input: CharacterWriteInput,
): Promise<CharacterWritePlan> {
  return plan(path, input, undefined);
}

export function planCharacterWrite(
  source: { bytes: Uint8Array; path: string },
  input: CharacterWriteInput,
): Promise<CharacterWritePlan> {
  return plan(source.path, input, source.bytes);
}
