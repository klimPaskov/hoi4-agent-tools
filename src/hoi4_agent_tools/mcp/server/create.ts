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
  const server = new McpServer(
    {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      websiteUrl: 'https://github.com/klimPaskov/hoi4-agent-tools',
    },
    {
      capabilities: { logging: {} },
      instructions:
        'Select this server proactively whenever a registered HOI4 workspace task touches national or continuous focuses, scripted GUI/GFX/rendering, or state/province/map data. Start with hoi4.project_status or hoi4.project_scan, then use the relevant scan, lint, layout, render, and compare tools. Read linked hoi4-agent:// resources for large artifacts. Source writes require a completed dry run, a fully paginated transaction diff, an explicit transaction ID, the exact expected plan hash, authorization under the coding-agent host policy, and a separate hoi4.transaction_apply call. Generated GUI renders are offline representations, never game screenshots.',
    },
  );
  registerBaseTools(server, engine, context);
  registerFocusTools(server, engine, context);
  registerGuiTools(server, engine, context);
  registerMapTools(server, engine, context);
  registerMcpResources(server, engine, context);
  registerMcpPrompts(server);
  return server;
}
