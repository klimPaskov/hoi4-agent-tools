import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const PACKAGE_BIN_TARGETS = {
  'hoi4-agent-tools': './dist/bin/stdio.js',
  'hoi4-agent-tools-http': './dist/bin/http.js',
  'hoi4-agent-tools-setup': './dist/bin/setup.js',
} as const;

export const REQUIRED_PACKAGE_FILES = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'docs/README.md',
  'docs/setup.md',
  'docs/events.md',
  'docs/technology.md',
  'docs/focus.md',
  'docs/gui.md',
  'docs/map.md',
  'docs/http.md',
  'docs/development.md',
  ...Object.values(PACKAGE_BIN_TARGETS).map((target) => target.replace(/^\.\//u, '')),
  'package.json',
  'server.json',
] as const;

const forbiddenPackageRoots = new Set([
  '.agents',
  '.git',
  '.github',
  'common',
  'examples',
  'fixtures',
  'gfx',
  'history',
  'localisation',
  'localisation_synced',
  'map',
  'node_modules',
  'prompts',
  'research',
  'schemas',
  'scripts',
  'source_review',
  'specs',
  'src',
  'tests',
]);

const packagedTextExtensions = new Set(['.cjs', '.js', '.json', '.map', '.md', '.mjs', '.ts']);

export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface CommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

export interface PackedFile {
  mode: number;
  path: string;
  size: number;
}

interface NpmPackResult {
  filename: string;
  files: PackedFile[];
  name: string;
  version: string;
}

export interface InstalledPackageFixture {
  binEntries: Readonly<Record<keyof typeof PACKAGE_BIN_TARGETS, string>>;
  consumerRoot: string;
  installedPackageRoot: string;
  pack: NpmPackResult;
  tarballPath: string;
}

function npmInvocation(arguments_: readonly string[]): readonly [string, string[]] {
  const configuredCli = process.env.npm_execpath;
  if (configuredCli !== undefined && /\.(?:c|m)?js$/iu.test(configuredCli)) {
    return [process.execPath, [configuredCli, ...arguments_]];
  }
  if (process.platform === 'win32') {
    const cli = path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    );
    return [process.execPath, [cli, ...arguments_]];
  }
  return ['npm', [...arguments_]];
}

export async function runCommand(
  executable: string,
  arguments_: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    let stdout = '';
    let timedOut = false;
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.once('error', reject);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 120_000);
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`${executable} timed out`));
        return;
      }
      const normalizedCode = code ?? -1;
      if (normalizedCode !== 0) {
        reject(
          new Error(
            `${executable} ${arguments_.join(' ')} failed (${normalizedCode})\n${stderr || stdout}`,
          ),
        );
        return;
      }
      resolve({ code: normalizedCode, stderr, stdout });
    });
  });
}

function normalizedPackagePath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/^package\//u, '');
}

export function forbiddenPackedPaths(files: readonly PackedFile[]): string[] {
  return files
    .map(({ path: filePath }) => normalizedPackagePath(filePath))
    .filter((filePath) => {
      const [root] = filePath.split('/');
      return (
        (root !== undefined && forbiddenPackageRoots.has(root.toLowerCase())) ||
        /(?:^|\/)\.hoi4-agent(?:\/|$)/u.test(filePath) ||
        filePath === 'dist/index.js' ||
        filePath.endsWith('.d.ts') ||
        filePath.endsWith('.map') ||
        /\.(?:bmp|dds|tga)$/iu.test(filePath)
      );
    })
    .sort();
}

export function missingRequiredPackedPaths(files: readonly PackedFile[]): string[] {
  const paths = new Set(files.map(({ path: filePath }) => normalizedPackagePath(filePath)));
  return REQUIRED_PACKAGE_FILES.filter((filePath) => !paths.has(filePath));
}

async function collectFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(root, absolute)));
    else if (entry.isFile()) files.push(path.relative(root, absolute));
  }
  return files.sort();
}

export async function packagedWorkspaceLeaks(
  installedPackageRoot: string,
  sourceProjectRoot: string,
): Promise<string[]> {
  const sourceRoot = path.resolve(sourceProjectRoot);
  const sourceSignatures = [
    sourceRoot,
    sourceRoot.replaceAll('\\', '/'),
    sourceRoot.replaceAll('/', '\\'),
  ];
  const absoluteUserPath =
    /(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]|\/(?:home|Users)\/[^/\s]+\/)/u;
  const leaks: string[] = [];
  for (const relative of await collectFiles(installedPackageRoot)) {
    const extension = path.extname(relative).toLowerCase();
    if (!packagedTextExtensions.has(extension)) continue;
    const contents = await readFile(path.join(installedPackageRoot, relative), 'utf8');
    if (
      sourceSignatures.some((signature) => contents.includes(signature)) ||
      absoluteUserPath.test(contents)
    ) {
      leaks.push(relative.replaceAll('\\', '/'));
    }
  }
  return leaks;
}

function parsePackOutput(output: string): NpmPackResult {
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error('npm pack did not return exactly one package result');
  }
  const [pack] = parsed as NpmPackResult[];
  if (
    pack === undefined ||
    typeof pack.filename !== 'string' ||
    typeof pack.name !== 'string' ||
    typeof pack.version !== 'string' ||
    !Array.isArray(pack.files)
  ) {
    throw new Error('npm pack returned an invalid result');
  }
  return pack;
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.NODE_PATH;
  environment.NO_UPDATE_NOTIFIER = '1';
  environment.npm_config_audit = 'false';
  environment.npm_config_fund = 'false';
  environment.npm_config_offline = 'true';
  environment.npm_config_update_notifier = 'false';
  return environment;
}

export async function buildPackAndInstall(
  projectRoot: string,
  temporaryRoot: string,
): Promise<InstalledPackageFixture> {
  const absoluteProjectRoot = path.resolve(projectRoot);
  const packRoot = path.join(temporaryRoot, 'pack');
  const consumerRoot = path.join(temporaryRoot, 'consumer');
  await mkdir(packRoot, { recursive: true });
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(
    path.join(consumerRoot, 'package.json'),
    `${JSON.stringify({ name: 'package-acceptance-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );

  const [buildExecutable, buildArguments] = npmInvocation(['run', 'build', '--silent']);
  await runCommand(buildExecutable, buildArguments, {
    cwd: absoluteProjectRoot,
    env: cleanEnvironment(),
  });
  const [packExecutable, packArguments] = npmInvocation([
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    packRoot,
  ]);
  const packed = await runCommand(packExecutable, packArguments, {
    cwd: absoluteProjectRoot,
    env: cleanEnvironment(),
  });
  const pack = parsePackOutput(packed.stdout);
  const tarballPath = path.join(packRoot, pack.filename);
  await access(tarballPath, constants.R_OK);

  const forbidden = forbiddenPackedPaths(pack.files);
  if (forbidden.length > 0) {
    throw new Error(`Package contains forbidden workspace payloads: ${forbidden.join(', ')}`);
  }
  const missing = missingRequiredPackedPaths(pack.files);
  if (missing.length > 0) {
    throw new Error(`Package is missing required files: ${missing.join(', ')}`);
  }

  const [installExecutable, installArguments] = npmInvocation([
    'install',
    '--ignore-scripts',
    '--prefer-offline',
    '--no-audit',
    '--no-fund',
    '--no-save',
    '--package-lock=false',
    tarballPath,
  ]);
  const installEnvironment = cleanEnvironment();
  delete installEnvironment.npm_config_offline;
  installEnvironment.npm_config_prefer_offline = 'true';
  await runCommand(installExecutable, installArguments, {
    cwd: consumerRoot,
    env: installEnvironment,
  });

  const installedPackageRoot = await realpath(path.join(consumerRoot, 'node_modules', pack.name));
  const canonicalConsumerRoot = await realpath(consumerRoot);
  if (
    installedPackageRoot === absoluteProjectRoot ||
    !installedPackageRoot.startsWith(`${canonicalConsumerRoot}${path.sep}`)
  ) {
    throw new Error('Installed package escaped the isolated consumer project');
  }

  const binEntries = Object.fromEntries(
    await Promise.all(
      Object.entries(PACKAGE_BIN_TARGETS).map(async ([name, target]) => {
        const targetPath = path.join(installedPackageRoot, target);
        await access(targetPath, constants.R_OK);
        const source = await readFile(targetPath, 'utf8');
        if (!source.startsWith('#!/usr/bin/env node\n')) {
          throw new Error(`Installed bin target lacks a Node shebang: ${target}`);
        }
        const shim = path.join(
          consumerRoot,
          'node_modules',
          '.bin',
          `${name}${process.platform === 'win32' ? '.cmd' : ''}`,
        );
        await access(shim, process.platform === 'win32' ? constants.R_OK : constants.X_OK);
        return [name, targetPath] as const;
      }),
    ),
  ) as Record<keyof typeof PACKAGE_BIN_TARGETS, string>;

  return {
    binEntries,
    consumerRoot,
    installedPackageRoot,
    pack,
    tarballPath,
  };
}
