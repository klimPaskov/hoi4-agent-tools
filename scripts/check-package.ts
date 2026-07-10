import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { REQUIRED_PACKAGE_FILES } from './distribution/package-fixture.js';

const root = path.resolve(import.meta.dirname, '..');
const npmCli = process.env.npm_execpath;
if (npmCli === undefined) throw new Error('npm_execpath is unavailable; run through npm');
const output = await new Promise<string>((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [npmCli, 'pack', '--dry-run', '--ignore-scripts', '--json'],
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
  child.once('exit', (code) => {
    if (code === 0) resolve(stdout);
    else reject(new Error(`npm pack failed (${code}): ${stderr}`));
  });
});
const packed = JSON.parse(output) as Array<{ files: Array<{ path: string }>; filename: string }>;
const paths = new Set(
  packed[0]?.files.map(({ path: filePath }) => filePath.replaceAll('\\', '/')) ?? [],
);
for (const required of REQUIRED_PACKAGE_FILES) {
  if (!paths.has(required)) throw new Error(`Packed package is missing ${required}`);
}
const forbidden = [...paths].filter(
  (filePath) =>
    /(?:^|\/)(?:history\/states|common\/national_focus|map\/provinces\.bmp)(?:\/|$)/iu.test(
      filePath,
    ) || /(?:^|\/)node_modules(?:\/|$)/u.test(filePath),
);
if (forbidden.length > 0)
  throw new Error(`Packed package contains forbidden external content: ${forbidden.join(', ')}`);
process.stderr.write(
  `Package dry run valid: ${packed[0]?.filename ?? 'unknown'} (${paths.size} files)\n`,
);
