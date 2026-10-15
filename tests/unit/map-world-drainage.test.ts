import { describe, expect, it } from 'vitest';
import {
  generateWorldDrainage,
  type WorldDrainageResult,
  type WorldDrainageSpec,
} from '../../src/hoi4_agent_tools/map/world-drainage.js';

function island(width = 48, height = 40): WorldDrainageSpec {
  const kind = new Uint8Array(width * height);
  const elevation = new Float32Array(kind.length).fill(-0.2);
  for (let y = 2; y < height - 2; y += 1)
    for (let x = 2; x < width - 2; x += 1) {
      const pixel = y * width + x;
      kind[pixel] = 1;
      const inland = Math.min(x - 1, y - 1, width - 2 - x, height - 2 - y);
      elevation[pixel] = Math.min(1, inland / 20);
    }
  return { width, height, kind, elevation, seed: 1821, count: 4 };
}

function neighbors(spec: WorldDrainageSpec, pixel: number): number[] {
  const x = pixel % spec.width;
  const result: number[] = [];
  if (x > 0) result.push(pixel - 1);
  if (x < spec.width - 1) result.push(pixel + 1);
  if (pixel >= spec.width) result.push(pixel - spec.width);
  if (pixel < spec.width * (spec.height - 1)) result.push(pixel + spec.width);
  return result;
}

function verifyChannels(spec: WorldDrainageSpec, result: WorldDrainageResult): void {
  const visited = new Set<number>();
  const sources = [...result.riverPixels.keys()].filter((pixel) => result.riverPixels[pixel] === 0);
  expect(sources).toHaveLength(result.count);
  for (const source of sources) {
    let current = source;
    let previous = -1;
    for (;;) {
      expect(visited.has(current)).toBe(false);
      visited.add(current);
      expect(spec.kind[current]).toBe(1);
      const adjacent = neighbors(spec, current);
      const riverNeighbors = adjacent.filter((pixel) => result.riverPixels[pixel]! < 254);
      if (previous < 0) expect(riverNeighbors).toHaveLength(1);
      expect(riverNeighbors.length).toBeLessThanOrEqual(2);
      const next = riverNeighbors.filter((pixel) => pixel !== previous);
      if (next.length === 0) {
        expect(adjacent.some((pixel) => spec.kind[pixel] !== 1)).toBe(true);
        break;
      }
      expect(next).toHaveLength(1);
      const destination = next[0]!;
      expect(result.elevation[destination]!).toBeLessThanOrEqual(result.elevation[current]!);
      expect(Math.round(96 + result.elevation[destination]! * 110)).toBeLessThanOrEqual(
        Math.round(96 + result.elevation[current]! * 110),
      );
      expect(result.riverPixels[destination]!).toBeGreaterThanOrEqual(3);
      expect(result.riverPixels[destination]!).toBeLessThanOrEqual(11);
      previous = current;
      current = destination;
    }
  }
  const channelPixels = [...result.riverPixels.keys()].filter(
    (pixel) => result.riverPixels[pixel]! < 254,
  );
  expect(visited.size).toBe(channelPixels.length);
  for (let pixel = 0; pixel < spec.kind.length; pixel += 1) {
    expect(result.elevation[pixel]!).toBeLessThanOrEqual(spec.elevation[pixel]!);
    if (!visited.has(pixel)) {
      expect(result.elevation[pixel]).toBe(spec.elevation[pixel]);
      expect(result.riverPixels[pixel]).toBe(spec.kind[pixel] === 1 ? 255 : 254);
    }
  }
}

describe('world drainage', () => {
  it('generates deterministic, separate, one-pixel downhill channels without mutating input', () => {
    const spec = island();
    const originalKind = spec.kind.slice();
    const originalElevation = spec.elevation.slice();
    const result = generateWorldDrainage(spec);
    expect(result.count).toBe(4);
    verifyChannels(spec, result);
    expect(generateWorldDrainage(spec)).toEqual(result);
    expect(spec.kind).toEqual(originalKind);
    expect(spec.elevation).toEqual(originalElevation);
    expect(generateWorldDrainage({ ...spec, seed: 1936 }).riverPixels).not.toEqual(
      result.riverPixels,
    );
  });

  it('carves an enclosed depression through its spillway instead of climbing its walls', () => {
    const spec = island();
    const center = 20 * spec.width + 24;
    spec.elevation[center] = 0.12;
    spec.elevation[center + spec.width] = 0.1;
    const result = generateWorldDrainage({
      ...spec,
      count: 1,
      referenceRivers: [
        [
          { x: 24, y: 20 },
          { x: 24, y: 21 },
        ],
      ],
    });
    expect(result.count).toBe(1);
    verifyChannels(spec, result);
    expect(result.elevation.some((value, pixel) => value < spec.elevation[pixel]!)).toBe(true);
    expect(result.warnings.join(' ')).toContain('drainage hint');
  });

  it('finds lake outlets even when there is no sea', () => {
    const width = 36;
    const height = 32;
    const kind = new Uint8Array(width * height).fill(1);
    const elevation = new Float32Array(kind.length).fill(0.6);
    for (let y = 12; y < 18; y += 1)
      for (let x = 14; x < 20; x += 1) {
        kind[y * width + x] = 2;
        elevation[y * width + x] = -0.05;
      }
    const spec = { width, height, kind, elevation, seed: 3, count: 2 };
    const result = generateWorldDrainage(spec);
    expect(result.count).toBe(2);
    verifyChannels(spec, result);
  });

  it('handles flat terrain without loops, self-touching channels, or edge wrapping', () => {
    const spec = island(30, 28);
    for (let pixel = 0; pixel < spec.kind.length; pixel += 1)
      if (spec.kind[pixel] === 1) spec.elevation[pixel] = 0.45;
    for (const seed of [0, 1, 2, 1001, -77]) {
      const result = generateWorldDrainage({ ...spec, seed, count: 2 });
      expect(result.count).toBe(2);
      verifyChannels(spec, result);
    }
  });

  it('ignores water-only reference hints and returns a generated fallback', () => {
    const spec = island();
    const result = generateWorldDrainage({
      ...spec,
      count: 1,
      referenceRivers: [
        [
          { x: 0, y: 0 },
          { x: 0, y: 39 },
        ],
      ],
    });
    expect(result.count).toBe(1);
    expect(result.warnings.join(' ')).toContain('contains no land');
    verifyChannels(spec, result);
  });

  it('reports unavailable outlets and leaves sealed land unchanged', () => {
    const spec = island();
    spec.kind.fill(1);
    spec.elevation.fill(0.5);
    const result = generateWorldDrainage(spec);
    expect(result.count).toBe(0);
    expect(result.elevation).toEqual(spec.elevation);
    expect(result.riverPixels.every((value) => value === 255)).toBe(true);
    expect(result.warnings.join(' ')).toContain('no sea or lake outlet');
  });

  it('returns the original surface when no rivers are requested', () => {
    const spec = island();
    const result = generateWorldDrainage({ ...spec, count: 0 });
    expect(result.count).toBe(0);
    expect(result.elevation).toEqual(spec.elevation);
    expect(result.warnings).toEqual([]);
    verifyChannels(spec, result);
  });

  it('reports shortfalls without disconnected or ambiguous partial rivers', () => {
    const spec = island(8, 8);
    const result = generateWorldDrainage({ ...spec, count: 100 });
    expect(result.count).toBeLessThan(100);
    expect(result.warnings.join(' ')).toContain('Generated');
    verifyChannels(spec, result);
  });

  it.each([
    { width: 0 },
    { width: 1.5 },
    { width: 13_238_273, height: 1 },
    { count: -1 },
    { count: 4097 },
    { seed: Number.NaN },
    { kind: new Uint8Array(2) },
    { elevation: new Float32Array(2) },
    { referenceRivers: [[{ x: 0, y: 0 }]] },
    {
      referenceRivers: [
        [
          { x: -1, y: 0 },
          { x: 1, y: 0 },
        ],
      ],
    },
    {
      referenceRivers: [
        [
          { x: 0, y: 0 },
          { x: 48, y: 0 },
        ],
      ],
    },
    {
      referenceRivers: [
        [
          { x: 0, y: 0 },
          { x: 1, y: Number.NaN },
        ],
      ],
    },
  ])('rejects malformed dimensions, limits, buffers, or reference coordinates: %j', (patch) => {
    expect(() => generateWorldDrainage({ ...island(), ...patch })).toThrow();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01])(
    'rejects invalid land height %s',
    (value) => {
      const spec = island();
      spec.elevation[20 * spec.width + 24] = value;
      expect(() => generateWorldDrainage(spec)).toThrow('elevations');
    },
  );

  it('rejects unknown kinds and positive water elevations', () => {
    const spec = island();
    spec.kind[0] = 3;
    expect(() => generateWorldDrainage(spec)).toThrow('unknown');
    spec.kind[0] = 0;
    spec.elevation[0] = 0.1;
    expect(() => generateWorldDrainage(spec)).toThrow('elevations');
  });
});
