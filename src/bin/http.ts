#!/usr/bin/env node
import { canonicalJson } from '../hoi4_agent_tools/core/canonical.js';
import { ServerRegistry } from '../hoi4_agent_tools/core/server-registry.js';
import { createMcpServer } from '../hoi4_agent_tools/mcp/server/create.js';
import { startHttpServer } from '../hoi4_agent_tools/mcp/transports/http.js';
import { createEngine } from '../hoi4_agent_tools/runtime.js';

async function main(): Promise<void> {
  const engine = await createEngine();
  const handle = await startHttpServer(engine, engine.resolver.config(), createMcpServer);
  new ServerRegistry(engine.resolver, 'http').start();
  const shutdown = async (): Promise<void> => {
    await handle.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${canonicalJson({
      level: 'error',
      event: 'startup_failed',
      code:
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error),
      // Startup output goes to the operator's own log; the cause (such as the JSON parse
      // position in a configuration file) is what makes the failure fixable.
      ...(typeof error === 'object' &&
      error !== null &&
      'details' in error &&
      typeof error.details === 'object' &&
      error.details !== null &&
      Object.keys(error.details).length > 0
        ? { details: error.details }
        : {}),
    })}\n`,
  );
  process.exitCode = 1;
});
