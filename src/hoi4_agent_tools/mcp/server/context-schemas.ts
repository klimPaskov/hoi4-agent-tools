import { z } from 'zod/v4';

/**
 * Keep a large nested payload schema out of tools/list while retaining its complete runtime parser.
 * The MCP SDK publishes the input side of a pipe and executes both sides when a tool is called.
 */
export function compactValidatedInputSchema<T extends z.ZodType>(
  schema: T,
  description: string,
): z.ZodPipe<z.ZodUnknown, T> {
  return z.unknown().describe(description).pipe(schema);
}
