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
        'Use read-only scan/lint/render tools first. Source writes require a completed dry run, explicit transaction ID, exact expected plan hash, and a separate transaction_apply call. Generated GUI renders are offline representations, never game screenshots.',
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
