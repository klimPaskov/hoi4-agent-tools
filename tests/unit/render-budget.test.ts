import { describe, expect, it } from 'vitest';
import {
  assertRenderDimensions,
  renderDimensionViolation,
  RenderBudget,
  RENDER_MAX_AGGREGATE_PIXELS,
  RENDER_MAX_DECODED_PIXELS,
  RENDER_MAX_DISTINCT_RASTER_OPERATIONS,
  RENDER_MAX_PIXELS,
} from '../../src/hoi4_agent_tools/core/render-budget.js';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';
import { parsePreviewScenario } from '../../src/hoi4_agent_tools/gui/scenario.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';

describe('shared render resource budget', () => {
  it('admits vanilla scale-1 maps and the committed large-focus canvas', () => {
    expect(assertRenderDimensions(5_632, 2_048, 'vanilla map').pixels).toBe(11_534_336);
    expect(assertRenderDimensions(13_152, 3_600, 'focus benchmark').pixels).toBe(47_347_200);
  });

  it('uses safe exact-boundary arithmetic and deterministic per-artifact blockers', () => {
    expect(assertRenderDimensions(8_192, 6_144).pixels).toBe(RENDER_MAX_PIXELS);
    expect(() => assertRenderDimensions(8_192, 6_145, 'oversized canvas')).toThrowError(
      expect.objectContaining({
        name: 'ServiceError',
        code: 'RENDER_PIXELS_BLOCKED',
        details: expect.objectContaining({ maximumPixels: RENDER_MAX_PIXELS }),
      }),
    );
    for (const invalid of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(renderDimensionViolation(invalid, 1)?.code).toBe('RENDER_DIMENSIONS_BLOCKED');
    }
  });

  it('enforces stricter decode ceilings and cannot be raised by a caller override', () => {
    expect(
      assertRenderDimensions(4_096, 4_096, 'decoded texture', {
        maximumPixels: RENDER_MAX_DECODED_PIXELS,
      }).pixels,
    ).toBe(RENDER_MAX_DECODED_PIXELS);
    expect(() =>
      assertRenderDimensions(4_096, 4_097, 'decoded texture', {
        maximumPixels: RENDER_MAX_DECODED_PIXELS,
      }),
    ).toThrowError(expect.objectContaining({ code: 'RENDER_PIXELS_BLOCKED' }));
    expect(() =>
      assertRenderDimensions(8_192, 6_145, 'hard ceiling', {
        maximumPixels: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrowError(expect.objectContaining({ code: 'RENDER_PIXELS_BLOCKED' }));
  });

  it('caps aggregate variants before their next allocation', () => {
    const budget = new RenderBudget();
    for (let index = 0; index < 4; index += 1) budget.reserve(4_096, 4_096, `variant ${index}`);
    expect(budget.reservedPixels).toBe(RENDER_MAX_AGGREGATE_PIXELS);
    expect(() => budget.reserve(1, 1, 'one pixel too many')).toThrowError(
      expect.objectContaining({
        code: 'RENDER_AGGREGATE_BLOCKED',
        details: expect.objectContaining({
          reservedPixels: RENDER_MAX_AGGREGATE_PIXELS,
          maximumAggregatePixels: RENDER_MAX_AGGREGATE_PIXELS,
        }),
      }),
    );
  });

  it('deduplicates raster work keys and enforces a caller-lowerable hard operation ceiling', () => {
    const budget = new RenderBudget({ maximumDistinctRasterOperations: 2 });
    budget.reserveRasterOperation('asset:a', 'asset A');
    budget.reserveRasterOperation('asset:a', 'asset A reused');
    budget.reserveRasterOperation('asset:b', 'asset B');
    expect(budget.distinctRasterOperations).toBe(2);
    expect(() => budget.reserveRasterOperation('asset:c', 'asset C')).toThrowError(
      expect.objectContaining({
        code: 'RENDER_RASTER_OPERATION_BUDGET_BLOCKED',
        details: expect.objectContaining({ maximumDistinctRasterOperations: 2 }),
      }),
    );

    const cannotRaise = new RenderBudget({
      maximumDistinctRasterOperations: Number.MAX_SAFE_INTEGER,
    });
    for (let index = 0; index < RENDER_MAX_DISTINCT_RASTER_OPERATIONS; index += 1)
      cannotRaise.reserveRasterOperation(`asset:${index}`);
    expect(() => cannotRaise.reserveRasterOperation('asset:overflow')).toThrowError(
      expect.objectContaining({ code: 'RENDER_RASTER_OPERATION_BUDGET_BLOCKED' }),
    );
  });

  it('admits exact vanilla scale-1 diff, before, and proposed output dimensions', () => {
    const budget = new RenderBudget();
    budget.reserve(5_632, 2_048, 'vanilla diff');
    budget.reserve(5_632, 2_048, 'vanilla before');
    budget.reserve(5_632, 2_048, 'vanilla proposed');
    expect(budget.reservedPixels).toBe(34_603_008);
    expect(budget.reservedPixels).toBeLessThan(RENDER_MAX_AGGREGATE_PIXELS);
  });

  it('rejects unsafe GUI and map-mask products at schema admission', () => {
    expect(() =>
      parsePreviewScenario({ id: 'oversized', resolution: { width: 16_384, height: 4_096 } }),
    ).toThrow(/RENDER_PIXELS_BLOCKED/u);
    const mask = mapOperationSchema.safeParse({
      id: 'mask-budget',
      kind: 'split_province',
      sourceProvinceId: 1,
      geometry: {
        kind: 'mask',
        width: 5_000,
        height: 5_000,
        origin: { x: 0, y: 0 },
        selectedPixelCount: 1,
        sha256: '0'.repeat(64),
        data: 'AAAA',
      },
      definition: { method: 'inherit-source' },
      distribution: {
        state: 'inherit-source',
        strategicRegion: 'inherit-source',
        victoryPoints: 'retain-source',
        provinceBuildings: 'retain-source',
        ports: 'retain-source',
        supplyNodes: 'retain-source',
        railways: 'retain-source',
        adjacencies: 'retain-source',
        positions: 'retain-source',
        entityLocators: 'retain-source',
      },
    });
    expect(mask.success).toBe(false);
    if (!mask.success) expect(mask.error.message).toContain('RENDER_PIXELS_BLOCKED');
  });

  it('exposes budget failures as ServiceError instances for blocker envelopes', () => {
    try {
      new RenderBudget().reserve(8_192, 6_145, 'service artifact');
      expect.unreachable('budget should block');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect(error).toMatchObject({ code: 'RENDER_PIXELS_BLOCKED' });
    }
  });
});
