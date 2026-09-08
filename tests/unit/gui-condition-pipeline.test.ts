import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { ScriptedGuiStudio, renderGuiScene } from '../../src/hoi4_agent_tools/gui/index.js';

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
    'interface/test.gui': `guiTypes = { containerWindowType = { name = "condition_window" size = { width = 640 height = 220 }
      ${['inclusive', 'compound', 'negation', 'helper', 'scoped', 'unknown'].map((name, index) => `instantTextBoxType = { name = "${name}" position = { x = 5 y = ${index * 30} } size = { width = 600 height = 25 } text = "LABEL_${name}" }`).join('\n')}
    } }`,
    'common/scripted_localisation/test.txt': `@limit = 10
      defined_text = { name = GetInclusive text = { trigger = { check_variable = { var = a value = @limit compare = greater_than_or_equals } } localization_key = TRUE_TEXT } text = { localization_key = FALSE_TEXT } }
      defined_text = { name = GetCompound text = { trigger = { AND = { a > 5 b > 5 } } localization_key = TRUE_TEXT } text = { localization_key = FALSE_TEXT } }
      defined_text = { name = GetNot text = { trigger = { NOT = { a > 5 } } localization_key = TRUE_TEXT } text = { localization_key = FALSE_TEXT } }
      defined_text = { name = GetHelper text = { trigger = { gate = yes } localization_key = TRUE_TEXT } text = { localization_key = FALSE_TEXT } }
      defined_text = { name = GetScoped text = { trigger = { FROM = { check_variable = { var = a value = ROOT.a compare = less_than } } check_variable = { var = FROM.a value = ROOT.a compare = less_than } } localization_key = TRUE_TEXT } text = { localization_key = FALSE_TEXT } }
      defined_text = { name = GetUnknown text = { trigger = { unmodelled_condition = yes } localization_key = TRUE_TEXT } text = { trigger = { always = yes } localization_key = FALSE_TEXT } }
    `,
    'common/scripted_triggers/gate.txt':
      'gate = { check_variable = { var = a value = constant:limits.boundary compare = greater_than_or_equals } }',
    'common/script_constants/limits.txt': 'limits = { boundary = 10 }',
    'localisation/english/test_l_english.yml':
      '\uFEFFl_english:\nLABEL_inclusive: "Inclusive: [GetInclusive]"\nLABEL_compound: "Compound: [GetCompound]"\nLABEL_negation: "Negation: [GetNot]"\nLABEL_helper: "Helper: [GetHelper]"\nLABEL_scoped: "Scoped: [GetScoped]"\nLABEL_unknown: "Unknown: [GetUnknown]"\nTRUE_TEXT: "§GTRUE§!"\nFALSE_TEXT: "§RFALSE§!"\n',
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
      const placeholder = await studio.lint({ ...input, generatedScenarios: { enabled: false } });
      expect(placeholder.scene.elements.find(({ name }) => name === 'inclusive')?.text?.text).toBe(
        'Inclusive: [dynamic_loc]',
      );
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
