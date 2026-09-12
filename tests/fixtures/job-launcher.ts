import { z } from 'zod/v4';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { JobWorkerHost } from '../../src/hoi4_agent_tools/core/job-worker-host.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

// Synthetic lifecycle-test launcher. The integration test owns this process and
// intentionally stops it after the real worker has obtained durable ownership.
const inputSchema = z
  .object({ configuration: serverConfigurationSchema, jobId: z.string(), workspaceId: z.string() })
  .strict();
process.once('message', (message: unknown) => {
  void (async () => {
    const input = inputSchema.parse(message);
    const engine = new CoreEngine(await WorkspaceResolver.create(input.configuration));
    const host = await JobWorkerHost.create(engine);
    await host.run(input.workspaceId, input.jobId);
  })()
    .catch(() => {
      process.exitCode = 1;
    })
    .finally(() => {
      if (process.connected) process.disconnect();
    });
});
