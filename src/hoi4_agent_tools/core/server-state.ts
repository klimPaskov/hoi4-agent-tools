import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { compareCodeUnits, canonicalJson, secureId } from './canonical.js';
import { ServiceError } from './result.js';

const journalKeyFile = 'journal-hmac.key';
const journalKeyBytes = 32;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const transactionIdSchema = z.string().regex(/^txn_[0-9a-f-]{36}$/u);
const journalHeadSchema = z
  .object({
    version: z.literal(1),
    workspaceIdentity: sha256Schema,
    transactionId: transactionIdSchema,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    manifestHash: sha256Schema,
    authenticationTag: sha256Schema,
    headTag: sha256Schema,
  })
  .strict();

interface JournalHead {
  version: 1;
  workspaceIdentity: string;
  transactionId: string;
  revision: number;
  manifestHash: string;
  authenticationTag: string;
  headTag: string;
}

interface JournalHeadInput {
  workspaceIdentity: string;
  transactionId: string;
  revision: number;
  authenticationTag: string;
  manifestHash: string;
}

function stateError(code: string, message: string): ServiceError {
  return new ServiceError(code, message);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function sameFileIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertNoLinkComponents(absolutePath: string): Promise<void> {
  const parsed = path.parse(absolutePath);
  let cursor = parsed.root;
  for (const segment of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) {
        throw stateError(
          'SERVER_STATE_UNSAFE',
          'Server state root contains a symbolic link or junction',
        );
      }
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }
}

async function assertPrivateFile(filePath: string, expectedBytes: number): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch {
    throw stateError(
      'SERVER_STATE_KEY_INVALID',
      'Server journal authentication key is unavailable',
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== expectedBytes) {
    throw stateError('SERVER_STATE_KEY_INVALID', 'Server journal authentication key is invalid');
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600) {
    throw stateError(
      'SERVER_STATE_KEY_PERMISSIONS',
      'Server journal authentication key permissions must be 0600',
    );
  }
}

async function atomicCreate(filePath: string, bytes: Uint8Array, mode: number): Promise<boolean> {
  const temporaryPath = path.join(path.dirname(filePath), `.${secureId('state')}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== 'win32') await chmod(temporaryPath, mode);
    try {
      await link(temporaryPath, filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function headPayload(head: Omit<JournalHead, 'headTag'>): unknown {
  return head;
}

/** Operator-owned state and authentication material outside every workspace/capability root. */
export class ServerState {
  private constructor(
    public readonly root: string,
    private readonly journalKey: Buffer,
  ) {}

  static async create(requestedRoot: string): Promise<ServerState> {
    const absoluteRoot = path.normalize(requestedRoot);
    if (!path.isAbsolute(absoluteRoot)) {
      throw stateError('SERVER_STATE_ROOT_INVALID', 'Server state root must be absolute');
    }
    await assertNoLinkComponents(absoluteRoot);
    await mkdir(absoluteRoot, { recursive: true, mode: 0o700 });
    await assertNoLinkComponents(absoluteRoot);
    const metadata = await lstat(absoluteRoot, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw stateError('SERVER_STATE_ROOT_INVALID', 'Server state root must be a real directory');
    }
    if (process.platform !== 'win32' && (metadata.mode & 0o077n) !== 0n) {
      throw stateError(
        'SERVER_STATE_ROOT_PERMISSIONS',
        'Server state root permissions must exclude group and other access',
      );
    }
    const canonicalRoot = path.normalize(await realpath(absoluteRoot));
    await assertNoLinkComponents(absoluteRoot);
    await assertNoLinkComponents(canonicalRoot);
    const [currentMetadata, canonicalMetadata] = await Promise.all([
      lstat(absoluteRoot, { bigint: true }),
      lstat(canonicalRoot, { bigint: true }),
    ]);
    if (
      currentMetadata.isSymbolicLink() ||
      !currentMetadata.isDirectory() ||
      canonicalMetadata.isSymbolicLink() ||
      !canonicalMetadata.isDirectory() ||
      !sameFileIdentity(metadata, currentMetadata) ||
      !sameFileIdentity(metadata, canonicalMetadata)
    ) {
      throw stateError(
        'SERVER_STATE_ROOT_NOT_CANONICAL',
        'Server state root changed while its canonical identity was being established',
      );
    }
    // Windows realpath expands harmless 8.3 names (for example RUNNER~1 on hosted runners).
    // Component checks and the identity comparison above accept only that native spelling
    // normalization while symbolic links, junctions, and replacement races fail closed.

    const keyPath = path.join(canonicalRoot, journalKeyFile);
    let key: Buffer;
    try {
      await assertPrivateFile(keyPath, journalKeyBytes);
      key = await readFile(keyPath);
    } catch (error) {
      if (!(error instanceof ServiceError) || error.code !== 'SERVER_STATE_KEY_INVALID')
        throw error;
      const createdKey = randomBytes(journalKeyBytes);
      let created: boolean;
      try {
        created = await atomicCreate(keyPath, createdKey, 0o600);
      } catch {
        throw stateError(
          'SERVER_STATE_KEY_CREATE_FAILED',
          'Server journal authentication key could not be created atomically',
        );
      }
      await assertPrivateFile(keyPath, journalKeyBytes);
      key = created ? createdKey : await readFile(keyPath);
    }
    if (key.length !== journalKeyBytes) {
      throw stateError('SERVER_STATE_KEY_INVALID', 'Server journal authentication key is invalid');
    }
    return new ServerState(canonicalRoot, Buffer.from(key));
  }

  authenticateJournal(payload: unknown): string {
    return createHmac('sha256', this.journalKey).update(canonicalJson(payload)).digest('hex');
  }

  verifyJournal(payload: unknown, authenticationTag: string): boolean {
    if (!/^[a-f0-9]{64}$/u.test(authenticationTag)) return false;
    const expected = Buffer.from(this.authenticateJournal(payload), 'hex');
    const actual = Buffer.from(authenticationTag, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  async recordInitialJournalHead(input: JournalHeadInput): Promise<void> {
    this.assertHeadInput(input);
    if (input.revision !== 1) {
      throw stateError('TRANSACTION_HEAD_INVALID', 'Initial transaction revision must be one');
    }
    const directory = this.journalHeadDirectory(input.workspaceIdentity, input.transactionId);
    await assertNoLinkComponents(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertNoLinkComponents(directory);
    const latest = await this.latestJournalHead(
      directory,
      input.workspaceIdentity,
      input.transactionId,
    );
    if (latest !== undefined) {
      if (this.headMatches(latest.head, input)) {
        await this.removeOlderHeads(latest.olderPaths);
        return;
      }
      throw stateError(
        'TRANSACTION_MANIFEST_REPLAY',
        'Initial transaction journal conflicts with protected server state',
      );
    }
    await this.createJournalHead(directory, input);
  }

  async recordJournalSuccessor(input: JournalHeadInput): Promise<void> {
    this.assertHeadInput(input);
    const directory = this.journalHeadDirectory(input.workspaceIdentity, input.transactionId);
    const latest = await this.latestJournalHead(
      directory,
      input.workspaceIdentity,
      input.transactionId,
    );
    if (latest === undefined) {
      throw stateError(
        'TRANSACTION_HEAD_MISSING',
        'Transaction journal has no protected server-state head',
      );
    }
    if (input.revision === latest.head.revision && this.headMatches(latest.head, input)) {
      await this.removeOlderHeads(latest.olderPaths);
      return;
    }
    if (input.revision !== latest.head.revision + 1) {
      throw stateError(
        'TRANSACTION_MANIFEST_REPLAY',
        'Transaction journal revision is not the protected successor',
      );
    }
    const target = await this.createJournalHead(directory, input);
    await this.removeOlderHeads(
      [latest.path, ...latest.olderPaths].filter((value) => value !== target),
    );
  }

  async verifyJournalHead(input: JournalHeadInput, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.assertHeadInput(input);
    const directory = this.journalHeadDirectory(input.workspaceIdentity, input.transactionId);
    const latest = await this.latestJournalHead(
      directory,
      input.workspaceIdentity,
      input.transactionId,
      signal,
    );
    signal?.throwIfAborted();
    if (latest === undefined) {
      throw stateError(
        'TRANSACTION_HEAD_MISSING',
        'Transaction journal has no protected server-state head',
      );
    }
    if (this.headMatches(latest.head, input)) return;
    if (input.revision === latest.head.revision + 1) {
      throw stateError(
        'TRANSACTION_HEAD_RECONCILIATION_REQUIRED',
        'Transaction journal has an authenticated successor pending write-path recovery',
      );
    }
    throw stateError(
      'TRANSACTION_MANIFEST_REPLAY',
      'Transaction journal conflicts with protected server state',
    );
  }

  async verifyOrReconcileJournalHead(input: JournalHeadInput, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.assertHeadInput(input);
    const directory = this.journalHeadDirectory(input.workspaceIdentity, input.transactionId);
    const latest = await this.latestJournalHead(
      directory,
      input.workspaceIdentity,
      input.transactionId,
      signal,
    );
    signal?.throwIfAborted();
    if (latest === undefined) {
      throw stateError(
        'TRANSACTION_HEAD_MISSING',
        'Transaction journal has no protected server-state head',
      );
    }
    if (this.headMatches(latest.head, input)) return;
    if (input.revision === latest.head.revision + 1) {
      // Once successor publication starts it completes atomically even if the
      // originating request is cancelled.
      const target = await this.createJournalHead(directory, input);
      await this.removeOlderHeads(
        [latest.path, ...latest.olderPaths].filter((value) => value !== target),
      );
      return;
    }
    throw stateError(
      'TRANSACTION_MANIFEST_REPLAY',
      'Transaction journal conflicts with protected server state',
    );
  }

  async removeJournalHead(workspaceIdentity: string, transactionId: string): Promise<void> {
    const directory = this.journalHeadDirectory(workspaceIdentity, transactionId);
    await assertNoLinkComponents(directory);
    await rm(directory, { recursive: true, force: true });
  }

  async listJournalHeadTransactionIds(
    workspaceIdentity: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    signal?.throwIfAborted();
    if (!sha256Schema.safeParse(workspaceIdentity).success) {
      throw stateError('TRANSACTION_HEAD_INVALID', 'Workspace head identity is invalid');
    }
    const workspaceDirectory = path.join(
      this.root,
      'transaction-heads',
      workspaceIdentity.slice(0, 2),
      workspaceIdentity,
    );
    await assertNoLinkComponents(workspaceDirectory);
    let entries;
    try {
      entries = await readdir(workspaceDirectory, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    signal?.throwIfAborted();
    const ids: string[] = [];
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (
        entry.isSymbolicLink() ||
        !entry.isDirectory() ||
        !transactionIdSchema.safeParse(entry.name).success
      ) {
        throw stateError('TRANSACTION_HEAD_INVALID', 'Protected transaction state is invalid');
      }
      ids.push(entry.name);
    }
    return ids.sort((left, right) => compareCodeUnits(left, right));
  }

  private async createJournalHead(directory: string, input: JournalHeadInput): Promise<string> {
    const withoutTag = {
      version: 1 as const,
      workspaceIdentity: input.workspaceIdentity,
      transactionId: input.transactionId,
      revision: input.revision,
      manifestHash: input.manifestHash,
      authenticationTag: input.authenticationTag,
    };
    const head: JournalHead = {
      ...withoutTag,
      headTag: this.authenticateJournal(headPayload(withoutTag)),
    };
    const target = path.join(directory, `${String(input.revision).padStart(16, '0')}.json`);
    const bytes = Buffer.from(`${canonicalJson(head)}\n`, 'utf8');
    let created: boolean;
    try {
      created = await atomicCreate(target, bytes, 0o600);
    } catch {
      throw stateError(
        'TRANSACTION_HEAD_WRITE_FAILED',
        'Protected transaction journal state could not be recorded',
      );
    }
    if (!created) {
      const raced = await this.readJournalHead(
        target,
        input.workspaceIdentity,
        input.transactionId,
      );
      if (canonicalJson(raced) !== canonicalJson(head)) {
        throw stateError(
          'TRANSACTION_MANIFEST_REPLAY',
          'Transaction journal conflicts with a concurrent protected revision',
        );
      }
    }
    return target;
  }

  private assertHeadInput(input: JournalHeadInput): void {
    if (
      !sha256Schema.safeParse(input.workspaceIdentity).success ||
      !transactionIdSchema.safeParse(input.transactionId).success ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      !sha256Schema.safeParse(input.authenticationTag).success ||
      !sha256Schema.safeParse(input.manifestHash).success
    ) {
      throw stateError('TRANSACTION_HEAD_INVALID', 'Transaction journal head identity is invalid');
    }
  }

  private headMatches(head: JournalHead, input: JournalHeadInput): boolean {
    return (
      head.revision === input.revision &&
      head.authenticationTag === input.authenticationTag &&
      head.manifestHash === input.manifestHash
    );
  }

  private async removeOlderHeads(paths: readonly string[]): Promise<void> {
    for (const filePath of paths) await unlink(filePath).catch(() => undefined);
  }

  private journalHeadDirectory(workspaceIdentity: string, transactionId: string): string {
    const directory = path.join(
      this.root,
      'transaction-heads',
      workspaceIdentity.slice(0, 2),
      workspaceIdentity,
      transactionId,
    );
    const relative = path.relative(this.root, directory);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw stateError('SERVER_STATE_ESCAPE', 'Protected transaction state escapes its root');
    }
    return directory;
  }

  private async latestJournalHead(
    directory: string,
    workspaceIdentity: string,
    transactionId: string,
    signal?: AbortSignal,
  ): Promise<{ head: JournalHead; path: string; olderPaths: string[] } | undefined> {
    signal?.throwIfAborted();
    await assertNoLinkComponents(directory);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    signal?.throwIfAborted();
    let latest: { revision: number; path: string } | undefined;
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (/^\.state_[0-9a-f-]{36}\.tmp$/u.test(entry.name) && entry.isFile()) continue;
      if (entry.isSymbolicLink() || !entry.isFile() || !/^\d{16}\.json$/u.test(entry.name)) {
        throw stateError(
          'TRANSACTION_HEAD_INVALID',
          'Protected transaction state contains an invalid entry',
        );
      }
      const revision = Number.parseInt(entry.name.slice(0, 16), 10);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw stateError('TRANSACTION_HEAD_INVALID', 'Protected transaction revision is invalid');
      }
      if (latest === undefined || revision > latest.revision) {
        latest = { revision, path: path.join(directory, entry.name) };
      }
    }
    if (latest === undefined) return undefined;
    const latestPath = latest.path;
    return {
      head: await this.readJournalHead(latestPath, workspaceIdentity, transactionId, signal),
      path: latestPath,
      olderPaths: entries
        .filter((entry) => /^\d{16}\.json$/u.test(entry.name))
        .map((entry) => path.join(directory, entry.name))
        .filter((filePath) => filePath !== latestPath),
    };
  }

  private async readJournalHead(
    filePath: string,
    workspaceIdentity: string,
    transactionId: string,
    signal?: AbortSignal,
  ): Promise<JournalHead> {
    signal?.throwIfAborted();
    let parsed: unknown;
    try {
      const metadata = await lstat(filePath);
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 4_096)
        throw new Error();
      signal?.throwIfAborted();
      const text =
        signal === undefined
          ? await readFile(filePath, 'utf8')
          : await readFile(filePath, { encoding: 'utf8', signal });
      signal?.throwIfAborted();
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      throw stateError('TRANSACTION_HEAD_INVALID', 'Protected transaction state is invalid');
    }
    signal?.throwIfAborted();
    const validated = journalHeadSchema.safeParse(parsed);
    if (!validated.success) {
      throw stateError('TRANSACTION_HEAD_INVALID', 'Protected transaction state is invalid');
    }
    const head = validated.data;
    if (
      head.workspaceIdentity !== workspaceIdentity ||
      head.transactionId !== transactionId ||
      !this.verifyJournal(
        headPayload({
          version: head.version,
          workspaceIdentity: head.workspaceIdentity,
          transactionId: head.transactionId,
          revision: head.revision,
          manifestHash: head.manifestHash,
          authenticationTag: head.authenticationTag,
        }),
        head.headTag,
      )
    ) {
      throw stateError('TRANSACTION_HEAD_INVALID', 'Protected transaction state is invalid');
    }
    return head;
  }
}
