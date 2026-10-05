import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of close.splice(0).reverse()) await action();
});

const section = (name: string, scopes: string, body = `Documentation for ${name}.`) =>
  `## ${name}\n\n* Supported Scopes: ${scopes}\n* Supported Targets: none\n\n\`\`\`\n${body}\n\`\`\`\n`;

async function client() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-script-file-'));
  close.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const mod = path.join(root, 'mod');
  const game = path.join(root, 'game');
  const docs = path.join(game, 'documentation');
  for (const folder of [
    docs,
    path.join(mod, 'events'),
    path.join(mod, 'common', 'buildings'),
    path.join(mod, 'common', 'scripted_effects'),
    path.join(mod, 'common', 'decisions'),
    path.join(mod, 'common', 'scripted_localisation'),
    path.join(mod, 'localisation', 'english'),
  ])
    await mkdir(folder, { recursive: true });
  await writeFile(path.join(mod, 'descriptor.mod'), 'name="Script file check"\n');
  await writeFile(
    path.join(docs, 'effects_documentation.md'),
    [section('add_power', 'COUNTRY'), section('add_population', 'STATE')].join('\n'),
  );
  await writeFile(
    path.join(docs, 'triggers_documentation.md'),
    [
      section('has_flag', 'COUNTRY'),
      section('has_country_flag', 'COUNTRY'),
      section('custom_trigger_tooltip', 'any'),
      section('hidden_trigger', 'any'),
      section(
        'building_count_trigger',
        'STATE, COUNTRY',
        'Checks building counts.\nUsage: <Building> < <int>\nSupported buildings: infrastructure, arms_factory.',
      ),
    ].join('\n'),
  );
  await writeFile(
    path.join(docs, 'dynamic_variables_documentation.md'),
    '# Dynamic variables\n\n## num_owned_states\n\nNumber of owned states.\n',
  );
  await writeFile(
    path.join(mod, 'common', 'buildings', 'towers.txt'),
    'buildings = {\n\tsignal_tower = { base_cost = 1 }\n}\n',
  );
  await writeFile(
    path.join(mod, 'common', 'scripted_effects', 'helpers.txt'),
    'grant_power = {\n\tadd_power = 1\n}\n',
  );
  await writeFile(
    path.join(mod, 'events', 'checks.txt'),
    [
      'add_namespace = check',
      'country_event = {',
      '\tid = check.1',
      '\ttrigger = {',
      '\t\thas_flag = ready',
      '\t\tarms_factory > 1',
      '\t\tsignal_tower > 0',
      '\t\tnum_owned_states > 1',
      '\t}',
      '\timmediate = {',
      '\t\tcapital_scope = { add_population = 1 OWNER = { add_power = 1 } }',
      '\t\tcontroller = { add_power = 1 }',
      '\t\tgrant_power = yes',
      '\t\tFROM = { add_power = 1 }',
      '\t\tadd_powr = 1',
      '\t}',
      '\toption = { name = check.1.a add_power = 1 }',
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(mod, 'events', 'news.txt'),
    [
      'news_event = {',
      '\tid = news.1',
      '\ttitle = news.1.t',
      '\tdesc = news.1.d',
      '\toption = { name = news.1.a }',
      '}',
      'country_event = {',
      '\tid = news.2',
      '\ttitle = news.2.t',
      '\toption = { name = news.2.a }',
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(mod, 'common', 'decisions', 'checks.txt'),
    [
      'check_category = {',
      '\tcheck_decision = {',
      '\t\tvisible = { has_country_flag = listing_flag }',
      '\t\tavailable = {',
      '\t\t\thas_country_flag = raw_flag',
      '\t\t\thas_country_flag = named_flag',
      '\t\t\thidden_trigger = { has_country_flag = hidden_flag }',
      '\t\t\tcustom_trigger_tooltip = { tooltip = check_tt has_country_flag = covered_flag }',
      '\t\t}',
      '\t}',
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(mod, 'common', 'scripted_localisation', 'moods.txt'),
    'defined_text = { name = GetMood text = { trigger = { always = yes } localization_key = MOOD_HAPPY } }\n',
  );
  await writeFile(
    path.join(mod, 'localisation', 'english', 'checks_l_english.yml'),
    `\uFEFF${[
      'l_english:',
      ' news.1.t: "§YExtra§! edition"',
      ' news.1.d: "The city is [GetMood]."',
      ' news.1.a: "TODO write this"',
      ' news.2.t: "§RRed§! is fine outside news"',
      ' news.2.a: "Understood"',
      ' MOOD_HAPPY: "§Ghappy§!"',
      ' named_flag: "Named requirement"',
      ' check_decision: "Check"',
      ' check_decision_desc: "This decision was reworked."',
    ].join('\n')}\n`,
  );
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [{ id: 'fixture', name: 'Fixture', root: mod, gameRoot: game }],
    }),
  );
  const server = createMcpServer(new CoreEngine(resolver));
  const mcp = new Client({ name: 'script-file-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  close.push(async () => {
    await mcp.close();
    await server.close();
  });
  return mcp;
}

interface Finding {
  code: string;
  command: string;
  line: number;
  scope: string;
  message: string;
}

describe('script_validate file mode', () => {
  it('checks every script body of a mod file with the scope its structure fixes', async () => {
    const mcp = await client();
    const result = await mcp.callTool({
      name: 'hoi4.script_validate',
      arguments: { workspaceId: 'fixture', path: 'events/checks.txt', limit: 32 },
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const data = (
      result.structuredContent as {
        data: {
          valid: boolean | null;
          findings: Finding[];
          file: { family: string; roots: number; unknownScopeRoots: number };
        };
      }
    ).data;
    expect(data.valid).toBe(false);
    expect(data.file).toMatchObject({ family: 'events', roots: 3, unknownScopeRoots: 0 });
    const found = data.findings.map(({ code, command, line }) => ({ code, command, line }));
    expect(found).toEqual([
      { code: 'SCRIPT_DYNAMIC_VARIABLE_AS_TRIGGER', command: 'num_owned_states', line: 8 },
      { code: 'SCRIPT_SCOPE_LINK_WRONG_SCOPE', command: 'controller', line: 12 },
      { code: 'SCRIPT_COMMAND_UNRESOLVED', command: 'add_powr', line: 15 },
    ]);
  });

  it('checks player-facing text and requirement tooltips', async () => {
    const mcp = await client();
    const check = async (file: string) => {
      const result = await mcp.callTool({
        name: 'hoi4.script_validate',
        arguments: { workspaceId: 'fixture', path: file, limit: 32 },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      return (
        result.structuredContent as {
          data: { checksPerformed: string[]; findings: Array<Finding & { status: string }> };
        }
      ).data;
    };
    const news = await check('events/news.txt');
    expect(news.checksPerformed).toContain('player_text');
    expect(news.findings.map(({ code, line, status }) => ({ code, line, status }))).toEqual([
      { code: 'SCRIPT_NEWS_TEXT_COLOUR_CODE', line: 3, status: 'warning' },
      { code: 'SCRIPT_NEWS_TEXT_COLOUR_CODE', line: 4, status: 'warning' },
      { code: 'SCRIPT_TEXT_IMPLEMENTATION_WORDING', line: 5, status: 'warning' },
    ]);
    expect(news.findings[1]?.message).toContain('MOOD_HAPPY');
    const decisions = await check('common/decisions/checks.txt');
    expect(decisions.findings.map(({ code, command, line }) => ({ code, command, line }))).toEqual([
      { code: 'SCRIPT_TEXT_IMPLEMENTATION_WORDING', command: 'check_decision', line: 2 },
      { code: 'SCRIPT_FLAG_TOOLTIP_UNLOCALISED', command: 'has_country_flag', line: 5 },
    ]);
  });

  it('rejects mixing file mode with snippet arguments', async () => {
    const mcp = await client();
    const result = await mcp.callTool({
      name: 'hoi4.script_validate',
      arguments: { workspaceId: 'fixture', path: 'events/checks.txt', kind: 'effect' },
    });
    expect(result.isError).toBe(true);
  });
});
