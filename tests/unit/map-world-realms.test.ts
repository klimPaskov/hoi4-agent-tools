import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { MapWorkspaceIndex } from '../../src/hoi4_agent_tools/map/model.js';
import {
  planMapOperations,
  type CreateWorldOperation,
} from '../../src/hoi4_agent_tools/map/operations.js';
import { WORLD_OUTPUT_MANIFEST } from '../../src/hoi4_agent_tools/map/world-outputs.js';
import { workspaceCountriesSchema } from '../../src/hoi4_agent_tools/schemas/map.js';

function source(relativePath: string, content: Uint8Array | string): ScannedFile {
  const bytes = Buffer.from(content);
  return {
    relativePath,
    absolutePath: `/synthetic/${relativePath}`,
    displayPath: `mod:${relativePath}`,
    rootKind: 'mod',
    loadOrder: 1,
    modifiedMs: 0,
    size: bytes.length,
    bytes,
    sha256: sha256Bytes(bytes),
  };
}

const tagFile = source(
  'common/country_tags/00_realms.txt',
  'AAA = "countries/AAA.txt"\nBBB = "countries/BBB.txt"\nCCC = "countries/CCC.txt"\n',
);
const dynamicFile = source(
  'common/country_tags/01_dynamic.txt',
  'dynamic_tags = yes\nD01 = "countries/D01.txt"\n',
);
const box = (left: number, top: number, right: number, bottom: number) => [
  { x: left, y: top },
  { x: right, y: top },
  { x: right, y: bottom },
  { x: left, y: bottom },
];

const baseWorld: CreateWorldOperation = {
  id: 'world',
  kind: 'create_world',
  width: 512,
  height: 256,
  seed: 3,
  rivers: 0,
  landPolygons: [box(24, 24, 360, 232), box(400, 64, 488, 192)],
  provincesPerState: 4,
};

function workspaceWorld(
  countries: NonNullable<CreateWorldOperation['countries']>,
): CreateWorldOperation {
  return { ...baseWorld, countries };
}

const realms = {
  source: 'workspace' as const,
  realms: [
    { tag: 'AAA', capital: { x: 80, y: 128 }, weight: 1 },
    { tag: 'BBB', capital: { x: 300, y: 128 }, claim: [box(200, 30, 260, 110)] },
  ],
  unowned: [box(150, 170, 230, 230)],
};

function plan(sources: ScannedFile[], operation: CreateWorldOperation) {
  return planMapOperations(MapWorkspaceIndex.build(sources), [operation]);
}

function ownerAt(result: ReturnType<typeof plan>, x: number, y: number) {
  const index = result.finalIndex;
  const raster = index.raster!;
  const province = raster.provinceIds[y * raster.width + x]!;
  return index.stateForProvince(province)[0]?.owner;
}

/** Owners of the island (x 400 to 488, y 64 to 192), sampled on a grid. */
function islandOwners(result: ReturnType<typeof plan>) {
  const owners = new Set<string>();
  for (let y = 72; y <= 184; y += 8)
    for (let x = 408; x <= 480; x += 8) owners.add(ownerAt(result, x, y) ?? '-');
  return owners;
}

function written(result: ReturnType<typeof plan>, path: string) {
  return Buffer.from(result.changes.find((f) => f.relativePath === path)!.content!).toString();
}

describe('workspace-owned countries in create_world', () => {
  it('places workspace countries and writes no country files of its own', () => {
    const result = plan([tagFile, dynamicFile], workspaceWorld(realms));
    expect(result.blockers).toEqual([]);
    const paths = result.changes.map(({ relativePath }) => relativePath);
    expect(
      paths.filter((path) =>
        /^(common\/country_tags|common\/countries|history\/countries|history\/units|gfx\/flags|common\/bookmarks)\//u.test(
          path,
        ),
      ),
    ).toEqual([]);
    const index = result.finalIndex;
    const owners = new Set(index.states.map(({ owner }) => owner ?? '-'));
    expect([...owners].sort()).toEqual(['-', 'AAA', 'BBB']);
    // The island no country starts on goes to the nearest capital by default.
    const report = result.worldOutputs?.[0]?.realms;
    expect(report?.countries.map(({ tag }) => tag)).toEqual(['AAA', 'BBB']);
    for (const country of report!.countries) {
      const state = index.statesById.get(country.capitalState)!;
      expect(state.owner).toBe(country.tag);
      expect(index.stateForProvince(country.capitalProvince)[0]?.id).toBe(state.id);
    }
    expect(ownerAt(result, 80, 128)).toBe('AAA');
    expect(ownerAt(result, 230, 70)).toBe('BBB');
    expect(ownerAt(result, 190, 200)).toBeUndefined();
    expect(islandOwners(result).has('-')).toBe(false);
    expect(report!.unownedStates.length).toBeGreaterThan(0);
    const unowned = index.statesById.get(report!.unownedStates[0]!)!;
    const text = Buffer.from(unowned.file.bytes).toString();
    expect(text).not.toMatch(/owner =|add_core_of =/u);
    const codes = result.diagnostics.map(({ code }) => code);
    expect(codes).toEqual(
      expect.arrayContaining(['MAP_WORLD_REALMS_PLACED', 'MAP_WORLD_STATE_UNOWNED']),
    );
    const tags = result.diagnostics.find(({ code }) => code === 'MAP_WORLD_TAG_COUNT');
    expect(tags?.details).toMatchObject({ static: 3, generated: 0, dynamic: 1, total: 4 });
    expect(written(result, 'localisation/replace/world_l_english.yml')).not.toMatch(
      /WORLD_BOOKMARK|AAA_ADJ/u,
    );
  });

  it('is deterministic and leaves the array form unchanged', () => {
    const one = plan([tagFile], workspaceWorld(realms));
    const two = plan([tagFile], workspaceWorld(realms));
    expect(one.changes.map((f) => [f.relativePath, f.content && sha256Bytes(f.content)])).toEqual(
      two.changes.map((f) => [f.relativePath, f.content && sha256Bytes(f.content)]),
    );
    const generated = plan([], workspaceWorld([{ tag: 'XXA', name: 'Aster' }]));
    expect(generated.blockers).toEqual([]);
    expect(generated.worldOutputs?.[0]?.realms).toBeUndefined();
    expect(
      generated.changes.some(
        ({ relativePath }) => relativePath === 'common/country_tags/zz_world_countries.txt',
      ),
    ).toBe(true);
    const tags = generated.diagnostics.find(({ code }) => code === 'MAP_WORLD_TAG_COUNT');
    expect(tags?.details).toMatchObject({ generated: 1, total: 1 });
  });

  it('keeps the realm constraints with the feature-aware partition', () => {
    // Generated countries of a feature-aware world grow with the territory service (ADR 0060);
    // workspace countries keep the realm growth with forced claims and blocked land.
    const featureAware = { ...workspaceWorld({ ...realms, islands: 'unowned' as const }) };
    const result = plan([tagFile], { ...featureAware, partition: 'feature-aware' });
    expect(result.blockers).toEqual([]);
    expect(ownerAt(result, 80, 128)).toBe('AAA');
    expect(ownerAt(result, 230, 70)).toBe('BBB');
    expect(ownerAt(result, 190, 200)).toBeUndefined();
    expect([...islandOwners(result)]).toEqual(['-']);
    expect(result.worldOutputs?.[0]?.realms?.unownedStates.length).toBeGreaterThan(0);
  });

  it('applies the island rules', () => {
    const unowned = plan([tagFile], workspaceWorld({ ...realms, islands: 'unowned' }));
    expect(unowned.blockers).toEqual([]);
    expect([...islandOwners(unowned)]).toEqual(['-']);
    const oneOwner = plan([tagFile], workspaceWorld({ ...realms, islands: 'one-owner' }));
    expect(oneOwner.blockers).toEqual([]);
    expect([...islandOwners(oneOwner)]).toEqual(['BBB']);
    // An exclusion over the island sends it to the other country.
    const excluded = plan(
      [tagFile],
      workspaceWorld({
        ...realms,
        realms: [realms.realms[0]!, { ...realms.realms[1]!, exclude: [box(396, 60, 492, 196)] }],
      }),
    );
    expect(excluded.blockers).toEqual([]);
    expect([...islandOwners(excluded)]).toEqual(['AAA']);
  });

  it.each([
    [
      'an undeclared tag',
      { source: 'workspace' as const, realms: [{ tag: 'ZZZ', capital: { x: 80, y: 128 } }] },
      'MAP_WORLD_REALM_TAG_UNKNOWN',
    ],
    [
      'a dynamic tag',
      { source: 'workspace' as const, realms: [{ tag: 'D01', capital: { x: 80, y: 128 } }] },
      'MAP_WORLD_REALM_TAG_DYNAMIC',
    ],
    [
      'a capital in water',
      { source: 'workspace' as const, realms: [{ tag: 'AAA', capital: { x: 380, y: 10 } }] },
      'MAP_WORLD_REALM_POINT_WATER',
    ],
    [
      'a capital outside the world',
      { source: 'workspace' as const, realms: [{ tag: 'AAA', capital: { x: 900, y: 10 } }] },
      'MAP_WORLD_REALM_POINT_OUTSIDE',
    ],
    [
      'a capital in unowned land',
      {
        source: 'workspace' as const,
        realms: [{ tag: 'AAA', capital: { x: 190, y: 200 } }],
        unowned: [box(150, 170, 230, 230)],
      },
      'MAP_WORLD_REALM_POINT_CONFLICT',
    ],
    [
      'a capital in its own exclusion',
      {
        source: 'workspace' as const,
        realms: [{ tag: 'AAA', capital: { x: 80, y: 128 }, exclude: [box(40, 90, 120, 160)] }],
      },
      'MAP_WORLD_REALM_POINT_CONFLICT',
    ],
    [
      'a seed on another capital',
      {
        source: 'workspace' as const,
        realms: [
          { tag: 'AAA', capital: { x: 80, y: 128 } },
          { tag: 'BBB', capital: { x: 300, y: 128 }, seeds: [{ x: 80, y: 128 }] },
        ],
      },
      'MAP_WORLD_REALM_POINT_CONFLICT',
    ],
    [
      'overlapping claims',
      {
        source: 'workspace' as const,
        realms: [
          { tag: 'AAA', capital: { x: 80, y: 128 }, claim: [box(150, 40, 260, 120)] },
          { tag: 'BBB', capital: { x: 300, y: 128 }, claim: [box(200, 40, 280, 120)] },
        ],
      },
      'MAP_WORLD_REALM_CLAIM_OVERLAP',
    ],
    [
      'a claim over unowned land',
      {
        source: 'workspace' as const,
        realms: [{ tag: 'AAA', capital: { x: 80, y: 128 }, claim: [box(150, 170, 230, 230)] }],
        unowned: [box(150, 170, 230, 230)],
      },
      'MAP_WORLD_REALM_CLAIM_OVERLAP',
    ],
  ])('refuses %s', (_name, countries, code) => {
    const result = plan([tagFile, dynamicFile], workspaceWorld(countries));
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([code]);
    expect(result.changes).toEqual([]);
  });

  it('releases edited country files of an earlier generated world and retires the rest', () => {
    const first = plan([], workspaceWorld([{ tag: 'XXA', name: 'Aster' }]));
    expect(first.blockers).toEqual([]);
    const flag = 'gfx/flags/XXA.tga';
    const sources = first.changes
      .filter((f) => f.content !== null)
      .map((f) =>
        f.relativePath === flag ? source(flag, 'mod flag') : source(f.relativePath, f.content!),
      );
    // The array form still blocks on the edited flag.
    expect(
      plan(sources, workspaceWorld([{ tag: 'XXA', name: 'Aster' }])).blockers.map(
        ({ code }) => code,
      ),
    ).toEqual(['MANAGED_OUTPUT_EDITED']);
    const next = plan([...sources, tagFile], workspaceWorld(realms));
    expect(next.blockers).toEqual([]);
    const report = next.worldOutputs![0]!;
    expect(report.released).toEqual([flag]);
    expect(report.retired).toEqual(
      expect.arrayContaining([
        'common/country_tags/zz_world_countries.txt',
        'common/bookmarks/world.txt',
        'gfx/flags/small/XXA.tga',
      ]),
    );
    expect(next.changes.some(({ relativePath }) => relativePath === flag)).toBe(false);
    const inventory = JSON.parse(written(next, WORLD_OUTPUT_MANIFEST)) as {
      files: { relativePath: string }[];
    };
    expect(inventory.files.some(({ relativePath }) => relativePath === flag)).toBe(false);
    expect(next.diagnostics.map(({ code }) => code)).toContain('MAP_WORLD_OUTPUT_RELEASED');
  });

  it('validates the request shape', () => {
    expect(workspaceCountriesSchema.safeParse(realms).success).toBe(true);
    expect(
      workspaceCountriesSchema.safeParse({
        source: 'workspace',
        realms: [
          { tag: 'AAA', capital: { x: 1, y: 1 } },
          { tag: 'AAA', capital: { x: 2, y: 2 } },
        ],
      }).success,
    ).toBe(false);
    for (const invalid of [
      { source: 'workspace', realms: [] },
      { source: 'mod', realms: [{ tag: 'AAA', capital: { x: 1, y: 1 } }] },
      { source: 'workspace', realms: [{ tag: 'aaa', capital: { x: 1, y: 1 } }] },
      { source: 'workspace', realms: [{ tag: 'AAA', capital: { x: -1, y: 1 } }] },
      { source: 'workspace', realms: [{ tag: 'AAA', capital: { x: 1, y: 1 }, weight: 0 }] },
      { source: 'workspace', realms: [{ tag: 'AAA', capital: { x: 1, y: 1 }, claim: [[]] }] },
      { source: 'workspace', realms: [{ tag: 'AAA', capital: { x: 1, y: 1 }, colour: 1 }] },
      {
        source: 'workspace',
        realms: Array.from({ length: 513 }, (_, index) => ({
          tag: `A${index.toString(36).toUpperCase().padStart(2, '0')}`,
          capital: { x: 1, y: 1 },
        })),
      },
    ])
      expect(workspaceCountriesSchema.safeParse(invalid).success).toBe(false);
  });
});
