import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { ResidentEngine } from '../../src/hoi4_agent_tools/core/resident-engine.js';
import { decodeDds } from '../../src/hoi4_agent_tools/gui/dds.js';
import { decodeTextureWithEngine } from '../../src/hoi4_agent_tools/gui/engine-textures.js';

/**
 * The synthetic texture fixtures of the Rust engine (`engine/crates/texture/tests/fixtures`) with
 * their reference decodes. The TypeScript decoder reads the 8-bit DX10 layouts and BC1 to BC3
 * itself; the rest (BC7 among them) is the engine's.
 */
const fixtures = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'engine',
  'crates',
  'texture',
  'tests',
  'fixtures',
);

async function reference(name: string): Promise<Buffer> {
  return sharp(path.join(fixtures, `${name}.ref.png`))
    .ensureAlpha()
    .raw()
    .toBuffer();
}

function maximumDifference(left: Buffer, right: Buffer): number {
  let worst = 0;
  for (let index = 0; index < left.length; index += 1)
    worst = Math.max(worst, Math.abs((left[index] ?? 0) - (right[index] ?? 0)));
  return worst;
}

describe('DX10 DDS in the TypeScript decoder', () => {
  it.each([
    ['dx10_r8g8b8a8_unorm', 'dx10-rgba8', 0],
    ['dx10_r8g8b8a8_unorm_srgb', 'dx10-rgba8-srgb', 0],
    ['dx10_b8g8r8a8_unorm', 'dx10-bgra8', 0],
    ['dx10_b8g8r8x8_unorm', 'dx10-bgrx8', 0],
    ['dx10_b8g8r8a8_unorm_srgb', 'dx10-bgra8-srgb', 0],
    // BC1 to BC3 round where the format leaves it open; the reference (Pillow) truncates.
    ['dx10_bc1', 'dx10-bc1', 1],
    ['dx10_bc2', 'dx10-bc2', 1],
    ['dx10_bc3', 'dx10-bc3', 1],
  ] as const)('decodes %s to its reference', async (name, format, tolerance) => {
    const decoded = decodeDds(await readFile(path.join(fixtures, `${name}.dds`)));
    expect(decoded).toMatchObject({ format });
    if ('unsupported' in decoded) return;
    expect(maximumDifference(decoded.data, await reference(name))).toBeLessThanOrEqual(tolerance);
  });

  it('leaves BC7 and packed formats to the engine', async () => {
    for (const name of ['bc7_modes', 'dx10_bc4', 'dx10_bc5', 'dx10_b5g6r5_unorm']) {
      const decoded = decodeDds(await readFile(path.join(fixtures, `${name}.dds`)));
      expect(decoded).toMatchObject({ unsupported: true });
      expect('format' in decoded && decoded.format.startsWith('DX10/')).toBe(true);
    }
  });
});

/** A built hoi4-engine: HOI4_ENGINE, else a cargo build in this repository. */
function realEngineBinary(): string | undefined {
  const executable = process.platform === 'win32' ? 'hoi4-engine.exe' : 'hoi4-engine';
  const targets = [
    process.env.CARGO_TARGET_DIR,
    path.resolve(import.meta.dirname, '..', '..', 'engine', 'target'),
  ].filter((entry): entry is string => entry !== undefined && entry !== '');
  return [
    process.env.HOI4_ENGINE,
    ...targets.flatMap((target) => [
      path.resolve(target, 'release', executable),
      path.resolve(target, 'debug', executable),
    ]),
  ].find((candidate) => {
    if (candidate === undefined || candidate === '') return false;
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

const engineBinary = realEngineBinary();
const engine =
  engineBinary === undefined
    ? undefined
    : new ResidentEngine({ env: { ...process.env, HOI4_ENGINE: engineBinary } });
afterAll(() => engine?.close());

describe.skipIf(engine === undefined)(
  'DX10 DDS through the Rust engine (skipped without a built engine)',
  () => {
    it.each(['bc7_modes', 'bc7_srgb_odd', 'dx10_b5g6r5_unorm', 'dx10_r10g10b10a2_unorm'])(
      'decodes %s bit for bit',
      async (name) => {
        const outcome = await decodeTextureWithEngine(
          await readFile(path.join(fixtures, `${name}.dds`)),
          'dds',
          16_777_216,
          { engine: engine! },
        );
        expect('decoded' in outcome).toBe(true);
        if (!('decoded' in outcome)) return;
        const expected = await reference(name);
        if (name === 'bc7_modes') {
          // The reserved block at the end is transparent black (Direct3D); Pillow makes it opaque.
          const pixels = outcome.decoded.width * (outcome.decoded.height - 4) * 4;
          expect(
            maximumDifference(
              outcome.decoded.data.subarray(0, pixels),
              expected.subarray(0, pixels),
            ),
          ).toBe(0);
        } else expect(maximumDifference(outcome.decoded.data, expected)).toBe(0);
      },
    );

    it('names a format the engine cannot decode', async () => {
      const bytes = await readFile(path.join(fixtures, 'bc7_modes.dds'));
      bytes.writeUInt32LE(95, 128);
      expect(
        await decodeTextureWithEngine(bytes, 'dds', 16_777_216, { engine: engine! }),
      ).toMatchObject({
        unsupported: true,
        format: 'BC6H_UF16',
        engineAvailable: true,
      });
    });
  },
);
