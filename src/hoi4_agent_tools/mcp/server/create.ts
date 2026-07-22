import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CoreEngine } from '../../core/engine.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../../version.js';
import type { ServerContext } from './base-tools.js';
import { registerFocusTools } from '../tools/focus.js';
import { registerGuiTools } from '../tools/gui.js';
import { registerMapTools } from '../tools/map.js';
import { registerEventTools } from '../tools/event.js';
import { registerTechnologyTools } from '../tools/technology.js';
import { registerProbabilityTools } from '../tools/probability.js';
import { registerMcpResources } from '../resources/register.js';

export const SERVER_INSTRUCTIONS =
  'Use focus tools for focus trees, GUI tools for interfaces, and map tools for map data. Start unfamiliar event chains with hoi4.event_inspect. Event tools are read-only. Start technology and doctrine work with hoi4.tech_inspect. Technology tools are read-only. Start weighted AI, MTTH, random, and declared-pool analysis with hoi4.probability_inspect. Probability tools are read-only. Large evidence is linked as resources.';

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
  registerProbabilityTools(server, engine, context);
  registerMcpResources(server, engine, context);
  return server;
}
