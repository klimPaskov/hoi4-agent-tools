import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { verifyNpmReleaseOrder } from './distribution/release-verification.js';

const root = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};
const url = `https://registry.npmjs.org/${encodeURIComponent(packageJson.name)}`;
const attempts = 3;
let metadata: unknown;
let notFoundResponses = 0;
let lastFailure: Error | undefined;

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
        'user-agent': 'hoi4-agent-tools-release-order-verifier',
      },
    });
    if (response.status === 404) {
      notFoundResponses += 1;
    } else if (response.ok) {
      metadata = (await response.json()) as unknown;
      break;
    } else {
      lastFailure = new Error(`npm registry returned ${response.status} during release check`);
    }
  } catch (error) {
    lastFailure = error instanceof Error ? error : new Error(String(error));
  }
  if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1_000));
}

if (metadata !== undefined) {
  const order = verifyNpmReleaseOrder(metadata, packageJson.name, packageJson.version);
  process.stderr.write(
    `npm release order valid (${order}): ${packageJson.name}@${packageJson.version}\n`,
  );
} else if (notFoundResponses === attempts) {
  process.stderr.write(
    `npm release order valid for first publication: ${packageJson.name}@${packageJson.version}\n`,
  );
} else {
  throw new Error('npm release order could not be established consistently; refusing publication', {
    cause: lastFailure,
  });
}
