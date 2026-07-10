import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import {
  INDEX_SKIPPED_SOURCE_SAMPLE_LIMIT,
  SymbolIndex,
} from '../../src/hoi4_agent_tools/core/index.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import {
  SOURCE_LINE_LIMIT,
  SOURCE_MAX_BYTES,
  SOURCE_TOKEN_LIMIT,
} from '../../src/hoi4_agent_tools/core/source/index.js';

function scannedFile(
  relativePath: string,
  content: string | Buffer,
  options: { shadowedBy?: string } = {},
): ScannedFile {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  return {
    absolutePath: path.join('C:\\fixture', relativePath),
    displayPath: `mod:${relativePath}`,
    relativePath,
    rootKind: 'mod',
    loadOrder: 0,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
    ...options,
  };
}

const partialSprite =
  'spriteTypes = { spriteType = { name = GFX_partial texturefile = "gfx/interface/partial.png" } }\n';

function sizeLimitedSource(): Buffer {
  const bytes = Buffer.alloc(SOURCE_MAX_BYTES + 1, 0x61);
  bytes.write(partialSprite, 0, 'utf8');
  return bytes;
}

function lineLimitedSource(): Buffer {
  return Buffer.from(`${partialSprite}${'\n'.repeat(SOURCE_LINE_LIMIT)}`);
}

function tokenLimitedSource(): Buffer {
  return Buffer.from(
    `${partialSprite}${'value = yes '.repeat(Math.ceil(SOURCE_TOKEN_LIMIT / 3) + 1)}`,
  );
}

describe('partial shared-index inventories', () => {
  it.each([
    ['SOURCE_FILE_SIZE_LIMIT', sizeLimitedSource],
    ['SOURCE_LINE_LIMIT', lineLimitedSource],
    ['SOURCE_TOKEN_LIMIT', tokenLimitedSource],
  ])('skips the entire document after %s instead of walking its partial tree', (code, source) => {
    const index = SymbolIndex.build([
      scannedFile('interface/partial.gfx', source()),
      scannedFile(
        'interface/valid.gfx',
        'spriteTypes = { spriteType = { name = GFX_valid texturefile = "gfx/interface/valid.png" } }\n',
      ),
    ]);

    expect(index.complete).toBe(false);
    expect(index.skippedSourceCount).toBe(1);
    expect(index.skippedSources).toEqual([
      expect.objectContaining({
        path: 'mod:interface/partial.gfx',
        reasonCodes: [code],
        possibleSymbolKinds: expect.arrayContaining(['sprite']),
      }),
    ]);
    expect(index.find('sprite', 'GFX_partial')).toBeUndefined();
    expect(index.find('sprite', 'GFX_valid')).toBeDefined();
    expect(index.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INDEX_SOURCE_SKIPPED_LIMIT', severity: 'warning' }),
      ]),
    );
    expect(index.diagnostics.some((diagnostic) => diagnostic.code === code)).toBe(false);
  });

  it('downgrades only unresolved kinds that a skipped source could define', () => {
    const focus = scannedFile(
      'common/national_focus/partial-reference.txt',
      'focus_tree = { id = partial_tree focus = { id = partial_focus icon = GFX_from_skipped } }\n',
    );
    const skippedGfx = scannedFile('interface/partial.gfx', tokenLimitedSource());
    const skippedLocalisation = scannedFile(
      'localisation/english/partial_l_english.yml',
      Buffer.from(`\uFEFFl_english:\n${'\n'.repeat(SOURCE_LINE_LIMIT)}`),
    );
    const skippedUnrelatedText = scannedFile('common/misc/partial.txt', tokenLimitedSource());

    const attributable = SymbolIndex.build([focus, skippedGfx]);
    expect(attributable.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INDEX_UNRESOLVED_REFERENCE_PARTIAL',
          severity: 'warning',
        }),
      ]),
    );
    expect(attributable.diagnostics.some(({ code }) => code === 'INDEX_UNRESOLVED_REFERENCE')).toBe(
      false,
    );

    const unrelated = SymbolIndex.build([focus, skippedLocalisation]);
    expect(unrelated.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INDEX_UNRESOLVED_REFERENCE', severity: 'error' }),
      ]),
    );

    const unrelatedText = SymbolIndex.build([focus, skippedUnrelatedText]);
    expect(unrelatedText.skippedSources[0]?.possibleSymbolKinds).toEqual([]);
    expect(unrelatedText.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INDEX_UNRESOLVED_REFERENCE', severity: 'error' }),
      ]),
    );
  });

  it('does not fall back to definition.csv when the active default.map is skipped', () => {
    const activeDefault = scannedFile(
      'map/default.map',
      Buffer.from(
        `definitions = "custom.csv"\n${'value = yes '.repeat(Math.ceil(SOURCE_TOKEN_LIMIT / 3) + 1)}`,
      ),
    );
    const lowerDefinition = {
      ...scannedFile('map/definition.csv', '1;10;20;30;land;false;plains;1\n'),
      absolutePath: path.join('C:\\game', 'map/definition.csv'),
      displayPath: 'game:map/definition.csv',
      rootKind: 'game' as const,
      loadOrder: -1,
    };
    const lowerDefault = {
      ...scannedFile('map/default.map', 'definitions = "definition.csv"\n'),
      absolutePath: path.join('C:\\game', 'map/default.map'),
      displayPath: 'game:map/default.map',
      rootKind: 'game' as const,
      loadOrder: -1,
      shadowedBy: activeDefault.displayPath,
    };

    const index = SymbolIndex.build([lowerDefault, lowerDefinition, activeDefault]);

    expect(index.complete).toBe(false);
    expect(index.skippedSources).toEqual([
      expect.objectContaining({ path: activeDefault.displayPath }),
    ]);
    expect(index.find('province', '1')).toBeUndefined();
  });

  it('bounds skipped-source samples and warnings while retaining the total', () => {
    const sharedLimitedBytes = lineLimitedSource();
    const files = Array.from({ length: INDEX_SKIPPED_SOURCE_SAMPLE_LIMIT + 1 }, (_, index) =>
      scannedFile(`interface/partial-${index}.gfx`, sharedLimitedBytes),
    );
    const index = SymbolIndex.build(files);

    expect(index.skippedSourceCount).toBe(INDEX_SKIPPED_SOURCE_SAMPLE_LIMIT + 1);
    expect(index.skippedSources).toHaveLength(INDEX_SKIPPED_SOURCE_SAMPLE_LIMIT);
    expect(
      index.diagnostics.filter(({ code }) => code === 'INDEX_SOURCE_SKIPPED_LIMIT'),
    ).toHaveLength(INDEX_SKIPPED_SOURCE_SAMPLE_LIMIT);
    expect(index.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INDEX_SKIPPED_SOURCE_LIST_TRUNCATED' }),
      ]),
    );
  });

  it('retains aggregate attribution for skipped sources beyond the bounded sample', () => {
    const sharedLimitedBytes = sizeLimitedSource();
    const unrelated = Array.from({ length: INDEX_SKIPPED_SOURCE_SAMPLE_LIMIT }, (_, index) =>
      scannedFile(`common/misc/partial-${index}.txt`, sharedLimitedBytes),
    );
    const skippedGfx = scannedFile('interface/partial.gfx', sharedLimitedBytes);
    const focus = scannedFile(
      'common/national_focus/reference.txt',
      'focus_tree = { id = partial_tree focus = { id = partial_focus icon = GFX_from_skipped } }\n',
    );
    const index = SymbolIndex.build([...unrelated, skippedGfx, focus]);

    expect(index.skippedSources.some(({ path }) => path === skippedGfx.displayPath)).toBe(false);
    expect(index.isSourceSkipped(skippedGfx.displayPath)).toBe(true);
    expect(index.hasSkippedSourceForKind('sprite')).toBe(true);
    expect(index.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INDEX_UNRESOLVED_REFERENCE_PARTIAL',
          severity: 'warning',
        }),
      ]),
    );
  });

  it('does not make the active inventory partial for a shadowed over-limit source', () => {
    const activePath = 'mod:interface/same.gfx';
    const index = SymbolIndex.build([
      scannedFile('interface/same.gfx', tokenLimitedSource(), { shadowedBy: activePath }),
      scannedFile(
        'interface/same.gfx',
        'spriteTypes = { spriteType = { name = GFX_active texturefile = "gfx/interface/active.png" } }\n',
      ),
    ]);

    expect(index.complete).toBe(true);
    expect(index.skippedSourceCount).toBe(0);
    expect(index.find('sprite', 'GFX_active')).toBeDefined();
  });
});
