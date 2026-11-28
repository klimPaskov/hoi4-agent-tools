import { z } from 'zod/v4';
import { callWritePlan, replacementSchema } from '../script-write/engine-plan.js';
import type { SourceByteReplacement } from '../script-write/engine-plan.js';

/**
 * The edit behind `hoi4.common_write` (packet T3, D-152): add, replace or remove one definition of a
 * `common/<folder>/*.txt` file for any kind the engine has a descriptor for. The engine plans it
 * (`common.block_write`, `hoi4-script-write`): every byte outside the touched block, its comments, its
 * neighbours, the newline style and the encoding come back as they were read, and a layout the edit
 * cannot place safely is refused with the reason, not guessed. The engine holds no game data, so the
 * strategy-token and on_action name lists come in with the request.
 */

export type CommonWriteKind = 'bop' | 'ai_strategy' | 'ai_strategy_plan' | 'on_action';
export type CommonWriteOperation = 'add' | 'replace' | 'remove';

export interface CommonWritePlanInput {
  kind: CommonWriteKind;
  operation: CommonWriteOperation;
  id: string;
  body?: string;
  blockIndex?: number;
  /** The strategy tokens the game documents. */
  knownTokens?: readonly string[];
  /** The on_action names the game documents. */
  knownNames?: readonly string[];
}

export interface CommonWriteFinding {
  severity: 'warning';
  code: string;
  message: string;
}

export interface CommonWriteReferences {
  localisation: string[];
  sprites: string[];
  categories: string[];
  focuses: string[];
}

export interface CommonWritePlan {
  operation: CommonWriteOperation;
  kind: CommonWriteKind;
  id: string;
  path: string;
  /** The source after the edit, decoded. */
  text: string;
  /** The file after the edit, in its own encoding. */
  bytes: Buffer;
  /** The one replacement that was made, in byte offsets of the decoded text. */
  edit: SourceByteReplacement;
  diff: string;
  /** The definitions of the file that the edit left untouched, byte for byte. */
  untouchedDefinitions: number;
  findings: CommonWriteFinding[];
  references: CommonWriteReferences;
}

const planSchema = z.object({
  operation: z.enum(['add', 'replace', 'remove']),
  kind: z.enum(['bop', 'ai_strategy', 'ai_strategy_plan', 'on_action']),
  id: z.string(),
  path: z.string(),
  edit: replacementSchema,
  untouchedDefinitions: z.number().int().nonnegative(),
  findings: z.array(
    z.object({ severity: z.enum(['warning']), code: z.string(), message: z.string() }),
  ),
  references: z.object({
    localisation: z.array(z.string()),
    sprites: z.array(z.string()),
    categories: z.array(z.string()),
    focuses: z.array(z.string()),
  }),
});

async function plan(
  path: string,
  input: CommonWritePlanInput,
  source: Uint8Array | undefined,
): Promise<CommonWritePlan> {
  const answer = await callWritePlan({
    op: 'common.block_write.plan',
    path,
    input: { ...input },
    ...(source === undefined ? {} : { source }),
    result: planSchema,
  });
  return { ...answer.result, text: answer.text, bytes: answer.bytes, diff: answer.diff };
}

/** The plan that creates a new file holding one new definition, for `createFile: true`. */
export function planNewCommonFile(
  path: string,
  input: CommonWritePlanInput,
): Promise<CommonWritePlan> {
  return plan(path, input, undefined);
}

export function planCommonWrite(
  source: { bytes: Uint8Array; path: string },
  input: CommonWritePlanInput,
): Promise<CommonWritePlan> {
  return plan(source.path, input, source.bytes);
}
