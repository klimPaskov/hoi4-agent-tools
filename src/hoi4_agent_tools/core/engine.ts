import { compareCodeUnits, hashCanonical } from './canonical.js';
import type { Diagnostic } from './diagnostics.js';
import { SymbolIndex, type IndexSkippedSource } from './index.js';
import { WorkspaceScanner, type ScanOptions, type ScannedFile } from './scanner.js';
import { ArtifactStore } from './artifacts.js';
import { TransactionManager } from './transactions.js';
import type { WorkspaceResolver } from './workspace.js';

const RECOVERY_TTL_SECONDS = 3_600;
const RECOVERY_MAX_BYTES = 536_870_912;
const RECOVERY_MAX_RECORDS = 128;

export interface ScanSnapshot {
  workspaceId: string;
  revision: string;
  files: ScannedFile[];
  index: SymbolIndex;
  complete: boolean;
  skippedSourceCount: number;
  skippedSources: readonly IndexSkippedSource[];
  diagnostics: Diagnostic[];
}

export interface WorkspaceStatus {
  id: string;
  name: string;
  kind: string;
  writable: boolean;
  rootKinds: string[];
  dependencyCount: number;
  replacePaths: string[];
  replacementOwners: Array<{ rootKind: string; loadOrder: number; paths: string[] }>;
  generatedDirectory: '.hoi4-agent';
}

export interface CoreEngineServices {
  scanner?: WorkspaceScanner;
  artifacts?: ArtifactStore;
  transactions?: TransactionManager;
}

interface ScanFlight {
  promise: Promise<ScanSnapshot>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

interface ScanAdmissionRequest {
  signal: AbortSignal;
  started: boolean;
  settled: boolean;
  run: () => void;
  reject: (reason: unknown) => void;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function scanFailureReason(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('Workspace scan failed', { cause: reason });
}

function under(roots: readonly string[], glob: string): string[] {
  return roots.map((root) => `${root.replaceAll('\\', '/').replace(/\/$/u, '')}/${glob}`);
}

function englishLocalisationPatterns(roots: readonly string[]): string[] {
  return [...under(roots, 'english/**/*.{yml,yaml}'), ...under(roots, '*.{yml,yaml}')];
}

function defaultPatterns(workspace: ReturnType<WorkspaceResolver['get']>): string[] {
  const roots = workspace.registration.roots;
  return [
    ...new Set([
      ...under(roots.focus, '**/*.txt'),
      ...under(roots.focus, '**/*.focus-plan.json'),
      'common/continuous_focus/**/*.txt',
      ...under(roots.scriptedGui, '**/*.txt'),
      'common/decisions/**/*.txt',
      'common/ideas/**/*.txt',
      'common/characters/**/*.txt',
      'common/scripted_effects/**/*.txt',
      'common/scripted_triggers/**/*.txt',
      'common/on_actions/**/*.txt',
      'common/operations/**/*.txt',
      'common/raids/**/*.txt',
      'common/bop/**/*.txt',
      'common/resistance_compliance_modifiers/**/*.txt',
      'common/special_projects/**/*.txt',
      'events/**/*.txt',
      'history/countries/**/*.txt',
      'history/states/**/*.txt',
      ...under(roots.states, '**/*.txt'),
      // Binary rasters and positional data tables are domain-selected by Agent
      // Nudger. The shared symbol scan retains only map sources it can index.
      ...under(roots.map, '**/*.map'),
      ...under(roots.map, '**/*.csv'),
      ...under(roots.map, '**/strategicregions/**/*.txt'),
      ...under(roots.map, '**/supply_nodes.txt'),
      ...under(roots.map, '**/railways.txt'),
      ...under(roots.interface, '**/*.{gui,gfx}'),
      ...under(roots.gfx, '**/*.gfx'),
      // Shared scans index the default player language. GUI scenario scans add
      // the explicitly requested language without retaining every translation.
      ...englishLocalisationPatterns(roots.localisation),
    ]),
  ].sort((left, right) => compareCodeUnits(left, right));
}

export class CoreEngine {
  readonly scanner: WorkspaceScanner;
  readonly artifacts: ArtifactStore;
  readonly transactions: TransactionManager;
  readonly #scanCache = new Map<string, ScanSnapshot>();
  readonly #scanFlights = new Map<string, ScanFlight>();
  readonly #scanGenerations = new Map<string, number>();
  readonly #scanAdmissionQueue: ScanAdmissionRequest[] = [];
  readonly #activeScanAdmissions = new Set<ScanAdmissionRequest>();

  public constructor(
    public readonly resolver: WorkspaceResolver,
    services: CoreEngineServices = {},
  ) {
    this.scanner =
      services.scanner ??
      new WorkspaceScanner(
        resolver.config().scanMaxFiles,
        resolver.config().scanMaxBytes,
        resolver.config().scanMaxFileBytes,
      );
    this.artifacts =
      services.artifacts ??
      new ArtifactStore(
        resolver.config().artifactMaxBytes,
        resolver.config().artifactMaxEntries,
        resolver.config().artifactMaxSingleBytes,
      );
    this.transactions =
      services.transactions ??
      new TransactionManager(
        resolver,
        this.artifacts,
        RECOVERY_TTL_SECONDS,
        RECOVERY_MAX_BYTES,
        RECOVERY_MAX_RECORDS,
        resolver.serverState(),
      );
  }

  async initialize(): Promise<void> {
    for (const workspace of this.resolver.list()) {
      // Recovery repairs an interrupted internal rewrite before the workspace is exposed.
      await this.transactions.recover(workspace.id);
    }
  }

  status(workspaceId: string, principal?: string): WorkspaceStatus {
    const workspace = this.resolver.get(workspaceId, principal);
    return {
      id: workspace.id,
      name: workspace.name,
      kind: workspace.registration.kind,
      writable: workspace.writeEnabled,
      rootKinds: [...new Set(workspace.roots.map(({ kind }) => kind))].sort((a, b) =>
        compareCodeUnits(a, b),
      ),
      dependencyCount: workspace.dependencyRoots.length,
      replacePaths: [...workspace.registration.replacePaths].sort((a, b) => compareCodeUnits(a, b)),
      replacementOwners: workspace.roots
        .filter(({ replacePaths }) => replacePaths.length > 0)
        .map(({ kind, loadOrder, replacePaths }) => ({
          rootKind: kind,
          loadOrder,
          paths: [...replacePaths].sort((a, b) => compareCodeUnits(a, b)),
        }))
        .sort(
          (left, right) =>
            left.loadOrder - right.loadOrder || compareCodeUnits(left.rootKind, right.rootKind),
        ),
      generatedDirectory: '.hoi4-agent',
    };
  }

  list(principal?: string): WorkspaceStatus[] {
    return this.resolver.list(principal).map(({ id }) => this.status(id, principal));
  }

  async scan(
    workspaceId: string,
    options: Partial<ScanOptions> = {},
    principal?: string,
    signal?: AbortSignal,
  ): Promise<ScanSnapshot> {
    signal?.throwIfAborted();
    const workspace = this.resolver.get(workspaceId, principal);
    const patterns = options.patterns ?? defaultPatterns(workspace);
    const ignore = options.ignore;
    const generation = this.#scanGenerations.get(workspaceId) ?? 0;
    const requestKey = `${workspaceId}:${generation}:${hashCanonical({
      patterns: [...patterns].sort(),
      ignore: [...(ignore ?? [])].sort(),
      rootKinds: [...(options.rootKinds ?? [])].sort(),
      maxFiles: options.maxFiles ?? this.resolver.config().scanMaxFiles,
      maxBytes: options.maxBytes ?? this.resolver.config().scanMaxBytes,
    })}`;
    let flight = this.#scanFlights.get(requestKey);
    if (flight === undefined) {
      const controller = new AbortController();
      const promise = (async (): Promise<ScanSnapshot> => {
        return this.withScanAdmission(controller.signal, async () => {
          const files = await this.scanner.scan(workspace, {
            patterns,
            ...(ignore === undefined ? {} : { ignore }),
            ...(options.rootKinds === undefined ? {} : { rootKinds: options.rootKinds }),
            ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
            ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          const revision = hashCanonical(
            files.map(({ displayPath, loadOrder, sha256 }) => ({ displayPath, loadOrder, sha256 })),
          );
          const cacheKey = `${requestKey}:${revision}`;
          const cached = this.#scanCache.get(cacheKey);
          if (cached !== undefined) return cached;
          const index = SymbolIndex.build(files);
          const snapshot = {
            workspaceId,
            revision,
            files,
            index,
            complete: index.complete,
            skippedSourceCount: index.skippedSourceCount,
            skippedSources: index.skippedSources,
            diagnostics: index.diagnostics,
          } satisfies ScanSnapshot;
          if ((this.#scanGenerations.get(workspaceId) ?? 0) === generation) {
            for (const key of this.#scanCache.keys()) {
              if (key.startsWith(`${workspaceId}:`)) this.#scanCache.delete(key);
            }
            this.#scanCache.set(cacheKey, snapshot);
          }
          return snapshot;
        });
      })();
      flight = { promise, controller, waiters: 0, settled: false };
      this.#scanFlights.set(requestKey, flight);
      const createdFlight = flight;
      void promise.then(
        () => {
          createdFlight.settled = true;
          if (this.#scanFlights.get(requestKey) === createdFlight) {
            this.#scanFlights.delete(requestKey);
          }
        },
        () => {
          createdFlight.settled = true;
          if (this.#scanFlights.get(requestKey) === createdFlight) {
            this.#scanFlights.delete(requestKey);
          }
        },
      );
    }
    return this.awaitScanFlight(requestKey, flight, signal);
  }

  invalidate(workspaceId: string): void {
    this.#scanGenerations.set(workspaceId, (this.#scanGenerations.get(workspaceId) ?? 0) + 1);
    for (const key of this.#scanCache.keys()) {
      if (key.startsWith(`${workspaceId}:`)) this.#scanCache.delete(key);
    }
    for (const [key, flight] of this.#scanFlights) {
      if (!key.startsWith(`${workspaceId}:`)) continue;
      this.#scanFlights.delete(key);
      flight.controller.abort();
    }
  }

  /** Monotonic cache generation used by domain services to invalidate derived snapshots. */
  generation(workspaceId: string): number {
    return this.#scanGenerations.get(workspaceId) ?? 0;
  }

  private awaitScanFlight(
    requestKey: string,
    flight: ScanFlight,
    signal?: AbortSignal,
  ): Promise<ScanSnapshot> {
    signal?.throwIfAborted();
    flight.waiters += 1;
    return new Promise<ScanSnapshot>((resolve, reject) => {
      let complete = false;
      const finish = (): void => {
        if (complete) return;
        complete = true;
        signal?.removeEventListener('abort', abort);
        flight.controller.signal.removeEventListener('abort', abortFlight);
        flight.waiters = Math.max(0, flight.waiters - 1);
        if (flight.waiters === 0 && !flight.settled) {
          if (this.#scanFlights.get(requestKey) === flight) this.#scanFlights.delete(requestKey);
          flight.controller.abort();
        }
      };
      const abort = (): void => {
        reject(
          signal === undefined
            ? new DOMException('The operation was aborted', 'AbortError')
            : abortReason(signal),
        );
        finish();
      };
      const abortFlight = (): void => {
        reject(abortReason(flight.controller.signal));
        finish();
      };
      signal?.addEventListener('abort', abort, { once: true });
      flight.controller.signal.addEventListener('abort', abortFlight, { once: true });
      if (signal?.aborted === true) {
        abort();
        return;
      }
      if (flight.controller.signal.aborted) {
        abortFlight();
        return;
      }
      void flight.promise.then(
        (snapshot) => {
          if (complete) return;
          finish();
          resolve(snapshot);
        },
        (error: unknown) => {
          if (complete) return;
          reject(scanFailureReason(error));
          finish();
        },
      );
    });
  }

  private withScanAdmission<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const request: ScanAdmissionRequest = {
        signal,
        started: false,
        settled: false,
        reject,
        run: () => {
          request.started = true;
          this.#activeScanAdmissions.add(request);
          void Promise.resolve()
            .then(() => {
              signal.throwIfAborted();
              return action();
            })
            .then(resolve, reject)
            .finally(() => {
              request.settled = true;
              signal.removeEventListener('abort', onAbort);
              this.#activeScanAdmissions.delete(request);
              this.drainScanAdmissionQueue();
            });
        },
      };
      const onAbort = (): void => {
        if (!request.started && !request.settled) {
          request.settled = true;
          request.reject(abortReason(signal));
        }
        this.drainScanAdmissionQueue();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.#scanAdmissionQueue.push(request);
      this.drainScanAdmissionQueue();
    });
  }

  private drainScanAdmissionQueue(): void {
    while (this.#scanAdmissionQueue.length > 0) {
      const request = this.#scanAdmissionQueue[0];
      if (request === undefined) return;
      if (request.settled || request.signal.aborted) {
        this.#scanAdmissionQueue.shift();
        if (!request.settled) {
          request.settled = true;
          request.reject(abortReason(request.signal));
        }
        continue;
      }

      if (this.#activeScanAdmissions.size > 0) {
        // Normal scans remain globally serialized. A single replacement may
        // bypass an admitted scan only after that physical scan has been
        // aborted. Keeping the physical-call ceiling at two prevents repeated
        // invalidations from accumulating an unbounded number of scanners that
        // ignore AbortSignal.
        if (this.#activeScanAdmissions.size >= 2) return;
        const active = this.#activeScanAdmissions.values().next().value;
        if (active?.signal.aborted !== true) return;
      }

      this.#scanAdmissionQueue.shift();
      request.run();
    }
  }

  indexFiles(files: readonly ScannedFile[]): SymbolIndex {
    return SymbolIndex.build(files);
  }
}
