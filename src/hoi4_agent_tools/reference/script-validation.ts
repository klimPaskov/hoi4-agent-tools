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
type Kind = Input['kind'];
type Finding = Output['findings'][number];
interface Signature {
  reference: ReferenceSection;
  scopes: string[];
  conflict: boolean;
}
const MAX_COMMANDS = 256;
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
): Promise<Output> {
  if (Buffer.byteLength(input.source, 'utf8') > 64_000)
    throw new ServiceError('SCRIPT_SOURCE_TOO_LARGE', 'Snippet exceeds 64000 UTF-8 bytes');
  const inventory = await references.inventory(workspace, signal, [input.documentation]);
  const catalogs: Record<Kind, Map<string, Signature>> = { effect: new Map(), trigger: new Map() };
  const sources = new Map<string, string>();
  for (const section of inventory.sections) {
    const filename = path.basename(section.path).toLowerCase();
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
    const previous = catalogs[kind].get(section.heading);
    const reference = publicReferenceSection(section);
    if (previous !== undefined) {
      previous.conflict ||= previous.scopes.join(',') !== scopes.join(',');
    } else catalogs[kind].set(section.heading, { reference, scopes, conflict: false });
  }
  const document = parseClausewitz(Buffer.from(input.source, 'utf8'), 'snippet');
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
    const position = locationFor('snippet', document.lineIndex, entry.start, entry.end).start;
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
      kind: input.kind,
      scope: input.scope,
      line: diagnostic.location?.start.line ?? 1,
      column: diagnostic.location?.start.column ?? 1,
      message: diagnostic.message.slice(0, 500),
      suggestions: [],
    });
  const walk = (block: BlockNode, kind: Kind, scope: string, previous?: string): void => {
    for (const entry of block.entries) {
      signal?.throwIfAborted();
      if (++visited > MAX_COMMANDS) {
        return;
      }
      if (entry.type !== 'assignment') {
        const position = locationFor('snippet', document.lineIndex, entry.start, entry.end).start;
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
          ? input.scope
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
      const signature = catalogs[kind].get(name);
      if (signature === undefined) {
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
      const wrongScope = !signature.scopes.includes('any') && !signature.scopes.includes(scope);
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
      const iterator =
        /^(?:every|random|any|all)_(?:(?:owned|controlled|neighbor)_)?(state|country)$/u.exec(name);
      if (entry.value.type !== 'block') {
        if (containers.has(name) || conditionals.has(name) || iterator !== null)
          report(entry, kind, scope, {
            code: 'SCRIPT_EXPECTED_BLOCK',
            status: 'error',
            message: 'This control command requires a block',
            suggestions: [],
            reference: signature.reference,
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
          reference: signature.reference,
        });
      }
    }
  };
  if (document.diagnostics.every(({ severity }) => severity !== 'error' && severity !== 'blocker'))
    walk(document.root, input.kind, input.scope);
  const unresolvedCount = findings.filter(({ status }) => status === 'unresolved').length;
  const invalid = findings.some(({ status }) => status === 'error');
  const truncated = visited > MAX_COMMANDS;
  const incomplete =
    unresolvedCount > 0 || truncated || inventory.skipped > 0 || catalogs[input.kind].size === 0;
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
