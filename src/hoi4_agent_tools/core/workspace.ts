import { lstat, mkdir, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  WORKSPACE_MAX_REGISTRATIONS,
  workspaceRegistrationSchema,
  type ServerConfiguration,
  type WorkspaceRegistration,
} from './configuration.js';
import { compareCodeUnits, hashCanonical, sha256Bytes } from './canonical.js';
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
  /** Configured-workspace identity used to isolate generated artifacts. */
  ownerIdentity: string;
}

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

function discoveredWorkspaceId(rootPath: string): string {
  const basename = path.basename(rootPath);
  const slug = basename
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 40);
  const identityPath = process.platform === 'win32' ? rootPath.toLowerCase() : rootPath;
  return `mod_${slug.length === 0 ? 'workspace' : slug}_${sha256Bytes(identityPath).slice(0, 12)}`;
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
  readonly #discoveredWorkspaceIds = new Set<string>();
  #storageRoots: string[] = [];
  #modRoots: string[] = [];
  #workspaceStorageRoot?: string;
  #serverStateRoot?: string;
  #serverState?: ServerState;

  private constructor(private readonly configuration: ServerConfiguration) {}

  static async create(configuration: ServerConfiguration): Promise<WorkspaceResolver> {
    const resolver = new WorkspaceResolver(configuration);
    if (configuration.serverStateRoot !== undefined) {
      resolver.#serverStateRoot = await canonicalPath(configuration.serverStateRoot);
    }
    resolver.#storageRoots = await Promise.all(
      configuration.storageRoots.map((root) => canonicalPath(root)),
    );
    resolver.#modRoots = await Promise.all(
      configuration.modRoots.map(async (root) => {
        const status = await lstat(root).catch(() => undefined);
        if (status === undefined || !status.isDirectory() || status.isSymbolicLink()) {
          throw new ServiceError(
            'WORKSPACE_MOD_ROOT_UNSAFE',
            'Configured mod roots must be existing real directories',
          );
        }
        return canonicalPath(root);
      }),
    );
    for (const [index, candidate] of resolver.#modRoots.entries()) {
      if (resolver.#modRoots.slice(0, index).some((root) => pathsOverlap(root, candidate))) {
        throw new ServiceError(
          'WORKSPACE_MOD_ROOT_OVERLAP',
          'Configured mod roots must be distinct and non-overlapping',
        );
      }
    }
    if (configuration.workspaceStorageRoot !== undefined) {
      resolver.#workspaceStorageRoot = await canonicalPath(configuration.workspaceStorageRoot);
      if (resolver.#modRoots.some((root) => pathsOverlap(root, resolver.#workspaceStorageRoot!))) {
        throw new ServiceError(
          'WORKSPACE_STORAGE_ROOT_OVERLAP',
          'Workspace storage root must not overlap a configured mod root',
        );
      }
      resolver.#storageRoots.push(resolver.#workspaceStorageRoot);
    }
    if (resolver.#serverStateRoot !== undefined) {
      for (const root of [
        ...resolver.#storageRoots,
        ...resolver.#modRoots,
        ...(configuration.gameRoot === undefined
          ? []
          : [await canonicalPath(configuration.gameRoot)]),
      ]) {
        if (pathsOverlap(resolver.#serverStateRoot, root)) {
          throw new ServiceError(
            'SERVER_STATE_ROOT_OVERLAP',
            'Server state root must not overlap a registration or generated-storage capability root',
          );
        }
      }
    }
    for (const configured of configuration.workspaces) {
      const registration = resolver.withGlobalWorkspaceDefaults(configured);
      const workspace = await resolver.resolveRegistration(registration);
      if (resolver.#byId.has(workspace.id)) {
        throw new ServiceError('WORKSPACE_DUPLICATE', `Duplicate workspace ID: ${workspace.id}`);
      }
      resolver.assertWorkspaceIsolation(workspace);
      resolver.#byId.set(workspace.id, workspace);
    }
    await resolver.discoverModWorkspaces();
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

  private withGlobalWorkspaceDefaults(registration: WorkspaceRegistration): WorkspaceRegistration {
    const gameRoot =
      registration.kind === 'mod' && registration.gameRoot === undefined
        ? this.configuration.gameRoot
        : registration.gameRoot;
    const storageBase =
      this.#workspaceStorageRoot === undefined
        ? undefined
        : path.join(this.#workspaceStorageRoot, registration.id);
    return {
      ...registration,
      ...(gameRoot === undefined ? {} : { gameRoot }),
      ...(registration.artifactRoot !== undefined || storageBase === undefined
        ? {}
        : { artifactRoot: path.join(storageBase, 'artifacts') }),
      ...(registration.cacheRoot !== undefined || storageBase === undefined
        ? {}
        : { cacheRoot: path.join(storageBase, 'cache') }),
    };
  }

  private async discoverModWorkspaces(): Promise<void> {
    const registrations: WorkspaceRegistration[] = [];
    for (const modRoot of this.#modRoots) {
      const directory = await opendir(modRoot);
      for await (const entry of directory) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink() || !entry.isDirectory()) continue;
        const lexicalCandidate = path.normalize(path.join(modRoot, entry.name));
        if (!isWithin(modRoot, lexicalCandidate)) continue;
        const candidateStatus = await lstat(lexicalCandidate).catch(() => undefined);
        if (
          candidateStatus === undefined ||
          candidateStatus.isSymbolicLink() ||
          !candidateStatus.isDirectory()
        ) {
          continue;
        }
        const candidate = await canonicalPath(lexicalCandidate);
        if (!isWithin(modRoot, candidate)) continue;
        if ([...this.#byId.values()].some((workspace) => workspace.modRoot === candidate)) continue;
        if (this.#byId.size + registrations.length >= WORKSPACE_MAX_REGISTRATIONS) {
          throw new ServiceError(
            'WORKSPACE_REGISTRATION_LIMIT',
            'Workspace registration limit has been reached',
          );
        }
        const id = discoveredWorkspaceId(candidate);
        const registration = workspaceRegistrationSchema.parse({
          id,
          name: entry.name.slice(0, 200),
          root: candidate,
          kind: 'mod',
        });
        registrations.push(this.withGlobalWorkspaceDefaults(registration));
      }
    }

    registrations.sort((left, right) => compareCodeUnits(left.id, right.id));
    for (const registration of registrations) {
      if (this.#byId.has(registration.id)) {
        throw new ServiceError('WORKSPACE_DUPLICATE', `Duplicate workspace ID: ${registration.id}`);
      }
      const workspace = await this.resolveRegistration(registration);
      this.assertWorkspaceIsolation(workspace);
      this.#byId.set(workspace.id, workspace);
      this.#discoveredWorkspaceIds.add(workspace.id);
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
      ...(this.discoveredModsAllowed(principal) ? this.#discoveredWorkspaceIds : []),
    ]);
  }

  private discoveredModsAllowed(principal: string): boolean {
    return (
      this.configuration.http.tokens.some(
        (entry) => entry.principal === principal && entry.allowDiscoveredMods,
      ) ||
      this.configuration.http.principals.some(
        (entry) => entry.principal === principal && entry.allowDiscoveredMods,
      )
    );
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
  ): Promise<ResolvedWorkspace> {
    const modRoot = await canonicalPath(registration.root);
    if (!(await exists(modRoot))) {
      throw new ServiceError(
        'WORKSPACE_ROOT_MISSING',
        `Workspace root does not exist: ${registration.root}`,
      );
    }
    const gameRoot =
      registration.gameRoot === undefined ? undefined : await canonicalPath(registration.gameRoot);
    const dependencyRegistrations =
      registration.dependencies.length > 0
        ? registration.dependencies
        : registration.dependencyRoots.map((root) => ({ root, replacePaths: [] }));
    const dependencyRoots = await Promise.all(
      dependencyRegistrations.map(({ root }) => canonicalPath(root)),
    );
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
    );
    const cacheRoot = await canonicalPath(
      registration.cacheRoot ?? path.join(modRoot, '.hoi4-agent', 'cache'),
    );
    const fixtureRoot =
      registration.fixtureRoot === undefined
        ? undefined
        : await canonicalPath(registration.fixtureRoot);
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
      if (!(await exists(sourceRoot))) {
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
    await mkdir(cacheRoot, { recursive: true });

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
      root.path = await canonicalPath(root.path);
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
      writeEnabled: registration.kind === 'mod',
    };
    const workspaceIdentity = resolvedWorkspaceIdentity(workspaceBase);
    return {
      ...workspaceBase,
      workspaceIdentity,
      ownerIdentity: configuredOwnerIdentity(workspaceIdentity),
    };
  }
}
