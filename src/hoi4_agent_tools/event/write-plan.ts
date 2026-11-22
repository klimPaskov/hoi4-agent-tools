import { z } from 'zod/v4';
import {
  callSourceQuery,
  callWritePlan,
  replacementSchema,
  type SourceByteReplacement,
} from '../script-write/engine-plan.js';

/**
 * The edit behind `hoi4.event_write` (issue 159): add, replace or remove one event block of an
 * `events/*.txt` file and nothing else. The engine plans it (`hoi4-script-write`, ADR 0089): every
 * byte outside the touched block, the other events, unrelated top-level entries, comments, the
 * newline style and the encoding come back as they were read, and a layout the edit cannot place
 * safely is refused with the reason, not guessed.
 */

export const EVENT_KINDS = [
  'country_event',
  'news_event',
  'state_event',
  'unit_leader_event',
  'operative_leader_event',
] as const;
export type EventWriteKind = (typeof EVENT_KINDS)[number];
export type EventWriteOperation = 'add' | 'replace' | 'remove';

export interface EventWriteInput {
  operation: EventWriteOperation;
  /** The event id, `namespace.number`. */
  id: string;
  /** add only: the event block kind. replace and remove keep the kind the event has. */
  kind?: EventWriteKind;
  /** The text between the event braces. Required by add and replace, refused by remove. */
  body?: string;
  /** add only: write `add_namespace` for the id's namespace when no mod file declares it. */
  createNamespace?: boolean;
  /** Whether a mod file already declares the id's namespace. The caller reads this across the mod. */
  namespaceDeclared?: boolean;
}

export interface EventWritePlan {
  operation: EventWriteOperation;
  id: string;
  kind: EventWriteKind;
  path: string;
  /** The source after the edit, decoded. */
  text: string;
  /** The file after the edit, in its own encoding. */
  bytes: Buffer;
  /** The replacements that were made, the event first, in byte offsets of the decoded text. */
  edits: SourceByteReplacement[];
  /** A unified diff of the file, empty when nothing changed. */
  diff: string;
  /** The other events of the file that the edit left untouched, byte for byte. */
  untouchedDefinitions: number;
  /** Whether the edit also wrote an `add_namespace` line. */
  namespaceAdded: boolean;
}

export const EVENT_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*\.[0-9]+$/u;

export function namespaceOf(id: string): string {
  return id.slice(0, id.indexOf('.'));
}

const planSchema = z.object({
  operation: z.enum(['add', 'replace', 'remove']),
  id: z.string(),
  kind: z.enum(EVENT_KINDS),
  path: z.string(),
  edits: z.array(replacementSchema),
  untouchedDefinitions: z.number().int().nonnegative(),
  namespaceAdded: z.boolean(),
});

async function plan(
  path: string,
  input: EventWriteInput,
  source: Uint8Array | undefined,
): Promise<EventWritePlan> {
  const answer = await callWritePlan({
    op: 'event_write.plan',
    path,
    input: { ...input },
    ...(source === undefined ? {} : { source }),
    result: planSchema,
  });
  return { ...answer.result, text: answer.text, bytes: answer.bytes, diff: answer.diff };
}

/**
 * The plan that creates a new `events` file holding the namespace line and one new event, for
 * `createFile: true`. The file is UTF-8 without a byte order mark and uses tabs and LF, as the game's
 * own event files do.
 */
export function planNewEventFile(path: string, input: EventWriteInput): Promise<EventWritePlan> {
  return plan(path, input, undefined);
}

export function planEventWrite(
  source: { bytes: Uint8Array; path: string },
  input: EventWriteInput,
): Promise<EventWritePlan> {
  return plan(source.path, input, source.bytes);
}

/** The ids of the events in a source, and the namespaces it declares. */
export async function eventFileContents(source: {
  bytes: Uint8Array;
  path: string;
}): Promise<{ ids: string[]; namespaces: string[] }> {
  return callSourceQuery(
    'event_write.contents',
    source.path,
    source.bytes,
    z.object({ ids: z.array(z.string()), namespaces: z.array(z.string()) }),
  );
}
