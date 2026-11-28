import path from 'node:path';
import type { CoreEngine } from '../core/engine.js';
import { ReferenceService } from '../reference/service.js';

/**
 * The two name lists the engine's checks compare with (packet T3): the strategy tokens and the
 * on_action names the installed game documents. They are read from the game documentation the
 * reference tools already index, so a token a patch adds is known without a tool update. The engine
 * holds no game data; with no documentation the lists are absent and the checks do not guess.
 */
export interface DocumentedLists {
  tokens: string[] | undefined;
  names: string[] | undefined;
}

const services = new WeakMap<CoreEngine, ReferenceService>();
const BULLET = /^\s*[-*]\s+`([a-z][a-z0-9_]*)`/u;
const TOKEN_HEADING = /^##\s+List of available strategy tokens\s*$/iu;
const STRATEGY_DOC = 'common/ai_strategy/_documentation.md';
const ON_ACTION_DOC = 'common/on_actions/_documentation.md';

function referencesOf(engine: CoreEngine): ReferenceService {
  const known = services.get(engine);
  if (known !== undefined) return known;
  const created = new ReferenceService({ docsRoot: engine.resolver.config().docsRoot });
  services.set(engine, created);
  return created;
}

/**
 * The lists from the lines of the two documentation files, by path under the game root. The
 * strategy tokens are the bullets between the heading "List of available strategy tokens" and the
 * next heading of its level or above: the later sections of that file (unit ratios, examples) have
 * bullets of their own that are not tokens. The on_action names are every bullet of its file; the
 * `on_daily_TAG` style entries have an upper-case tag and are not names.
 */
export function parseDocumentedLists(
  files: ReadonlyMap<string, readonly string[]>,
): DocumentedLists {
  const tokens = new Set<string>();
  const names = new Set<string>();
  let inTokenList = false;
  for (const line of files.get(STRATEGY_DOC) ?? []) {
    if (TOKEN_HEADING.test(line)) inTokenList = true;
    else if (/^#{1,2}\s/u.test(line)) inTokenList = false;
    else if (inTokenList) {
      const match = BULLET.exec(line);
      if (match?.[1] !== undefined) tokens.add(match[1]);
    }
  }
  for (const line of files.get(ON_ACTION_DOC) ?? []) {
    const match = BULLET.exec(line);
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return {
    tokens: tokens.size === 0 ? undefined : [...tokens].sort(),
    names: names.size === 0 ? undefined : [...names].sort(),
  };
}

export async function documentedLists(
  engine: CoreEngine,
  workspaceId: string,
  principal: string | undefined,
  signal: AbortSignal | undefined,
): Promise<DocumentedLists> {
  const workspace = engine.resolver.get(workspaceId, principal);
  const inventory = await referencesOf(engine).inventory(workspace, signal, ['game_doc']);
  const files = new Map<string, string[]>();
  const sections = [...inventory.sections].sort((a, b) => a.startLine - b.startLine);
  for (const section of sections) {
    const file = section.relativePath.replaceAll('\\', '/').toLowerCase();
    if (path.posix.basename(file) !== '_documentation.md') continue;
    const lines = files.get(file) ?? [];
    lines.push(...section.lines);
    files.set(file, lines);
  }
  return parseDocumentedLists(files);
}
