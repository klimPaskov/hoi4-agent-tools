import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-inspector-'));
const modRoot = path.join(temporary, 'mods');
const mod = path.join(modRoot, 'fixture');
const storage = path.join(temporary, 'storage');
const config = path.join(temporary, 'config.json');
const publicToolNames = [
  'hoi4.mods',
  'hoi4.focus_inspect',
  'hoi4.focus_render',
  'hoi4.focus_rewrite',
  'hoi4.gui_inspect',
  'hoi4.gui_render',
  'hoi4.gui_rewrite',
  'hoi4.map_inspect',
  'hoi4.map_render',
  'hoi4.map_rewrite',
  'hoi4.event_inspect',
  'hoi4.event_render',
  'hoi4.event_compare',
] as const;
const artifactResourceTemplate =
  'hoi4-agent://workspace/{workspaceId}/artifact/{sha256}/{provenanceHash}/{name}';

interface InspectorRun {
  code: number;
  stderr: string;
  stdout: string;
}

function exactNames(actual: readonly string[], expected: readonly string[]): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

async function runInspector(
  method: string,
  methodArguments: readonly string[] = [],
): Promise<InspectorRun> {
  const executable = process.execPath;
  const args = [
    path.join(root, 'node_modules', '@modelcontextprotocol', 'inspector', 'cli', 'build', 'cli.js'),
    '--cli',
    'node',
    path.join(root, 'dist', 'bin', 'stdio.js'),
    '--method',
    method,
    ...methodArguments,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: { ...process.env, HOI4_AGENT_CONFIG: config },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code: code ?? 1, stderr, stdout }));
  });
}

function successfulJson(run: InspectorRun, label: string): unknown {
  if (run.code !== 0) throw new Error(`${label} failed\n${run.stderr}`);
  try {
    return JSON.parse(run.stdout.trim()) as unknown;
  } catch {
    throw new Error(`${label} returned non-JSON stdout\n${run.stdout}`);
  }
}

function successfulToolResult(run: InspectorRun, label: string): Record<string, unknown> {
  const result = successfulJson(run, label) as {
    isError?: unknown;
    structuredContent?: Record<string, unknown>;
  };
  if (result.isError === true || result.structuredContent?.status !== 'ok') {
    throw new Error(`${label} returned an unsuccessful tool result\n${run.stdout}`);
  }
  return result.structuredContent;
}

try {
  await Promise.all([
    mkdir(path.join(mod, 'common', 'national_focus'), { recursive: true }),
    mkdir(path.join(mod, 'common', 'on_actions'), { recursive: true }),
    mkdir(path.join(mod, 'events'), { recursive: true }),
    mkdir(path.join(mod, 'localisation', 'english'), { recursive: true }),
    mkdir(storage),
  ]);
  await Promise.all([
    writeFile(
      path.join(mod, 'common', 'national_focus', 'inspector.txt'),
      'focus_tree = { id = inspector focus = { id = inspector_root x = 0 y = 0 cost = 10 } }\n',
    ),
    writeFile(
      path.join(mod, 'common', 'on_actions', 'inspector.txt'),
      'on_actions = { on_startup = { effect = { country_event = inspector.1 } } }\n',
    ),
    writeFile(
      path.join(mod, 'events', 'inspector.txt'),
      'add_namespace = inspector\ncountry_event = { id = inspector.1 title = inspector.1.t is_triggered_only = yes option = { name = inspector.1.a } }\n',
    ),
    writeFile(
      path.join(mod, 'localisation', 'english', 'inspector_l_english.yml'),
      '\ufeffl_english:\ninspector.1.t: "Inspector Event"\ninspector.1.a: "Finish"\n',
    ),
  ]);
  await writeFile(
    config,
    `${JSON.stringify({
      version: 1,
      serverStateRoot: path.join(temporary, 'state'),
      storageRoots: [storage],
      workspaces: [
        {
          id: 'inspector',
          name: 'Official Inspector fixture',
          root: mod,
          artifactRoot: path.join(storage, 'artifacts'),
          cacheRoot: path.join(storage, 'cache'),
        },
      ],
    })}\n`,
  );

  const tools = successfulJson(await runInspector('tools/list'), 'Inspector tools/list') as {
    tools?: Array<{ name?: string }>;
  };
  const toolNames = tools.tools?.flatMap(({ name }) => (name === undefined ? [] : [name])) ?? [];
  if (!exactNames(toolNames, publicToolNames)) {
    throw new Error(`Inspector returned the wrong public tools: ${toolNames.join(', ')}`);
  }

  const templates = successfulJson(
    await runInspector('resources/templates/list'),
    'Inspector resources/templates/list',
  ) as { resourceTemplates?: Array<{ uriTemplate?: string }> };
  const templateUris =
    templates.resourceTemplates?.flatMap(({ uriTemplate }) =>
      uriTemplate === undefined ? [] : [uriTemplate],
    ) ?? [];
  if (!exactNames(templateUris, [artifactResourceTemplate])) {
    throw new Error(`Inspector returned the wrong resource templates: ${templateUris.join(', ')}`);
  }

  const resources = successfulJson(
    await runInspector('resources/list'),
    'Inspector resources/list',
  ) as { resources?: unknown[] };
  if ((resources.resources?.length ?? 0) !== 0) {
    throw new Error('Inspector returned fixed resources');
  }

  const prompts = await runInspector('prompts/list');
  if (prompts.code === 0) {
    const listed = successfulJson(prompts, 'Inspector prompts/list') as { prompts?: unknown[] };
    if ((listed.prompts?.length ?? 0) !== 0) throw new Error('Inspector returned prompts');
  } else if (
    !/does not support prompts|method not found|not supported|-32601/iu.test(prompts.stderr)
  ) {
    throw new Error(`Inspector prompt discovery failed unexpectedly\n${prompts.stderr}`);
  }

  const inspected = successfulToolResult(
    await runInspector('tools/call', [
      '--tool-name',
      'hoi4.event_inspect',
      '--tool-arg',
      'workspaceId=inspector',
      'mode=scan',
    ]),
    'Inspector hoi4.event_inspect',
  );
  if (inspected.code !== 'EVENT_INSPECTED') {
    throw new Error(`Inspector event inspection returned ${String(inspected.code)}`);
  }
  const inspectedArtifacts = inspected.artifacts as
    Array<{ uri?: unknown; mimeType?: unknown }> | undefined;
  const inspectedJsonUri = inspectedArtifacts?.find(
    ({ uri, mimeType }) => typeof uri === 'string' && mimeType === 'application/json',
  )?.uri;
  if (typeof inspectedJsonUri !== 'string') {
    throw new Error('Inspector event inspection did not link its JSON artifact');
  }
  const inspectedResource = successfulJson(
    await runInspector('resources/read', ['--uri', inspectedJsonUri]),
    'Inspector resources/read event artifact',
  ) as { contents?: Array<{ mimeType?: unknown; text?: unknown }> };
  const inspectedResourceContent = inspectedResource.contents?.[0];
  if (
    inspectedResourceContent?.mimeType !== 'application/json' ||
    typeof inspectedResourceContent.text !== 'string'
  ) {
    throw new Error('Inspector event artifact resource was not returned as JSON text');
  }
  const inspectedArtifact = JSON.parse(inspectedResourceContent.text) as {
    schemaVersion?: unknown;
    workspaceId?: unknown;
    mode?: unknown;
  };
  if (
    inspectedArtifact.schemaVersion !== 'event-analysis.v1' ||
    inspectedArtifact.workspaceId !== 'inspector' ||
    inspectedArtifact.mode !== 'scan'
  ) {
    throw new Error('Inspector event artifact resource contained unexpected evidence');
  }

  const rendered = successfulToolResult(
    await runInspector('tools/call', [
      '--tool-name',
      'hoi4.event_render',
      '--tool-arg',
      'workspaceId=inspector',
      'view=overview',
      'includeHtml=false',
    ]),
    'Inspector hoi4.event_render',
  );
  if (rendered.code !== 'EVENT_RENDERED') {
    throw new Error(`Inspector event render returned ${String(rendered.code)}`);
  }

  const proposedSource =
    'add_namespace = inspector\ncountry_event = { id = inspector.1 title = inspector.1.t is_triggered_only = yes option = { name = inspector.1.a country_event = inspector.2 } }\ncountry_event = { id = inspector.2 title = inspector.2.t is_triggered_only = yes option = { name = inspector.2.a } }\n';
  const compared = successfulToolResult(
    await runInspector('tools/call', [
      '--tool-name',
      'hoi4.event_compare',
      '--tool-arg',
      'workspaceId=inspector',
      `proposedSources=${JSON.stringify([{ relativePath: 'events/inspector.txt', source: proposedSource }])}`,
      'render=false',
    ]),
    'Inspector hoi4.event_compare',
  );
  if (compared.code !== 'EVENT_COMPARED') {
    throw new Error(`Inspector event comparison returned ${String(compared.code)}`);
  }

  process.stderr.write(
    'Official MCP Inspector verified thirteen-tool discovery, the artifact resource, and event inspect/render/compare workflows.\n',
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
