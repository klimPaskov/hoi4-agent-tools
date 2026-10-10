import type { z } from 'zod/v4';
import { errorResult } from '../../core/operation-result.js';
import { ServiceError } from '../../core/result.js';

/**
 * Invalid arguments come back as a tool error naming each wrong field, what it expected and a
 * working call, not as a protocol error: clients show a tool error's text to the model, while
 * some reduce a protocol error to a generic "Invalid tool arguments".
 */

export const ARGUMENT_EXAMPLES: Readonly<Record<string, string>> = {
  'hoi4.event_inspect':
    '{"mode":"lint","selector":"chaosx.nr14"} or {"mode":"trace","selector":"chaosx.nr14.1","direction":"downstream"}',
  'hoi4.event_render': '{"view":"overview","selector":"chaosx.nr14"}',
  'hoi4.script_validate':
    '{"path":"events/my_events.txt"} or {"source":"add_political_power = 10","kind":"effect","scope":"country"}',
  'hoi4.decision_inspect':
    '{"mode":"inventory"} or {"mode":"inspect","id":"my_decision","scenarios":[{"id":"base","actor":"GER","state":{}}]}',
  'hoi4.probability_inspect':
    '{"candidatePool":["my_decision"]} or {"source":"events/my_events.txt","adapter":"event_option_ai_chance"}',
  'hoi4.gui_render': '{"windowName":"my_window"}',
  'hoi4.gui_inspect': '{"windowName":"my_window"}',
  'hoi4.focus_inspect': '{"treeId":"my_focus_tree"}',
  'hoi4.source_lookup': '{"symbol":"my_scripted_effect"}',
  'hoi4.reference_search': '{"query":"add_timed_idea"}',
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
