import path from 'node:path';
import type { z } from 'zod/v4';
import { hashCanonical } from '../core/canonical.js';
import { ServiceError } from '../core/result.js';
import {
  locationFor,
  parseClausewitz,
  type AssignmentNode,
  type BlockNode,
} from '../core/source/index.js';
import type { ResolvedWorkspace } from '../core/workspace.js';
import type {
  scriptValidateDataSchema,
  scriptValidateRequestSchema,
} from '../schemas/script-validation.js';
import { editDistance } from './suggestions.js';
import { publicReferenceSection, type ReferenceService, type ReferenceSection } from './service.js';

type Input = z.infer<typeof scriptValidateRequestSchema>;
type Output = z.infer<typeof scriptValidateDataSchema>;
type Kind = NonNullable<Input['kind']>;
type Finding = Output['findings'][number];
interface Signature {
  reference: ReferenceSection;
  scopes: string[];
  conflict: boolean;
}
const MAX_COMMANDS = 256;
const MAX_FILE_COMMANDS = 50_000;
/** A block whose scope the file's structure does not determine; scope checks are skipped. */
const UNKNOWN_SCOPE = 'unknown';

/** A scanned mod file checked in file mode, with the mod's scripted helper names. */
export interface ScriptFileContext {
  path: string;
  relativePath: string;
  bytes: Buffer;
  helpers: { effect: ReadonlySet<string>; trigger: ReadonlySet<string> };
  /**
   * Building, ideology and resource names the mod defines, each mapped to the documented
   * generic trigger (such as `building_count_trigger`) that accepts the name as its key.
   */
  implicitTriggers: ReadonlyMap<string, string>;
}

/**
 * Scope links from the wiki Scopes page: the scopes each link is usable in and the scope it
 * enters. The engine accepts these keys in any letter case.
 */
const scopeLinks: Readonly<Record<string, { from: readonly string[]; to: string }>> = {
  owner: { from: ['state', 'character', 'combatant'], to: 'country' },
  controller: { from: ['state'], to: 'country' },
  capital_scope: { from: ['country'], to: 'state' },
  overlord: { from: ['country'], to: 'country' },
  faction_leader: { from: ['country'], to: 'country' },
};

interface ScriptRoot {
  block: BlockNode;
  kind: Kind;
  scope: string;
}

const eventScopes: Readonly<Record<string, string>> = {
  country_event: 'country',
  news_event: 'country',
  state_event: 'state',
  unit_leader_event: 'character',
  operative_leader_event: 'character',
};
const optionMetadata = new Set([
  'name',
  'ai_chance',
  'original_recipient_only',
  'highlight_states',
  'is_triggered_only',
]);
const decisionTriggers = new Set([
  'allowed',
  'visible',
  'available',
  'cancel_trigger',
  'remove_trigger',
  'activation',
]);
const decisionEffects = new Set([
  'complete_effect',
  'remove_effect',
  'timeout_effect',
  'cancel_effect',
]);
const focusTriggers = new Set(['available', 'bypass', 'cancel', 'allow_branch']);
const focusEffects = new Set([
  'completion_reward',
  'select_effect',
  'cancel_effect',
  'bypass_effect',
]);

function blockOf(entry: BlockNode['entries'][number]): BlockNode | undefined {
  return entry.type === 'assignment' && entry.value.type === 'block' ? entry.value : undefined;
}

/**
 * The effect and trigger bodies of a mod file, with the scope its structure fixes. Families
 * whose scope depends on the caller, such as scripted helpers and on actions, are checked
 * without scope rules. An unrecognized family yields no roots.
 */
export function scriptRoots(
  relativePath: string,
  document: { root: BlockNode },
): { family: string; roots: ScriptRoot[] } {
  const file = relativePath.replaceAll('\\', '/').toLowerCase();
  const roots: ScriptRoot[] = [];
  const add = (block: BlockNode | undefined, kind: Kind, scope: string) => {
    if (block !== undefined) roots.push({ block, kind, scope });
  };
  const top = document.root.entries.filter(
    (entry): entry is Extract<BlockNode['entries'][number], { type: 'assignment' }> =>
      entry.type === 'assignment',
  );
  if (file.startsWith('events/')) {
    for (const event of top) {
      const scope = eventScopes[event.key.value];
      const body = blockOf(event);
      if (scope === undefined || body === undefined) continue;
      for (const entry of body.entries) {
        if (entry.type !== 'assignment') continue;
        const key = entry.key.value;
        if (key === 'trigger' || key === 'show_major') add(blockOf(entry), 'trigger', scope);
        else if (key === 'immediate' || key === 'after') add(blockOf(entry), 'effect', scope);
        else if (key === 'option') {
          const option = blockOf(entry);
          if (option === undefined) continue;
          const effects = option.entries.filter(
            (child) =>
              child.type !== 'assignment' ||
              (child.key.value !== 'trigger' && !optionMetadata.has(child.key.value)),
          );
          for (const child of option.entries)
            if (child.type === 'assignment' && child.key.value === 'trigger')
              add(blockOf(child), 'trigger', scope);
          if (effects.length > 0) add({ ...option, entries: effects }, 'effect', scope);
        }
      }
    }
    return { family: 'events', roots };
  }
  if (file.startsWith('common/decisions/') && !file.startsWith('common/decisions/categories/')) {
    for (const category of top)
      for (const decision of blockOf(category)?.entries ?? []) {
        const body = blockOf(decision);
        if (body === undefined) continue;
        for (const entry of body.entries) {
          if (entry.type !== 'assignment') continue;
          if (decisionTriggers.has(entry.key.value)) add(blockOf(entry), 'trigger', 'country');
          else if (entry.key.value === 'target_trigger')
            add(blockOf(entry), 'trigger', UNKNOWN_SCOPE);
          else if (decisionEffects.has(entry.key.value)) add(blockOf(entry), 'effect', 'country');
        }
      }
    return { family: 'decisions', roots };
  }
  if (file.startsWith('common/national_focus/')) {
    const focuses = top.flatMap((entry) =>
      entry.key.value === 'shared_focus'
        ? [entry]
        : entry.key.value === 'focus_tree'
          ? (blockOf(entry)?.entries ?? []).filter(
              (child) => child.type === 'assignment' && child.key.value === 'focus',
            )
          : [],
    );
    for (const focus of focuses)
      for (const entry of blockOf(focus)?.entries ?? []) {
        if (entry.type !== 'assignment') continue;
        if (focusTriggers.has(entry.key.value)) add(blockOf(entry), 'trigger', 'country');
        else if (focusEffects.has(entry.key.value)) add(blockOf(entry), 'effect', 'country');
      }
    return { family: 'national_focus', roots };
  }
  if (file.startsWith('common/scripted_effects/') || file.startsWith('common/scripted_triggers/')) {
    const kind: Kind = file.startsWith('common/scripted_effects/') ? 'effect' : 'trigger';
    for (const helper of top) add(blockOf(helper), kind, UNKNOWN_SCOPE);
    return { family: kind === 'effect' ? 'scripted_effects' : 'scripted_triggers', roots };
  }
  if (file.startsWith('common/on_actions/')) {
    for (const container of top)
      for (const action of blockOf(container)?.entries ?? [])
        for (const entry of blockOf(action)?.entries ?? [])
          if (entry.type === 'assignment' && entry.key.value === 'effect')
            add(blockOf(entry), 'effect', UNKNOWN_SCOPE);
    return { family: 'on_actions', roots };
  }
  return { family: 'unsupported', roots };
}
const booleanCommands = new Set(['AND', 'OR', 'NOT', 'XOR', 'NAND', 'NOR']);
const containers = new Set([
  'and',
  'or',
  'not',
  'xor',
  'nand',
  'nor',
  'hidden_trigger',
  'hidden_effect',
]);
const conditionals = new Set(['if', 'else_if', 'else']);
const iteratorParameters = new Set([
  'tooltip',
  'random_select_amount',
  'display_individual_scopes',
  'count',
]);

/** Check only rules explicitly available from one selected documentation authority. */
export async function validateScript(
  references: ReferenceService,
  workspace: ResolvedWorkspace,
  input: Input,
  signal?: AbortSignal,
  file?: ScriptFileContext,
): Promise<Output> {
  if (file === undefined && Buffer.byteLength(input.source ?? '', 'utf8') > 64_000)
    throw new ServiceError('SCRIPT_SOURCE_TOO_LARGE', 'Snippet exceeds 64000 UTF-8 bytes');
  const inventory = await references.inventory(workspace, signal, [input.documentation]);
  const catalogs: Record<Kind, Map<string, Signature>> = { effect: new Map(), trigger: new Map() };
  const sources = new Map<string, string>();
  const dynamicVariables = new Set<string>();
  // Generic triggers such as `building_count_trigger` are written with a listed name as the
  // key (`arms_factory > 2`); each listed name checks as that documented trigger.
  const implicitNames = new Map<string, string>();
  for (const section of inventory.sections) {
    const filename = path.basename(section.path).toLowerCase();
    if (
      filename === 'dynamic_variables_documentation.md' &&
      /^[a-z_][a-z0-9_]{0,255}$/u.test(section.heading)
    )
      dynamicVariables.add(section.heading);
    const match = /^(effects?|triggers?)_(?:documentation|docs)\.(?:md|log)$/u.exec(filename);
    if (match === null) continue;
    sources.set(section.path, section.revision);
    if (!/^[a-z_][a-z0-9_]{0,255}$/u.test(section.heading)) continue;
    const scopeLine = /^\s*(?:\*\s*)?Supported Scopes:\s*(.+?)\s*$/imu.exec(
      section.lines.join('\n'),
    );
    if (scopeLine === null || !/^[a-z_,\s]+$/iu.test(scopeLine[1]!)) continue;
    const scopes = [
      ...new Set(
        scopeLine[1]!
          .toLowerCase()
          .split(/[,\s]+/u)
          .filter(Boolean),
      ),
    ].sort();
    const kind: Kind = match[1]!.startsWith('effect') ? 'effect' : 'trigger';
    const body = section.lines.join('\n');
    const listed = /^Supported (?!Scopes|Targets)[A-Za-z ]+:\s*([a-z0-9_,\s]+?)\.?\s*$/mu.exec(
      body,
    );
    if (kind === 'trigger' && listed !== null && /^Usage:\s*<[A-Za-z]+>/mu.test(body))
      for (const name of listed[1]!.split(/[,\s]+/u).filter(Boolean))
        if (!implicitNames.has(name)) implicitNames.set(name, section.heading);
    const previous = catalogs[kind].get(section.heading);
    const reference = publicReferenceSection(section);
    if (previous !== undefined) {
      previous.conflict ||= previous.scopes.join(',') !== scopes.join(',');
    } else catalogs[kind].set(section.heading, { reference, scopes, conflict: false });
  }
  for (const [name, heading] of [...implicitNames, ...(file?.implicitTriggers ?? [])]) {
    const signature = catalogs.trigger.get(heading);
    if (signature !== undefined && !catalogs.trigger.has(name))
      catalogs.trigger.set(name, signature);
  }
  const documentPath = file?.path ?? 'snippet';
  const document = parseClausewitz(
    file?.bytes ?? Buffer.from(input.source ?? '', 'utf8'),
    documentPath,
  );
  const commandLimit = file === undefined ? MAX_COMMANDS : MAX_FILE_COMMANDS;
  let rootScope = input.scope ?? UNKNOWN_SCOPE;
  const findings: Finding[] = [];
  let visited = 0;
  let checkedCommands = 0;
  let argumentBlocksUnchecked = 0;
  let suggestionBudget = 4000;
  const bindings = new Map<string, string>();
  for (const binding of input.bindings) {
    if (bindings.has(binding.name))
      throw new ServiceError('SCRIPT_BINDING_DUPLICATE', 'Scope bindings must have unique names');
    if (binding.name === 'ROOT' || binding.name === 'THIS' || binding.name === 'PREV')
      throw new ServiceError(
        'SCRIPT_BINDING_RESERVED',
        'ROOT, THIS and PREV follow the supplied scope and traversal stack',
      );
    bindings.set(binding.name, binding.scope);
  }
  const report = (
    entry: AssignmentNode,
    kind: Kind,
    scope: string,
    details: Omit<Finding, 'command' | 'kind' | 'scope' | 'line' | 'column'>,
  ) => {
    const position = locationFor(documentPath, document.lineIndex, entry.start, entry.end).start;
    // A file check lists only problems; matching commands are counted, not itemized.
    if (
      file !== undefined &&
      (details.status === 'supported' || details.code === 'SCRIPT_ARGUMENT_BLOCK_UNCHECKED')
    )
      return;
    findings.push({
      ...details,
      command: entry.key.value.slice(0, 256),
      kind,
      scope,
      line: position.line,
      column: position.column,
    });
  };
  for (const diagnostic of document.diagnostics)
    findings.push({
      code: diagnostic.code,
      status: 'error',
      command: '',
      kind: input.kind ?? 'effect',
      scope: input.scope ?? UNKNOWN_SCOPE,
      line: diagnostic.location?.start.line ?? 1,
      column: diagnostic.location?.start.column ?? 1,
      message: diagnostic.message.slice(0, 500),
      suggestions: [],
    });
  const walk = (block: BlockNode, kind: Kind, scope: string, previous?: string): void => {
    for (const entry of block.entries) {
      signal?.throwIfAborted();
      if (++visited > commandLimit) {
        return;
      }
      if (entry.type !== 'assignment') {
        const position = locationFor(
          documentPath,
          document.lineIndex,
          entry.start,
          entry.end,
        ).start;
        findings.push({
          code: 'SCRIPT_EXPECTED_COMMAND',
          status: 'error',
          command: '',
          kind,
          scope,
          line: position.line,
          column: position.column,
          message: 'Expected a command assignment in this effect or trigger body',
          suggestions: [],
        });
        continue;
      }
      const raw = entry.key.value;
      if (raw.startsWith('@')) continue;
      const name = booleanCommands.has(raw) ? raw.toLowerCase() : raw;
      const explicitScope =
        raw === 'ROOT'
          ? rootScope
          : raw === 'THIS'
            ? scope
            : raw === 'PREV'
              ? previous
              : bindings.get(raw);
      const fixedScope =
        /^[A-Z][A-Z0-9]{2}$/u.test(raw) &&
        !['ROOT', 'THIS', 'PREV', 'FROM', 'AND', 'NOT', 'XOR', 'NOR'].includes(raw)
          ? 'country'
          : /^\d+$/u.test(raw)
            ? 'state'
            : undefined;
      if (
        entry.value.type === 'block' &&
        (explicitScope !== undefined || fixedScope !== undefined)
      ) {
        walk(entry.value, kind, explicitScope ?? fixedScope!, scope);
        continue;
      }
      const link = entry.value.type === 'block' ? scopeLinks[raw.toLowerCase()] : undefined;
      if (link !== undefined && entry.value.type === 'block') {
        checkedCommands++;
        if (scope !== UNKNOWN_SCOPE && !link.from.includes(scope))
          report(entry, kind, scope, {
            code: 'SCRIPT_SCOPE_LINK_WRONG_SCOPE',
            status: 'error',
            message: `${raw} is usable only within ${link.from.join(', ')} scope`,
            suggestions: [],
          });
        walk(entry.value, kind, link.to, scope);
        continue;
      }
      // A file has no caller to declare FROM, chained links or targets; their blocks are
      // still checked for command kinds, without scope rules.
      if (
        file !== undefined &&
        entry.value.type === 'block' &&
        (/^(?:root|this|prev|from)(?:\.(?:root|this|prev|from))*$/iu.test(raw) ||
          /^(?:event_target|var|mio|sp):/u.test(raw))
      ) {
        const keyword = raw.toUpperCase();
        walk(
          entry.value,
          kind,
          keyword === 'ROOT'
            ? rootScope
            : keyword === 'THIS'
              ? scope
              : keyword === 'PREV'
                ? (previous ?? UNKNOWN_SCOPE)
                : UNKNOWN_SCOPE,
          scope,
        );
        continue;
      }
      const signature = catalogs[kind].get(name);
      if (signature === undefined && file?.helpers[kind].has(name) === true) {
        // A scripted helper of the mod; its own file is checked separately.
        checkedCommands++;
        continue;
      }
      // Only a scalar comparison (`num_owned_states > 1`) misuses a dynamic variable; a block
      // with that key is a scope or helper the catalog does not describe.
      if (
        signature === undefined &&
        kind === 'trigger' &&
        entry.value.type !== 'block' &&
        dynamicVariables.has(name)
      ) {
        report(entry, kind, scope, {
          code: 'SCRIPT_DYNAMIC_VARIABLE_AS_TRIGGER',
          status: 'error',
          message: `${name} is a documented dynamic variable, not a trigger; compare it with check_variable`,
          suggestions: ['check_variable'],
        });
        continue;
      }
      // else_if and else are control flow even where the documentation lists only `if`.
      if (signature === undefined && !conditionals.has(name) && !containers.has(name)) {
        const other = catalogs[kind === 'effect' ? 'trigger' : 'effect'].get(name);
        const suggestions =
          name.length > 128
            ? []
            : [...catalogs[kind].keys()]
                .filter((candidate) => Math.abs(candidate.length - name.length) <= 3)
                .filter(() => suggestionBudget-- > 0)
                .map((candidate) => ({ candidate, distance: editDistance(name, candidate) }))
                .filter(({ distance }) => distance <= 3)
                .sort(
                  (a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate, 'en'),
                )
                .slice(0, 3)
                .map(({ candidate }) => candidate);
        report(entry, kind, scope, {
          code: other === undefined ? 'SCRIPT_COMMAND_UNRESOLVED' : 'SCRIPT_COMMAND_WRONG_KIND',
          status: other === undefined ? 'unresolved' : 'error',
          message:
            other === undefined
              ? 'Not documented as a native command in the selected source; inspect scripted helpers or declare the scope binding'
              : `Documented as a ${kind === 'effect' ? 'trigger' : 'effect'}, not a ${kind}`,
          suggestions,
          ...(other === undefined ? {} : { reference: other.reference }),
        });
        continue;
      }
      checkedCommands++;
      if (signature !== undefined) {
        const wrongScope =
          scope !== UNKNOWN_SCOPE &&
          !signature.scopes.includes('any') &&
          !signature.scopes.includes(scope);
        report(entry, kind, scope, {
          code: signature.conflict
            ? 'SCRIPT_DOCUMENTATION_CONFLICT'
            : wrongScope
              ? 'SCRIPT_COMMAND_WRONG_SCOPE'
              : 'SCRIPT_COMMAND_SUPPORTED',
          status: signature.conflict ? 'unresolved' : wrongScope ? 'error' : 'supported',
          suggestions: [],
          reference: signature.reference,
          message: signature.conflict
            ? 'Conflicting supported scopes in the selected documentation'
            : wrongScope
              ? `Supported scopes: ${signature.scopes.join(', ')}`
              : 'Command kind and declared scope match the selected documentation',
        });
      }
      const iterator =
        /^(?:every|random|any|all)_(?:(?:owned|controlled|neighbor)_)?(state|country)$/u.exec(name);
      if (entry.value.type !== 'block') {
        if (containers.has(name) || conditionals.has(name) || iterator !== null)
          report(entry, kind, scope, {
            code: 'SCRIPT_EXPECTED_BLOCK',
            status: 'error',
            message: 'This control command requires a block',
            suggestions: [],
            ...(signature === undefined ? {} : { reference: signature.reference }),
          });
        continue;
      }
      if (containers.has(name)) {
        walk(entry.value, kind, scope, previous);
        continue;
      }
      if (conditionals.has(name) || iterator !== null) {
        const childScope = iterator?.[1] ?? scope;
        for (const child of entry.value.entries) {
          if (child.type === 'assignment' && child.key.value === 'limit') {
            if (child.value.type === 'block')
              walk(child.value, 'trigger', childScope, iterator === null ? previous : scope);
            else
              report(child, 'trigger', childScope, {
                code: 'SCRIPT_EXPECTED_BLOCK',
                status: 'error',
                message: 'limit requires a trigger block',
                suggestions: [],
              });
          } else if (
            iterator !== null &&
            child.type === 'assignment' &&
            iteratorParameters.has(child.key.value)
          ) {
            argumentBlocksUnchecked++;
          } else
            walk(
              { type: 'block', entries: [child], start: child.start, end: child.end },
              kind,
              childScope,
              iterator === null ? previous : scope,
            );
        }
      } else {
        argumentBlocksUnchecked++;
        report(entry, kind, scope, {
          code: 'SCRIPT_ARGUMENT_BLOCK_UNCHECKED',
          status: 'unresolved',
          message:
            'Native argument block is not validated from prose documentation; read the cited syntax before use',
          suggestions: [],
          ...(signature === undefined ? {} : { reference: signature.reference }),
        });
      }
    }
  };
  const plan =
    file === undefined
      ? {
          family: 'snippet',
          roots: [{ block: document.root, kind: input.kind!, scope: input.scope! }],
        }
      : scriptRoots(file.relativePath, document);
  if (document.diagnostics.every(({ severity }) => severity !== 'error' && severity !== 'blocker'))
    for (const root of plan.roots) {
      rootScope = root.scope;
      walk(root.block, root.kind, root.scope);
    }
  const unresolvedCount = findings.filter(({ status }) => status === 'unresolved').length;
  const invalid = findings.some(({ status }) => status === 'error');
  const truncated = visited > commandLimit;
  const unknownScopeRoots = plan.roots.filter(({ scope }) => scope === UNKNOWN_SCOPE).length;
  const incomplete =
    unresolvedCount > 0 ||
    truncated ||
    inventory.skipped > 0 ||
    (file === undefined ? catalogs[input.kind!].size === 0 : plan.roots.length === 0) ||
    unknownScopeRoots > 0;
  const order = { error: 0, unresolved: 1, supported: 2 };
  findings.sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      a.line - b.line ||
      a.column - b.column ||
      a.code.localeCompare(b.code, 'en'),
  );
  const result: Output = {
    valid: invalid ? false : incomplete ? null : true,
    checksPerformed: ['syntax', 'command_kind', 'declared_scope'],
    parametersChecked: false,
    documentation: {
      source: input.documentation,
      revision: hashCanonical([...sources].sort()),
      effectCount: catalogs.effect.size,
      triggerCount: catalogs.trigger.size,
      skippedSources: inventory.skipped,
    },
    findings: findings.slice(0, input.limit),
    totalFindings: findings.length,
    omittedFindings: Math.max(0, findings.length - input.limit),
    checkedCommands,
    unresolvedCount,
    truncated,
    argumentBlocksUnchecked,
    ...(file === undefined
      ? {}
      : {
          file: {
            path: file.path,
            family: plan.family,
            roots: plan.roots.length,
            unknownScopeRoots,
          },
        }),
  };
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > 16_000 && result.findings.length > 1)
    result.findings.pop();
  result.omittedFindings = result.totalFindings - result.findings.length;
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 16_000)
    throw new ServiceError(
      'REFERENCE_RESPONSE_TOO_LARGE',
      'Command documentation metadata exceeds the bounded reply',
    );
  return result;
}
