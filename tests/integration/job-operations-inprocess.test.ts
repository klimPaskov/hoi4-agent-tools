import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import {
  JobOperations,
  type JobExecutionContext,
  type JobOutput,
} from '../../src/hoi4_agent_tools/core/job-executor.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { registerEventJobs } from '../../src/hoi4_agent_tools/event/job-operations.js';
import { registerFocusJobs } from '../../src/hoi4_agent_tools/focus/job-operations.js';
import { registerGuiJobs } from '../../src/hoi4_agent_tools/gui/job-operations.js';
import { registerMapJobs } from '../../src/hoi4_agent_tools/map/job-operations.js';
import { registerProbabilityJobs } from '../../src/hoi4_agent_tools/probability/job-operations.js';
import { registerTechnologyJobs } from '../../src/hoi4_agent_tools/technology/job-operations.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function fixture(extra?: 'gui' | 'map') {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-job-operation-entry-'));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const mod = path.join(root, 'mod');
  const source = async (relativePath: string, content: string) => {
    const file = path.join(mod, ...relativePath.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  await source(
    'events/inprocess.txt',
    'add_namespace = inprocess\ncountry_event = { id = inprocess.1 is_triggered_only = yes option = { name = inprocess.1.a add_political_power = 1 } }\n',
  );
  await source(
    'common/national_focus/inprocess.txt',
    'focus_tree = { id = inprocess_tree focus = { id = inprocess_root x = 0 y = 0 cost = 1 completion_reward = { add_political_power = 1 } } }\n',
  );
  await source(
    'common/continuous_focus/inprocess.txt',
    'continuous_focus_palette = { id = inprocess_palette default = yes continuous_focus = { id = inprocess_continuous cost = 10 } }\n',
  );
  await source(
    'common/technologies/inprocess.txt',
    'technologies = { inprocess_tech = { start_year = 1936 research_cost = 1 folder = { name = inprocess_folder position = { x = 0 y = 0 } } } }\n',
  );
  await source(
    'common/technology_tags/inprocess.txt',
    'technology_folders = { inprocess_folder = { ledger = army } }\n',
  );
  if (extra === 'gui')
    await cp(path.resolve('fixtures', 'gui', 'workspace'), mod, { recursive: true });
  if (extra === 'map') {
    const roots = path.resolve('fixtures', 'map', 'roots');
    await cp(path.join(roots, 'mod'), mod, { recursive: true });
    await cp(path.join(roots, 'game'), path.join(root, 'game'), { recursive: true });
    await cp(path.join(roots, 'dependency'), path.join(root, 'dependency'), { recursive: true });
  }
  const engine = new CoreEngine(
    await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        storageRoots: [path.join(root, 'runtime')],
        workspaces: [
          {
            id: 'fixture',
            name: 'In-process operation fixture',
            root: mod,
            ...(extra === 'map'
              ? {
                  gameRoot: path.join(root, 'game'),
                  dependencyRoots: [path.join(root, 'dependency')],
                }
              : {}),
            artifactRoot: path.join(root, 'runtime', 'artifacts'),
            cacheRoot: path.join(root, 'runtime', 'cache'),
          },
        ],
      }),
    ),
  );
  await engine.initialize();
  const operations = new JobOperations();
  registerEventJobs(operations, engine);
  registerFocusJobs(operations, engine);
  registerGuiJobs(operations, engine);
  registerMapJobs(operations, engine);
  registerProbabilityJobs(operations, engine);
  registerTechnologyJobs(operations, engine);
  return { engine, operations };
}

async function runRead(
  engine: CoreEngine,
  operations: JobOperations,
  name: string,
  input: Record<string, unknown>,
): Promise<{ result: JobOutput; staged: JobOutput[] }> {
  const operation = operations.get(name);
  if (operation.mutation) throw new Error(`Expected read operation: ${name}`);
  const staged: JobOutput[] = [];
  const context: JobExecutionContext = {
    engine,
    workspaceId: 'fixture',
    principal: undefined,
    signal: new AbortController().signal,
    checkpoint: undefined,
    progress: async () => undefined,
    saveCheckpoint: async () => undefined,
    stageResult: async (value) => {
      staged.push(value);
    },
  };
  return { result: await operation.run(input, context), staged };
}

describe('in-process durable job operation adapters', () => {
  it('produces wire results and result-ready staging across independent analysis domains', async () => {
    const { engine, operations } = await fixture();
    const calls: Array<[string, Record<string, unknown>, string]> = [
      ['hoi4.event_inspect', { workspaceId: 'fixture', mode: 'roots' }, 'EVENT_INSPECTED'],
      [
        'hoi4.focus_inspect',
        {
          workspaceId: 'fixture',
          relativePath: 'common/national_focus/inprocess.txt',
          treeId: 'inprocess_tree',
        },
        'FOCUS_INSPECTED',
      ],
      [
        'hoi4.focus_render',
        {
          workspaceId: 'fixture',
          relativePath: 'common/national_focus/inprocess.txt',
          treeId: 'inprocess_tree',
        },
        'FOCUS_RENDERED',
      ],
      [
        'hoi4.focus_raster',
        {
          workspaceId: 'fixture',
          relativePath: 'common/national_focus/inprocess.txt',
          treeId: 'inprocess_tree',
        },
        'FOCUS_RASTERIZED',
      ],
      [
        'hoi4.focus_inspect',
        {
          mode: 'continuous',
          workspaceId: 'fixture',
          relativePath: 'common/continuous_focus/inprocess.txt',
          paletteId: 'inprocess_palette',
        },
        'FOCUS_INSPECTED',
      ],
      [
        'hoi4.focus_render',
        {
          mode: 'continuous',
          workspaceId: 'fixture',
          relativePath: 'common/continuous_focus/inprocess.txt',
          paletteId: 'inprocess_palette',
        },
        'CONTINUOUS_FOCUS_RENDERED',
      ],
      ['hoi4.tech_inspect', { workspaceId: 'fixture', mode: 'scan' }, 'TECH_INSPECTED'],
      [
        'hoi4.tech_render',
        { workspaceId: 'fixture', view: 'folder', folderId: 'inprocess_folder' },
        'TECH_RENDERED',
      ],
    ];
    for (const [name, input, code] of calls) {
      const { result, staged } = await runRead(engine, operations, name, input);
      expect(result).toMatchObject({ structuredContent: { status: 'ok', code } });
      expect(staged).toEqual([result]);
    }
  }, 120_000);

  it('runs declared weighted-pool inspection and evaluation through the same adapters', async () => {
    const { engine, operations } = await fixture();
    const customPoolManifest = {
      schemaVersion: '1.0',
      id: 'inprocess-pool',
      selection: { mode: 'categorical_weighted', cadence: 'daily' },
      state: {},
      candidates: [
        { id: 'first', weight: 2, eligibleWhen: 'state.available == true' },
        { id: 'second', weight: 1 },
      ],
      transitions: [],
    };
    const inspected = await runRead(engine, operations, 'hoi4.probability_inspect', {
      workspaceId: 'fixture',
      customPoolManifest,
    });
    expect(inspected.result).toMatchObject({
      structuredContent: { status: 'ok', code: 'PROBABILITY_SOURCE_INSPECTED' },
    });
    expect(inspected.staged).toEqual([inspected.result]);
    const evaluated = await runRead(engine, operations, 'hoi4.probability_evaluate', {
      workspaceId: 'fixture',
      customPoolManifest,
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'inprocess-scenarios',
        scenarios: [{ id: 'available', state: { available: true } }],
      },
    });
    expect(evaluated.result).toMatchObject({
      structuredContent: { status: 'ok', code: 'PROBABILITY_ANALYZED' },
    });
    expect(evaluated.staged).toEqual([evaluated.result]);
    const analysisId = (evaluated.result.structuredContent as { data: { analysisId: string } }).data
      .analysisId;
    const rendered = await runRead(engine, operations, 'hoi4.probability_render', {
      workspaceId: 'fixture',
      analysisId,
      outputs: ['matrix', 'waterfall', 'threshold'],
      filter: { metrics: ['conditional_probability'] },
    });
    expect(rendered.result).toMatchObject({
      structuredContent: { status: 'ok', data: { operation: 'render' } },
    });
    expect(rendered.staged).toEqual([rendered.result]);
  }, 120_000);

  it('runs GUI inspection and rendering from a scoped fixture through the durable adapter', async () => {
    const { engine, operations } = await fixture('gui');
    const scenario = JSON.parse(
      await readFile(path.resolve('fixtures', 'gui', 'scenarios', 'baseline.json'), 'utf8'),
    ) as Record<string, unknown>;
    const inspected = await runRead(engine, operations, 'hoi4.gui_inspect', {
      workspaceId: 'fixture',
    });
    expect(inspected.result).toMatchObject({
      structuredContent: { status: 'ok', code: 'GUI_INSPECTED' },
    });
    expect(inspected.staged).toEqual([inspected.result]);
    const rendered = await runRead(engine, operations, 'hoi4.gui_render', {
      workspaceId: 'fixture',
      windowName: 'synthetic_gui_window',
      scenario,
      states: ['normal'],
      resolutions: [{ width: 960, height: 540, uiScale: 1 }],
      generatedScenarios: { enabled: false },
    });
    expect(rendered.result).toMatchObject({
      structuredContent: { status: 'ok', code: 'GUI_RENDERED' },
    });
    expect(rendered.staged).toEqual([rendered.result]);
  }, 120_000);

  it('runs map inspection and rendering without a transport or subprocess', async () => {
    const { engine, operations } = await fixture('map');
    const inspected = await runRead(engine, operations, 'hoi4.map_inspect', {
      workspaceId: 'fixture',
      includeOverview: false,
      provinceIds: [1],
    });
    expect(inspected.result).toMatchObject({
      structuredContent: { status: 'ok', code: 'MAP_INSPECTED' },
    });
    expect(inspected.staged).toEqual([inspected.result]);
    const rendered = await runRead(engine, operations, 'hoi4.map_render', {
      workspaceId: 'fixture',
      layer: 'province',
      scale: 1,
    });
    expect(rendered.result).toMatchObject({
      structuredContent: { status: 'ok', code: 'MAP_RENDERED' },
    });
    expect(rendered.staged).toEqual([rendered.result]);
  }, 120_000);

  it('returns a bounded tool error without staging when job scope does not match', async () => {
    const { engine, operations } = await fixture();
    const { result, staged } = await runRead(engine, operations, 'hoi4.focus_inspect', {
      workspaceId: 'another-workspace',
      relativePath: 'common/national_focus/inprocess.txt',
      treeId: 'inprocess_tree',
    });
    expect(result).toMatchObject({ isError: true });
    expect(staged).toEqual([]);
  });
});
