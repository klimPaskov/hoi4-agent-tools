import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  engineSymbolIndex,
  engineSymbolIndexSync,
} from '../../src/hoi4_agent_tools/core/engine-index.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import {
  sharedResidentEngine,
  type ResidentEngine,
} from '../../src/hoi4_agent_tools/core/resident-engine.js';
import { symbolIndexFixture, symbolIndexSnapshot } from '../helpers/symbol-index-fixture.js';

/**
 * The shared index from the engine (ADR 0085) against what the retired TypeScript builder made of
 * the same synthetic sources (`tests/fixtures/symbol-index/expected.json`, written by
 * `SymbolIndex.build` before it moved to the engine): every record, reference, diagnostic and
 * coverage field must be the same. The parity script of ADR 0085 compared the two on the
 * installed game and the benchmark mods.
 */

const expectedPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'symbol-index',
  'expected.json',
);

let root: string;
let expected: unknown;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hoi4-engine-index-'));
  expected = JSON.parse(await readFile(expectedPath, 'utf8')) as unknown;
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('shared symbol index on the engine', () => {
  it('builds what the TypeScript builder built from files kept in memory', () => {
    expect(symbolIndexSnapshot(engineSymbolIndexSync(symbolIndexFixture(root)))).toEqual(expected);
    expect(symbolIndexSnapshot(SymbolIndex.build(symbolIndexFixture(root)))).toEqual(expected);
  });

  it('reads files from disk by path and resends the ones whose bytes changed', async () => {
    const input = symbolIndexFixture(root);
    // Half of the files exist on disk with the scanned bytes, one with different bytes.
    for (const file of input.slice(0, 12)) {
      await mkdir(path.dirname(file.absolutePath), { recursive: true });
      await writeFile(file.absolutePath, file.bytes);
    }
    await writeFile(input[0]!.absolutePath, 'focus_tree = { id = edited_on_disk }\n');
    expect(symbolIndexSnapshot(engineSymbolIndexSync(input))).toEqual(expected);
    expect(symbolIndexSnapshot(await engineSymbolIndex(input))).toEqual(expected);
    expect(symbolIndexSnapshot(await SymbolIndex.buildAsync(input))).toEqual(expected);
  });

  it('keeps references, diagnostics and locations in the engine index', () => {
    const index = engineSymbolIndexSync(symbolIndexFixture(root));
    expect(index.find('focus', 'a')?.metadata).toEqual({ x: 1, y: -2 });
    expect(index.find('localisation', 'l_english:k')?.metadata.value).toBe('Value "q" \n');
    expect(
      index.references.some(({ kind, to }) => kind === 'focus_prerequisite' && to === 'b'),
    ).toBe(true);
    expect(index.diagnostics.map(({ code }) => code)).toContain('INDEX_SYMBOL_COLLISION');
    expect(index.find('event', 'u.1')?.location?.start).toEqual({ line: 2, column: 1, offset: 18 });
  });

  it('answers ENGINE_UNAVAILABLE without an engine instead of indexing in TypeScript', () => {
    const configured = process.env.HOI4_ENGINE;
    process.env.HOI4_ENGINE = path.join(root, 'missing-engine.exe');
    try {
      expect(() => SymbolIndex.build(symbolIndexFixture(root))).toThrowError(
        expect.objectContaining({ code: 'ENGINE_UNAVAILABLE' }),
      );
    } finally {
      if (configured === undefined) Reflect.deleteProperty(process.env, 'HOI4_ENGINE');
      else process.env.HOI4_ENGINE = configured;
    }
  });
});

describe('engine answers kept between builds (issue 137)', () => {
  /** The shared resident engine, counting the files each index request asks about. */
  function countingEngine() {
    const shared = sharedResidentEngine();
    const asked: string[][] = [];
    const engine = {
      request: (...args: Parameters<ResidentEngine['request']>) => {
        const body = args[1] as { files?: Array<{ displayPath: string }> };
        asked.push((body.files ?? []).map(({ displayPath }) => displayPath));
        return shared.request(...args);
      },
    } as unknown as ResidentEngine;
    return { engine, asked };
  }

  it('asks the engine only about files whose bytes are new, with the same result', async () => {
    const input = symbolIndexFixture(path.join(root, 'kept'));
    const { engine, asked } = countingEngine();
    expect(symbolIndexSnapshot(await engineSymbolIndex(input, undefined, engine))).toEqual(
      expected,
    );
    const firstAsked = asked.flat().length;
    expect(firstAsked).toBeGreaterThan(1);

    // The same scanned bytes again: nothing goes to the engine.
    asked.length = 0;
    const again = input.map((file) => ({ ...file }));
    expect(symbolIndexSnapshot(await engineSymbolIndex(again, undefined, engine))).toEqual(
      expected,
    );
    expect(asked.flat()).toEqual([]);

    // One file read again into new bytes (a mod file is read on every scan): only it is asked.
    asked.length = 0;
    const reread = input.map((file, position) =>
      position === 0 ? { ...file, bytes: Buffer.from(file.bytes) } : file,
    );
    expect(symbolIndexSnapshot(await engineSymbolIndex(reread, undefined, engine))).toEqual(
      expected,
    );
    // A file the engine cannot read from disk is asked for again with its bytes inline.
    expect([...new Set(asked.flat())]).toEqual([input[0]!.displayPath]);
  });

  it('asks again when a file now shadows or is shadowed, so its flags change', async () => {
    const input = symbolIndexFixture(path.join(root, 'flags'));
    const { engine, asked } = countingEngine();
    await engineSymbolIndex(input, undefined, engine);
    asked.length = 0;
    const shadowed = input.map((file, position) =>
      position === 0 ? { ...file, shadowedBy: 'mod:elsewhere.txt' } : file,
    );
    const rebuilt = await engineSymbolIndex(shadowed, undefined, engine);
    // A file the engine cannot read from disk is asked for again with its bytes inline.
    expect([...new Set(asked.flat())]).toEqual([input[0]!.displayPath]);
    // The same as a build that kept nothing.
    expect(symbolIndexSnapshot(rebuilt)).toEqual(
      symbolIndexSnapshot(
        engineSymbolIndexSync(
          shadowed.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) })),
        ),
      ),
    );
  });
});
