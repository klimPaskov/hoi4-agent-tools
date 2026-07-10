import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';

export function registerMcpPrompts(server: McpServer): void {
  const argsSchema = { workspaceId: z.string().describe('Registered workspace ID') };
  server.registerPrompt(
    'hoi4.safe-focus-workflow',
    {
      title: 'Safe focus workflow',
      description:
        'Scan, lint, render, review a national-tree or continuous-palette dry run, then explicitly apply.',
      argsSchema,
    },
    ({ workspaceId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `For workspace ${workspaceId}, identify whether the requested source is a national focus tree or continuous focus palette. Omit mode only for backward-compatible national behavior; pass mode "continuous" and paletteId for a continuous palette. Scan and lint the source, render review artifacts, plan source changes in the matching mode, follow every transaction_diff nextCursor until the complete diff has been reviewed, inspect the source map, bitmap comparison, and blockers, and ask for approval before calling transaction_apply with the exact plan hash.`,
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    'hoi4.safe-gui-workflow',
    {
      title: 'Safe scripted-GUI workflow',
      description: 'Render scenarios with fidelity evidence before planning source changes.',
      argsSchema,
    },
    ({ workspaceId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `For workspace ${workspaceId}, scan the GUI source graph, lint references and visual states, render deterministic scenario and fidelity artifacts, compare the proposal, follow every transaction_diff nextCursor until the complete diff and blockers have been reviewed, and ask for approval before calling transaction_apply with the exact plan hash. Treat every render as an offline representation.`,
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    'hoi4.safe-map-workflow',
    {
      title: 'Safe map transaction workflow',
      description: 'Require exact geometry and explicit distributions before a map apply.',
      argsSchema,
    },
    ({ workspaceId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `For workspace ${workspaceId}, scan all map sources and dependencies, use exact province IDs plus a polygon or mask for geometry, resolve every distribution policy, render pixel and semantic diffs, run static validation, follow every transaction_diff nextCursor until the complete diff and blockers have been reviewed, and ask for approval before applying the exact hash-bound transaction.`,
          },
        },
      ],
    }),
  );
}
