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
const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-public-install-'));
const httpOrigin = 'https://public-install.example.test';
const httpToken = randomBytes(32).toString('hex');
const httpTokenEnvironment = 'PUBLIC_INSTALL_HTTP_TOKEN';

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
    `${ownPackage.name}@${ownPackage.version}`,
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

  const mod = path.join(temporary, 'mod');
  await mkdir(mod);
  const configuration = path.join(temporary, 'config.json');
  await writeFile(
    configuration,
    `${JSON.stringify({
      version: 1,
      workspaces: [{ id: 'public', name: 'Public package smoke test', root: mod }],
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
          result?: { serverInfo?: { version?: string }; tools?: Array<{ name?: string }> };
        };
        if (message.id === 1) {
          if (message.result?.serverInfo?.version !== ownPackage.version) {
            clearTimeout(timeout);
            reject(new Error('Published stdio server reported the wrong version'));
            return;
          }
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
          );
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
          );
        } else if (message.id === 2) {
          const names = message.result?.tools?.map(({ name }) => name) ?? [];
          if (!names.includes('hoi4.focus_render') || !names.includes('hoi4.map_plan')) {
            clearTimeout(timeout);
            reject(new Error('Published stdio server is missing required public tools'));
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
    expectedPromptNames: [
      'hoi4.safe-focus-workflow',
      'hoi4.safe-gui-workflow',
      'hoi4.safe-map-workflow',
    ],
    expectedResourceUri: 'hoi4-agent://schema/focus-plan',
    expectedServerName: ownPackage.name,
    expectedServerVersion: ownPackage.version,
    expectedToolNames: ['hoi4.focus_render', 'hoi4.map_plan'],
    origin: httpOrigin,
    token: httpToken,
    workspaceId: 'public',
  });
  process.stderr.write(
    `Clean public stdio and authenticated HTTP installation verified: ${ownPackage.name}@${ownPackage.version}\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
