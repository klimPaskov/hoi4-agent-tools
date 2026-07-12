import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CoreEngine } from '../../core/engine.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../../version.js';
import type { ServerContext } from './base-tools.js';
import { registerModsTool } from '../tools/mods.js';
import { registerFocusTools } from '../tools/focus.js';
import { registerGuiTools } from '../tools/gui.js';
import { registerMapTools } from '../tools/map.js';
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
    },
  );
  registerModsTool(server, engine, context);
  registerFocusTools(server, engine, context);
  registerGuiTools(server, engine, context);
  registerMapTools(server, engine, context);
  registerMcpResources(server, engine, context);
  return server;
}
