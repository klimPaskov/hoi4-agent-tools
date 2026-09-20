import { z } from 'zod/v4';
import { serverConfigurationSchema } from './configuration.js';
import { CoreEngine } from './engine.js';
import { JobExecutor, JobOperations } from './job-executor.js';
import { JobService } from './job-service.js';
import { WorkspaceResolver } from './workspace.js';
import { registerEventJobs } from '../event/job-operations.js';
import { registerFocusJobs } from '../focus/job-operations.js';
import { registerGuiJobs } from '../gui/job-operations.js';
import { registerMapJobs } from '../map/job-operations.js';
import { registerProbabilityJobs } from '../probability/job-operations.js';
import { registerTechnologyJobs } from '../technology/job-operations.js';
import { registerAnalysisJobs } from './analysis-job-operations.js';

// Fixed internal process entry point. It accepts only a trusted host's structured IPC
// message, never a script path, module name, callback, command, or transport request.
const inputSchema = z
  .object({
    configuration: serverConfigurationSchema,
    workspaceId: z.string().min(1),
    jobId: z.string().regex(/^job_[a-f0-9]{64}$/u),
    principal: z.string().min(1).optional(),
  })
  .strict();
if (process.send === undefined) throw new Error('Job workers require their internal IPC host');
let started = false;
const startup = setTimeout(() => {
  if (!started) process.exit(1);
}, 30_000);
startup.unref();
process.once('disconnect', () => {
  if (!started) process.exit(0);
});
process.once('message', (value: unknown) => {
  started = true;
  clearTimeout(startup);
  void (async () => {
    const input = inputSchema.parse(value);
    const resolver = await WorkspaceResolver.create(input.configuration);
    const engine = new CoreEngine(resolver);
    // Recovery is targeted by the job executor. Do not sweep or interfere with
    // unrelated live rewrite journals when a worker starts.
    const jobs = await JobService.create(resolver);
    const operations = new JobOperations();
    registerEventJobs(operations, engine);
    registerAnalysisJobs(operations, engine);
    registerTechnologyJobs(operations, engine);
    registerProbabilityJobs(operations, engine);
    registerMapJobs(operations, engine);
    registerGuiJobs(operations, engine);
    registerFocusJobs(operations, engine);
    await new JobExecutor(engine, jobs, operations).run(
      input.workspaceId,
      input.jobId,
      input.principal,
    );
  })()
    .catch(() => {
      process.exitCode = 1;
    })
    .finally(() => {
      if (process.connected) process.disconnect();
    });
});
process.send({ type: 'ready' });
