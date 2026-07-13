import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { qualifyInstalledHttpBinary } from './distribution/installed-http-qualification.js';

const root = path.resolve(import.meta.dirname, '..');
const ownPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  mcpName: string;
};
const packageSpec =
  process.env.PUBLIC_INSTALL_PACKAGE_SPEC ?? `${ownPackage.name}@${ownPackage.version}`;
const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-public-install-'));
const httpOrigin = 'https://public-install.example.test';
const httpToken = randomBytes(32).toString('hex');
const httpTokenEnvironment = 'PUBLIC_INSTALL_HTTP_TOKEN';
const focusRelativePath = 'common/national_focus/public_install_focus.txt';
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
const focusFixture = `focus_tree = {
\tid = public_install_focus
\tcountry = {
\t\tfactor = 0
\t}

\tfocus = {
\t\tid = public_install_root
\t\ticon = GFX_goal_generic_construct_civ_factory
\t\tx = 0
\t\ty = 0
\t\tcost = 10

\t\tcompletion_reward = {
\t\t\tadd_political_power = 50
\t\t}
\t}
}
`;

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

async function runNode(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: temporary,
      env: environment,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Command failed with exit code ${code ?? 1}`)),
    );
  });
}

try {
  await writeFile(path.join(temporary, 'package.json'), '{"private":true,"type":"module"}\n');
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined) throw new Error('npm_execpath is unavailable; run through npm');
  await runNode([
    npmCli,
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--registry=https://registry.npmjs.org',
    packageSpec,
  ]);
  const installedRoot = path.join(temporary, 'node_modules', ownPackage.name);
  const installed = JSON.parse(
    await readFile(path.join(installedRoot, 'package.json'), 'utf8'),
  ) as {
    version: string;
    mcpName: string;
  };
  if (installed.version !== ownPackage.version || installed.mcpName !== ownPackage.mcpName) {
    throw new Error('Clean public installation returned mismatched package metadata');
  }
  await runNode([npmCli, 'audit', 'signatures', '--registry=https://registry.npmjs.org']);

  const modRoot = path.join(temporary, 'mods');
  const mod = path.join(modRoot, 'public');
  const focusRoot = path.join(mod, 'common', 'national_focus');
  const storage = path.join(temporary, 'storage');
  await Promise.all([mkdir(focusRoot, { recursive: true }), mkdir(storage)]);
  await writeFile(path.join(mod, focusRelativePath), focusFixture);
  const configuration = path.join(temporary, 'config.json');
  await writeFile(
    configuration,
    `${JSON.stringify({
      version: 1,
      serverStateRoot: path.join(temporary, 'state'),
      modRoots: [modRoot],
      workspaceStorageRoot: storage,
      workspaces: [
        {
          id: 'public',
          name: 'Public package smoke test',
          root: mod,
          kind: 'mod',
        },
      ],
      http: {
        host: '127.0.0.1',
        port: 0,
        allowedOrigins: [httpOrigin],
        tokens: [
          {
            principal: 'public-install-verifier',
            tokenEnv: httpTokenEnvironment,
            workspaceIds: ['public'],
          },
        ],
      },
    })}\n`,
  );
  const entry = path.join(installedRoot, 'dist', 'bin', 'stdio.js');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: temporary,
      env: { ...process.env, HOI4_AGENT_CONFIG: configuration },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let pending = '';
    let validated = false;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Published stdio package did not initialize in time'));
    }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line.length === 0) continue;
        const message = JSON.parse(line) as {
          id?: number;
          result?: {
            capabilities?: { prompts?: unknown; resources?: unknown };
            serverInfo?: { version?: string };
            tools?: Array<{ name?: string }>;
          };
        };
        if (message.id === 1) {
          if (message.result?.serverInfo?.version !== ownPackage.version) {
            clearTimeout(timeout);
            reject(new Error('Published stdio server reported the wrong version'));
            return;
          }
          if (
            message.result.capabilities?.prompts !== undefined ||
            message.result.capabilities?.resources === undefined
          ) {
            clearTimeout(timeout);
            reject(new Error('Published stdio server reported the wrong discovery capabilities'));
            return;
          }
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
          );
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
          );
        } else if (message.id === 2) {
          const names =
            message.result?.tools?.flatMap(({ name }) => (name === undefined ? [] : [name])) ?? [];
          if (!sameNames(names, publicToolNames)) {
            clearTimeout(timeout);
            reject(
              new Error(`Published stdio tools do not match the thirteen-tool public surface`),
            );
            return;
          }
          validated = true;
          child.stdin.end();
        }
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (validated && code === 0) resolve();
      else reject(new Error(`Published stdio server exited before validation (${code ?? 1})`));
    });
    child.stderr.on('data', () => undefined);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'public-install-verifier', version: ownPackage.version },
        },
      })}\n`,
    );
  });

  const httpEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    HOI4_AGENT_CONFIG: configuration,
    [httpTokenEnvironment]: httpToken,
  };
  delete httpEnvironment.NODE_PATH;
  await qualifyInstalledHttpBinary({
    cwd: temporary,
    entryPath: path.join(installedRoot, 'dist', 'bin', 'http.js'),
    environment: httpEnvironment,
    expectedServerName: ownPackage.name,
    expectedServerVersion: ownPackage.version,
    focusRelativePath,
    origin: httpOrigin,
    token: httpToken,
    workspaceId: 'public',
  });
  process.stderr.write(
    `Clean stdio and authenticated HTTP installation verified: ${ownPackage.name}@${ownPackage.version}\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
