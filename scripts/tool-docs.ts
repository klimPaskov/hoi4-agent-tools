import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import prettier from 'prettier';
import { serverConfigurationSchema } from '../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../src/hoi4_agent_tools/mcp/server/create.js';

// docs/tools.md keeps its prose by hand. The tool tables and the example table between the
// markers below are generated from the default tools/list, so a renamed, added or reworded tool
// shows up as drift in tests/integration/tool-docs.test.ts.

export const TOOL_DOCS_PATH = path.resolve(import.meta.dirname, '../docs/tools.md');

const TABLES = ['<!-- generated:tool-tables:start -->', '<!-- generated:tool-tables:end -->'];
const EXAMPLES = ['<!-- generated:tool-examples:start -->', '<!-- generated:tool-examples:end -->'];

/** Section order and membership. Every default tool must appear exactly once. */
export const TOOL_GROUPS: ReadonlyArray<{ heading: string; tools: readonly string[] }> = [
  {
    heading: 'References and source',
    tools: [
      'hoi4.reference_context',
      'hoi4.reference_search',
      'hoi4.reference_read',
      'hoi4.source_lookup',
      'hoi4.script_validate',
      'hoi4.error_log',
      'hoi4.mod_index',
      'hoi4.localisation_inspect',
      'hoi4.idea_inspect',
      'hoi4.system_inspect',
      'hoi4.unit_inspect',
      'hoi4.asset_inspect',
      'hoi4.skill',
    ],
  },
  {
    heading: 'Focus trees',
    tools: ['hoi4.focus_inspect', 'hoi4.focus_render', 'hoi4.focus_rewrite'],
  },
  { heading: 'Scripted GUIs', tools: ['hoi4.gui_inspect', 'hoi4.gui_render', 'hoi4.gui_rewrite'] },
  { heading: 'Maps', tools: ['hoi4.map_inspect', 'hoi4.map_rewrite'] },
  { heading: 'Events', tools: ['hoi4.event_inspect', 'hoi4.event_render'] },
  { heading: 'Technology and doctrines', tools: ['hoi4.tech_inspect', 'hoi4.tech_render'] },
  {
    heading: 'AI weights and timing',
    tools: ['hoi4.probability_inspect', 'hoi4.probability_analyze'],
  },
  {
    heading: 'Decisions, impact and tests',
    tools: [
      'hoi4.impact_inspect',
      'hoi4.decision_inspect',
      'hoi4.mechanic_test',
      'hoi4.package_check',
      'hoi4.scenario_test',
    ],
  },
  { heading: 'Background jobs', tools: ['hoi4.job_inspect', 'hoi4.job_cancel'] },
];

/** The tools/list a default server answers: no ChaosX tools, one empty workspace. */
export async function listDefaultTools(): Promise<Tool[]> {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-tool-docs-'));
  try {
    await mkdir(path.join(root, 'docs'));
    const config = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [{ id: 'docs', name: 'docs', root: path.join(root, 'docs') }],
    });
    const server = createMcpServer(new CoreEngine(await WorkspaceResolver.create(config)), {});
    const client = new Client({ name: 'tool-docs', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return (await client.listTools()).tools;
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Problems that make the tables wrong whatever the file says. */
export function toolDocProblems(tools: readonly Tool[]): string[] {
  const problems: string[] = [];
  const names = tools.map(({ name }) => name);
  for (const name of new Set(names.filter((name, index) => names.indexOf(name) !== index)))
    problems.push(`duplicate tool name ${name}`);
  const grouped = TOOL_GROUPS.flatMap(({ tools: members }) => members);
  for (const name of new Set(grouped.filter((name, index) => grouped.indexOf(name) !== index)))
    problems.push(`${name} is listed in more than one section`);
  for (const name of names)
    if (!grouped.includes(name)) problems.push(`${name} has no section in TOOL_GROUPS`);
  for (const name of grouped)
    if (!names.includes(name)) problems.push(`${name} is in TOOL_GROUPS but not in tools/list`);
  for (const tool of tools) {
    if (purpose(tool) === '') problems.push(`${tool.name} has no description before its example`);
    if (examples(tool).length === 0) problems.push(`${tool.name} has no example call`);
  }
  return problems;
}

function purpose(tool: Tool): string {
  const description = tool.description ?? '';
  const at = description.indexOf('Example:');
  return (at < 0 ? description : description.slice(0, at)).trim();
}

/** Each JSON object that follows "Example:" in the description, in order. */
function examples(tool: Tool): string[] {
  const description = tool.description ?? '';
  const at = description.indexOf('Example:');
  if (at < 0) return [];
  const found: string[] = [];
  let index = at;
  for (;;) {
    const start = description.indexOf('{', index);
    if (start < 0) break;
    const end = closingBrace(description, start);
    if (end < 0) break;
    found.push(description.slice(start, end + 1));
    // Only objects joined by " or " belong to the example.
    const rest = description.slice(end + 1);
    if (!rest.startsWith(' or {')) break;
    index = end + 1;
  }
  return found;
}

function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (character === '\\') index += 1;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return index;
  }
  return -1;
}

/** What a call can change, from the tool's MCP annotations. */
function writes(tool: Tool): string {
  const annotations = tool.annotations ?? {};
  if (annotations.readOnlyHint === true) return '—';
  if (annotations.destructiveHint !== true) return 'review files';
  // A destructive call that is safe to repeat stops work rather than editing source.
  return annotations.idempotentHint === true ? 'job state' : 'mod files';
}

const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');

function tablesMarkdown(tools: readonly Tool[]): string {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return TOOL_GROUPS.map(({ heading, tools: members }) =>
    [
      `## ${heading}`,
      '',
      '| Tool | Purpose | Writes |',
      '| --- | --- | --- |',
      ...members.map((name) => {
        const tool = byName.get(name)!;
        return `| \`${name}\` | ${cell(purpose(tool))} | ${writes(tool)} |`;
      }),
    ].join('\n'),
  ).join('\n\n');
}

function examplesMarkdown(tools: readonly Tool[]): string {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return [
    '| Tool | Example arguments |',
    '| --- | --- |',
    ...TOOL_GROUPS.flatMap(({ tools: members }) => members).map(
      (name) =>
        `| \`${name}\` | ${examples(byName.get(name)!)
          .map((example) => `\`${cell(example)}\``)
          .join(' or ')} |`,
    ),
  ].join('\n');
}

function replaceBetween(markdown: string, [start, end]: string[], body: string): string {
  const from = markdown.indexOf(start!);
  const to = markdown.indexOf(end!);
  if (from < 0 || to < from) throw new Error(`docs/tools.md is missing the marker ${start}`);
  return `${markdown.slice(0, from + start!.length)}\n\n${body}\n\n${markdown.slice(to)}`;
}

/** docs/tools.md with its generated parts rebuilt from `tools`, formatted as Prettier would. */
export async function renderToolDocs(markdown: string, tools: readonly Tool[]): Promise<string> {
  const problems = toolDocProblems(tools);
  if (problems.length > 0)
    throw new Error(`Cannot generate the tool tables:\n${problems.join('\n')}`);
  const next = replaceBetween(
    replaceBetween(markdown, TABLES, tablesMarkdown(tools)),
    EXAMPLES,
    examplesMarkdown(tools),
  );
  const options = await prettier.resolveConfig(TOOL_DOCS_PATH);
  return prettier.format(next, { ...options, filepath: TOOL_DOCS_PATH });
}
