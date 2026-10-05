import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { ScriptedGuiStudio, renderGuiScene } from '../../src/hoi4_agent_tools/gui/index.js';
import { scenarioMatrixEvidence } from '../../src/hoi4_agent_tools/gui/studio.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-condition-pipeline-'));
  roots.push(root);
  const mod = path.join(root, 'mod');
  const source: Record<string, string> = {
    'descriptor.mod': 'name = "Condition pipeline fixture"',
    'interface/test.gui': `guiTypes = { containerWindowType = { name = "condition_window" size = { width = 640 height = 280 }
      ${['inclusive', 'compound', 'negation', 'helper', 'scoped', 'unknown', 'dated', 'controlled'].map((name, index) => `instantTextBoxType = { name = "${name}" position = { x = 5 y = ${index * 30} } size = { width = 600 height = 25 } text = "LABEL_${name}" }`).join('\n')}
      buttonType = { name = "controlled_action" position = { x = 5 y = 245 } size = { width = 100 height = 25 } }
      buttonType = { name = "scoped_action" position = { x = 115 y = 245 } size = { width = 100 height = 25 } }
      iconType = { name = "controlled_visibility" position = { x = 225 y = 245 } size = { width = 50 height = 25 } }
      iconType = { name = "scoped_visibility" position = { x = 285 y = 245 } size = { width = 50 height = 25 } }
      buttonType = { name = "visibility_action" position = { x = 345 y = 245 } size = { width = 100 height = 25 } }
      iconType = { name = "dynamic_visibility" position = { x = 455 y = 245 } size = { width = 50 height = 25 } }
      buttonType = { name = "dynamic_enablement" position = { x = 515 y = 245 } size = { width = 100 height = 25 } }
    } }`,
    'common/scripted_guis/conditions.txt': `scripted_gui = { condition_gui = { context_type = player_context window_name = condition_window effects = { controlled_action_click = { } scoped_action_click = { } visibility_action_click = { } dynamic_enablement_click = { } } triggers = { controlled_action_click_enabled = { controls_state = 87 } scoped_action_click_enabled = { FROM = { a > 0 } } controlled_visibility_visible = { controls_state = 87 } scoped_visibility_visible = { FROM = { a > 0 } } visibility_action_visible = { controls_state = 87 } } properties = { dynamic_visibility = { visible = "[?show_dynamic]" } dynamic_enablement = { enabled = "[?allow_dynamic]" } } } }`,
    'common/scripted_localisation/test.txt': `@limit = 10
      defined_text = { name = GetInclusive text = { trigger = { check_variable = { var = a value = @limit compare = greater_than_or_equals } } localization_key = TRUE_TEXT } text = { localization_key = FALSE_TEXT } }
      defined_text = { name = GetCompound text = { trigger = { AND = { a > 5 b > 5 } } localization_key = TRUE_TEXT } text = { localization_key = FALSE_TEXT } }
      defined_text = { name = GetNot text = { trigger = { NOT = { a > 5 } } localization_key = TRUE_TEXT } text = { localization_key = FALSE_TEXT } }
      defined_text = { name = GetHelper text = { trigger = { gate = yes } localization_key = TRUE_TEXT } text = { localization_key = FALSE_TEXT } }
      defined_text = { name = GetScoped text = { trigger = { FROM = { check_variable = { var = a value = ROOT.a compare = less_than } } check_variable = { var = FROM.a value = ROOT.a compare = less_than } } localization_key = TRUE_TEXT } text = { localization_key = FALSE_TEXT } }
      defined_text = { name = GetUnknown text = { trigger = { unmodelled_condition = yes } localization_key = TRUE_TEXT } text = { trigger = { always = yes } localization_key = FALSE_TEXT } }
      defined_text = { name = GetDated text = { trigger = { date > 1944.9.30 } localization_key = TRUE_TEXT } text = { localization_key = FALSE_TEXT } }
      defined_text = { name = GetControlled text = { trigger = { controls_state = 87 88 = { is_controlled_by = ROOT } } localization_key = TRUE_TEXT } text = { localization_key = FALSE_TEXT } }
    `,
    'common/scripted_triggers/gate.txt':
      'gate = { check_variable = { var = a value = constant:limits.boundary compare = greater_than_or_equals } }',
    'common/script_constants/limits.txt': 'limits = { boundary = 10 }',
    'localisation/english/test_l_english.yml':
      '\uFEFFl_english:\nLABEL_inclusive: "Inclusive: [GetInclusive]"\nLABEL_compound: "Compound: [GetCompound]"\nLABEL_negation: "Negation: [GetNot]"\nLABEL_helper: "Helper: [GetHelper]"\nLABEL_scoped: "Scoped: [GetScoped]"\nLABEL_unknown: "Unknown: [GetUnknown]"\nLABEL_dated: "Dated: [GetDated]"\nLABEL_controlled: "Controlled: [GetControlled]"\nTRUE_TEXT: "§GTRUE§!"\nFALSE_TEXT: "§RFALSE§!"\nOVERRIDE_LABEL: "Scenario-selected localisation"\n',
  };
  for (const [relative, text] of Object.entries(source)) {
    const target = path.join(mod, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  const runtime = path.join(root, 'runtime');
  await mkdir(runtime);
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(root, 'state'),
    storageRoots: [runtime],
    workspaces: [
      {
        id: 'fixture',
        name: 'Fixture',
        root: mod,
        cacheRoot: path.join(runtime, 'cache'),
        artifactRoot: path.join(runtime, 'artifacts'),
      },
    ],
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  return new ScriptedGuiStudio(engine);
}

describe('generated scenario to production GUI render', () => {
  it('keeps missing dynamic visible/enabled properties unresolved until boolean values are declared', async () => {
    const studio = await fixture();
    const preview = async (id: string, values: Record<string, string | number | boolean>) =>
      await studio.lint({
        workspaceId: 'fixture',
        windowName: 'condition_window',
        scenario: { id, values },
        generatedScenarios: { enabled: false },
      });
    const missing = await preview('property-missing', {});
    const declaredTrue = await preview('property-true', {
      show_dynamic: true,
      allow_dynamic: true,
    });
    const declaredFalse = await preview('property-false', {
      show_dynamic: false,
      allow_dynamic: false,
    });
    const overridden = await preview('property-override', {
      'dynamic_visibility.visible': false,
      'dynamic_enablement.enabled': true,
    });
    const element = (result: typeof missing, name: string) =>
      result.scene.elements.find((candidate) => candidate.name === name);
    expect(element(missing, 'dynamic_visibility')).toMatchObject({
      visible: true,
      visibilityStatus: 'unresolved',
    });
    expect(element(missing, 'dynamic_visibility')?.visibilityStatusReason).toContain(
      'show_dynamic',
    );
    expect(element(missing, 'dynamic_enablement')).toMatchObject({
      visible: true,
      enablement: 'unresolved',
      clickable: false,
    });
    expect(element(missing, 'dynamic_enablement')?.enablementReason).toContain('allow_dynamic');
    expect(element(declaredTrue, 'dynamic_visibility')).toMatchObject({
      visible: true,
      visibilityStatus: 'shown',
    });
    expect(element(declaredTrue, 'dynamic_enablement')).toMatchObject({
      enablement: 'enabled',
      clickable: true,
    });
    expect(element(declaredFalse, 'dynamic_visibility')).toMatchObject({
      visible: false,
      visibilityStatus: 'hidden',
    });
    expect(element(declaredFalse, 'dynamic_enablement')).toMatchObject({
      enablement: 'disabled',
      clickable: false,
    });
    expect(element(overridden, 'dynamic_visibility')).toMatchObject({
      visible: false,
      visibilityStatus: 'hidden',
    });
    expect(element(overridden, 'dynamic_enablement')).toMatchObject({
      enablement: 'enabled',
      clickable: true,
    });
    const missingMatrix = scenarioMatrixEvidence(missing.graph, [missing.scene]);
    const branches = missingMatrix.branchCoverage as Array<{
      element: string;
      visibility?: { shown: string[]; hidden: string[]; unresolved: string[]; covered: boolean };
      enabled?: { enabled: string[]; disabled: string[]; unresolved: string[]; covered: boolean };
    }>;
    expect(branches.find(({ element }) => element === 'dynamic_visibility')?.visibility).toEqual({
      shown: [],
      hidden: [],
      unresolved: ['property-missing'],
      covered: false,
    });
    expect(branches.find(({ element }) => element === 'dynamic_enablement')?.enabled).toEqual({
      enabled: [],
      disabled: [],
      unresolved: ['property-missing'],
      covered: false,
    });
    const resolvedMatrix = scenarioMatrixEvidence(missing.graph, [
      declaredTrue.scene,
      declaredFalse.scene,
    ]);
    const resolvedBranches = resolvedMatrix.branchCoverage as typeof branches;
    expect(
      resolvedBranches.find(({ element }) => element === 'dynamic_visibility')?.visibility,
    ).toMatchObject({ shown: ['property-true'], hidden: ['property-false'], covered: true });
    expect(
      resolvedBranches.find(({ element }) => element === 'dynamic_enablement')?.enabled,
    ).toMatchObject({ enabled: ['property-true'], disabled: ['property-false'], covered: true });
  });
  it('keeps uncertain visibility as a preview while withholding verified branch coverage', async () => {
    const studio = await fixture();
    const preview = async (id: string, patch: Record<string, unknown>) =>
      await studio.lint({
        workspaceId: 'fixture',
        windowName: 'condition_window',
        scenario: { id, country: { tag: 'GER' }, ...patch },
        generatedScenarios: { enabled: false },
      });
    const matching = await preview('matching-visible', { controls: { '87': 'GER' } });
    const wrong = await preview('wrong-visible', { controls: { '87': 'FRA' } });
    const missing = await preview('missing-visible', {});
    const scoped = await preview('scoped-visible', {
      scopes: { FROM: { id: 'target', state: { a: 1 } } },
    });
    const forcedShown = await preview('forced-shown', {
      visibility: { controlled_visibility: true },
    });
    const forcedHidden = await preview('forced-hidden', {
      visibility: { controlled_visibility: false },
    });
    const element = (result: typeof matching, name: string) =>
      result.scene.elements.find((candidate) => candidate.name === name);
    expect(element(matching, 'controlled_visibility')).toMatchObject({
      visible: true,
      visibilityStatus: 'shown',
    });
    expect(element(wrong, 'controlled_visibility')).toMatchObject({
      visible: false,
      visibilityStatus: 'hidden',
    });
    expect(element(missing, 'controlled_visibility')).toMatchObject({
      visible: true,
      visibilityStatus: 'unresolved',
    });
    expect(element(missing, 'controlled_visibility')?.visibilityStatusReason).toContain(
      'controlled_visibility_visible',
    );
    expect(element(missing, 'visibility_action')).toMatchObject({
      visible: true,
      visibilityStatus: 'unresolved',
      enablement: 'unresolved',
      clickable: false,
    });
    expect(element(missing, 'scoped_visibility')).toMatchObject({
      visible: true,
      visibilityStatus: 'unresolved',
    });
    expect(element(missing, 'scoped_visibility')?.visibilityStatusReason).toContain('FROM');
    expect(element(scoped, 'scoped_visibility')).toMatchObject({
      visible: true,
      visibilityStatus: 'shown',
    });
    expect(element(forcedShown, 'controlled_visibility')).toMatchObject({
      visible: true,
      visibilityStatus: 'shown',
    });
    expect(element(forcedHidden, 'controlled_visibility')).toMatchObject({
      visible: false,
      visibilityStatus: 'hidden',
    });
    const potentialOverlay = await renderGuiScene(missing.scene, ['click-regions']);
    expect(potentialOverlay.images[0]?.svg).toContain(
      'Potential click region: condition_gui.visibility_action_visible',
    );
    const evidence = scenarioMatrixEvidence(matching.graph, [
      matching.scene,
      wrong.scene,
      missing.scene,
      forcedShown.scene,
      forcedHidden.scene,
    ]);
    const branch = (
      evidence.branchCoverage as Array<{
        element: string;
        visibility?: { shown: string[]; hidden: string[]; unresolved: string[]; covered: boolean };
      }>
    ).find(({ element }) => element === 'controlled_visibility');
    expect(branch?.visibility).toEqual({
      shown: ['matching-visible', 'forced-shown'],
      hidden: ['wrong-visible', 'forced-hidden'],
      unresolved: ['missing-visible'],
      covered: true,
    });
    const unresolvedOnly = scenarioMatrixEvidence(matching.graph, [missing.scene]);
    const onlyBranch = (
      unresolvedOnly.branchCoverage as Array<{
        element: string;
        visibility?: { shown: string[]; hidden: string[]; unresolved: string[]; covered: boolean };
      }>
    ).find(({ element }) => element === 'controlled_visibility');
    expect(onlyBranch?.visibility).toEqual({
      shown: [],
      hidden: [],
      unresolved: ['missing-visible'],
      covered: false,
    });
    const visibilityAction = (
      unresolvedOnly.branchCoverage as Array<{
        element: string;
        visibility?: { shown: string[]; unresolved: string[] };
      }>
    ).find(({ element }) => element === 'visibility_action');
    expect(visibilityAction?.visibility).toMatchObject({
      shown: [],
      unresolved: ['missing-visible'],
    });
    expect(
      (
        unresolvedOnly.scenarios as Array<{
          unresolvedVisibility: Array<{ name: string; previewVisible: boolean }>;
        }>
      )[0]?.unresolvedVisibility,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'controlled_visibility', previewVisible: true }),
      ]),
    );
  });
  it('retains verified, rejected, and unresolved click enablement in scenes and matrix evidence', async () => {
    const studio = await fixture();
    const preview = async (id: string, patch: Record<string, unknown>) =>
      await studio.lint({
        workspaceId: 'fixture',
        windowName: 'condition_window',
        scenario: { id, country: { tag: 'GER' }, ...patch },
        generatedScenarios: { enabled: false },
      });
    const matching = await preview('matching', { controls: { '87': 'GER' } });
    const wrong = await preview('wrong', { controls: { '87': 'FRA' } });
    const missing = await preview('missing', {});
    const scoped = await preview('scoped', { scopes: { FROM: { id: 'target', state: { a: 1 } } } });
    const overridden = await preview('override', {
      values: { 'controlled_action.enabled': true, 'scoped_action.enabled': false },
    });
    const action = (result: typeof matching, name: string) =>
      result.scene.elements.find((element) => element.name === name);
    expect(action(matching, 'controlled_action')).toMatchObject({
      enablement: 'enabled',
      clickable: true,
    });
    expect(action(wrong, 'controlled_action')).toMatchObject({
      enablement: 'disabled',
      clickable: false,
      disabledReason: 'scripted_enabled_false',
    });
    expect(action(missing, 'controlled_action')).toMatchObject({
      enablement: 'unresolved',
      clickable: false,
      state: 'normal',
    });
    expect(action(missing, 'controlled_action')?.enablementReason).toContain(
      'controlled_action_click_enabled',
    );
    expect(action(missing, 'scoped_action')).toMatchObject({
      enablement: 'unresolved',
      clickable: false,
    });
    expect(action(scoped, 'scoped_action')).toMatchObject({
      enablement: 'enabled',
      clickable: true,
    });
    expect(action(overridden, 'controlled_action')).toMatchObject({
      enablement: 'enabled',
      clickable: true,
    });
    expect(action(overridden, 'scoped_action')).toMatchObject({
      enablement: 'disabled',
      clickable: false,
    });
    const hover = await preview('hover', { state: 'hover' });
    const locked = await preview('locked', { elementStates: { controlled_action: 'locked' } });
    expect(action(hover, 'controlled_action')).toMatchObject({
      state: 'hover',
      enablement: 'unresolved',
      clickable: false,
    });
    expect(action(locked, 'controlled_action')).toMatchObject({
      state: 'locked',
      enablement: 'disabled',
      disabledReason: 'scenario_state',
      clickable: false,
    });
    const overlay = await renderGuiScene(missing.scene, ['click-regions']);
    expect(overlay.images[0]?.svg).toContain('Potential click region:');
    const lockedOverlay = await renderGuiScene(locked.scene, ['click-regions']);
    expect(lockedOverlay.images[0]?.svg).not.toContain(
      'Potential click region: condition_gui.controlled_action_click_enabled',
    );
    const matrix = scenarioMatrixEvidence(matching.graph, [
      matching.scene,
      wrong.scene,
      missing.scene,
      overridden.scene,
    ]);
    const branch = (
      matrix.branchCoverage as Array<{
        element: string;
        enabled?: { enabled: string[]; disabled: string[]; unresolved: string[]; covered: boolean };
      }>
    ).find(({ element }) => element === 'controlled_action');
    expect(branch?.enabled).toEqual({
      enabled: ['matching', 'override'],
      disabled: ['wrong'],
      unresolved: ['missing'],
      covered: true,
    });
    const unresolvedOnly = scenarioMatrixEvidence(matching.graph, [missing.scene]);
    const unresolvedBranch = (
      unresolvedOnly.branchCoverage as Array<{
        element: string;
        enabled?: { covered: boolean; unresolved: string[] };
      }>
    ).find(({ element }) => element === 'controlled_action');
    expect(unresolvedBranch?.enabled).toMatchObject({ covered: false, unresolved: ['missing'] });
    expect(
      (unresolvedOnly.scenarios as Array<{ unresolvedClickRegions: Array<{ name: string }> }>)[0]
        ?.unresolvedClickRegions,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'controlled_action' })]));
  });
  it('loads localisation selected only by explicit scenario text overrides', async () => {
    const studio = await fixture();
    const result = await studio.lint({
      workspaceId: 'fixture',
      windowName: 'condition_window',
      scenario: { id: 'localised', values: { 'inclusive.text': 'OVERRIDE_LABEL' } },
      generatedScenarios: { enabled: false },
    });
    expect(result.scene.elements.find(({ name }) => name === 'inclusive')?.text?.text).toBe(
      'Scenario-selected localisation',
    );
  });
  it('carries explicit dates and controllers into source-driven rendered text', async () => {
    const studio = await fixture();
    const result = await studio.lint({
      workspaceId: 'fixture',
      windowName: 'condition_window',
      scenario: {
        id: 'dated',
        date: '1944-10-01',
        country: { tag: 'GER' },
        controls: { '87': 'GER', '88': 'GER' },
      },
      generatedScenarios: { seed: 'dated-controller', count: 1 },
    });
    expect(result.scene.elements.find(({ name }) => name === 'dated')?.text?.text).toBe(
      'Dated: TRUE',
    );
    expect(result.scene.elements.find(({ name }) => name === 'controlled')?.text?.text).toBe(
      'Controlled: TRUE',
    );
    expect(result.scene.scenario.date).toBe('1944.10.1');
    expect(result.scene.scenario.controls).toEqual({ '87': 'GER', '88': 'GER' });
  });
  it.each(['variables', 'stateValues'] as const)(
    'renders explicit %s through conditions without replacing inputs or guessing unknown branches',
    async (valueSource) => {
      const studio = await fixture();
      const input = {
        workspaceId: 'fixture',
        windowName: 'condition_window',
        scenario: {
          id: 'explicit',
          [valueSource]: { a: 10, b: 0 },
          scopes: { FROM: { id: 'target', state: { a: 2 } } },
        },
        generatedScenarios: { seed: 'conditions', count: 1 },
      };
      const first = await studio.lint(input);
      const second = await studio.lint(input);
      expect(first.scene.scenario).toEqual(second.scene.scenario);
      const texts = Object.fromEntries(
        first.scene.elements
          .filter(({ text }) => text !== undefined)
          .map(({ name, text }) => [name, text?.text]),
      );
      expect(texts).toMatchObject({
        inclusive: 'Inclusive: TRUE',
        compound: 'Compound: FALSE',
        negation: 'Negation: FALSE',
        helper: 'Helper: TRUE',
        scoped: 'Scoped: TRUE',
        unknown: 'Unknown: [dynamic_loc]',
      });
      expect(first.scene.scenario.values).toMatchObject({ a: 10, b: 0 });
      expect(first.scene.scenario.conditionResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            token: 'GetUnknown',
            state: 'unresolved',
            unresolved: [expect.stringContaining('unmodelled_condition')],
          }),
        ]),
      );
      const render = await renderGuiScene(first.scene, ['full']);
      const repeat = await renderGuiScene(second.scene, ['full']);
      expect(render.images[0]?.svg).toBe(repeat.images[0]?.svg);
      expect(render.images[0]?.png).toEqual(repeat.images[0]?.png);
      expect(render.images[0]?.svg).toContain('fill="#ff3232"');
      expect(render.images[0]?.svg).toContain('data-hoi4-colour-runs="true"');
      // Without generation, the supplied scenario still resolves every branch it decides and
      // leaves the undecidable one visibly unresolved.
      const placeholder = await studio.lint({ ...input, generatedScenarios: { enabled: false } });
      const placeholderText = (name: string) =>
        placeholder.scene.elements.find((element) => element.name === name)?.text?.text;
      expect(placeholderText('inclusive')).toBe('Inclusive: TRUE');
      expect(placeholderText('unknown')).toBe('Unknown: [dynamic_loc]');
    },
  );

  it('never replaces explicit localisation selections with generated choices', async () => {
    const studio = await fixture();
    const result = await studio.lint({
      workspaceId: 'fixture',
      windowName: 'condition_window',
      scenario: { id: 'override', values: { a: 10, b: 0, GetInclusive: 'Explicit text' } },
      generatedScenarios: { seed: 'override', count: 1 },
    });
    expect(result.scene.elements.find(({ name }) => name === 'inclusive')?.text?.text).toBe(
      'Inclusive: Explicit text',
    );
  });
});
