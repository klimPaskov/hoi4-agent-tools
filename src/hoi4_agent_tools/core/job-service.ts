import {
  currentJobOwner,
  jobRetentionExpired,
  jobOwnerLiveness,
  JobStore,
  type JobRecord,
  type JobRequest,
  type JobScope,
} from './job-store.js';
import { ServiceError } from './result.js';
import { transactionRootFingerprint } from './transactions.js';
import type { WorkspaceResolver } from './workspace.js';

/** Authorization boundary for persistent jobs; transport inputs never supply an ownership scope. */
export class JobService {
  private constructor(
    private readonly resolver: WorkspaceResolver,
    readonly store: JobStore,
  ) {}

  static async create(resolver: WorkspaceResolver): Promise<JobService> {
    const state = resolver.serverState();
    if (state === undefined)
      throw new ServiceError(
        'JOB_STORAGE_UNAVAILABLE',
        'Persistent jobs require operator-owned server state',
      );
    return new JobService(resolver, await JobStore.create(state));
  }

  scope(workspaceId: string, principal?: string): JobScope {
    const workspace = this.resolver.get(workspaceId, principal);
    return {
      workspaceId: workspace.id,
      workspaceIdentity: workspace.workspaceIdentity,
      rootFingerprint: transactionRootFingerprint(workspace),
      principal: principal ?? null,
    };
  }

  async submit(
    workspaceId: string,
    request: JobRequest,
    principal?: string,
    signal?: AbortSignal,
  ): Promise<{ record: JobRecord; created: boolean }> {
    const scope = this.scope(workspaceId, principal);
    if (request.mutation && !this.resolver.get(workspaceId, principal).writeEnabled)
      throw new ServiceError(
        'WORKSPACE_WRITE_DISABLED',
        'Background rewrites require an enabled workspace write policy',
      );
    return this.store.submit(scope, request, signal);
  }

  async get(
    workspaceId: string,
    id: string,
    principal?: string,
    signal?: AbortSignal,
  ): Promise<JobRecord> {
    const scope = this.scope(workspaceId, principal);
    const record = await this.store.get(scope, id, signal);
    if (jobRetentionExpired(record) && !record.request.mutation) {
      await this.store.removeTerminal(scope, id, signal);
      throw new ServiceError(
        'JOB_NOT_FOUND',
        'The retained job result has expired in the authorized scope',
      );
    }
    return record;
  }

  async list(
    workspaceId: string,
    principal?: string,
    options: { after?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<{ records: JobRecord[]; next?: string }> {
    const scope = this.scope(workspaceId, principal);
    const page = await this.store.list(scope, options);
    const records: JobRecord[] = [];
    for (const record of page.records) {
      if (!jobRetentionExpired(record)) {
        records.push(record);
        continue;
      }
      if (!record.request.mutation)
        await this.store.removeTerminal(scope, record.id, options.signal);
    }
    return { records, ...(page.next === undefined ? {} : { next: page.next }) };
  }

  async cancel(
    workspaceId: string,
    id: string,
    principal?: string,
    signal?: AbortSignal,
  ): Promise<JobRecord> {
    const scope = this.scope(workspaceId, principal);
    for (;;) {
      signal?.throwIfAborted();
      const record = await this.store.get(scope, id, signal);
      if (['completed', 'failed', 'cancelled'].includes(record.status) || record.cancelRequested)
        return record;
      try {
        return await this.store.update(
          scope,
          id,
          record.revision,
          {
            cancelRequested: true,
            ...(record.status === 'queued' ? { status: 'cancelled' as const } : {}),
          },
          signal,
        );
      } catch (error) {
        if (!(error instanceof ServiceError) || error.code !== 'JOB_REVISION_CONFLICT') throw error;
      }
    }
  }

  /** Settle a stopped attempt only when no uncertain write outcome can exist. */
  async failInterrupted(
    workspaceId: string,
    id: string,
    failure: { code: string; message: string },
    principal?: string,
    signal?: AbortSignal,
  ): Promise<JobRecord> {
    const scope = this.scope(workspaceId, principal);
    for (;;) {
      signal?.throwIfAborted();
      const current = await this.store.get(scope, id, signal);
      if (['completed', 'failed', 'cancelled'].includes(current.status)) return current;
      if (current.request.mutation && current.transaction !== undefined)
        throw new ServiceError(
          'JOB_RECONCILIATION_REQUIRED',
          'An interrupted rewrite must be reconciled from its bound transaction journal',
        );
      if (current.status === 'queued') {
        try {
          return await this.store.update(
            scope,
            id,
            current.revision,
            { status: 'failed', failure },
            signal,
          );
        } catch (error) {
          if (!(error instanceof ServiceError) || error.code !== 'JOB_REVISION_CONFLICT')
            throw error;
          continue;
        }
      }
      if (current.owner === undefined || jobOwnerLiveness(current.owner) !== 'dead')
        throw new ServiceError(
          'JOB_OWNER_UNRESOLVED',
          'The interrupted execution owner has not been proven stopped',
        );
      const owner = currentJobOwner();
      try {
        const claimed = await this.store.claim(scope, id, owner, signal);
        if (claimed.record.status === 'cancelled') return claimed.record;
        return await this.store.updateOwned(
          scope,
          id,
          owner.token,
          claimed.record.cancelRequested ? { status: 'cancelled' } : { status: 'failed', failure },
          signal,
        );
      } catch (error) {
        if (
          error instanceof ServiceError &&
          ['JOB_OWNER_ACTIVE', 'JOB_REVISION_CONFLICT'].includes(error.code)
        )
          continue;
        throw error;
      }
    }
  }
}
