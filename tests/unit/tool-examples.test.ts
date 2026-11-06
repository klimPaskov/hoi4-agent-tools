import { describe, expect, it } from 'vitest';
import {
  acceptedFields,
  ARGUMENT_EXAMPLES,
  invalidArgumentsError,
} from '../../src/hoi4_agent_tools/mcp/server/argument-errors.js';
import { taskToolCatalog } from '../../src/hoi4_agent_tools/mcp/server/task-tool-catalog.js';
import { jobControlTools } from '../../src/hoi4_agent_tools/mcp/tools/job.js';
import { referenceTools } from '../../src/hoi4_agent_tools/mcp/tools/reference.js';
import { normalizeToolArguments } from '../../src/hoi4_agent_tools/schemas/lenient-arguments.js';

/**
 * Every example a tool description or an argument error shows must be a call the server accepts
 * (#65). An agent copies them; the source_lookup example once failed with INVALID_ARGUMENTS.
 * Only these documented placeholders stand for values the caller has from an earlier result.
 */
const PLACEHOLDERS: Array<[RegExp, string]> = [
  [/job_<64 hex characters[^>]*>/gu, `job_${'a'.repeat(64)}`],
  [/<hit id>/gu, 'b'.repeat(64)],
  [/<hit revision>/gu, 'c'.repeat(64)],
  [/<id of a reference_search result>/gu, 'b'.repeat(64)],
  [/<revision of the same result>/gu, 'c'.repeat(64)],
  [/<sha256 of the file>/gu, 'd'.repeat(64)],
];

/** The JSON objects after "Example:" in a description, including those joined by "or". */
function examplesIn(text: string): string[] {
  const found: string[] = [];
  let at = text.indexOf('Example: ');
  if (at < 0) return found;
  at += 'Example: '.length;
  while (text[at] === '{') {
    let depth = 0;
    let quoted = false;
    let end = at;
    for (; end < text.length; end += 1) {
      const char = text[end];
      if (quoted) {
        if (char === '\\') end += 1;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) break;
    }
    found.push(text.slice(at, end + 1));
    at = end + 1;
    if (text.startsWith(' or ', at)) at += ' or '.length;
  }
  return found;
}

const tools = [...taskToolCatalog, ...referenceTools, ...jobControlTools];

describe('tool examples', () => {
  const cases = tools.flatMap(({ name, description, inputSchema }) => [
    ...examplesIn(description).map((example) => ({ name, example, inputSchema, from: 'tool' })),
    ...(ARGUMENT_EXAMPLES[name] === undefined
      ? []
      : examplesIn(`Example: ${ARGUMENT_EXAMPLES[name]}`).map((example) => ({
          name,
          example,
          inputSchema,
          from: 'error',
        }))),
  ]);

  it('finds an example for every tool', () => {
    const named = new Set(cases.map(({ name }) => name));
    expect(tools.map(({ name }) => name).filter((name) => !named.has(name))).toEqual([]);
  });

  it.each(cases)('$name $from example is accepted: $example', ({ name, example, inputSchema }) => {
    let text = example;
    for (const [pattern, value] of PLACEHOLDERS) text = text.replace(pattern, value);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const result = inputSchema.safeParse(
      normalizeToolArguments(name, { workspaceId: 'current', ...parsed }),
    );
    expect(result.success, JSON.stringify(result.error?.issues.slice(0, 3))).toBe(true);
  });
});

describe('shape errors', () => {
  it('names the fields an object accepts when a field is unknown (#65)', () => {
    const tool = tools.find(({ name }) => name === 'hoi4.probability_analyze')!;
    const parsed = tool.inputSchema.safeParse(
      normalizeToolArguments(tool.name, {
        workspaceId: 'current',
        analysis: 'sweep',
        source: 'common/decisions/my_decisions.txt',
        candidatePool: ['my_decision'],
        scenarioSet: [{ actor: 'GER', flagz: [] }],
        sweep: { paths: ['variable.pressure'], steps: 3 },
      }),
    );
    expect(parsed.success).toBe(false);
    const message = invalidArgumentsError(tool.name, parsed.error!, tool.inputSchema).message;
    expect(message).toMatch(/unknown field flagz; accepted fields: id, .*actor, .*state, .*flags/u);
    // Through wrappers, unions and arrays alike.
    expect(acceptedFields(tool.inputSchema, [])).toContain('scenarioSet');
    expect(acceptedFields(tool.inputSchema, ['sweep'])).toContain('paths');
  });
});
