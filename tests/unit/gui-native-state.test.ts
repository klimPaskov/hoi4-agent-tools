import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { buildGuiScene } from '../../src/hoi4_agent_tools/gui/layout.js';
import { buildGuiSourceGraph } from '../../src/hoi4_agent_tools/gui/source-graph.js';
import { parsePreviewScenario } from '../../src/hoi4_agent_tools/gui/scenario.js';
import { scenarioNeedsCountryHistory } from '../../src/hoi4_agent_tools/gui/native-state.js';

function scanned(displayPath: string, content: string | Buffer): ScannedFile {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  return {
    displayPath,
    absolutePath: `/synthetic/${displayPath}`,
    relativePath: displayPath,
    rootKind: 'fixture',
    loadOrder: 0,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

// A synthetic stand-in with the same element names as the engine-controlled political window.
const layout = `guiTypes = { containerWindowType = { name = "countrypoliticsview" size = { width = 300 height = 200 }
  iconType = { name = "pol_faction_icon" spriteType = "GFX_strip" position = { x = 0 y = 0 } frame = 1 }
  containerWindowType = { name = "faction" position = { x = 0 y = 60 } size = { width = 200 height = 20 }
    containerWindowType = { name = "no_faction" size = { width = 100%% height = 100%% }
      iconType = { name = "create_faction_icon" spriteType = "GFX_dot" position = { x = 0 y = 0 } } }
    containerWindowType = { name = "original_in_faction" size = { width = 100%% height = 100%% }
      iconType = { name = "dismantle_icon" spriteType = "GFX_dot" position = { x = 0 y = 0 } } }
    containerWindowType = { name = "in_faction" size = { width = 100%% height = 100%% }
      iconType = { name = "faction_icon" spriteType = "GFX_dot" position = { x = 0 y = 0 } } }
  }
  containerWindowType = { name = "power_balance_button" position = { x = 0 y = 100 } size = { width = 50 height = 20 }
    iconType = { name = "power_balance_icon" spriteType = "GFX_dot" position = { x = 0 y = 0 } } }
  iconType = { name = "shown_by_show" spriteType = "GFX_dot" position = { x = 100 y = 0 } show = yes }
  iconType = { name = "hidden_by_show" spriteType = "GFX_dot" position = { x = 120 y = 0 } show = no }
  iconType = { name = "hidden_by_hide" spriteType = "GFX_dot" position = { x = 140 y = 0 } hide = yes }
  iconType = { name = "dynamic" spriteType = "GFX_dot" position = { x = 160 y = 0 } }
} }`;

async function fixture(history: Record<string, string>) {
  const strip = await sharp({
    create: { width: 40, height: 10, channels: 4, background: '#808080' },
  })
    .png()
    .toBuffer();
  const dot = await sharp({
    create: { width: 8, height: 8, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  return [
    scanned('interface/countrypoliticsview.gui', layout),
    scanned(
      'interface/countrypoliticsview.gfx',
      `spriteTypes = {
        spriteType = { name = "GFX_strip" texturefile = "gfx/strip.png" noOfFrames = 4 }
        spriteType = { name = "GFX_dot" texturefile = "gfx/dot.png" }
      }`,
    ),
    scanned('gfx/strip.png', strip),
    scanned('gfx/dot.png', dot),
    ...Object.entries(history).map(([name, text]) => scanned(`history/countries/${name}`, text)),
  ];
}

const history = {
  'FRA - France.txt': 'capital = 16\nset_politics = { ruling_party = democratic }\n',
  'GER - Germany.txt':
    'capital = 64\nset_politics = { ruling_party = fascism }\ncreate_faction_from_template = faction_template_axis\nadd_to_faction = GER\nadd_to_faction = ITA\n',
  'ITA - Italy.txt':
    'set_politics = { ruling_party = fascism }\nset_power_balance = { id = ITA_power_balance }\n',
  'SOV - Soviet union.txt':
    'set_politics = { ruling_party = neutrality }\n1938.1.1 = { set_politics = { ruling_party = communism } }\n1940.1.1 = { set_politics = { ruling_party = democratic } }\n',
  'ENG - Britain.txt': '#add_to_faction = FRA\nset_politics = { ruling_party = democratic }\n',
};

async function sceneFor(
  files: ScannedFile[],
  scenario: Record<string, unknown>,
  windowName = 'countrypoliticsview',
) {
  return buildGuiScene(
    buildGuiSourceGraph(files, SymbolIndex.build(files)),
    files,
    windowName,
    parsePreviewScenario({ id: 'native', resolution: { width: 400, height: 300 }, ...scenario }),
  );
}

type Scene = Awaited<ReturnType<typeof sceneFor>>;
const named = (scene: Scene, name: string) =>
  scene.elements.find((element) => element.name === name)!;
const frameOf = (scene: Scene) => named(scene, 'pol_faction_icon').sprite!.frame;

describe('engine-controlled GUI state', () => {
  it('shows only the branches the game shows for a country in no faction, with its ideology frame', async () => {
    const scene = await sceneFor(await fixture(history), { country: { tag: 'FRA' } });
    expect(named(scene, 'no_faction').visible).toBe(true);
    expect(named(scene, 'create_faction_icon').visible).toBe(true);
    for (const hidden of [
      'original_in_faction',
      'dismantle_icon',
      'in_faction',
      'faction_icon',
      'power_balance_button',
      'power_balance_icon',
    ])
      expect(named(scene, hidden).visible, hidden).toBe(false);
    // The static .gui frame is the fascist eagle; the democratic torch is the third frame.
    expect(frameOf(scene)).toBe(2);
    expect(scene.fidelity.modelled.some(({ field }) => field === 'native_window_state')).toBe(true);
  });

  it('selects the leader, member and balance-of-power branches from country history', async () => {
    const files = await fixture(history);
    const leader = await sceneFor(files, { country: { tag: 'GER' } });
    expect(named(leader, 'original_in_faction').visible).toBe(true);
    expect(named(leader, 'in_faction').visible).toBe(false);
    expect(named(leader, 'no_faction').visible).toBe(false);
    expect(frameOf(leader)).toBe(0);
    const member = await sceneFor(files, { country: { tag: 'ITA' } });
    expect(named(member, 'in_faction').visible).toBe(true);
    expect(named(member, 'faction_icon').visible).toBe(true);
    expect(named(member, 'original_in_faction').visible).toBe(false);
    expect(named(member, 'power_balance_button').visible).toBe(true);
    expect(named(member, 'power_balance_icon').visible).toBe(true);
  });

  it('ignores dated history that has not happened at the scenario date', async () => {
    const files = await fixture(history);
    expect(frameOf(await sceneFor(files, { country: { tag: 'SOV' }, date: '1936.1.1' }))).toBe(3);
    expect(frameOf(await sceneFor(files, { country: { tag: 'SOV' }, date: '1939.1.1' }))).toBe(1);
    expect(frameOf(await sceneFor(files, { country: { tag: 'SOV' }, date: '1941.1.1' }))).toBe(2);
  });

  it('lets explicit country facts and scenario values override history', async () => {
    const files = await fixture(history);
    const explicit = await sceneFor(files, {
      country: { tag: 'FRA', faction: 'member', balanceOfPower: true, ideology: 'communism' },
    });
    expect(named(explicit, 'in_faction').visible).toBe(true);
    expect(named(explicit, 'no_faction').visible).toBe(false);
    expect(named(explicit, 'power_balance_button').visible).toBe(true);
    expect(frameOf(explicit)).toBe(1);
    const forced = await sceneFor(files, {
      country: { tag: 'FRA' },
      visibility: { no_faction: false, original_in_faction: true },
      values: { 'pol_faction_icon.frame': 4 },
    });
    expect(named(forced, 'no_faction').visible).toBe(false);
    expect(named(forced, 'original_in_faction').visible).toBe(true);
    expect(frameOf(forced)).toBe(3);
    const selected = await sceneFor(files, {
      country: { tag: 'FRA' },
      selectedFrames: { pol_faction_icon: 0 },
    });
    expect(frameOf(selected)).toBe(0);
  });

  it('does not draw every branch when the scenario names no country', async () => {
    const scene = await sceneFor(await fixture(history), {});
    expect(named(scene, 'no_faction').visible).toBe(true);
    for (const hidden of ['original_in_faction', 'in_faction', 'power_balance_button'])
      expect(named(scene, hidden).visible, hidden).toBe(false);
    expect(scene.fidelity.approximated.some(({ field }) => field === 'native_window_state')).toBe(
      true,
    );
  });

  it('asks for country history only when the scenario leaves a fact open', () => {
    expect(scenarioNeedsCountryHistory(parsePreviewScenario({ id: 'a' }))).toBe(false);
    expect(
      scenarioNeedsCountryHistory(parsePreviewScenario({ id: 'b', country: { tag: 'FRA' } })),
    ).toBe(true);
    expect(
      scenarioNeedsCountryHistory(
        parsePreviewScenario({
          id: 'c',
          country: { tag: 'FRA', faction: 'none', balanceOfPower: false, ideology: 'democratic' },
        }),
      ),
    ).toBe(false);
  });
});

describe('source visibility semantics', () => {
  it('honours show, hide and word or number visibility values', async () => {
    const files = await fixture(history);
    const scene = await sceneFor(files, {
      values: { 'dynamic.visible': 'no' },
      country: { tag: 'FRA' },
    });
    expect(named(scene, 'shown_by_show').visible).toBe(true);
    expect(named(scene, 'hidden_by_show').visible).toBe(false);
    expect(named(scene, 'hidden_by_hide').visible).toBe(false);
    expect(named(scene, 'dynamic').visible).toBe(false);
    for (const [value, expected] of [
      [0, false],
      [1, true],
      ['false', false],
      ['yes', true],
      ['hidden', false],
    ] as const) {
      const other = await sceneFor(files, {
        values: { 'dynamic.visible': value, 'hidden_by_show.visible': 'true' },
        country: { tag: 'FRA' },
      });
      expect(named(other, 'dynamic').visible, String(value)).toBe(expected);
      expect(named(other, 'hidden_by_show').visible).toBe(true);
    }
  });
});
