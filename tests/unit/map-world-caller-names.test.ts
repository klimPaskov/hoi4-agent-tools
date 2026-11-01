import { describe, expect, it } from 'vitest';
import type { GeneratedWorld } from '../../src/hoi4_agent_tools/map/world.js';
import type { WorldNamesInput } from '../../src/hoi4_agent_tools/schemas/map.js';
import { provinceMap } from '../helpers/gameplay-checks.js';
import { gameplayWorld } from '../helpers/gameplay-fixture.js';
import { filesOf } from '../helpers/map-appearance-world.js';

function localisation(world: GeneratedWorld): Map<string, string> {
  const text = filesOf(world).get('localisation/replace/world_l_english.yml')!.toString('utf8');
  return new Map(
    [...text.matchAll(/^ ([A-Za-z0-9_]+): "(.*)"$/gmu)].map((match) => [match[1]!, match[2]!]),
  );
}

/** Lists of province ids by state or region id, read from the written files. */
function members(world: GeneratedWorld, folder: string): Map<number, number[]> {
  return new Map(
    [...filesOf(world)]
      .filter(([name]) => name.startsWith(folder))
      .map(([, bytes]) => {
        const text = bytes.toString('utf8');
        const provinces = /provinces\s*=\s*\{([^}]+)\}/u.exec(text)![1]!.trim().split(/\s+/u);
        return [Number(/id\s*=\s*(\d+)/u.exec(text)![1]), provinces.map(Number)] as const;
      }),
  );
}

function victoryProvinces(world: GeneratedWorld): number[] {
  const provinces: number[] = [];
  for (const [name, bytes] of filesOf(world))
    if (name.startsWith('history/states/'))
      for (const match of bytes.toString('utf8').matchAll(/victory_points\s*=\s*\{\s*(\d+)/gu))
        provinces.push(Number(match[1]));
  return provinces.sort((a, b) => a - b);
}

describe('names from the caller (ZR-22)', () => {
  const base = gameplayWorld();
  const map = provinceMap(base);
  const pixelOf = new Map<number, { x: number; y: number }>();
  for (let index = map.ids.length - 1; index >= 0; index -= 1)
    pixelOf.set(map.ids[index]!, { x: index % map.width, y: Math.floor(index / map.width) });
  const states = members(base, 'history/states/');
  const regions = members(base, 'map/strategicregions/');
  const victory = victoryProvinces(base);
  const seaPixel = pixelOf.get([...map.typeOf].find(([, type]) => type === 'sea')![0])!;
  const nonVictoryLand = [...map.typeOf].find(
    ([id, type]) => type === 'land' && id > 0 && !victory.includes(id),
  )![0];
  const names: WorldNamesInput = {
    states: [
      ...[...states].map(([id, provinces]) => ({
        at: pixelOf.get(provinces.at(-1)!)!,
        name: `Shire ${id}`,
      })),
      // A sea pixel names no state, and a second name for state 1 is dropped.
      { at: seaPixel, name: 'Nowhere' },
      { at: pixelOf.get(states.get(1)![0]!)!, name: 'Second Name' },
    ],
    victoryPoints: [
      ...victory.map((id) => ({ at: pixelOf.get(id)!, name: `Town ${id}` })),
      // Land with no victory point names no victory point.
      { at: pixelOf.get(nonVictoryLand)!, name: 'Hamlet' },
    ],
    regions: [...regions].map(([id, provinces]) => ({
      at: pixelOf.get(provinces[0]!)!,
      name: `Reach ${id}`,
    })),
  };
  const named = gameplayWorld('caller-names', { names });
  const written = localisation(named);

  it('writes the caller names for every state, victory point and region they cover', () => {
    for (const id of states.keys()) expect(written.get(`STATE_${id}`)).toBe(`Shire ${id}`);
    for (const id of victory) expect(written.get(`VICTORY_POINTS_${id}`)).toBe(`Town ${id}`);
    for (const id of regions.keys())
      expect(written.get(`STRATEGICREGION_${id}`)).toBe(`Reach ${id}`);
    expect([...written.keys()].some((key) => key.startsWith('WORLD_GEOGRAPHY_'))).toBe(false);
    expect(named.notes.map(({ code }) => code)).not.toContain('MAP_NAME_PLACEHOLDER');
  });

  it('changes nothing but the names', () => {
    // State and region files are named after what they hold, so they are compared by id.
    const byId = (world: GeneratedWorld) =>
      new Map(
        [...filesOf(world)].map(([name, bytes]) => [
          name.replace(/^((?:history\/states|map\/strategicregions)\/\d+)-.*\.txt$/u, '$1'),
          bytes,
        ]),
      );
    const before = byId(base);
    const after = byId(named);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    const changed = [...after].filter(([name, bytes]) => !bytes.equals(before.get(name)!));
    expect(changed.map(([name]) => name)).toEqual(['localisation/replace/world_l_english.yml']);
    expect([...filesOf(named).keys()]).toContain('history/states/1-Shire 1.txt');
  });

  it('reports names that match nothing and second names for one feature', () => {
    const unmatched = named.notes.find(({ code }) => code === 'MAP_NAME_UNMATCHED')!;
    expect(unmatched.details).toMatchObject({
      count: 2,
      examples: expect.arrayContaining([
        expect.objectContaining({ kind: 'state', name: 'Nowhere', ...seaPixel }),
        expect.objectContaining({ kind: 'victory point', name: 'Hamlet' }),
      ]),
    });
    const duplicate = named.notes.find(({ code }) => code === 'MAP_NAME_POINT_DUPLICATE')!;
    expect(duplicate.details).toMatchObject({
      count: 1,
      examples: [expect.objectContaining({ name: 'Second Name', kept: 'Shire 1' })],
    });
    expect(named.notes.map(({ code }) => code)).not.toContain('MAP_NAME_DUPLICATE');
  });

  it('reports one text given to two features of a kind, and is deterministic', () => {
    const [first, second] = [...states.values()];
    const shared: WorldNamesInput = {
      states: [
        { at: pixelOf.get(first![0]!)!, name: 'Twin' },
        { at: pixelOf.get(second![0]!)!, name: 'Twin' },
      ],
    };
    const twin = gameplayWorld('caller-names-twin', { names: shared });
    expect(twin.notes.find(({ code }) => code === 'MAP_NAME_DUPLICATE')?.details).toMatchObject({
      count: 1,
      examples: [{ kind: 'state', name: 'Twin', features: 2 }],
    });
    const again = gameplayWorld('caller-names-twin-again', { names: shared });
    expect(localisation(again)).toEqual(localisation(twin));
  });
});
