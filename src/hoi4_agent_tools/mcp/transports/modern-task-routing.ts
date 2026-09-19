import {
  isJSONRPCRequest,
  isJSONRPCNotification,
  PROTOCOL_VERSION_META_KEY,
  Server,
  type Transport,
} from '@modelcontextprotocol/server';
import { CancelledNotificationSchema } from '@modelcontextprotocol/core';
import { secureId } from '../../core/canonical.js';

export const MODERN_TASK_ROUTES = new Map([
  ['tasks/get', 'io.github.klimPaskov/hoi4-agent-tools.internal/tasks/get'],
  ['tasks/update', 'io.github.klimPaskov/hoi4-agent-tools.internal/tasks/update'],
  ['tasks/cancel', 'io.github.klimPaskov/hoi4-agent-tools.internal/tasks/cancel'],
]);
const privateMethods = new Set(MODERN_TASK_ROUTES.values());

/**
 * SDK 2.0.0 issue #2598: historical tasks/get and tasks/cancel are rejected by
 * its core-method era gate before registered extension handlers can run.
 * Rewrite only these extension method names at the public Transport seam.
 * The SDK still validates the envelope and pins the era; HTTP/auth metadata,
 * request IDs, cancellation, params, and every other method remain untouched.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- Public advanced Server API is needed to decorate its transport; McpServer cannot inject one.
export class ModernTaskRoutingServer extends Server {
  override async connect(transport: Transport): Promise<void> {
    // SDK 2.0.0's cancellation handler ignores falsy IDs (0 and ''). Give only those
    // active requests private truthy IDs internally and preserve their exact wire IDs.
    const requestAliases = new Map<0 | '', string>();
    const responseAliases = new Map<string, 0 | ''>();
    const releaseAlias = (alias: string): void => {
      const original = responseAliases.get(alias);
      if (original !== undefined) requestAliases.delete(original);
      responseAliases.delete(alias);
    };
    const routed: Transport = {
      get sessionId() {
        return transport.sessionId;
      },
      ...(transport.hasPerRequestStream === undefined
        ? {}
        : { hasPerRequestStream: transport.hasPerRequestStream }),
      start: async () => {
        transport.onclose = () => {
          requestAliases.clear();
          responseAliases.clear();
          routed.onclose?.();
        };
        transport.onerror = (error) => routed.onerror?.(error);
        transport.onmessage = (message, extra) => {
          if (isJSONRPCRequest(message) && privateMethods.has(message.method)) {
            void transport
              .send({
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32601, message: 'Method not found' },
              })
              .catch((error: unknown) =>
                routed.onerror?.(
                  error instanceof Error ? error : new Error('Response could not be sent'),
                ),
              );
            return;
          }
          const alias =
            isJSONRPCRequest(message) &&
            message.params?._meta?.[PROTOCOL_VERSION_META_KEY] === '2026-07-28'
              ? MODERN_TASK_ROUTES.get(message.method)
              : undefined;
          let inbound = alias === undefined ? message : { ...message, method: alias };
          if (isJSONRPCRequest(inbound) && (inbound.id === 0 || inbound.id === '')) {
            if (requestAliases.has(inbound.id)) {
              void transport
                .send({
                  jsonrpc: '2.0',
                  id: inbound.id,
                  error: { code: -32600, message: 'Request ID is already active' },
                })
                .catch((error: unknown) =>
                  routed.onerror?.(
                    error instanceof Error ? error : new Error('Response could not be sent'),
                  ),
                );
              return;
            }
            const requestAlias = secureId('mcp_request');
            requestAliases.set(inbound.id, requestAlias);
            responseAliases.set(requestAlias, inbound.id);
            inbound = { ...inbound, id: requestAlias };
          } else if (
            isJSONRPCNotification(inbound) &&
            inbound.method === 'notifications/cancelled' &&
            CancelledNotificationSchema.safeParse(inbound).success
          ) {
            const original = inbound.params?.requestId;
            const requestAlias =
              original === 0 || original === '' ? requestAliases.get(original) : undefined;
            if (requestAlias !== undefined) {
              inbound = { ...inbound, params: { ...inbound.params, requestId: requestAlias } };
              releaseAlias(requestAlias);
            }
          }
          routed.onmessage?.(inbound, extra);
        };
        await transport.start();
      },
      send: (message, options) => {
        const original =
          'id' in message && typeof message.id === 'string'
            ? responseAliases.get(message.id)
            : undefined;
        const related =
          typeof options?.relatedRequestId === 'string'
            ? responseAliases.get(options.relatedRequestId)
            : undefined;
        const outbound = original === undefined ? message : { ...message, id: original };
        if (original !== undefined && 'id' in message && typeof message.id === 'string')
          releaseAlias(message.id);
        return transport.send(
          outbound,
          related === undefined ? options : { ...options, relatedRequestId: related },
        );
      },
      close: () => transport.close(),
      setProtocolVersion: (version) => transport.setProtocolVersion?.(version),
      setSupportedProtocolVersions: (versions) =>
        transport.setSupportedProtocolVersions?.(versions),
    };
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Connect the public advanced Server API after wrapping the transport.
    await super.connect(routed);
  }
}
