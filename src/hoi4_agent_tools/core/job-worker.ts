import { z } from 'zod/v4';
import { serverConfigurationSchema } from './configuration.js';
import { CoreEngine } from './engine.js';
import { JobExecutor } from './job-executor.js';
import { JobService } from './job-service.js';
import { WorkspaceResolver } from './workspace.js';
import { registerWorkerOperations } from './job-operation-registration.js';

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
    // The send callback confirms enqueueing, not receipt. Acknowledge before the host
    // disconnects; losing that channel after receipt never cancels durable execution.
    if (process.connected) process.send?.({ type: 'accepted' }, () => undefined);
    const resolver = await WorkspaceResolver.create(input.configuration);
    const engine = new CoreEngine(resolver);
    // Recovery is targeted by the job executor. Do not sweep or interfere with
    // unrelated live rewrite journals when a worker starts.
    const jobs = await JobService.create(resolver);
    const record = await jobs.get(input.workspaceId, input.jobId, input.principal);
    if (!record.request.mutation) {
      // The host enforces the deadline while it lives; a worker whose host has gone stops
      // itself, so an orphaned read-only analysis never holds memory indefinitely.
      const { jobDeadlineSeconds } = resolver.config();
      setTimeout(() => {
        void jobs
          .failInterrupted(
            input.workspaceId,
            input.jobId,
            {
              code: 'JOB_DEADLINE_EXCEEDED',
              message: `The job ran longer than ${jobDeadlineSeconds} seconds and was stopped; narrow its selector or limits, or raise jobDeadlineSeconds`,
            },
            input.principal,
          )
          .catch(() => undefined)
          .finally(() => process.exit(1));
      }, jobDeadlineSeconds * 1000).unref();
    }
    const operations = await registerWorkerOperations(engine, record.request.toolName);
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
