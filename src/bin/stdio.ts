#!/usr/bin/env node
import { canonicalJson } from '../hoi4_agent_tools/core/canonical.js';
import { createMcpServer } from '../hoi4_agent_tools/mcp/server/create.js';
import {
  BoundedStdioServerTransport,
  StdioFrameLimitError,
  StdioInvalidMessageError,
  StdioInvalidUtf8Error,
} from '../hoi4_agent_tools/mcp/transports/bounded-stdio.js';
import { FinalProtocolTransport } from '../hoi4_agent_tools/mcp/transports/protocol-gate.js';
import { createEngine } from '../hoi4_agent_tools/runtime.js';

async function main(): Promise<void> {
  const engine = await createEngine();
  const server = createMcpServer(engine);
  server.server.onerror = (error): void => {
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
  const transport = new BoundedStdioServerTransport();
  await server.connect(new FinalProtocolTransport(transport));
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
