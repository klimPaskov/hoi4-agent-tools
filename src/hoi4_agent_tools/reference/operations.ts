import type { CoreEngine, ScanSnapshot } from '../core/engine.js';
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
        ],
      },
      principal,
      signal,
    );
    const file = selectFile(snapshot, request.path);
    const helpers = (kind: string) =>
      new Set(snapshot.index.symbols.filter((symbol) => symbol.kind === kind).map(({ id }) => id));
    return validateScript(this.references, workspace, request, signal, {
      path: file.displayPath,
      relativePath: file.relativePath,
      bytes: file.bytes,
      helpers: { effect: helpers('scripted_effect'), trigger: helpers('scripted_trigger') },
      implicitTriggers: implicitTriggerNames(snapshot),
    });
  }
}
