import type { z } from 'zod/v4';
import type { OperationTaskCall } from '../../core/operation-tasks.js';

/** Shared public tool metadata and schemas, independent of either MCP SDK generation. */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema?: z.ZodType;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

export interface TaskToolDefinition extends ToolDefinition {
  name: OperationTaskCall['name'];
  outputSchema: z.ZodType;
}
