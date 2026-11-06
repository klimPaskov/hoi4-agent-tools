import type { z } from 'zod/v4';
import type { modHealthDataSchema, healthCheckSchema } from '../schemas/modder-tools.js';

/**
 * `hoi4.mod_health`: one call that runs the existing audits and returns the problems that
 * matter most. Each check reports findings; findings with the same check and code form one
 * problem, counted, with two examples. Problems rank by severity, then by how much they hurt a
 * player (a file the game cannot read before a missing tooltip), then by count.
 */

export type HealthCheck = z.infer<typeof healthCheckSchema>;
type Output = z.infer<typeof modHealthDataSchema>;
type Problem = Output['problems'][number];

export interface HealthFinding {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  path?: string;
  line?: number;
}

export interface CheckRun {
  check: HealthCheck;
  status: 'ran' | 'partial' | 'unavailable' | 'skipped';
  ms: number;
  note?: string;
  findings: HealthFinding[];
  /** Findings per code when the check returns only examples of each. */
  counts?: Readonly<Record<string, number>>;
  /** A title and fix for a group the check knows best, such as an error.log pattern. */
  describe?: (code: string, examples: readonly HealthFinding[]) => Partial<Description> | undefined;
}

export interface Description {
  title: string;
  fix: string;
  /** 0 to 100: how much a player is hurt; the game failing to read a file is 100. */
  weight: number;
  next?: { tool: string; arguments: Record<string, string | number | boolean> };
}

/** What each known code means for the mod, what to do, and how much it matters. */
const descriptions: Readonly<Record<string, Description>> = {
  REF_UNKNOWN_EFFECT: {
    title: 'Effects the game does not know',
    fix: 'Correct each name to a documented effect, or define the scripted effect; hoi4.explain_error and hoi4.reference_search name the right command.',
    weight: 85,
  },
  REF_UNKNOWN_TRIGGER: {
    title: 'Triggers the game does not know',
    fix: 'Correct each name to a documented trigger, or define the scripted trigger; hoi4.explain_error and hoi4.reference_search name the right command.',
    weight: 85,
  },
  LINT_UNKNOWN_MODIFIER: {
    title: 'Modifiers the game does not know',
    fix: "Use a modifier from the game's modifiers documentation, or define it in common/modifier_definitions/.",
    weight: 60,
  },
  LINT_DUPLICATE_DEFINITION: {
    title: 'Ids defined twice in the mod',
    fix: 'Keep one definition of each id: the later one wins and the other is lost.',
    weight: 80,
  },
  LINT_DUPLICATE_ACROSS_LAYERS: {
    title: 'Ids the game or a dependency also defines',
    fix: 'Rename the mod copy, or replace the other file (a file of the same name or replace_path), so only one loads.',
    weight: 50,
  },
  LINT_EVENT_NAMESPACE_COLLISION: {
    title: 'Event namespaces the game already declares',
    fix: 'Use a namespace of the mod own; events in a shared namespace collide by id.',
    weight: 70,
  },
  LINT_INERT_MTTH: {
    title: 'Timers on triggered-only events, which never run',
    fix: 'Remove mean_time_to_happen, or is_triggered_only if the event should fire by itself.',
    weight: 45,
  },
  LINT_MUTUALLY_EXCLUSIVE_NOT_RECIPROCAL: {
    title: 'Mutually exclusive focuses that exclude in one direction only',
    fix: 'List the exclusion on both focuses.',
    weight: 55,
  },
  LINT_EVENT_LOC_KEY_REUSED: {
    title: 'Events that use one localisation key for two texts',
    fix: 'Give each text of the event its own key.',
    weight: 35,
  },
  LINT_UNKNOWN_DLC: {
    title: 'has_dlc names a DLC the game does not know',
    fix: "Use the DLC's exact name as the game lists it.",
    weight: 50,
  },
  LINT_FLAG_NEVER_SET: {
    title: 'Flags checked but never set',
    fix: 'Set the flag somewhere, or correct its name; flags built at run time from parameters are counted here too.',
    weight: 25,
  },
  REF_MISSING_LOCALISATION_KEY: {
    title: 'Localisation keys the script uses that no file defines',
    fix: 'Add the keys (hoi4.localisation_write mode add), or correct their names.',
    weight: 65,
  },
  REF_CASE_MISMATCH: {
    title: 'Names whose letter case differs from their definition',
    fix: 'Write each name with the letter case of its definition.',
    weight: 40,
  },
  OVERRIDE_BREAKS_REFERENCE: {
    title: 'Overridden files that remove definitions other files use',
    fix: 'Keep the definitions the rest of the game uses in the mod copy, or change the files that use them.',
    weight: 75,
  },
  OVERRIDE_DROPS_DEFINITION: {
    title: 'Overridden files that drop definitions',
    fix: 'Copy the dropped definitions into the mod file, or confirm the drop is intended.',
    weight: 55,
  },
  OVERRIDE_DROPS_ON_ACTION_HOOK: {
    title: 'Overridden on_actions files that drop hooks',
    fix: 'Put the mod hooks in a new on_actions file instead of replacing the game one, so both load.',
    weight: 65,
  },
  SCRIPT_COMMAND_WRONG_SCOPE: {
    title: 'Commands used in a scope they do not support',
    fix: 'Change scope before the command, or use the variant for this scope; hoi4.script_validate on the file shows each scope.',
    weight: 80,
  },
  SCRIPT_COMMAND_WRONG_KIND: {
    title: 'Effects used as triggers, or triggers as effects',
    fix: 'Move each command to a block of its kind.',
    weight: 80,
  },
  SCRIPT_SCOPE_LINK_AS_TRIGGER: {
    title: 'Scope links used as triggers, which the game drops',
    fix: 'Use is_owned_by or is_controlled_by instead of owner = X or controller = X.',
    weight: 80,
  },
  SCRIPT_FLAG_TOOLTIP_UNLOCALISED: {
    title: 'Flag checks whose requirement tooltip shows the raw flag name',
    fix: 'Add a localisation key named like the flag, or wrap the check in hidden_trigger.',
    weight: 30,
  },
  SCRIPT_ARGUMENT_UNKNOWN_ID: {
    title: 'Commands that name an idea, event, decision, focus or technology nothing defines',
    fix: 'Correct each id, or define it.',
    weight: 60,
  },
  LOC_KEY_UNDEFINED: {
    title: 'Localisation keys the script uses that no language defines',
    fix: 'Add the keys (hoi4.localisation_write mode add), or correct their names.',
    weight: 65,
  },
  LOC_KEY_MISSING_LANGUAGE: {
    title: 'Keys missing from a language the mod supports',
    fix: 'Add them (hoi4.localisation_write mode fix copies the English text), or drop the language.',
    weight: 30,
  },
  LOC_KEY_DUPLICATE: {
    title: 'Localisation keys defined twice in one language',
    fix: 'Keep one definition of each key; put intended overrides under localisation/<language>/replace/.',
    weight: 45,
  },
  LOC_FILE_LANGUAGE_MISMATCH: {
    title: 'Localisation files whose name and header name different languages',
    fix: 'Make the file name end in _l_<language>.yml with the matching l_<language>: header.',
    weight: 70,
  },
  LOC_MISSING_LANGUAGE_HEADER: {
    title: 'Localisation files without a language header',
    fix: 'Start each file with l_<language>: on its first line, in UTF-8 with a byte order mark.',
    weight: 90,
  },
  LOC_PLACEHOLDER_MISSING: {
    title: 'Text that refers to keys or values that do not exist',
    fix: 'Correct each $key$ or [scope.Get...] reference.',
    weight: 40,
  },
  ASSET_TEXTURE_MISSING: {
    title: 'Sprites whose texture file is missing',
    fix: 'Add the texture file, or correct the texturefile path (letter case matters on Linux and macOS).',
    weight: 70,
  },
  ASSET_TEXTURE_UNREADABLE: {
    title: 'Texture files the game cannot read',
    fix: 'Save the texture again as DDS (BC3 or uncompressed RGBA) or PNG.',
    weight: 70,
  },
  ASSET_TEXTURE_FORMAT_RISKY: {
    title: 'Textures in BC7, which crashed the game in an in-game check',
    fix: 'Save these textures as BC3 or uncompressed DDS.',
    weight: 75,
  },
  ASSET_FILE_MISSING: {
    title: 'Sounds whose audio file is missing',
    fix: 'Add the audio file, or correct its path.',
    weight: 55,
  },
  ASSET_FLAG_MISSING: {
    title: 'Country flags missing in one of the three sizes',
    fix: 'Add the flag at 82x52, medium 41x26 and small 10x7.',
    weight: 50,
  },
  ASSET_FLAG_SIZE: {
    title: 'Flags of the wrong size',
    fix: 'Resize to 82x52, medium 41x26 and small 10x7.',
    weight: 40,
  },
  ASSET_REFERENCE_UNKNOWN: {
    title: 'Sound effects that play sounds nothing defines',
    fix: 'Define the sound, or correct its name.',
    weight: 45,
  },
};

/** Codes two audits use for the same problem, mapped to one. */
const sameProblem: Readonly<Record<string, string>> = {
  LOC_KEY_UNDEFINED: 'REF_MISSING_LOCALISATION_KEY',
};

const checkOrder: Readonly<Record<HealthCheck, number>> = {
  error_log: 0,
  engine_check: 1,
  script: 2,
  localisation: 3,
  assets: 4,
};

/** Rank the problems of every check that ran; the top `limit` come back with examples. */
export function rankProblems(runs: readonly CheckRun[], limit: number): Output {
  // Two audits that report the same kind of problem make one problem, counted once.
  const groups = new Map<
    string,
    { run: CheckRun; code: string; findings: HealthFinding[]; count: number }
  >();
  const perCheck = new Map<string, number>();
  for (const run of runs)
    for (const finding of run.findings) {
      const code = sameProblem[finding.code] ?? finding.code;
      const group = groups.get(code) ?? { run, code, findings: [], count: 0 };
      if (group.run === run) group.findings.push(finding);
      const key = `${run.check}\0${code}`;
      perCheck.set(key, (perCheck.get(key) ?? 0) + 1);
      group.count = Math.max(group.count, perCheck.get(key)!, run.counts?.[finding.code] ?? 0);
      groups.set(code, group);
    }
  const problems: Array<Problem & { weight: number }> = [];
  for (const { run, code, findings, count } of groups.values()) {
    const severity = findings.some((finding) => finding.severity === 'error') ? 'error' : 'warning';
    const own = run.describe?.(code, findings);
    const known = descriptions[code];
    const weight = own?.weight ?? known?.weight ?? (severity === 'error' ? 60 : 30);
    const next = own?.next ?? known?.next;
    problems.push({
      rank: 0,
      check: run.check,
      severity,
      code,
      title: (own?.title ?? known?.title ?? findings[0]!.message).slice(0, 300),
      count,
      examples: findings.slice(0, 2).map(({ message, path, line }) => ({
        message: message.slice(0, 300),
        ...(path === undefined ? {} : { path: path.slice(0, 1024) }),
        ...(line === undefined || line < 1 ? {} : { line }),
      })),
      fix: (own?.fix ?? known?.fix ?? 'Read the examples and fix each place they name.').slice(
        0,
        400,
      ),
      ...(next === undefined ? {} : { next }),
      weight,
    });
  }
  problems.sort(
    (left, right) =>
      Number(right.severity === 'error') - Number(left.severity === 'error') ||
      right.weight - left.weight ||
      right.count - left.count ||
      checkOrder[left.check] - checkOrder[right.check] ||
      (left.code < right.code ? -1 : left.code > right.code ? 1 : 0),
  );
  const top = problems.slice(0, limit).map(({ weight: _weight, ...problem }, index) => ({
    ...problem,
    rank: index + 1,
  }));
  const ran = runs.filter(({ status }) => status === 'ran' || status === 'partial');
  const complete = runs.every(({ status }) => status === 'ran' || status === 'skipped');
  return {
    verdict: problems.length > 0 ? 'problems' : complete ? 'healthy' : 'incomplete',
    problems: top,
    totals: {
      problems: problems.length,
      findings: problems.reduce((sum, problem) => sum + problem.count, 0),
      errors: problems.filter(({ severity }) => severity === 'error').length,
      warnings: problems.filter(({ severity }) => severity === 'warning').length,
      omitted: Math.max(0, problems.length - top.length),
    },
    checks: runs.map(({ check, status, ms, note, findings, counts }) => ({
      check,
      status,
      ms: Math.round(ms),
      findings: Math.max(
        findings.length,
        Object.values(counts ?? {}).reduce((sum, count) => sum + count, 0),
      ),
      ...(note === undefined ? {} : { note: note.slice(0, 300) }),
    })),
    checksRun: ran.length,
  };
}
