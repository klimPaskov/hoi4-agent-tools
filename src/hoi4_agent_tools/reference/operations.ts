import type { CoreEngine } from '../core/engine.js';
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
              ? await validateScript(
                  this.references,
                  workspace,
                  scriptValidateRequestSchema.parse(parsed),
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
}
