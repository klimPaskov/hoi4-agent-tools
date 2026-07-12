import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CoreEngine } from '../../core/engine.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../../version.js';
import { registerBaseTools, type ServerContext } from './base-tools.js';
import { registerFocusTools } from '../tools/focus.js';
import { registerGuiTools } from '../tools/gui.js';
import { registerMapTools } from '../tools/map.js';
import { registerMcpPrompts } from '../prompts/register.js';
import { registerMcpResources } from '../resources/register.js';

export function createMcpServer(engine: CoreEngine, context: ServerContext = {}): McpServer {
  const writePolicy = engine.resolver.config().writePolicy;
  const autonomous = writePolicy === 'autonomous';
  const server = new McpServer(
    {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      websiteUrl: 'https://github.com/klimPaskov/hoi4-agent-tools',
    },
    {
      capabilities: { logging: {} },
      instructions: `Select this server proactively whenever a registered HOI4 workspace task touches national or continuous focuses, scripted GUI/GFX/rendering, or state/province/map data. Start with hoi4.project_status or hoi4.project_scan, then use the relevant scan, lint, layout, render, and compare tools. Read linked hoi4-agent:// resources for large artifacts. ${
        autonomous
          ? 'This server is operator-configured for autonomous writes: hoi4.focus_rewrite, hoi4.gui_rewrite, and hoi4.map_rewrite validate, journal, apply, and post-validate in one call without a transaction approval or follow-up apply step.'
          : writePolicy === 'transactions'
            ? 'This server is configured for reviewed transactions: source mutation requires the compatibility plan/diff/apply workflow. Configure writePolicy "autonomous" to expose one-call rewrite tools.'
            : 'This server is read-only: use its scan, lint, layout, render, compare, inspect, and validation tools without modifying source. Configure writePolicy "autonomous" to expose one-call rewrite tools.'
      } Generated GUI renders are offline representations, never game screenshots.`,
    },
  );
  registerBaseTools(server, engine, context);
  registerFocusTools(server, engine, context);
  registerGuiTools(server, engine, context);
  registerMapTools(server, engine, context);
  registerMcpResources(server, engine, context);
  registerMcpPrompts(server, writePolicy);
  return server;
}
