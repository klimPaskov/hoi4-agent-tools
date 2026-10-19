import { describe, expect, it } from 'vitest';
import { resolveGeography } from '../../src/hoi4_agent_tools/map/geography/index.js';
import { generateWorld } from '../../src/hoi4_agent_tools/map/world.js';
import type { GeographyModelInput } from '../../src/hoi4_agent_tools/schemas/geography.js';
import {
  adjacencyRows,
  landComponents,
  provinceMap,
  spearman,
} from '../helpers/gameplay-checks.js';
import {
  GAMEPLAY_HEIGHT,
  GAMEPLAY_WIDTH,
  gameplayGeography,
  gameplaySpec,
  gameplayWorld,
} from '../helpers/gameplay-fixture.js';
import { filesOf, plainContext } from '../helpers/map-appearance-world.js';

function variant(edit: (model: GeographyModelInput) => void, overrides = {}) {
  const model = gameplayGeography();
  edit(model);
  const geography = resolveGeography(model, {
    frame: { width: GAMEPLAY_WIDTH, height: GAMEPLAY_HEIGHT },
    hasReference: false,
  }).geography;
  return generateWorld(gameplaySpec({ geography, ...overrides }), plainContext);
}

function stateTexts(world: ReturnType<typeof gameplayWorld>): Map<number, string> {
  return new Map(
    [...filesOf(world)]
      .filter(([name]) => name.startsWith('history/states/'))
      .map(([, bytes]) => {
        const text = bytes.toString('utf8');
        return [Number(/id = (\d+)/u.exec(text)![1]), text] as const;
      }),
  );
}

function localisation(world: ReturnType<typeof gameplayWorld>): Map<string, string> {
  const text = filesOf(world).get('localisation/replace/world_l_english.yml')!.toString('utf8');
  return new Map(
    [...text.matchAll(/^ ([A-Za-z0-9_]+): "(.*)"$/gmu)].map((match) => [match[1]!, match[2]!]),
  );
}

describe('ports from the shape of the coast', () => {
  const world = gameplayWorld();
  const economy = world.gameplay!.economy!;
  const map = provinceMap(world);

  it('places a port on every port site, with a higher level than a score-only port', () => {
    const sited = [...economy.ports.ports.values()].filter(({ reason }) => reason === 'site');
    expect(sited.length).toBeGreaterThanOrEqual(2);
    for (const port of sited) expect(port.level).toBeGreaterThanOrEqual(3);
    const scoreOnly = [...economy.ports.ports.values()].filter(({ reason }) => reason === 'score');
    expect(scoreOnly.length).toBeGreaterThan(0);
    for (const port of scoreOnly) expect(port.level).toBeLessThan(4);
  });

  it('scores sheltered coast above an open headland', () => {
    const scores = [...economy.harbours.values()];
    const best = scores.reduce((a, b) => (b.score > a.score ? b : a));
    const worst = scores.reduce((a, b) => (b.score < a.score ? b : a));
    expect(best.score).toBeGreaterThan(worst.score + 0.2);
    // Shelter and concavity separate bays from points, and they feed the score.
    const bays = scores.filter(({ concavity }) => concavity > 0.6);
    const ordered = [...scores].sort((a, b) => a.concavity + a.shelter - b.concavity - b.shelter);
    const points = ordered.slice(0, Math.max(3, Math.floor(ordered.length / 4)));
    expect(bays.length).toBeGreaterThan(0);
    expect(points.length).toBeGreaterThan(0);
    const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;
    expect(mean(bays.map(({ score }) => score))).toBeGreaterThan(
      mean(points.map(({ score }) => score)),
    );
  });

  it('gives every coastal landmass of a country at least one port', () => {
    const land = landComponents(map, () => true);
    const portsByLandmass = new Set(
      [...economy.ports.ports.keys()].map((province) => land.get(province + 1)),
    );
    // Aenor, Cinder Isle and South Isle each have one.
    expect(portsByLandmass.size).toBeGreaterThanOrEqual(3);
    for (const province of economy.ports.ports.keys())
      expect(
        [...map.neighbors.get(province + 1)!].some((other) => map.typeOf.get(other) === 'sea'),
      ).toBe(true);
  });

  it('puts the lake port of an inland sea on that sea', () => {
    const rows = adjacencyRows(world);
    const canal = rows.find(({ rule }) => rule === 'GREAT_LAKE_CANAL')!;
    // Sea provinces reachable from the canal's inland end without using the canal.
    const reach = new Set<number>([canal.from]);
    const stack = [canal.from];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const other of map.neighbors.get(current) ?? [])
        if (map.typeOf.get(other) === 'sea' && !reach.has(other)) {
          reach.add(other);
          stack.push(other);
        }
    }
    expect(reach.has(canal.to)).toBe(false);
    const lakePorts = [...economy.ports.ports.keys()].filter((province) =>
      reach.has(economy.harbours.get(province)!.sea + 1),
    );
    expect(lakePorts.length).toBeGreaterThan(0);
    const names = localisation(world);
    expect([...names.values()]).toContain('Lakehaven');
  });

  it('refuses a port on a decorative lake and one inland, and says why', () => {
    const built = variant((model) => {
      model.sites!.push(
        { id: 'tarn_quay', name: 'Tarn Quay', kind: 'port', at: [0.18, 0.425], lake: 'tarn' },
        { id: 'dry_dock', name: 'Dry Dock', kind: 'port', at: [0.2, 0.62] },
      );
    });
    const codes = built.notes.map(({ code }) => code);
    expect(codes).toContain('MAP_PORT_LAKE_UNSUPPORTED');
    expect(codes).toContain('MAP_PORT_SITE_NOT_COASTAL');
    const lakeNote = built.notes.find(({ code }) => code === 'MAP_PORT_LAKE_UNSUPPORTED')!;
    expect(lakeNote.details).toMatchObject({ siteId: 'tarn_quay', lakeId: 'tarn' });
  });
});

describe('development from the model', () => {
  const world = gameplayWorld();
  const economy = world.gameplay!.economy!;

  it('ranks fertile states above barren ones', () => {
    const built = variant((model) => {
      model.biomes = [
        {
          id: 'golden_fields',
          kind: 'farmland',
          fertility: 0.95,
          polygons: [
            [
              [0.06, 0.12],
              [0.3, 0.12],
              [0.3, 0.88],
              [0.06, 0.88],
            ],
          ],
        },
        {
          id: 'ash_flats',
          kind: 'desert',
          fertility: 0.04,
          polygons: [
            [
              [0.3, 0.12],
              [0.5, 0.12],
              [0.5, 0.88],
              [0.3, 0.88],
            ],
          ],
        },
      ] as never;
      // Sites would lift individual states; the correlation is about land.
      model.sites = [];
    });
    const plan = built.gameplay!.economy!.development.states;
    const states = [...plan.values()].filter((state) => state.fertility > 0);
    const correlation = spearman(
      states.map(({ fertility }) => fertility),
      states.map(({ development }) => development),
    );
    expect(correlation).toBeGreaterThan(0.6);
    const fertile = states.filter(({ fertility }) => fertility > 0.7);
    const barren = states.filter(({ fertility }) => fertility < 0.3);
    expect(fertile.length).toBeGreaterThan(3);
    expect(barren.length).toBeGreaterThan(3);
    const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;
    expect(mean(fertile.map(({ development }) => development))).toBeGreaterThan(
      mean(barren.map(({ development }) => development)) + 0.15,
    );
  });

  it('writes valid, deterministic state values and keeps victory points on sites', () => {
    const second = generateWorld(gameplaySpec(), plainContext);
    const a = stateTexts(world);
    const b = stateTexts(second);
    expect([...a.keys()]).toEqual([...b.keys()]);
    for (const [id, text] of a) expect(b.get(id)).toBe(text);
    const names = localisation(world);
    const capitals = [...a.values()].filter((text) => /victory_points = \{ \d+ 25 \}/u.test(text));
    expect(capitals).toHaveLength(2);
    expect(capitals.map((text) => names.get(`STATE_${/id = (\d+)/u.exec(text)![1]!}`))).toContain(
      'Aenorhold',
    );
    for (const text of a.values()) {
      expect(Number(/manpower = (\d+)/u.exec(text)![1])).toBeGreaterThanOrEqual(1_000);
      expect(text).toMatch(/state_category = [a-z_]+/u);
    }
  });

  it('takes ore from a mine site and from a range, not from a terrain roll', () => {
    const texts = [...stateTexts(world).values()];
    const steel = texts.map((text) => Number(/steel = (\d+)/u.exec(text)?.[1] ?? 0));
    // The Iron Hill mine (importance 3) alone gives 2 + 3 * 3.
    expect(Math.max(...steel)).toBeGreaterThanOrEqual(11);
    const again = variant((model) => {
      model.sites = model.sites!.filter(({ id }) => id !== 'iron_hill');
    });
    const without = [...stateTexts(again).values()].map((text) =>
      Number(/steel = (\d+)/u.exec(text)?.[1] ?? 0),
    );
    expect(without.reduce((s, v) => s + v, 0)).toBeLessThan(steel.reduce((s, v) => s + v, 0));
  });

  it('keeps the random economy for the legacy model and says nothing of the geography one', () => {
    const legacy = generateWorld(gameplaySpec({ developmentModel: 'legacy' }), plainContext);
    expect(legacy.gameplay!.economy).toBeUndefined();
    expect(legacy.railCost).toBeUndefined();
    expect(legacy.notes.map(({ code }) => code)).not.toContain('MAP_DEVELOPMENT_PLANNED');
    expect(economy.development.states.size).toBe(world.summary.states);
    // Crossings still come from the model.
    expect(adjacencyRows(legacy).some(({ rule }) => rule === 'BRIGHT_STRAIT')).toBe(true);
  });
});

describe('names from the model', () => {
  const world = gameplayWorld();
  const names = localisation(world);

  it('names every state, region and victory point from the model without placeholders', () => {
    const stateNames = [...names].filter(([key]) => key.startsWith('STATE_')).map(([, v]) => v);
    expect(stateNames).toHaveLength(world.summary.states);
    expect(new Set(stateNames).size).toBe(stateNames.length);
    for (const name of stateNames) expect(name).not.toMatch(/District|Region \d/u);
    const regionNames = [...names]
      .filter(([key]) => key.startsWith('STRATEGICREGION_'))
      .map(([, v]) => v);
    expect(new Set(regionNames).size).toBe(regionNames.length);
    for (const name of regionNames) expect(name).not.toMatch(/^Region \d+$/u);
    const victory = [...names]
      .filter(([key]) => key.startsWith('VICTORY_POINTS_'))
      .map(([, v]) => v);
    expect(new Set(victory).size).toBe(victory.length);
    for (const name of victory) expect(name).not.toMatch(/Settlement \d+/u);
    expect(world.notes.map(({ code }) => code)).not.toContain('MAP_NAME_PLACEHOLDER');
  });

  it('uses the lands, regions, seas, lakes and sites where the provinces lie', () => {
    const all = [...names.values()];
    expect(all.some((name) => name.includes('South Isle'))).toBe(true);
    expect(all.some((name) => name.includes('West Marches'))).toBe(true);
    expect(all.some((name) => name.includes('Northern Reach'))).toBe(true);
    expect(all.some((name) => name.includes('Southern Deep'))).toBe(true);
    expect(all).toContain('Great Lake');
    expect(all).toContain('Cinder Keep');
    // A lake province carries the lake's name.
    expect([...names.keys()].some((key) => /^PROV\d+$/u.test(key))).toBe(true);
    expect(all).toContain('The Tarn');
    // Every state on South Isle says so.
    const map = provinceMap(world);
    const southIsleStates = [...stateTexts(world)].filter(([, text]) => {
      const provinces = /provinces = \{([^}]+)\}/u.exec(text)![1]!.trim().split(/\s+/u).map(Number);
      const probe = provinces[0]!;
      let sy = 0;
      let n = 0;
      for (let i = 0; i < map.ids.length; i += 5)
        if (map.ids[i] === probe) {
          sy += Math.floor(i / map.width);
          n += 1;
        }
      return sy / n > GAMEPLAY_HEIGHT * 0.78 && provinces.length > 0;
    });
    expect(southIsleStates.length).toBeGreaterThan(0);
    for (const [id] of southIsleStates) expect(names.get(`STATE_${id}`)).toContain('South Isle');
  });

  it('counts the placeholders when the model leaves features unnamed', () => {
    const built = variant((model) => {
      for (const land of model.lands!) delete land.name;
      for (const region of model.regions ?? []) delete region.name;
      for (const sea of model.seas ?? []) delete sea.name;
      model.sites = [];
    });
    const note = built.notes.find(({ code }) => code === 'MAP_NAME_PLACEHOLDER')!;
    expect(note.severity).toBe('warning');
    const details = note.details as {
      placeholders: number;
      total: number;
      states: { total: number; placeholders: number };
      regions: { total: number; placeholders: number };
    };
    expect(details.placeholders).toBeGreaterThan(0);
    expect(details.states.total).toBe(built.summary.states);
    // The warning matches what was written.
    const written = [...localisation(built)].filter(([, value]) => / District \d+$/u.test(value));
    expect(written).toHaveLength(details.states.placeholders);
    const regions = [...localisation(built)].filter(([, value]) => /^Region \d+$/u.test(value));
    expect(regions).toHaveLength(details.regions.placeholders);
  });
});

describe('the railway cost model', () => {
  const world = gameplayWorld();
  const cost = world.railCost!;
  const map = provinceMap(world);
  const terrain = new Map(
    filesOf(world)
      .get('map/definition.csv')!
      .toString('utf8')
      .split('\r\n')
      .filter((line) => line !== '')
      .map((line) => line.split(';'))
      .map((d) => [Number(d[0]), d[6]!] as const),
  );

  it('is positive, symmetric and costs more over mountains than over plains', () => {
    const into = new Map<string, number[]>();
    for (const [a, neighbors] of map.neighbors)
      for (const b of neighbors) {
        if (a > b || map.typeOf.get(a) !== 'land' || map.typeOf.get(b) !== 'land') continue;
        const forward = cost.cost(a, b);
        expect(forward).toBeGreaterThanOrEqual(0.2);
        expect(cost.cost(b, a)).toBeCloseTo(forward, 9);
        for (const kind of [terrain.get(a)!, terrain.get(b)!]) {
          const list = into.get(kind) ?? [];
          list.push(forward);
          into.set(kind, list);
        }
      }
    const mean = (kind: string): number => {
      const list = into.get(kind) ?? [];
      return list.reduce((s, v) => s + v, 0) / Math.max(1, list.length);
    };
    expect(mean('mountain') || mean('hills')).toBeGreaterThan(mean('plains') * 0.9);
  });

  it('prices every gate crossing and lists the cities trunk lines must reach', () => {
    const gates = new Set(world.gameplay!.crossings.gates.map(([a, b]) => `${a + 1}:${b + 1}`));
    const gateCosts = [...gates].map((pair) => {
      const [a, b] = pair.split(':').map(Number) as [number, number];
      return cost.cost(a, b);
    });
    expect(gateCosts.length).toBeGreaterThan(0);
    for (const value of gateCosts) expect(Number.isFinite(value)).toBe(true);
    // Trunk targets are the cities of value 8 or more.
    expect(cost.trunk.size).toBeGreaterThan(2);
  });
});
