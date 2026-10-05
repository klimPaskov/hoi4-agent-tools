import type { CoreEngine, ScanSnapshot } from '../core/engine.js';
import { hashCanonical } from '../core/canonical.js';
import { parseClausewitz } from '../core/source/index.js';
import {
  requireOperationScope,
  resolveOperationWorkspaceId,
  type OperationContext,
} from '../core/operation-context.js';
import { emptyServiceResult } from '../core/result.js';
import { toolResult } from '../core/operation-result.js';
import {
  referenceContextRequestSchema,
  referenceReadRequestSchema,
  referenceSearchRequestSchema,
  sourceLookupRequestSchema,
} from '../schemas/reference.js';
import { ReferenceService } from './service.js';
import { sourceLookup } from './source-lookup.js';
import {
  scriptValidateDataSchema,
  scriptValidateRequestSchema,
} from '../schemas/script-validation.js';
import { validateScript } from './script-validation.js';
import type { LocalisedText, PlayerTextContext } from './player-text.js';
import { eventPopupDefinitions, type EventPopupDefinition } from './event-popups.js';
import { locatePatterns, selectFile } from './source-locate.js';
import type { ResolvedWorkspace } from '../core/workspace.js';
import type { z } from 'zod/v4';

/**
 * Database folders whose entry names are trigger keys: `<folder> = { <name> = { ... } }` in
 * each file, checked as the documented generic trigger.
 */
const implicitTriggerSources: Readonly<Record<string, string>> = {
  buildings: 'building_count_trigger',
  ideologies: 'ideology_support_trigger',
  resources: 'resource_count_trigger',
};

/** Building, ideology and resource names from every scanned source layer. */
function implicitTriggerNames(snapshot: ScanSnapshot): Map<string, string> {
  const names = new Map<string, string>();
  for (const file of snapshot.index.files.values()) {
    const folder = /^common\/([a-z_]+)\/[^/]+\.txt$/u.exec(file.relativePath)?.[1];
    const heading = folder === undefined ? undefined : implicitTriggerSources[folder];
    if (heading === undefined) continue;
    for (const top of parseClausewitz(file.bytes, file.displayPath).root.entries) {
      if (top.type !== 'assignment' || top.key.value !== folder || top.value.type !== 'block')
        continue;
      for (const entry of top.value.entries)
        if (entry.type === 'assignment' && entry.value.type === 'block')
          names.set(entry.key.value, heading);
    }
  }
  return names;
}

const schemas = {
  'hoi4.reference_search': referenceSearchRequestSchema,
  'hoi4.reference_read': referenceReadRequestSchema,
  'hoi4.reference_context': referenceContextRequestSchema,
  'hoi4.source_lookup': sourceLookupRequestSchema,
  'hoi4.script_validate': scriptValidateRequestSchema,
} as const;
export type ReferenceToolName = keyof typeof schemas;
export function isReferenceTool(name: string): name is ReferenceToolName {
  return Object.hasOwn(schemas, name);
}

const sharedReferences = new WeakMap<CoreEngine, ReferenceService>();

/** One authorization and execution contract for both MCP protocol adapters. */
export class ReferenceToolService {
  private readonly references: ReferenceService;
  constructor(private readonly engine: CoreEngine) {
    const cached = sharedReferences.get(engine) ?? new ReferenceService();
    sharedReferences.set(engine, cached);
    this.references = cached;
  }

  async call(
    name: ReferenceToolName,
    input: unknown,
    context: OperationContext,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof toolResult>> {
    requireOperationScope(context, 'hoi4:read');
    const parsed = schemas[name].parse(input);
    const workspaceId = await resolveOperationWorkspaceId(
      this.engine,
      context,
      parsed.workspaceId,
      signal,
    );
    const workspace = this.engine.resolver.get(workspaceId, context.principal);
    const data =
      name === 'hoi4.reference_search'
        ? await this.references.search(
            workspace,
            referenceSearchRequestSchema.parse(parsed),
            signal,
          )
        : name === 'hoi4.reference_read'
          ? await this.references.read(workspace, referenceReadRequestSchema.parse(parsed), signal)
          : name === 'hoi4.reference_context'
            ? await this.references.context(
                workspace,
                referenceContextRequestSchema.parse(parsed),
                signal,
              )
            : name === 'hoi4.script_validate'
              ? await this.validateScript(
                  workspaceId,
                  workspace,
                  scriptValidateRequestSchema.parse(parsed),
                  context.principal,
                  signal,
                )
              : await sourceLookup(
                  this.engine,
                  workspaceId,
                  sourceLookupRequestSchema.parse(parsed),
                  context.principal,
                  signal,
                );
    const result = emptyServiceResult(workspaceId, data);
    if (name === 'hoi4.script_validate') {
      const checked = scriptValidateDataSchema.parse(data);
      result.code = checked.valid === null ? 'SCRIPT_CHECK_PARTIAL' : 'SCRIPT_CHECKED';
      result.validation = {
        passed: checked.valid === true,
        checks: [
          {
            id: 'script-command-checks',
            passed: checked.valid === true,
            message:
              checked.valid === true
                ? 'Syntax, native command kinds and declared scopes match the selected documentation'
                : checked.valid === false
                  ? 'Script checks found an error'
                  : 'Script checks have unresolved coverage',
          },
        ],
      };
      result.diagnostics = checked.findings
        .filter(({ status }) => status !== 'supported')
        .slice(0, 20)
        .map((finding) => ({
          code: finding.code,
          severity: finding.status === 'error' ? ('error' as const) : ('warning' as const),
          category: 'validation' as const,
          message: finding.message,
          details: {
            command: finding.command,
            kind: finding.kind,
            scope: finding.scope,
            line: finding.line,
            column: finding.column,
          },
        }));
      while (
        Buffer.byteLength(JSON.stringify(result.diagnostics), 'utf8') > 4096 &&
        result.diagnostics.length > 1
      )
        result.diagnostics.pop();
    }
    return toolResult(result);
  }

  readonly #eventPopups = new Map<
    string,
    { key: string; events: ReadonlyMap<string, EventPopupDefinition> }
  >();

  /** The latest player-text context of each workspace, keyed by its source files' hashes. */
  readonly #playerText = new Map<string, { key: string; context: PlayerTextContext }>();

  /** File mode reads the scanned file and the mod's scripted helper names from one scan. */
  private async validateScript(
    workspaceId: string,
    workspace: ResolvedWorkspace,
    request: z.infer<typeof scriptValidateRequestSchema>,
    principal?: string,
    signal?: AbortSignal,
  ) {
    if (request.path === undefined)
      return validateScript(this.references, workspace, request, signal);
    const snapshot = await this.engine.scan(
      workspaceId,
      {
        patterns: [
          ...(locatePatterns(this.engine, workspaceId, request.path, principal) ?? []),
          'common/scripted_effects/**/*.txt',
          'common/scripted_triggers/**/*.txt',
          ...Object.keys(implicitTriggerSources).map((folder) => `common/${folder}/*.txt`),
          // One scan serves every check: the engine keeps one snapshot per workspace.
          ...playerTextPatterns,
          'events/**/*.txt',
        ],
      },
      principal,
      signal,
    );
    const file = selectFile(snapshot, request.path);
    const playerText = playerTextFamily(file.relativePath)
      ? this.playerTextContext(workspaceId, snapshot)
      : undefined;
    const helpers = (kind: string) =>
      new Set(snapshot.index.symbols.filter((symbol) => symbol.kind === kind).map(({ id }) => id));
    return validateScript(this.references, workspace, request, signal, {
      path: file.displayPath,
      relativePath: file.relativePath,
      bytes: file.bytes,
      helpers: { effect: helpers('scripted_effect'), trigger: helpers('scripted_trigger') },
      implicitTriggers: implicitTriggerNames(snapshot),
      ...(playerText === undefined ? {} : { playerText }),
      eventPopups: this.eventPopupContext(workspaceId, snapshot),
    });
  }

  /** Every active event definition, cached by the hashes of the events files. */
  private eventPopupContext(
    workspaceId: string,
    snapshot: ScanSnapshot,
  ): ReadonlyMap<string, EventPopupDefinition> {
    const sources = [...snapshot.index.files.values()]
      .filter(
        ({ relativePath, shadowedBy }) =>
          shadowedBy === undefined && relativePath.startsWith('events/'),
      )
      .sort((left, right) => left.loadOrder - right.loadOrder);
    const cacheKey = hashCanonical(sources.map(({ displayPath, sha256 }) => [displayPath, sha256]));
    const cached = this.#eventPopups.get(workspaceId);
    if (cached?.key === cacheKey) return cached.events;
    const events = new Map<string, EventPopupDefinition>();
    for (const file of sources)
      for (const [id, definition] of eventPopupDefinitions(file.bytes, file.displayPath))
        events.set(id, definition);
    this.#eventPopups.set(workspaceId, { key: cacheKey, events });
    return events;
  }

  /** English localisation as the game resolves it, and the branches of scripted localisation. */
  private playerTextContext(workspaceId: string, snapshot: ScanSnapshot): PlayerTextContext {
    const sources = [...snapshot.index.files.values()].filter(({ relativePath }) =>
      playerTextSource(relativePath),
    );
    const cacheKey = hashCanonical(sources.map(({ displayPath, sha256 }) => [displayPath, sha256]));
    const cached = this.#playerText.get(workspaceId);
    if (cached?.key === cacheKey) return cached.context;
    const localisation = new Map<string, LocalisedText & { loadOrder: number }>();
    for (const symbol of snapshot.index.symbols) {
      if (symbol.kind !== 'localisation' || !symbol.id.startsWith('l_english:')) continue;
      const key = symbol.id.slice('l_english:'.length);
      const previous = localisation.get(key);
      if (previous !== undefined && previous.loadOrder > symbol.loadOrder) continue;
      localisation.set(key, {
        value: typeof symbol.metadata.value === 'string' ? symbol.metadata.value : '',
        path: symbol.path,
        line: symbol.location?.start.line ?? 1,
        loadOrder: symbol.loadOrder,
      });
    }
    const scriptedLocalisation = new Map<string, string[]>();
    for (const file of sources) {
      if (!file.relativePath.startsWith('common/scripted_localisation/')) continue;
      for (const definition of parseClausewitz(file.bytes, file.displayPath).root.entries) {
        if (
          definition.type !== 'assignment' ||
          definition.key.value !== 'defined_text' ||
          definition.value.type !== 'block'
        )
          continue;
        let name: string | undefined;
        const keys: string[] = [];
        for (const entry of definition.value.entries) {
          if (entry.type !== 'assignment') continue;
          if (entry.key.value === 'name' && entry.value.type === 'scalar') name = entry.value.value;
          if (entry.key.value !== 'text' || entry.value.type !== 'block') continue;
          for (const branch of entry.value.entries)
            if (
              branch.type === 'assignment' &&
              /^locali[sz]ation_key$/u.test(branch.key.value) &&
              branch.value.type === 'scalar'
            )
              keys.push(branch.value.value);
        }
        if (name !== undefined) scriptedLocalisation.set(name, keys);
      }
    }
    const context = { localisation, scriptedLocalisation };
    this.#playerText.set(workspaceId, { key: cacheKey, context });
    return context;
  }
}

const playerTextPatterns = [
  'localisation/**/*_l_english.yml',
  'common/scripted_localisation/**/*.txt',
] as const;

function playerTextSource(relativePath: string): boolean {
  const file = relativePath.replaceAll('\\', '/').toLowerCase();
  return (
    (file.startsWith('localisation/') && file.endsWith('_l_english.yml')) ||
    file.startsWith('common/scripted_localisation/')
  );
}

/** Files whose player-facing text and requirement tooltips file mode checks. */
function playerTextFamily(relativePath: string): boolean {
  const file = relativePath.replaceAll('\\', '/').toLowerCase();
  return (
    file.startsWith('events/') ||
    file.startsWith('common/national_focus/') ||
    (file.startsWith('common/decisions/') && !file.startsWith('common/decisions/categories/'))
  );
}
