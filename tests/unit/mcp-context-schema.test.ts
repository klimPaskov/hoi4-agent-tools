import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { compactValidatedInputSchema } from '../../src/hoi4_agent_tools/mcp/server/context-schemas.js';
import { strictOperationResultSchema } from '../../src/hoi4_agent_tools/mcp/server/result.js';

describe('MCP compact schema contracts', () => {
  it('advertises a compact nested input while running the complete parser', () => {
    const exactPayload = z
      .object({
        kind: z.literal('exact'),
        nested: z.object({ required: z.string().min(1) }).strict(),
      })
      .strict();
    const schema = z
      .object({
        workspaceId: z.string(),
        payload: compactValidatedInputSchema(
          exactPayload,
          'Complete synthetic payload; see package documentation.',
        ),
      })
      .strict();
    const published = z.toJSONSchema(schema, { io: 'input' });

    expect(published).toMatchObject({
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        payload: { description: 'Complete synthetic payload; see package documentation.' },
      },
      additionalProperties: false,
    });
    expect(JSON.stringify(published)).not.toContain('nested');
    expect(schema.safeParse({ workspaceId: 'test', payload: { kind: 'exact' } }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        workspaceId: 'test',
        payload: { kind: 'exact', nested: { required: 'retained' } },
      }).success,
    ).toBe(true);
  });

  it('advertises one compact result envelope while validating exact per-tool data', () => {
    const schema = strictOperationResultSchema(
      z.object({ count: z.number().int().min(0) }).strict(),
    );
    const envelope = {
      status: 'ok' as const,
      code: 'TEST_OK',
      workspaceId: 'test',
      filesScanned: [],
      proposedFiles: [],
      changedFiles: [],
      diagnostics: [],
      artifacts: [],
      validation: { passed: true, checks: [] },
      blockers: [],
      data: { count: 1 },
    };
    const published = z.toJSONSchema(schema, { io: 'output' });

    expect(published).toMatchObject({
      type: 'object',
      properties: { data: { type: 'object' } },
      additionalProperties: false,
    });
    expect(JSON.stringify(published)).not.toContain('count');
    expect(schema.safeParse(envelope).success).toBe(true);
    expect(schema.safeParse({ ...envelope, data: { count: 'wrong' } }).success).toBe(false);
    expect(schema.safeParse({ ...envelope, data: { count: 1, extra: true } }).success).toBe(false);
  });
});
