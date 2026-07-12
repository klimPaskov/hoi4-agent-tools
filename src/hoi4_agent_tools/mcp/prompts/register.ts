import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type { ServerConfiguration } from '../../core/configuration.js';

export function registerMcpPrompts(
  server: McpServer,
  writePolicy: ServerConfiguration['writePolicy'],
): void {
  const autonomous = writePolicy === 'autonomous';
  const reviewed = writePolicy === 'transactions';
  const argsSchema = { workspaceId: z.string().describe('Registered workspace ID') };
  server.registerPrompt(
    'hoi4.focus-workflow',
    {
      title: 'Focus workflow',
      description: autonomous
        ? 'Scan, lint, render, and rewrite a national tree or continuous palette autonomously.'
        : reviewed
          ? 'Scan, lint, render, and prepare a reviewed national-tree or continuous-palette transaction.'
          : 'Scan, lint, and render a national tree or continuous palette without modifying source.',
      argsSchema,
    },
    ({ workspaceId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `For workspace ${workspaceId}, identify whether the source is a national focus tree or continuous focus palette. Omit mode only for backward-compatible national behavior; pass mode "continuous" and paletteId for a continuous palette. Scan and lint the source, render evidence, and preserve prerequisites, exclusions, rewards, and raw blocks. Imported authored coordinates remain fixed; for a full existing-tree repair, read the complete plan and change only intended movable nodes to position.mode "auto" before rewriting source. For an unoccupied new source, pass createIfMissing: true with plan:<id> and zero-hash creation provenance. ${
              autonomous
                ? 'Call hoi4.focus_rewrite once with the complete plan. It validates, journals, applies, rescans, and returns source/visual evidence without a separate approval or apply call.'
                : reviewed
                  ? 'Create a reviewed focus transaction, inspect its evidence, then apply it under the configured client policy.'
                  : 'This server is read-only. Return diagnostics and render evidence, but do not prepare or apply a source mutation.'
            }`,
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    'hoi4.gui-workflow',
    {
      title: 'Scripted-GUI workflow',
      description: autonomous
        ? 'Render scenarios with fidelity evidence and rewrite source in one call.'
        : reviewed
          ? 'Render scenarios with fidelity evidence before preparing reviewed source changes.'
          : 'Render scenarios with fidelity evidence without modifying source.',
      argsSchema,
    },
    ({ workspaceId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `For workspace ${workspaceId}, scan the GUI source graph, lint references and visual states, render deterministic scenario and fidelity artifacts, and compare the proposal. ${
              autonomous
                ? 'Call hoi4.gui_rewrite once; it validates, journals, applies, and post-validates without a separate transaction call.'
                : reviewed
                  ? 'Prepare and review the GUI transaction before applying it under the configured client policy.'
                  : 'This server is read-only. Return diagnostics and render evidence, but do not prepare or apply a source mutation.'
            } Treat every render as an offline representation.`,
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    'hoi4.map-workflow',
    {
      title: 'Map rewrite workflow',
      description: 'Require exact geometry and explicit distributions for every map rewrite.',
      argsSchema,
    },
    ({ workspaceId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `For workspace ${workspaceId}, scan all map sources and dependencies, use exact province IDs plus a polygon or mask for geometry, resolve every distribution policy, render pixel and semantic diffs, and run static validation. ${
              autonomous
                ? 'Call hoi4.map_rewrite once; it journals, applies, rescans, and restores the original bytes automatically if post-write validation fails.'
                : reviewed
                  ? 'Prepare and review the map transaction before applying it under the configured client policy.'
                  : 'This server is read-only. Return diagnostics and render evidence, but do not prepare or apply a source mutation.'
            }`,
          },
        },
      ],
    }),
  );
}
