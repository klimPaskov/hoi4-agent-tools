import { GetPromptResultSchema } from '@modelcontextprotocol/core';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { ModernTaskRoutingServer } from '../transports/modern-task-routing.js';
import {
  probabilityPrompt,
  probabilityPromptArguments,
  probabilityPromptDefinition,
} from './probability.js';

export function registerModernPrompts(server: ModernTaskRoutingServer): void {
  server.setRequestHandler('prompts/list', () => ({
    prompts: [
      {
        ...probabilityPromptDefinition,
        arguments: Object.entries(probabilityPromptArguments.shape).map(([name, schema]) => ({
          name,
          required: !schema.safeParse(undefined).success,
        })),
      },
    ],
  }));
  server.setRequestHandler('prompts/get', (request) => {
    if (request.params.name !== probabilityPromptDefinition.name)
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown prompt');
    const parsed = probabilityPromptArguments.safeParse(request.params.arguments ?? {});
    if (!parsed.success)
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid prompt arguments');
    return GetPromptResultSchema.parse({
      ...probabilityPrompt(parsed.data),
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private',
    });
  });
}
