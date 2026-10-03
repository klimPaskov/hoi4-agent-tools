import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { ReferenceService } from '../../src/hoi4_agent_tools/reference/service.js';
import { validateScript } from '../../src/hoi4_agent_tools/reference/script-validation.js';
import {
  scriptValidateDataSchema,
  scriptValidateRequestSchema,
} from '../../src/hoi4_agent_tools/schemas/script-validation.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const docs = (entries: Array<[string, string]>) =>
  entries
    .map(
      ([name, scope]) =>
        `## ${name}\n\n* Supported Scopes: ${scope}\n* Supported Targets: none\n\nDocumentation for ${name}.\n`,
    )
    .join('\n');
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-script-check-'));
  roots.push(root);
  const mod = path.join(root, 'mod');
  const game = path.join(root, 'game');
  const generated = path.join(mod, 'script_docs');
  await Promise.all([
    mkdir(path.join(game, 'documentation'), { recursive: true }),
    mkdir(path.join(mod, 'paradox_wiki'), { recursive: true }),
    mkdir(generated, { recursive: true }),
  ]);
  const effects = path.join(game, 'documentation', 'effects_documentation.md');
  await writeFile(
    effects,
    docs([
      ['add_power', 'COUNTRY'],
      ['add_population', 'STATE'],
      ['if', 'any'],
      ['every_state', 'any'],
      ['hidden_effect', 'any'],
      ['set_variable', 'any'],
    ]),
  );
  await writeFile(
    path.join(game, 'documentation', 'triggers_documentation.md'),
    docs([
      ['has_flag', 'COUNTRY'],
      ['is_core', 'STATE'],
      ['and', 'any'],
      ['not', 'any'],
      ['or', 'any'],
    ]),
  );
  await writeFile(
    path.join(mod, 'paradox_wiki', 'Effects.md'),
    docs([['wiki_only_command', 'COUNTRY']]),
  );
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [{ id: 'fixture', name: 'Fixture', root: mod, gameRoot: game }],
    }),
  );
  const service = new ReferenceService();
  const check = async (source: string, options: Record<string, unknown> = {}) =>
    scriptValidateDataSchema.parse(
      await validateScript(
        service,
        resolver.get('fixture'),
        scriptValidateRequestSchema.parse({
          workspaceId: 'fixture',
          source,
          kind: 'effect',
          scope: 'country',
          ...options,
        }),
      ),
    );
  return { effects, generated, check };
}

describe('documentation-backed script checks', () => {
  it('checks native command kinds and scopes with exact local citations', async () => {
    const { check, effects } = await fixture();
    const good = await check('add_power = 2');
    expect(good.valid).toBe(true);
    expect(good.parametersChecked).toBe(false);
    expect(good.findings[0]).toMatchObject({
      code: 'SCRIPT_COMMAND_SUPPORTED',
      reference: { path: effects, heading: 'add_power', startLine: 1 },
    });
    const wrongScope = await check('add_power = 2', { scope: 'state' });
    expect(wrongScope.valid).toBe(false);
    expect(wrongScope.findings[0]?.code).toBe('SCRIPT_COMMAND_WRONG_SCOPE');
    const wrongKind = await check('has_flag = x');
    expect(wrongKind.valid).toBe(false);
    expect(wrongKind.findings[0]?.code).toBe('SCRIPT_COMMAND_WRONG_KIND');
  });

  it('checks conditional limits and iterator scopes without treating argument fields as commands', async () => {
    const { check } = await fixture();
    const result = await check(
      'if = { limit = { AND = { has_flag = x } } every_state = { limit = { is_core = yes } add_population = 5 } }',
    );
    expect(result.valid).toBe(true);
    expect(result.checkedCommands).toBe(6);
    const bad = await check('every_state = { add_power = 5 }');
    expect(bad.valid).toBe(false);
    expect(bad.findings[0]).toMatchObject({ code: 'SCRIPT_COMMAND_WRONG_SCOPE', scope: 'state' });
    const args = await check('set_variable = { value = 5 }');
    expect(args.valid).toBeNull();
    expect(args.argumentBlocksUnchecked).toBe(1);
    expect(args.findings.some(({ command }) => command === 'value')).toBe(false);
  });

  it('tracks ROOT, PREV and declared external bindings', async () => {
    const { check } = await fixture();
    expect(
      (await check('12 = { add_population = 5 PREV = { add_power = 2 } ROOT = { add_power = 1 } }'))
        .valid,
    ).toBe(true);
    expect((await check('event_target:recipient = { add_power = 1 }')).valid).toBeNull();
    expect(
      (
        await check('event_target:recipient = { add_power = 1 }', {
          bindings: [{ name: 'event_target:recipient', scope: 'country' }],
        })
      ).valid,
    ).toBe(true);
    await expect(
      check('add_power = 1', { bindings: [{ name: 'ROOT', scope: 'state' }] }),
    ).rejects.toMatchObject({ code: 'SCRIPT_BINDING_RESERVED' });
  });

  it('keeps undocumented helpers unresolved and suggests close documented names', async () => {
    const { check } = await fixture();
    const result = await check('add_powre = 1 custom_helper = yes wiki_only_command = yes');
    expect(result.valid).toBeNull();
    expect(result.unresolvedCount).toBe(3);
    expect(result.findings[0]?.suggestions).toContain('add_power');
    expect(result.findings.some(({ code }) => code === 'SCRIPT_COMMAND_SUPPORTED')).toBe(false);
  });

  it('reports parse failures and malformed known control blocks', async () => {
    const { check } = await fixture();
    expect((await check('if = {')).valid).toBe(false);
    const malformed = await check('if = yes');
    expect(malformed.valid).toBe(false);
    expect(malformed.findings[0]?.code).toBe('SCRIPT_EXPECTED_BLOCK');
    expect((await check('if = { limit = yes add_power = 1 }')).valid).toBe(false);
    expect((await check('every_state = yes')).valid).toBe(false);
    expect((await check('has_flag >= x', { kind: 'trigger' })).findings[0]?.code).toBe(
      'SOURCE_UNSUPPORTED_OPERATOR',
    );
    await expect(check('add_power = 1', { scope: 'countri' })).rejects.toThrow();
  });

  it('does not silently substitute another source when generated documentation is absent', async () => {
    const { check, generated } = await fixture();
    expect((await check('add_power = 1', { documentation: 'script_doc' })).valid).toBeNull();
    await writeFile(
      path.join(generated, 'effect_docs.log'),
      'add_power\n  Supported Scopes: STATE\n  Adds power in the generated fixture.\n',
    );
    const generatedResult = await check('add_power = 1', {
      documentation: 'script_doc',
      scope: 'state',
    });
    expect(generatedResult.valid).toBe(true);
    expect(generatedResult.findings[0]?.reference?.source).toBe('script_doc');
    expect((await check('add_power = 1', { scope: 'state' })).valid).toBe(false);
  });

  it('detects changed and conflicting documentation', async () => {
    const { check, effects } = await fixture();
    const before = await check('add_power = 1');
    await writeFile(effects, docs([['add_power', 'STATE']]));
    const after = await check('add_power = 1');
    expect(after.documentation.revision).not.toBe(before.documentation.revision);
    expect(after.valid).toBe(false);
    await writeFile(
      effects,
      docs([
        ['add_power', 'COUNTRY'],
        ['add_power', 'STATE'],
      ]),
    );
    const conflict = await check('add_power = 1');
    expect(conflict.valid).toBeNull();
    expect(conflict.findings[0]?.code).toBe('SCRIPT_DOCUMENTATION_CONFLICT');
  });

  it('prioritizes problems in bounded replies and never treats budget exhaustion as full coverage', async () => {
    const { check } = await fixture();
    const result = await check('add_power = 1 add_population = 1', { limit: 1 });
    expect(result.valid).toBe(false);
    expect(result.findings[0]?.code).toBe('SCRIPT_COMMAND_WRONG_SCOPE');
    expect(result.omittedFindings).toBe(1);
    const large = await check('add_power = 1\n'.repeat(300));
    expect(large.valid).toBeNull();
    expect(large.truncated).toBe(true);
    expect(large.checkedCommands).toBe(256);
    await expect(check(`add_power = "${'🟢'.repeat(20_000)}"`)).rejects.toMatchObject({
      code: 'SCRIPT_SOURCE_TOO_LARGE',
    });
  });

  it('bounds citation-heavy replies without changing the result of checks that were performed', async () => {
    const { check, effects } = await fixture();
    const names = Array.from({ length: 32 }, (_, index) => `command_${index}`);
    await writeFile(
      effects,
      names
        .map((name) => `## ${name}\n${'界'.repeat(300)}\n* Supported Scopes: COUNTRY\n`)
        .join('\n'),
    );
    const result = await check(names.map((name) => `${name} = 1`).join('\n'), { limit: 32 });
    expect(result.valid).toBe(true);
    expect(result.checkedCommands).toBe(32);
    expect(result.omittedFindings).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16_000);
  });
});
