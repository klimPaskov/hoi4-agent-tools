import path from 'node:path';
import process from 'node:process';
import { bundleEngineBinaries } from './distribution/engine-bundle.js';

const root = path.resolve(import.meta.dirname, '..');
const artifacts = process.argv[2];
if (artifacts === undefined)
  throw new Error('Usage: npm run engine:bundle -- <directory holding engine-<platform>/ builds>');
const manifest = await bundleEngineBinaries(root, path.resolve(artifacts));
for (const [platform, entry] of Object.entries(manifest.binaries))
  process.stderr.write(
    `engine/bin/${entry.file}: ${entry.size} bytes, sha256:${entry.sha256} (${platform})\n`,
  );
process.stderr.write(
  `Bundled hoi4-engine ${manifest.engineVersion} for ${Object.keys(manifest.binaries).length} platforms\n`,
);
