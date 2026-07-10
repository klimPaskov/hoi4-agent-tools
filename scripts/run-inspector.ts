import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-inspector-'));
const config = path.join(temporary, 'config.json');
await writeFile(
  config,
  `${JSON.stringify({ version: 1, writePolicy: 'read-only', registrationRoots: [], workspaces: [] })}\n`,
);

const executable = process.execPath;
const args = [
  path.join(root, 'node_modules', '@modelcontextprotocol', 'inspector', 'cli', 'build', 'cli.js'),
  '--cli',
  'node',
  path.join(root, 'dist', 'bin', 'stdio.js'),
  '--method',
  'tools/list',
];
try {
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: { ...process.env, HOI4_AGENT_CONFIG: config },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) process.exitCode = code;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
