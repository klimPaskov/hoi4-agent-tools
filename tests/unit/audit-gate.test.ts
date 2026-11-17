import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  auditExceptionsSchema,
  evaluateAudit,
  type AuditExceptions,
} from '../../scripts/audit-gate.js';

const exceptions: AuditExceptions = {
  exceptions: [
    {
      id: 'GHSA-fc5q-39xc-vjpf',
      package: 'picomatch',
      reason: 'Development tools only; no fixed version is published.',
      approved: '2026-11-17',
      reviewBy: '2026-12-01',
    },
  ],
};

function advisory(name: string, id: string, severity: string): Record<string, unknown> {
  return { name, severity, url: `https://github.com/advisories/${id}`, title: 't' };
}

function report(...via: Record<string, unknown>[]): unknown {
  return {
    vulnerabilities: {
      picomatch: { via },
      vite: { via: ['picomatch'] },
    },
  };
}

describe('audit gate', () => {
  it('allows a listed advisory in the listed package before its review date', () => {
    const result = evaluateAudit(
      report(advisory('picomatch', 'GHSA-fc5q-39xc-vjpf', 'high')),
      exceptions,
      '2026-11-17',
    );
    expect(result.failures).toEqual([]);
    expect(result.allowed).toHaveLength(1);
  });

  it('fails a high advisory with no exception', () => {
    const result = evaluateAudit(
      report(
        advisory('picomatch', 'GHSA-fc5q-39xc-vjpf', 'high'),
        advisory('other', 'GHSA-2222-3333-4444', 'critical'),
      ),
      exceptions,
      '2026-11-17',
    );
    expect(result.failures).toEqual([
      'critical GHSA-2222-3333-4444 in other has no reviewed exception',
    ]);
  });

  it('does not let an exception cover the same advisory in another package', () => {
    const result = evaluateAudit(
      report(
        advisory('picomatch', 'GHSA-fc5q-39xc-vjpf', 'high'),
        advisory('anymatch', 'GHSA-fc5q-39xc-vjpf', 'high'),
      ),
      exceptions,
      '2026-11-17',
    );
    expect(result.failures).toEqual([
      'high GHSA-fc5q-39xc-vjpf in anymatch has no reviewed exception',
    ]);
  });

  it('fails once the review date has passed', () => {
    const result = evaluateAudit(
      report(advisory('picomatch', 'GHSA-fc5q-39xc-vjpf', 'high')),
      exceptions,
      '2026-12-02',
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('review date 2026-12-01 has passed');
  });

  it('fails a stale exception that matches no advisory', () => {
    const result = evaluateAudit(report(), exceptions, '2026-11-17');
    expect(result.failures).toEqual([
      'The exception for GHSA-fc5q-39xc-vjpf in picomatch matches no advisory any more; remove it',
    ]);
  });

  it('ignores moderate and low advisories', () => {
    const result = evaluateAudit(
      report(
        advisory('picomatch', 'GHSA-fc5q-39xc-vjpf', 'high'),
        advisory('minimatch', 'GHSA-g3hv-75wg-m249', 'moderate'),
      ),
      exceptions,
      '2026-11-17',
    );
    expect(result.failures).toEqual([]);
  });

  it('rejects a malformed report and an exception without a reason', () => {
    expect(() => evaluateAudit({ nope: 1 }, exceptions, '2026-11-17')).toThrow();
    expect(() =>
      auditExceptionsSchema.parse({
        exceptions: [{ ...exceptions.exceptions[0], reason: '' }],
      }),
    ).toThrow();
  });

  it('keeps the checked-in exception list valid and dated', () => {
    const file = auditExceptionsSchema.parse(
      JSON.parse(
        readFileSync(new URL('../../scripts/audit-exceptions.json', import.meta.url), 'utf8'),
      ),
    );
    for (const entry of file.exceptions) expect(entry.reviewBy > entry.approved).toBe(true);
  });
});
