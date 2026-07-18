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
  'Use hoi4.focus_inspect and hoi4.focus_render for fast structural work; hoi4.focus_raster adds decoded icons and PNG output. Use hoi4.event_inspect to analyze event chains. Event tools are read-only. Focus, GUI, and map rewrite tools edit the current mod. Large evidence is returned through linked resources.';

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
