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
            text: `For workspace ${workspaceId}, identify whether the source is a national focus tree or continuous focus palette. Omit mode only for backward-compatible national behavior; pass mode "continuous" and paletteId for a continuous palette. Scan and lint the source, render review artifacts, and preserve prerequisites, exclusions, rewards, and raw blocks. Imported authored coordinates remain fixed; for a full existing-tree repair, read the complete plan and change only intended movable nodes to position.mode "auto" before planning source changes. For an unoccupied new source, pass createIfMissing: true with plan:<id> and zero-hash creation provenance. Follow every transaction_diff nextCursor until the complete diff has been reviewed, and inspect the source map, bitmap comparison, and blockers. Call transaction_apply with the exact plan hash only when the coding-agent host's configured write and approval policy authorizes it.`,
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
            text: `For workspace ${workspaceId}, scan the GUI source graph, lint references and visual states, render deterministic scenario and fidelity artifacts, compare the proposal, and follow every transaction_diff nextCursor until the complete diff and blockers have been reviewed. Call transaction_apply with the exact plan hash only when the coding-agent host's configured write and approval policy authorizes it. Treat every render as an offline representation.`,
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
            text: `For workspace ${workspaceId}, scan all map sources and dependencies, use exact province IDs plus a polygon or mask for geometry, resolve every distribution policy, render pixel and semantic diffs, run static validation, and follow every transaction_diff nextCursor until the complete diff and blockers have been reviewed. Apply the exact hash-bound transaction only when the coding-agent host's configured write and approval policy authorizes it.`,
          },
        },
      ],
    }),
  );
}
