import { readFile } from 'node:fs/promises';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  listDefaultTools,
  renderToolDocs,
  TOOL_DOCS_PATH,
  toolDocProblems,
} from '../../scripts/tool-docs.js';

const tool = (name: string, description = 'Read it. Example: {"id":"x"}.'): Tool => ({
  name,
  description,
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true },
});

describe('generated tool reference', () => {
  let tools: Tool[];
  beforeAll(async () => {
    tools = await listDefaultTools();
  }, 120_000);

  it('matches tools/list, so a changed tool fails until npm run docs:tools is rerun', async () => {
    expect(toolDocProblems(tools)).toEqual([]);
    const current = await readFile(TOOL_DOCS_PATH, 'utf8');
    expect(await renderToolDocs(current, tools)).toBe(current);
  }, 120_000);

  it('reports duplicate, undocumented and stale tool names', async () => {
    const problems = toolDocProblems([
      ...tools.filter(({ name }) => name !== 'hoi4.job_cancel'),
      tool('hoi4.job_inspect'),
      tool('hoi4.new_inspect'),
    ]);
    expect(problems).toEqual(
      expect.arrayContaining([
        'duplicate tool name hoi4.job_inspect',
        'hoi4.new_inspect has no section in TOOL_GROUPS',
        'hoi4.job_cancel is in TOOL_GROUPS but not in tools/list',
      ]),
    );
    await expect(renderToolDocs('', [tool('hoi4.new_inspect')])).rejects.toThrow(
      'no section in TOOL_GROUPS',
    );
  }, 120_000);

  it('reports a tool without an example call', () => {
    const problems = toolDocProblems(
      tools.map((entry) =>
        entry.name === 'hoi4.job_cancel' ? tool(entry.name, 'Stop a task.') : entry,
      ),
    );
    expect(problems).toEqual(['hoi4.job_cancel has no example call']);
  });
});
