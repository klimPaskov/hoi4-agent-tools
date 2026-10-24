import { describe, expect, it } from 'vitest';
import {
  generateWorldProvinces,
  type WorldProvinceInput,
  type WorldProvinces,
} from '../../src/hoi4_agent_tools/map/world-provinces.js';

function input(width = 256, height = 192): WorldProvinceInput {
  return {
    width,
    height,
    seed: 1977,
    kind: new Uint8Array(width * height).fill(1),
    elevation: new Float32Array(width * height).fill(0.2),
    moisture: new Float32Array(width * height).fill(0.3),
    landProvincePixels: 150,
    seaProvincePixels: 300,
  };
}

function assertTopology(source: WorldProvinceInput, provinces: WorldProvinces): void {
  const { width, height } = source;
  const seen = new Uint8Array(width * height);
  const components = new Int32Array(provinces.kind.length);
  const minX = new Int32Array(provinces.kind.length).fill(width);
  const maxX = new Int32Array(provinces.kind.length).fill(-width);
  const minY = new Int32Array(provinces.kind.length).fill(height);
  const maxY = new Int32Array(provinces.kind.length).fill(-height);
  const localSameKind = new Set<number>();
  for (let p = 0; p < seen.length; p++) {
    const id = provinces.pixel[p]!;
    expect(provinces.kind[id]).toBe(source.kind[p]);
    const x = p % width;
    const y = Math.floor(p / width);
    for (const q of [x + 1 < width ? p + 1 : -1, p + width])
      if (
        q >= 0 &&
        q < source.kind.length &&
        provinces.pixel[q] !== id &&
        source.kind[p] === source.kind[q]
      ) {
        localSameKind.add(id);
        localSameKind.add(provinces.pixel[q]!);
      }
    minX[id] = Math.min(minX[id]!, x);
    maxX[id] = Math.max(maxX[id]!, x);
    minY[id] = Math.min(minY[id]!, y);
    maxY[id] = Math.max(maxY[id]!, y);
    if (seen[p]) continue;
    components[id]!++;
    const queue = [p];
    seen[p] = 1;
    for (const current of queue) {
      const cx = current % width;
      for (const q of [
        current - width,
        current + width,
        cx + 1 < width ? current + 1 : -1,
        cx > 0 ? current - 1 : -1,
      ]) {
        if (q < 0 || q >= seen.length || seen[q] || provinces.pixel[q] !== id) continue;
        seen[q] = 1;
        queue.push(q);
      }
    }
  }
  expect([...components].every((count) => count === 1)).toBe(true);
  for (let id = 0; id < provinces.kind.length; id++) {
    expect(maxX[id]! - minX[id]! + 1).toBeLessThanOrEqual(width / 8);
    expect(maxY[id]! - minY[id]! + 1).toBeLessThanOrEqual(height / 8);
    if (localSameKind.has(id)) expect(provinces.size[id]).toBeGreaterThanOrEqual(20);
    for (const other of provinces.neighbors[id]!)
      expect(provinces.neighbors[other]!.has(id)).toBe(true);
  }
  for (let y = 0; y + 1 < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = y * width + x;
      const b = y * width + ((x + 1) % width);
      expect(
        new Set([a, b, a + width, b + width].map((p) => provinces.pixel[p])).size,
      ).toBeLessThan(4);
    }
  }
  expect(provinces.size.reduce((sum, size) => sum + size, 0)).toBe(width * height);
}

describe('natural world province geometry', () => {
  it('retains a tiny seam-cut water component without a map-spanning province or altered geography', () => {
    const source = input(512, 256);
    source.kind.fill(0);
    for (let y = 32; y <= 64; y++) for (let x = 480; x < 512; x++) source.kind[y * 512 + x] = 1;
    for (let y = 40; y < 49; y++) for (let x = 510; x < 512; x++) source.kind[y * 512 + x] = 0;
    const before = source.kind.slice(),
      output = generateWorldProvinces(source);
    assertTopology(source, output);
    const id = output.pixel[44 * 512 + 511]!;
    expect(output.size[id]).toBe(18);
    expect(output.neighbors[id]).toContain(output.pixel[44 * 512]!);
    expect(source.kind).toEqual(before);
  });

  it('keeps narrow coastal fragments viable without wrapping their native bounding boxes', () => {
    const source = input(512, 256);
    source.kind.fill(0);
    source.landProvincePixels = 1400;
    source.seaProvincePixels = 15000;
    for (let x = 0; x < 512; x++)
      for (let offset = 0; offset < 3; offset++) {
        const y = 80 + Math.round(20 * Math.sin(x / 21)) + offset;
        source.kind[y * 512 + x] = 1;
      }
    const output = generateWorldProvinces(source);
    assertTopology(source, output);
    expect(output.pixel[0]).not.toBe(output.pixel[511]);
  });

  it('preserves a curved coast, lakes and a tiny island while maintaining topology across the seam', () => {
    const source = input();
    const { width, height } = source;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const coast = 95 + Math.round(12 * Math.sin(y / 21));
        source.kind[y * width + x] = x > coast && x < 224 ? 1 : 0;
        if ((x - 156) ** 2 + (y - 95) ** 2 < 9 ** 2) source.kind[y * width + x] = 2;
      }
    }
    source.kind[20 * width + 20] = 1;
    const before = source.kind.slice();
    const output = generateWorldProvinces(source);
    assertTopology(source, output);
    expect(source.kind).toEqual(before);
    const island = output.pixel[20 * width + 20]!;
    expect(output.size[island]).toBe(1);
    expect(output.kind).toContain(2);
  });

  it('is deterministic, changes with the seed, and densely numbers provinces by their first pixel', () => {
    const source = input(192, 128);
    const output = generateWorldProvinces(source);
    const repeat = generateWorldProvinces(source);
    expect(output).toEqual(repeat);
    expect(generateWorldProvinces({ ...source, seed: 1978 }).pixel).not.toEqual(output.pixel);
    const first = new Set<number>();
    for (const id of output.pixel) {
      if (first.has(id)) continue;
      expect(id).toBe(first.size);
      first.add(id);
    }
    assertTopology(source, output);
  });

  it('gives elevated moist terrain more provinces than dry lowlands', () => {
    const source = input(512, 256);
    source.landProvincePixels = 200;
    for (let p = 0; p < source.kind.length; p++) {
      const high = p % source.width >= source.width / 2;
      source.elevation[p] = high ? 0.95 : 0.05;
      source.moisture[p] = high ? 0.95 : 0.05;
    }
    const output = generateWorldProvinces(source);
    const low = new Set<number>();
    const high = new Set<number>();
    for (let y = 0; y < source.height; y++) {
      for (let x = 32; x < source.width - 32; x++) {
        const id = output.pixel[y * source.width + x]!;
        if (x < source.width / 2 - 32) low.add(id);
        if (x > source.width / 2 + 32) high.add(id);
      }
    }
    expect(high.size).toBeGreaterThan(low.size * 1.2);
    assertTopology(source, output);
  });

  it('keeps the land province count at the requested size on uniformly wet land', () => {
    // Reference terrain carries moisture 0.45 to 0.96; extra sites once added 50-95% provinces.
    for (const moisture of [0.05, 0.5, 0.95]) {
      // Large enough that the sampling cell is not capped at a twentieth of the map.
      const source = input(2048, 1024);
      source.landProvincePixels = 400;
      source.elevation.fill(0.05);
      source.moisture.fill(moisture);
      const count = generateWorldProvinces(source).kind.length;
      const expected = (source.width * source.height) / source.landProvincePixels;
      expect(count).toBeGreaterThan(expected * 0.9);
      expect(count).toBeLessThan(expected * 1.1);
    }
  });

  it('cuts lakes at the sea province size, not the land size', () => {
    const source = input(2048, 1024);
    source.landProvincePixels = 100;
    source.seaProvincePixels = 2_500;
    for (let y = 256; y < 768; y++)
      for (let x = 512; x < 1536; x++) source.kind[y * source.width + x] = 2;
    const output = generateWorldProvinces(source);
    const lakes = output.kind.filter((kind) => kind === 2).length;
    const expected = (512 * 1024) / source.seaProvincePixels;
    expect(lakes).toBeGreaterThan(expected * 0.7);
    expect(lakes).toBeLessThan(expected * 1.4);
    assertTopology(source, output);
  });

  it('rejects invalid dimensions, excessive allocation, mismatched fields and non-finite values', () => {
    const source = input(64, 64);
    expect(() => generateWorldProvinces({ ...source, width: -1 })).toThrow(/dimensions/);
    expect(() => generateWorldProvinces({ ...source, width: 20_000, height: 20_000 })).toThrow(
      /limit/,
    );
    expect(() => generateWorldProvinces({ ...source, kind: new Uint8Array(1) })).toThrow(
      /dimensions/,
    );
    expect(() => generateWorldProvinces({ ...source, seed: NaN })).toThrow(/seed/);
    expect(() => generateWorldProvinces({ ...source, landProvincePixels: Infinity })).toThrow(
      /target/,
    );
    source.elevation[3] = NaN;
    expect(() => generateWorldProvinces(source)).toThrow(/non-finite/);
    source.elevation[3] = 0;
    source.kind[3] = 3;
    expect(() => generateWorldProvinces(source)).toThrow(/unsupported kind/);
  });

  it('reports an impossible exact kind-mask corner instead of changing land, lake or sea', () => {
    const source = input(128, 128);
    const p = 50 * source.width + 50;
    source.kind[p] = 0;
    source.kind[p + 1] = 1;
    source.kind[p + source.width] = 2;
    source.kind[p + source.width + 1] = 0;
    const before = source.kind.slice();
    expect(() => generateWorldProvinces(source)).toThrow(/four-province corner/);
    expect(source.kind).toEqual(before);
  });

  it('rejects more than 65,000 unavoidable isolated provinces before allocating province geometry', () => {
    const source = input(512, 512);
    source.kind.fill(0);
    for (let y = 0; y < source.height; y += 2)
      for (let x = 0; x < source.width; x += 2) source.kind[y * source.width + x] = 1;
    expect(() => generateWorldProvinces(source)).toThrow(/65,000 isolated provinces/);
  });
});
