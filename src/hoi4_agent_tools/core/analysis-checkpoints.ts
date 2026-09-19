import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod/v4';
import { canonicalJson, hashCanonical } from './canonical.js';
import type { JobExecutionContext } from './job-executor.js';
import { ServiceError } from './result.js';
import { PACKAGE_VERSION } from '../version.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const envelopeSchema = z
  .object({
    version: z.literal(1),
    key: digest,
    sourceRevision: digest,
    state: z.json(),
  })
  .strict();

export interface AnalysisCheckpoints {
  load<T>(key: string, sourceRevision: string, schema: z.ZodType<T>): Promise<T | undefined>;
  save(
    key: string,
    sourceRevision: string,
    state: unknown,
    completed: number,
    total: number,
  ): Promise<void>;
}

const active = new AsyncLocalStorage<AnalysisCheckpoints>();

/** Internal typed execution context; no transport or caller-supplied executable hooks. */
export function withAnalysisCheckpoints<T>(
  checkpoints: AnalysisCheckpoints,
  run: () => Promise<T>,
): Promise<T> {
  return active.run(checkpoints, run);
}

export function currentAnalysisCheckpoints(): AnalysisCheckpoints | undefined {
  return active.getStore();
}

/** The authenticated job record commits to the exact immutable checkpoint bytes. */
export function jobAnalysisCheckpoints(context: JobExecutionContext): AnalysisCheckpoints {
  let checkpoint = context.checkpoint;
  const workspace = context.engine.resolver.get(context.workspaceId, context.principal);
  return {
    async load(key, sourceRevision, schema) {
      if (checkpoint?.cursor !== `analysis:${key}` || checkpoint.sourceRevision !== sourceRevision)
        return undefined;
      if (checkpoint.resourceUri === undefined || checkpoint.stateHash === undefined)
        throw new ServiceError(
          'ANALYSIS_CHECKPOINT_INVALID',
          'Analysis checkpoint has no authenticated state',
        );
      const resource = await context.engine.artifacts.readLogical(
        workspace,
        checkpoint.resourceUri,
        {
          mimeType: 'application/json',
          maxBytes: 268_435_456,
          maxChunks: 256,
        },
        context.signal,
      );
      const envelope = envelopeSchema.parse(JSON.parse(resource.bytes.toString('utf8')) as unknown);
      if (
        envelope.key !== key ||
        envelope.sourceRevision !== sourceRevision ||
        hashCanonical(envelope) !== checkpoint.stateHash
      )
        throw new ServiceError(
          'ANALYSIS_CHECKPOINT_INVALID',
          'Analysis checkpoint identity or content does not match its job',
        );
      return schema.parse(envelope.state);
    },
    async save(key, sourceRevision, state, completed, total) {
      context.signal.throwIfAborted();
      const envelope = envelopeSchema.parse({ version: 1, key, sourceRevision, state });
      await context.engine.artifacts.withAtomicChunkedWrites(
        workspace,
        [
          {
            name: 'analysis-checkpoint.json',
            mimeType: 'application/json',
            content: canonicalJson(envelope),
            provenance: {
              kind: 'analysis-checkpoint',
              toolVersion: PACKAGE_VERSION,
              schemaVersion: '1',
              sourceHashes: {},
              metadata: { key, sourceRevision },
            },
            description: 'Revision-bound internal dependency-expansion checkpoint',
          },
        ],
        async ([resource], physical) => {
          const next = {
            sourceRevision,
            resourceUri: resource!.uri,
            cursor: `analysis:${key}`,
            stateHash: hashCanonical(envelope),
            resources: physical.map(({ uri }) => uri),
          };
          // Publish the authenticated pin before releasing artifact admission. A competing
          // writer therefore sees either the old complete checkpoint or the new one.
          await context.saveCheckpoint(next);
          checkpoint = next;
        },
        context.signal,
      );
      await context.progress({
        completed,
        total,
        message: 'Expanding source-bound helper dependencies',
      });
    },
  };
}
