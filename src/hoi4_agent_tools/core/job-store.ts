import { lstat, mkdir, open, opendir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod/v4';
import { canonicalJson, hashCanonical, secureId } from './canonical.js';
import { ServiceError } from './result.js';
import type { ServerState } from './server-state.js';
import { SharedRequestCapacity } from './shared-request-capacity.js';
import { containedGeneratedPath } from './workspace.js';
import { PACKAGE_VERSION } from '../version.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const jobId = z.string().regex(/^job_[a-f0-9]{64}$/u);
const scopeSchema = z
  .object({
    workspaceId: z.string().min(1),
    workspaceIdentity: digest,
    rootFingerprint: digest,
    principal: z.string().min(1).nullable(),
  })
  .strict();
const transactionBindingSchema = z
  .object({
    transactionId: z.string().regex(/^txn_[0-9a-f-]{36}$/u),
    planHash: digest,
  })
  .strict();
const statusSchema = z.enum([
  'queued',
  'running',
  'reconciling',
  'completed',
  'cancelled',
  'failed',
]);
const ownerSchema = z
  .object({
    token: z.string().regex(/^worker_[0-9a-f-]{36}$/u),
    pid: z.number().int().positive(),
    host: z.string().min(1),
    processStartedAt: z.iso.datetime(),
  })
  .strict();
const requestSchema = z
  .object({
    toolName: z.string().regex(/^(?:hoi4|chaosx)\.[a-z_]+$/u),
    arguments: z.record(z.string(), z.json()),
    mutation: z.boolean(),
    requestKey: z.string().min(1).max(256).optional(),
    protocolTask: z
      .object({
        ttl: z.number().int().positive().nullable(),
        pollInterval: z.number().int().min(50).max(60_000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => !value.mutation || value.requestKey !== undefined, {
    message: 'Background rewrites require a reusable request key',
  });
const recordBaseSchema = z
  .object({
    version: z.literal(1),
    id: jobId,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    scope: scopeSchema,
    request: requestSchema,
    requestHash: digest,
    toolVersion: z.string(),
    status: statusSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    cancelRequested: z.boolean(),
    owner: ownerSchema.optional(),
    progress: z
      .object({
        completed: z.number().nonnegative(),
        total: z.number().nonnegative().optional(),
        message: z.string().max(4096),
      })
      .strict()
      .optional(),
    transaction: transactionBindingSchema.optional(),
    writeRecipe: z.record(z.string(), z.json()).optional(),
    checkpoint: z
      .object({
        sourceRevision: digest,
        resourceUri: z.string().min(1).optional(),
        cursor: z.string().min(1),
        resultHash: digest.optional(),
      })
      .strict()
      .optional(),
    result: z.record(z.string(), z.json()).optional(),
    failure: z
      .object({ code: z.string().min(1), message: z.string().max(4096) })
      .strict()
      .optional(),
  })
  .strict();
const recordSchema = recordBaseSchema.superRefine((value, context) => {
  if (value.status === 'completed' && value.result === undefined)
    context.addIssue({ code: 'custom', message: 'Completed jobs require a recorded result' });
  if (value.status === 'failed' && value.failure === undefined)
    context.addIssue({
      code: 'custom',
      message: 'Failed jobs require recorded failure evidence',
    });
  if (value.transaction !== undefined && !value.request.mutation)
    context.addIssue({
      code: 'custom',
      message: 'Read-only jobs cannot bind write transactions',
    });
  if (
    value.writeRecipe !== undefined &&
    (!value.request.mutation || value.transaction === undefined)
  )
    context.addIssue({
      code: 'custom',
      message: 'A write result recipe requires a bound mutation transaction',
    });
  if (value.progress?.total !== undefined && value.progress.completed > value.progress.total)
    context.addIssue({ code: 'custom', message: 'Completed progress exceeds total work' });
  if (
    value.result !== undefined &&
    value.status !== 'completed' &&
    (value.request.mutation ||
      value.checkpoint?.cursor !== 'result-ready' ||
      value.checkpoint.resultHash !== hashCanonical(value.result))
  )
    context.addIssue({
      code: 'custom',
      message: 'A staged read result requires an authenticated result-ready checkpoint',
    });
});
const envelopeSchema = z.object({ record: recordSchema, authenticationTag: digest }).strict();
const updateSchema = recordBaseSchema
  .pick({
    status: true,
    cancelRequested: true,
    progress: true,
    transaction: true,
    writeRecipe: true,
    checkpoint: true,
    result: true,
    failure: true,
  })
  .partial()
  .strict();

export type JobScope = z.infer<typeof scopeSchema>;
export type JobOwner = z.infer<typeof ownerSchema>;
export type JobRequest = z.infer<typeof requestSchema>;
export type JobRecord = z.infer<typeof recordSchema>;
export type JobUpdate = Partial<
  Pick<
    JobRecord,
    | 'status'
    | 'cancelRequested'
    | 'progress'
    | 'transaction'
    | 'writeRecipe'
    | 'checkpoint'
    | 'result'
    | 'failure'
  >
>;

export function currentJobOwner(): JobOwner {
  return {
    token: secureId('worker'),
    pid: process.pid,
    host: hostname().toLowerCase(),
    processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  };
}

export function jobOwnerLiveness(owner: JobOwner): 'alive' | 'dead' | 'unknown' {
  if (owner.host !== hostname().toLowerCase()) return 'unknown';
  try {
    process.kill(owner.pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

function jobRequestHash(scope: JobScope, request: JobRequest, toolVersion: string): string {
  const { protocolTask: _protocolTask, ...executionRequest } = request;
  return hashCanonical({ scope, request: executionRequest, toolVersion });
}

const transitions: Record<JobRecord['status'], ReadonlySet<JobRecord['status']>> = {
  queued: new Set(['queued', 'running', 'cancelled', 'failed']),
  running: new Set(['running', 'reconciling', 'completed', 'cancelled', 'failed']),
  reconciling: new Set(['reconciling', 'running', 'completed', 'cancelled', 'failed']),
  completed: new Set(),
  cancelled: new Set(),
  failed: new Set(),
};

export function jobRetentionExpired(record: JobRecord, now = Date.now()): boolean {
  const ttl = record.request.protocolTask?.ttl;
  return (
    ttl !== undefined &&
    ttl !== null &&
    ['completed', 'cancelled', 'failed'].includes(record.status) &&
    Date.parse(record.updatedAt) + ttl <= now
  );
}

async function assertUnlinked(file: string): Promise<void> {
  try {
    if ((await lstat(file)).isSymbolicLink())
      throw new ServiceError(
        'JOB_RECORD_UNSAFE',
        'Persistent job storage cannot use symbolic links or junctions',
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

interface JobRecordPublishOptions {
  platform?: NodeJS.Platform;
  publish?: (temporary: string, target: string) => Promise<void>;
  wait?: (milliseconds: number) => Promise<unknown>;
  maxAttempts?: number;
}

/** Atomic replacement with a finite retry for Windows sharing violations. */
export async function publishJobRecord(
  temporary: string,
  target: string,
  options: JobRecordPublishOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const publish = options.publish ?? rename;
  const wait = options.wait ?? delay;
  const maxAttempts = options.maxAttempts ?? 100;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
    throw new RangeError('Job record publication attempts must be a positive integer');
  for (let attempt = 1; ; attempt += 1) {
    try {
      await publish(temporary, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (
        platform !== 'win32' ||
        !['EPERM', 'EBUSY', 'EACCES'].includes(code) ||
        attempt >= maxAttempts
      )
        throw error;
      await wait(10);
    }
  }
}

/** Internal durable job records. Callers must obtain scopes from the authorized workspace resolver. */
export class JobStore {
  private constructor(
    private readonly state: ServerState,
    private readonly root: string,
    private readonly lock: SharedRequestCapacity,
    private readonly maxRecordBytes: number,
  ) {}

  static async create(state: ServerState, maxRecordBytes = 4 * 1024 * 1024): Promise<JobStore> {
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1024)
      throw new RangeError('Job record budget must be an integer of at least 1024 bytes');
    await assertUnlinked(path.join(state.root, 'jobs'));
    const root = await containedGeneratedPath(state.root, 'jobs');
    await mkdir(root, { recursive: true, mode: 0o700 });
    await assertUnlinked(path.join(state.root, 'jobs'));
    await containedGeneratedPath(state.root, 'jobs');
    return new JobStore(state, root, new SharedRequestCapacity(root, 1), maxRecordBytes);
  }

  async submit(
    scopeInput: JobScope,
    requestInput: JobRequest,
    signal = new AbortController().signal,
  ): Promise<{ record: JobRecord; created: boolean }> {
    const scope = scopeSchema.parse(scopeInput);
    const request = requestSchema.parse(requestInput);
    const requestHash = jobRequestHash(scope, request, PACKAGE_VERSION);
    const id = `job_${hashCanonical({ scope, key: request.requestKey ?? secureId('request') })}`;
    return this.lock.run(signal, async () => {
      const existing = await this.read(scope, id);
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash)
          throw new ServiceError(
            'JOB_REQUEST_KEY_CONFLICT',
            'The request key is already bound to different inputs or a different tool version',
          );
        return { record: existing, created: false };
      }
      const now = new Date().toISOString();
      const record = recordSchema.parse({
        version: 1,
        id,
        revision: 1,
        scope,
        request,
        requestHash,
        toolVersion: PACKAGE_VERSION,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        cancelRequested: false,
      });
      signal.throwIfAborted();
      await this.write(record);
      return { record, created: true };
    });
  }

  async get(scope: JobScope, id: string, signal?: AbortSignal): Promise<JobRecord> {
    signal?.throwIfAborted();
    const record = await this.read(scopeSchema.parse(scope), jobId.parse(id));
    signal?.throwIfAborted();
    if (record === undefined)
      throw new ServiceError(
        'JOB_NOT_FOUND',
        'No job exists in the authorized workspace and principal scope',
      );
    return record;
  }

  /** Remove only an authenticated terminal record under the store lock. */
  async removeTerminal(
    scopeInput: JobScope,
    idInput: string,
    signal = new AbortController().signal,
  ): Promise<boolean> {
    const scope = scopeSchema.parse(scopeInput);
    const id = jobId.parse(idInput);
    return this.lock.run(signal, async () => {
      const record = await this.read(scope, id);
      if (record === undefined) return false;
      if (!['completed', 'cancelled', 'failed'].includes(record.status))
        throw new ServiceError(
          'JOB_STATE_CONFLICT',
          'Only a terminal job record can be removed by retention cleanup',
        );
      const file = await this.recordPath(scope, id);
      for (let attempt = 1; ; attempt += 1) {
        signal.throwIfAborted();
        try {
          await unlink(file);
          return true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? '';
          if (code === 'ENOENT') return false;
          if (
            process.platform !== 'win32' ||
            !['EPERM', 'EBUSY', 'EACCES'].includes(code) ||
            attempt >= 100
          )
            throw error;
          await delay(10);
        }
      }
    });
  }

  /** Claim execution once; an interrupted owner must be proven dead, never merely slow. */
  async claim(
    scope: JobScope,
    id: string,
    ownerInput: JobOwner,
    signal = new AbortController().signal,
  ): Promise<{ record: JobRecord; recovery: boolean }> {
    const owner = ownerSchema.parse(ownerInput);
    return this.lock.run(signal, async () => {
      const current = await this.get(scope, id, signal);
      if (!['queued', 'running', 'reconciling'].includes(current.status))
        throw new ServiceError('JOB_TERMINAL', 'The job already has a terminal outcome');
      const recovery = current.status !== 'queued';
      if (recovery) {
        if (current.owner === undefined)
          throw new ServiceError(
            'JOB_OWNER_UNRESOLVED',
            'Interrupted job ownership has no verifiable process evidence',
          );
        const liveness = jobOwnerLiveness(current.owner);
        if (liveness !== 'dead')
          throw new ServiceError(
            liveness === 'alive' ? 'JOB_OWNER_ACTIVE' : 'JOB_OWNER_UNRESOLVED',
            'The previous execution owner has not been proven stopped',
          );
      }
      const record = recordSchema.parse({
        ...current,
        owner,
        status: recovery ? 'reconciling' : current.cancelRequested ? 'cancelled' : 'running',
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      signal.throwIfAborted();
      await this.write(record);
      return { record, recovery };
    });
  }

  /** Worker fencing: stale execution tokens cannot publish progress, results, or bindings. */
  async updateOwned(
    scope: JobScope,
    id: string,
    ownerToken: string,
    patch: JobUpdate,
    signal = new AbortController().signal,
  ): Promise<JobRecord> {
    for (;;) {
      signal.throwIfAborted();
      const current = await this.get(scope, id, signal);
      if (current.owner?.token !== ownerToken)
        throw new ServiceError(
          'JOB_OWNER_CHANGED',
          'The job is owned by another execution attempt',
        );
      try {
        return await this.update(scope, id, current.revision, patch, signal);
      } catch (error) {
        if (!(error instanceof ServiceError) || error.code !== 'JOB_REVISION_CONFLICT') throw error;
      }
    }
  }

  /** Bounded-memory stable-key pagination; only the requested scope is enumerated. */
  async list(
    scopeInput: JobScope,
    options: { after?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<{ records: JobRecord[]; next?: string }> {
    const scope = scopeSchema.parse(scopeInput);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new ServiceError('JOB_PAGE_INVALID', 'Job page size must be between 1 and 100');
    if (options.after !== undefined) jobId.parse(options.after);
    options.signal?.throwIfAborted();
    await assertUnlinked(this.root);
    await assertUnlinked(path.join(this.root, hashCanonical(scope)));
    const directory = await containedGeneratedPath(this.root, hashCanonical(scope));
    let entries;
    try {
      entries = await opendir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [] };
      throw error;
    }
    const ids: string[] = [];
    for await (const entry of entries) {
      options.signal?.throwIfAborted();
      if (entry.name.startsWith('.') && entry.name.endsWith('.tmp') && entry.isFile()) continue;
      const id = entry.name.replace(/\.json$/u, '');
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !entry.name.endsWith('.json') ||
        !jobId.safeParse(id).success
      )
        throw new ServiceError('JOB_RECORD_UNSAFE', 'Job scope contains an invalid record entry');
      if (options.after !== undefined && id <= options.after) continue;
      const position = ids.findIndex((value) => value > id);
      ids.splice(position < 0 ? ids.length : position, 0, id);
      if (ids.length > limit + 1) ids.pop();
    }
    const records: JobRecord[] = [];
    for (const id of ids.slice(0, limit)) records.push(await this.get(scope, id, options.signal));
    return { records, ...(ids.length > limit ? { next: records.at(-1)!.id } : {}) };
  }

  async update(
    scope: JobScope,
    id: string,
    expectedRevision: number,
    update: JobUpdate,
    signal = new AbortController().signal,
  ): Promise<JobRecord> {
    const patch = updateSchema.parse(update);
    return this.lock.run(signal, async () => {
      const current = await this.get(scope, id, signal);
      if (current.revision !== expectedRevision)
        throw new ServiceError(
          'JOB_REVISION_CONFLICT',
          'Job state changed; retrieve its current revision before updating',
        );
      if (!transitions[current.status].has(patch.status ?? current.status))
        throw new ServiceError(
          'JOB_STATE_CONFLICT',
          'The requested job state transition is not valid',
        );
      if (current.cancelRequested && patch.cancelRequested === false)
        throw new ServiceError(
          'JOB_STATE_CONFLICT',
          'A recorded cancellation request cannot be withdrawn',
        );
      if (
        current.transaction !== undefined &&
        Object.hasOwn(patch, 'transaction') &&
        canonicalJson(current.transaction) !== canonicalJson(patch.transaction ?? null)
      )
        throw new ServiceError(
          'JOB_TRANSACTION_CONFLICT',
          'A job cannot be rebound to another transaction',
        );
      if (
        current.writeRecipe !== undefined &&
        Object.hasOwn(patch, 'writeRecipe') &&
        canonicalJson(current.writeRecipe) !== canonicalJson(patch.writeRecipe ?? null)
      )
        throw new ServiceError(
          'JOB_WRITE_RECIPE_CONFLICT',
          'A job cannot replace its authenticated write result recipe',
        );
      if (
        current.result !== undefined &&
        Object.hasOwn(patch, 'result') &&
        canonicalJson(current.result) !== canonicalJson(patch.result ?? null)
      )
        throw new ServiceError(
          'JOB_RESULT_CONFLICT',
          'A staged or completed job result is immutable',
        );
      const record = recordSchema.parse({
        ...current,
        ...patch,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      signal.throwIfAborted();
      await this.write(record);
      return record;
    });
  }

  private async recordPath(scope: JobScope, id: string): Promise<string> {
    await assertUnlinked(this.root);
    await assertUnlinked(path.join(this.root, hashCanonical(scope)));
    await assertUnlinked(path.join(this.root, hashCanonical(scope), `${id}.json`));
    return containedGeneratedPath(this.root, hashCanonical(scope), `${id}.json`);
  }

  private async read(scope: JobScope, id: string): Promise<JobRecord | undefined> {
    const file = await this.recordPath(scope, id);
    let handle;
    try {
      handle = await open(file, 'r');
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > this.maxRecordBytes)
        throw new ServiceError(
          'JOB_RECORD_INVALID',
          'Persistent job record exceeds its storage budget or is not a file',
        );
      const parsed = envelopeSchema.safeParse(JSON.parse(await handle.readFile('utf8')) as unknown);
      if (
        !parsed.success ||
        parsed.data.record.id !== id ||
        canonicalJson(parsed.data.record.scope) !== canonicalJson(scope) ||
        !this.state.verifyJournal(
          { kind: 'job-record.v1', record: parsed.data.record },
          parsed.data.authenticationTag,
        )
      )
        throw new ServiceError(
          'JOB_RECORD_INVALID',
          'Persistent job record authentication or identity is invalid',
        );
      const record = parsed.data.record;
      if (record.requestHash !== jobRequestHash(record.scope, record.request, record.toolVersion))
        throw new ServiceError('JOB_RECORD_INVALID', 'Persistent job request identity is invalid');
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof SyntaxError)
        throw new ServiceError('JOB_RECORD_INVALID', 'Persistent job record is not valid JSON');
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async write(record: JobRecord): Promise<void> {
    await this.recordPath(record.scope, record.id);
    const directory = await containedGeneratedPath(this.root, hashCanonical(record.scope));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = await this.recordPath(record.scope, record.id);
    const temporary = await containedGeneratedPath(directory, `.${secureId('job')}.tmp`);
    const bytes = Buffer.from(
      canonicalJson({
        record,
        authenticationTag: this.state.authenticateJournal({ kind: 'job-record.v1', record }),
      }),
    );
    if (bytes.length > this.maxRecordBytes)
      throw new ServiceError(
        'JOB_RECORD_LIMIT',
        'Job record exceeds its metadata budget; large inputs and results must use linked resources',
      );
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.recordPath(record.scope, record.id);
      await publishJobRecord(temporary, target);
      if (process.platform !== 'win32') {
        const directoryHandle = await open(directory, 'r');
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
    } finally {
      await handle?.close();
      await unlink(temporary).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }
}
