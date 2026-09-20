import { readFile, stat } from 'node:fs/promises';
import { analysisSourceEvidence } from '../core/analysis-evidence.js';
import { publicArtifactLink } from '../core/artifacts.js';
import { canonicalJson, hashCanonical, sha256Bytes } from '../core/canonical.js';
import type { CoreEngine, ScanSnapshot } from '../core/engine.js';
import type { SymbolKind } from '../core/index.js';
import { scanImpactSemanticReferences } from '../core/impact-semantic.js';
import { setInlineFilesScanned } from '../core/operation-result.js';
import { emptyServiceResult, ServiceError } from '../core/result.js';
import { parseClausewitz, type SourceEntry } from '../core/source/index.js';
import type { PackageCheckRequest, PackageManifest } from '../schemas/scenarios.js';
import { scenarioSuiteSchema } from '../schemas/scenarios.js';
import { PACKAGE_VERSION } from '../version.js';

export interface PackageServiceInput extends PackageCheckRequest {
  principal?: string;
  signal?: AbortSignal;
}

export interface PackageItemResult {
  category: string;
  id: string;
  status: 'present' | 'absent' | 'shadowed' | 'unresolved';
  path?: string;
  sha256?: string;
  reason?: string;
}

const MAX_FILE_BYTES = 64 * 1024 * 1024;

function registrationPresent(bytes: Buffer, path: string, token: string): boolean | undefined {
  if (!/\.(?:txt|gfx|gui|asset)$/iu.test(path)) return undefined;
  const document = parseClausewitz(bytes, path);
  if (document.diagnostics.some(({ severity }) => severity === 'error' || severity === 'blocker'))
    return undefined;
  const visit = (entry: SourceEntry): boolean => {
    if (entry.type === 'scalar') return entry.value === token;
    if (entry.type === 'block') return entry.entries.some(visit);
    return entry.key.value === token || visit(entry.value);
  };
  return visit(document.root);
}

function indexedChecks(snapshot: ScanSnapshot, manifest: PackageManifest): PackageItemResult[] {
  const results: PackageItemResult[] = [];
  const semantic = manifest.calls.length > 0 ? scanImpactSemanticReferences(snapshot) : undefined;
  const references =
    semantic === undefined
      ? snapshot.index.references
      : [...snapshot.index.references, ...semantic.references];
  for (const definition of manifest.definitions) {
    const active = snapshot.index.find(definition.kind as SymbolKind, definition.id);
    const all = snapshot.index.findAll(definition.kind as SymbolKind, definition.id);
    const file = snapshot.files.find(({ displayPath }) => displayPath === active?.path);
    results.push({
      category: 'definition',
      id: `${definition.kind}:${definition.id}`,
      status:
        active === undefined
          ? all.length > 0
            ? 'shadowed'
            : snapshot.complete
              ? 'absent'
              : 'unresolved'
          : 'present',
      ...(active?.path === undefined ? {} : { path: active.path }),
      ...(file?.sha256 === undefined ? {} : { sha256: file.sha256 }),
    });
  }
  for (const call of manifest.calls) {
    const from = snapshot.index.find(call.from.kind as SymbolKind, call.from.id);
    const to = snapshot.index.find(call.to.kind as SymbolKind, call.to.id);
    const reference = references.find(
      (candidate) =>
        candidate.from === call.from.id &&
        candidate.toKind === call.to.kind &&
        candidate.to === call.to.id &&
        candidate.path === from?.path,
    );
    results.push({
      category: 'call',
      id: `${call.from.kind}:${call.from.id}->${call.to.kind}:${call.to.id}`,
      status:
        from === undefined || to === undefined
          ? snapshot.complete
            ? 'absent'
            : 'unresolved'
          : reference === undefined
            ? snapshot.complete && (semantic?.complete ?? true)
              ? 'absent'
              : 'unresolved'
            : 'present',
      ...(reference?.path === undefined ? {} : { path: reference.path }),
    });
  }
  for (const id of manifest.localisation) {
    const symbol =
      snapshot.index.find('localisation', id) ??
      snapshot.index.find('localisation', `l_english:${id}`);
    results.push({
      category: 'localisation',
      id,
      status: symbol === undefined ? (snapshot.complete ? 'absent' : 'unresolved') : 'present',
      ...(symbol?.path === undefined ? {} : { path: symbol.path }),
    });
  }
  return results;
}

/** Declarative package inventory; no manifest field is interpreted as code. */
export class PackageAnalyzer {
  constructor(private readonly engine: CoreEngine) {}

  async check(input: PackageServiceInput) {
    const workspace = this.engine.resolver.get(input.workspaceId, input.principal);
    if (input.refresh) this.engine.invalidate(input.workspaceId);
    const snapshot = await this.engine.scan(input.workspaceId, {}, input.principal, input.signal);
    if (input.expectedRevision !== undefined && input.expectedRevision !== snapshot.revision)
      throw new ServiceError('PACKAGE_SOURCE_STALE', 'Package source revision changed', {
        expectedRevision: input.expectedRevision,
        observedRevision: snapshot.revision,
      });
    const results = indexedChecks(snapshot, input.manifest);
    const read = async (relativePath: string): Promise<{ bytes: Buffer; path: string }> => {
      const resolved = await this.engine.resolver.resolvePath(
        input.workspaceId,
        relativePath,
        'read',
        ['mod', 'game', 'dependency', 'fixture'],
        input.principal,
      );
      const metadata = await stat(resolved.path);
      if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES)
        throw new ServiceError('PACKAGE_FILE_LIMIT', 'Package file exceeds the bounded reader');
      return { bytes: await readFile(resolved.path), path: resolved.path };
    };
    for (const registration of input.manifest.registrations) {
      input.signal?.throwIfAborted();
      try {
        const file = await read(registration.path);
        const present = registrationPresent(file.bytes, registration.path, registration.token);
        results.push({
          category: 'registration',
          id: `${registration.path}:${registration.token}`,
          status: present === undefined ? 'unresolved' : present ? 'present' : 'absent',
          path: registration.path,
          sha256: sha256Bytes(file.bytes),
          ...(present === undefined ? { reason: 'PACKAGE_REGISTRATION_UNSUPPORTED_SOURCE' } : {}),
        });
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        results.push({
          category: 'registration',
          id: `${registration.path}:${registration.token}`,
          status:
            error instanceof ServiceError && error.code === 'PATH_NOT_FOUND_IN_ROOTS'
              ? 'absent'
              : 'unresolved',
          reason: error instanceof ServiceError ? error.code : 'PACKAGE_FILE_READ',
        });
      }
    }
    for (const asset of input.manifest.assets) {
      input.signal?.throwIfAborted();
      try {
        const file = await read(asset);
        results.push({
          category: 'asset',
          id: asset,
          status: 'present',
          path: asset,
          sha256: sha256Bytes(file.bytes),
        });
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        results.push({
          category: 'asset',
          id: asset,
          status:
            error instanceof ServiceError && error.code === 'PATH_NOT_FOUND_IN_ROOTS'
              ? 'absent'
              : 'unresolved',
          reason: error instanceof ServiceError ? error.code : 'PACKAGE_FILE_READ',
        });
      }
    }
    for (const required of input.manifest.requiredCases) {
      input.signal?.throwIfAborted();
      try {
        const file = await read(required.suite);
        const suite = scenarioSuiteSchema.parse(JSON.parse(file.bytes.toString('utf8')) as unknown);
        results.push({
          category: 'required_case',
          id: `${required.suite}:${required.caseId}`,
          status: suite.cases.some(({ id }) => id === required.caseId) ? 'present' : 'absent',
          path: required.suite,
          sha256: sha256Bytes(file.bytes),
        });
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        results.push({
          category: 'required_case',
          id: `${required.suite}:${required.caseId}`,
          status:
            error instanceof ServiceError && error.code === 'PATH_NOT_FOUND_IN_ROOTS'
              ? 'absent'
              : 'unresolved',
          reason: error instanceof ServiceError ? error.code : 'PACKAGE_SUITE_INVALID',
        });
      }
    }
    const report = {
      schemaVersion: 'package-check.v1',
      packageId: input.manifest.id,
      sourceRevision: snapshot.revision,
      manifestHash: hashCanonical(input.manifest),
      items: results,
      complete: snapshot.complete && results.every(({ status }) => status === 'present'),
    };
    const reportHash = hashCanonical(report);
    const evidence = analysisSourceEvidence(snapshot);
    const artifact = await this.engine.artifacts.putChunked(
      workspace,
      `package-${reportHash.slice(0, 24)}.json`,
      'application/json',
      `${canonicalJson(report)}\n`,
      {
        kind: 'package-check',
        toolVersion: PACKAGE_VERSION,
        schemaVersion: 'package-check.v1',
        sourceHashes: evidence.sourceHashes,
        metadata: { beforeRevision: snapshot.revision, sourceInventory: evidence.inventory },
      },
      'Revision-pinned package connection inventory',
      input.signal,
    );
    const result = emptyServiceResult(input.workspaceId, {
      sourceRevision: snapshot.revision,
      reportHash,
      complete: report.complete,
      items: results.length,
      present: results.filter(({ status }) => status === 'present').length,
      absent: results.filter(({ status }) => status === 'absent').length,
      shadowed: results.filter(({ status }) => status === 'shadowed').length,
      unresolved: results.filter(({ status }) => status === 'unresolved').length,
    });
    result.code = report.complete ? 'PACKAGE_CHECK_PASSED' : 'PACKAGE_CHECK_INCOMPLETE';
    result.artifacts = [publicArtifactLink(artifact)];
    setInlineFilesScanned(
      result,
      snapshot.files.map(({ displayPath }) => displayPath),
    );
    result.validation = {
      passed: report.complete,
      checks: [
        {
          id: 'package-connections',
          passed: report.complete,
          message: report.complete
            ? 'Every declared package connection is present'
            : 'A declared package connection is absent, shadowed, or unresolved',
        },
      ],
    };
    return result;
  }
}
