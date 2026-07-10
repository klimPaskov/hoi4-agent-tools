import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { verifyReleaseArtifact } from './distribution/release-verification.js';

const root = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};
const artifactDirectory = path.resolve(
  root,
  process.env.RELEASE_ARTIFACT_DIR ?? process.argv[2] ?? 'release',
);
const manifestBytes = await readFile(path.join(artifactDirectory, 'npm-pack.json'));
const parsed = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/u, '')) as Array<{
  filename?: unknown;
}>;
const filename = parsed[0]?.filename;
if (typeof filename !== 'string') throw new Error('npm-pack.json does not name a tarball');
const tarballBytes = await readFile(path.join(artifactDirectory, filename));
const verified = verifyReleaseArtifact(
  manifestBytes,
  tarballBytes,
  packageJson.name,
  packageJson.version,
);
process.stderr.write(
  `Release artifact verified: ${verified.filename} (${verified.size} bytes, sha256:${verified.sha256})\n`,
);
