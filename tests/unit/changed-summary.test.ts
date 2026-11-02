import { describe, expect, it } from 'vitest';
import { summarizeChangedFiles } from '../../src/hoi4_agent_tools/core/changed-summary.js';

const hash = 'a'.repeat(64);

describe('changed file summary', () => {
  it('counts created, removed and modified files per folder', () => {
    const summary = summarizeChangedFiles([
      { relativePath: 'history/states/1-A.txt', beforeSha256: null, afterSha256: hash },
      { relativePath: 'history/states/2-B.txt', beforeSha256: null, afterSha256: hash },
      { relativePath: 'history/states/3-C.txt', beforeSha256: hash, afterSha256: null },
      { relativePath: 'map/provinces.bmp', beforeSha256: hash, afterSha256: 'b'.repeat(64) },
      { relativePath: 'map/strategicregions/1-R.txt', beforeSha256: null, afterSha256: hash },
      { relativePath: 'map\\definition.csv', beforeSha256: hash, afterSha256: 'c'.repeat(64) },
      { relativePath: 'descriptor.mod', beforeSha256: hash, afterSha256: 'd'.repeat(64) },
    ]);
    expect(summary).toMatchObject({ total: 7, created: 3, removed: 1, modified: 3 });
    expect(summary.folders).toEqual([
      { folder: 'history/states', created: 2, removed: 1, modified: 0 },
      { folder: 'map', created: 0, removed: 0, modified: 2 },
      { folder: '.', created: 0, removed: 0, modified: 1 },
      { folder: 'map/strategicregions', created: 1, removed: 0, modified: 0 },
    ]);
    expect(summary.omittedFolders).toBe(0);
  });

  it('keeps the largest folders and counts the rest', () => {
    const files = Array.from({ length: 50 }, (_, index) => ({
      relativePath: `dir_${index.toString().padStart(2, '0')}/file.txt`,
      beforeSha256: null,
      afterSha256: hash,
    }));
    const summary = summarizeChangedFiles(files, 10);
    expect(summary.total).toBe(50);
    expect(summary.folders).toHaveLength(10);
    expect(summary.omittedFolders).toBe(40);
    expect(summary.folders[0]?.folder).toBe('dir_00');
    expect(JSON.stringify(summary).length).toBeLessThan(2_000);
  });

  it('is empty for no files', () => {
    expect(summarizeChangedFiles([])).toEqual({
      total: 0,
      created: 0,
      removed: 0,
      modified: 0,
      folders: [],
      omittedFolders: 0,
    });
  });
});
