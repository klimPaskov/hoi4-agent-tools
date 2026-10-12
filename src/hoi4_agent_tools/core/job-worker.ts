import { setFlagsFromString, getHeapStatistics } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { z } from 'zod/v4';
import { hashCanonical } from './canonical.js';
import { serverConfigurationSchema, type ServerConfiguration } from './configuration.js';
import { CoreEngine } from './engine.js';
import { JobExecutor, type JobOperations } from './job-executor.js';
import { JobService } from './job-service.js';
import { WorkspaceResolver } from './workspace.js';
import { registerWorkerOperations, workerDomain } from './job-operation-registration.js';
import { workerErrorMarker } from './worker-exit.js';

// Fixed internal process entry point. It accepts only a trusted host's structured IPC
// message, never a script path, module name, callback, command, or transport request.
//
// A worker runs one job at a time. After a job it stays warm for jobWorkerIdleSeconds while
// its host keeps the IPC channel open, so the host's next job reuses the loaded indexes
// instead of scanning cold. It exits when the idle time ends or the host disconnects. A worker
// whose heap stays large after a job is not kept warm: several heavy jobs in a row would
// otherwise exhaust the heap limit in the middle of the next one.
const inputSchema = z
  .object({
    configuration: serverConfigurationSchema,
    workspaceId: z.string().min(1),
    jobId: z.string().regex(/^job_[a-f0-9]{64}$/u),
    principal: z.string().min(1).optional(),
  })
  .strict();
if (process.send === undefined) throw new Error('Job workers require their internal IPC host');

interface WarmState {
  configurationHash: string;
  resolver: WorkspaceResolver;
  engine: CoreEngine;
  jobs: JobService;
  operations: Map<string, JobOperations>;
}

let warm: WarmState | undefined;
let busy = false;
let started = false;
let idleTimer: NodeJS.Timeout | undefined;

/** Share of the heap limit a worker may still hold after a job and a full collection. */
const WARM_HEAP_SHARE = 0.4;
/** Absolute ceiling on that retained heap, so a large heap limit does not keep gigabytes idle. */
const WARM_HEAP_MAXIMUM_BYTES = 1_536 * 1024 * 1024;

/** Whether the heap, after a full collection, is small enough to serve another job. */
function heapAllowsReuse(): boolean {
  const limit = Math.min(
    getHeapStatistics().heap_size_limit * WARM_HEAP_SHARE,
    WARM_HEAP_MAXIMUM_BYTES,
  );
  if (getHeapStatistics().used_heap_size <= limit) return true;
  try {
    setFlagsFromString('--expose-gc');
    (runInNewContext('gc') as () => void)();
  } catch {
    // Without a collection the figure above stands: recycle rather than risk the next job.
    return false;
  }
  return getHeapStatistics().used_heap_size <= limit;
}

const startup = setTimeout(() => {
  if (!started) process.exit(1);
}, 30_000);
startup.unref();

function finish(): void {
  if (process.connected) process.disconnect();
  process.exit(process.exitCode ?? 0);
}

process.on('disconnect', () => {
  // A host that leaves while a job runs does not cancel it; the job finishes and the worker
  // exits afterwards. An idle worker has nothing left to do.
  if (!busy) finish();
});

async function warmState(configuration: ServerConfiguration): Promise<WarmState> {
  const configurationHash = hashCanonical(configuration);
  if (warm?.configurationHash === configurationHash) return warm;
  const resolver = await WorkspaceResolver.create(configuration);
  const engine = new CoreEngine(resolver);
  // Recovery is targeted by the job executor. Do not sweep or interfere with
  // unrelated live rewrite journals when a worker starts.
  const jobs = await JobService.create(resolver);
  warm = { configurationHash, resolver, engine, jobs, operations: new Map() };
  return warm;
}

async function runJob(value: unknown): Promise<void> {
  const input = inputSchema.parse(value);
  // The send callback confirms enqueueing, not receipt. Acknowledge before the host
  // continues; losing that channel after receipt never cancels durable execution.
  if (process.connected) process.send?.({ type: 'accepted' }, () => undefined);
  const state = await warmState(input.configuration);
  const record = await state.jobs.get(input.workspaceId, input.jobId, input.principal);
  // The host enforces the deadline while it lives; the executor also stops a read-only job
  // at its deadline and records why, so an orphaned worker never runs indefinitely.
  const deadlineMs = Date.now() + state.resolver.config().jobDeadlineSeconds * 1000;
  const domain = workerDomain(record.request.toolName);
  let operations = state.operations.get(domain);
  if (operations === undefined) {
    operations = await registerWorkerOperations(state.engine, record.request.toolName);
    state.operations.set(domain, operations);
  } else operations.get(record.request.toolName);
  await new JobExecutor(state.engine, state.jobs, operations).run(
    input.workspaceId,
    input.jobId,
    input.principal,
    { deadlineMs },
  );
}

process.on('message', (value: unknown) => {
  if (busy) return;
  started = true;
  busy = true;
  clearTimeout(startup);
  if (idleTimer !== undefined) clearTimeout(idleTimer);
  void runJob(value)
    .catch((error: unknown) => {
      // The host reads this line back to tell an uncaught job error from a memory failure.
      process.stderr.write(workerErrorMarker(error));
      process.exitCode = 1;
    })
    .finally(() => {
      busy = false;
      const idleSeconds = warm?.resolver.config().jobWorkerIdleSeconds ?? 0;
      // A failed job leaves state of unknown health; start the next job in a fresh worker.
      if (!process.connected || idleSeconds === 0 || process.exitCode === 1 || !heapAllowsReuse()) {
        finish();
        return;
      }
      process.send?.({ type: 'idle' }, () => undefined);
      idleTimer = setTimeout(finish, idleSeconds * 1000);
      idleTimer.unref();
    });
});
process.send({ type: 'ready' });
