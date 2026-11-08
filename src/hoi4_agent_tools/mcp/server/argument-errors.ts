import type { z } from 'zod/v4';
import { errorResult } from '../../core/operation-result.js';
import { ServiceError } from '../../core/result.js';

/**
 * Invalid arguments come back as a tool error naming each wrong field, what it expected and a
 * working call, not as a protocol error: clients show a tool error's text to the model, while
 * some reduce a protocol error to a generic "Invalid tool arguments".
 */

export const ARGUMENT_EXAMPLES: Readonly<Record<string, string>> = {
  'hoi4.reference_context': '{"surface":"event"}',
  'hoi4.reference_search': '{"query":"add_timed_idea"}',
  'hoi4.reference_read':
    '{"id":"<id of a reference_search result>","revision":"<revision of the same result>"}',
  'hoi4.source_lookup':
    '{"symbol":"my_scripted_effect"} or {"path":"events/my_events.txt","line":42}',
  'hoi4.script_validate':
    '{"path":"events/my_events.txt"} or {"source":"add_political_power = 10","kind":"effect","scope":"country"}',
  'hoi4.error_log': '{"scope":"mod","category":"effect"}',
  'hoi4.script_guard': '{"paths":["events/my_events.txt"]} or {"sinceMinutes":30}',
  'hoi4.mod_health': '{"limit":5} or {"checks":["error_log","engine_check"]}',
  'hoi4.explain_error': `{"line":"Invalid trigger 'stability' in events/my_events.txt line : 12"}`,
  'hoi4.mod_index': '{"mode":"overview"} or {"mode":"next_id","kind":"event","namespace":"my_mod"}',
  'hoi4.localisation_inspect': '{"mode":"key","key":"my_event.1.t"} or {"mode":"audit"}',
  'hoi4.compat_check': '{"mode":"mod","other":"my_other_mod"} or {"mode":"patch"}',
  'hoi4.idea_inspect': '{"kind":"idea","id":"my_idea"} or {"kind":"character","audit":true}',
  'hoi4.system_inspect':
    '{"kind":"mio","id":"my_organization"} or {"kind":"on_actions","audit":true}',
  'hoi4.unit_inspect': '{"kind":"oob","id":"GER_1936"} or {"kind":"variant","audit":true}',
  'hoi4.asset_inspect': '{"kind":"sprite","id":"GFX_my_icon"} or {"kind":"flag","audit":true}',
  'hoi4.skill': '{} or {"name":"hoi4-events"}',
  'hoi4.event_inspect':
    '{"mode":"lint","selector":"chaosx.nr14"} or {"mode":"trace","selector":"chaosx.nr14.1","direction":"downstream"}',
  'hoi4.event_render': '{"view":"overview","selector":"chaosx.nr14"}',
  'hoi4.focus_inspect': '{"treeId":"my_focus_tree"}',
  'hoi4.focus_render':
    '{"relativePath":"common/national_focus/my_tree.txt","treeId":"my_focus_tree"}',
  'hoi4.focus_rewrite':
    '{"relativePath":"common/national_focus/my_tree.txt","treeId":"my_focus_tree","layoutMode":"compact"}',
  'hoi4.localisation_write':
    '{"mode":"add","entries":[{"key":"my_focus","text":"My focus"}]} or {"mode":"fix","apply":true}',
  'hoi4.gui_inspect': '{"windowName":"my_window"}',
  'hoi4.gui_render': '{"windowName":"my_window","scenario":{"id":"normal"}}',
  'hoi4.gui_rewrite':
    '{"mode":"patches","relativePath":"interface/my_window.gui","windowName":"my_window","scenario":{"id":"normal"},"expectedSourceHash":"<sha256 of the file>","patches":[{"description":"Move the button right","start":120,"end":130,"expectedText":"x = 10 y","text":"x = 40 y"}]}',
  'hoi4.map_inspect':
    '{"query":"Brandenburg","lookupOnly":true} or {"layer":"state","tile":{"x":2600,"y":500,"width":256,"height":256}}',
  'hoi4.map_rewrite':
    '{"operations":[{"id":"new-state","kind":"create_state","provinceIds":[120,121],"displayName":"New State"}]}',
  'hoi4.tech_inspect':
    '{"mode":"scan"} or {"mode":"explain","technologyId":"my_tech"} or {"mode":"lint"}',
  'hoi4.tech_render': '{"view":"folder","folderId":"my_folder"}',
  'hoi4.probability_inspect':
    '{"candidatePool":["my_decision"]} or {"source":"events/my_events.txt","adapter":"event_option_ai_chance"}',
  'hoi4.probability_analyze':
    '{"analysis":"sweep","source":"common/decisions/my_decisions.txt","candidatePool":["my_decision"],"scenarioSet":[{"actor":"GER","state":{"variable.pressure":10}}],"sweep":{"paths":["variable.pressure"],"steps":10}}',
  'hoi4.impact_inspect':
    '{"symbols":[{"kind":"scripted_effect","id":"my_effect"}]} or {"changedFiles":["mod:common/scripted_effects/my_effects.txt"]}',
  'hoi4.decision_inspect':
    '{"mode":"inventory"} or {"mode":"inspect","id":"my_decision","scenarios":[{"id":"base","actor":"GER","state":{}}]}',
  'hoi4.mechanic_test':
    '{"test":{"id":"my_test","scenario":{"schemaVersion":"1.0","id":"my_test","state":{"treasury":10,"savings":2}},"steps":[{"kind":"effect","source":{"kind":"scripted_effect","id":"my_effect"}}],"assertions":[{"id":"kept","kind":"conservation","paths":[{"key":"treasury"},{"key":"savings"}]}]}}',
  'hoi4.package_check':
    '{"manifest":{"schemaVersion":"1.0","id":"my_package","definitions":[{"kind":"scripted_effect","id":"my_effect"}]}}',
  'hoi4.scenario_test': '{"suitePath":"tests/my_suite.json","maxCases":20}',
  'hoi4.job_inspect': '{"jobId":"job_<64 hex characters from a native task id>"}',
  'hoi4.job_cancel': '{"jobId":"job_<64 hex characters from a native task id>"}',
};

interface Issue {
  field: string;
  problem: string;
}

interface SchemaDef {
  type?: string;
  innerType?: z.ZodType;
  in?: z.ZodType;
  out?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  options?: z.ZodType[];
  valueType?: z.ZodType;
}

function defOf(schema: z.ZodType | undefined): SchemaDef | undefined {
  return (schema as { _zod?: { def?: SchemaDef } } | undefined)?._zod?.def;
}

/**
 * The fields the object at a path accepts, so an unknown field names the expected shape (#65).
 * Wrappers are unwrapped and the fields of every union alternative are listed.
 */
export function acceptedFields(
  schema: z.ZodType | undefined,
  path: readonly PropertyKey[],
  depth = 0,
): string[] {
  const def = defOf(schema);
  if (def === undefined || depth > 32) return [];
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'catch':
    case 'nonoptional':
      return acceptedFields(def.innerType, path, depth + 1);
    case 'pipe': {
      // A preprocess step pipes from an unknown or a transform; then out checks the fields.
      const fromInput = acceptedFields(def.in, path, depth + 1);
      return fromInput.length > 0 ? fromInput : acceptedFields(def.out, path, depth + 1);
    }
    case 'union':
      return [
        ...new Set(
          (def.options ?? []).flatMap((option) => acceptedFields(option, path, depth + 1)),
        ),
      ];
    case 'array':
      return typeof path[0] === 'number'
        ? acceptedFields(def.element, path.slice(1), depth + 1)
        : [];
    case 'record':
      return path.length === 0 ? [] : acceptedFields(def.valueType, path.slice(1), depth + 1);
    case 'object':
      if (path.length === 0) return Object.keys(def.shape ?? {});
      return acceptedFields(def.shape?.[String(path[0])], path.slice(1), depth + 1);
    default:
      return [];
  }
}

function describeIssue(issue: z.core.$ZodIssue, schema?: z.ZodType): Issue {
  const field = issue.path.length === 0 ? '(arguments)' : issue.path.map(String).join('.');
  let problem = issue.message;
  if (issue.code === 'unrecognized_keys') {
    const accepted = acceptedFields(schema, issue.path);
    problem = `unknown field${issue.keys.length === 1 ? '' : 's'} ${issue.keys.join(', ')}${accepted.length === 0 ? '' : `; accepted fields: ${accepted.join(', ')}`}`;
  } else if (issue.code === 'invalid_value')
    problem = `expected one of ${issue.values.map((value) => JSON.stringify(value)).join(', ')}`;
  else if (issue.code === 'invalid_union') {
    // Name the alternative that came closest: the one with the fewest problems.
    const closest = [...issue.errors].sort((left, right) => left.length - right.length)[0];
    const first = closest?.[0];
    if (first !== undefined) {
      const nested = describeIssue(first, schema);
      problem = `${issue.message}; closest form: ${nested.field === '(arguments)' ? '' : `${nested.field}: `}${nested.problem}`;
    }
  }
  return { field, problem: problem.slice(0, 300) };
}

export function invalidArgumentsError(
  toolName: string,
  error: z.ZodError,
  schema?: z.ZodType,
): ServiceError {
  const issues = error.issues.slice(0, 6).map((issue) => describeIssue(issue, schema));
  const example = ARGUMENT_EXAMPLES[toolName];
  const message = [
    `Invalid arguments for ${toolName}: ${issues.map(({ field, problem }) => `${field}: ${problem}`).join('; ')}.`,
    ...(example === undefined ? [] : [`Example: ${example}.`]),
    'The tool input schema lists every accepted field.',
  ].join(' ');
  return new ServiceError('INVALID_ARGUMENTS', message.slice(0, 1_500), {
    tool: toolName,
    issues,
    ...(example === undefined ? {} : { example }),
  });
}

export function invalidArgumentsResult(
  toolName: string,
  error: z.ZodError,
  workspaceId: unknown,
  schema?: z.ZodType,
): ReturnType<typeof errorResult> {
  return errorResult(
    invalidArgumentsError(toolName, error, schema),
    typeof workspaceId === 'string' ? workspaceId : 'current',
  );
}
