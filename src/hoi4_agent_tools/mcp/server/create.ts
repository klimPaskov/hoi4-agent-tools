import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CoreEngine } from '../../core/engine.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../../version.js';
import type { ServerContext } from './base-tools.js';
import { registerFocusTools } from '../tools/focus.js';
import { registerGuiTools } from '../tools/gui.js';
import { registerMapTools } from '../tools/map.js';
import { registerEventTools } from '../tools/event.js';
import { registerMcpResources } from '../resources/register.js';

export const SERVER_INSTRUCTIONS =
  'The workspace defaults to the mod containing the MCP working directory; pass workspaceId only when selecting another configured mod. Use hoi4.event_inspect for scan, roots, trace, explain_path, state_flow, lint, and impact; hoi4.event_render and hoi4.event_compare return linked evidence. JSON resources are authoritative. Event tools are read-only. Only focus, GUI, and map rewrite tools edit configured mods.';

export function createMcpServer(engine: CoreEngine, context: ServerContext = {}): McpServer {
  const server = new McpServer(
    {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      websiteUrl: 'https://github.com/klimPaskov/hoi4-agent-tools',
    },
    {
      capabilities: { logging: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  registerFocusTools(server, engine, context);
  registerGuiTools(server, engine, context);
  registerMapTools(server, engine, context);
  registerEventTools(server, engine, context);
  registerMcpResources(server, engine, context);
  return server;
}
