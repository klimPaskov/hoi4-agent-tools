import path from 'node:path';
import { canonicalJson, sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';

/**
 * Synthetic sources for the shared symbol index (ADR 0085): every definition family, localisation
 * with and without a byte order mark, map tables, malformed syntax, non-ASCII text and CR LF,
 * Windows-1252 bytes, game and shadowed files. `tests/fixtures/symbol-index/expected.json` holds
 * what the retired TypeScript builder made of them.
 */

function scanned(
  root: string,
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

/** Everything a symbol index answers, as plain JSON. */
export function symbolIndexSnapshot(index: SymbolIndex): unknown {
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

const BOM = '﻿';

/** The fixture's files, with absolute paths under `root` (which need not exist). */
export function symbolIndexFixture(root: string): ScannedFile[] {
  const file = (
    ...args: Parameters<typeof scanned> extends [string, ...infer Rest] ? Rest : never
  ) => scanned(root, ...args);
  return [
    file(
      'common/national_focus/tree.txt',
      'focus_tree = {\r\n\tid = tree\r\n\tfocus = { id = a x = 1 y = -2 icon = GFX_a prerequisite = { focus = b } relative_position_id = b }\r\n\tfocus = { id = b x = 007 }\r\n}\r\nshared_focus = { id = s }\r\n',
    ),
    file(
      'common/technologies/infantry.txt',
      'technologies = {\n\tinfantry_weapons = {\n\t\tstart_year = 1918\n\t\tresearch_cost = 1.5\n\t\tpath = { leads_to_tech = infantry_weapons1 }\n\t\txor = { a b }\n\t\tfolder = { name = infantry_folder }\n\t\tcategories = { infantry_weapons }\n\t\tenable_equipments = { infantry_equipment_0 }\n\t\tenable_building = { building = arms_factory }\n\t\tdoctrine = yes\n\t}\n\t@cost = 2\n}\n',
    ),
    file(
      'events/ünïcode.txt',
      'add_namespace = u\ncountry_event = {\n\tid = u.1 # «ä»\n\ttitle = "Ünïcode 𝄞 title"\n}\nnews_event = { id = u.2 }\n',
    ),
    file(
      'common/decisions/form.txt',
      'formable_nations = { icon = x take = { } }\ncat = { form_x = { } plain = { } }\n',
    ),
    file('common/ideas/ideas.txt', 'ideas = { country = { idea_a = { } } }\n'),
    file(
      'common/characters/c.txt',
      'characters = { GER_a = { advisor = { idea_token = GER_a_advisor slot = political_advisor } } }\n',
    ),
    file('common/script_constants/c.txt', 'a = 1\ngroup = { b = "two" schema = { c = 3 } }\n'),
    file(
      'interface/a.gfx',
      'spriteTypes = { SpriteType = { NAME = GFX_a TextureFile = "gfx/a.dds" noOfFrames = 3 } }\n',
    ),
    file(
      'interface/a.gui',
      'guiTypes = { containerWindowType = { name = w iconType = { name = i spriteType = GFX_a } } }\n',
    ),
    file(
      'common/scripted_guis/g.txt',
      'scripted_gui = { g = { context_type = player_context window_name = w } }\n',
    ),
    file('history/states/1-A.txt', 'state = { id = 1 name = STATE_1 provinces = { 1 2 3 } }\n'),
    file(
      'map/strategicregions/1.txt',
      'strategic_region = { id = 1 name = R provinces = { 1 2 } }\n',
    ),
    file(
      'map/definition.csv',
      '0;0;0;0;land;false;unknown;0\n1;10;20;30;land;true;plains;1\n2;1;2;3;sea\n',
    ),
    file('map/adjacencies.csv', 'From;To;Type;Through\n1;2;sea;3\n1;3;impassable\n'),
    file('map/supply_nodes.txt', '1 2\n3 x\n'),
    file('map/railways.txt', '1 2 3\n'),
    file(
      'localisation/english/a_l_english.yml',
      `${BOM}l_english:\n k:0 "Value \\"q\\" \\n"\n k2: "say "hi" now" # inner quotes\n bad line\n`,
    ),
    file('localisation/english/b_l_english.yml', 'l_english:\n k3:0 "no bom"\n'),
    file(
      'common/ideas/broken.txt',
      'ideas = { country = { broken = { a = } }\n}\n} = x != y\n"unterminated\n',
    ),
    file('common/ideas/escape.txt', 'ideas = { country = { e = { name = "a\\tb" } } }\n'),
    file('common/scripted_effects/dup.txt', 'dup_effect = { }\ndup_effect = { }\n'),
    file('common/scripted_effects/game.txt', 'game_effect = { } broken = {', 'game', 0),
    file(
      'common/scripted_effects/shadowed.txt',
      'shadowed_effect = { } bad = {',
      'game',
      0,
      'mod:common/scripted_effects/shadowed.txt',
    ),
    file('common/scripted_effects/shadowed.txt', 'shadowed_effect = { }\n'),
    file('gfx/a.dds', Buffer.from([0x44, 0x44, 0x53, 0x20])),
    file('common/windows.txt', Buffer.from([0x61, 0x20, 0x3d, 0x20, 0x81, 0xe9, 0x0a])),
  ];
}
