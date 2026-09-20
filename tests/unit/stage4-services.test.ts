import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { MechanicAnalyzer } from '../../src/hoi4_agent_tools/mechanic/service.js';
import { PackageAnalyzer } from '../../src/hoi4_agent_tools/package-check/service.js';
import { ScenarioAnalyzer } from '../../src/hoi4_agent_tools/scenario-suite/service.js';
import {
  mechanicTestRequestSchema,
  packageCheckRequestSchema,
  scenarioTestRequestSchema,
} from '../../src/hoi4_agent_tools/schemas/scenarios.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-stage4-'));
  roots.push(temporary);
  const mod = path.join(temporary, 'mod');
  const sourcePath = path.join(mod, 'common', 'scripted_effects', 'ledger.txt');
  const source =
    'transfer = { subtract_from_variable = { treasury = 3 } add_to_variable = { savings = 3 } } ' +
    'invoke_transfer = { transfer = yes } ' +
    'deceptive_payment = { add_political_power = -10 add_political_power = -10 add_political_power = 10 }';
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, source);
  await mkdir(path.join(mod, 'localisation', 'english'), { recursive: true });
  await writeFile(
    path.join(mod, 'localisation', 'english', 'ledger_l_english.yml'),
    '\ufeffl_english:\nledger_name: "Ledger"\n',
  );
  await mkdir(path.join(mod, 'tests'), { recursive: true });
  await writeFile(
    path.join(mod, 'tests', 'ledger_suite.json'),
    JSON.stringify({
      schemaVersion: '1.0',
      id: 'ledger-suite',
      cases: [
        {
          id: 'transfer_case',
          domain: 'mechanic',
          test: {
            id: 'transfer_case',
            scenario: {
              schemaVersion: '1.0',
              id: 'transfer_case',
              state: { treasury: 10, savings: 2 },
            },
            steps: [{ kind: 'effect', source: { kind: 'scripted_effect', id: 'transfer' } }],
            assertions: [
              { id: 'paid', kind: 'single_payment', balance: { key: 'treasury' }, cost: 3 },
            ],
          },
        },
      ],
    }),
  );
  await mkdir(path.join(mod, 'common', 'decisions'), { recursive: true });
  await writeFile(
    path.join(mod, 'common', 'decisions', 'payments.txt'),
    'actions = { engine_payment = { cost = 10 complete_effect = { set_country_flag = funded } } ' +
      'custom_payment = { custom_cost_trigger = { check_variable = { treasury = 3 compare = greater_than_or_equals } } ' +
      'complete_effect = { subtract_from_variable = { treasury = 3 } } } ' +
      'duplicate_payment = { cost = 10 complete_effect = { add_political_power = -10 } } }',
  );
  await mkdir(path.join(mod, 'gfx'), { recursive: true });
  await writeFile(path.join(mod, 'gfx', 'ledger.dds'), Buffer.from([1, 2, 3]));
  await mkdir(path.join(mod, 'interface'), { recursive: true });
  await writeFile(
    path.join(mod, 'interface', 'ledger.gfx'),
    'spriteTypes = { spriteType = { name = GFX_ledger texturefile = "gfx/ledger.dds" } } # GFX_comment_only',
  );
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(temporary, 'state'),
    workspaces: [{ id: 'fixture', name: 'Stage 4 fixture', root: mod }],
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  return { engine, configuration, sourcePath, source };
}

describe('Stage 4 source-backed services', () => {
  it('charges engine costs once, keeps custom payments explicit, and blocks duplicate cost paths', async () => {
    const { engine } = await fixture();
    const analyzer = new MechanicAnalyzer(engine);
    const testDecision = async (
      id: string,
      state: Record<string, number>,
      assertions: Record<string, unknown>[],
    ) =>
      analyzer.test(
        mechanicTestRequestSchema.parse({
          workspaceId: 'fixture',
          test: {
            id,
            scenario: { schemaVersion: '1.0', id, state },
            steps: [{ kind: 'effect', source: { kind: 'decision', id } }],
            assertions,
          },
        }),
      );
    const engineCost = await testDecision('engine_payment', { political_power: 30 }, [
      { id: 'one_payment', kind: 'single_payment', balance: { key: 'political_power' }, cost: 10 },
    ]);
    expect(engineCost.data).toMatchObject({ status: 'passed', passed: 1 });
    const customCost = await testDecision('custom_payment', { treasury: 10 }, [
      { id: 'one_payment', kind: 'single_payment', balance: { key: 'treasury' }, cost: 3 },
    ]);
    expect(customCost.data).toMatchObject({ status: 'passed', passed: 1 });
    const unaffordable = await testDecision('engine_payment', { political_power: 5 }, [
      { id: 'unchanged', kind: 'end_state', path: { key: 'political_power' }, expected: 5 },
    ]);
    expect(unaffordable.data).toMatchObject({ status: 'passed', passed: 1 });
    const duplicate = await testDecision('duplicate_payment', { political_power: 30 }, [
      { id: 'payment', kind: 'single_payment', balance: { key: 'political_power' }, cost: 10 },
    ]);
    expect(duplicate.data).toMatchObject({ status: 'unresolved' });
  });

  it('detects two deductions even when a grant hides the second charge', async () => {
    const { engine } = await fixture();
    const result = await new MechanicAnalyzer(engine).test(
      mechanicTestRequestSchema.parse({
        workspaceId: 'fixture',
        test: {
          id: 'double-charge',
          scenario: { schemaVersion: '1.0', id: 'double-charge', state: { political_power: 30 } },
          steps: [{ kind: 'effect', source: { kind: 'scripted_effect', id: 'deceptive_payment' } }],
          assertions: [
            {
              id: 'one_charge',
              kind: 'single_payment',
              balance: { key: 'political_power' },
              cost: 10,
            },
          ],
        },
      }),
    );
    expect(result.data).toMatchObject({ status: 'failed', failed: 1 });
  });

  it('runs declared mechanic assertions and leaves the source untouched', async () => {
    const { engine, sourcePath, source } = await fixture();
    const request = mechanicTestRequestSchema.parse({
      workspaceId: 'fixture',
      test: {
        id: 'transfer',
        scenario: { schemaVersion: '1.0', id: 'transfer', state: { treasury: 10, savings: 2 } },
        steps: [{ kind: 'effect', source: { kind: 'scripted_effect', id: 'transfer' } }],
        assertions: [
          {
            id: 'conserved',
            kind: 'conservation',
            paths: [{ key: 'treasury' }, { key: 'savings' }],
          },
          { id: 'paid', kind: 'single_payment', balance: { key: 'treasury' }, cost: 3 },
        ],
      },
    });
    const result = await new MechanicAnalyzer(engine).test(request);
    expect(result.data).toMatchObject({ status: 'passed', passed: 2, failed: 0 });
    const artifact = await engine.artifacts.readLogical(
      engine.resolver.get('fixture'),
      result.artifacts[0]!.uri,
      { mimeType: 'application/json', maxBytes: 1_000_000, maxChunks: 32 },
    );
    expect(JSON.parse(artifact.bytes.toString('utf8'))).toMatchObject({
      finalState: { state: { treasury: 7, savings: 5 } },
    });
    expect(await readFile(sourcePath, 'utf8')).toBe(source);
  });

  it('reports a missing package connection and preserves source', async () => {
    const { engine, sourcePath, source } = await fixture();
    const manifest = {
      schemaVersion: '1.0',
      id: 'ledger',
      definitions: [
        { kind: 'scripted_effect', id: 'transfer' },
        { kind: 'idea', id: 'missing_idea' },
      ],
      assets: ['gfx/ledger.dds'],
      registrations: [
        { path: 'interface/ledger.gfx', token: 'GFX_ledger' },
        { path: 'interface/ledger.gfx', token: 'GFX_comment_only' },
      ],
    };
    const result = await new PackageAnalyzer(engine).check(
      packageCheckRequestSchema.parse({ workspaceId: 'fixture', manifest }),
    );
    expect(result.data).toMatchObject({ complete: false, present: 3, absent: 2 });
    expect(await readFile(sourcePath, 'utf8')).toBe(source);
  });

  it('resolves helper calls, localisation, assets, registrations, and required cases', async () => {
    const { engine } = await fixture();
    const result = await new PackageAnalyzer(engine).check(
      packageCheckRequestSchema.parse({
        workspaceId: 'fixture',
        manifest: {
          schemaVersion: '1.0',
          id: 'ledger',
          definitions: [
            { kind: 'scripted_effect', id: 'transfer' },
            { kind: 'scripted_effect', id: 'invoke_transfer' },
          ],
          calls: [
            {
              from: { kind: 'scripted_effect', id: 'invoke_transfer' },
              to: { kind: 'scripted_effect', id: 'transfer' },
            },
          ],
          registrations: [{ path: 'interface/ledger.gfx', token: 'GFX_ledger' }],
          localisation: ['ledger_name'],
          assets: ['gfx/ledger.dds'],
          requiredCases: [{ suite: 'tests/ledger_suite.json', caseId: 'transfer_case' }],
        },
      }),
    );
    expect(result.data).toMatchObject({ complete: true, present: 7, absent: 0, unresolved: 0 });
  });

  it('pages every named case with a signed, source-bound continuation', async () => {
    const { engine, configuration, sourcePath, source } = await fixture();
    const suite = {
      schemaVersion: '1.0',
      id: 'ledger-suite',
      cases: [
        {
          id: 'mechanic',
          domain: 'mechanic',
          test: {
            id: 'transfer',
            scenario: { schemaVersion: '1.0', id: 'transfer', state: { treasury: 10, savings: 2 } },
            steps: [{ kind: 'effect', source: { kind: 'scripted_effect', id: 'transfer' } }],
            assertions: [
              { id: 'payment', kind: 'single_payment', balance: { key: 'treasury' }, cost: 3 },
            ],
          },
        },
        {
          id: 'package',
          domain: 'package',
          manifest: {
            schemaVersion: '1.0',
            id: 'ledger',
            definitions: [{ kind: 'scripted_effect', id: 'transfer' }],
          },
        },
        {
          id: 'decision_inventory',
          domain: 'tool',
          tool: 'hoi4.decision_inspect',
          arguments: {},
          assertions: [{ id: 'three_decisions', path: ['data', 'decisions'], expected: 3 }],
        },
      ],
    };
    const analyzer = new ScenarioAnalyzer(engine);
    const first = await analyzer.test(
      scenarioTestRequestSchema.parse({
        workspaceId: 'fixture',
        suite,
        maxCases: 1,
      }),
    );
    expect(first.data).toMatchObject({ start: 0, end: 1, total: 3, pending: 2 });
    expect(first.data.continuation).toBeDefined();
    const recovered = new ScenarioAnalyzer(
      new CoreEngine(await WorkspaceResolver.create(configuration)),
    );
    const second = await recovered.test(
      scenarioTestRequestSchema.parse({
        workspaceId: 'fixture',
        suite,
        maxCases: 1,
        continuation: first.data.continuation,
      }),
    );
    expect(second.data).toMatchObject({ start: 1, end: 2, pending: 1 });
    const third = await recovered.test(
      scenarioTestRequestSchema.parse({
        workspaceId: 'fixture',
        suite,
        maxCases: 1,
        continuation: second.data.continuation,
      }),
    );
    expect(third.data).toMatchObject({ start: 2, end: 3, pending: 0, failed: 0, unresolved: 0 });
    expect(third.data.continuation).toBeUndefined();
    await expect(
      analyzer.test(
        scenarioTestRequestSchema.parse({
          workspaceId: 'fixture',
          suite,
          maxCases: 1,
          continuation: first.data.continuation!.slice(0, -1) + '0',
        }),
      ),
    ).rejects.toMatchObject({ code: 'SCENARIO_CONTINUATION_INVALID' });
    await expect(
      analyzer.test({
        ...scenarioTestRequestSchema.parse({
          workspaceId: 'fixture',
          suite,
          maxCases: 1,
          continuation: first.data.continuation,
        }),
        principal: 'different-caller',
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_INACCESSIBLE' });
    await writeFile(sourcePath, `${source} # changed revision`);
    await expect(
      analyzer.test(
        scenarioTestRequestSchema.parse({
          workspaceId: 'fixture',
          suite,
          maxCases: 1,
          refresh: true,
          continuation: first.data.continuation,
        }),
      ),
    ).rejects.toMatchObject({ code: 'SCENARIO_CONTINUATION_STALE' });
    await writeFile(sourcePath, source);
    expect(await readFile(sourcePath, 'utf8')).toBe(source);
  });

  it('resumes a bounded suite through every case without dropping failures', async () => {
    const { engine } = await fixture();
    const suite = {
      schemaVersion: '1.0',
      id: 'bounded-suite',
      cases: Array.from({ length: 65 }, (_, index) => ({
        id: `case_${index}`,
        domain: 'mechanic',
        test: {
          id: `transfer_${index}`,
          scenario: {
            schemaVersion: '1.0',
            id: `case_${index}`,
            state: { treasury: 10, savings: 2 },
          },
          steps: [{ kind: 'effect', source: { kind: 'scripted_effect', id: 'transfer' } }],
          assertions: [
            {
              id: 'paid',
              kind: 'single_payment',
              balance: { key: 'treasury' },
              cost: index === 0 ? 4 : 3,
            },
          ],
        },
      })),
    };
    const analyzer = new ScenarioAnalyzer(engine);
    let continuation: string | undefined;
    const seen: number[] = [];
    for (let page = 0; page < 3; page += 1) {
      const result = await analyzer.test(
        scenarioTestRequestSchema.parse({
          workspaceId: 'fixture',
          suite,
          maxCases: 32,
          ...(continuation === undefined ? {} : { continuation }),
        }),
      );
      for (let index = result.data.start; index < result.data.end; index += 1) seen.push(index);
      continuation = result.data.continuation;
      if (page < 2) expect(continuation).toBeDefined();
      else {
        expect(result.data).toMatchObject({ pending: 0, failed: 1, unresolved: 0 });
        expect(result.code).toBe('SCENARIO_SUITE_INCOMPLETE');
      }
    }
    expect(seen).toEqual(Array.from({ length: 65 }, (_, index) => index));
  });

  it('rejects executable manifest fields and unlisted suite operations', () => {
    expect(
      packageCheckRequestSchema.safeParse({
        workspaceId: 'fixture',
        manifest: { schemaVersion: '1.0', id: 'bad', command: 'write source' },
      }).success,
    ).toBe(false);
    expect(
      scenarioTestRequestSchema.safeParse({
        workspaceId: 'fixture',
        suite: {
          schemaVersion: '1.0',
          id: 'bad',
          cases: [{ id: 'mutation', domain: 'tool', tool: 'hoi4.map_rewrite', arguments: {} }],
        },
      }).success,
    ).toBe(false);
  });
});
