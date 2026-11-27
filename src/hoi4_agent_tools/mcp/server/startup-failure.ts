import type { CoreEngine } from '../../core/engine.js';
import { DOMAIN_TOOL_NAMES } from '../../core/domain-tools.js';
import { isJobControlTool } from '../../core/job-controls.js';
import { errorResult } from '../../core/operation-result.js';

const domainTools: ReadonlySet<string> = new Set(DOMAIN_TOOL_NAMES);

/**
 * The answer to a call that needs a workspace when the server could not load its workspaces: the
 * error that stopped the startup, in the ordinary tool-error envelope with its code. The stdio
 * server keeps running after such an error (it answered the handshake before loading), and the
 * client library would otherwise reduce the thrown error to its message. Tools that need no
 * workspace, and every call on a server that started, get `undefined` and run as usual.
 */
export function startupFailureResult(
  engine: CoreEngine,
  toolName: string,
): ReturnType<typeof errorResult> | undefined {
  const failure = engine.resolver.startupError();
  if (failure === undefined) return undefined;
  if (!domainTools.has(toolName) && !isJobControlTool(toolName)) return undefined;
  return errorResult(failure);
}
