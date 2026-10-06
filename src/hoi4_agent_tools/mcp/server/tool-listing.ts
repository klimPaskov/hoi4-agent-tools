/**
 * Every tool schema is sent to the client's model on each session, so listed schemas carry no
 * bytes that change nothing: the per-schema `$schema` dialect declaration (the schemas use no
 * dialect-specific keywords, so the MCP default dialect reads them identically) and the
 * safe-integer bounds that every unbounded integer receives.
 */

const SAFE_INTEGER_BOUNDS = new Map([
  ['maximum', Number.MAX_SAFE_INTEGER],
  ['minimum', Number.MIN_SAFE_INTEGER],
]);

function slimSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(slimSchema);
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$schema') continue;
    if (SAFE_INTEGER_BOUNDS.get(key) === child) continue;
    result[key] = slimSchema(child);
  }
  return result;
}

/** Remove redundant schema bytes from one listed tool, leaving everything else untouched. */
export function slimListedTool<T extends { inputSchema?: unknown; outputSchema?: unknown }>(
  tool: T,
): T {
  return {
    ...tool,
    ...(tool.inputSchema === undefined ? {} : { inputSchema: slimSchema(tool.inputSchema) }),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: slimSchema(tool.outputSchema) }),
  };
}

/** Apply {@link slimListedTool} to a `tools/list` result. */
export function slimToolList<T>(result: T): T {
  if (result === null || typeof result !== 'object' || !('tools' in result)) return result;
  const { tools } = result as { tools: unknown };
  if (!Array.isArray(tools)) return result;
  return {
    ...result,
    tools: tools.map((tool: { inputSchema?: unknown; outputSchema?: unknown }) =>
      slimListedTool(tool),
    ),
  };
}
