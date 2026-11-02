import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ENGINE_BUNDLE_PLATFORMS,
  bundleEngineBinaries,
  engineBinaryFile,
  verifyEngineBundle,
  type PackedFile,
} from '../../scripts/distribution/engine-bundle.js';
import { engineBundleManifestSchema } from '../../src/hoi4_agent_tools/core/engine-client.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const remove of cleanup.splice(0)) await remove();
});

async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A package root with an engine version and one fake build per platform. */
async function fixture(): Promise<{ root: string; artifacts: string }> {
  const root = await temporary('hoi4-engine-bundle-');
  await mkdir(path.join(root, 'engine'), { recursive: true });
  await writeFile(
    path.join(root, 'engine', 'Cargo.toml'),
    '[workspace]\nmembers = []\n\n[workspace.package]\nversion = "0.3.1"\nedition = "2024"\n\n[workspace.dependencies]\nserde = "1"\n',
  );
  const artifacts = path.join(root, 'artifacts');
  for (const platform of ENGINE_BUNDLE_PLATFORMS) {
    const directory = path.join(artifacts, `engine-${platform}`);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, path.basename(engineBinaryFile(platform))),
      `fake engine ${platform}`,
    );
  }
  return { root, artifacts };
}

function packedFrom(manifest: Awaited<ReturnType<typeof bundleEngineBinaries>>): PackedFile[] {
  return [
    { path: 'engine/bin/manifest.json', mode: 0o644, size: 1 },
    ...Object.values(manifest.binaries).map((entry) => ({
      path: `engine/bin/${entry.file}`,
      mode: 0o755,
      size: entry.size,
    })),
  ];
}

describe('engine bundle', () => {
  it('bundles every platform with its SHA-256 and the engine version', async () => {
    const { root, artifacts } = await fixture();
    const manifest = await bundleEngineBinaries(root, artifacts);
    expect(manifest.engineVersion).toBe('0.3.1');
    expect(Object.keys(manifest.binaries).sort()).toEqual([...ENGINE_BUNDLE_PLATFORMS]);
    expect(manifest.binaries['win32-x64']?.file).toBe('win32-x64/hoi4-engine.exe');
    expect(manifest.binaries['linux-arm64']?.file).toBe('linux-arm64/hoi4-engine');
    const written = engineBundleManifestSchema.parse(
      JSON.parse(await readFile(path.join(root, 'engine', 'bin', 'manifest.json'), 'utf8')),
    );
    expect(written).toEqual(manifest);
    await expect(verifyEngineBundle(root, packedFrom(manifest))).resolves.toEqual(manifest);
  });

  it('refuses a release with a platform missing', async () => {
    const { root, artifacts } = await fixture();
    await rm(path.join(artifacts, 'engine-darwin-arm64'), { recursive: true });
    await expect(bundleEngineBinaries(root, artifacts)).rejects.toThrow(
      'The hoi4-engine build for darwin-arm64 is missing',
    );
  });

  it('rejects a binary changed after bundling', async () => {
    const { root, artifacts } = await fixture();
    const manifest = await bundleEngineBinaries(root, artifacts);
    await writeFile(path.join(root, 'engine', 'bin', 'linux-x64', 'hoi4-engine'), 'replaced');
    await expect(verifyEngineBundle(root, packedFrom(manifest))).rejects.toThrow(
      'engine/bin/linux-x64/hoi4-engine does not match engine/bin/manifest.json',
    );
  });

  it('rejects a pack without a binary, without the executable bit or with extra engine files', async () => {
    const { root, artifacts } = await fixture();
    const manifest = await bundleEngineBinaries(root, artifacts);
    const packed = packedFrom(manifest);
    await expect(
      verifyEngineBundle(
        root,
        packed.filter((file) => !file.path.includes('darwin-arm64')),
      ),
    ).rejects.toThrow('The package is missing engine/bin/darwin-arm64/hoi4-engine');
    await expect(
      verifyEngineBundle(
        root,
        packed.map((file) => (file.path.includes('linux-x64') ? { ...file, mode: 0o644 } : file)),
      ),
    ).rejects.toThrow('without the executable bit');
    await expect(
      verifyEngineBundle(root, [...packed, { path: 'engine/bin/notes.txt', mode: 0o644, size: 1 }]),
    ).rejects.toThrow('unexpected engine files: engine/bin/notes.txt');
    await expect(
      verifyEngineBundle(
        root,
        packed.filter((file) => file.path !== 'engine/bin/manifest.json'),
      ),
    ).rejects.toThrow('missing engine/bin/manifest.json');
  });

  it('rejects a manifest whose engine version differs from engine/Cargo.toml', async () => {
    const { root, artifacts } = await fixture();
    const manifest = await bundleEngineBinaries(root, artifacts);
    const cargo = path.join(root, 'engine', 'Cargo.toml');
    await writeFile(cargo, (await readFile(cargo, 'utf8')).replace('0.3.1', '0.3.2'));
    await expect(verifyEngineBundle(root, packedFrom(manifest))).rejects.toThrow(
      'names engine 0.3.1, engine/Cargo.toml 0.3.2',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the executable bit through npm pack',
    async () => {
      const npmCli = process.env.npm_execpath;
      if (npmCli?.endsWith('.js') !== true) return;
      const root = await temporary('hoi4-engine-pack-');
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'engine-pack-mode', version: '1.0.0', files: ['engine/bin/'] }),
      );
      await writeFile(path.join(root, '.gitignore'), '/engine/bin/\n');
      const binary = path.join(root, 'engine', 'bin', 'linux-x64', 'hoi4-engine');
      await mkdir(path.dirname(binary), { recursive: true });
      await writeFile(binary, 'fake');
      await chmod(binary, 0o755);
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0 ? resolve(stdout) : reject(new Error(`npm pack exited ${code}`)),
        );
      });
      const files = (JSON.parse(output) as Array<{ files: PackedFile[] }>)[0]?.files ?? [];
      const packed = files.find((file) => file.path === 'engine/bin/linux-x64/hoi4-engine');
      expect(packed).toBeDefined();
      expect((packed?.mode ?? 0) & 0o111).toBe(0o111);
    },
    60_000,
  );
});
