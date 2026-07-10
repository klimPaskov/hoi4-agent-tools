import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import {
  WORKSPACE_MAX_REGISTRATIONS,
  type ServerConfiguration,
  type WorkspaceRegistration,
} from './configuration.js';
import {
  compareCodeUnits,
  canonicalJson,
  hashCanonical,
  secureId,
  sha256Bytes,
} from './canonical.js';
import { ServiceError } from './result.js';
import { ServerState } from './server-state.js';

export type RootAccess = 'read' | 'write';
export type RootKind = 'mod' | 'game' | 'dependency' | 'artifact' | 'cache' | 'fixture';

export interface ResolvedRoot {
  kind: RootKind;
  path: string;
  writable: boolean;
  loadOrder: number;
  replacePaths: string[];
}

export interface ResolvedWorkspace {
  id: string;
  name: string;
  registration: WorkspaceRegistration;
  roots: ResolvedRoot[];
  modRoot: string;
  gameRoot?: string;
  dependencyRoots: string[];
  artifactRoot: string;
  cacheRoot: string;
  fixtureRoot?: string;
  writeEnabled: boolean;
  /** SHA-256 binding for the canonical root topology and source-resolution behavior. */
  workspaceIdentity: string;
  /** Shared configured-workspace identity or principal-scoped runtime owner identity. */
  ownerIdentity: string;
}

interface RuntimeOwner {
  principal: string | undefined;
  signal?: AbortSignal;
}

interface RuntimeRegistrationClaim {
  version: 1;
  workspaceIdentity: string;
  ownerIdentity: string;
  claimHash: string;
}

const runtimeRegistrationClaimFile = '.runtime-registration-owner.json';
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const runtimeRegistrationClaimSchema = z
  .object({
    version: z.literal(1),
    workspaceIdentity: sha256Schema,
    ownerIdentity: sha256Schema,
    claimHash: sha256Schema,
  })
  .strict();

async function exists(value: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  try {
    await lstat(value);
    signal?.throwIfAborted();
    return true;
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    return false;
  }
}

export async function canonicalPath(input: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const absolute = path.resolve(input);
  if (await exists(absolute, signal)) {
    const canonical = path.normalize(await realpath(absolute));
    signal?.throwIfAborted();
    return canonical;
  }

  const suffix: string[] = [];
  let cursor = absolute;
  while (!(await exists(cursor, signal))) {
    signal?.throwIfAborted();
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new ServiceError(
        'PATH_NO_EXISTING_ANCESTOR',
        `Path has no existing ancestor: ${input}`,
      );
    }
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const canonical = path.normalize(path.join(await realpath(cursor), ...suffix));
  signal?.throwIfAborted();
  return canonical;
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

/**
 * Hash the resolved root topology without persisting canonical host paths. Canonicalization happens
 * before this function is called, so filesystem aliases converge on the same stable identity.
 */
export function resolvedWorkspaceIdentity(
  workspace: Pick<ResolvedWorkspace, 'id' | 'registration' | 'roots'>,
): string {
  return hashCanonical({
    id: workspace.id,
    roots: workspace.roots.map(({ kind, path: rootPath, loadOrder, writable, replacePaths }) => ({
      kind,
      rootHash: sha256Bytes(process.platform === 'win32' ? rootPath.toLowerCase() : rootPath),
      loadOrder,
      writable,
      replacePaths,
    })),
    behavior: {
      kind: workspace.registration.kind,
      relativeRoots: workspace.registration.roots,
      replacePaths: [...workspace.registration.replacePaths].sort((left, right) =>
        compareCodeUnits(left, right),
      ),
    },
  });
}

function configuredOwnerIdentity(workspaceIdentity: string): string {
  return hashCanonical({
    domain: 'hoi4-agent-configured-workspace-owner-v1',
    workspaceIdentity,
  });
}

function runtimeOwnerIdentity(workspaceIdentity: string, principal?: string): string {
  return hashCanonical({
    domain: 'hoi4-agent-runtime-workspace-owner-v1',
    workspaceIdentity,
    principal: principal ?? null,
  });
}

function runtimeClaimHash(claim: Omit<RuntimeRegistrationClaim, 'claimHash'>): string {
  return hashCanonical(claim);
}

function registrationClaimConflict(): ServiceError {
  return new ServiceError(
    'WORKSPACE_REGISTRATION_CONFLICT',
    'Runtime workspace registration conflicts with an existing registration',
  );
}

async function readRuntimeRegistrationClaim(
  claimPath: string,
  signal?: AbortSignal,
): Promise<RuntimeRegistrationClaim | undefined> {
  signal?.throwIfAborted();
  let claimStatus;
  try {
    claimStatus = await lstat(claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw registrationClaimConflict();
  }
  signal?.throwIfAborted();
  if (claimStatus.isSymbolicLink() || !claimStatus.isFile() || claimStatus.size > 4_096) {
    throw registrationClaimConflict();
  }

  let parsed: unknown;
  try {
    const text =
      signal === undefined
        ? await readFile(claimPath, 'utf8')
        : await readFile(claimPath, { encoding: 'utf8', signal });
    signal?.throwIfAborted();
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw registrationClaimConflict();
  }
  signal?.throwIfAborted();
  const validated = runtimeRegistrationClaimSchema.safeParse(parsed);
  if (!validated.success) throw registrationClaimConflict();
  const claim = validated.data;
  if (
    runtimeClaimHash({
      version: claim.version,
      workspaceIdentity: claim.workspaceIdentity,
      ownerIdentity: claim.ownerIdentity,
    }) !== claim.claimHash
  ) {
    throw registrationClaimConflict();
  }
  return claim;
}

async function assertRuntimeRegistrationClaim(
  workspace: ResolvedWorkspace,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const claimRoot = await containedGeneratedPath(workspace.artifactRoot);
  signal?.throwIfAborted();
  const claimPath = path.join(claimRoot, runtimeRegistrationClaimFile);
  const expectedWithoutHash = {
    version: 1 as const,
    workspaceIdentity: workspace.workspaceIdentity,
    ownerIdentity: workspace.ownerIdentity,
  };
  const expected: RuntimeRegistrationClaim = {
    ...expectedWithoutHash,
    claimHash: runtimeClaimHash(expectedWithoutHash),
  };
  const assertMatches = (claim: RuntimeRegistrationClaim): void => {
    if (
      claim.workspaceIdentity !== expected.workspaceIdentity ||
      claim.ownerIdentity !== expected.ownerIdentity ||
      claim.claimHash !== expected.claimHash
    ) {
      throw registrationClaimConflict();
    }
  };

  const existing = await readRuntimeRegistrationClaim(claimPath, signal);
  if (existing !== undefined) {
    assertMatches(existing);
    return;
  }

  signal?.throwIfAborted();
  const temporaryPath = path.join(claimRoot, `.runtime-registration-${secureId('claim')}.tmp`);
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporaryHandle = await open(temporaryPath, 'wx', 0o600);
    await temporaryHandle.writeFile(`${canonicalJson(expected)}\n`, 'utf8');
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    signal?.throwIfAborted();
    try {
      // A hard link publishes fully flushed bytes without replacing a competing claim.
      await link(temporaryPath, claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw registrationClaimConflict();
      }
      const racedClaim = await readRuntimeRegistrationClaim(claimPath, signal);
      if (racedClaim === undefined) throw registrationClaimConflict();
      assertMatches(racedClaim);
    }
  } catch (error) {
    if (error instanceof ServiceError || (error as Error).name === 'AbortError') throw error;
    throw registrationClaimConflict();
  } finally {
    await temporaryHandle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) return true;
  }
  return false;
}

export function isPortablePathSegment(segment: string): boolean {
  const windowsDevice =
    /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))(?:\.|$)/iu;
  return (
    segment.length > 0 &&
    !containsAsciiControlCharacter(segment) &&
    !/[<>:"|?*]/u.test(segment) &&
    !windowsDevice.test(segment) &&
    !/[. ]$/u.test(segment)
  );
}

/** Resolve a generated-storage descendant without permitting an existing link to escape its root. */
export async function containedGeneratedPath(root: string, ...segments: string[]): Promise<string> {
  const candidate = await canonicalPath(path.join(root, ...segments));
  if (!isWithin(root, candidate)) {
    throw new ServiceError(
      'PATH_GENERATED_ROOT_ESCAPE',
      'Generated storage path escapes its configured root',
    );
  }
  return candidate;
}

function assertRelative(relativePath: string): void {
  if (relativePath.length === 0)
    throw new ServiceError('PATH_EMPTY', 'Workspace-relative path cannot be empty');
  if (relativePath.includes('\0')) throw new ServiceError('PATH_NUL', 'Path contains a NUL byte');
  if (path.isAbsolute(relativePath)) {
    throw new ServiceError('PATH_ABSOLUTE_REJECTED', 'Only workspace-relative paths are accepted');
  }
  const segments = relativePath.replaceAll('\\', '/').split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new ServiceError('PATH_TRAVERSAL', 'Parent path segments are not allowed', {
      relativePath,
    });
  }
  if (segments.some((segment) => segment.includes(':'))) {
    throw new ServiceError(
      'PATH_ALTERNATE_STREAM',
      'Colon characters and alternate data streams are not allowed',
      {
        relativePath,
      },
    );
  }
  if (
    segments.some(
      (segment) => segment !== '.' && segment.length > 0 && !isPortablePathSegment(segment),
    )
  ) {
    throw new ServiceError(
      'PATH_WINDOWS_DEVICE',
      'Portable paths cannot contain device names, control characters, or ambiguous characters',
      {
        relativePath,
      },
    );
  }
}

export class WorkspaceResolver {
  readonly #byId = new Map<string, ResolvedWorkspace>();
  readonly #runtimePrincipalWorkspaces = new Map<string, Set<string>>();
  readonly #runtimeWorkspaceIds = new Set<string>();
  readonly #runtimeWorkspaceOwners = new Map<string, string | undefined>();
  #registrationRoots: string[] = [];
  #registrationLexicalRoots: string[] = [];
  #writableRegistrationRoots: string[] = [];
  #writableRegistrationLexicalRoots: string[] = [];
  #storageRoots: string[] = [];
  #storageLexicalRoots: string[] = [];
  #serverStateRoot?: string;
  #serverState?: ServerState;
  #registrationQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly configuration: ServerConfiguration) {}

  static async create(configuration: ServerConfiguration): Promise<WorkspaceResolver> {
    const resolver = new WorkspaceResolver(configuration);
    if (configuration.serverStateRoot !== undefined) {
      resolver.#serverStateRoot = await canonicalPath(configuration.serverStateRoot);
    }
    resolver.#registrationLexicalRoots = configuration.registrationRoots.map((root) =>
      path.normalize(path.resolve(root)),
    );
    resolver.#registrationRoots = await Promise.all(
      configuration.registrationRoots.map((root) => canonicalPath(root)),
    );
    resolver.#writableRegistrationLexicalRoots = configuration.writableRegistrationRoots.map(
      (root) => path.normalize(path.resolve(root)),
    );
    resolver.#writableRegistrationRoots = await Promise.all(
      configuration.writableRegistrationRoots.map((root) => canonicalPath(root)),
    );
    for (const candidate of resolver.#writableRegistrationLexicalRoots) {
      if (!resolver.#registrationLexicalRoots.some((root) => isWithin(root, candidate))) {
        throw new ServiceError(
          'WORKSPACE_WRITABLE_REGISTRATION_ROOT_FORBIDDEN',
          'Writable runtime registration roots must be lexical descendants of registration roots',
        );
      }
    }
    for (const candidate of resolver.#writableRegistrationRoots) {
      if (!resolver.#registrationRoots.some((root) => isWithin(root, candidate))) {
        throw new ServiceError(
          'WORKSPACE_WRITABLE_REGISTRATION_ROOT_FORBIDDEN',
          'Writable runtime registration roots must resolve beneath registration roots',
        );
      }
    }
    resolver.#storageLexicalRoots = configuration.storageRoots.map((root) =>
      path.normalize(path.resolve(root)),
    );
    resolver.#storageRoots = await Promise.all(
      configuration.storageRoots.map((root) => canonicalPath(root)),
    );
    if (resolver.#serverStateRoot !== undefined) {
      for (const root of [
        ...resolver.#registrationRoots,
        ...resolver.#writableRegistrationRoots,
        ...resolver.#storageRoots,
      ]) {
        if (pathsOverlap(resolver.#serverStateRoot, root)) {
          throw new ServiceError(
            'SERVER_STATE_ROOT_OVERLAP',
            'Server state root must not overlap a registration or generated-storage capability root',
          );
        }
      }
    }
    for (const registration of configuration.workspaces) {
      const workspace = await resolver.resolveRegistration(registration);
      if (resolver.#byId.has(workspace.id)) {
        throw new ServiceError('WORKSPACE_DUPLICATE', `Duplicate workspace ID: ${workspace.id}`);
      }
      resolver.assertWorkspaceIsolation(workspace);
      resolver.#byId.set(workspace.id, workspace);
    }
    if (configuration.serverStateRoot !== undefined) {
      resolver.#serverState = await ServerState.create(configuration.serverStateRoot);
      resolver.#serverStateRoot = resolver.#serverState.root;
    }
    return resolver;
  }

  config(): ServerConfiguration {
    return this.configuration;
  }

  serverState(): ServerState | undefined {
    return this.#serverState;
  }

  async register(
    registration: WorkspaceRegistration,
    principal?: string,
    signal?: AbortSignal,
  ): Promise<ResolvedWorkspace> {
    signal?.throwIfAborted();
    let release!: () => void;
    const previous = this.#registrationQueue;
    this.#registrationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    signal?.throwIfAborted();
    try {
      return await this.registerExclusive(registration, principal, signal);
    } finally {
      release();
    }
  }

  private async registerExclusive(
    registration: WorkspaceRegistration,
    principal?: string,
    signal?: AbortSignal,
  ): Promise<ResolvedWorkspace> {
    signal?.throwIfAborted();
    if (principal !== undefined && !this.registrationAllowed(principal)) {
      throw new ServiceError(
        'WORKSPACE_REGISTRATION_FORBIDDEN',
        'Principal cannot register workspaces',
      );
    }
    const registrationConflict = (code: string, message: string): ServiceError =>
      principal === undefined
        ? new ServiceError(code, message)
        : new ServiceError(
            'WORKSPACE_REGISTRATION_CONFLICT',
            'Runtime workspace registration conflicts with an existing registration',
          );
    if (this.#byId.has(registration.id)) {
      throw registrationConflict(
        'WORKSPACE_DUPLICATE',
        `Workspace ID is already registered: ${registration.id}`,
      );
    }
    if (this.#byId.size >= WORKSPACE_MAX_REGISTRATIONS) {
      throw registrationConflict(
        'WORKSPACE_REGISTRATION_LIMIT',
        'Workspace registration limit has been reached',
      );
    }
    this.assertLexicalRegistrationPath(
      registration.root,
      'workspace root',
      'WORKSPACE_REGISTRATION_ROOT_FORBIDDEN',
    );
    if (registration.kind === 'mod') this.assertLexicalWritableRegistrationPath(registration.root);
    const candidateRoot = await canonicalPath(registration.root, signal);
    signal?.throwIfAborted();
    if (!this.#registrationRoots.some((root) => isWithin(root, candidateRoot))) {
      throw new ServiceError(
        'WORKSPACE_REGISTRATION_ROOT_FORBIDDEN',
        'Workspace is outside configured registration roots',
        {
          workspaceId: registration.id,
        },
      );
    }
    if (
      registration.kind === 'mod' &&
      !this.#writableRegistrationRoots.some((root) => isWithin(root, candidateRoot))
    ) {
      throw new ServiceError(
        'WORKSPACE_REGISTRATION_ROOT_FORBIDDEN',
        'Runtime mod roots require an operator-approved writable registration root',
      );
    }
    const readRoots = [
      registration.gameRoot,
      ...registration.dependencyRoots,
      ...registration.dependencies.map(({ root }) => root),
      registration.fixtureRoot,
    ].filter((value): value is string => value !== undefined);
    const canonicalReadRoots: string[] = [];
    for (const requestedRoot of readRoots) {
      signal?.throwIfAborted();
      this.assertLexicalRegistrationPath(
        requestedRoot,
        'workspace source root',
        'WORKSPACE_REGISTRATION_SOURCE_ROOT_FORBIDDEN',
      );
      const candidate = await canonicalPath(requestedRoot, signal);
      if (!this.#registrationRoots.some((root) => isWithin(root, candidate))) {
        throw new ServiceError(
          'WORKSPACE_REGISTRATION_SOURCE_ROOT_FORBIDDEN',
          'A requested game, dependency, or fixture root is outside configured registration roots',
          { workspaceId: registration.id },
        );
      }
      canonicalReadRoots.push(candidate);
    }

    for (const existing of this.#byId.values()) {
      signal?.throwIfAborted();
      if (existing.roots.some((root) => pathsOverlap(candidateRoot, root.path))) {
        throw registrationConflict(
          'WORKSPACE_REGISTRATION_ROOT_OVERLAP',
          'Runtime workspace root overlaps an existing registered workspace root',
        );
      }
      const protectedRoots = existing.roots.filter((root) =>
        ['mod', 'artifact', 'cache'].includes(root.kind),
      );
      if (
        canonicalReadRoots.some((requestedRoot) =>
          protectedRoots.some((root) => pathsOverlap(requestedRoot, root.path)),
        )
      ) {
        throw registrationConflict(
          'WORKSPACE_REGISTRATION_SOURCE_OVERLAP',
          'Runtime source root overlaps an existing workspace-owned root',
        );
      }
    }
    for (const [index, requestedRoot] of canonicalReadRoots.entries()) {
      signal?.throwIfAborted();
      if (
        pathsOverlap(candidateRoot, requestedRoot) ||
        canonicalReadRoots
          .slice(0, index)
          .some((existingRequestedRoot) => pathsOverlap(requestedRoot, existingRequestedRoot))
      ) {
        throw new ServiceError(
          'WORKSPACE_REGISTRATION_INTERNAL_OVERLAP',
          'Runtime workspace roots must be distinct and non-overlapping',
          { workspaceId: registration.id },
        );
      }
    }
    const generatedCandidates = new Map<'artifacts' | 'cache', string>();
    for (const [generatedKind, configuredRoot] of [
      ['artifacts', registration.artifactRoot],
      ['cache', registration.cacheRoot],
    ] as const) {
      signal?.throwIfAborted();
      const generatedRoot =
        configuredRoot ??
        (registration.kind === 'mod'
          ? path.join(registration.root, '.hoi4-agent', generatedKind)
          : undefined);
      if (generatedRoot === undefined) continue;
      this.assertLexicalGeneratedPath(registration, generatedRoot, generatedKind);
      const candidate = await canonicalPath(generatedRoot, signal);
      const relativeToPrimary = path
        .relative(candidateRoot, candidate)
        .replaceAll('\\', '/')
        .toLowerCase();
      const allowed =
        (registration.kind === 'mod' &&
          isWithin(candidateRoot, candidate) &&
          (relativeToPrimary === `.hoi4-agent/${generatedKind}` ||
            relativeToPrimary.startsWith(`.hoi4-agent/${generatedKind}/`))) ||
        this.#storageRoots.some((root) => isWithin(root, candidate));
      if (!allowed) {
        throw new ServiceError(
          'WORKSPACE_REGISTRATION_GENERATED_ROOT_FORBIDDEN',
          'Runtime artifact and cache roots must remain inside the registered workspace',
          { workspaceId: registration.id },
        );
      }
      generatedCandidates.set(generatedKind, candidate);
    }
    const artifactCandidate = generatedCandidates.get('artifacts');
    const cacheCandidate = generatedCandidates.get('cache');
    if (
      artifactCandidate !== undefined &&
      cacheCandidate !== undefined &&
      pathsOverlap(artifactCandidate, cacheCandidate)
    ) {
      throw new ServiceError(
        'WORKSPACE_REGISTRATION_GENERATED_ROOT_FORBIDDEN',
        'Runtime artifact and cache roots must be distinct and non-overlapping',
        { workspaceId: registration.id },
      );
    }
    for (const candidate of generatedCandidates.values()) {
      signal?.throwIfAborted();
      const overlapsOwnSources =
        (registration.kind !== 'mod' && pathsOverlap(candidateRoot, candidate)) ||
        (registration.kind === 'mod' &&
          !isWithin(candidateRoot, candidate) &&
          pathsOverlap(candidateRoot, candidate)) ||
        canonicalReadRoots.some((sourceRoot) => pathsOverlap(sourceRoot, candidate));
      if (overlapsOwnSources) {
        throw new ServiceError(
          'WORKSPACE_REGISTRATION_GENERATED_ROOT_FORBIDDEN',
          'Runtime generated storage must not overlap a source root',
          { workspaceId: registration.id },
        );
      }
      if (
        [...this.#byId.values()].some((existing) =>
          existing.roots.some((root) => pathsOverlap(candidate, root.path)),
        )
      ) {
        throw registrationConflict(
          'WORKSPACE_REGISTRATION_GENERATED_ROOT_OVERLAP',
          'Runtime generated storage overlaps an existing workspace root',
        );
      }
    }
    const workspace = await this.resolveRegistration(registration, {
      principal,
      ...(signal === undefined ? {} : { signal }),
    });
    signal?.throwIfAborted();
    if (this.#byId.has(registration.id)) {
      throw registrationConflict(
        'WORKSPACE_DUPLICATE',
        `Workspace ID is already registered: ${registration.id}`,
      );
    }
    this.assertResolvedRuntimeRegistration(workspace);
    try {
      this.assertWorkspaceIsolation(workspace);
    } catch (error) {
      if (principal !== undefined && error instanceof ServiceError) {
        throw registrationConflict(error.code, error.message);
      }
      throw error;
    }
    signal?.throwIfAborted();
    await assertRuntimeRegistrationClaim(workspace, signal);
    signal?.throwIfAborted();
    this.#byId.set(workspace.id, workspace);
    this.#runtimeWorkspaceIds.add(workspace.id);
    this.#runtimeWorkspaceOwners.set(workspace.id, principal);
    if (principal !== undefined) {
      const ids = this.#runtimePrincipalWorkspaces.get(principal) ?? new Set<string>();
      ids.add(workspace.id);
      this.#runtimePrincipalWorkspaces.set(principal, ids);
    }
    return workspace;
  }

  unregisterRuntime(workspaceId: string, principal?: string): void {
    if (
      this.#runtimeWorkspaceIds.has(workspaceId) &&
      this.#runtimeWorkspaceOwners.get(workspaceId) !== principal
    ) {
      throw new ServiceError(
        'WORKSPACE_INACCESSIBLE',
        'Workspace is unavailable to the authenticated principal',
      );
    }
    if (!this.#runtimeWorkspaceIds.delete(workspaceId)) return;
    this.#runtimeWorkspaceOwners.delete(workspaceId);
    this.#byId.delete(workspaceId);
    if (principal !== undefined) {
      const ids = this.#runtimePrincipalWorkspaces.get(principal);
      ids?.delete(workspaceId);
      if (ids?.size === 0) this.#runtimePrincipalWorkspaces.delete(principal);
    }
  }

  list(principal?: string): ResolvedWorkspace[] {
    const allowed = principal === undefined ? undefined : this.allowedWorkspaceIds(principal);
    return [...this.#byId.values()]
      .filter((workspace) => allowed === undefined || allowed.has(workspace.id))
      .sort((a, b) => compareCodeUnits(a.id, b.id));
  }

  get(workspaceId: string, principal?: string): ResolvedWorkspace {
    if (principal !== undefined && !this.allowedWorkspaceIds(principal).has(workspaceId)) {
      throw new ServiceError(
        'WORKSPACE_INACCESSIBLE',
        'Workspace is unavailable to the authenticated principal',
      );
    }
    const workspace = this.#byId.get(workspaceId);
    if (workspace === undefined) {
      if (principal !== undefined) {
        throw new ServiceError(
          'WORKSPACE_INACCESSIBLE',
          'Workspace is unavailable to the authenticated principal',
        );
      }
      throw new ServiceError(
        'WORKSPACE_NOT_REGISTERED',
        `Workspace is not registered: ${workspaceId}`,
      );
    }
    return workspace;
  }

  async resolvePath(
    workspaceId: string,
    relativePath: string,
    access: RootAccess,
    rootKinds?: readonly RootKind[],
    principal?: string,
  ): Promise<{ path: string; root: ResolvedRoot }> {
    assertRelative(relativePath);
    const workspace = this.get(workspaceId, principal);
    const firstSegment = path.posix
      .normalize(relativePath.replaceAll('\\', '/'))
      .split('/')
      .find((segment) => segment !== '.' && segment.length > 0)
      ?.toLowerCase();
    if (access === 'write' && firstSegment === '.hoi4-agent') {
      throw new ServiceError(
        'PATH_GENERATED_STORAGE_RESERVED',
        'Generated .hoi4-agent storage cannot be targeted as mod source',
      );
    }
    const roots = workspace.roots.filter(
      (root) =>
        (rootKinds === undefined || rootKinds.includes(root.kind)) &&
        (access === 'read' || root.writable),
    );
    for (const root of roots.sort((a, b) => b.loadOrder - a.loadOrder)) {
      const candidate = await canonicalPath(path.join(root.path, relativePath));
      if (!isWithin(root.path, candidate)) continue;
      if (access === 'read' && !(await exists(candidate))) continue;
      if (access === 'write') {
        if (
          root.kind === 'mod' &&
          (pathsOverlap(workspace.artifactRoot, candidate) ||
            pathsOverlap(workspace.cacheRoot, candidate))
        ) {
          throw new ServiceError(
            'PATH_GENERATED_STORAGE_RESERVED',
            'Artifact and cache storage cannot be targeted as mod source',
          );
        }
        const existingParent = await canonicalPath(path.dirname(candidate));
        if (!isWithin(root.path, existingParent)) continue;
      }
      return { path: candidate, root };
    }
    throw new ServiceError(
      access === 'write' ? 'PATH_WRITE_OUTSIDE_ROOTS' : 'PATH_NOT_FOUND_IN_ROOTS',
      `Path cannot be resolved for ${access} access`,
      { workspaceId, relativePath, rootKinds },
    );
  }

  async resolvePathInRoot(
    workspaceId: string,
    relativePath: string,
    rootKind: RootKind,
    loadOrder: number,
    principal?: string,
  ): Promise<{ path: string; root: ResolvedRoot }> {
    assertRelative(relativePath);
    const workspace = this.get(workspaceId, principal);
    const root = workspace.roots.find(
      (candidate) => candidate.kind === rootKind && candidate.loadOrder === loadOrder,
    );
    if (root === undefined) {
      throw new ServiceError('PATH_ROOT_NOT_FOUND', 'Configured source root no longer exists', {
        workspaceId,
        rootKind,
        loadOrder,
      });
    }
    const candidate = await canonicalPath(path.join(root.path, relativePath));
    if (!isWithin(root.path, candidate) || !(await exists(candidate))) {
      throw new ServiceError(
        'PATH_NOT_FOUND_IN_ROOT',
        'Path cannot be resolved in the selected source root',
        {
          workspaceId,
          relativePath,
          rootKind,
          loadOrder,
        },
      );
    }
    return { path: candidate, root };
  }

  private allowedWorkspaceIds(principal: string): Set<string> {
    const token = this.configuration.http.tokens.find((entry) => entry.principal === principal);
    const oauth = this.configuration.http.principals.find((entry) => entry.principal === principal);
    return new Set([
      ...(token?.workspaceIds ?? []),
      ...(oauth?.workspaceIds ?? []),
      ...(this.#runtimePrincipalWorkspaces.get(principal) ?? []),
    ]);
  }

  private registrationAllowed(principal: string): boolean {
    return (
      this.configuration.http.tokens.some(
        (entry) => entry.principal === principal && entry.allowRegistration,
      ) ||
      this.configuration.http.principals.some(
        (entry) => entry.principal === principal && entry.allowRegistration,
      )
    );
  }

  private assertLexicalRegistrationPath(value: string, label: string, code: string): void {
    const candidate = path.normalize(path.resolve(value));
    if (!this.#registrationLexicalRoots.some((root) => isWithin(root, candidate))) {
      throw new ServiceError(
        code,
        `Runtime ${label} is lexically outside configured registration roots`,
      );
    }
  }

  private assertLexicalWritableRegistrationPath(value: string): void {
    const candidate = path.normalize(path.resolve(value));
    if (!this.#writableRegistrationLexicalRoots.some((root) => isWithin(root, candidate))) {
      throw new ServiceError(
        'WORKSPACE_REGISTRATION_ROOT_FORBIDDEN',
        'Runtime mod roots are lexically outside operator-approved writable registration roots',
      );
    }
  }

  private assertLexicalGeneratedPath(
    registration: WorkspaceRegistration,
    value: string,
    generatedKind: 'artifacts' | 'cache',
  ): void {
    const candidate = path.normalize(path.resolve(value));
    const primary = path.normalize(path.resolve(registration.root));
    const expectedRoot = path.join(primary, '.hoi4-agent', generatedKind);
    const insideWritableMod = registration.kind === 'mod' && isWithin(expectedRoot, candidate);
    const insideStorage = this.#storageLexicalRoots.some((root) => isWithin(root, candidate));
    if (!insideWritableMod && !insideStorage) {
      throw new ServiceError(
        'WORKSPACE_REGISTRATION_GENERATED_ROOT_FORBIDDEN',
        'Runtime generated storage is outside the writable mod or configured storage roots',
      );
    }
  }

  private assertResolvedRuntimeRegistration(workspace: ResolvedWorkspace): void {
    const allowed = (candidate: string): boolean =>
      this.#registrationRoots.some((root) => isWithin(root, candidate));
    if (!allowed(workspace.modRoot)) {
      throw new ServiceError(
        'WORKSPACE_REGISTRATION_ROOT_FORBIDDEN',
        'Resolved runtime workspace is outside configured registration roots',
      );
    }
    if (
      workspace.registration.kind === 'mod' &&
      !this.#writableRegistrationRoots.some((root) => isWithin(root, workspace.modRoot))
    ) {
      throw new ServiceError(
        'WORKSPACE_REGISTRATION_ROOT_FORBIDDEN',
        'Resolved runtime mod root is outside operator-approved writable registration roots',
      );
    }
    for (const root of workspace.roots.filter((candidate) =>
      ['game', 'dependency', 'fixture'].includes(candidate.kind),
    )) {
      if (!allowed(root.path)) {
        throw new ServiceError(
          'WORKSPACE_REGISTRATION_SOURCE_ROOT_FORBIDDEN',
          'Resolved runtime source is outside configured registration roots',
        );
      }
    }
    const generatedAllowed = (candidate: string, generatedKind: 'artifacts' | 'cache'): boolean =>
      (workspace.registration.kind === 'mod' &&
        isWithin(path.join(workspace.modRoot, '.hoi4-agent', generatedKind), candidate)) ||
      this.#storageRoots.some((root) => isWithin(root, candidate));
    if (
      !generatedAllowed(workspace.artifactRoot, 'artifacts') ||
      !generatedAllowed(workspace.cacheRoot, 'cache')
    ) {
      throw new ServiceError(
        'WORKSPACE_REGISTRATION_GENERATED_ROOT_FORBIDDEN',
        'Resolved runtime generated storage must remain inside its workspace',
      );
    }
  }

  private assertWorkspaceIsolation(workspace: ResolvedWorkspace): void {
    const readRoots = workspace.roots.filter((root) =>
      ['game', 'dependency', 'fixture'].includes(root.kind),
    );
    const ownedRoots = workspace.roots.filter((root) =>
      ['mod', 'artifact', 'cache'].includes(root.kind),
    );
    for (const existing of this.#byId.values()) {
      if (existing.roots.some((root) => pathsOverlap(workspace.modRoot, root.path))) {
        throw new ServiceError(
          'WORKSPACE_ROOT_OVERLAP',
          'Configured workspace root overlaps another registered workspace root',
          { workspaceId: workspace.id },
        );
      }
      if (
        ownedRoots.some((owned) =>
          existing.roots.some((existingRoot) => pathsOverlap(owned.path, existingRoot.path)),
        )
      ) {
        throw new ServiceError(
          'WORKSPACE_GENERATED_ROOT_OVERLAP',
          'Workspace-owned source or generated storage overlaps another registered workspace',
          { workspaceId: workspace.id },
        );
      }
      const protectedRoots = existing.roots.filter((root) =>
        ['mod', 'artifact', 'cache'].includes(root.kind),
      );
      if (
        readRoots.some((requestedRoot) =>
          protectedRoots.some((root) => pathsOverlap(requestedRoot.path, root.path)),
        )
      ) {
        throw new ServiceError(
          'WORKSPACE_SOURCE_OVERLAP',
          'Configured source root overlaps another workspace-owned root',
          { workspaceId: workspace.id },
        );
      }
    }
  }

  private async resolveRegistration(
    registration: WorkspaceRegistration,
    runtimeOwner?: RuntimeOwner,
  ): Promise<ResolvedWorkspace> {
    const signal = runtimeOwner?.signal;
    signal?.throwIfAborted();
    const modRoot = await canonicalPath(registration.root, signal);
    if (!(await exists(modRoot, signal))) {
      throw new ServiceError(
        'WORKSPACE_ROOT_MISSING',
        `Workspace root does not exist: ${registration.root}`,
      );
    }
    const gameRoot =
      registration.gameRoot === undefined
        ? undefined
        : await canonicalPath(registration.gameRoot, signal);
    const dependencyRegistrations =
      registration.dependencies.length > 0
        ? registration.dependencies
        : registration.dependencyRoots.map((root) => ({ root, replacePaths: [] }));
    const dependencyRoots = await Promise.all(
      dependencyRegistrations.map(({ root }) => canonicalPath(root, signal)),
    );
    signal?.throwIfAborted();
    if (
      registration.kind !== 'mod' &&
      (registration.artifactRoot === undefined || registration.cacheRoot === undefined)
    ) {
      throw new ServiceError(
        'WORKSPACE_GENERATED_ROOT_REQUIRED',
        'Read-only game and dependency workspaces require explicit operator-owned storage roots',
        { workspaceId: registration.id },
      );
    }
    const artifactRoot = await canonicalPath(
      registration.artifactRoot ?? path.join(modRoot, '.hoi4-agent', 'artifacts'),
      signal,
    );
    const cacheRoot = await canonicalPath(
      registration.cacheRoot ?? path.join(modRoot, '.hoi4-agent', 'cache'),
      signal,
    );
    const fixtureRoot =
      registration.fixtureRoot === undefined
        ? undefined
        : await canonicalPath(registration.fixtureRoot, signal);
    signal?.throwIfAborted();
    const generatedAllowed = (candidate: string, generatedKind: 'artifacts' | 'cache'): boolean =>
      (registration.kind === 'mod' &&
        isWithin(path.join(modRoot, '.hoi4-agent', generatedKind), candidate)) ||
      this.#storageRoots.some((root) => isWithin(root, candidate));
    if (!generatedAllowed(artifactRoot, 'artifacts')) {
      throw new ServiceError(
        'WORKSPACE_GENERATED_ROOT_ESCAPE',
        'Artifact storage must be inside the writable mod or a configured storage root',
        { workspaceId: registration.id },
      );
    }
    if (!generatedAllowed(cacheRoot, 'cache')) {
      throw new ServiceError(
        'WORKSPACE_GENERATED_ROOT_ESCAPE',
        'Cache storage must be inside the writable mod or a configured storage root',
        { workspaceId: registration.id },
      );
    }
    if (pathsOverlap(artifactRoot, cacheRoot)) {
      throw new ServiceError(
        'WORKSPACE_GENERATED_ROOT_OVERLAP',
        'Artifact and cache storage roots must be distinct and non-overlapping',
        { workspaceId: registration.id },
      );
    }
    for (const sourceRoot of [gameRoot, ...dependencyRoots, fixtureRoot].filter(
      (value): value is string => value !== undefined,
    )) {
      signal?.throwIfAborted();
      if (!(await exists(sourceRoot, signal))) {
        throw new ServiceError(
          'WORKSPACE_SOURCE_ROOT_MISSING',
          'Configured game, dependency, or fixture root does not exist',
          { workspaceId: registration.id },
        );
      }
    }
    const sourceRoots = [gameRoot, ...dependencyRoots, fixtureRoot].filter(
      (value): value is string => value !== undefined,
    );
    for (const [index, sourceRoot] of sourceRoots.entries()) {
      if (
        pathsOverlap(modRoot, sourceRoot) ||
        sourceRoots
          .slice(0, index)
          .some((existingSourceRoot) => pathsOverlap(sourceRoot, existingSourceRoot))
      ) {
        throw new ServiceError(
          'WORKSPACE_INTERNAL_ROOT_OVERLAP',
          'Workspace source roots must be distinct and non-overlapping',
          { workspaceId: registration.id },
        );
      }
    }
    for (const generatedRoot of [artifactRoot, cacheRoot]) {
      if (
        (registration.kind !== 'mod' && pathsOverlap(modRoot, generatedRoot)) ||
        (registration.kind === 'mod' &&
          !isWithin(modRoot, generatedRoot) &&
          pathsOverlap(modRoot, generatedRoot)) ||
        sourceRoots.some((sourceRoot) => pathsOverlap(sourceRoot, generatedRoot))
      ) {
        throw new ServiceError(
          'WORKSPACE_GENERATED_SOURCE_OVERLAP',
          'Generated storage must not overlap a source root',
          { workspaceId: registration.id },
        );
      }
    }
    if (
      this.#serverStateRoot !== undefined &&
      [modRoot, ...sourceRoots, artifactRoot, cacheRoot].some((root) =>
        pathsOverlap(this.#serverStateRoot!, root),
      )
    ) {
      throw new ServiceError(
        'SERVER_STATE_ROOT_OVERLAP',
        'Server state root must not overlap a workspace source or generated-storage root',
        { workspaceId: registration.id },
      );
    }
    await mkdir(artifactRoot, { recursive: true });
    signal?.throwIfAborted();
    await mkdir(cacheRoot, { recursive: true });
    signal?.throwIfAborted();

    const roots: ResolvedRoot[] = [
      {
        kind: registration.kind,
        path: modRoot,
        writable: registration.kind === 'mod',
        loadOrder: dependencyRoots.length + 1,
        replacePaths: [...registration.replacePaths],
      },
      ...dependencyRoots.map((dependency, index) => ({
        kind: 'dependency' as const,
        path: dependency,
        writable: false,
        loadOrder: index + 1,
        replacePaths: [...dependencyRegistrations[index]!.replacePaths],
      })),
      ...(gameRoot === undefined
        ? []
        : [
            {
              kind: 'game' as const,
              path: gameRoot,
              writable: false,
              loadOrder: 0,
              replacePaths: [],
            },
          ]),
      {
        kind: 'artifact',
        path: artifactRoot,
        writable: true,
        loadOrder: dependencyRoots.length + 2,
        replacePaths: [],
      },
      {
        kind: 'cache',
        path: cacheRoot,
        writable: true,
        loadOrder: dependencyRoots.length + 2,
        replacePaths: [],
      },
      ...(fixtureRoot === undefined
        ? []
        : [
            {
              kind: 'fixture' as const,
              path: fixtureRoot,
              writable: false,
              loadOrder: 0,
              replacePaths: [],
            },
          ]),
    ];

    for (const root of roots) {
      signal?.throwIfAborted();
      root.path = await canonicalPath(root.path, signal);
    }
    const workspaceBase = {
      id: registration.id,
      name: registration.name,
      registration,
      roots,
      modRoot,
      ...(gameRoot === undefined ? {} : { gameRoot }),
      dependencyRoots,
      artifactRoot,
      cacheRoot,
      ...(fixtureRoot === undefined ? {} : { fixtureRoot }),
      writeEnabled:
        registration.kind === 'mod' &&
        this.configuration.writePolicy === 'transactions' &&
        registration.writeEnabled,
    };
    const workspaceIdentity = resolvedWorkspaceIdentity(workspaceBase);
    return {
      ...workspaceBase,
      workspaceIdentity,
      ownerIdentity:
        runtimeOwner === undefined
          ? configuredOwnerIdentity(workspaceIdentity)
          : runtimeOwnerIdentity(workspaceIdentity, runtimeOwner.principal),
    };
  }
}
