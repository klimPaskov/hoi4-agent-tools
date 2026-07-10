#!/usr/bin/env node
import { canonicalJson } from '../hoi4_agent_tools/core/canonical.js';
import { createMcpServer } from '../hoi4_agent_tools/mcp/server/create.js';
import { startHttpServer } from '../hoi4_agent_tools/mcp/transports/http.js';
import { createEngine } from '../hoi4_agent_tools/runtime.js';

async function main(): Promise<void> {
  const engine = await createEngine();
  const handle = await startHttpServer(engine, engine.resolver.config(), createMcpServer);
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
    })}\n`,
  );
  process.exitCode = 1;
});
