import { describe, expect, it } from 'vitest';
import { emptyServiceResult, ServiceError } from '../../src/hoi4_agent_tools/core/result.js';
import {
  errorResult,
  MAX_INLINE_FILES_SCANNED,
  MAX_TOOL_RESULT_BYTES,
  setInlineFilesScanned,
  toolResult,
} from '../../src/hoi4_agent_tools/mcp/server/result.js';

describe('MCP error privacy', () => {
  it('does not expose unknown exception messages or path-bearing causes', () => {
    const secretPath =
      process.platform === 'win32' ? 'C:\\Users\\secret\\workspace' : '/home/secret/workspace';
    const unknown = errorResult(new Error(`ENOENT opening ${secretPath}`), 'test');
    expect(unknown.structuredContent).toMatchObject({
      code: 'INTERNAL_ERROR',
      blockers: [{ message: 'Unexpected internal error' }],
    });
    expect(JSON.stringify(unknown.structuredContent)).not.toContain(secretPath);

    const expected = errorResult(
      new ServiceError('EXPECTED_FAILURE', 'The requested artifact is unavailable', {
        cause: `ENOENT opening ${secretPath}`,
        relativePath: 'common/example.txt',
      }),
      'test',
    );
    expect(expected.structuredContent).toMatchObject({
      blockers: [
        {
          code: 'EXPECTED_FAILURE',
          details: { relativePath: 'common/example.txt' },
        },
      ],
    });
    expect(JSON.stringify(expected.structuredContent)).not.toContain(secretPath);
  });

  it('omits absent artifact sizes and distinguishes blocked service errors', () => {
    const success = emptyServiceResult('test', {});
    success.artifacts = [
      {
        uri: 'hoi4-artifact://test/fixture',
        name: 'fixture.json',
        mimeType: 'application/json',
      },
    ];
    expect(toolResult(success).content).toContainEqual({
      type: 'resource_link',
      uri: 'hoi4-artifact://test/fixture',
      name: 'fixture.json',
      mimeType: 'application/json',
    });

    const blocked = errorResult(new ServiceError('WRITE_BLOCKED', 'Write is blocked'), 'test');
    expect(blocked.structuredContent).toMatchObject({ status: 'blocked', code: 'WRITE_BLOCKED' });
    expect(blocked.isError).toBeUndefined();
  });

  it('bounds inline source inventories and reports the complete count', () => {
    const result = emptyServiceResult('test', {});
    const files = Array.from(
      { length: MAX_INLINE_FILES_SCANNED + 20 },
      (_, index) => `common/generated/${index}.txt`,
    );
    setInlineFilesScanned(result, files);
    expect(result.filesScanned).toHaveLength(MAX_INLINE_FILES_SCANNED);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'MCP_INLINE_FILES_TRUNCATED',
      details: { total: files.length, returned: MAX_INLINE_FILES_SCANNED },
    });
    result.diagnostics = [];
    expect(toolResult(result).structuredContent).toMatchObject({
      diagnostics: [{ code: 'MCP_INLINE_FILES_TRUNCATED' }],
    });
  });

  it('preserves the operation outcome with compact links when a response exceeds its byte budget', () => {
    const result = emptyServiceResult('test', { payload: 'x'.repeat(MAX_TOOL_RESULT_BYTES + 1) });
    result.artifacts = [
      {
        uri: 'hoi4-agent://workspace/test/artifact/fixture',
        name: 'complete.json',
        mimeType: 'application/json',
      },
    ];
    const bounded = toolResult(result);
    expect(bounded.structuredContent).toMatchObject({
      status: 'ok',
      code: 'OK',
      artifacts: [{ name: 'complete.json' }],
      diagnostics: [
        { code: 'MCP_RESPONSE_TRUNCATED', details: { maxBytes: MAX_TOOL_RESULT_BYTES } },
      ],
      blockers: [],
      data: {},
    });
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_BYTES,
    );
  });

  it('bounds deep, cyclic, and non-finite unknown detail payloads without recursion failure', () => {
    const deep: Record<string, unknown> = {};
    let current = deep;
    for (let depth = 0; depth < 20_000; depth += 1) {
      const next: Record<string, unknown> = {};
      current.next = next;
      current = next;
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    for (const payload of [
      deep,
      cyclic,
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
    ]) {
      const result = emptyServiceResult('test', { payload });
      const output = toolResult(result);
      expect(output.structuredContent).toMatchObject({
        status: 'ok',
        code: 'OK',
        diagnostics: [{ code: 'MCP_RESPONSE_TRUNCATED' }],
        data: {},
      });
      expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThanOrEqual(
        MAX_TOOL_RESULT_BYTES,
      );
    }
  });

  it('measures the final MCP result without duplicating structured JSON into text', () => {
    const result = emptyServiceResult('test', { payload: 'x'.repeat(300_000) });
    const output = toolResult(result);
    expect(output.structuredContent).toMatchObject({ status: 'ok', code: 'OK' });
    expect(output.content[0]).toMatchObject({ type: 'text' });
    expect('text' in output.content[0]! ? output.content[0].text.length : 0).toBeLessThan(256);
    expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_BYTES,
    );
  });

  it('retains usable artifact links while bounding untrusted descriptions', () => {
    const result = emptyServiceResult('test', {});
    result.artifacts = [
      {
        uri: 'hoi4-agent://workspace/test/artifact/fixture',
        name: 'fixture.json',
        mimeType: 'application/json',
        description: 'd'.repeat(600_000),
      },
    ];
    const output = toolResult(result);
    expect(output.structuredContent).toMatchObject({
      status: 'ok',
      artifacts: [{ name: 'fixture.json' }],
    });
    const link = output.content.find((entry) => entry.type === 'resource_link');
    expect(link).toMatchObject({ type: 'resource_link', name: 'fixture.json' });
    expect(link !== undefined && 'description' in link ? link.description.length : 0).toBe(1_024);
    expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_BYTES,
    );
  });
});
