import { describe, expect, it } from 'vitest';
import { eventPartialReasons } from '../../src/hoi4_agent_tools/event/operations.js';
import type { EventGraphSnapshot } from '../../src/hoi4_agent_tools/event/model.js';

const graph = (fields: Partial<Record<'analysisMode' | 'skippedSourceCount', unknown>>) =>
  ({
    complete: false,
    analysisMode: 'full',
    skippedSourceCount: 0,
    ...fields,
  }) as unknown as EventGraphSnapshot;

const codes = (reasons: ReturnType<typeof eventPartialReasons>) => reasons.map(({ code }) => code);

describe('what a partial event answer is missing', () => {
  it('names a trace that stopped at its limits', () => {
    const reasons = eventPartialReasons({
      graph: graph({ analysisMode: 'focused' }),
      summary: { trace: { truncated: true, boundaryNodes: 2 } },
    });
    expect(codes(reasons)).toEqual(['EVENT_TRACE_TRUNCATED']);
    expect(reasons[0]).toMatchObject({ severity: 'info', category: 'configuration' });
    expect(reasons[0]?.message).toContain('maxNodes');
  });

  it('names skipped sources with their count', () => {
    const reasons = eventPartialReasons({ graph: graph({ skippedSourceCount: 3 }) });
    expect(codes(reasons)).toEqual(['EVENT_SOURCES_SKIPPED']);
    expect(reasons[0]?.message).toContain('3 event source');
  });

  it('names the deferred workspace-wide passes of a focused answer with nothing skipped', () => {
    const reasons = eventPartialReasons({
      graph: graph({ analysisMode: 'focused' }),
      summary: { entryPoints: 4 },
    });
    expect(codes(reasons)).toEqual(['EVENT_FOCUSED_ANALYSIS_DEFERRED']);
    expect(reasons[0]?.message).toContain('scripted effects');
  });

  it('names an unfinished helper expansion and skipped sources together', () => {
    const reasons = eventPartialReasons({
      graph: graph({ skippedSourceCount: 1 }),
      helperExpansion: { complete: false },
    });
    expect(codes(reasons)).toEqual(['EVENT_HELPER_EXPANSION_INCOMPLETE', 'EVENT_SOURCES_SKIPPED']);
  });
});
