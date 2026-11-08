import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod/v4';
import manifestFile from './docs-pack.json' with { type: 'json' };

/**
 * The docs pack: the modding kit's HOI4 wiki pages at one pinned kit commit, downloaded once by
 * `hoi4-agent-tools-setup --fetch-docs` (maintainer decision R-4). It lets the reference tools
 * answer with no mod open, and in a mod that has no copy of the wiki. Every file is checked
 * against the SHA-256 this package version pins, so a pack is either complete and exact or not
 * used at all. The pack lives in the server's data folder, never in a mod.
 */

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const docsPackManifestSchema = z
  .object({
    version: z.literal(1),
    /** The GitHub repository the pages come from, `owner/name`. */
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    commit: z.string().regex(/^[a-f0-9]{40}$/u),
    /** The repository folder that holds the pages. */
    folder: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
    /** Who may use the text, and how; the pack's own LICENSE.txt has the full terms. */
    license: z.string().min(1).max(300),
    files: z
      .array(
        z
          .object({
            path: z.string().regex(/^[A-Za-z0-9_.-]+\.(?:md|txt|json)$/u),
            sha256: sha256Schema,
            bytes: z
              .number()
              .int()
              .min(0)
              .max(4 * 1024 * 1024),
          })
          .strict(),
      )
      .min(1)
      .max(512),
  })
  .strict();

export type DocsPackManifest = z.infer<typeof docsPackManifestSchema>;

/** The pack this package version uses. */
export const docsPackManifest: DocsPackManifest = docsPackManifestSchema.parse(manifestFile);

/** The pack's subfolder that holds the pages, which the reference tools read as the wiki. */
export const DOCS_PACK_WIKI_FOLDER = 'hoi4_wiki';
const MAX_PACK_BYTES = 32 * 1024 * 1024;

/**
 * Where packs live unless the configuration names `docsRoot`: the same data folder the setup
 * utility gives generated workspaces.
 */
export function defaultDocsRoot(
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const dataRoot =
    environment.XDG_DATA_HOME ?? environment.LOCALAPPDATA ?? path.join(home, '.local', 'share');
  return path.join(dataRoot, 'hoi4-agent-tools', 'docs');
}

/** One manifest's folder under the docs root: the first 12 characters of its kit commit. */
export function docsPackFolder(docsRoot: string, manifest: DocsPackManifest = docsPackManifest) {
  return path.join(docsRoot, manifest.commit.slice(0, 12));
}

/** The marker a complete pack carries: the SHA-256 of the manifest it was installed from. */
export function docsPackMarker(manifest: DocsPackManifest = docsPackManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

/** The file that marks a pack folder complete. */
export const DOCS_PACK_MARKER_FILE = '.complete';

/**
 * The wiki folder of an installed, complete pack for this manifest, or undefined. A pack counts
 * as installed only when its marker names this exact manifest, so a pack of another package
 * version or an interrupted download is never read.
 */
export async function installedDocsPackWiki(
  docsRoot: string | undefined,
  manifest: DocsPackManifest = docsPackManifest,
): Promise<string | undefined> {
  if (docsRoot === undefined) return undefined;
  const folder = docsPackFolder(docsRoot, manifest);
  try {
    const marker = (await readFile(path.join(folder, DOCS_PACK_MARKER_FILE), 'utf8')).trim();
    if (marker !== docsPackMarker(manifest)) return undefined;
    const wiki = path.join(folder, DOCS_PACK_WIKI_FOLDER);
    return (await stat(wiki)).isDirectory() ? wiki : undefined;
  } catch {
    return undefined;
  }
}

export interface FetchDocsPackOptions {
  docsRoot: string;
  manifest?: DocsPackManifest;
  /** Replaced in tests; the global `fetch` otherwise. */
  fetch?: (url: string, init: { signal?: AbortSignal }) => Promise<Response>;
  signal?: AbortSignal;
  onFile?: (file: string) => void;
}

export interface FetchDocsPackResult {
  folder: string;
  wiki: string;
  files: number;
  bytes: number;
  /** True when a complete pack for this manifest was already installed. */
  reused: boolean;
  repository: string;
  commit: string;
}

function fileUrl(manifest: DocsPackManifest, file: string): string {
  return `https://raw.githubusercontent.com/${manifest.repository}/${manifest.commit}/${manifest.folder}/${encodeURIComponent(file)}`;
}

export class DocsPackError extends Error {
  constructor(
    readonly code: 'DOCS_PACK_DOWNLOAD_FAILED' | 'DOCS_PACK_HASH_MISMATCH' | 'DOCS_PACK_TOO_LARGE',
    message: string,
  ) {
    super(message);
    this.name = 'DocsPackError';
  }
}

/**
 * Download the pinned pages, check every file's size and SHA-256, and install the pack in one
 * rename, so a reader sees either the complete pack or none. A complete pack is reused, and
 * packs of other manifests are removed afterwards.
 */
export async function fetchDocsPack(options: FetchDocsPackOptions): Promise<FetchDocsPackResult> {
  const manifest = options.manifest ?? docsPackManifest;
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const docsRoot = path.resolve(options.docsRoot);
  const folder = docsPackFolder(docsRoot, manifest);
  const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  const summary = {
    folder,
    wiki: path.join(folder, DOCS_PACK_WIKI_FOLDER),
    files: manifest.files.length,
    bytes: total,
    repository: manifest.repository,
    commit: manifest.commit,
  };
  if (total > MAX_PACK_BYTES)
    throw new DocsPackError('DOCS_PACK_TOO_LARGE', `The docs pack lists ${total} bytes`);
  if ((await installedDocsPackWiki(docsRoot, manifest)) !== undefined)
    return { ...summary, reused: true };

  await mkdir(docsRoot, { recursive: true });
  const staging = path.join(docsRoot, `.partial-${randomBytes(6).toString('hex')}`);
  const stagingWiki = path.join(staging, DOCS_PACK_WIKI_FOLDER);
  await mkdir(stagingWiki, { recursive: true });
  try {
    for (const file of manifest.files) {
      options.signal?.throwIfAborted();
      const url = fileUrl(manifest, file.path);
      let response: Response;
      try {
        response = await doFetch(
          url,
          options.signal === undefined ? {} : { signal: options.signal },
        );
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        throw new DocsPackError(
          'DOCS_PACK_DOWNLOAD_FAILED',
          `Could not download ${file.path}: ${(error as Error).message}`,
        );
      }
      if (!response.ok)
        throw new DocsPackError(
          'DOCS_PACK_DOWNLOAD_FAILED',
          `Could not download ${file.path}: HTTP ${response.status}`,
        );
      const bytes = Buffer.from(await response.arrayBuffer());
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== file.bytes || digest !== file.sha256)
        throw new DocsPackError(
          'DOCS_PACK_HASH_MISMATCH',
          `${file.path} does not match the pinned SHA-256; nothing was installed`,
        );
      await writeFile(path.join(stagingWiki, file.path), bytes, { flag: 'wx' });
      options.onFile?.(file.path);
    }
    await writeFile(
      path.join(staging, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(staging, DOCS_PACK_MARKER_FILE),
      `${docsPackMarker(manifest)}\n`,
      'utf8',
    );
    await rm(folder, { recursive: true, force: true });
    await rename(staging, folder);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  // Older packs and interrupted downloads are no longer read.
  for (const entry of await readdir(docsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name === path.basename(folder)) continue;
    if (/^[a-f0-9]{12}$/u.test(name) || name.startsWith('.partial-'))
      await rm(path.join(docsRoot, name), { recursive: true, force: true });
  }
  return { ...summary, reused: false };
}
