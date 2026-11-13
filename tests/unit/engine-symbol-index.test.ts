import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import {
  engineSymbolIndex,
  engineSymbolIndexSync,
} from '../../src/hoi4_agent_tools/core/engine-index.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';

/**
 * The shared index from the engine's per-file records (ADR 0085) against `SymbolIndex.build`:
 * every record, reference, diagnostic and coverage field must be the same. The parity script
 * (`scripts/symbol-index-parity.ts`) runs the same comparison on real workspaces.
 */

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hoi4-engine-index-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function scanned(
  relativePath: string,
  content: string | Buffer,
  rootKind: ScannedFile['rootKind'] = 'mod',
  loadOrder = 10,
  shadowedBy?: string,
): ScannedFile {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return {
    absolutePath: path.join(root, rootKind, relativePath),
    displayPath: `${rootKind}:${relativePath}`,
    relativePath,
    rootKind,
    loadOrder,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
    ...(shadowedBy === undefined ? {} : { shadowedBy }),
  };
}

function snapshot(index: SymbolIndex) {
  return JSON.parse(
    canonicalJson({
      symbols: index.symbols,
      references: index.references,
      diagnostics: index.diagnostics,
      skippedSources: index.skippedSources,
      complete: index.complete,
      skippedSourceCount: index.skippedSourceCount,
      skippedPossibleSymbolKinds: index.skippedPossibleSymbolKinds,
      files: [...index.files.keys()],
    }),
  ) as unknown;
}

const BOM = '\uFEFF';
const files = (): ScannedFile[] => [
  scanned(
    'common/national_focus/tree.txt',
    'focus_tree = {\r\n\tid = tree\r\n\tfocus = { id = a x = 1 y = -2 icon = GFX_a prerequisite = { focus = b } relative_position_id = b }\r\n\tfocus = { id = b x = 007 }\r\n}\r\nshared_focus = { id = s }\r\n',
  ),
  scanned(
    'common/technologies/infantry.txt',
    'technologies = {\n\tinfantry_weapons = {\n\t\tstart_year = 1918\n\t\tresearch_cost = 1.5\n\t\tpath = { leads_to_tech = infantry_weapons1 }\n\t\txor = { a b }\n\t\tfolder = { name = infantry_folder }\n\t\tcategories = { infantry_weapons }\n\t\tenable_equipments = { infantry_equipment_0 }\n\t\tenable_building = { building = arms_factory }\n\t\tdoctrine = yes\n\t}\n\t@cost = 2\n}\n',
  ),
  scanned(
    'events/ünïcode.txt',
    'add_namespace = u\ncountry_event = {\n\tid = u.1 # «ä»\n\ttitle = "Ünïcode 𝄞 title"\n}\nnews_event = { id = u.2 }\n',
  ),
  scanned(
    'common/decisions/form.txt',
    'formable_nations = { icon = x take = { } }\ncat = { form_x = { } plain = { } }\n',
  ),
  scanned('common/ideas/ideas.txt', 'ideas = { country = { idea_a = { } } }\n'),
  scanned(
    'common/characters/c.txt',
    'characters = { GER_a = { advisor = { idea_token = GER_a_advisor slot = political_advisor } } }\n',
  ),
  scanned('common/script_constants/c.txt', 'a = 1\ngroup = { b = "two" schema = { c = 3 } }\n'),
  scanned(
    'interface/a.gfx',
    'spriteTypes = { SpriteType = { NAME = GFX_a TextureFile = "gfx/a.dds" noOfFrames = 3 } }\n',
  ),
  scanned(
    'interface/a.gui',
    'guiTypes = { containerWindowType = { name = w iconType = { name = i spriteType = GFX_a } } }\n',
  ),
  scanned(
    'common/scripted_guis/g.txt',
    'scripted_gui = { g = { context_type = player_context window_name = w } }\n',
  ),
  scanned('history/states/1-A.txt', 'state = { id = 1 name = STATE_1 provinces = { 1 2 3 } }\n'),
  scanned(
    'map/strategicregions/1.txt',
    'strategic_region = { id = 1 name = R provinces = { 1 2 } }\n',
  ),
  scanned(
    'map/definition.csv',
    '0;0;0;0;land;false;unknown;0\n1;10;20;30;land;true;plains;1\n2;1;2;3;sea\n',
  ),
  scanned('map/adjacencies.csv', 'From;To;Type;Through\n1;2;sea;3\n1;3;impassable\n'),
  scanned('map/supply_nodes.txt', '1 2\n3 x\n'),
  scanned('map/railways.txt', '1 2 3\n'),
  scanned(
    'localisation/english/a_l_english.yml',
    `${BOM}l_english:\n k:0 "Value \\"q\\" \\n"\n k2: "say "hi" now" # inner quotes\n bad line\n`,
  ),
  scanned('localisation/english/b_l_english.yml', 'l_english:\n k3:0 "no bom"\n'),
  scanned(
    'common/ideas/broken.txt',
    'ideas = { country = { broken = { a = } }\n}\n} = x != y\n"unterminated\n',
  ),
  scanned('common/ideas/escape.txt', 'ideas = { country = { e = { name = "a\\tb" } } }\n'),
  scanned('common/scripted_effects/dup.txt', 'dup_effect = { }\ndup_effect = { }\n'),
  scanned('common/scripted_effects/game.txt', 'game_effect = { } broken = {', 'game', 0),
  scanned(
    'common/scripted_effects/shadowed.txt',
    'shadowed_effect = { } bad = {',
    'game',
    0,
    'mod:common/scripted_effects/shadowed.txt',
  ),
  scanned('common/scripted_effects/shadowed.txt', 'shadowed_effect = { }\n'),
  scanned('gfx/a.dds', Buffer.from([0x44, 0x44, 0x53, 0x20])),
  scanned('common/windows.txt', Buffer.from([0x61, 0x20, 0x3d, 0x20, 0x81, 0xe9, 0x0a])),
];

describe('shared symbol index on the engine', () => {
  it('builds the same index as SymbolIndex.build from files kept in memory', () => {
    const input = files();
    expect(snapshot(engineSymbolIndexSync(input))).toEqual(snapshot(SymbolIndex.build(input)));
  });

  it('reads files from disk by path and resends the ones whose bytes changed', async () => {
    const input = files();
    // Half of the files exist on disk with the scanned bytes, one with different bytes.
    for (const file of input.slice(0, 12)) {
      await mkdir(path.dirname(file.absolutePath), { recursive: true });
      await writeFile(file.absolutePath, file.bytes);
    }
    await writeFile(input[0]!.absolutePath, 'focus_tree = { id = edited_on_disk }\n');
    const expected = snapshot(SymbolIndex.build(input));
    expect(snapshot(engineSymbolIndexSync(input))).toEqual(expected);
    expect(snapshot(await engineSymbolIndex(input))).toEqual(expected);
  });

  it('keeps references, diagnostics and locations in the engine index', () => {
    const index = engineSymbolIndexSync(files());
    expect(index.find('focus', 'a')?.metadata).toEqual({ x: 1, y: -2 });
    expect(index.find('localisation', 'l_english:k')?.metadata.value).toBe('Value "q" \n');
    expect(
      index.references.some(({ kind, to }) => kind === 'focus_prerequisite' && to === 'b'),
    ).toBe(true);
    expect(index.diagnostics.map(({ code }) => code)).toContain('INDEX_SYMBOL_COLLISION');
    expect(index.find('event', 'u.1')?.location?.start).toEqual({ line: 2, column: 1, offset: 18 });
  });
});
