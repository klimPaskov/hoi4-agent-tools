import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  auditExceptionsSchema,
  evaluateAudit,
  fixedVersion,
  type AuditExceptions,
  type AuditInputs,
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

const picomatch = advisory('picomatch', 'GHSA-fc5q-39xc-vjpf', 'high', '<=4.0.7');

function advisory(
  name: string,
  id: string,
  severity: string,
  range = '<1.0.0',
): Record<string, unknown> {
  return { name, severity, range, url: `https://github.com/advisories/${id}`, title: 't' };
}

function report(...via: Record<string, unknown>[]): unknown {
  return { vulnerabilities: { picomatch: { via }, vite: { via: ['picomatch'] } } };
}

function inputs(overrides: Partial<AuditInputs> = {}): AuditInputs {
  return {
    full: report(picomatch),
    production: report(),
    publishedVersions: new Map([['picomatch', ['2.3.1', '4.0.6', '4.0.7', '5.0.0-beta.1']]]),
    today: '2026-11-17',
    ...overrides,
  };
}

describe('audit gate', () => {
  it('allows a listed dev-only advisory with no fixed version before its review date', () => {
    const result = evaluateAudit(inputs(), exceptions);
    expect(result.failures).toEqual([]);
    expect(result.allowed).toHaveLength(1);
  });

  it('fails a high advisory with no exception', () => {
    const result = evaluateAudit(
      inputs({ full: report(picomatch, advisory('other', 'GHSA-2222-3333-4444', 'critical')) }),
      exceptions,
    );
    expect(result.failures).toEqual([
      'critical GHSA-2222-3333-4444 in other has no reviewed exception',
    ]);
  });

  it('does not let an exception cover the same advisory in another package', () => {
    const result = evaluateAudit(
      inputs({
        full: report(picomatch, advisory('anymatch', 'GHSA-fc5q-39xc-vjpf', 'high')),
      }),
      exceptions,
    );
    expect(result.failures).toEqual([
      'high GHSA-fc5q-39xc-vjpf in anymatch has no reviewed exception',
    ]);
  });

  it('never passes an excepted advisory that reaches the production dependencies', () => {
    const result = evaluateAudit(inputs({ production: report(picomatch) }), exceptions);
    expect(result.allowed).toEqual([]);
    expect(result.failures).toEqual([
      'GHSA-fc5q-39xc-vjpf in picomatch reaches the production dependencies; an exception never covers those',
    ]);
  });

  it('stops counting an exception once a fixed version is published', () => {
    const result = evaluateAudit(
      inputs({ publishedVersions: new Map([['picomatch', ['4.0.7', '4.0.8']]]) }),
      exceptions,
    );
    expect(result.allowed).toEqual([]);
    expect(result.failures[0]).toContain('picomatch@4.0.8 is outside the vulnerable range');
  });

  it('fails when the published versions cannot be read', () => {
    const result = evaluateAudit(inputs({ publishedVersions: new Map() }), exceptions);
    expect(result.failures[0]).toContain('a fix cannot be ruled out');
  });

  it('fails once the review date has passed', () => {
    const result = evaluateAudit(inputs({ today: '2026-12-02' }), exceptions);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('review date 2026-12-01 has passed');
  });

  it('fails a stale exception that matches no advisory', () => {
    const result = evaluateAudit(inputs({ full: report() }), exceptions);
    expect(result.failures).toEqual([
      'The exception for GHSA-fc5q-39xc-vjpf in picomatch matches no advisory any more; remove it',
    ]);
  });

  it('ignores moderate advisories in the full audit', () => {
    const result = evaluateAudit(
      inputs({
        full: report(picomatch, advisory('minimatch', 'GHSA-g3hv-75wg-m249', 'moderate')),
      }),
      exceptions,
    );
    expect(result.failures).toEqual([]);
  });

  it('ignores prereleases and unparsable versions when looking for a fix', () => {
    expect(fixedVersion('<=4.0.7', ['4.0.7', '5.0.0-beta.1', 'garbage'])).toBeUndefined();
    expect(fixedVersion('<=4.0.7', ['4.0.7', '4.1.0', '4.0.9'])).toBe('4.1.0');
  });

  it('rejects a malformed report and an exception without a reason', () => {
    expect(() => evaluateAudit(inputs({ full: { nope: 1 } }), exceptions)).toThrow();
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
