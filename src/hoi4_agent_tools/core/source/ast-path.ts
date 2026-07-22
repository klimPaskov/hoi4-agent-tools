import type {
  AssignmentNode,
  BlockNode,
  ScalarNode,
  SourceDocument,
  SourceEntry,
} from './parser.js';

type PathNode = AssignmentNode | BlockNode | ScalarNode;

const cachedPaths = new WeakMap<SourceDocument, WeakMap<object, readonly string[]>>();

function indexBlock(
  block: BlockNode,
  path: readonly string[],
  output: WeakMap<object, readonly string[]>,
): void {
  output.set(block, path);
  const occurrences = new Map<string, number>();
  for (const [index, entry] of block.entries.entries()) {
    if (entry.type === 'assignment') {
      const key = entry.key.value;
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      const entryPath = [...path, `${key}[${occurrence}]`];
      output.set(entry, entryPath);
      output.set(entry.key, [...entryPath, '$key']);
      output.set(entry.value, entryPath);
      if (entry.value.type === 'block') indexBlock(entry.value, entryPath, output);
      continue;
    }
    const entryPath = [...path, `#${entry.type}[${index}]`];
    output.set(entry, entryPath);
    if (entry.type === 'block') indexBlock(entry, entryPath, output);
  }
}

function pathsFor(document: SourceDocument): WeakMap<object, readonly string[]> {
  const existing = cachedPaths.get(document);
  if (existing !== undefined) return existing;
  const indexed = new WeakMap<object, readonly string[]>();
  indexBlock(document.root, [], indexed);
  cachedPaths.set(document, indexed);
  return indexed;
}

/** Stable key-and-occurrence path for a node inside one parsed Clausewitz document. */
export function astPathFor(document: SourceDocument, node: PathNode): string[] | undefined {
  const path = pathsFor(document).get(node);
  return path === undefined ? undefined : [...path];
}

/** Test and diagnostic helper for callers that already hold a generic source entry. */
export function sourceEntryAstPath(
  document: SourceDocument,
  entry: SourceEntry,
): string[] | undefined {
  return astPathFor(document, entry);
}
