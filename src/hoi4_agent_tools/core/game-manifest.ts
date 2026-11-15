import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { sha256Bytes } from './canonical.js';
import type { ServerState } from './server-state.js';

/**
 * Game-build manifests (ADR 0087). After the scanner has walked and verified the installed game
 * for one set of patterns, it records what it found: every file's relative path, size, identity
 * (device, file number, size and both change times) and SHA-256, under the game's build
 * fingerprint. A later process with the same build and patterns opens those files directly
 * instead of walking the game and resolving every path again. Any difference, a missing manifest,
 * a changed build or one file whose identity or hash no longer matches, sends the scan back to
 * the full walk, which records a new manifest.
 */

export interface GameManifestEntry {
  relativePath: string;
  size: number;
  identity: string;
  sha256: string;
  modifiedMs: number;
}

export interface GameManifest {
  /** The scan the manifest answers: game root, patterns, ignores and what mods hide. */
  key: string;
  /** The game's build fingerprint when the game was walked. */
  fingerprint: string;
  /** Every match of the patterns, including those a mod's replace_path hid. */
  enumerated: number;
  files: GameManifestEntry[];
}

export interface GameManifestStore {
  load(key: string, fingerprint: string): Promise<GameManifest | undefined>;
  save(manifest: GameManifest): Promise<void>;
}

const MANIFEST_DIRECTORY = 'game-manifests';
const MANIFEST_VERSION = 1;
const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
/** Manifests kept per server state; the oldest are removed after a save. */
const MANIFEST_MAX_FILES = 8;

/** A relative path inside the game root: forward slashes, no `.`/`..` segment, not absolute. */
const relativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.includes('\\') &&
      !value.includes('\0') &&
      !path.posix.isAbsolute(value) &&
      !/^[A-Za-z]:/u.test(value) &&
      value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    { message: 'not a contained relative path' },
  );

const payloadSchema = z
  .object({
    version: z.literal(MANIFEST_VERSION),
    key: z.string().min(1).max(65_536),
    fingerprint: z.string().min(1).max(65_536),
    enumerated: z.number().int().nonnegative(),
    files: z
      .array(
        z.tuple([
          relativePathSchema,
          z.number().int().nonnegative(),
          z.string().regex(/^[0-9.:e+-]+$/u),
          z.string().regex(/^[a-f0-9]{64}$/u),
          z.number(),
        ]),
      )
      .max(200_000),
  })
  .strict();

const fileSchema = payloadSchema.extend({ tag: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

/** Keeps game-build manifests in the server state folder, authenticated with its journal key. */
export class ServerStateGameManifests implements GameManifestStore {
  readonly #directory: string;

  public constructor(private readonly state: ServerState) {
    this.#directory = path.join(state.root, MANIFEST_DIRECTORY);
  }

  private file(key: string): string {
    return path.join(this.#directory, `${sha256Bytes(Buffer.from(key, 'utf8'))}.json`);
  }

  /** The manifest for this scan and build, or undefined when there is none or it cannot be trusted. */
  public async load(key: string, fingerprint: string): Promise<GameManifest | undefined> {
    const file = this.file(key);
    try {
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.size > MANIFEST_MAX_BYTES) return undefined;
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
      if (!parsed.success) return undefined;
      const { tag, ...payload } = parsed.data;
      if (!this.state.verifyJournal(payload, tag)) return undefined;
      if (payload.key !== key || payload.fingerprint !== fingerprint) return undefined;
      return {
        key: payload.key,
        fingerprint: payload.fingerprint,
        enumerated: payload.enumerated,
        files: payload.files.map(([relativePath, size, identity, sha256, modifiedMs]) => ({
          relativePath,
          size,
          identity,
          sha256,
          modifiedMs,
        })),
      };
    } catch {
      // A missing, unreadable or malformed manifest only means the game is walked again.
      return undefined;
    }
  }

  /** Records a manifest; a failure to write it is not an error, the next scan walks the game. */
  public async save(manifest: GameManifest): Promise<void> {
    const payload = {
      version: MANIFEST_VERSION,
      key: manifest.key,
      fingerprint: manifest.fingerprint,
      enumerated: manifest.enumerated,
      files: manifest.files.map(
        (entry) =>
          [entry.relativePath, entry.size, entry.identity, entry.sha256, entry.modifiedMs] as const,
      ),
    };
    if (!payloadSchema.safeParse(payload).success) return;
    const text = `${JSON.stringify({ ...payload, tag: this.state.authenticateJournal(payload) })}\n`;
    if (Buffer.byteLength(text, 'utf8') > MANIFEST_MAX_BYTES) return;
    const file = this.file(manifest.key);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.#directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) return;
      await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
      await this.prune();
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async prune(): Promise<void> {
    const entries = await readdir(this.#directory, { withFileTypes: true });
    const manifests: Array<{ file: string; modified: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(this.#directory, entry.name);
      const metadata = await lstat(file).catch(() => undefined);
      if (metadata !== undefined) manifests.push({ file, modified: metadata.mtimeMs });
    }
    manifests.sort((left, right) => right.modified - left.modified);
    for (const { file } of manifests.slice(MANIFEST_MAX_FILES))
      await rm(file, { force: true }).catch(() => undefined);
  }
}
