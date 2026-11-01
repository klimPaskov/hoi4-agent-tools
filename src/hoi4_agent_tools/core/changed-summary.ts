export interface ChangedFileIdentity {
  relativePath: string;
  beforeSha256: string | null;
  afterSha256: string | null;
}

export interface ChangedFolderSummary {
  folder: string;
  created: number;
  removed: number;
  modified: number;
}

export interface ChangedFilesSummary {
  total: number;
  created: number;
  removed: number;
  modified: number;
  /** The folders with the most changes, largest first (at most `limit`). */
  folders: ChangedFolderSummary[];
  /** Folders left out of `folders`. */
  omittedFolders: number;
}

/** The folder a path is counted in: its directory, at most two levels deep (`.` for the root). */
function folderOf(relativePath: string): string {
  const parts = relativePath.replaceAll('\\', '/').split('/');
  parts.pop();
  return parts.length === 0 ? '.' : parts.slice(0, 2).join('/');
}

/**
 * A bounded count of what a rewrite changed, so a response whose file list is cut still says how
 * much changed: created, removed and modified files in total and per folder. Deterministic.
 */
export function summarizeChangedFiles(
  files: readonly ChangedFileIdentity[],
  limit = 40,
): ChangedFilesSummary {
  const byFolder = new Map<string, ChangedFolderSummary>();
  let created = 0;
  let removed = 0;
  let modified = 0;
  for (const file of files) {
    const kind =
      file.beforeSha256 === null ? 'created' : file.afterSha256 === null ? 'removed' : 'modified';
    if (kind === 'created') created += 1;
    else if (kind === 'removed') removed += 1;
    else modified += 1;
    const folder = folderOf(file.relativePath);
    const entry = byFolder.get(folder) ?? { folder, created: 0, removed: 0, modified: 0 };
    entry[kind] += 1;
    byFolder.set(folder, entry);
  }
  const ranked = [...byFolder.values()].sort(
    (left, right) =>
      right.created +
        right.removed +
        right.modified -
        (left.created + left.removed + left.modified) || (left.folder < right.folder ? -1 : 1),
  );
  return {
    total: files.length,
    created,
    removed,
    modified,
    folders: ranked.slice(0, limit),
    omittedFolders: Math.max(0, ranked.length - limit),
  };
}
