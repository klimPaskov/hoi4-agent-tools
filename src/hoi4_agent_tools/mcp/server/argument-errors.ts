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
  'hoi4.mod_index': '{"mode":"overview"} or {"mode":"next_id","kind":"event","namespace":"my_mod"}',
  'hoi4.event_inspect':
    '{"mode":"lint","selector":"chaosx.nr14"} or {"mode":"trace","selector":"chaosx.nr14.1","direction":"downstream"}',
  'hoi4.event_render': '{"view":"overview","selector":"chaosx.nr14"}',
  'hoi4.focus_inspect': '{"treeId":"my_focus_tree"}',
  'hoi4.focus_render':
    '{"relativePath":"common/national_focus/my_tree.txt","treeId":"my_focus_tree"}',
  'hoi4.focus_rewrite':
    '{"relativePath":"common/national_focus/my_tree.txt","treeId":"my_focus_tree","layoutMode":"compact"}',
  'hoi4.gui_inspect': '{"windowName":"my_window"}',
  'hoi4.gui_render': '{"windowName":"my_window","scenario":{"id":"normal"}}',
  'hoi4.gui_rewrite':
    '{"mode":"patches","relativePath":"interface/my_window.gui","windowName":"my_window","scenario":{"id":"normal"},"expectedSourceHash":"<sha256 of the file>","patches":[{"start":120,"end":130,"expectedText":"x = 10 y","text":"x = 40 y"}]}',
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

function describeIssue(issue: z.core.$ZodIssue): Issue {
  const field = issue.path.length === 0 ? '(arguments)' : issue.path.map(String).join('.');
  let problem = issue.message;
  if (issue.code === 'unrecognized_keys')
    problem = `unknown field${issue.keys.length === 1 ? '' : 's'} ${issue.keys.join(', ')}`;
  else if (issue.code === 'invalid_value')
    problem = `expected one of ${issue.values.map((value) => JSON.stringify(value)).join(', ')}`;
  else if (issue.code === 'invalid_union') {
    // Name the alternative that came closest: the one with the fewest problems.
    const closest = [...issue.errors].sort((left, right) => left.length - right.length)[0];
    const first = closest?.[0];
    if (first !== undefined) {
      const nested = describeIssue(first);
      problem = `${issue.message}; closest form: ${nested.field === '(arguments)' ? '' : `${nested.field}: `}${nested.problem}`;
    }
  }
  return { field, problem: problem.slice(0, 300) };
}

export function invalidArgumentsError(toolName: string, error: z.ZodError): ServiceError {
  const issues = error.issues.slice(0, 6).map(describeIssue);
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
): ReturnType<typeof errorResult> {
  return errorResult(
    invalidArgumentsError(toolName, error),
    typeof workspaceId === 'string' ? workspaceId : 'current',
  );
}
