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

const schemas = {
  'hoi4.reference_search': referenceSearchRequestSchema,
  'hoi4.reference_read': referenceReadRequestSchema,
  'hoi4.reference_context': referenceContextRequestSchema,
  'hoi4.source_lookup': sourceLookupRequestSchema,
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
            : await sourceLookup(
                this.engine,
                workspaceId,
                sourceLookupRequestSchema.parse(parsed),
                context.principal,
                signal,
              );
    return toolResult(emptyServiceResult(workspaceId, data));
  }
}
