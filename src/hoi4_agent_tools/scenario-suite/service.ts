import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod/v4';
import { analysisSourceEvidence } from '../core/analysis-evidence.js';
import { publicArtifactLink } from '../core/artifacts.js';
import { canonicalJson, hashCanonical, sha256Bytes } from '../core/canonical.js';
import type { CoreEngine } from '../core/engine.js';
import { registerAnalysisJobs } from '../core/analysis-job-operations.js';
import { JobOperations, type JobExecutionContext } from '../core/job-executor.js';
import { setInlineFilesScanned } from '../core/operation-result.js';
import { emptyServiceResult, ServiceError } from '../core/result.js';
import { registerEventJobs } from '../event/job-operations.js';
import { registerFocusJobs } from '../focus/job-operations.js';
import { registerGuiJobs } from '../gui/job-operations.js';
import { registerMapJobs } from '../map/job-operations.js';
import { runMechanicCase } from '../mechanic/service.js';
import { PackageAnalyzer } from '../package-check/service.js';
import { registerProbabilityJobs } from '../probability/job-operations.js';
import {
  scenarioSuiteSchema,
  type ScenarioSuite,
  type ScenarioTestRequest,
} from '../schemas/scenarios.js';
import { registerTechnologyJobs } from '../technology/job-operations.js';
import { PACKAGE_VERSION } from '../version.js';

export interface ScenarioServiceInput extends ScenarioTestRequest {
  principal?: string;
  signal?: AbortSignal;
}

const MAX_SUITE_BYTES = 8 * 1024 * 1024;
const continuationSchema = z
  .object({
    version: z.literal(1),
    workspaceIdentity: z.string().regex(/^[a-f0-9]{64}$/u),
    principal: z.string(),
    suiteHash: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    nextIndex: z.number().int().nonnegative(),
    completedHash: z.string().regex(/^[a-f0-9]{64}$/u),
    failed: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
  })
  .strict();

function issueToken(engine: CoreEngine, payload: z.infer<typeof continuationSchema>): string {
  const state = engine.resolver.serverState();
  if (state === undefined)
    throw new ServiceError(
      'SCENARIO_CONTINUATION_UNAVAILABLE',
      'Persistent server state is required for suite continuation',
    );
  const encoded = Buffer.from(canonicalJson(payload)).toString('base64url');
  return `${encoded}.${state.authenticateJournal(payload)}`;
}

function readToken(engine: CoreEngine, token: string): z.infer<typeof continuationSchema> {
  const state = engine.resolver.serverState();
  if (state === undefined)
    throw new ServiceError(
      'SCENARIO_CONTINUATION_UNAVAILABLE',
      'Persistent server state is required for suite continuation',
    );
  const [encoded, tag, extra] = token.split('.');
  if (encoded === undefined || tag === undefined || extra !== undefined)
    throw new ServiceError('SCENARIO_CONTINUATION_INVALID', 'Malformed continuation');
  let payload: z.infer<typeof continuationSchema>;
  try {
    payload = continuationSchema.parse(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown,
    );
  } catch {
    throw new ServiceError('SCENARIO_CONTINUATION_INVALID', 'Malformed continuation');
  }
  if (!state.verifyJournal(payload, tag))
    throw new ServiceError('SCENARIO_CONTINUATION_INVALID', 'Continuation authentication failed');
  return payload;
}

function atPath(object: unknown, path: readonly string[]): unknown {
  let cursor = object;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object' || !Object.hasOwn(cursor, key))
      return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function caseAssertions(assertions: ScenarioSuite['cases'][number]['assertions'], output: unknown) {
  return assertions.map((assertion) => {
    const observed = atPath(output, assertion.path);
    return {
      id: assertion.id,
      status:
        observed === undefined
          ? 'unresolved'
          : observed === assertion.expected
            ? 'passed'
            : 'failed',
      ...(observed === undefined ? {} : { observed }),
    };
  });
}

function typedOperations(engine: CoreEngine): JobOperations {
  const operations = new JobOperations();
  registerAnalysisJobs(operations, engine);
  registerEventJobs(operations, engine);
  registerTechnologyJobs(operations, engine);
  registerProbabilityJobs(operations, engine);
  registerFocusJobs(operations, engine);
  registerGuiJobs(operations, engine);
  registerMapJobs(operations, engine);
  return operations;
}

/**
 * Runs a versioned suite in bounded pages through fixed read-only core
 * operations. The continuation is signed and pins all selection inputs.
 */
export class ScenarioAnalyzer {
  constructor(private readonly engine: CoreEngine) {}

  async test(input: ScenarioServiceInput) {
    const workspace = this.engine.resolver.get(input.workspaceId, input.principal);
    if (input.refresh) this.engine.invalidate(input.workspaceId);
    const snapshot = await this.engine.scan(input.workspaceId, {}, input.principal, input.signal);
    if (input.expectedRevision !== undefined && input.expectedRevision !== snapshot.revision)
      throw new ServiceError('SCENARIO_SOURCE_STALE', 'Scenario source revision changed');
    let suite: ScenarioSuite;
    let suiteFileHash: string | undefined;
    if (input.suitePath !== undefined) {
      const resolved = await this.engine.resolver.resolvePath(
        input.workspaceId,
        input.suitePath,
        'read',
        ['mod'],
        input.principal,
      );
      const details = await stat(resolved.path);
      if (!details.isFile() || details.size > MAX_SUITE_BYTES)
        throw new ServiceError('SCENARIO_SUITE_LIMIT', 'Suite file exceeds the bounded reader');
      const bytes = await readFile(resolved.path);
      suiteFileHash = sha256Bytes(bytes);
      suite = scenarioSuiteSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
    } else suite = scenarioSuiteSchema.parse(input.suite);
    const suiteHash = hashCanonical({ suite, suiteFileHash });
    const resumed =
      input.continuation === undefined ? undefined : readToken(this.engine, input.continuation);
    if (
      resumed !== undefined &&
      (resumed.workspaceIdentity !== workspace.workspaceIdentity ||
        resumed.principal !== (input.principal ?? '') ||
        resumed.suiteHash !== suiteHash ||
        resumed.sourceRevision !== snapshot.revision ||
        resumed.nextIndex >= suite.cases.length ||
        resumed.failed + resumed.unresolved > resumed.nextIndex)
    )
      throw new ServiceError(
        'SCENARIO_CONTINUATION_STALE',
        'Continuation does not match the authorized suite and source revision',
      );
    const start = resumed?.nextIndex ?? 0;
    const end = Math.min(suite.cases.length, start + input.maxCases);
    const operations = typedOperations(this.engine);
    const packageAnalyzer = new PackageAnalyzer(this.engine);
    const caseResults = [];
    let completedHash =
      resumed?.completedHash ??
      hashCanonical({
        suiteHash,
        sourceRevision: snapshot.revision,
        workspaceIdentity: workspace.workspaceIdentity,
      });
    const evidence = analysisSourceEvidence(snapshot);
    for (let index = start; index < end; index += 1) {
      input.signal?.throwIfAborted();
      const item = suite.cases[index]!;
      const missing = item.sourceSelectors.filter(
        ({ kind, id }) =>
          snapshot.index.find(kind as Parameters<typeof snapshot.index.find>[0], id) === undefined,
      );
      let output: unknown;
      let executionStatus: 'completed' | 'failed' | 'unresolved';
      let reason: string | undefined;
      if (missing.length > 0) {
        executionStatus = snapshot.complete ? 'failed' : 'unresolved';
        reason = 'Declared source selector is absent from the active source index';
        output = { missing };
      } else {
        try {
          if (item.domain === 'mechanic') {
            const mechanic = runMechanicCase(snapshot, item.test);
            output = mechanic;
            executionStatus =
              mechanic.status === 'passed'
                ? 'completed'
                : mechanic.status === 'failed'
                  ? 'failed'
                  : 'unresolved';
          } else if (item.domain === 'package') {
            const checked = await packageAnalyzer.check({
              workspaceId: input.workspaceId,
              manifest: item.manifest,
              expectedRevision: snapshot.revision,
              ...(input.principal === undefined ? {} : { principal: input.principal }),
              ...(input.signal === undefined ? {} : { signal: input.signal }),
              refresh: false,
            });
            output = checked;
            executionStatus = checked.data.complete ? 'completed' : 'failed';
          } else {
            const operation = operations.get(item.tool);
            if (operation.mutation)
              throw new ServiceError('SCENARIO_TOOL_MUTATION', 'Suite operation is not read-only');
            const context: JobExecutionContext = {
              engine: this.engine,
              workspaceId: input.workspaceId,
              principal: input.principal,
              signal: input.signal ?? new AbortController().signal,
              checkpoint: undefined,
              progress: () => Promise.resolve(),
              saveCheckpoint: () =>
                Promise.reject(
                  new ServiceError(
                    'SCENARIO_CHECKPOINT_UNAVAILABLE',
                    'Nested jobs cannot publish a suite checkpoint',
                  ),
                ),
              stageResult: () => Promise.resolve(),
            };
            const wire = await operation.run(
              {
                ...item.arguments,
                workspaceId: input.workspaceId,
              },
              context,
            );
            output = atPath(wire, ['structuredContent']) ?? wire;
            const status = atPath(output, ['status']);
            const passed = atPath(output, ['validation', 'passed']);
            executionStatus =
              status === 'error' || status === 'blocked' || passed === false
                ? 'failed'
                : 'completed';
          }
        } catch (error) {
          if (input.signal?.aborted) throw error;
          executionStatus = 'unresolved';
          reason =
            error instanceof ServiceError
              ? error.code
              : error instanceof Error
                ? error.message
                : 'Case execution failed';
          output = {};
        }
      }
      const assertions = caseAssertions(item.assertions, output);
      const status = assertions.some(({ status }) => status === 'failed')
        ? 'failed'
        : assertions.some(({ status }) => status === 'unresolved') ||
            executionStatus === 'unresolved'
          ? 'unresolved'
          : executionStatus === 'failed'
            ? 'failed'
            : 'completed';
      const caseReport = {
        schemaVersion: 'scenario-case.v1',
        suiteId: suite.id,
        caseId: item.id,
        index,
        domain: item.domain,
        sourceRevision: snapshot.revision,
        status,
        assertions,
        ...(reason === undefined ? {} : { reason }),
        output,
      };
      const caseHash = hashCanonical(caseReport);
      const artifact = await this.engine.artifacts.putChunked(
        workspace,
        `scenario-case-${caseHash.slice(0, 24)}.json`,
        'application/json',
        `${canonicalJson(caseReport)}\n`,
        {
          kind: 'scenario-case',
          toolVersion: PACKAGE_VERSION,
          schemaVersion: 'scenario-case.v1',
          sourceHashes: evidence.sourceHashes,
          metadata: { beforeRevision: snapshot.revision, suiteHash, caseId: item.id },
        },
        'Content-addressed suite case result',
        input.signal,
      );
      completedHash = hashCanonical({ prior: completedHash, caseId: item.id, caseHash });
      caseResults.push({
        id: item.id,
        index,
        status,
        caseHash,
        artifact: publicArtifactLink(artifact),
        ...(item.views.includes('summary') ? { assertions } : {}),
        ...(item.views.includes('artifacts')
          ? { outputArtifacts: atPath(output, ['artifacts']) }
          : {}),
        ...(item.views.includes('diagnostics')
          ? { diagnostics: atPath(output, ['diagnostics']) }
          : {}),
      });
      const observed = await this.engine.scan(input.workspaceId, {}, input.principal, input.signal);
      if (observed.revision !== snapshot.revision)
        throw new ServiceError('SCENARIO_SOURCE_STALE', 'Source changed during suite execution');
    }
    const failed =
      (resumed?.failed ?? 0) + caseResults.filter(({ status }) => status === 'failed').length;
    const unresolved =
      (resumed?.unresolved ?? 0) +
      caseResults.filter(({ status }) => status === 'unresolved').length;
    const continuation =
      end < suite.cases.length
        ? issueToken(this.engine, {
            version: 1,
            workspaceIdentity: workspace.workspaceIdentity,
            principal: input.principal ?? '',
            suiteHash,
            sourceRevision: snapshot.revision,
            nextIndex: end,
            completedHash,
            failed,
            unresolved,
          })
        : undefined;
    const report = {
      schemaVersion: 'scenario-suite-batch.v1',
      suiteId: suite.id,
      suiteHash,
      sourceRevision: snapshot.revision,
      start,
      end,
      total: suite.cases.length,
      completedHash,
      failed,
      unresolved,
      cases: caseResults,
      ...(continuation === undefined ? {} : { continuation }),
    };
    const reportHash = hashCanonical(report);
    const artifact = await this.engine.artifacts.putChunked(
      workspace,
      `scenario-batch-${reportHash.slice(0, 24)}.json`,
      'application/json',
      `${canonicalJson(report)}\n`,
      {
        kind: 'scenario-suite-batch',
        toolVersion: PACKAGE_VERSION,
        schemaVersion: 'scenario-suite-batch.v1',
        sourceHashes: evidence.sourceHashes,
        metadata: { beforeRevision: snapshot.revision, suiteHash, start, end },
      },
      'Revision-pinned suite batch and continuation evidence',
      input.signal,
    );
    const result = emptyServiceResult(input.workspaceId, {
      sourceRevision: snapshot.revision,
      suiteHash,
      reportHash,
      start,
      end,
      total: suite.cases.length,
      completed: end,
      failed,
      unresolved,
      pending: suite.cases.length - end,
      ...(continuation === undefined ? {} : { continuation }),
    });
    result.code =
      continuation !== undefined
        ? 'SCENARIO_SUITE_PENDING'
        : failed > 0 || unresolved > 0
          ? 'SCENARIO_SUITE_INCOMPLETE'
          : 'SCENARIO_SUITE_PASSED';
    result.artifacts = [publicArtifactLink(artifact)];
    setInlineFilesScanned(
      result,
      snapshot.files.map(({ displayPath }) => displayPath),
    );
    result.validation = {
      passed: continuation === undefined && failed === 0 && unresolved === 0,
      checks: [
        {
          id: 'suite-cases',
          passed: continuation === undefined && failed === 0 && unresolved === 0,
          message:
            continuation === undefined
              ? 'All requested cases were reported in this suite'
              : 'Additional cases are pending under the authenticated continuation',
        },
      ],
    };
    return result;
  }
}
