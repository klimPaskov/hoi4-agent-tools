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

async function runInspector(method: string): Promise<InspectorRun> {
  const executable = process.execPath;
  const args = [
    path.join(root, 'node_modules', '@modelcontextprotocol', 'inspector', 'cli', 'build', 'cli.js'),
    '--cli',
    'node',
    path.join(root, 'dist', 'bin', 'stdio.js'),
    '--method',
    method,
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

try {
  await Promise.all([
    mkdir(path.join(mod, 'common', 'national_focus'), { recursive: true }),
    mkdir(storage),
  ]);
  await writeFile(
    path.join(mod, 'common', 'national_focus', 'inspector.txt'),
    'focus_tree = { id = inspector focus = { id = inspector_root x = 0 y = 0 cost = 10 } }\n',
  );
  await writeFile(
    config,
    `${JSON.stringify({
      version: 1,
      serverStateRoot: path.join(temporary, 'state'),
      modRoots: [modRoot],
      workspaceStorageRoot: storage,
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

  process.stderr.write('Official MCP Inspector verified the ten tools and artifact resource.\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
