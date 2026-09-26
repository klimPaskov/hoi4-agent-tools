import { fileURLToPath } from 'node:url';
import {
  CallToolResultSchema,
  ClientCapabilitiesSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/core';
import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  ProtocolError,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { CoreEngine } from '../../core/engine.js';
import { isJobControlTool, JobControlService } from '../../core/job-controls.js';
import type { OperationContext } from '../../core/operation-context.js';
import { OperationTaskService } from '../../core/operation-tasks.js';
import { errorResult } from '../../core/operation-result.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../../version.js';
import { MODERN_TASK_ROUTES, ModernTaskRoutingServer } from '../transports/modern-task-routing.js';
import { registerModernResources } from '../resources/register-modern.js';
import { registerModernPrompts } from '../prompts/register-modern.js';
import { jobControlTools } from '../tools/job.js';
import { referenceTools } from '../tools/reference.js';
import { isReferenceTool, ReferenceToolService } from '../../reference/operations.js';
import type { createChaosxToolOperations } from '../tools/chaosx.js';
import { ModernTaskAdapter, TASKS_EXTENSION } from './modern-tasks.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { modernProgressReporter, withProgressHeartbeat } from './progress.js';
import { taskToolCatalog } from './task-tool-catalog.js';
import type { ToolDefinition } from './task-tool-definition.js';

const rootsResponseSchema = z
  .object({
    roots: z
      .array(z.object({ uri: z.string().max(8192), name: z.string().optional() }).loose())
      .max(256),
  })
  .loose();
const metadataParamsSchema = z.record(z.string(), z.unknown());
const workspaceRootsKey = 'hoi4-workspace-roots';

function clientCapabilities(envelope: unknown) {
  // SDK 2.0.0 publishes RequestMetaEnvelope as {}, although it retains these keys at runtime.
  const parsed = z
    .object({ [CLIENT_CAPABILITIES_META_KEY]: ClientCapabilitiesSchema })
    .loose()
    .safeParse(envelope);
  return parsed.success ? parsed.data[CLIENT_CAPABILITIES_META_KEY] : undefined;
}

/**
 * Modern operation/task factory, shared by the connection and HTTP serving entries.
 * The stdio entry explicitly opts into the two private ChaosX tools when configured.
 * HTTP remains mod-independent and never enables that private extension.
 */
export function createModernOperationServer(
  engine: CoreEngine,
  context: OperationContext = {},
  tasks = new OperationTaskService(engine),
  options: {
    createPrivateTools?: typeof createChaosxToolOperations;
  } = {},
): ModernTaskRoutingServer {
  const adapter = new ModernTaskAdapter(tasks);
  const controls = new JobControlService(engine);
  const references = new ReferenceToolService(engine);
  const privateOperations = options.createPrivateTools?.(engine, context);
  const mapEnd = taskToolCatalog.findIndex(({ name }) => name === 'hoi4.map_rewrite') + 1;
  const definitions: readonly ToolDefinition[] = [
    ...taskToolCatalog.slice(0, mapEnd),
    ...referenceTools,
    ...taskToolCatalog.slice(mapEnd),
    ...jobControlTools,
    ...(privateOperations === undefined
      ? []
      : [privateOperations.visual.definition, privateOperations.country.definition]),
  ];
  const server = new ModernTaskRoutingServer(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        extensions: { [TASKS_EXTENSION]: {} },
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  registerModernResources(server, engine, context);
  registerModernPrompts(server);
  server.setRequestHandler('tools/list', () =>
    ListToolsResultSchema.parse({
      tools: definitions.map(({ name, inputSchema, outputSchema, ...metadata }) => ({
        ...metadata,
        name,
        inputSchema: {
          ...z.toJSONSchema(inputSchema, { target: 'draft-7', io: 'input' }),
          type: 'object' as const,
        },
        ...(outputSchema === undefined
          ? {}
          : {
              outputSchema: {
                ...z.toJSONSchema(outputSchema, { target: 'draft-7', io: 'input' }),
                type: 'object' as const,
              },
            }),
      })),
    }),
  );
  server.setRequestHandler('tools/call', async (request, extra) => {
    const definition = definitions.find(({ name }) => name === request.params.name);
    if (definition === undefined)
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown tool');
    const input = definition.inputSchema.safeParse(request.params.arguments ?? {});
    if (!input.success)
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid tool arguments');
    const capabilities = clientCapabilities(extra.mcpReq.envelope);
    const arguments_ = z.record(z.string(), z.json()).parse(input.data);
    let operationContext = context;
    if (
      (arguments_.workspaceId === undefined || arguments_.workspaceId === 'current') &&
      capabilities?.roots !== undefined &&
      context.resolveCurrentWorkspaceId === undefined
    ) {
      const response = extra.mcpReq.inputResponses?.[workspaceRootsKey];
      if (response === undefined)
        return inputRequired({ inputRequests: { [workspaceRootsKey]: inputRequired.listRoots() } });
      const roots = rootsResponseSchema.safeParse(response);
      if (!roots.success)
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          'Invalid workspace roots response',
        );
      const paths = roots.data.roots.flatMap(({ uri }) => {
        try {
          return new URL(uri).protocol === 'file:' ? [fileURLToPath(uri)] : [];
        } catch {
          return [];
        }
      });
      operationContext = {
        ...context,
        resolveCurrentWorkspaceId: async () =>
          engine.resolver.resolveClientWorkspaceId(paths, context.principal),
      };
    }
    try {
      if (isReferenceTool(definition.name)) {
        const name = definition.name;
        const result = await withProgressHeartbeat(
          () =>
            engine.requests.run(
              references,
              Buffer.byteLength(JSON.stringify(arguments_)),
              extra.mcpReq.signal,
              () =>
                engine.sharedRequests.run(extra.mcpReq.signal, () =>
                  references.call(name, arguments_, operationContext, extra.mcpReq.signal),
                ),
            ),
          modernProgressReporter(extra),
        );
        definition.outputSchema?.parse(result.structuredContent);
        return CallToolResultSchema.parse({
          ...result,
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private',
        });
      }
      if (privateOperations !== undefined) {
        const operations =
          operationContext === context || options.createPrivateTools === undefined
            ? privateOperations
            : options.createPrivateTools(engine, operationContext);
        const progress = modernProgressReporter(extra);
        if (definition.name === operations.visual.definition.name) {
          const result = await operations.visual.call(
            operations.visual.definition.inputSchema.parse(arguments_),
            progress,
          );
          if (result.isError !== true)
            operations.visual.definition.outputSchema.parse(result.structuredContent);
          return CallToolResultSchema.parse({
            ...result,
            resultType: 'complete',
            ttlMs: 0,
            cacheScope: 'private',
          });
        }
        if (definition.name === operations.country.definition.name) {
          const result = await operations.country.call(
            operations.country.definition.inputSchema.parse(arguments_),
            progress,
          );
          if (result.isError !== true)
            operations.country.definition.outputSchema.parse(result.structuredContent);
          return CallToolResultSchema.parse({
            ...result,
            resultType: 'complete',
            ttlMs: 0,
            cacheScope: 'private',
          });
        }
      }
      if (isJobControlTool(definition.name)) {
        const result = await controls.call(
          definition.name,
          arguments_,
          operationContext,
          extra.mcpReq.signal,
        );
        const completed = CallToolResultSchema.parse({
          ...result,
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private',
        });
        if (definition.outputSchema !== undefined)
          definition.outputSchema.parse(completed.structuredContent);
        return completed;
      }
      const progress = modernProgressReporter(extra);
      const result = await withProgressHeartbeat(async () => {
        const completed = await adapter.call(
          { name: definition.name, arguments: arguments_ },
          capabilities,
          operationContext,
          {
            requestId: extra.mcpReq.id,
            signal: extra.mcpReq.signal,
            ...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
          },
        );
        // A native task response ends this request, not the durable operation.
        // Subsequent state and progress come from authenticated tasks/get polling.
        if (completed.resultType !== 'task') {
          await progress.report(2, 3, 'Retrieving persistent operation result');
          await progress.report(3, 3, 'Persistent operation complete');
        }
        return completed;
      }, progress);
      return CallToolResultSchema.parse({ content: [], ...result });
    } catch (error) {
      if (error instanceof ProtocolError || extra.mcpReq.signal.aborted) throw error;
      return errorResult(
        error,
        typeof arguments_.workspaceId === 'string' ? arguments_.workspaceId : 'current',
      );
    }
  });
  for (const [method, alias] of MODERN_TASK_ROUTES) {
    server.setRequestHandler(alias, { params: metadataParamsSchema }, async (params, extra) => {
      if (
        extra.http?.req !== undefined &&
        (extra.http.req.headers.get('mcp-method') !== method ||
          extra.http.req.headers.get('mcp-name') !== params.taskId)
      )
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          'Task routing headers do not match the request',
        );
      const { _meta: _metadata, ...payload } = params;
      if (method === 'tasks/update')
        payload.inputResponses = extra.mcpReq.inputResponses ?? payload.inputResponses;
      return adapter.handle(
        method,
        payload,
        clientCapabilities(extra.mcpReq.envelope),
        context,
        extra.mcpReq.signal,
      );
    });
  }
  return server;
}
