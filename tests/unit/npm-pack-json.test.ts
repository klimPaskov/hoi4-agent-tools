import { describe, expect, it } from 'vitest';
import { npmPackResults } from '../../scripts/distribution/npm-pack-json.js';

const result = { name: 'pkg', version: '1.0.0', filename: 'pkg-1.0.0.tgz', files: [] };

describe('npm pack --json output', () => {
  it('reads the array form of npm 11 and earlier', () => {
    expect(npmPackResults(JSON.stringify([result]))).toEqual([result]);
  });

  it('reads the object form of npm 12, keyed by package name', () => {
    expect(npmPackResults(JSON.stringify({ pkg: result }))).toEqual([result]);
  });

  it('strips a byte order mark', () => {
    expect(npmPackResults(`\uFEFF${JSON.stringify([result])}`)).toEqual([result]);
  });

  it('rejects output that is neither form', () => {
    expect(() => npmPackResults('{}')).toThrow('neither an array nor an object');
    expect(() => npmPackResults('"pkg"')).toThrow('neither an array nor an object');
    expect(() => npmPackResults('null')).toThrow('neither an array nor an object');
    expect(() => npmPackResults(JSON.stringify({ pkg: 'x' }))).toThrow('neither');
    expect(() => npmPackResults(JSON.stringify({ pkg: [result] }))).toThrow('neither');
    expect(() => npmPackResults('not json')).toThrow();
  });
});
