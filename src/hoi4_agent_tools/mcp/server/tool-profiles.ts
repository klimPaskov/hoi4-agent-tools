/**
 * Tool profiles (maintainer decision R-4): every session pays for the tools it lists, so a
 * session lists the core profile unless it asks for more. `core` holds the tools most modding
 * sessions use; `map` the world builder; `advanced` the editors, renders and analyses of focus
 * trees, GUI, events, technology and probability, and the rest. A tool outside the listed
 * profiles is not listed, and still answers a call that names it.
 */

export const TOOL_PROFILES = ['core', 'map', 'advanced'] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];

/** `all` stands for every profile. */
export const PROFILE_SELECTION_VALUES = [...TOOL_PROFILES, 'all'] as const;
export type ProfileSelection = (typeof PROFILE_SELECTION_VALUES)[number];

/** The profile a session lists when nothing chooses one. */
export const DEFAULT_PROFILES: readonly ToolProfile[] = ['core'];

/** The environment variable that chooses profiles for one client registration. */
export const PROFILES_ENV = 'HOI4_AGENT_TOOLS_PROFILES';

const coreTools = new Set([
  'hoi4.skill',
  'hoi4.reference_search',
  'hoi4.reference_read',
  'hoi4.reference_context',
  'hoi4.source_lookup',
  'hoi4.script_validate',
  'hoi4.script_guard',
  'hoi4.error_log',
  'hoi4.explain_error',
  'hoi4.mod_health',
  'hoi4.mod_index',
  'hoi4.localisation_inspect',
  'hoi4.localisation_write',
]);
const mapTools = new Set(['hoi4.map_inspect', 'hoi4.map_rewrite']);
/** Job controls follow the long-running tools of map and advanced. */
const jobTools = new Set(['hoi4.job_inspect', 'hoi4.job_cancel']);

/** The profiles a tool belongs to. */
export function profilesOf(name: string): readonly ToolProfile[] {
  if (coreTools.has(name)) return ['core'];
  if (mapTools.has(name)) return ['map'];
  if (jobTools.has(name)) return ['map', 'advanced'];
  return ['advanced'];
}

/** Every profile when the selection names `all` or nothing; else the named ones. */
export function resolveProfiles(
  selection: readonly ProfileSelection[] | undefined,
): ReadonlySet<ToolProfile> {
  if (selection === undefined || selection.includes('all')) return new Set(TOOL_PROFILES);
  return new Set(selection.filter((value): value is ToolProfile => value !== 'all'));
}

/** Whether a session with these profiles lists the tool. */
export function isListed(name: string, profiles: ReadonlySet<ToolProfile>): boolean {
  return profilesOf(name).some((profile) => profiles.has(profile));
}

/**
 * Parse `HOI4_AGENT_TOOLS_PROFILES` (`core,map`, `all`). Unknown names fail, so a typo never
 * silently hides every tool.
 */
export function parseProfilesEnv(value: string | undefined): ProfileSelection[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const names = value
    .split(/[\s,]+/u)
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const unknown = names.filter(
    (name) => !(PROFILE_SELECTION_VALUES as readonly string[]).includes(name),
  );
  if (unknown.length > 0)
    throw new Error(
      `${PROFILES_ENV} names unknown profiles: ${unknown.join(', ')}; use ${PROFILE_SELECTION_VALUES.join(', ')}`,
    );
  return names as ProfileSelection[];
}

/** One sentence for the server instructions when some tools are not listed. */
export function profileInstructions(profiles: ReadonlySet<ToolProfile>): string | undefined {
  const missing = TOOL_PROFILES.filter((profile) => !profiles.has(profile));
  if (missing.length === 0) return undefined;
  return ` This session lists the ${[...profiles].join(' and ')} tools; the ${missing.join(' and ')} tools (${missing
    .map((profile) =>
      profile === 'map'
        ? 'world maps'
        : 'focus, GUI, event, technology, probability and other editors',
    )
    .join(
      '; ',
    )}) need ${PROFILES_ENV}=${[...TOOL_PROFILES].join(',')} in the client's server entry.`;
}
