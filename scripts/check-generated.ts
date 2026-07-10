import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const targets = process.argv.slice(2);
if (targets.length === 0) throw new Error('At least one generated path is required');

const result = await new Promise<{ code: number; stderr: string; stdout: string }>(
  (resolve, reject) => {
    const child = spawn(
      'git',
      ['status', '--porcelain', '--untracked-files=all', '--', ...targets],
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  },
);
if (result.code !== 0) throw new Error(`git status failed: ${result.stderr.trim()}`);
const changedAfterGeneration = result.stdout
  .split(/\r?\n/u)
  .filter(Boolean)
  .filter((line) => line.startsWith('??') || line[1] !== ' ');
if (changedAfterGeneration.length > 0) {
  throw new Error(`Generated files are stale:\n${changedAfterGeneration.join('\n')}`);
}
process.stderr.write(`Generated paths are deterministic and clean: ${targets.join(', ')}\n`);
