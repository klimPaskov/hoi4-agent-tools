#!/usr/bin/env node
import { canonicalJson } from '../hoi4_agent_tools/core/canonical.js';
import {
  StdioFrameLimitError,
  StdioInvalidMessageError,
  StdioInvalidUtf8Error,
} from '../hoi4_agent_tools/mcp/transports/bounded-stdio.js';
import { serveNegotiatedStdio } from '../hoi4_agent_tools/mcp/transports/negotiated-stdio.js';
import { createEngine } from '../hoi4_agent_tools/runtime.js';

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
  await serveNegotiatedStdio(engine, {
    onerror,
    onFailure: (error) => {
      process.exitCode = 1;
      process.stderr.write(
        `${canonicalJson({
          level: 'error',
          event: 'transport_startup_failed',
          message: error instanceof Error ? error.message : String(error),
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
