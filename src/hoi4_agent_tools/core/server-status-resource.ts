import { canonicalJson } from './canonical.js';
import type { CoreEngine } from './engine.js';
import { serverRegistry } from './server-registry.js';

/** A fixed, listed resource: every server process sharing this server state and its memory. */
export const serverStatusResource = {
  uri: 'hoi4-agent://server/status',
  name: 'server-status',
  title: 'HOI4 Agent Tools server status',
  description:
    'Live server processes sharing this server state, with memory, last client activity and execution limits.',
  mimeType: 'application/json',
} as const;

export async function readServerStatus(
  engine: CoreEngine,
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
  const status = await serverRegistry(engine.resolver).status();
  return {
    contents: [
      {
        uri: serverStatusResource.uri,
        mimeType: serverStatusResource.mimeType,
        text: `${canonicalJson(status)}\n`,
      },
    ],
  };
}
