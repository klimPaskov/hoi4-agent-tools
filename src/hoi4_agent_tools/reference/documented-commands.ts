import path from 'node:path';
import type { ReferenceService } from './service.js';
import type { ResolvedWorkspace } from '../core/workspace.js';

/** The effects, triggers and modifiers the installed game documents, by name. */
export interface DocumentedNames {
  effect: ReadonlySet<string>;
  trigger: ReadonlySet<string>;
  modifier: ReadonlySet<string>;
}

const files: Readonly<Record<string, keyof DocumentedNames>> = {
  'effects_documentation.md': 'effect',
  'triggers_documentation.md': 'trigger',
  'modifiers_documentation.md': 'modifier',
};

/**
 * Read the names from the `## name` sections of the installed game's documentation, which each
 * game version ships, so names a patch adds are known without a tool update. Undefined when the
 * workspace has no game documentation.
 */
export async function documentedNames(
  references: ReferenceService,
  workspace: ResolvedWorkspace,
  signal?: AbortSignal,
): Promise<DocumentedNames | undefined> {
  const inventory = await references.inventory(workspace, signal, ['game_doc']);
  const names: Record<keyof DocumentedNames, Set<string>> = {
    effect: new Set(),
    trigger: new Set(),
    modifier: new Set(),
  };
  for (const section of inventory.sections) {
    const kind = files[path.basename(section.path).toLowerCase()];
    if (kind === undefined || !/^[a-z_][a-z0-9_]{0,255}$/u.test(section.heading)) continue;
    names[kind].add(section.heading);
  }
  return names.effect.size === 0 && names.trigger.size === 0 ? undefined : names;
}
