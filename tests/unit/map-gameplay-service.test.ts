import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { validateCrossings } from '../../src/hoi4_agent_tools/map/gameplay/crossing-validation.js';
import { geographyModelSchema } from '../../src/hoi4_agent_tools/schemas/geography.js';
import { AgentNudger } from '../../src/hoi4_agent_tools/map/service.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';
import type { Diagnostic } from '../../src/hoi4_agent_tools/core/diagnostics.js';
import type { MapOperation } from '../../src/hoi4_agent_tools/map/operations.js';
import { gameplayGeography, gameplayWorld } from '../helpers/gameplay-fixture.js';
import { filesOf, indexOfFiles } from '../helpers/map-appearance-world.js';

async function nudger(): Promise<AgentNudger> {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-gameplay-'));
  const mod = path.join(base, 'mod');
  await mkdir(mod);
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'state'),
      workspaces: [{ id: 'w', name: 'W', root: mod }],
    }),
  );
  return new AgentNudger(resolver);
}

const operation = (extra: Record<string, unknown> = {}): MapOperation =>
  ({
    id: 'world',
    kind: 'create_world',
    width: 1_024,
    height: 512,
    seed: 5,
    landProvincePixels: 520,
    seaProvincePixels: 2_400,
    geography: gameplayGeography(),
    countries: [
      { tag: 'AAA', name: 'Aenorland' },
      { tag: 'BBB', name: 'Beta' },
    ],
    ...extra,
  }) as MapOperation;

function findings(files: Map<string, Buffer>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const steps = validateCrossings(indexOfFiles(files), (d) => out.push({ ...d, category: 'map' }));
  for (;;) if (steps.next().done) break;
  return out;
}

describe('a geography world through the planner', () => {
  let files: Map<string, Buffer>;
  let passed = false;
  let codes: string[] = [];

  beforeAll(async () => {
    const preview = await (
      await nudger()
    ).previewRewriteWithDiff({
      workspaceId: 'w',
      operations: [operation({ autoStraits: true })],
    });
    expect(preview.plan.blockers).toEqual([]);
    passed = preview.validation.passed;
    codes = preview.validation.diagnostics.map(({ code }) => code);
    files = new Map(
      preview.plan.changes
        .filter((change) => change.content !== null)
        .map((change) => [change.relativePath, Buffer.from(change.content!)] as const),
    );
  }, 120_000);

  it('validates, with crossings, positions and railways all consistent', () => {
    expect(passed).toBe(true);
    for (const code of [
      'MAP_ADJACENCY_RULE_MISSING',
      'MAP_ADJACENCY_RULE_INVALID',
      'MAP_RAILWAY_CROSSES_IMPASSABLE',
      'MAP_UNIT_POSITION_MISSING',
      'MAP_IMPASSABLE_NOT_ADJACENT',
    ])
      expect(codes).not.toContain(code);
    // The only finding is the deliberately wide Long Channel.
    expect(findings(files).map(({ code }) => code)).toEqual(['MAP_STRAIT_NOT_NARROW']);
  });

  it('keeps the railways off the wall except through a gate, and runs trunk lines', () => {
    const impassable = new Set(
      files
        .get('map/adjacencies.csv')!
        .toString('utf8')
        .split('\r\n')
        .filter((line) => line.includes(';impassable;'))
        .flatMap((line) => {
          const [a, b] = line.split(';');
          return [`${a}:${b}`, `${b}:${a}`];
        }),
    );
    const railways = files
      .get('map/railways.txt')!
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => line.trim().split(/\s+/u).map(Number));
    expect(railways.length).toBeGreaterThan(5);
    for (const [, , ...provinces] of railways)
      for (let i = 1; i < provinces.length; i += 1)
        expect(impassable.has(`${provinces[i - 1]}:${provinces[i]}`)).toBe(false);
    // Trunk lines are level 2 and the capital's lines level 3.
    const levels = new Set(railways.map(([level]) => level));
    expect(levels.has(2) || levels.has(3)).toBe(true);
    expect(files.get('map/supply_nodes.txt')!.toString('utf8').trim().length).toBeGreaterThan(0);
  });

  it('gives each inland-sea port a naval base position on the inland sea', () => {
    const positions = files
      .get('map/buildings.txt')!
      .toString('utf8')
      .split(/\r?\n/u)
      .filter((line) => line.includes(';naval_base_spawn;'))
      .map((line) => line.split(';'));
    expect(positions.length).toBeGreaterThan(5);
    const definitions = new Map(
      files
        .get('map/definition.csv')!
        .toString('utf8')
        .split('\r\n')
        .filter((line) => line !== '')
        .map((line) => line.split(';'))
        .map((d) => [Number(d[0]), d[4]!] as const),
    );
    for (const position of positions) expect(definitions.get(Number(position[6]))).toBe('sea');
  });
});

describe('crossing and wall validators', () => {
  const world = gameplayWorld();
  const clean = filesOf(world);

  function edited(change: (name: string, text: string) => string): Map<string, Buffer> {
    return new Map(
      [...clean].map(([name, bytes]) => [
        name,
        name === 'map/adjacencies.csv' || name === 'map/adjacency_rules.txt'
          ? Buffer.from(change(name, bytes.toString('utf8')))
          : bytes,
      ]),
    );
  }

  it('finds nothing wrong with the generated world but its one wide channel', () => {
    const found = findings(clean);
    expect(found.map(({ code }) => code)).toEqual(['MAP_STRAIT_NOT_NARROW']);
    expect(found[0]!.details).toMatchObject({ count: 1 });
  });

  it('flags a row that names a rule nobody defines', () => {
    const bad = edited((name, text) =>
      name === 'map/adjacencies.csv' ? text.replace('BRIGHT_STRAIT', 'GHOST_RULE') : text,
    );
    const found = findings(bad).filter(({ code }) => code === 'MAP_ADJACENCY_RULE_MISSING');
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('error');
    // The rule it left behind is now unused.
    expect(findings(bad).map(({ code }) => code)).toContain('MAP_ADJACENCY_RULE_UNUSED');
  });

  it('flags a rule with one required province, an unknown one and a duplicate', () => {
    const one = edited((name, text) =>
      name === 'map/adjacency_rules.txt'
        ? text.replace(/required_provinces = \{[^}]*\}/u, 'required_provinces = { 1 }')
        : text,
    );
    expect(findings(one).map(({ code }) => code)).toContain('MAP_ADJACENCY_RULE_INVALID');
    const unknown = edited((name, text) =>
      name === 'map/adjacency_rules.txt'
        ? text.replace(/required_provinces = \{[^}]*\}/u, 'required_provinces = { 1 99999 }')
        : text,
    );
    expect(
      findings(unknown).find(({ code }) => code === 'MAP_ADJACENCY_RULE_INVALID')?.details,
    ).toMatchObject({
      problems: [expect.stringContaining('unknown province')],
    });
    const duplicate = edited((name, text) =>
      name === 'map/adjacency_rules.txt'
        ? `${text}\n${text.slice(text.indexOf('# Bright'), text.indexOf('# Long'))}`
        : text,
    );
    expect(findings(duplicate).map(({ code }) => code)).toContain('MAP_ADJACENCY_RULE_DUPLICATE');
  });

  it('warns about a pattern of impassable rows between provinces that do not touch', () => {
    const bad = edited((name, text) =>
      name === 'map/adjacencies.csv'
        ? text.replace(
            '-1;-1;;-1;-1;-1;-1;-1;-1',
            '1;300;impassable;-1;-1;-1;-1;-1;;x\r\n2;310;impassable;-1;-1;-1;-1;-1;;x\r\n3;320;impassable;-1;-1;-1;-1;-1;;x\r\n-1;-1;;-1;-1;-1;-1;-1;-1',
          )
        : text,
    );
    const found = findings(bad).find(({ code }) => code === 'MAP_IMPASSABLE_NOT_ADJACENT')!;
    expect(found.severity).toBe('warning');
  });

  it('warns about a land crossing between provinces too far apart', () => {
    // Replace the narrow Bright Strait row with a hop across the whole continent.
    const far = edited((name, text) =>
      name === 'map/adjacencies.csv'
        ? text.replace(
            /^\d+;\d+;sea;\d+;[^\r\n]*BRIGHT_STRAIT;Bright Strait/mu,
            '81;659;sea;223;-1;-1;-1;-1;BRIGHT_STRAIT;Bright Strait',
          )
        : text,
    );
    expect(findings(far).map(({ code }) => code)).toContain('MAP_STRAIT_NOT_NARROW');
  });
});

describe('the new create_world options', () => {
  const base = { kind: 'create_world' } as const;

  it('accepts the development model and automatic straits', () => {
    for (const extra of [
      { development: { model: 'geography' } },
      { development: { model: 'legacy' } },
      { development: {} },
      { autoStraits: true },
      { autoStraits: false },
      { autoStraits: { maxGapPx: 30 } },
    ])
      expect(mapOperationSchema.safeParse({ ...base, ...extra }).success).toBe(true);
  });

  it('rejects unknown models, fractions, out-of-range gaps and extra keys', () => {
    for (const extra of [
      { development: { model: 'random' } },
      { development: { model: 'geography', balance: 1 } },
      { development: 'geography' },
      { autoStraits: { maxGapPx: 3 } },
      { autoStraits: { maxGapPx: 97 } },
      { autoStraits: { maxGapPx: 12.5 } },
      { autoStraits: { gap: 10 } },
      { autoStraits: 'yes' },
    ])
      expect(
        mapOperationSchema.safeParse({ ...base, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
  });

  it('refuses both options without a geography', async () => {
    const service = await nudger();
    for (const [extra, code] of [
      [{ development: { model: 'geography' } }, 'MAP_DEVELOPMENT_REQUIRES_GEOGRAPHY'],
      [{ autoStraits: true }, 'MAP_AUTO_STRAITS_REQUIRES_GEOGRAPHY'],
    ] as const) {
      const planned = await service.plan({
        workspaceId: 'w',
        operations: [operation({ geography: undefined, ...extra })],
      });
      expect(planned.plan.blockers.map((blocker) => blocker.code)).toContain(code);
    }
  });

  it('accepts a site resource and rejects an unknown one', () => {
    const model = gameplayGeography();
    expect(geographyModelSchema.safeParse(model).success).toBe(true);
    const withResource = {
      ...model,
      sites: [
        ...(model.sites ?? []),
        { id: 'oil_well', kind: 'mine', at: [0.2, 0.3], resource: 'oil' },
      ],
    };
    expect(geographyModelSchema.safeParse(withResource).success).toBe(true);
    const bad = {
      ...model,
      sites: [
        ...(model.sites ?? []),
        { id: 'gold', kind: 'mine', at: [0.2, 0.3], resource: 'gold' },
      ],
    };
    expect(geographyModelSchema.safeParse(bad).success).toBe(false);
  });
});
