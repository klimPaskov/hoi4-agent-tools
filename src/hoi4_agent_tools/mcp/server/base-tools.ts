import { boundedSourceHashEvidence, publicArtifactLink } from '../../core/artifacts.js';
import { canonicalJson } from '../../core/canonical.js';
import type { Diagnostic } from '../../core/diagnostics.js';
import type { CoreEngine } from '../../core/engine.js';
import { ServiceError, type ArtifactLink } from '../../core/result.js';
import { parseClausewitz } from '../../core/source/index.js';
import { TRANSACTION_MAX_DIAGNOSTICS } from '../../core/transaction-limits.js';
import type { TransactionManifest } from '../../core/transactions.js';
import {
  importContinuousFocusPalettes,
  importFocusTrees,
  layoutFocusTreeAsync,
  lintContinuousFocusPalette,
  lintFocusTree,
  type FocusReferenceCatalog,
} from '../../focus/index.js';
import { ScriptedGuiStudio } from '../../gui/index.js';
import { AgentNudger, attributeMapValidationDiagnostics } from '../../map/index.js';
import { PACKAGE_VERSION } from '../../version.js';

export interface ServerContext {
  principal?: string;
  scopes?: readonly string[];
}

export function requireServerScope(context: ServerContext, scope: string): void {
  if (context.scopes !== undefined && !context.scopes.includes(scope)) {
    throw new ServiceError('AUTH_SCOPE_REQUIRED', `This operation requires the ${scope} scope`, {
      requiredScope: scope,
    });
  }
}

function sourcePathComparisonKey(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function focusReferences(
  engineSnapshot: Awaited<ReturnType<CoreEngine['scan']>>,
): FocusReferenceCatalog {
  const active = (kind: Parameters<typeof engineSnapshot.index.findAll>[0]): string[] =>
    engineSnapshot.index
      .findAll(kind)
      .filter(({ overridden }) => !overridden)
      .map(({ id }) => id);
  return {
    decision: active('decision'),
    decision_category: active('decision_category'),
    event: active('event'),
    idea: active('idea'),
    leader: active('leader'),
    formable: active('formable'),
    helper: active('scripted_effect'),
  };
}

export async function postValidateTransaction(
  engine: CoreEngine,
  transaction: TransactionManifest,
  principal: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{
  diagnostics: Diagnostic[];
  checks: { id: string; passed: boolean; message: string }[];
  artifacts: ArtifactLink[];
}> {
  engine.invalidate(transaction.workspaceId);
  const snapshot = await engine.scan(transaction.workspaceId, {}, principal, signal);
  const changed = new Set(
    transaction.files.map(({ relativePath }) => sourcePathComparisonKey(relativePath)),
  );
  const diagnostics = snapshot.diagnostics.filter(({ location }) => {
    if (location === undefined) return false;
    const sourcePath = sourcePathComparisonKey(location.path);
    return [...changed].some((relativePath) => sourcePath.endsWith(`:${relativePath}`));
  });
  const checks: { id: string; passed: boolean; message: string }[] = [];

  if (transaction.operationKind === 'focus-plan-changes') {
    const catalog = focusReferences(snapshot);
    for (const file of snapshot.files.filter(
      ({ shadowedBy, relativePath }) =>
        shadowedBy === undefined &&
        relativePath.toLowerCase().endsWith('.txt') &&
        changed.has(sourcePathComparisonKey(relativePath)),
    )) {
      const document = parseClausewitz(file.bytes, file.displayPath);
      const imported = importFocusTrees(document, { references: catalog });
      diagnostics.push(...imported.diagnostics);
      for (const plan of imported.plans) {
        const layout = await layoutFocusTreeAsync(plan, signal === undefined ? {} : { signal });
        diagnostics.push(
          ...lintFocusTree(plan, {
            index: snapshot.index,
            references: catalog,
            layout,
          }),
        );
      }
    }
    const passed = !diagnostics.some(
      ({ severity }) => severity === 'error' || severity === 'blocker',
    );
    checks.push({
      id: 'post-write-focus',
      passed,
      message: passed
        ? 'The focus result re-imported, laid out, and linted successfully'
        : 'The focus result failed post-write import or lint',
    });
  } else if (transaction.operationKind === 'continuous-focus-plan-changes') {
    for (const file of snapshot.files.filter(
      ({ shadowedBy, relativePath }) =>
        shadowedBy === undefined &&
        relativePath.toLowerCase().endsWith('.txt') &&
        changed.has(sourcePathComparisonKey(relativePath)),
    )) {
      const imported = importContinuousFocusPalettes(parseClausewitz(file.bytes, file.displayPath));
      diagnostics.push(...imported.diagnostics);
      for (const plan of imported.continuousFocusPalettes) {
        diagnostics.push(...lintContinuousFocusPalette(plan));
      }
    }
    const passed = !diagnostics.some(
      ({ severity }) => severity === 'error' || severity === 'blocker',
    );
    checks.push({
      id: 'post-write-continuous-focus',
      passed,
      message: passed
        ? 'The continuous focus result re-imported and linted successfully'
        : 'The continuous focus result failed post-write import or lint',
    });
  } else if (
    transaction.operationKind === 'gui-source-change' ||
    transaction.operationKind === 'gui-helper-compilation'
  ) {
    const studio = new ScriptedGuiStudio(engine);
    const scanned = await studio.scan(transaction.workspaceId, principal, signal);
    diagnostics.push(...scanned.graph.diagnostics);
    const passed = !scanned.graph.diagnostics.some(
      ({ severity }) => severity === 'error' || severity === 'blocker',
    );
    checks.push({
      id: 'post-write-gui-graph',
      passed,
      message: passed
        ? 'The GUI graph rebuilt successfully'
        : 'The GUI graph has blocking diagnostics',
    });
  } else if (transaction.operationKind === 'agent-nudger-map-changes') {
    const nudger = new AgentNudger(engine);
    const validated = await nudger.validate(transaction.workspaceId, principal, signal);
    const mapDiagnostics = attributeMapValidationDiagnostics({
      diagnostics: [...diagnostics, ...validated.validation.diagnostics],
      operations: transaction.operations,
      changes: transaction.files,
    });
    diagnostics.length = 0;
    diagnostics.push(...mapDiagnostics);
    checks.push(...validated.validation.checks);
    checks.push({
      id: 'post-write-map',
      passed: validated.validation.passed,
      message: validated.validation.passed
        ? 'The map result rescanned and validated successfully'
        : 'The map result failed post-write validation',
    });
  }

  const passed = !diagnostics.some(
    ({ severity }) => severity === 'error' || severity === 'blocker',
  );
  checks.unshift({
    id: 'post-write-shared-index',
    passed,
    message: passed
      ? 'Changed files reparsed and reindexed successfully'
      : 'Changed files have blocking post-write diagnostics',
  });
  const availableDiagnostics = Math.max(
    0,
    TRANSACTION_MAX_DIAGNOSTICS - transaction.diagnostics.length,
  );
  if (diagnostics.length > availableDiagnostics) {
    const workspace = engine.resolver.get(transaction.workspaceId, principal);
    const sourceEvidence = boundedSourceHashEvidence(
      Object.fromEntries(
        transaction.files.flatMap(({ relativePath, afterSha256 }) =>
          afterSha256 === null ? [] : [[relativePath, afterSha256]],
        ),
      ),
    );
    const artifact = await engine.artifacts.putChunked(
      workspace,
      `${transaction.operationKind}.post-validation.json`,
      'application/json',
      `${canonicalJson({
        schemaVersion: 1,
        operationKind: transaction.operationKind,
        diagnosticCount: diagnostics.length,
        checks,
        diagnostics,
      })}\n`,
      {
        kind: 'rewrite-post-validation',
        toolVersion: PACKAGE_VERSION,
        schemaVersion: 'rewrite-post-validation.v1',
        sourceHashes: sourceEvidence.sourceHashes,
        metadata: { sourceHashInventory: sourceEvidence.inventory },
      },
      'Complete diagnostics from post-write validation',
      signal,
    );
    const retainedLimit = Math.max(0, availableDiagnostics - 1);
    const hard = diagnostics.filter(
      ({ severity }) => severity === 'error' || severity === 'blocker',
    );
    const retainedHard = hard.slice(0, retainedLimit);
    const retainedSoft = diagnostics
      .filter(({ severity }) => severity !== 'error' && severity !== 'blocker')
      .slice(0, retainedLimit - retainedHard.length);
    const omittedHard = hard.length - retainedHard.length;
    const artifactLink = publicArtifactLink(artifact);
    checks.push({
      id: 'post-write-diagnostics-artifact',
      passed: omittedHard === 0,
      message: `Complete post-write diagnostics are stored at ${artifactLink.uri}`,
    });
    return {
      diagnostics:
        availableDiagnostics === 0
          ? []
          : [
              ...retainedHard,
              ...retainedSoft,
              {
                code: 'POST_VALIDATION_DIAGNOSTICS_IN_ARTIFACT',
                severity: omittedHard > 0 ? 'blocker' : 'warning',
                category: 'validation',
                message: `Complete post-write validation contains ${diagnostics.length} diagnostics and is stored as an artifact`,
                details: {
                  total: diagnostics.length,
                  returned: availableDiagnostics,
                  omitted: diagnostics.length - retainedLimit,
                  omittedHard,
                  artifact: artifactLink,
                },
              },
            ],
      checks,
      artifacts: [artifactLink],
    };
  }
  return { diagnostics, checks, artifacts: [] };
}
