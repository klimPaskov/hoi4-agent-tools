import { describe, expect, it } from 'vitest';
import { parseDocumentedLists } from '../../src/hoi4_agent_tools/common-write/documented-lists.js';
import { capFindings, capList, cutText } from '../../src/hoi4_agent_tools/common-write/limits.js';
import { isPlainRelativePath } from '../../src/hoi4_agent_tools/common-write/paths.js';
import { commonWriteDataSchema } from '../../src/hoi4_agent_tools/schemas/common-write.js';

// The structure of the installed game's two documentation files, with synthetic names: a token
// list in `###` groups under one `##` heading, then further sections with bullets of their own.
const STRATEGY_DOC = [
  '# Examples and documentation of how to use the AI strategies',
  '',
  '## List of available strategy tokens',
  '(updated)',
  '',
  '### Related to diplomacy',
  '- `tst_alliance`',
  '- `tst_conquer`',
  '',
  '### Related to navies',
  '- `tst_naval_token`',
  '',
  '## UNIT RATIOS',
  '',
  '### AIR',
  '- `tst_ratio_not_a_token`',
  '',
  '## Examples of AI strategy usage',
  '- `tst_example_not_a_token`',
  '### `tst_conquer`',
];
const ON_ACTION_DOC = [
  '# List of possible on-actions',
  '### General',
  '- `on_tst_startup`',
  '- `on_tst_daily`',
  '- `on_tst_daily_TAG`',
  '- `on_tst_old`    - [deprecated] prefer another',
];

describe('common_write documented lists', () => {
  it('reads the token list from its own section only, and the on_action names from their file', () => {
    const lists = parseDocumentedLists(
      new Map([
        ['common/ai_strategy/_documentation.md', STRATEGY_DOC],
        ['common/on_actions/_documentation.md', ON_ACTION_DOC],
      ]),
    );
    expect(lists.tokens).toEqual(['tst_alliance', 'tst_conquer', 'tst_naval_token']);
    expect(lists.names).toEqual(['on_tst_daily', 'on_tst_old', 'on_tst_startup']);
  });

  it('gives nothing when the documentation is absent, so the engine does not guess', () => {
    expect(parseDocumentedLists(new Map())).toEqual({ tokens: undefined, names: undefined });
    const noList = parseDocumentedLists(
      new Map([['common/ai_strategy/_documentation.md', ['# Title', '- `tst_x`']]]),
    );
    expect(noList.tokens).toBeUndefined();
  });
});

describe('common_write new file paths', () => {
  it('accepts plain paths and refuses streams, devices and odd segments', () => {
    expect(isPlainRelativePath('common/bop/sub/com10.txt')).toBe(true);
    for (const bad of [
      'common/bop/a.txt:x.txt',
      'common/bop/CON.txt',
      'common/bop/nul.txt',
      'common/bop/com1.txt',
      'common/bop/lpt9.x.txt',
      'common/bop/a.txt.',
      'common/bop/a?.txt',
      'common/bop/sub /a.txt',
      'common/bop//a.txt',
      'common/bop/../a.txt',
      'common/bop/a\u0001.txt',
    ])
      expect(isPlainRelativePath(bad), bad).toBe(false);
  });
});

describe('common_write output caps', () => {
  it('cuts lists with a count and strings without splitting a surrogate pair', () => {
    const many = Array.from({ length: 150 }, (_, index) => `focus_${index}`);
    expect(capList(many, 100)).toMatchObject({ omitted: 50 });
    expect(capList(many, 100).kept).toHaveLength(100);
    const cut = cutText(`${'a'.repeat(9)}😀`, 10);
    expect(cut).toBe('a'.repeat(9));
    expect(cutText('short', 10)).toBe('short');
  });

  it('keeps a result with hundreds of undefined references inside the output schema', () => {
    const findings = capFindings(
      Array.from({ length: 80 }, (_, index) => ({
        severity: 'warning' as const,
        code: `C${index}`,
        message: 'm'.repeat(2000),
      })),
    );
    const names = Array.from({ length: 300 }, (_, index) => `n${index}${'x'.repeat(400)}`);
    const parsed = commonWriteDataSchema.parse({
      operation: 'add',
      kind: 'bop',
      id: 'tst',
      path: 'common/bop/t.txt',
      applied: false,
      diff: '',
      diffTruncated: false,
      untouchedDefinitions: 0,
      findings: findings.kept,
      missing: {
        localisation: capList(names, 50).kept,
        sprites: capList(names, 20).kept,
        categories: capList(names, 5).kept,
        focuses: capList(names, 100).kept,
      },
      omitted: {
        findings: findings.omitted,
        localisation: capList(names, 50).omitted,
        sprites: capList(names, 20).omitted,
        categories: capList(names, 5).omitted,
        focuses: capList(names, 100).omitted,
      },
    });
    expect(parsed.omitted).toMatchObject({ findings: 30, focuses: 200, localisation: 250 });
  });
});
