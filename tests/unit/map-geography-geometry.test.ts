import { describe, expect, it } from 'vitest';
import {
  findSelfIntersection,
  interiorPoint,
  pointSegment,
  ringCentroid,
  ringContains,
  ringsIntersect,
  segmentsIntersect,
  signedArea,
} from '../../src/hoi4_agent_tools/map/geography/geometry.js';

const xs = (points: Array<[number, number]>) => points.map(([x]) => x);
const ys = (points: Array<[number, number]>) => points.map(([, y]) => y);

const unitSquare: Array<[number, number]> = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

describe('geography planar geometry', () => {
  it('detects crossing, touching and overlapping segments', () => {
    expect(segmentsIntersect(0, 0, 2, 2, 0, 2, 2, 0)).toBe(true);
    expect(segmentsIntersect(0, 0, 1, 1, 1, 1, 2, 0)).toBe(true);
    expect(segmentsIntersect(0, 0, 2, 0, 1, 0, 3, 0)).toBe(true);
    expect(segmentsIntersect(0, 0, 1, 0, 2, 0, 3, 0)).toBe(false);
    expect(segmentsIntersect(0, 0, 1, 0, 0, 1, 1, 1)).toBe(false);
    expect(segmentsIntersect(0, 0, 1, 1, 2, 2, 3, 3)).toBe(false);
    expect(segmentsIntersect(0, 0, 4, 0, 2, 1, 2, 3)).toBe(false);
  });

  it('signs the area by the order of the vertices', () => {
    expect(signedArea(xs(unitSquare), ys(unitSquare))).toBe(1);
    const reversed = [...unitSquare].reverse();
    expect(signedArea(xs(reversed), ys(reversed))).toBe(-1);
  });

  it('finds the centroid of a ring', () => {
    const [cx, cy] = ringCentroid(xs(unitSquare), ys(unitSquare));
    expect(cx).toBeCloseTo(0.5, 12);
    expect(cy).toBeCloseTo(0.5, 12);
  });

  it('tests containment with the boundary counting as inside', () => {
    const concave: Array<[number, number]> = [
      [0, 0],
      [4, 0],
      [4, 4],
      [3, 4],
      [3, 1],
      [1, 1],
      [1, 4],
      [0, 4],
    ];
    expect(ringContains(xs(concave), ys(concave), 0.5, 2)).toBe(true);
    expect(ringContains(xs(concave), ys(concave), 2, 2)).toBe(false);
    expect(ringContains(xs(concave), ys(concave), 3.5, 3)).toBe(true);
    expect(ringContains(xs(concave), ys(concave), 4, 2)).toBe(true);
    expect(ringContains(xs(concave), ys(concave), 2, 1)).toBe(true);
    expect(ringContains(xs(concave), ys(concave), 5, 2)).toBe(false);
    expect(ringContains(xs(concave), ys(concave), -0.0001, 2)).toBe(false);
  });

  it('measures the distance from a point to a segment', () => {
    expect(pointSegment(1, 1, 0, 0, 2, 0)).toEqual({ distance: 1, t: 0.5 });
    expect(pointSegment(-1, 0, 0, 0, 2, 0)).toEqual({ distance: 1, t: 0 });
    expect(pointSegment(5, 0, 0, 0, 2, 0)).toEqual({ distance: 3, t: 1 });
    expect(pointSegment(1, 1, 0, 0, 0, 0).distance).toBeCloseTo(Math.SQRT2, 12);
  });

  describe('self-intersection', () => {
    it('accepts simple rings and paths', () => {
      expect(findSelfIntersection(xs(unitSquare), ys(unitSquare), true)).toBeUndefined();
      const zigzag: Array<[number, number]> = [
        [0, 0],
        [1, 1],
        [2, 0],
        [3, 1],
      ];
      expect(findSelfIntersection(xs(zigzag), ys(zigzag), false)).toBeUndefined();
    });

    it('finds a crossing, a touch and a spike', () => {
      const bowtie: Array<[number, number]> = [
        [0, 0],
        [2, 2],
        [2, 0],
        [0, 2],
      ];
      expect(findSelfIntersection(xs(bowtie), ys(bowtie), true)).toEqual([0, 2]);
      const touch: Array<[number, number]> = [
        [0, 0],
        [4, 0],
        [4, 4],
        [2, 0],
        [0, 4],
      ];
      expect(findSelfIntersection(xs(touch), ys(touch), true)).toBeDefined();
      const spike: Array<[number, number]> = [
        [0, 0],
        [2, 0],
        [1, 0],
        [1, 2],
      ];
      expect(findSelfIntersection(xs(spike), ys(spike), true)).toBeDefined();
    });

    it('treats the closing edge as part of a closed ring only', () => {
      const open: Array<[number, number]> = [
        [0, 0],
        [2, 0],
        [2, 2],
        [1, 2],
        [1, -1],
      ];
      expect(findSelfIntersection(xs(open), ys(open), false)).toBeDefined();
      const fishhook: Array<[number, number]> = [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
      ];
      expect(findSelfIntersection(xs(fishhook), ys(fishhook), false)).toBeUndefined();
    });

    it('scales to long rings', () => {
      const n = 2_000;
      const star = Array.from({ length: n }, (_value, index) => {
        const turn = (index / n) * 2 * Math.PI;
        const radius = 1 + 0.05 * (index % 2);
        return [radius * Math.cos(turn), radius * Math.sin(turn)] as [number, number];
      });
      const started = Date.now();
      expect(findSelfIntersection(xs(star), ys(star), true)).toBeUndefined();
      // Swapping two neighbours makes one crossing.
      const tangled = [...star];
      [tangled[100], tangled[102]] = [tangled[102]!, tangled[100]!];
      expect(findSelfIntersection(xs(tangled), ys(tangled), true)).toBeDefined();
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });

  describe('ring intersection', () => {
    const shifted = (dx: number, dy: number, size = 1): Array<[number, number]> =>
      unitSquare.map(([x, y]) => [x * size + dx, y * size + dy]);

    it('separates disjoint, crossing, touching and nested rings', () => {
      const test = (other: Array<[number, number]>) =>
        ringsIntersect(xs(unitSquare), ys(unitSquare), xs(other), ys(other));
      expect(test(shifted(3, 3))).toBe(false);
      expect(test(shifted(0.5, 0.5))).toBe(true);
      expect(test(shifted(1, 0))).toBe(true);
      expect(test(shifted(0.25, 0.25, 0.5))).toBe(false);
      expect(test(shifted(-0.5, -0.5, 2))).toBe(false);
    });
  });

  it('puts the interior point of a U shape inside the U', () => {
    const u: Array<[number, number]> = [
      [0, 0],
      [3, 0],
      [3, 3],
      [2, 3],
      [2, 1],
      [1, 1],
      [1, 3],
      [0, 3],
    ];
    const [, centroidY] = ringCentroid(xs(u), ys(u));
    const bounds = { x0: 0, y0: 0, x1: 3, y1: 3 };
    const [px, py] = interiorPoint([{ xs: xs(u), ys: ys(u) }], centroidY, bounds);
    expect(ringContains(xs(u), ys(u), px, py)).toBe(true);
  });
});
