import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ENGINE_BUNDLE_MANIFEST_SCHEMA,
  engineBundleManifestSchema,
  type EngineBundleManifest,
} from '../../src/hoi4_agent_tools/core/engine-client.js';

/** Every platform a release ships `hoi4-engine` for (ADR 0074), as `<process.platform>-<process.arch>`. */
export const ENGINE_BUNDLE_PLATFORMS = [
  'darwin-arm64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
] as const;
export type EngineBundlePlatform = (typeof ENGINE_BUNDLE_PLATFORMS)[number];

export function engineBinaryFile(platform: EngineBundlePlatform): string {
  return `${platform}/${platform.startsWith('win32-') ? 'hoi4-engine.exe' : 'hoi4-engine'}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The workspace version in `engine/Cargo.toml`, which `hoi4-engine --version` prints. */
export async function readEngineVersion(root: string): Promise<string> {
  const cargo = await readFile(path.join(root, 'engine', 'Cargo.toml'), 'utf8');
  const section = /^\[workspace\.package\]\s*$([\s\S]*?)(?:^\[|(?![\s\S]))/mu.exec(cargo)?.[1];
  const version =
    section === undefined ? undefined : /^version\s*=\s*"([^"]+)"/mu.exec(section)?.[1];
  if (version === undefined)
    throw new Error('engine/Cargo.toml has no [workspace.package] version');
  return version;
}

/**
 * Copies the release build of every platform from `artifactsDirectory/engine-<platform>/` into
 * `engine/bin/<platform>/`, makes it executable and writes `engine/bin/manifest.json`. Every
 * platform is required: a release never ships a partial bundle.
 */
export async function bundleEngineBinaries(
  root: string,
  artifactsDirectory: string,
): Promise<EngineBundleManifest> {
  const binDirectory = path.join(root, 'engine', 'bin');
  await rm(binDirectory, { recursive: true, force: true });
  const binaries: EngineBundleManifest['binaries'] = {};
  for (const platform of ENGINE_BUNDLE_PLATFORMS) {
    const file = engineBinaryFile(platform);
    const source = path.join(artifactsDirectory, `engine-${platform}`, path.basename(file));
    let bytes: Buffer;
    try {
      bytes = await readFile(source);
    } catch {
      throw new Error(`The hoi4-engine build for ${platform} is missing: ${source}`);
    }
    if (bytes.byteLength === 0) throw new Error(`The hoi4-engine build for ${platform} is empty`);
    const target = path.join(binDirectory, ...file.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    // Artifact downloads drop the executable bit; npm keeps the mode set here.
    await chmod(target, 0o755);
    binaries[platform] = { file, sha256: sha256(bytes), size: bytes.byteLength };
  }
  const manifest: EngineBundleManifest = {
    schema: ENGINE_BUNDLE_MANIFEST_SCHEMA,
    engineVersion: await readEngineVersion(root),
    binaries,
  };
  await writeFile(
    path.join(binDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export interface PackedFile {
  path: string;
  mode: number;
  size: number;
}

/**
 * Checks a release before it is published: the manifest on disk is valid and lists every
 * platform, each binary on disk matches it, and the pack holds each binary as an executable
 * file of the same size, and nothing else in `engine/bin/` besides the manifest.
 */
export async function verifyEngineBundle(
  root: string,
  packedFiles: readonly PackedFile[],
): Promise<EngineBundleManifest> {
  const binDirectory = path.join(root, 'engine', 'bin');
  const manifest = engineBundleManifestSchema.parse(
    JSON.parse(await readFile(path.join(binDirectory, 'manifest.json'), 'utf8')),
  );
  const expectedVersion = await readEngineVersion(root);
  if (manifest.engineVersion !== expectedVersion)
    throw new Error(
      `engine/bin/manifest.json names engine ${manifest.engineVersion}, engine/Cargo.toml ${expectedVersion}`,
    );
  const listed = Object.keys(manifest.binaries).sort();
  if (listed.join(',') !== [...ENGINE_BUNDLE_PLATFORMS].join(','))
    throw new Error(
      `engine/bin/manifest.json lists ${listed.join(', ')}; a release needs ${ENGINE_BUNDLE_PLATFORMS.join(', ')}`,
    );
  const packed = new Map(packedFiles.map((file) => [file.path.replaceAll('\\', '/'), file]));
  for (const platform of ENGINE_BUNDLE_PLATFORMS) {
    const entry = manifest.binaries[platform];
    if (entry?.file !== engineBinaryFile(platform))
      throw new Error(`engine/bin/manifest.json names the wrong file for ${platform}`);
    const bytes = await readFile(path.join(binDirectory, ...entry.file.split('/')));
    if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256)
      throw new Error(`engine/bin/${entry.file} does not match engine/bin/manifest.json`);
    const inPack = packed.get(`engine/bin/${entry.file}`);
    if (inPack === undefined) throw new Error(`The package is missing engine/bin/${entry.file}`);
    if (inPack.size !== entry.size)
      throw new Error(`The package holds a different engine/bin/${entry.file}`);
    if ((inPack.mode & 0o111) !== 0o111)
      throw new Error(`The package holds engine/bin/${entry.file} without the executable bit`);
  }
  const allowed = new Set([
    'engine/bin/manifest.json',
    ...ENGINE_BUNDLE_PLATFORMS.map((platform) => `engine/bin/${engineBinaryFile(platform)}`),
  ]);
  const extra = [...packed.keys()].filter(
    (file) => file.startsWith('engine/bin/') && !allowed.has(file),
  );
  if (extra.length > 0)
    throw new Error(`The package holds unexpected engine files: ${extra.join(', ')}`);
  if (!packed.has('engine/bin/manifest.json'))
    throw new Error('The package is missing engine/bin/manifest.json');
  return manifest;
}
