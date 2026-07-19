import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/hoi4_agent_tools/core/artifacts.js';
import { compareCodeUnits, sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import { parseClausewitz } from '../../src/hoi4_agent_tools/core/source/index.js';
import { TransactionManager } from '../../src/hoi4_agent_tools/core/transactions.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { nativeFocusEffectKeys } from '../../src/hoi4_agent_tools/focus/native-effects.js';
import { focusTreePlanSchema } from '../../src/hoi4_agent_tools/schemas/focus.js';

const postValidate = () =>
  Promise.resolve({
    diagnostics: [],
    checks: [{ id: 'focus-test-post-write', passed: true, message: 'Fixture revalidated' }],
  });
import {
  FOCUS_PLAN_SCHEMA_VERSION,
  FocusWorkbench,
  compileFocusTree,
  compactFocusTreePlan,
  compileContinuousFocusPalette,
  compileContinuousFocusPaletteWithSourceMap,
  assertFocusPlanAuthority,
  assertCompactLayoutQuality,
  createFocusPlanningSidecar,
  enrichFocusPlanFromSidecar,
  detectContinuousFocusDrift,
  detectFocusDrift,
  focusPlanHash,
  importFocusTrees,
  importContinuousFocusPalettes,
  linkContinuousFocusPalettes,
  layoutFocusTree,
  layoutFocusTreeAsync,
  lintFocusTree,
  renderFocusTree,
  renderContinuousFocusPalette,
  storeFocusRenderArtifacts,
  updateContinuousFocusPaletteSource,
  updateFocusTreeSource,
  type FocusNodePlan,
  type FocusLayoutResult,
  type FocusPosition,
  type FocusTreePlan,
  type RawClausewitzBlock,
} from '../../src/hoi4_agent_tools/focus/index.js';

const sampleSource = `# fixture tree
focus_tree = {
\tid = fixture_tree
\tcountry = {
\t\tfactor = 0
\t\tmodifier = { add = 10 original_tag = AAA }
\t}
\tcontinuous_focus_position = { x = 1200 y = 100 }
\tcustom_tree_field = { preserve = exactly }

\tfocus = {
\t\tid = root
\t\ticon = GFX_root
\t\tx = 0
\t\ty = 0
\t\t# This comment must survive a targeted scalar rewrite.
\t\tcost = 5
\t\tsearch_filters = { FOCUS_FILTER_POLITICAL }
\t\tai_will_do = { base = 5 }
\t\tcompletion_reward = {
\t\t\tactivate_decision = fixture_decision
\t\t\tactivate_decision = form_fixture_country
\t\t\tunlock_decision_category_tooltip = fixture_decision_category
\t\t\tcountry_event = { id = fixture.1 }
\t\t\tadd_ideas = fixture_idea
\t\t\trecruit_character = fixture_leader
\t\t\tset_cosmetic_tag = FIXTURE_COSMETIC
\t\t\tfixture_helper = yes
\t\t}
\t\tcustom_focus_field = { preserve = this_too }
\t}

\tfocus = {
\t\tid = alternate
\t\ticon = GFX_alternate
\t\tx = 4
\t\ty = 0
\t\tsearch_filters = { FOCUS_FILTER_POLITICAL }
\t\tcompletion_reward = { add_stability = 0.05 }
\t}

\tfocus = {
\t\tid = gate
\t\ticon = GFX_gate
\t\tx = 8
\t\ty = 0
\t\tsearch_filters = { FOCUS_FILTER_INDUSTRY }
\t\tcompletion_reward = { add_war_support = 0.05 }
\t}

\tfocus = {
\t\tid = excluded
\t\ticon = GFX_excluded
\t\tx = 12
\t\ty = 0
\t\tsearch_filters = { FOCUS_FILTER_INDUSTRY }
\t\tcompletion_reward = { add_political_power = 25 }
\t}

\tfocus = {
\t\tid = child
\t\ticon = GFX_child
\t\tprerequisite = { focus = root focus = alternate }
\t\tprerequisite = { focus = gate }
\t\tmutually_exclusive = { focus = excluded }
\t\tx = 2
\t\ty = 2
\t\trelative_position_id = root
\t\tavailable = { has_completed_focus = root }
\t\tallow_branch = { has_completed_focus = root }
\t\tsearch_filters = { FOCUS_FILTER_POLITICAL FOCUS_FILTER_INDUSTRY }
\t\tcompletion_reward = { activate_decision = child_decision }
\t}
}
`;

const rawReward = (text = '{ add_political_power = 50 }'): RawClausewitzBlock => ({
  text,
  referencedFocusIds: [],
});

function focusNode(
  id: string,
  position: FocusPosition,
  overrides: Partial<FocusNodePlan> = {},
): FocusNodePlan {
  return {
    id,
    label: id,
    prerequisites: { operator: 'and', groups: [] },
    mutuallyExclusive: [],
    routeLocks: [],
    position,
    visibility: 'normal',
    convergence: false,
    sharedSupport: false,
    icons: [{ kind: 'static', sprite: 'GFX_fixture' }],
    localisation: { titleKey: id, descriptionKey: `${id}_desc` },
    ai: { majorRoute: false, strategyIds: [] },
    filters: ['FOCUS_FILTER_POLITICAL'],
    links: [],
    completionReward: rawReward(),
    rawPassthrough: [],
    ...overrides,
  };
}

function focusPlan(
  focuses: FocusNodePlan[],
  overrides: Partial<FocusTreePlan> = {},
): FocusTreePlan {
  const plan: FocusTreePlan = {
    schemaVersion: FOCUS_PLAN_SCHEMA_VERSION,
    id: 'layout_tree',
    default: false,
    branchGroups: [],
    laneGroups: [
      { id: 'left', label: 'Left lane', order: 0 },
      { id: 'right', label: 'Right lane', order: 1 },
      { id: 'default', label: 'Default lane', order: 2 },
    ],
    entryFocusIds: focuses
      .filter(({ prerequisites }) => prerequisites.groups.length === 0)
      .map(({ id }) => id),
    focuses,
    sharedFocusIds: [],
    continuousFocusPaletteIds: [],
    continuousFocusIds: [],
    rawPassthrough: [],
    provenance: {
      sourcePath: 'mod:common/national_focus/layout.txt',
      sourceHash: 'source-hash',
      importedPlanHash: '',
    },
    ...overrides,
  };
  plan.provenance.importedPlanHash = focusPlanHash(plan);
  return plan;
}

function abortSignalInside(stackFrame: string): {
  signal: AbortSignal;
  matched: () => boolean;
} {
  const controller = new AbortController();
  let matched = false;
  const signal = new Proxy(controller.signal, {
    get(target, property) {
      if (property === 'throwIfAborted') {
        return () => {
          if (!matched && new Error().stack?.includes(stackFrame) === true) {
            matched = true;
            controller.abort();
          }
          target.throwIfAborted();
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { signal, matched: () => matched };
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createFocusTransactionFixture(
  source: string,
  relativePath = 'common/national_focus/fixture.txt',
): Promise<{
  focusPath: string;
  resolver: WorkspaceResolver;
  transactions: TransactionManager;
  workbench: FocusWorkbench;
}> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-focus-source-update-'));
  temporaryRoots.push(temporary);
  const modRoot = path.join(temporary, 'mod');
  const focusPath = path.join(modRoot, ...relativePath.split('/'));
  const focusDirectory = path.dirname(focusPath);
  await mkdir(focusDirectory, { recursive: true });
  await writeFile(focusPath, source, 'utf8');
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(temporary, 'server-state'),
    workspaces: [
      {
        id: 'fixture',
        name: 'Fixture',
        root: modRoot,
        kind: 'mod',
      },
    ],
  });
  const resolver = await WorkspaceResolver.create(configuration);
  const transactions = new TransactionManager(resolver);
  return {
    focusPath,
    resolver,
    transactions,
    workbench: new FocusWorkbench(resolver, transactions),
  };
}

describe('Focus Tree Workbench import and drift', () => {
  it('accepts decision-category links in the public focus-plan schema', () => {
    const plan = focusPlan(
      [
        focusNode(
          'root',
          { mode: 'fixed', x: 0, y: 0, pinned: true },
          {
            links: [{ kind: 'decision_category', target: 'fixture_category' }],
          },
        ),
      ],
      {
        provenance: {
          sourcePath: 'mod:common/national_focus/schema-fixture.txt',
          sourceHash: '0'.repeat(64),
          importedPlanHash: '',
        },
      },
    );

    expect(focusTreePlanSchema.safeParse(plan).success).toBe(true);
  });

  it('ships the reviewed current native-effect identifier catalog', () => {
    expect(nativeFocusEffectKeys.size).toBe(553);
    for (const key of [
      'activate_decision',
      'add_divisional_commander_xp',
      'add_history_entry',
      'add_random_valid_trait_from_unit',
      'add_unit_medal_to_latest_entry',
      'change_division_template',
      'destroy_unit',
      'if',
      'promote_officer_to_general',
      'random_list',
      'reseed_division_commander',
      'set_cosmetic_tag',
      'set_unit_organization',
      'unlock_decision_category_tooltip',
    ]) {
      expect(nativeFocusEffectKeys.has(key)).toBe(true);
    }
    expect(nativeFocusEffectKeys.has('scripted_effect')).toBe(false);
    expect(nativeFocusEffectKeys.has('form_country')).toBe(false);
  });

  it('imports explicit prerequisite semantics, planning fields, links, and raw passthrough', () => {
    const document = parseClausewitz(
      Buffer.from(sampleSource),
      'mod:common/national_focus/fixture.txt',
    );
    const imported = importFocusTrees(document);
    expect(imported.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
    expect(imported.plans).toHaveLength(1);
    const plan = imported.plans[0];
    expect(plan).toBeDefined();
    if (plan === undefined) return;
    expect(plan.id).toBe('fixture_tree');
    expect(plan.countryAssignment?.countryTags).toEqual(['AAA']);
    expect(plan.continuousFocusPosition).toEqual({ x: 1200, y: 100 });
    expect(plan.rawPassthrough.map(({ key }) => key)).toContain('custom_tree_field');

    const root = plan.focuses.find(({ id }) => id === 'root');
    const child = plan.focuses.find(({ id }) => id === 'child');
    expect(root?.rawPassthrough.map(({ key }) => key)).toContain('custom_focus_field');
    expect(root?.links.map(({ kind, target }) => `${kind}:${target}`).sort()).toEqual([
      'decision:fixture_decision',
      'decision_category:fixture_decision_category',
      'event:fixture.1',
      'formable:form_fixture_country',
      'helper:fixture_helper',
      'idea:fixture_idea',
      'leader:fixture_leader',
    ]);
    expect(root?.links.some(({ target }) => target === 'FIXTURE_COSMETIC')).toBe(false);
    expect(child?.prerequisites).toEqual(
      expect.objectContaining({
        operator: 'and',
        groups: [
          expect.objectContaining({ operator: 'or', focusIds: ['root', 'alternate'] }),
          expect.objectContaining({ operator: 'or', focusIds: ['gate'] }),
        ],
      }),
    );
    expect(child?.position).toEqual({
      mode: 'relative',
      x: 2,
      y: 2,
      relativeTo: 'root',
      pinned: false,
    });
    expect(child?.visibility).toBe('conditional');
    expect(child?.routeLocks[0]?.requiredFocusIds).toEqual(['root']);
    expect(child?.routeLocks.map(({ field }) => field)).toEqual(['available', 'allow_branch']);

    const compiled = compileFocusTree(plan, layoutFocusTree(plan));
    expect(compiled).toContain('prerequisite = { focus = root focus = alternate }');
    expect(compiled).toContain('prerequisite = { focus = gate }');
    expect(compiled).toContain('custom_tree_field = { preserve = exactly }');
    expect(compiled).toContain('custom_focus_field = { preserve = this_too }');
    expect(compiled).not.toMatch(/^\s*(?:hidden|crisis)\s*=/mu);
  });

  it('preserves symbolic, numeric-lexeme, and unmodelled costs across targeted updates', () => {
    const source = [
      '@symbolic_focus_cost = 6',
      'focus_tree = {',
      '\tid = cost_round_trip',
      '\tfocus = {',
      '\t\tid = symbolic',
      '\t\tx = 0',
      '\t\ty = 0',
      '\t\tcost = @symbolic_focus_cost # preserve symbolic lexeme',
      '\t}',
      '\tfocus = {',
      '\t\tid = numeric',
      '\t\tx = 2',
      '\t\ty = 0',
      '\t\tcost = 5.000 # preserve numeric lexeme',
      '\t}',
      '\tfocus = {',
      '\t\tid = unmodelled',
      '\t\tx = 4',
      '\t\ty = 0',
      '\t\tcost = constant:legacy_cost # preserve unmodelled source',
      '\t}',
      '}',
      '',
    ].join('\n');
    const document = parseClausewitz(Buffer.from(source), 'mod:cost-round-trip.txt');
    const current = importFocusTrees(document).plans[0]!;
    expect(current.focuses.map(({ cost }) => cost)).toEqual(['@symbolic_focus_cost', 5, undefined]);
    expect(focusTreePlanSchema.safeParse(current).success).toBe(true);

    const moved = structuredClone(current);
    for (const focus of moved.focuses) {
      if (focus.position.mode !== 'fixed') throw new Error('Expected fixed fixture position');
      focus.position.x += 1;
      focus.position.y += 1;
    }
    const movedSource = updateFocusTreeSource(document, current, moved, layoutFocusTree(moved));
    const expectedMoved = source
      .replace('\t\tx = 0\n\t\ty = 0', '\t\tx = 1\n\t\ty = 1')
      .replace('\t\tx = 2\n\t\ty = 0', '\t\tx = 3\n\t\ty = 1')
      .replace('\t\tx = 4\n\t\ty = 0', '\t\tx = 5\n\t\ty = 1');
    expect(movedSource.equals(Buffer.from(expectedMoved))).toBe(true);
    expect(movedSource.toString('utf8')).toContain('cost = @symbolic_focus_cost #');
    expect(movedSource.toString('utf8')).toContain('cost = 5.000 #');
    expect(movedSource.toString('utf8')).toContain('cost = constant:legacy_cost #');

    const changed = structuredClone(current);
    changed.focuses.find(({ id }) => id === 'symbolic')!.cost = 7;
    changed.focuses.find(({ id }) => id === 'numeric')!.cost = '@replacement_focus_cost';
    const changedSource = updateFocusTreeSource(
      document,
      current,
      changed,
      layoutFocusTree(changed),
    );
    expect(changedSource.toString('utf8')).toContain('cost = 7 # preserve symbolic lexeme');
    expect(changedSource.toString('utf8')).toContain(
      'cost = @replacement_focus_cost # preserve numeric lexeme',
    );
    expect(changedSource.toString('utf8')).toContain(
      'cost = constant:legacy_cost # preserve unmodelled source',
    );
    const changedPlan = importFocusTrees(parseClausewitz(changedSource, 'mod:cost-round-trip.txt'))
      .plans[0]!;
    expect(changedPlan.focuses.map(({ cost }) => cost)).toEqual([
      7,
      '@replacement_focus_cost',
      undefined,
    ]);

    const unsafe = structuredClone(current) as FocusTreePlan & {
      focuses: Array<FocusNodePlan & { cost?: number | string }>;
    };
    unsafe.focuses[0]!.cost = '@unsafe-name';
    expect(focusTreePlanSchema.safeParse(unsafe).success).toBe(false);
    expect(() => compileFocusTree(unsafe as FocusTreePlan, layoutFocusTree(unsafe))).toThrowError(
      expect.objectContaining({ code: 'FOCUS_COST_INVALID' }),
    );
  });

  it('finds nested scripted effects without treating controls or scopes as helpers', () => {
    const source = `focus_tree = {
\tid = helper_links
\tfocus = {
\t\tid = root
\t\tx = 0
\t\ty = 0
\t\tcompletion_reward = {
\t\t\tIF = {
\t\t\t\tlimit = { always = yes }
\t\t\t\tknown_block_helper = { amount = 2 }
\t\t\t\trandom_list = {
\t\t\t\t\t10 = {
\t\t\t\t\t\tmodifier = { factor = 2 has_war = yes }
\t\t\t\t\t\tmissing_helper = yes
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\t123 = { add_stability = 0.01 }
\t\t\t\tSOV_iosif_stalin = { add_war_support = 0.01 }
\t\t\t\tfor_each_loop = {
\t\t\t\t\tarray = fixture_values
\t\t\t\t\tvalue = fixture_value
\t\t\t\t\tindex = fixture_index
\t\t\t\t\tbreak = fixture_break
\t\t\t\t\tmissing_loop_helper = yes
\t\t\t\t}
\t\t\t}
\t\t\tset_cosmetic_tag = FIXTURE_COSMETIC
\t\t}
\t}
}`;
    const imported = importFocusTrees(
      parseClausewitz(Buffer.from(source), 'mod:common/national_focus/helpers.txt'),
      {
        references: {
          helper: ['known_block_helper'],
          leader: ['SOV_iosif_stalin'],
        },
      },
    );
    const importedPlan = imported.plans[0];
    expect(importedPlan?.focuses[0]?.links.map(({ kind, target }) => `${kind}:${target}`)).toEqual([
      'helper:known_block_helper',
      'helper:missing_helper',
      'helper:missing_loop_helper',
    ]);
    if (importedPlan === undefined) return;
    const missing = lintFocusTree(importedPlan, {
      references: {
        helper: ['known_block_helper'],
        leader: ['SOV_iosif_stalin'],
      },
    }).filter(({ code }) => code === 'FOCUS_GAMEPLAY_REFERENCE_MISSING');
    expect(missing.map(({ details }) => details)).toEqual([
      { kind: 'helper', target: 'missing_helper' },
      { kind: 'helper', target: 'missing_loop_helper' },
    ]);
  });

  it('follows effect-container grammar without swallowing helpers or tooltip bindings', () => {
    const source = `focus_tree = {
\tid = helper_grammar
\tfocus = {
\t\tid = root
\t\tx = 0
\t\ty = 0
\t\tcompletion_reward = {
\t\t\trandom_reward_helper = { amount = 2 }
\t\t\trandom_list = {
\t\t\t\tlog = yes
\t\t\t\tseed = random
\t\t\t\tweight_var = { missing_weight_helper = yes }
\t\t\t}
\t\t\tglobal_every_army_leader = {
\t\t\t\tlimit = { always = yes }
\t\t\t\tdisplay_individual_scopes = yes
\t\t\t\tinclude_invisible = yes
\t\t\t\trandom_select_amount = 2
\t\t\t\tmissing_leader_helper = yes
\t\t\t}
\t\t\thidden_effect = {
\t\t\t\tadd_history_entry = {
\t\t\t\t\tkey = fixture_history
\t\t\t\t\tsubject = "Fixture history"
\t\t\t\t\tallow = yes
\t\t\t\t}
\t\t\t}
\t\t\tcustom_effect_tooltip = {
\t\t\t\tlocalization_key = fixture_tooltip
\t\t\t\tCHARACTER = SOV_effect_character
\t\t\t}
\t\t\tcustom_override_tooltip = {
\t\t\t\ttooltip = {
\t\t\t\t\tlocalization_key = fixture_override
\t\t\t\t\tANSWER = 42
\t\t\t\t}
\t\t\t\tmissing_override_helper = yes
\t\t\t}
\t\t\tstate:my_effect_state = { add_stability = 0.01 }
\t\t\tSOV_effect_character = { add_war_support = 0.01 }
\t\t\tmissing_block_helper = { amount = 3 }
\t\t\trandom_missing_helper = { amount = 4 }
\t\t}
\t}
}`;
    const imported = importFocusTrees(
      parseClausewitz(Buffer.from(source), 'mod:common/national_focus/helper-grammar.txt'),
      {
        references: {
          helper: ['random_reward_helper'],
          leader: ['SOV_effect_character'],
        },
      },
    );

    expect(
      imported.plans[0]?.focuses[0]?.links.map(({ kind, target }) => `${kind}:${target}`),
    ).toEqual([
      'helper:random_reward_helper',
      'helper:missing_weight_helper',
      'helper:missing_leader_helper',
      'helper:missing_override_helper',
      'helper:missing_block_helper',
      'helper:random_missing_helper',
    ]);
  });

  it('extracts documented decision, mission, idea, event, and formable reference forms', () => {
    const source = `focus_tree = {
\tid = reference_forms
\tfocus = {
\t\tid = root
\t\tx = 0
\t\ty = 0
\t\tcompletion_reward = {
\t\t\tunlock_decision_tooltip = { decision = fixture_unlock show_effect_tooltip = yes }
\t\t\tactivate_targeted_decision = { target = AAA decision = fixture_targeted }
\t\t\tremove_targeted_decision = { target = AAA decision = fixture_remove_targeted }
\t\t\tremove_decision_on_cooldown = fixture_cooldown
\t\t\tactivate_mission = fixture_activate_mission
\t\t\tremove_mission = fixture_remove_mission
\t\t\tadd_days_mission_timeout = { mission = fixture_extended_mission days = 5 }
\t\t\tactivate_decision = reform_country_economy
\t\t\tactivate_decision = form_unknown_union
\t\t\tunlock_decision_category_tooltip = fixture_category
\t\t\tswap_ideas = { remove_idea = fixture_old_idea add_idea = fixture_new_idea }
\t\t\tshow_ideas_tooltip = fixture_shown_idea
\t\t\tmodify_timed_idea = { idea = fixture_timed_idea days = 5 }
\t\t\tcountry_event = { id = fixture.1 hours = 1 }
\t\t}
\t}
}`;
    const imported = importFocusTrees(
      parseClausewitz(Buffer.from(source), 'mod:common/national_focus/references.txt'),
      {
        references: {
          decision: ['reform_country_economy'],
          formable: [],
        },
      },
    );

    expect(
      imported.plans[0]?.focuses[0]?.links.map(({ kind, target }) => `${kind}:${target}`).sort(),
    ).toEqual(
      [
        'decision:fixture_activate_mission',
        'decision:fixture_cooldown',
        'decision:fixture_extended_mission',
        'decision:fixture_remove_mission',
        'decision:fixture_remove_targeted',
        'decision:fixture_targeted',
        'decision:fixture_unlock',
        'decision:reform_country_economy',
        'decision_category:fixture_category',
        'event:fixture.1',
        'formable:form_unknown_union',
        'idea:fixture_new_idea',
        'idea:fixture_old_idea',
        'idea:fixture_shown_idea',
        'idea:fixture_timed_idea',
      ].sort(),
    );
  });

  it('propagates authoritative reference catalogs through import, drift, and dry-run validation', async () => {
    const source = `focus_tree = {
\tid = catalog_propagation
\tfocus = {
\t\tid = root
\t\tx = 0
\t\ty = 0
\t\tcost = 5
\t\tcompletion_reward = { activate_decision = reform_country_economy }
\t}
}`;
    const relativePath = 'common/national_focus/catalog-propagation.txt';
    const { workbench } = await createFocusTransactionFixture(source, relativePath);
    const references = {
      decision: ['reform_country_economy'],
      formable: [],
    } as const;
    const imported = await workbench.importPath(
      'fixture',
      relativePath,
      undefined,
      undefined,
      references,
    );
    const plan = imported.result.plans[0];
    expect(plan?.focuses[0]?.links).toEqual([
      expect.objectContaining({ kind: 'decision', target: 'reform_country_economy' }),
    ]);
    if (plan === undefined) return;
    expect(
      detectFocusDrift(plan, imported.document, references).currentSourcePlan?.focuses[0]?.links,
    ).toEqual([expect.objectContaining({ kind: 'decision', target: 'reform_country_economy' })]);

    plan.focuses[0]!.cost = 6;
    const planned = await workbench.planChanges({
      workspaceId: 'fixture',
      relativePath,
      plan,
      references,
    });
    expect(planned.transaction.validation.passed).toBe(true);
    expect(planned.drift.status).toBe('plan_changed');
  });

  it('imports, source-maps, renders, and safely updates continuous focus source', async () => {
    const source = `continuous_focus_palette = {
\tid = fixture_palette
\tcountry = { original_tag = AAA }
\treset_on_civilwar = no
\tposition = { x = 50 y = 1000 }

\tfocus = {
\t\tid = fixture_continuous
\t\ticon = GFX_fixture
\t\tenable = { always = yes }
\t\tmodifier = { army_org_factor = 0.05 }
\t\tdaily_cost = 1
\t}
}`;
    const document = parseClausewitz(
      Buffer.from(source),
      'mod:common/continuous_focus/fixture.txt',
    );
    const imported = importContinuousFocusPalettes(document);
    expect(imported.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
    const palette = imported.continuousFocusPalettes[0];
    expect(palette).toEqual(
      expect.objectContaining({
        id: 'fixture_palette',
        resetOnCivilWar: false,
        position: { x: 50, y: 1000 },
      }),
    );
    expect(palette?.focuses.map(({ id }) => id)).toEqual(['fixture_continuous']);
    expect(compileContinuousFocusPalette(palette!)).toBe(source);
    const compiled = compileContinuousFocusPaletteWithSourceMap(palette!);
    expect(compiled.source).toBe(source);
    expect(compiled.sourceMap).toMatchObject({
      treeId: 'fixture_palette',
      mappings: [
        expect.objectContaining({
          focusId: 'fixture_continuous',
          planNodeLocation: palette?.focuses[0]?.sourceLocation,
        }),
      ],
    });

    const target = structuredClone(palette!);
    target.resetOnCivilWar = true;
    target.focuses[0]!.icons = [{ kind: 'static', sprite: 'GFX_fixture_changed' }];
    const updated = updateContinuousFocusPaletteSource(document, palette, target);
    const updatedText = updated.toString('utf8');
    expect(updatedText).toContain('reset_on_civilwar = yes');
    expect(updatedText).toContain('icon = GFX_fixture_changed');
    expect(updatedText).toContain('modifier = { army_org_factor = 0.05 }');
    const reimported = importContinuousFocusPalettes(
      parseClausewitz(updated, 'mod:common/continuous_focus/fixture.txt'),
    ).continuousFocusPalettes[0];
    expect(reimported?.focuses[0]?.rawPassthrough.map(({ key }) => key)).toContain('modifier');

    const firstRender = await renderContinuousFocusPalette(palette!, []);
    const secondRender = await renderContinuousFocusPalette(palette!, []);
    expect(firstRender.hashes).toEqual(secondRender.hashes);
    expect(firstRender.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(JSON.parse(firstRender.json)).toMatchObject({
      kind: 'continuous-focus-palette',
      palette: { id: 'fixture_palette' },
      focuses: [{ id: 'fixture_continuous' }],
    });
  });

  it('links matching country palettes ahead of the default palette', () => {
    const palettes = importContinuousFocusPalettes(
      parseClausewitz(
        Buffer.from(`continuous_focus_palette = {
\tid = generic_palette
\tdefault = yes
\tfocus = { id = generic_continuous }
}
continuous_focus_palette = {
\tid = aaa_palette
\tcountry = { factor = 0 modifier = { add = 10 original_tag = AAA } }
\tfocus = { id = aaa_continuous }
}`),
        'mod:common/continuous_focus/palettes.txt',
      ),
    ).continuousFocusPalettes;
    const national = importFocusTrees(
      parseClausewitz(Buffer.from(sampleSource), 'mod:common/national_focus/fixture.txt'),
    ).plans[0]!;
    const linked = linkContinuousFocusPalettes(national, palettes);
    expect(linked.continuousFocusPaletteIds).toEqual(['aaa_palette']);
    expect(linked.continuousFocusIds).toEqual(['aaa_continuous']);
  });

  it('migrates invalid planner and continuous markers without re-emitting them', () => {
    const source = `focus_tree = {
\tid = legacy_markers
\tfocus = {
\t\tid = legacy_focus
\t\tx = 0
\t\ty = 0
\t\thidden = yes
\t\tcrisis = yes
\t\tcontinuous = yes
\t\tallow_branch = { has_country_flag = legacy_revealed }
\t}
}`;
    const imported = importFocusTrees(parseClausewitz(Buffer.from(source), 'mod:legacy.txt'));
    expect(imported.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'FOCUS_INVALID_VISIBILITY_MARKER',
        'FOCUS_INVALID_CONTINUOUS_MARKER',
      ]),
    );
    const legacyPlan = imported.plans[0]!;
    const compiled = compileFocusTree(legacyPlan, layoutFocusTree(legacyPlan));
    expect(compiled).not.toMatch(/^\s*(?:hidden|crisis|continuous)\s*=/mu);
    expect(compiled).toContain('allow_branch = { has_country_flag = legacy_revealed }');
    const invalidPlan = structuredClone(legacyPlan);
    invalidPlan.focuses[0]!.rawPassthrough.push({
      kind: 'assignment',
      key: 'continuous',
      order: 0,
      text: 'continuous = yes',
    });
    expect(() => compileFocusTree(invalidPlan, layoutFocusTree(invalidPlan))).toThrow(
      'planner-only or continuous metadata',
    );
  });

  it('compiles structured route locks and visibility only as valid trigger fields', () => {
    const gated = focusNode(
      'gated',
      { mode: 'fixed', x: 0, y: 0, pinned: true },
      {
        visibility: 'hidden',
        reveal: {
          kind: 'event',
          references: ['fixture.2'],
          trigger: { text: '{ has_country_flag = fixture_revealed }', referencedFocusIds: [] },
        },
        routeLocks: [
          {
            id: 'gated:available',
            field: 'available',
            mode: 'any',
            requiredFocusIds: ['left', 'right'],
            excludedFocusIds: [],
          },
        ],
      },
    );
    const plan = focusPlan([gated]);
    const compiled = compileFocusTree(plan, layoutFocusTree(plan));
    expect(compiled).toContain(
      'available = { OR = { has_completed_focus = left has_completed_focus = right } }',
    );
    expect(compiled).toContain('allow_branch = { has_country_flag = fixture_revealed }');
    expect(compiled).not.toMatch(/^\s*(?:hidden|crisis|continuous)\s*=/mu);
    const reimported = importFocusTrees(parseClausewitz(Buffer.from(compiled), 'mod:gated.txt'));
    expect(reimported.plans[0]?.focuses[0]?.routeLocks[0]).toEqual(
      expect.objectContaining({
        field: 'available',
        mode: 'any',
        requiredFocusIds: ['left', 'right'],
      }),
    );
    const sourcePlan = reimported.plans[0]!;
    const sidecarPlan = structuredClone(plan);
    sidecarPlan.provenance.sourcePath = sourcePlan.provenance.sourcePath;
    const sidecar = createFocusPlanningSidecar(sidecarPlan, sourcePlan.provenance.sourceHash);
    const enriched = enrichFocusPlanFromSidecar(sourcePlan, sidecar);
    expect(enriched.applied).toBe(true);
    expect(enriched.plan.focuses[0]?.visibility).toBe('hidden');
    const mismatched = enrichFocusPlanFromSidecar(sourcePlan, {
      ...sidecar,
      sourcePath: 'mod:other.txt',
    });
    expect(mismatched.applied).toBe(false);
    expect(mismatched.diagnostics.map(({ code }) => code)).toContain(
      'FOCUS_PLANNING_SIDECAR_SOURCE_MISMATCH',
    );
  });

  it('restores automatic layout intent from the source-bound planning sidecar', () => {
    const automatic = focusNode('automatic_round_trip', {
      mode: 'auto',
      pinned: false,
      preferredX: 6,
      preferredY: 4,
    });
    const planned = focusPlan([automatic]);
    const compiled = compileFocusTree(planned, layoutFocusTree(planned));
    const sourcePlan = importFocusTrees(
      parseClausewitz(Buffer.from(compiled), planned.provenance.sourcePath),
    ).plans[0]!;
    expect(sourcePlan.focuses[0]?.position.mode).toBe('fixed');
    const sidecarPlan = structuredClone(planned);
    sidecarPlan.provenance.sourcePath = sourcePlan.provenance.sourcePath;
    const sidecar = createFocusPlanningSidecar(sidecarPlan, sourcePlan.provenance.sourceHash);
    expect(sidecar.focuses[0]?.autoPosition).toEqual(automatic.position);
    const enriched = enrichFocusPlanFromSidecar(sourcePlan, sidecar);
    expect(enriched.applied).toBe(true);
    expect(enriched.plan.focuses[0]?.position).toEqual(automatic.position);
  });

  it('distinguishes plan changes, formatting drift, semantic drift, and conflicts', () => {
    const original = parseClausewitz(Buffer.from(sampleSource), 'mod:fixture.txt');
    const saved = importFocusTrees(original).plans[0];
    expect(saved).toBeDefined();
    if (saved === undefined) return;
    const clean = detectFocusDrift(saved, original);
    expect(clean.status).toBe('clean');
    expect(() => assertFocusPlanAuthority(clean, undefined)).not.toThrow();

    const changedPlan = structuredClone(saved);
    const root = changedPlan.focuses.find(({ id }) => id === 'root');
    expect(root).toBeDefined();
    if (root === undefined) return;
    root.cost = 7;
    expect(detectFocusDrift(changedPlan, original).status).toBe('plan_changed');

    const formatting = parseClausewitz(
      Buffer.from(sampleSource.replace('# fixture tree', '# fixture tree with a changed comment')),
      'mod:fixture.txt',
    );
    expect(detectFocusDrift(saved, formatting).status).toBe('source_changed_formatting');

    const semantic = parseClausewitz(
      Buffer.from(sampleSource.replace('cost = 5', 'cost = 6')),
      'mod:fixture.txt',
    );
    expect(detectFocusDrift(saved, semantic).status).toBe('source_changed_semantically');
    const conflict = detectFocusDrift(changedPlan, semantic);
    expect(conflict.status).toBe('conflict');
    expect(() => assertFocusPlanAuthority(conflict, 'plan')).not.toThrow();
    expect(() => assertFocusPlanAuthority(conflict, 'source')).toThrowError(
      expect.objectContaining({ code: 'FOCUS_SOURCE_AUTHORITATIVE' }),
    );
    expect(() => assertFocusPlanAuthority(conflict, undefined)).toThrowError(
      expect.objectContaining({ code: 'FOCUS_DRIFT_AUTHORITY_REQUIRED' }),
    );

    const convergedSource = parseClausewitz(
      Buffer.from(sampleSource.replace('cost = 5', 'cost = 7')),
      'mod:fixture.txt',
    );
    expect(detectFocusDrift(changedPlan, convergedSource)).toMatchObject({
      status: 'converged',
      requiresAuthority: false,
    });

    const locationFallback = structuredClone(saved);
    locationFallback.id = 'renamed_fixture_tree';
    expect(detectFocusDrift(locationFallback, original).currentSourcePlan?.id).toBe('fixture_tree');
    const singleTreeFallback = structuredClone(locationFallback);
    delete singleTreeFallback.sourceLocation;
    expect(detectFocusDrift(singleTreeFallback, original).currentSourcePlan?.id).toBe(
      'fixture_tree',
    );
    const removed = detectFocusDrift(
      saved,
      parseClausewitz(Buffer.from('# tree removed\n'), 'mod:fixture.txt'),
    );
    expect(removed).toMatchObject({ status: 'tree_removed', requiresAuthority: true });
  });

  it('classifies continuous-focus drift across every authority state', () => {
    const source = `continuous_focus_palette = {
\tid = drift_palette
\treset_on_civilwar = no
\tfocus = {
\t\tid = drift_focus
\t\ticon = GFX_drift
\t}
}
`;
    const original = parseClausewitz(Buffer.from(source), 'mod:continuous.txt');
    const saved = importContinuousFocusPalettes(original).continuousFocusPalettes[0];
    expect(saved).toBeDefined();
    if (saved === undefined) return;

    expect(detectContinuousFocusDrift(saved, original).status).toBe('clean');
    const changedPlan = structuredClone(saved);
    changedPlan.resetOnCivilWar = true;
    expect(detectContinuousFocusDrift(changedPlan, original).status).toBe('plan_changed');

    const formatting = parseClausewitz(
      Buffer.from(source.replace('id = drift_palette', 'id = drift_palette # comment')),
      'mod:continuous.txt',
    );
    expect(detectContinuousFocusDrift(saved, formatting).status).toBe('source_changed_formatting');

    const semantic = parseClausewitz(
      Buffer.from(source.replace('icon = GFX_drift', 'icon = GFX_drift_changed')),
      'mod:continuous.txt',
    );
    expect(detectContinuousFocusDrift(saved, semantic).status).toBe('source_changed_semantically');
    expect(detectContinuousFocusDrift(changedPlan, semantic).status).toBe('conflict');

    const converged = parseClausewitz(
      Buffer.from(source.replace('reset_on_civilwar = no', 'reset_on_civilwar = yes')),
      'mod:continuous.txt',
    );
    expect(detectContinuousFocusDrift(changedPlan, converged)).toMatchObject({
      status: 'converged',
      requiresAuthority: false,
    });

    const locationFallback = structuredClone(saved);
    locationFallback.id = 'renamed_drift_palette';
    expect(detectContinuousFocusDrift(locationFallback, original).currentSourcePlan?.id).toBe(
      'drift_palette',
    );
    const singlePaletteFallback = structuredClone(locationFallback);
    delete singlePaletteFallback.sourceLocation;
    expect(detectContinuousFocusDrift(singlePaletteFallback, original).currentSourcePlan?.id).toBe(
      'drift_palette',
    );
    expect(
      detectContinuousFocusDrift(
        saved,
        parseClausewitz(Buffer.from('# palette removed\n'), 'mod:continuous.txt'),
      ),
    ).toMatchObject({ status: 'tree_removed', requiresAuthority: true });
  });
});

describe('Focus Tree Workbench layout', () => {
  it('yields to the event loop and observes a real mid-layout abort', async () => {
    const focuses = [
      focusNode('timer_root', { mode: 'fixed', x: 0, y: 0, pinned: true }),
      ...Array.from({ length: 1_000 }, (_, index) =>
        focusNode(
          `timer_child_${String(index).padStart(3, '0')}`,
          { mode: 'auto', pinned: false, preferredX: 0, preferredY: 1 },
          {
            prerequisites: {
              operator: 'and',
              groups: [{ operator: 'or', focusIds: ['timer_root'], rawPassthrough: [] }],
            },
          },
        ),
      ),
    ];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 0);

    try {
      await expect(
        layoutFocusTreeAsync(focusPlan(focuses), { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      clearTimeout(timer);
    }
  });

  it('cancels cooperatively from inside automatic candidate evaluation', () => {
    const root = focusNode('cancel_root', { mode: 'fixed', x: 0, y: 0, pinned: true });
    const child = focusNode(
      'cancel_child',
      { mode: 'auto', pinned: false },
      {
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: ['cancel_root'], rawPassthrough: [] }],
        },
      },
    );
    const probe = abortSignalInside('crossingCountForCandidate');

    expect(() => layoutFocusTree(focusPlan([root, child]), { signal: probe.signal })).toThrow(
      /abort/i,
    );
    expect(probe.matched()).toBe(true);
  });

  it('blocks dense automatic placement when the shared layout work budget is exhausted', () => {
    const focuses = Array.from({ length: 2_000 }, (_, index) =>
      focusNode(`dense_${String(index).padStart(3, '0')}`, {
        mode: 'auto',
        pinned: false,
        preferredX: 0,
        preferredY: 0,
      }),
    );
    expect(() => layoutFocusTree(focusPlan(focuses))).toThrowError(
      expect.objectContaining({ code: 'FOCUS_LAYOUT_WORK_BUDGET_BLOCKED' }),
    );
  });

  it('is deterministic, preserves hard and previous coordinates, and keeps automatic nodes unique', () => {
    const root = focusNode('root', { mode: 'fixed', x: 0, y: 0, pinned: true });
    const fixed = focusNode('fixed', { mode: 'fixed', x: 12, y: 0, pinned: false });
    const relative = focusNode(
      'relative',
      { mode: 'relative', x: 2, y: 1, relativeTo: 'root', pinned: true },
      {
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: ['root'], rawPassthrough: [] }],
        },
      },
    );
    const left = focusNode(
      'left_auto',
      { mode: 'auto', pinned: false },
      {
        laneId: 'left',
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: ['root'], rawPassthrough: [] }],
        },
      },
    );
    const right = focusNode(
      'right_auto',
      { mode: 'auto', pinned: false },
      {
        laneId: 'right',
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: ['root'], rawPassthrough: [] }],
        },
      },
    );
    const deep = focusNode(
      'deep_auto',
      { mode: 'auto', pinned: false },
      {
        laneId: 'left',
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: ['left_auto'], rawPassthrough: [] }],
        },
      },
    );
    const plan = focusPlan([root, fixed, relative, left, right, deep]);
    const first = layoutFocusTree(plan);
    const repeated = layoutFocusTree(plan);
    expect(repeated.layoutHash).toBe(first.layoutHash);
    expect(repeated.nodes).toEqual(first.nodes);
    expect(first.nodes.find(({ id }) => id === 'root')).toEqual(
      expect.objectContaining({ x: 0, y: 0, preserved: true }),
    );
    expect(first.nodes.find(({ id }) => id === 'relative')).toEqual(
      expect.objectContaining({ x: 2, y: 1, preserved: true }),
    );
    expect(new Set(first.nodes.map(({ x, y }) => `${x},${y}`)).size).toBe(first.nodes.length);
    expect(first.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);

    const expanded = structuredClone(plan);
    expanded.focuses.push(
      focusNode(
        'new_auto',
        { mode: 'auto', pinned: false },
        {
          laneId: 'left',
          prerequisites: {
            operator: 'and',
            groups: [{ operator: 'or', focusIds: ['root'], rawPassthrough: [] }],
          },
        },
      ),
    );
    const incremental = layoutFocusTree(expanded, { previous: first });
    for (const previous of first.nodes) {
      expect(incremental.nodes.find(({ id }) => id === previous.id)).toEqual(
        expect.objectContaining({ x: previous.x, y: previous.y }),
      );
    }
    expect(new Set(incremental.nodes.map(({ x, y }) => `${x},${y}`)).size).toBe(
      incremental.nodes.length,
    );
  });

  it('balances sibling branches by lane order with deterministic mirror spacing', () => {
    const root = focusNode('symmetric_root', { mode: 'fixed', x: 0, y: 0, pinned: true });
    const lanes = ['route_a', 'route_b', 'route_c', 'route_d'];
    const children = lanes.map((laneId, index) =>
      focusNode(
        `symmetric_child_${String(4 - index)}`,
        { mode: 'auto', pinned: false },
        {
          laneId,
          prerequisites: {
            operator: 'and',
            groups: [{ operator: 'or', focusIds: [root.id], rawPassthrough: [] }],
          },
        },
      ),
    );
    const plan = focusPlan([root, ...children], {
      laneGroups: lanes.map((id, order) => ({ id, label: id, order })),
    });
    const layout = layoutFocusTree(plan);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    expect(children.map(({ id }) => byId.get(id)?.x)).toEqual([-3, -1, 1, 3]);
    expect(layout.metrics?.symmetry).toEqual(
      expect.objectContaining({
        siblingCohortCount: 1,
        asymmetricSiblingCohortCount: 0,
        maximumSiblingDeviation: 0,
      }),
    );
    expect(layout.metrics?.spacing).toEqual(
      expect.objectContaining({ requiredSameRowSpacing: 2, tooCloseSameRowPairCount: 0 }),
    );
  });

  it('measures two-child symmetry against the placed structural parent anchor', () => {
    const parent = focusNode('anchor_parent', { mode: 'fixed', x: 10, y: 0, pinned: true });
    const children = (coordinates: readonly number[]) =>
      coordinates.map((x, index) =>
        focusNode(
          `anchor_child_${String(index)}`,
          { mode: 'auto', pinned: false, preferredX: x, preferredY: 1 },
          {
            prerequisites: {
              operator: 'and',
              groups: [{ operator: 'or', focusIds: [parent.id], rawPassthrough: [] }],
            },
          },
        ),
      );

    const shifted = layoutFocusTree(focusPlan([parent, ...children([12, 14])]));
    expect(shifted.metrics?.symmetry).toEqual(
      expect.objectContaining({
        asymmetricSiblingCohortCount: 0,
        maximumSiblingDeviation: 0,
        offAnchorSiblingCohortCount: 1,
        maximumSiblingAnchorDeviation: 6,
      }),
    );
    expect(shifted.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'FOCUS_LAYOUT_SIBLING_ANCHOR_DEVIATION',
          details: expect.objectContaining({
            anchorX: 10,
            anchorKind: 'parent_median',
            deviation: 6,
          }),
        }),
      ]),
    );

    const balanced = layoutFocusTree(focusPlan([parent, ...children([9, 11])]));
    expect(balanced.metrics?.symmetry).toEqual(
      expect.objectContaining({
        asymmetricSiblingCohortCount: 0,
        maximumSiblingDeviation: 0,
        offAnchorSiblingCohortCount: 0,
        maximumSiblingAnchorDeviation: 0,
      }),
    );
  });

  it('reports objective focus-spacing and connector-length metrics', () => {
    const root = focusNode('metric_root', { mode: 'fixed', x: 0, y: 0, pinned: true });
    const adjacent = focusNode('metric_adjacent', {
      mode: 'fixed',
      x: 1,
      y: 0,
      pinned: true,
    });
    const distant = focusNode(
      'metric_distant',
      { mode: 'fixed', x: 12, y: 1, pinned: true },
      {
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: [root.id], rawPassthrough: [] }],
        },
      },
    );
    const layout = layoutFocusTree(focusPlan([root, adjacent, distant]));
    expect(layout.metrics?.spacing).toEqual(
      expect.objectContaining({
        requiredSameRowSpacing: 2,
        tooCloseSameRowPairCount: 1,
        minimumSameRowSpacing: 1,
      }),
    );
    expect(layout.metrics?.connectors).toEqual(
      expect.objectContaining({
        count: 1,
        longConnectorCount: 1,
        maximumHorizontalSpan: 12,
      }),
    );
    expect(layout.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FOCUS_LAYOUT_SAME_ROW_SPACING_UNSATISFIED' }),
        expect.objectContaining({ code: 'FOCUS_LAYOUT_LONG_CONNECTOR' }),
      ]),
    );
  });

  it('compacts an authored layout without worsening crossings, connector span, or spacing', () => {
    const root = focusNode('compact_root', { mode: 'fixed', x: 0, y: 0, pinned: true });
    const near = focusNode(
      'compact_near',
      { mode: 'fixed', x: -2, y: 1, pinned: true },
      {
        laneId: 'left',
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: [root.id], rawPassthrough: [] }],
        },
      },
    );
    const far = focusNode(
      'compact_far',
      { mode: 'fixed', x: 20, y: 1, pinned: true },
      {
        laneId: 'right',
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: [root.id], rawPassthrough: [] }],
        },
      },
    );
    const authored = focusPlan([root, near, far], {
      laneGroups: [
        { id: 'left', label: 'Left', order: 0, minimumX: -20, maximumX: 0 },
        { id: 'right', label: 'Right', order: 1, minimumX: 10, maximumX: 30 },
      ],
    });
    const before = layoutFocusTree(authored);
    const compactPlan = compactFocusTreePlan(authored);
    const after = layoutFocusTree(compactPlan);
    expect(compactPlan.focuses.every(({ position }) => position.mode === 'auto')).toBe(true);
    expect(
      compactPlan.laneGroups.every(
        ({ minimumX, maximumX }) => minimumX === undefined && maximumX === undefined,
      ),
    ).toBe(true);
    expect(() => assertCompactLayoutQuality(before, after)).not.toThrow();
    expect(after.metrics?.bounds.columnCount).toBeLessThan(before.metrics?.bounds.columnCount ?? 0);
    expect(after.metrics?.connectors.crossingCount).toBeLessThanOrEqual(
      before.metrics?.connectors.crossingCount ?? 0,
    );
    expect(after.metrics?.spacing.tooCloseSameRowPairCount).toBe(0);
    expect(compactFocusTreePlan(compactPlan).focuses.map(({ position }) => position)).toEqual(
      compactPlan.focuses.map(({ position }) => position),
    );
    const regressed = structuredClone(after);
    regressed.metrics!.connectors.crossingCount =
      (before.metrics?.connectors.crossingCount ?? 0) + 1;
    expect(() => assertCompactLayoutQuality(before, regressed)).toThrowError(
      expect.objectContaining({ code: 'FOCUS_COMPACT_QUALITY_BLOCKED' }),
    );
    for (const [field, value] of [
      ['nodeIntersectionCount', (before.metrics?.connectors.nodeIntersectionCount ?? 0) + 1],
      ['totalManhattanSpan', (before.metrics?.connectors.totalManhattanSpan ?? 0) + 1],
    ] as const) {
      const connectorRegression = structuredClone(after);
      connectorRegression.metrics!.connectors[field] = value;
      expect(() => assertCompactLayoutQuality(before, connectorRegression)).toThrowError(
        expect.objectContaining({ code: 'FOCUS_COMPACT_QUALITY_BLOCKED' }),
      );
    }
    const relativeMaximumBaseline = structuredClone(before);
    relativeMaximumBaseline.metrics!.connectors.maximumManhattanSpan = Math.max(
      0,
      after.metrics!.connectors.maximumManhattanSpan - 1,
    );
    expect(() => assertCompactLayoutQuality(relativeMaximumBaseline, after)).toThrowError(
      expect.objectContaining({
        code: 'FOCUS_COMPACT_QUALITY_BLOCKED',
        details: expect.objectContaining({
          regressions: expect.arrayContaining(['maximumManhattanConnectorSpan']),
        }),
      }),
    );
  });

  it('anchors compacted fixed sibling coordinates around their compacted parent', () => {
    const parent = focusNode('compact_anchor_parent', {
      mode: 'fixed',
      x: 10,
      y: 0,
      pinned: true,
    });
    const children = [12, 14].map((x, index) =>
      focusNode(
        `compact_anchor_child_${String(index)}`,
        { mode: 'fixed', x, y: 1, pinned: true },
        {
          prerequisites: {
            operator: 'and',
            groups: [{ operator: 'or', focusIds: [parent.id], rawPassthrough: [] }],
          },
        },
      ),
    );
    const compacted = compactFocusTreePlan(focusPlan([parent, ...children]));
    const layout = layoutFocusTree(compacted);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    const compactedParent = byId.get(parent.id)!;
    const compactedChildren = children.map(({ id }) => byId.get(id)!);

    expect(compactedChildren[0]!.x + compactedChildren[1]!.x).toBe(2 * compactedParent.x);
    expect(layout.metrics?.symmetry).toEqual(
      expect.objectContaining({
        asymmetricSiblingCohortCount: 0,
        maximumSiblingDeviation: 0,
        offAnchorSiblingCohortCount: 0,
        maximumSiblingAnchorDeviation: 0,
      }),
    );
  });

  it('uses the same configured lane anchors while compacting and measuring root cohorts', () => {
    const roots = [
      focusNode('lane_left_a', { mode: 'fixed', x: -12, y: 0, pinned: true }, { laneId: 'left' }),
      focusNode('lane_left_b', { mode: 'fixed', x: -10, y: 0, pinned: true }, { laneId: 'left' }),
      focusNode('lane_right_a', { mode: 'fixed', x: 10, y: 0, pinned: true }, { laneId: 'right' }),
      focusNode('lane_right_b', { mode: 'fixed', x: 12, y: 0, pinned: true }, { laneId: 'right' }),
    ];
    const authored = focusPlan(roots, {
      laneGroups: [
        { id: 'left', label: 'Left', order: 0 },
        { id: 'right', label: 'Right', order: 1 },
      ],
    });
    const compacted = compactFocusTreePlan(authored);
    const layout = layoutFocusTree(compacted);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));

    expect((byId.get('lane_left_a')?.x ?? 0) + (byId.get('lane_left_b')?.x ?? 0)).toBe(-8);
    expect((byId.get('lane_right_a')?.x ?? 0) + (byId.get('lane_right_b')?.x ?? 0)).toBe(8);
    expect(layout.metrics?.symmetry).toEqual(
      expect.objectContaining({
        offAnchorSiblingCohortCount: 0,
        maximumSiblingAnchorDeviation: 0,
      }),
    );
  });

  it('throws instead of returning an unchecked compact fallback', () => {
    const crowdedRoots = Array.from({ length: 100 }, (_, index) =>
      focusNode(`crowded_root_${String(index)}`, {
        mode: 'fixed',
        x: index * 2,
        y: 0,
        pinned: true,
      }),
    );

    expect(() => compactFocusTreePlan(focusPlan(crowdedRoots))).toThrowError(
      expect.objectContaining({ code: 'FOCUS_COMPACT_QUALITY_BLOCKED' }),
    );
  });

  it('rebalances an automatic gateway without trading shorter edges for crossings or node hits', () => {
    const upper = focusNode('quality_upper', { mode: 'fixed', x: -10, y: 0, pinned: true });
    const gateway = focusNode(
      'quality_gateway',
      { mode: 'auto', pinned: false, preferredX: -8, preferredY: 1 },
      {
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: [upper.id], rawPassthrough: [] }],
        },
      },
    );
    const children = [-4, 0, 4, 8].map((x, index) =>
      focusNode(
        `quality_child_${String(index)}`,
        { mode: 'fixed', x, y: 2, pinned: true },
        {
          prerequisites: {
            operator: 'and',
            groups: [{ operator: 'or', focusIds: [gateway.id], rawPassthrough: [] }],
          },
        },
      ),
    );
    const blocker = focusNode('quality_blocker', {
      mode: 'fixed',
      x: 0,
      y: 1,
      pinned: true,
    });
    const automaticPlan = focusPlan([upper, gateway, blocker, ...children]);
    const authoredPlan = structuredClone(automaticPlan);
    authoredPlan.focuses.find(({ id }) => id === gateway.id)!.position = {
      mode: 'fixed',
      x: -8,
      y: 1,
      pinned: true,
    };
    const authored = layoutFocusTree(authoredPlan);
    const refined = layoutFocusTree(automaticPlan);

    expect(refined.nodes.find(({ id }) => id === gateway.id)?.x).not.toBe(-8);
    expect(refined.metrics!.connectors.maximumHorizontalSpan).toBeLessThan(
      authored.metrics!.connectors.maximumHorizontalSpan,
    );
    expect(refined.metrics!.connectors.crossingCount).toBeLessThanOrEqual(
      authored.metrics!.connectors.crossingCount,
    );
    expect(refined.metrics!.connectors.nodeIntersectionCount).toBeLessThanOrEqual(
      authored.metrics!.connectors.nodeIntersectionCount,
    );
    expect(refined.metrics!.connectors.longConnectorCount).toBeLessThanOrEqual(
      authored.metrics!.connectors.longConnectorCount,
    );
  });

  it('reflows an arbitrary all-auto plan into compact mirrored rows idempotently', () => {
    const root = focusNode('wide_auto_root', {
      mode: 'auto',
      pinned: false,
      preferredX: 20,
      preferredY: 0,
    });
    const children = Array.from({ length: 5 }, (_, index) =>
      focusNode(
        `wide_auto_child_${String(index)}`,
        {
          mode: 'auto',
          pinned: false,
          preferredX: index * 10,
          preferredY: 10,
        },
        {
          prerequisites: {
            operator: 'and',
            groups: [{ operator: 'or', focusIds: [root.id], rawPassthrough: [] }],
          },
        },
      ),
    );
    const authored = focusPlan([root, ...children], { laneGroups: [] });
    const before = layoutFocusTree(authored);
    const compacted = compactFocusTreePlan(authored);
    const after = layoutFocusTree(compacted);
    expect(() => assertCompactLayoutQuality(before, after)).not.toThrow();
    expect(after.metrics).toMatchObject({
      bounds: { rowCount: 2 },
      connectors: { crossingCount: 0 },
      symmetry: { asymmetricSiblingCohortCount: 0, maximumSiblingDeviation: 0 },
      spacing: { tooCloseSameRowPairCount: 0, minimumSameRowSpacing: 2 },
    });
    expect(after.metrics!.bounds.columnCount).toBeLessThan(before.metrics!.bounds.columnCount);
    expect(after.nodes.every(({ x, y }) => Number.isInteger(x) && Number.isInteger(y))).toBe(true);
    const repeated = compactFocusTreePlan(compacted);
    expect(repeated.focuses.map(({ position }) => position)).toEqual(
      compacted.focuses.map(({ position }) => position),
    );
  });

  it('rejects rendered rectangle overlaps and centers automatic convergence nodes', () => {
    const left = focusNode(
      'left',
      { mode: 'fixed', x: 0, y: 0, pinned: true },
      { mutuallyExclusive: ['right'] },
    );
    const right = focusNode(
      'right',
      { mode: 'fixed', x: 4, y: 0, pinned: true },
      { mutuallyExclusive: ['left'] },
    );
    const convergence = focusNode(
      'convergence',
      { mode: 'auto', pinned: false },
      {
        convergence: true,
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: ['left', 'right'], rawPassthrough: [] }],
        },
      },
    );
    const convergingLayout = layoutFocusTree(focusPlan([left, right, convergence]));
    expect(convergingLayout.nodes.find(({ id }) => id === 'convergence')).toEqual(
      expect.objectContaining({ x: 2, y: 1 }),
    );
    expect(convergingLayout.diagnostics).toEqual([]);

    const overlappingPlan = focusPlan([
      focusNode('overlap_a', { mode: 'fixed', x: 0, y: 0, pinned: true }),
      focusNode('overlap_b', { mode: 'fixed', x: 0.25, y: 0, pinned: true }),
    ]);
    const overlappingLayout = layoutFocusTree(overlappingPlan);
    expect(overlappingLayout.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FOCUS_LAYOUT_VISIBLE_OVERLAP', severity: 'error' }),
      ]),
    );
    expect(lintFocusTree(overlappingPlan, { layout: overlappingLayout })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FOCUS_VISIBLE_OVERLAP', severity: 'error' }),
      ]),
    );
  });

  it('uses mutual exclusions as spacing constraints and reports authored constraints it cannot move', () => {
    const left = focusNode(
      'exclusive_left',
      { mode: 'auto', pinned: false, preferredX: 0, preferredY: 0 },
      { mutuallyExclusive: ['exclusive_right'] },
    );
    const right = focusNode(
      'exclusive_right',
      { mode: 'auto', pinned: false, preferredX: 1, preferredY: 1 },
      { mutuallyExclusive: ['exclusive_left'] },
    );
    const layout = layoutFocusTree(focusPlan([left, right]), { nodeSpacing: 2 });
    expect(layout.nodes.find(({ id }) => id === 'exclusive_left')).toEqual(
      expect.objectContaining({ x: -1, y: 0 }),
    );
    expect(layout.nodes.find(({ id }) => id === 'exclusive_right')).toEqual(
      expect.objectContaining({ x: 2, y: 1 }),
    );
    expect(layout.decisions.find(({ focusId }) => focusId === 'exclusive_right')).toEqual(
      expect.objectContaining({
        kind: 'moved_for_mutual_exclusion',
        message: expect.stringContaining('mutual-exclusion spacing'),
      }),
    );
    expect(
      layout.diagnostics.some(
        ({ code }) => code === 'FOCUS_LAYOUT_MUTUAL_EXCLUSION_SPACING_UNSATISFIED',
      ),
    ).toBe(false);

    const locked = layoutFocusTree(
      focusPlan([
        focusNode(
          'locked_left',
          { mode: 'fixed', x: 0, y: 0, pinned: true },
          { mutuallyExclusive: ['locked_right'] },
        ),
        focusNode(
          'locked_right',
          { mode: 'fixed', x: 1, y: 0, pinned: true },
          { mutuallyExclusive: ['locked_left'] },
        ),
      ]),
      { nodeSpacing: 2 },
    );
    expect(locked.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'locked_left', x: 0, preserved: true }),
        expect.objectContaining({ id: 'locked_right', x: 1, preserved: true }),
      ]),
    );
    expect(locked.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'FOCUS_LAYOUT_MUTUAL_EXCLUSION_SPACING_UNSATISFIED',
          severity: 'warning',
          details: expect.objectContaining({
            requiredSpacing: 2,
            movableFocusIds: [],
            preservedFocusIds: ['locked_left', 'locked_right'],
          }),
        }),
      ]),
    );
  });

  it('enforces lane bounds for automatic and authored coordinates', () => {
    const bounded = focusNode(
      'bounded_auto',
      { mode: 'auto', pinned: false, preferredX: 100, preferredY: 0 },
      { laneId: 'bounded' },
    );
    const boundedPlan = focusPlan([bounded], {
      laneGroups: [{ id: 'bounded', label: 'Bounded lane', order: 0, minimumX: -2, maximumX: 2 }],
    });
    expect(layoutFocusTree(boundedPlan).nodes).toEqual([
      expect.objectContaining({ id: bounded.id, x: 2 }),
    ]);

    const authored = focusNode(
      'bounded_authored',
      { mode: 'fixed', x: 3, y: 0, pinned: true },
      { laneId: 'bounded' },
    );
    const authoredLayout = layoutFocusTree(
      focusPlan([authored], { laneGroups: boundedPlan.laneGroups }),
    );
    expect(authoredLayout.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'FOCUS_LAYOUT_LANE_BOUNDS_VIOLATION',
          severity: 'error',
          details: expect.objectContaining({ minimumX: -2, maximumX: 2, x: 3 }),
        }),
      ]),
    );

    const occupied = focusNode(
      'bounded_occupied',
      { mode: 'fixed', x: 0, y: 0, pinned: true },
      { laneId: 'exact' },
    );
    const noCapacity = focusNode(
      'bounded_no_capacity',
      { mode: 'auto', pinned: false, preferredX: 0, preferredY: 0 },
      { laneId: 'exact' },
    );
    expect(() =>
      layoutFocusTree(
        focusPlan([occupied, noCapacity], {
          laneGroups: [{ id: 'exact', label: 'Exact lane', order: 0, minimumX: 0, maximumX: 0 }],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'FOCUS_LAYOUT_LANE_CAPACITY_BLOCKED' }));

    const invalidBounds = structuredClone(boundedPlan);
    invalidBounds.laneGroups[0]!.minimumX = 5;
    invalidBounds.laneGroups[0]!.maximumX = -5;
    expect(focusTreePlanSchema.safeParse(invalidBounds).success).toBe(false);
  });

  it('reduces avoidable connector crossings without moving fixed or prior-stable nodes', () => {
    const leftParent = focusNode('crossing_left_parent', {
      mode: 'fixed',
      x: -4,
      y: 0,
      pinned: true,
    });
    const rightParent = focusNode('crossing_right_parent', {
      mode: 'fixed',
      x: 4,
      y: 0,
      pinned: true,
    });
    const leftChild = focusNode(
      'crossing_left_child',
      { mode: 'fixed', x: -4, y: 3, pinned: true },
      {
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: ['crossing_right_parent'], rawPassthrough: [] }],
        },
      },
    );
    const movableChild = focusNode(
      'crossing_movable_child',
      { mode: 'auto', pinned: false, preferredX: 4, preferredY: 3 },
      {
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: ['crossing_left_parent'], rawPassthrough: [] }],
        },
      },
    );
    const plan = focusPlan([leftParent, rightParent, leftChild, movableChild]);
    const optimized = layoutFocusTree(plan);
    expect(optimized.nodes.find(({ id }) => id === 'crossing_movable_child')).toEqual(
      expect.objectContaining({ x: -6, y: 3 }),
    );
    expect(optimized.decisions.find(({ focusId }) => focusId === 'crossing_movable_child')).toEqual(
      expect.objectContaining({
        kind: 'moved_to_reduce_crossings',
        message: expect.stringContaining('connector crossings 1 -> 0'),
      }),
    );
    expect(
      optimized.diagnostics.some(
        ({ code }) => code === 'FOCUS_LAYOUT_CONNECTOR_CROSSING_UNSATISFIED',
      ),
    ).toBe(false);
    expect(
      lintFocusTree(plan, { layout: optimized }).some(
        ({ code }) => code === 'FOCUS_AVOIDABLE_CONNECTOR_CROSSING',
      ),
    ).toBe(false);
    expect(optimized.nodes.find(({ id }) => id === 'crossing_left_child')).toEqual(
      expect.objectContaining({ x: -4, y: 3, preserved: true }),
    );

    const stableBase = focusPlan([leftParent, movableChild]);
    const previous = layoutFocusTree(stableBase);
    expect(previous.nodes.find(({ id }) => id === 'crossing_movable_child')).toEqual(
      expect.objectContaining({ x: 4, y: 3 }),
    );
    const incremental = layoutFocusTree(plan, { previous });
    expect(incremental.nodes.find(({ id }) => id === 'crossing_movable_child')).toEqual(
      expect.objectContaining({ x: 4, y: 3, preserved: true }),
    );
    expect(incremental.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'FOCUS_LAYOUT_CONNECTOR_CROSSING_UNSATISFIED',
          details: expect.objectContaining({
            preservedFocusIds: expect.arrayContaining(['crossing_movable_child']),
          }),
        }),
      ]),
    );
  });

  it('bounds a large authored crossing search without exhausting the layout budget', () => {
    const edgeCount = 200;
    const fixed = Array.from({ length: edgeCount }, (_, index) => {
      const parentId = `authored_parent_${String(index).padStart(3, '0')}`;
      const childId = `authored_child_${String(index).padStart(3, '0')}`;
      return [
        focusNode(parentId, { mode: 'fixed', x: index * 2, y: 0, pinned: true }),
        focusNode(
          childId,
          { mode: 'fixed', x: (edgeCount - index) * 2, y: 3, pinned: true },
          {
            prerequisites: {
              operator: 'and',
              groups: [{ operator: 'or', focusIds: [parentId], rawPassthrough: [] }],
            },
          },
        ),
      ];
    }).flat();
    const movable = focusNode(
      'authored_movable',
      { mode: 'auto', pinned: false, preferredX: edgeCount, preferredY: 2 },
      {
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: ['authored_parent_000'], rawPassthrough: [] }],
        },
      },
    );
    const plan = focusPlan([...fixed, movable]);

    const first = layoutFocusTree(plan);
    const repeated = layoutFocusTree(plan);
    expect(first.nodes).toHaveLength(edgeCount * 2 + 1);
    expect(first.layoutHash).toBe(repeated.layoutHash);
    expect(first.nodes.find(({ id }) => id === movable.id)).toEqual(
      expect.objectContaining({ sourceMode: 'auto' }),
    );
  });
});

describe('Focus Tree Workbench lint', () => {
  it('reports structural, reference, layout, route, and design defects with deterministic codes', () => {
    const root = focusNode('root', { mode: 'fixed', x: 0, y: 0, pinned: true });
    const duplicateA = focusNode('duplicate', { mode: 'fixed', x: 20, y: 0, pinned: false });
    const duplicateB = focusNode('duplicate', { mode: 'fixed', x: 22, y: 0, pinned: false });
    const cycleA = focusNode(
      'cycle_a',
      { mode: 'auto', pinned: false },
      {
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: ['cycle_b'], rawPassthrough: [] }],
        },
      },
    );
    const cycleB = focusNode(
      'cycle_b',
      { mode: 'auto', pinned: false },
      {
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: ['cycle_a'], rawPassthrough: [] }],
        },
      },
    );
    const missing = focusNode(
      'missing_parent',
      { mode: 'auto', pinned: false },
      {
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: ['does_not_exist'], rawPassthrough: [] }],
        },
      },
    );
    const malformed = focusNode(
      'malformed',
      { mode: 'fixed', x: 24, y: 0, pinned: false },
      {
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: [], rawPassthrough: [] }],
        },
      },
    );
    const contradiction = focusNode(
      'contradiction',
      { mode: 'fixed', x: 0, y: 2, pinned: false },
      {
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: ['root'], rawPassthrough: [] }],
        },
        mutuallyExclusive: ['root'],
      },
    );
    const relativeMissing = focusNode('relative_missing', {
      mode: 'relative',
      x: 0,
      y: 1,
      relativeTo: 'absent_anchor',
      pinned: false,
    });
    const relativeA = focusNode('relative_a', {
      mode: 'relative',
      x: 1,
      y: 1,
      relativeTo: 'relative_b',
      pinned: false,
    });
    const relativeB = focusNode('relative_b', {
      mode: 'relative',
      x: 1,
      y: 1,
      relativeTo: 'relative_a',
      pinned: false,
    });
    const hidden = focusNode(
      'hidden',
      { mode: 'fixed', x: 26, y: 0, pinned: false },
      {
        visibility: 'hidden',
      },
    );
    const impossible = focusNode(
      'impossible',
      { mode: 'fixed', x: 28, y: 0, pinned: false },
      {
        routeLocks: [
          {
            id: 'impossible:route',
            mode: 'all',
            requiredFocusIds: ['root'],
            excludedFocusIds: ['root'],
            alwaysImpossible: true,
          },
        ],
      },
    );
    const overlap = focusNode('overlap', { mode: 'fixed', x: 0, y: 0, pinned: true });
    const crossingParentLeft = focusNode('cross_parent_left', {
      mode: 'fixed',
      x: -4,
      y: 0,
      pinned: false,
    });
    const crossingParentRight = focusNode('cross_parent_right', {
      mode: 'fixed',
      x: 4,
      y: 0,
      pinned: false,
    });
    const crossingChildRight = focusNode(
      'cross_child_right',
      { mode: 'fixed', x: 4, y: 3, pinned: false },
      {
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: ['cross_parent_left'], rawPassthrough: [] }],
        },
      },
    );
    const crossingChildLeft = focusNode(
      'cross_child_left',
      { mode: 'fixed', x: -4, y: 3, pinned: false },
      {
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: ['cross_parent_right'], rawPassthrough: [] }],
        },
      },
    );
    const weak = focusNode(
      'weak',
      { mode: 'fixed', x: 2, y: 3, pinned: false },
      {
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: ['root'], rawPassthrough: [] }],
        },
        icons: [],
        filters: [],
        ai: { majorRoute: true, strategyIds: [] },
        links: [{ kind: 'decision', target: 'missing_decision' }],
      },
    );
    delete weak.completionReward;
    const repeatedReward = rawReward('{ add_stability = 0.01 }');
    const rewardA = focusNode(
      'reward_a',
      { mode: 'fixed', x: 30, y: 0, pinned: false },
      {
        completionReward: repeatedReward,
      },
    );
    const rewardB = focusNode(
      'reward_b',
      { mode: 'fixed', x: 32, y: 0, pinned: false },
      {
        completionReward: repeatedReward,
      },
    );
    const rewardC = focusNode(
      'reward_c',
      { mode: 'fixed', x: 34, y: 0, pinned: false },
      {
        completionReward: repeatedReward,
      },
    );
    const isolated = focusNode('isolated', { mode: 'fixed', x: 36, y: 0, pinned: false });
    const plan = focusPlan(
      [
        root,
        duplicateA,
        duplicateB,
        cycleA,
        cycleB,
        missing,
        malformed,
        contradiction,
        relativeMissing,
        relativeA,
        relativeB,
        hidden,
        impossible,
        overlap,
        crossingParentLeft,
        crossingParentRight,
        crossingChildRight,
        crossingChildLeft,
        weak,
        rewardA,
        rewardB,
        rewardC,
        isolated,
      ],
      {
        entryFocusIds: ['root'],
        branchGroups: [
          {
            id: 'major',
            label: 'Major route',
            family: 'political',
            focusIds: ['weak'],
            major: true,
            hidden: false,
            crisis: false,
            conditional: false,
            aiStrategyIds: [],
          },
        ],
        runtimeAssignment: { replacesExistingCountryTree: true },
      },
    );
    weak.branchId = 'major';
    const diagnostics = lintFocusTree(plan, {
      index: SymbolIndex.build([]),
      references: {
        decision: [],
        event: [],
        idea: [],
        leader: [],
        formable: [],
        helper: [],
      },
      genericRewardThreshold: 3,
    });
    const codes = new Set(diagnostics.map(({ code }) => code));
    expect(codes).toEqual(
      expect.objectContaining(
        new Set([
          'FOCUS_DUPLICATE_ID',
          'FOCUS_PREREQUISITE_CYCLE',
          'FOCUS_PREREQUISITE_MISSING',
          'FOCUS_ISOLATED',
          'FOCUS_UNREACHABLE',
          'FOCUS_PREREQUISITE_GROUP_MALFORMED',
          'FOCUS_MUTUAL_EXCLUSION_CONTRADICTS_PATH',
          'FOCUS_RELATIVE_TARGET_MISSING',
          'FOCUS_RELATIVE_POSITION_CYCLE',
          'FOCUS_HIDDEN_WITHOUT_REVEAL',
          'FOCUS_ROUTE_LOCK_IMPOSSIBLE',
          'FOCUS_DUPLICATE_COORDINATE',
          'FOCUS_AVOIDABLE_CONNECTOR_CROSSING',
          'FOCUS_WEAK_DANGLING_BRANCH',
          'FOCUS_TERMINAL_WITHOUT_PAYOFF',
          'FOCUS_ICON_REFERENCE_MISSING',
          'FOCUS_LOCALISATION_REFERENCE_MISSING',
          'FOCUS_FILTER_MISSING',
          'FOCUS_MAJOR_ROUTE_AI_MISSING',
          'FOCUS_GAMEPLAY_REFERENCE_MISSING',
          'FOCUS_RUNTIME_REPLACEMENT_UNSAFE',
          'FOCUS_REPEATED_GENERIC_REWARD',
        ]),
      ),
    );
    expect(diagnostics).toEqual(
      [...diagnostics].sort((left, right) => {
        const order = { blocker: 0, error: 1, warning: 2, info: 3 } as const;
        return (
          order[left.severity] - order[right.severity] || compareCodeUnits(left.code, right.code)
        );
      }),
    );
  });
  it('blocks adversarial DFS depth and pair-comparison work without overflowing', () => {
    const chain = Array.from({ length: 5_000 }, (_unused, index) =>
      focusNode(
        `depth-${index}`,
        { mode: 'fixed', x: 0, y: index, pinned: true },
        {
          prerequisites:
            index === 0
              ? { operator: 'and', groups: [] }
              : {
                  operator: 'and',
                  groups: [
                    {
                      operator: 'or',
                      focusIds: [`depth-${index - 1}`],
                      rawPassthrough: [],
                    },
                  ],
                },
        },
      ),
    );
    expect(lintFocusTree(focusPlan(chain)).map(({ code }) => code)).toContain(
      'FOCUS_GRAPH_DEPTH_BUDGET_BLOCKED',
    );

    const broad = Array.from({ length: 2_500 }, (_unused, index) =>
      focusNode(`broad-${index}`, { mode: 'fixed', x: index, y: 0, pinned: true }),
    );
    const broadPlan = focusPlan(broad);
    const broadLayout = {
      treeId: broadPlan.id,
      nodes: broad.map((focus, index) => ({
        id: focus.id,
        x: index,
        y: 0,
        laneId: 'default',
        preserved: true,
        sourceMode: 'fixed' as const,
      })),
      decisions: [],
      diagnostics: [],
      layoutHash: 'bounded-pair-work',
    } satisfies FocusLayoutResult;
    expect(lintFocusTree(broadPlan, { layout: broadLayout }).map(({ code }) => code)).toContain(
      'FOCUS_LAYOUT_COMPARISON_BUDGET_BLOCKED',
    );
  });

  it('caps focus lint and layout diagnostics with explicit truncation blockers', () => {
    const lintFocuses = Array.from({ length: 2_500 }, (_unused, index) =>
      focusNode(`isolated_${index}`, { mode: 'fixed', x: index * 2, y: 0, pinned: true }),
    );
    const lintDiagnostics = lintFocusTree(focusPlan(lintFocuses), {
      layout: {
        treeId: 'bounded-lint',
        nodes: [],
        decisions: [],
        diagnostics: [],
        layoutHash: 'bounded-lint',
      },
    });
    expect(lintDiagnostics).toHaveLength(2_000);
    expect(lintDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FOCUS_LINT_DIAGNOSTICS_TRUNCATED' }),
      ]),
    );

    const overlapFocuses = Array.from({ length: 100 }, (_unused, index) =>
      focusNode(`overlap_${index}`, { mode: 'fixed', x: 0, y: 0, pinned: true }),
    );
    const layout = layoutFocusTree(focusPlan(overlapFocuses));
    expect(layout.diagnostics).toHaveLength(2_000);
    expect(layout.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FOCUS_LAYOUT_DIAGNOSTICS_TRUNCATED' }),
      ]),
    );
  });

  it('budgets route-lock pair analysis instead of scanning an adversarial matrix', () => {
    const left = focusNode(
      'route_left',
      { mode: 'fixed', x: 0, y: 0, pinned: true },
      { mutuallyExclusive: ['route_right'] },
    );
    const right = focusNode(
      'route_right',
      { mode: 'fixed', x: 2, y: 0, pinned: true },
      { mutuallyExclusive: ['route_left'] },
    );
    const gated = focusNode(
      'route_gated',
      { mode: 'fixed', x: 4, y: 0, pinned: true },
      {
        routeLocks: [
          {
            id: 'adversarial-route-lock',
            mode: 'all',
            requiredFocusIds: Array.from(
              { length: 2_100 },
              (_unused, index) => `required_${index}`,
            ),
            excludedFocusIds: [],
          },
        ],
      },
    );
    expect(() => lintFocusTree(focusPlan([left, right, gated]))).toThrowError(
      expect.objectContaining({ code: 'FOCUS_LINT_WORK_BUDGET_BLOCKED' }),
    );
  });

  it('caps cycle samples using bounded linear canonicalization', () => {
    const focuses = Array.from({ length: 130 }, (_unused, cycleIndex) => {
      const leftId = `cycle_${cycleIndex}_left`;
      const rightId = `cycle_${cycleIndex}_right`;
      return [
        focusNode(
          leftId,
          { mode: 'fixed', x: cycleIndex * 4, y: 0, pinned: true },
          {
            prerequisites: {
              operator: 'and',
              groups: [{ operator: 'or', focusIds: [rightId], rawPassthrough: [] }],
            },
          },
        ),
        focusNode(
          rightId,
          { mode: 'fixed', x: cycleIndex * 4 + 2, y: 1, pinned: true },
          {
            prerequisites: {
              operator: 'and',
              groups: [{ operator: 'or', focusIds: [leftId], rawPassthrough: [] }],
            },
          },
        ),
      ];
    }).flat();
    const diagnostics = lintFocusTree(focusPlan(focuses), {
      layout: {
        treeId: 'cycle-samples',
        nodes: [],
        decisions: [],
        diagnostics: [],
        layoutHash: 'cycle-samples',
      },
    });
    expect(diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'FOCUS_CYCLE_SAMPLES_TRUNCATED' })]),
    );
  });
});

describe('Focus Tree Workbench rendering', () => {
  it('produces deterministic HTML, SVG, JSON, and a real rasterized PNG', async () => {
    const root = focusNode('root', { mode: 'fixed', x: 0, y: 0, pinned: true });
    const child = focusNode(
      'child',
      { mode: 'relative', x: 2, y: 1, relativeTo: 'root', pinned: false },
      {
        prerequisites: {
          operator: 'and',
          groups: [{ operator: 'or', focusIds: ['root'], rawPassthrough: [] }],
        },
        visibility: 'conditional',
        reveal: {
          kind: 'event',
          references: ['fixture.1'],
          trigger: rawReward('{ has_country_flag = fixture_revealed }'),
        },
      },
    );
    const plan = focusPlan([root, child]);
    const layout = layoutFocusTree(plan);
    const diagnostics = [
      {
        code: 'FOCUS_TEST_WARNING',
        severity: 'warning' as const,
        category: 'design' as const,
        message: 'Synthetic source-linked warning',
        location: {
          path: 'mod:fixture.txt',
          start: { line: 10, column: 2, offset: 100 },
          end: { line: 10, column: 8, offset: 106 },
          symbol: 'child',
        },
      },
    ];
    const icon =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const first = await renderFocusTree(plan, layout, diagnostics, {
      iconDataUris: { GFX_fixture: icon },
      renderProfile: { fixture: 'deterministic' },
    });
    const second = await renderFocusTree(plan, layout, diagnostics, {
      iconDataUris: { GFX_fixture: icon },
      renderProfile: { fixture: 'deterministic' },
    });
    expect(second.hashes).toEqual(first.hashes);
    expect(second.png.equals(first.png)).toBe(true);
    expect(first.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(first.svg).toContain('<image href="data:image/png;base64,');
    expect(first.svg).toContain('data-font-sha256=');
    expect(first.svg).not.toMatch(/<text\b|font-family=/u);
    expect(first.svg).toContain('data-diagnostics="FOCUS_TEST_WARNING"');
    expect(first.sourceMap.mappings.map(({ focusId }) => focusId)).toEqual(['root', 'child']);
    expect(first.html).toContain('Offline HOI4 Agent Tools representation');
    expect(first.html).toContain('not an in-game screenshot or editor');
    const graph = JSON.parse(first.json) as {
      tree: { id: string };
      diagnostics: { code: string }[];
    };
    expect(graph.tree.id).toBe('layout_tree');
    expect(graph.diagnostics.map(({ code }) => code)).toContain('FOCUS_TEST_WARNING');
  });

  it('rolls back the complete focus artifact bundle when cancellation arrives mid-write', async () => {
    const { resolver } = await createFocusTransactionFixture(sampleSource);
    const workspace = resolver.get('fixture');
    const store = new ArtifactStore();
    const plan = focusPlan([focusNode('root', { mode: 'fixed', x: 0, y: 0, pinned: true })], {
      provenance: {
        sourcePath: 'mod:common/national_focus/layout.txt',
        sourceHash: 'a'.repeat(64),
        importedPlanHash: '',
      },
    });
    const bundle = await renderFocusTree(plan, layoutFocusTree(plan), []);
    const firstTarget = path.join(
      workspace.artifactRoot,
      sha256Bytes(bundle.html).slice(0, 2),
      sha256Bytes(bundle.html),
      `${plan.id}.focus.html`,
    );
    const controller = new AbortController();
    let observedPartialWrite = false;
    const signal = new Proxy(controller.signal, {
      get(target, property) {
        if (property === 'throwIfAborted') {
          return () => {
            if (!observedPartialWrite && existsSync(firstTarget)) {
              observedPartialWrite = true;
              controller.abort();
            }
            target.throwIfAborted();
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(
      storeFocusRenderArtifacts(workspace, store, plan, bundle, { signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(observedPartialWrite).toBe(true);
    expect(existsSync(firstTarget)).toBe(false);
    await expect(store.list(workspace)).resolves.toEqual([]);
  });

  it('uniformly scales focus raster output without changing the logical SVG viewport', async () => {
    const root = focusNode('root', { mode: 'fixed', x: 0, y: 0, pinned: true });
    const plan = focusPlan([root]);
    const layout = layoutFocusTree(plan);
    const scaled = await renderFocusTree(plan, layout, [], { outputScale: 0.25 });
    expect(scaled).toMatchObject({ width: 80, height: 60 });
    expect(scaled.svg).toContain('width="80" height="60" viewBox="0 0 320 240"');
    await expect(renderFocusTree(plan, layout, [], { outputScale: 0.249 })).rejects.toMatchObject({
      code: 'FOCUS_RENDER_SCALE_INVALID',
      details: expect.objectContaining({ minimumOutputScale: 0.25, maximumOutputScale: 1 }),
    });
  });

  it('blocks oversized focus canvases and hostile embedded icon rasters before Sharp', async () => {
    const root = focusNode('root', { mode: 'fixed', x: 0, y: 0, pinned: true });
    const plan = focusPlan([root]);
    const far = focusNode('far', { mode: 'fixed', x: 100_000, y: 0, pinned: true });
    const oversizedPlan = focusPlan([root, far]);
    const oversizedLayout = {
      treeId: oversizedPlan.id,
      nodes: [
        {
          id: root.id,
          x: 0,
          y: 0,
          laneId: 'default',
          preserved: true,
          sourceMode: 'fixed' as const,
        },
        {
          id: far.id,
          x: 100_000,
          y: 0,
          laneId: 'default',
          preserved: true,
          sourceMode: 'fixed' as const,
        },
      ],
      decisions: [],
      diagnostics: [],
      layoutHash: 'oversized',
    } satisfies FocusLayoutResult;
    await expect(renderFocusTree(oversizedPlan, oversizedLayout, [])).rejects.toMatchObject({
      code: 'RENDER_DIMENSIONS_BLOCKED',
    });

    const normalLayout = layoutFocusTree(plan);
    const hostileSvg =
      'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%224097%22%20height%3D%224096%22%3E%3C%2Fsvg%3E';
    await expect(
      renderFocusTree(plan, normalLayout, [], {
        iconDataUris: { GFX_fixture: hostileSvg },
      }),
    ).rejects.toMatchObject({ code: 'RENDER_ASSET_DATA_URI_BLOCKED' });

    await expect(
      renderFocusTree(plan, normalLayout, [], {
        iconDataUris: { GFX_fixture: 'data:image/png,%E0%A4%A' },
      }),
    ).rejects.toMatchObject({ code: 'RENDER_ASSET_DECODE_BLOCKED' });

    const largePng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    largePng.writeUInt32BE(4_096, 16);
    largePng.writeUInt32BE(4_096, 20);
    const repeatedPlan = focusPlan([
      focusNode('icon_a', { mode: 'fixed', x: 0, y: 0, pinned: true }),
      focusNode('icon_b', { mode: 'fixed', x: 1, y: 0, pinned: true }),
      focusNode('icon_c', { mode: 'fixed', x: 2, y: 0, pinned: true }),
      focusNode('icon_d', { mode: 'fixed', x: 3, y: 0, pinned: true }),
    ]);
    await expect(
      renderFocusTree(repeatedPlan, layoutFocusTree(repeatedPlan), [], {
        iconDataUris: { GFX_fixture: `data:image/png;base64,${largePng.toString('base64')}` },
      }),
    ).rejects.toMatchObject({ code: 'RENDER_AGGREGATE_BLOCKED' });
  });
});

describe('Focus Tree Workbench transactions', () => {
  it('plans and applies targeted changes through TransactionManager', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-focus-workbench-'));
    temporaryRoots.push(temporary);
    const modRoot = path.join(temporary, 'mod');
    const focusDirectory = path.join(modRoot, 'common', 'national_focus');
    await mkdir(focusDirectory, { recursive: true });
    const focusPath = path.join(focusDirectory, 'fixture.txt');
    await writeFile(focusPath, sampleSource, 'utf8');
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(temporary, 'server-state'),
      workspaces: [
        {
          id: 'fixture',
          name: 'Fixture',
          root: modRoot,
          kind: 'mod',
        },
      ],
    });
    const resolver = await WorkspaceResolver.create(configuration);
    const transactions = new TransactionManager(resolver);
    const workbench = new FocusWorkbench(resolver, transactions);
    const imported = await workbench.importPath('fixture', 'common/national_focus/fixture.txt');
    const plan = imported.result.plans[0];
    expect(plan).toBeDefined();
    if (plan === undefined) return;
    const root = plan.focuses.find(({ id }) => id === 'root');
    expect(root).toBeDefined();
    if (root === undefined) return;
    root.cost = 7;

    const planned = await workbench.planChanges({
      workspaceId: 'fixture',
      relativePath: 'common/national_focus/fixture.txt',
      plan,
    });
    expect(planned.drift.status).toBe('plan_changed');
    expect(planned.transaction.state).toBe('planned');
    expect(planned.transaction.files).toHaveLength(2);
    expect(planned.transaction.files.map(({ relativePath }) => relativePath)).toEqual([
      'common/national_focus/fixture.focus-plan.json',
      'common/national_focus/fixture.txt',
    ]);
    expect(planned.transaction.files[0]?.diffArtifact?.mimeType).toBe('text/x-diff');
    expect(planned.transaction.artifacts.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'fixture_tree.focus.proposed-source-map.json',
        'fixture_tree.focus.proposed-plan.json',
      ]),
    );
    expect(await readFile(focusPath, 'utf8')).toBe(sampleSource);

    const applied = await transactions.apply(
      'fixture',
      planned.transaction.transactionId,
      planned.transaction.planHash,
      { postValidate },
    );
    expect(applied.state).toBe('applied');
    expect(applied.artifacts.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'fixture_tree.focus.proposed-source-map.json',
        'fixture_tree.focus.proposed-plan.json',
      ]),
    );
    const changed = await readFile(focusPath, 'utf8');
    expect(changed).toContain('cost = 7');
    expect(changed).toContain('# This comment must survive a targeted scalar rewrite.');
    expect(changed).toContain('custom_tree_field = { preserve = exactly }');
    expect(changed).toContain('custom_focus_field = { preserve = this_too }');
    const sidecar = JSON.parse(
      await readFile(path.join(focusDirectory, 'fixture.focus-plan.json'), 'utf8'),
    ) as { focuses: unknown[]; sourceHash: string };
    expect(sidecar.focuses).toHaveLength(plan.focuses.length);
    expect(sidecar.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('patches changed structured fields without regenerating surrounding source', async () => {
    const { focusPath, transactions, workbench } =
      await createFocusTransactionFixture(sampleSource);
    const imported = await workbench.importPath('fixture', 'common/national_focus/fixture.txt');
    const plan = imported.result.plans[0];
    expect(plan).toBeDefined();
    if (plan === undefined) return;
    const child = plan.focuses.find(({ id }) => id === 'child');
    expect(child).toBeDefined();
    if (child === undefined) return;
    child.prerequisites.groups[1]?.focusIds.push('alternate');
    child.filters = ['FOCUS_FILTER_INDUSTRY'];
    const allowBranchLock = child.routeLocks.find(({ field }) => field === 'allow_branch');
    expect(allowBranchLock).toBeDefined();
    if (allowBranchLock === undefined) return;
    allowBranchLock.requiredFocusIds = ['alternate'];

    const planned = await workbench.planChanges({
      workspaceId: 'fixture',
      relativePath: 'common/national_focus/fixture.txt',
      plan,
    });
    expect(await readFile(focusPath, 'utf8')).toBe(sampleSource);
    await transactions.apply(
      'fixture',
      planned.transaction.transactionId,
      planned.transaction.planHash,
      { postValidate },
    );

    const changed = await readFile(focusPath, 'utf8');
    expect(changed).toContain('prerequisite = { focus = gate focus = alternate }');
    expect(changed).toContain('search_filters = { FOCUS_FILTER_INDUSTRY }');
    expect(changed).toContain('allow_branch = { has_completed_focus = alternate }');
    expect(changed).toContain('# This comment must survive a targeted scalar rewrite.');
    expect(changed).toContain('custom_tree_field = { preserve = exactly }');
    expect(changed).toContain('custom_focus_field = { preserve = this_too }');
    expect(changed.match(/custom_tree_field/g)).toHaveLength(1);
    expect(changed.match(/custom_focus_field/g)).toHaveLength(1);
  });

  it('refuses to regenerate a changed structured field that contains comments', async () => {
    const commentedSource = sampleSource.replace(
      'prerequisite = { focus = gate }',
      'prerequisite = { # preserve this authored explanation\n\t\t\tfocus = gate\n\t\t}',
    );
    const { workbench } = await createFocusTransactionFixture(commentedSource);
    const imported = await workbench.importPath('fixture', 'common/national_focus/fixture.txt');
    const plan = imported.result.plans[0];
    expect(plan).toBeDefined();
    if (plan === undefined) return;
    const child = plan.focuses.find(({ id }) => id === 'child');
    expect(child).toBeDefined();
    if (child === undefined) return;
    child.prerequisites.groups[1]?.focusIds.push('alternate');

    await expect(
      workbench.planChanges({
        workspaceId: 'fixture',
        relativePath: 'common/national_focus/fixture.txt',
        plan,
      }),
    ).rejects.toMatchObject({ code: 'FOCUS_UNSAFE_COMMENTED_REWRITE' });
  });

  it('creates a source-mapped transaction for continuous focus changes and refuses raw rewrites', async () => {
    const source = `continuous_focus_palette = {
\tid = transaction_palette
\tdefault = yes
\treset_on_civilwar = no

\tfocus = {
\t\tid = transaction_continuous
\t\ticon = GFX_fixture
\t\tmodifier = { army_org_factor = 0.05 }
\t}
}`;
    const { focusPath, workbench } = await createFocusTransactionFixture(
      source,
      'common/continuous_focus/fixture.txt',
    );
    const imported = await workbench.importContinuousPath(
      'fixture',
      'common/continuous_focus/fixture.txt',
    );
    const plan = imported.result.continuousFocusPalettes[0];
    expect(plan).toBeDefined();
    if (plan === undefined) return;
    plan.resetOnCivilWar = true;
    const planned = await workbench.planContinuousChanges({
      workspaceId: 'fixture',
      relativePath: 'common/continuous_focus/fixture.txt',
      plan,
    });
    expect(planned).toMatchObject({
      drift: { status: 'plan_changed' },
      transaction: { state: 'planned', validation: { passed: true } },
    });
    expect(planned.transaction.files).toEqual([
      expect.objectContaining({ relativePath: 'common/continuous_focus/fixture.txt' }),
    ]);
    expect(planned.transaction.artifacts.map(({ name }) => name)).toContain(
      'transaction_palette.continuous.proposed-source-map.json',
    );
    expect(await readFile(focusPath, 'utf8')).toBe(source);

    const unsafe = structuredClone(imported.result.continuousFocusPalettes[0]!);
    unsafe.focuses[0]!.rawPassthrough[0]!.text = 'modifier = { army_org_factor = 0.10 }';
    await expect(
      workbench.planContinuousChanges({
        workspaceId: 'fixture',
        relativePath: 'common/continuous_focus/fixture.txt',
        plan: unsafe,
      }),
    ).rejects.toMatchObject({ code: 'FOCUS_UNSAFE_RAW_FIELD_REWRITE' });
  });
});
