import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CoreEngine } from '../../core/engine.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../../version.js';
import type { ServerContext } from './base-tools.js';
import { registerFocusTools } from '../tools/focus.js';
import { registerGuiTools } from '../tools/gui.js';
import { registerMapTools } from '../tools/map.js';
import { registerEventTools } from '../tools/event.js';
import { registerTechnologyTools } from '../tools/technology.js';
import { registerMcpResources } from '../resources/register.js';

export const SERVER_INSTRUCTIONS =
  'Use focus tools for focus trees, GUI tools for interfaces, and map tools for map data. Use hoi4.event_inspect, hoi4.event_render, and hoi4.event_compare for event chains. Use hoi4.tech_inspect, hoi4.tech_render, and hoi4.tech_compare for technology and doctrines. Event tools are read-only. Technology tools are read-only. Large evidence is linked as resources.';

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
  registerTechnologyTools(server, engine, context);
  registerMcpResources(server, engine, context);
  return server;
}
