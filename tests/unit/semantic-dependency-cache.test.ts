import { describe, expect, it } from 'vitest';
import { hashCanonical, sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import type { ScanSnapshot } from '../../src/hoi4_agent_tools/core/engine.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { buildEventGraph } from '../../src/hoi4_agent_tools/event/graph.js';
import type { EventSourceFragment } from '../../src/hoi4_agent_tools/event/model.js';
import { buildTechnologyGraph } from '../../src/hoi4_agent_tools/technology/graph.js';
import type { TechnologySourceFragment } from '../../src/hoi4_agent_tools/technology/model.js';
import {
  beginSemanticAnalysis,
  clearSemanticDependencies,
  semanticFragment,
  SemanticCatalog,
} from '../../src/hoi4_agent_tools/core/semantic-dependencies.js';

function file(relativePath: string, source: string, extra: Partial<ScannedFile> = {}): ScannedFile {
  const bytes = Buffer.from(source);
  return {
    absolutePath: `/fixture/${relativePath}`,
    relativePath,
    displayPath: `mod:${relativePath}`,
    rootKind: 'mod',
    loadOrder: 1,
    size: bytes.length,
    modifiedMs: 0,
    bytes,
    sha256: sha256Bytes(bytes),
    ...extra,
  };
}
function snapshot(files: ScannedFile[]): ScanSnapshot {
  const index = SymbolIndex.build(files);
  return {
    workspaceId: 'synthetic',
    files,
    index,
    revision: hashCanonical(
      files.map(({ displayPath, sha256, loadOrder, shadowedBy }) => ({
        displayPath,
        sha256,
        loadOrder,
        shadowedBy,
      })),
    ),
    complete: index.complete,
    skippedSources: index.skippedSources,
    skippedSourceCount: index.skippedSourceCount,
    diagnostics: index.diagnostics,
  };
}
function cache<T extends { sourcePath: string }>() {
  const values = new Map<string, T>();
  const rebuilt: string[] = [];
  return {
    rebuilt,
    get: (key: string) => values.get(key),
    set: (key: string, value: T) => {
      rebuilt.push(value.sourcePath);
      values.set(key, value);
    },
  };
}
const sources = () => [
  file(
    'events/entry.txt',
    'country_event = { id = cache.1 is_triggered_only = yes immediate = { a = yes } } country_event = { id = cache.2 is_triggered_only = yes }',
  ),
  file('common/scripted_effects/a.txt', 'a = { b = yes }'),
  file(
    'common/scripted_effects/b.txt',
    'b = { a = yes country_event = { id = cache.2 } add_tech_bonus = { bonus = 1 uses = 1 technology = cache_tech } }',
  ),
  file(
    'common/scripted_effects/unrelated.txt',
    'unrelated = { set_country_flag = unrelated_value }',
  ),
  file(
    'common/technologies/tech.txt',
    'technologies = { cache_tech = { research_cost = 1 start_year = 1936 } }',
  ),
];

describe('production semantic dependency caching', () => {
  it.each(['event', 'technology'] as const)(
    'preserves complete %s evidence through missing definitions, deletion, rename and overlays',
    (domain) => {
      const events = cache<EventSourceFragment>();
      const technologies = cache<TechnologySourceFragment>();
      const selected = domain === 'event' ? events : technologies;
      const build = (files: ScannedFile[], cached: boolean) =>
        domain === 'event'
          ? buildEventGraph(snapshot(files), { ...(cached ? { cache: events } : {}) })
          : buildTechnologyGraph(snapshot(files), {
              workspaceIdentity: 'fixture',
              ...(cached ? { cache: technologies } : {}),
            });
      const initial = sources();
      const missing = initial.filter(({ relativePath }) => !relativePath.endsWith('/a.txt'));
      expect(build(missing, true)).toEqual(build(missing, false));
      selected.rebuilt.length = 0;
      expect(build(initial, true)).toEqual(build(initial, false));
      expect(selected.rebuilt.sort()).toEqual(
        [initial[0]!.displayPath, initial[1]!.displayPath, initial[2]!.displayPath].sort(),
      );
      selected.rebuilt.length = 0;
      expect(build(missing, true)).toEqual(build(missing, false));
      expect(selected.rebuilt.sort()).toEqual(
        [initial[0]!.displayPath, initial[2]!.displayPath].sort(),
      );
      const renamed = [
        ...missing,
        file('common/scripted_effects/renamed.txt', initial[1]!.bytes.toString('utf8')),
      ];
      expect(build(renamed, true)).toEqual(build(renamed, false));
      const overlay = file(
        'common/scripted_effects/a.txt',
        'a = { country_event = { id = cache.2 } }',
        {
          absolutePath: '/overlay/common/scripted_effects/a.txt',
          displayPath: 'dependency-2:common/scripted_effects/a.txt',
          rootKind: 'dependency',
          loadOrder: 2,
        },
      );
      for (const files of [
        [...renamed, overlay],
        [...renamed, { ...overlay, loadOrder: 0 }],
        [
          ...initial.map((value) =>
            value.relativePath.endsWith('/a.txt')
              ? { ...value, shadowedBy: overlay.displayPath }
              : value,
          ),
          overlay,
        ],
        renamed,
        initial,
      ]) {
        expect(build(files, true)).toEqual(build(files, false));
      }
    },
  );
  it.each(['event', 'technology'] as const)(
    'rebuilds %s consumers transitively while retaining unrelated fragments',
    (domain) => {
      const events = cache<EventSourceFragment>();
      const technologies = cache<TechnologySourceFragment>();
      const selected = domain === 'event' ? events : technologies;
      const build = (files: ScannedFile[], cached: boolean) =>
        domain === 'event'
          ? buildEventGraph(snapshot(files), { ...(cached ? { cache: events } : {}) })
          : buildTechnologyGraph(snapshot(files), {
              workspaceIdentity: 'fixture',
              ...(cached ? { cache: technologies } : {}),
            });
      const initial = sources();
      expect(build(initial, true)).toEqual(build(initial, false));
      selected.rebuilt.length = 0;
      const unrelated = file(
        'common/scripted_effects/new.txt',
        'new_unrelated = { set_country_flag = independent }',
      );
      const extended = [...initial, unrelated];
      expect(build(extended, true)).toEqual(build(extended, false));
      expect(selected.rebuilt).toEqual([unrelated.displayPath]);
      selected.rebuilt.length = 0;
      const changed = extended.map((value) =>
        value.relativePath.endsWith('/b.txt')
          ? file(value.relativePath, value.bytes.toString('utf8').replace('bonus = 1', 'bonus = 2'))
          : value,
      );
      expect(build(changed, true)).toEqual(build(changed, false));
      expect(selected.rebuilt.sort()).toEqual(
        [initial[0]!.displayPath, initial[1]!.displayPath, initial[2]!.displayPath].sort(),
      );
    },
  );

  it('keeps identical technology bytes in distinct source files and load levels separate', () => {
    const content = 'technologies = { identical = { research_cost = 1 start_year = 1936 } }';
    const files = [
      file('common/technologies/first.txt', content),
      file('common/technologies/second.txt', content),
    ];
    const fragments = cache<TechnologySourceFragment>();
    const build = (values: ScannedFile[], cached: boolean) =>
      buildTechnologyGraph(snapshot(values), {
        workspaceIdentity: 'fixture',
        ...(cached ? { cache: fragments } : {}),
      });
    expect(build(files, true)).toEqual(build(files, false));
    expect(fragments.rebuilt).toEqual(files.map(({ displayPath }) => displayPath));
    expect(build([{ ...files[0]!, loadOrder: 2 }, files[1]!], true)).toEqual(
      build([{ ...files[0]!, loadOrder: 2 }, files[1]!], false),
    );
  });
});

describe('typed semantic catalog observations', () => {
  it.each(['interruption', 'inventory eviction'] as const)(
    'retains consumer invalidation across %s',
    (boundary) => {
      const fragments = cache<{ sourcePath: string; helperHash: string }>();
      const original = snapshot(sources());
      const run = (scan: ScanSnapshot, interrupt = false) => {
        const session = beginSemanticAnalysis(fragments, scan, 'synthetic');
        const catalog = new SemanticCatalog();
        const helpers = catalog.bind('helpers', 'scripted_effect', new Set(['a', 'b']));
        if (interrupt) throw new Error('stopped after invalidation');
        return semanticFragment(
          session,
          fragments,
          scan.files[0]!,
          'unused-legacy-key',
          catalog,
          () => {
            expect(helpers.has('a')).toBe(true);
            return { sourcePath: scan.files[0]!.displayPath, helperHash: scan.files[1]!.sha256 };
          },
        );
      };
      const first = run(original);
      const changed = snapshot(
        original.files.map((value, index) =>
          index === 1
            ? file(value.relativePath, 'a = { b = yes set_country_flag = changed }')
            : value,
        ),
      );
      if (boundary === 'interruption')
        expect(() => run(changed, true)).toThrow('stopped after invalidation');
      else {
        for (let index = 0; index < 33; index++) {
          const session = beginSemanticAnalysis(
            fragments,
            { ...original, workspaceId: `evict-${index}` },
            'synthetic',
          );
          expect(session.proofs.scopes.size).toBeLessThanOrEqual(32);
        }
      }
      expect(run(changed).helperHash).not.toBe(first.helperHash);
    },
  );
  it('tracks absent lookups, exact namespaces, full enumeration and exception boundaries', () => {
    const catalog = new SemanticCatalog();
    const definitions = new Map([['present', new Set(['first.txt'])]]);
    const observed = catalog.bind('definitions', 'event', definitions);
    const helpers = new Set(['present']);
    const helperView = catalog.bind('helpers', 'scripted_effect', helpers);
    const one = catalog.collect(() => [observed.get('present'), helperView.has('missing')]);
    definitions.set('unrelated', new Set(['other.txt']));
    expect(catalog.signature(one.reads)).toBe(one.signature);
    const all = catalog.collect(() => [...observed]);
    definitions.set('extra', new Set(['extra.txt']));
    expect(catalog.signature(all.reads)).not.toBe(all.signature);
    definitions.get('present')!.add('second.txt');
    expect(catalog.signature(one.reads)).not.toBe(one.signature);
    const absent = catalog.collect(() => helperView.has('missing'));
    helpers.add('missing');
    expect(catalog.signature(absent.reads)).not.toBe(absent.signature);
    expect(() => observed.set('forbidden', new Set())).toThrow('read-only');
    expect(() =>
      catalog.collect(() => {
        observed.has('exception');
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(catalog.collect(() => undefined).reads).toEqual([]);
  });

  it('invalidates completeness changes, isolates workspace roots, and releases dependency proof retention', () => {
    const fragments = cache<{ sourcePath: string; complete: boolean }>();
    const current = sources().slice(0, 1);
    const scan = snapshot(current);
    const catalog = new SemanticCatalog();
    const build = (value: ScanSnapshot) => {
      const session = beginSemanticAnalysis(fragments, value, 'synthetic');
      return semanticFragment(
        session,
        fragments,
        value.files[0]!,
        'unused-legacy-key',
        catalog,
        () => ({ sourcePath: value.files[0]!.absolutePath, complete: value.complete }),
      );
    };
    expect(build(scan).complete).toBe(true);
    expect(build({ ...scan, complete: false }).complete).toBe(false);
    expect(build(scan).complete).toBe(true);
    expect(
      build(
        snapshot(
          current.map((value) => ({
            ...value,
            absolutePath: value.absolutePath.replace('/fixture/', '/other/'),
          })),
        ),
      ),
    ).toMatchObject({ sourcePath: '/other/events/entry.txt' });
    fragments.rebuilt.length = 0;
    clearSemanticDependencies(fragments);
    expect(build(scan).complete).toBe(true);
    expect(fragments.rebuilt).toHaveLength(1);
  });
});
