import { describe, expect, it } from 'vitest';
import { assembleRelease, changelogProblems } from '../../scripts/changelog.js';

const EMPTY = '# Changelog\n\n## Unreleased\n\n## 1.2.0 - 2026-11-01\n\n- Older entry.\n';

describe('changelog fragments', () => {
  it('accepts an empty Unreleased section and well-formed fragments', () => {
    expect(
      changelogProblems(EMPTY, [{ name: 'a.md', text: '- One entry.\n- Another.\n' }]),
    ).toEqual([]);
  });

  it('rejects an entry written directly under Unreleased', () => {
    const edited = EMPTY.replace('## Unreleased\n', '## Unreleased\n\n- Direct edit.\n');
    expect(changelogProblems(edited, [])).toEqual([
      expect.stringContaining('"## Unreleased" must stay empty'),
    ]);
  });

  it('rejects a missing Unreleased heading and malformed fragments', () => {
    expect(changelogProblems('# Changelog\n\n## 1.0.0 - 2026-01-01\n', [])).toEqual([
      expect.stringContaining('has no "## Unreleased" heading'),
    ]);
    const problems = changelogProblems(EMPTY, [
      { name: 'empty.md', text: '\n' },
      { name: 'prose.md', text: 'Not a bullet.\n' },
      { name: 'heading.md', text: '- Entry.\n\n### Details\n' },
      { name: 'notes.txt', text: '- Entry.\n' },
    ]);
    expect(problems).toEqual([
      'changelog.d/empty.md is empty',
      'changelog.d/prose.md must start with a bullet ("- ...")',
      'changelog.d/heading.md must not contain headings',
      'changelog.d/notes.txt: a fragment is a .md file',
    ]);
  });

  it('assembles fragments in file-name order under a new version section', () => {
    const released = assembleRelease(
      EMPTY,
      [
        { name: '10-b.md', text: '- Second.\n' },
        { name: '01-a.md', text: '- First.\n- Also first.\n' },
      ],
      '1.3.0',
      '2026-11-15',
    );
    expect(released).toBe(
      '# Changelog\n\n## Unreleased\n\n## 1.3.0 - 2026-11-15\n\n- First.\n- Also first.\n- Second.\n\n## 1.2.0 - 2026-11-01\n\n- Older entry.\n',
    );
    expect(changelogProblems(released, [])).toEqual([]);
  });

  it('refuses a release without fragments, a duplicate version or a bad date', () => {
    expect(() => assembleRelease(EMPTY, [], '1.3.0', '2026-11-15')).toThrow('no fragments');
    const one = [{ name: 'a.md', text: '- Entry.\n' }];
    expect(() => assembleRelease(EMPTY, one, '1.2.0', '2026-11-15')).toThrow('already has 1.2.0');
    expect(() => assembleRelease(EMPTY, one, '1.3', '2026-11-15')).toThrow('is not x.y.z');
    expect(() => assembleRelease(EMPTY, one, '1.3.0', '15.11.2026')).toThrow('is not YYYY-MM-DD');
  });
});
