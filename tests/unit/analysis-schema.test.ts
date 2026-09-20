import { describe, expect, it } from 'vitest';
import {
  decisionInspectRequestSchema,
  impactInspectRequestSchema,
} from '../../src/hoi4_agent_tools/schemas/analysis.js';

describe('cross-system analysis request boundaries', () => {
  it('accepts a bounded proposed source with a typed symbol', () => {
    const parsed = impactInspectRequestSchema.parse({
      workspaceId: 'fixture',
      symbols: [{ kind: 'idea', id: 'rationing' }],
      proposedSources: [{ relativePath: 'common/decisions/policy.txt', content: 'policy = {}' }],
    });
    expect(parsed).toMatchObject({ workspaceId: 'fixture', refresh: false });
  });

  it('rejects empty selections, traversal, and unknown symbol kinds', () => {
    expect(impactInspectRequestSchema.safeParse({ workspaceId: 'fixture' }).success).toBe(false);
    expect(
      impactInspectRequestSchema.safeParse({
        workspaceId: 'fixture',
        changedFiles: ['mod:../outside.txt'],
      }).success,
    ).toBe(false);
    expect(
      impactInspectRequestSchema.safeParse({
        workspaceId: 'fixture',
        proposedSources: [{ relativePath: '../outside.txt', content: '' }],
      }).success,
    ).toBe(false);
    expect(
      impactInspectRequestSchema.safeParse({
        workspaceId: 'fixture',
        symbols: [{ kind: 'arbitrary_command', id: 'anything' }],
      }).success,
    ).toBe(false);
  });

  it('requires declared actor and target scenarios for comparison input', () => {
    const valid = {
      workspaceId: 'fixture',
      mode: 'compare',
      id: 'state_action',
      scenarios: [
        {
          id: 'owned',
          actor: 'GER',
          state: {},
          scopes: { FROM: { id: '123', type: 'state', state: { owner: 'GER' } } },
        },
      ],
      proposedSources: [{ relativePath: 'common/decisions/policy.txt', content: null }],
    };
    expect(decisionInspectRequestSchema.safeParse(valid).success).toBe(true);
    expect(
      decisionInspectRequestSchema.safeParse({ ...valid, proposedSources: undefined }).success,
    ).toBe(false);
    expect(decisionInspectRequestSchema.safeParse({ ...valid, scenarios: [] }).success).toBe(false);
    expect(
      decisionInspectRequestSchema.safeParse({
        ...valid,
        scenarios: [valid.scenarios[0], valid.scenarios[0]],
      }).success,
    ).toBe(false);
    expect(
      decisionInspectRequestSchema.safeParse({
        workspaceId: 'fixture',
        proposedSources: valid.proposedSources,
      }).success,
    ).toBe(false);
  });
});
