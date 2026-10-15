import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { ServerState } from '../../src/hoi4_agent_tools/core/server-state.js';
import { TransactionCanonicalSnapshot } from '../../src/hoi4_agent_tools/core/transaction-canonical.js';
import { TRANSACTION_MAX_MANIFEST_BYTES } from '../../src/hoi4_agent_tools/core/transaction-limits.js';

describe('request-local canonical transaction snapshots', () => {
  it('matches canonical bytes, hashes, and authentication for seeded nested payloads and mutable revisions', async () => {
    const state = await ServerState.create(
      await mkdtemp(path.join(tmpdir(), 'hoi4-canonical-state-')),
    );
    let seed = 17;
    const next = () => (seed = Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    const mutableKeys = [
      'revision',
      'state',
      'appliedFiles',
      'pendingFiles',
      'failure',
      'integrityHash',
      'authenticationTag',
    ];
    for (let sample = 0; sample < 100; sample += 1) {
      const fixed = {
        '2': { '10': 'ten', '2': 'two', zero: -0 },
        '10': null,
        planPayload: {
          files: Array.from({ length: next() % 20 }, (_, index) => ({
            relativePath: `history/states/${index}-"\\é.txt`,
            nested: { z: next(), a: [false, null, '\n\t\u0000', '🌍'] },
          })),
          optional: undefined,
        },
        artifacts: [
          { name: '雪.json', details: Object.fromEntries([['__proto__', { safe: true }]]) },
        ],
      };
      const payload = {
        ...fixed,
        revision: 1,
        state: 'applying',
        appliedFiles: [] as string[],
        integrityHash: '',
        authenticationTag: '',
      };
      const snapshot = new TransactionCanonicalSnapshot(payload, mutableKeys);
      for (let revision = 2; revision < 5; revision += 1) {
        const candidate = {
          ...payload,
          revision,
          appliedFiles: Array.from({ length: revision }, (_, i) => `file-${i}.txt`),
          pendingFiles:
            revision % 2 === 0
              ? []
              : [
                  {
                    relativePath: 'next.txt',
                    beforeIdentity: null,
                    stagedIdentity: { device: '0', inode: String(next()) },
                  },
                ],
        };
        for (const excluded of [
          [],
          ['authenticationTag'],
          ['integrityHash', 'authenticationTag'],
        ]) {
          const expected = Object.fromEntries(
            Object.entries(candidate).filter(([key]) => !excluded.includes(key)),
          );
          const serialized = snapshot.serialize(candidate, excluded);
          expect(serialized).toBe(canonicalJson(expected));
          expect(sha256Bytes(serialized)).toBe(sha256Bytes(canonicalJson(expected)));
          expect(state.authenticateCanonicalJournal(serialized)).toBe(
            state.authenticateJournal(expected),
          );
        }
      }
    }
  });

  it('copies immutable field bytes and refuses oversized snapshots, revisions, and authentication input', async () => {
    const source = { fixed: { value: 'original' }, revision: 1 };
    const snapshot = new TransactionCanonicalSnapshot(source, ['revision']);
    source.fixed.value = 'external mutation';
    expect(snapshot.serialize({ ...source, revision: 2 })).toBe(
      canonicalJson({ fixed: { value: 'original' }, revision: 2 }),
    );
    const other = new TransactionCanonicalSnapshot(source, ['revision']);
    expect(other.serialize(source)).toBe(canonicalJson(source));
    expect(
      () =>
        new TransactionCanonicalSnapshot({ fixed: 'x'.repeat(TRANSACTION_MAX_MANIFEST_BYTES) }, []),
    ).toThrowError(expect.objectContaining({ code: 'TRANSACTION_MANIFEST_LIMIT' }));
    expect(() =>
      snapshot.serialize({ ...source, revision: 'x'.repeat(TRANSACTION_MAX_MANIFEST_BYTES) }),
    ).toThrowError(expect.objectContaining({ code: 'TRANSACTION_MANIFEST_LIMIT' }));
    const state = await ServerState.create(
      await mkdtemp(path.join(tmpdir(), 'hoi4-canonical-state-')),
    );
    expect(() =>
      state.authenticateCanonicalJournal('x'.repeat(TRANSACTION_MAX_MANIFEST_BYTES + 1)),
    ).toThrowError(expect.objectContaining({ code: 'TRANSACTION_MANIFEST_LIMIT' }));
  });
});
