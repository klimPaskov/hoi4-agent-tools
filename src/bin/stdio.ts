#!/usr/bin/env node
import { canonicalJson } from '../hoi4_agent_tools/core/canonical.js';
import {
  StdioFrameLimitError,
  StdioInvalidMessageError,
  StdioInvalidUtf8Error,
} from '../hoi4_agent_tools/mcp/transports/bounded-stdio.js';
import { serveNegotiatedStdio } from '../hoi4_agent_tools/mcp/transports/negotiated-stdio.js';
import { ServerRegistry } from '../hoi4_agent_tools/core/server-registry.js';
import { StdioLifetime } from '../hoi4_agent_tools/mcp/transports/stdio-lifetime.js';
import { createEngine } from '../hoi4_agent_tools/runtime.js';

/**
 * A client registration can set its own idle limit, because the server configuration is shared
 * by every client: clients that keep idle per-subagent connections opt in without affecting a
 * long-lived interactive session.
 */
function idleExitMinutes(configured: number): number {
  const override = process.env.HOI4_AGENT_STDIO_IDLE_EXIT_MINUTES;
  if (override === undefined || override.trim() === '') return configured;
  const minutes = Number(override);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 10_080)
    throw new Error('HOI4_AGENT_STDIO_IDLE_EXIT_MINUTES must be a whole number from 0 to 10080');
  return minutes;
}

async function main(): Promise<void> {
  const engine = await createEngine();
  const chaosxTools =
    process.env.HOI4_AGENT_TOOLS_CHAOSX === '1'
      ? await import('../hoi4_agent_tools/mcp/tools/chaosx.js')
      : undefined;
  const onerror = (error: Error): void => {
    const fatalInputError =
      error instanceof StdioFrameLimitError || error instanceof StdioInvalidUtf8Error;
    const rejectedMessage = error instanceof StdioInvalidMessageError;
    if (fatalInputError) process.exitCode = 1;
    process.stderr.write(
      `${canonicalJson({
        level: 'error',
        event: 'transport_error',
        code: fatalInputError || rejectedMessage ? error.code : 'STDIO_PROTOCOL_ERROR',
        message: error.message,
      })}\n`,
    );
  };
  let closeTransport = (): Promise<void> => Promise.resolve();
  const lifetime = new StdioLifetime({
    idleExitMinutes: idleExitMinutes(engine.resolver.config().stdioIdleExitMinutes),
    onExit: (reason) => {
      process.stderr.write(`${canonicalJson({ level: 'info', event: 'stdio_exit', reason })}\n`);
      void closeTransport().finally(() => setTimeout(() => process.exit(0), 250).unref());
    },
  });
  const transport = await serveNegotiatedStdio(engine, {
    onerror,
    observer: lifetime,
    onFailure: (error) => {
      process.exitCode = 1;
      process.stderr.write(
        `${canonicalJson({
          level: 'error',
          event: 'transport_startup_failed',
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
    },
    ...(chaosxTools === undefined
      ? {}
      : {
          createModernPrivateTools: chaosxTools.createChaosxToolOperations,
          registerLegacy: (server: Parameters<typeof chaosxTools.registerChaosxTools>[0]) =>
            chaosxTools.registerChaosxTools(server, engine, {}),
        }),
  });
  closeTransport = () => transport.close();
  lifetime.start();
  new ServerRegistry(engine.resolver, 'stdio', () => lifetime.lastActivity()).start();
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
