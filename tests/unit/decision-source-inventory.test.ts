import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import {
  decisionSourceInventory,
  decisionTargetCatalog,
} from '../../src/hoi4_agent_tools/decision/source-inventory.js';

function source(
  relativePath: string,
  text: string,
  rootKind: ScannedFile['rootKind'] = 'mod',
  loadOrder = 1,
): ScannedFile {
  const bytes = Buffer.from(text);
  return {
    absolutePath: `/fixture/${rootKind}/${relativePath}`,
    displayPath: `${rootKind}:${relativePath}`,
    relativePath,
    rootKind,
    loadOrder,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

function inventory(files: ScannedFile[]) {
  const index = SymbolIndex.build(files);
  return decisionSourceInventory({
    revision: 'fixture-revision',
    files,
    index,
    complete: index.complete,
    skippedSourceCount: index.skippedSourceCount,
  });
}

describe('decision source inventory', () => {
  it('joins category fragments with active decisions and keeps actor/target and mission fields distinct', () => {
    const result = inventory([
      source(
        'common/decisions/categories/categories.txt',
        'political_actions = { allowed = { original_tag = GER } visible = { has_country_flag = unlocked } }',
      ),
      source(
        'common/decisions/actions.txt',
        `political_actions = {
          target_country = {
            targets = { FRA BEL }
            target_root_trigger = { has_country_flag = unlocked }
            target_trigger = { FROM = { has_idea = target_idea } }
            available = { FROM = { has_idea = target_idea } }
            custom_cost_trigger = { has_political_power > 20 }
            custom_cost_text = custom_cost
            complete_effect = { add_to_variable = { treasury = -20 } }
            ai_will_do = { factor = 1 }
          }
          mission = {
            activation = { has_country_flag = mission_ready }
            days_mission_timeout = 30
            available = { has_country_flag = mission_complete }
            timeout_effect = { set_country_flag = mission_failed }
            cancel_trigger = { has_country_flag = mission_cancelled }
          }
        }`,
      ),
    ]);
    expect(result.complete).toBe(true);
    expect(result.unresolvedDefinitions).toEqual([]);
    expect(result.decisions.map(({ id, kind }) => [id, kind])).toEqual([
      ['mission', 'mission'],
      ['target_country', 'decision'],
    ]);
    const target = result.decisions[1]!;
    expect(target.category).toBe('political_actions');
    expect(target.fields.targets).toHaveLength(1);
    expect(target.fields.target_root_trigger).toHaveLength(1);
    expect(target.fields.target_trigger).toHaveLength(1);
    expect(target.fields.custom_cost_trigger).toHaveLength(1);
    expect(target.fields.complete_effect).toHaveLength(1);
    expect(target.fields.ai_will_do).toHaveLength(1);
    expect(target.fields.days_mission_timeout).toHaveLength(0);
    expect(decisionTargetCatalog(target)).toMatchObject({
      targeted: true,
      explicitTargets: ['FRA', 'BEL'],
      targetArrays: [],
      stateFilters: [],
      hasTargetRootTrigger: true,
      hasTargetTrigger: true,
    });
    expect(result.decisions[0]!.fields.timeout_effect).toHaveLength(1);
    expect(result.categories.some(({ fields }) => fields.allowed.length === 1)).toBe(true);
  });

  it('selects the active decision without silently dropping overridden source evidence', () => {
    const vanilla = source(
      'common/decisions/vanilla.txt',
      'political_actions = { shared = { cost = 10 complete_effect = { add_political_power = 1 } } }',
      'game',
      0,
    );
    const mod = source(
      'common/decisions/mod.txt',
      'political_actions = { shared = { cost = 20 complete_effect = { add_political_power = 2 } } }',
    );
    const result = inventory([vanilla, mod]);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({
      id: 'shared',
      path: mod.displayPath,
      sourceHash: mod.sha256,
    });
    expect(result.decisions[0]!.fields.cost[0]!.value).toMatchObject({ value: '20' });
    expect(result.overrides).toEqual([
      expect.objectContaining({ kind: 'decision', id: 'shared', path: vanilla.displayPath }),
    ]);
  });
});
