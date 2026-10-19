import { describe, expect, it } from 'vitest';
import type { EventGraphNode, EventIssue } from '../../src/hoi4_agent_tools/event/model.js';
import type { EventRootDiscovery } from '../../src/hoi4_agent_tools/event/queries.js';
import {
  EVENT_INLINE_FINDINGS,
  summarizeEventIssues,
  summarizeEventPath,
  summarizeEventRoots,
} from '../../src/hoi4_agent_tools/event/summary.js';

function issue(
  code: string,
  classification: EventIssue['classification'],
  path: string,
  line: number,
  name?: string,
): EventIssue {
  return {
    code,
    classification,
    severity: 'warning',
    message: `${code} at ${path}:${line}`,
    confidence: 'confirmed',
    location: {
      path,
      start: { line, column: 1, offset: line * 10 },
      end: { line, column: 2, offset: line * 10 + 1 },
    },
    blockers: [],
    details: name === undefined ? {} : { name },
  };
}

function eventNode(eventId: string, sourcePath: string): EventGraphNode {
  return {
    id: `event:${eventId}`,
    kind: 'event',
    label: eventId,
    eventId,
    sourcePath,
    metadata: {},
  };
}

describe('inline event summaries', () => {
  it('ranks the mod’s own findings first, then by severity, and bounds the list', () => {
    const issues = [
      issue('EVENT_REFERENCE_MISSING', 'confirmed_error', 'game:events/a.txt', 1),
      issue('EVENT_GATE_WITHOUT_WRITER', 'design_warning', 'mod:events/b.txt', 9, 'late_flag'),
      issue('EVENT_TARGET_READ_BEFORE_SAVE', 'probable_defect', 'mod:events/b.txt', 4, 'target'),
      ...Array.from({ length: 12 }, (_, index) =>
        issue('EVENT_OPTION_DANGLING', 'design_warning', 'mod:events/c.txt', index + 1),
      ),
    ];
    const summary = summarizeEventIssues(issues) as {
      issues: number;
      byLayer: Record<string, number>;
      topCodes: Record<string, number>;
      findings: Array<{ code: string; path: string; subject?: string }>;
    };

    expect(summary.issues).toBe(15);
    expect(summary.byLayer).toEqual({ game: 1, mod: 14 });
    expect(Object.keys(summary.topCodes)[0]).toBe('EVENT_OPTION_DANGLING');
    expect(summary.findings).toHaveLength(EVENT_INLINE_FINDINGS);
    expect(summary.findings[0]).toMatchObject({
      code: 'EVENT_TARGET_READ_BEFORE_SAVE',
      path: 'mod:events/b.txt',
      subject: 'target',
    });
    expect(summary.findings.some(({ path }) => path.startsWith('game:'))).toBe(false);
  });

  it('samples callerless events from the mod before vanilla and counts them by layer', () => {
    const roots: EventRootDiscovery = {
      entryPoints: [],
      automaticEvents: [],
      knownRootEventIds: [],
      callerlessTriggeredEvents: [
        eventNode('AAA_vanilla.1', 'game:events/vanilla.txt'),
        eventNode('zzz_mod.1', 'mod:events/mod.txt'),
      ],
      stronglyConnectedComponents: [],
    };
    expect(summarizeEventRoots(roots)).toMatchObject({
      callerlessTriggeredEventIds: ['zzz_mod.1', 'AAA_vanilla.1'],
      callerlessTriggeredByLayer: { game: 1, mod: 1 },
    });
  });

  it('states whether a path exists and why not', () => {
    expect(
      summarizeEventPath({
        found: false,
        fromNodeIds: ['event:a.1'],
        toNodeIds: ['event:a.2'],
        steps: [],
        failureReason: 'unreachable',
        failureMessage: 'No route connects the selected events',
        unresolvedAssumptions: [],
        boundary: { maxDepth: 8, maxNodes: 500, expandHelpers: true },
      }),
    ).toEqual({
      found: false,
      steps: 0,
      eventIds: [],
      failureReason: 'unreachable',
      failureMessage: 'No route connects the selected events',
      unresolvedAssumptions: 0,
    });
  });
});
