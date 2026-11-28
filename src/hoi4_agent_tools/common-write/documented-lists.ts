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

function referencesOf(engine: CoreEngine): ReferenceService {
  const known = services.get(engine);
  if (known !== undefined) return known;
  const created = new ReferenceService({ docsRoot: engine.resolver.config().docsRoot });
  services.set(engine, created);
  return created;
}

export async function documentedLists(
  engine: CoreEngine,
  workspaceId: string,
  principal: string | undefined,
  signal: AbortSignal | undefined,
): Promise<DocumentedLists> {
  const workspace = engine.resolver.get(workspaceId, principal);
  const inventory = await referencesOf(engine).inventory(workspace, signal, ['game_doc']);
  const tokens = new Set<string>();
  const names = new Set<string>();
  const sections = [...inventory.sections].sort((a, b) => a.startLine - b.startLine);
  const afterTokenList = new Set<string>();
  for (const section of sections) {
    const file = section.relativePath.replaceAll('\\', '/').toLowerCase();
    if (path.posix.basename(file) !== '_documentation.md') continue;
    if (file === 'common/ai_strategy/_documentation.md') {
      // The token list is the section "List of available strategy tokens" and the ones after it.
      if (/list of available strategy tokens/iu.test(section.heading)) afterTokenList.add(file);
      if (!afterTokenList.has(file)) continue;
      for (const line of section.lines) {
        const match = BULLET.exec(line);
        if (match?.[1] !== undefined) tokens.add(match[1]);
      }
    } else if (file === 'common/on_actions/_documentation.md') {
      for (const line of section.lines) {
        const match = BULLET.exec(line);
        if (match?.[1] !== undefined) names.add(match[1]);
      }
    }
  }
  return {
    tokens: tokens.size === 0 ? undefined : [...tokens].sort(),
    names: names.size === 0 ? undefined : [...names].sort(),
  };
}
