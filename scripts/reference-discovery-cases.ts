/**
 * Held-out documentation discovery questions for `scripts/evaluate-reference-discovery.ts`.
 *
 * Each answer names a local documentation file and a line pattern that was checked by hand
 * against the installed Hearts of Iron IV documentation or the offline wiki snapshot. A
 * result answers the question when its cited section contains a matching line. The cases
 * contain only questions and identifier patterns, never documentation text.
 */
export interface DiscoveryAnswer {
  file: string;
  line: RegExp;
}

export interface DiscoveryCase {
  query: string;
  kind: 'question' | 'identifier' | 'negative';
  answers: DiscoveryAnswer[];
}

const effects = 'effects_documentation.md';
const triggers = 'triggers_documentation.md';
const heading = (name: string) => new RegExp(`^## ${name}$`, 'u');
const row = (name: string) => new RegExp(`^\\| ${name} \\|`, 'u');
const wiki = (page: string) => `${page} - Hearts of Iron 4 Wiki.md`;
const section = (title: string) => new RegExp(`^#{2,4} ${title}( <a |$)`, 'u');

export const discoveryCases: DiscoveryCase[] = [
  {
    query: 'how to check if a state is controlled by a country',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('is_controlled_by') },
      { file: triggers, line: heading('controls_state') },
      { file: wiki('Triggers'), line: row('is_controlled_by') },
      { file: wiki('Triggers'), line: row('controls_state') },
    ],
  },
  {
    query: 'set a flag that expires after a number of days',
    kind: 'question',
    answers: [
      { file: effects, line: heading('set_country_flag') },
      { file: wiki('Data structures'), line: section('Flags') },
      { file: wiki('Effects'), line: row('set_country_flag') },
    ],
  },
  {
    query: "add equipment to a country's stockpile",
    kind: 'question',
    answers: [
      { file: effects, line: heading('add_equipment_to_stockpile') },
      { file: wiki('Effects'), line: row('add_equipment_to_stockpile') },
    ],
  },
  {
    query: 'pick one of several weighted random outcomes',
    kind: 'question',
    answers: [
      { file: effects, line: heading('random_list') },
      { file: wiki('Effects'), line: section('Random effects') },
    ],
  },
  {
    query: 'run effects for every country matching a condition',
    kind: 'question',
    answers: [
      { file: effects, line: heading('every_country') },
      { file: wiki('Effects'), line: row('every_country') },
    ],
  },
  {
    query: 'fire an event for a country after a delay',
    kind: 'question',
    answers: [
      { file: effects, line: heading('country_event') },
      { file: wiki('Effects'), line: row('country_event') },
      { file: wiki('Event modding'), line: section('Triggering') },
    ],
  },
  {
    query: 'change the popularity of an ideology',
    kind: 'question',
    answers: [
      { file: effects, line: heading('add_popularity') },
      { file: effects, line: heading('set_popularities') },
      { file: wiki('Effects'), line: row('add_popularity') },
      { file: wiki('Effects'), line: row('set_popularities') },
    ],
  },
  {
    query: 'count the civilian factories of a country',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('num_of_civilian_factories') },
      { file: triggers, line: heading('num_of_factories') },
      { file: wiki('Triggers'), line: row('num_of_civilian_factories') },
    ],
  },
  {
    query: 'remember a scope to use later in another event',
    kind: 'question',
    answers: [
      { file: effects, line: heading('save_event_target_as') },
      { file: effects, line: heading('save_global_event_target_as') },
      { file: wiki('Data structures'), line: section('Event targets') },
      { file: wiki('Data structures'), line: section('Regular event targets') },
      { file: wiki('Data structures'), line: section('Global event targets') },
    ],
  },
  {
    query: 'modifier whose values come from variables',
    kind: 'question',
    answers: [
      { file: wiki('Modifiers'), line: section('Dynamic modifiers') },
      { file: wiki('Modifiers'), line: section('Adding a dynamic modifier') },
      { file: effects, line: heading('add_dynamic_modifier') },
    ],
  },
  {
    query: 'temporary variable that only exists inside one effect block',
    kind: 'question',
    answers: [
      { file: effects, line: heading('set_temp_variable') },
      { file: wiki('Data structures'), line: section('Variable types') },
    ],
  },
  {
    query: 'localisation text that changes depending on conditions',
    kind: 'question',
    answers: [
      { file: wiki('Localisation'), line: section('Scripted localisation') },
      { file: wiki('Localisation'), line: section('Dynamic scripted localisation') },
    ],
  },
  {
    query: 'show custom tooltip text for a trigger',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('custom_trigger_tooltip') },
      { file: wiki('Triggers'), line: row('custom_trigger_tooltip') },
    ],
  },
  {
    query: 'hide effects from the tooltip',
    kind: 'question',
    answers: [
      { file: effects, line: heading('hidden_effect') },
      { file: wiki('Effects'), line: section('Tooltip manipulation') },
    ],
  },
  {
    query: 'on action when a country capitulates',
    kind: 'question',
    answers: [{ file: wiki('On actions'), line: row('on_capitulation') }],
  },
  {
    query: 'give a state to another country',
    kind: 'question',
    answers: [
      { file: effects, line: heading('transfer_state') },
      { file: effects, line: heading('set_state_owner') },
      { file: wiki('Effects'), line: row('transfer_state') },
    ],
  },
  {
    query: 'add a core on a state',
    kind: 'question',
    answers: [
      { file: effects, line: heading('add_core_of') },
      { file: wiki('Effects'), line: row('add_core_of') },
    ],
  },
  {
    query: 'check the current game date',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('date') },
      { file: wiki('Triggers'), line: row('date') },
    ],
  },
  {
    query: 'spawn divisions from an order of battle file',
    kind: 'question',
    answers: [
      { file: effects, line: heading('load_oob') },
      { file: wiki('Effects'), line: row('load_oob') },
    ],
  },
  {
    query: 'check how much manpower a country has available',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('has_manpower') },
      { file: wiki('Triggers'), line: row('has_manpower') },
    ],
  },
  {
    query: 'build a factory in a state with an effect',
    kind: 'question',
    answers: [
      { file: effects, line: heading('add_building_construction') },
      { file: wiki('Effects'), line: row('add_building_construction') },
    ],
  },
  {
    query: 'change the category of a state',
    kind: 'question',
    answers: [
      { file: effects, line: heading('set_state_category') },
      { file: wiki('Effects'), line: row('set_state_category') },
    ],
  },
  {
    query: 'build an effect from text with variables substituted',
    kind: 'question',
    answers: [
      { file: effects, line: heading('meta_effect') },
      { file: wiki('Effects'), line: section('Meta effects') },
    ],
  },
  {
    query: 'check if two countries are at war',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('has_war_with') },
      { file: wiki('Triggers'), line: row('has_war_with') },
    ],
  },
  {
    query: 'check which ideology governs a country',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('has_government') },
      { file: wiki('Triggers'), line: row('has_government') },
    ],
  },
  {
    query: 'add a national spirit that expires',
    kind: 'question',
    answers: [
      { file: effects, line: heading('add_timed_idea') },
      { file: wiki('Effects'), line: row('add_timed_idea') },
    ],
  },
  {
    query: 'compare a variable against a value in a trigger',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('check_variable') },
      { file: wiki('Data structures'), line: section('Trigger usage') },
      { file: wiki('Triggers'), line: row('check_variable') },
    ],
  },
  {
    query: 'mean time to happen for an event',
    kind: 'question',
    answers: [{ file: wiki('Event modding'), line: section('Triggering') }],
  },
  {
    query: 'event that can only fire once',
    kind: 'question',
    answers: [{ file: wiki('Event modding'), line: section('Triggering') }],
  },
  {
    query: 'skip a focus when its condition is already met',
    kind: 'question',
    answers: [{ file: wiki('National focus modding'), line: section('Triggers') }],
  },
  {
    query: 'define constants shared across script files',
    kind: 'question',
    answers: [
      { file: 'script_concept_documentation.md', line: /^## Script Constants$/u },
      { file: wiki('Data structures'), line: section('Constants') },
    ],
  },
  {
    query: 'how does the AI choose to take a decision',
    kind: 'question',
    answers: [{ file: wiki('Decision modding'), line: section('AI') }],
  },
  {
    query: 'add_political_power',
    kind: 'identifier',
    answers: [{ file: effects, line: heading('add_political_power') }],
  },
  {
    query: 'every_owned_state',
    kind: 'identifier',
    answers: [{ file: effects, line: heading('every_owned_state') }],
  },
  {
    query: 'has_country_flag',
    kind: 'identifier',
    answers: [{ file: triggers, line: heading('has_country_flag') }],
  },
  {
    query: 'on_startup',
    kind: 'identifier',
    answers: [{ file: wiki('On actions'), line: row('on_startup') }],
  },
  {
    query: 'is_controlled_by',
    kind: 'identifier',
    answers: [{ file: triggers, line: heading('is_controlled_by') }],
  },
  {
    query: 'zxqv flurble wombat',
    kind: 'negative',
    answers: [],
  },
  {
    query: 'quantum blockchain recipe',
    kind: 'negative',
    answers: [],
  },
];

/**
 * Validation questions written before ranking adjustments and never used to tune them.
 * A ranking change must hold up here as well as on `discoveryCases`.
 */
export const validationCases: DiscoveryCase[] = (
  [
    ['remove a national spirit from a country', effects, 'remove_ideas'],
    ['declare war on another country', effects, 'declare_war_on'],
    ['create a new faction', effects, 'create_faction'],
    ['add a country to a faction', effects, 'add_to_faction'],
    ['annex a country completely', effects, 'annex_country'],
    ['move the capital of a country', effects, 'set_capital'],
    ['check if a country has completed a focus', triggers, 'has_completed_focus'],
    ['check if a country is a major power', triggers, 'is_major'],
    ['give a country more research slots', effects, 'add_research_slot'],
    ['grant a technology to a country', effects, 'set_technology'],
    ['show a news event', effects, 'news_event'],
    ['number of divisions a country has', triggers, 'num_divisions'],
    ['increase the stability of a country', effects, 'add_stability'],
    ['pick a random state owned by the country', effects, 'random_owned_state'],
    ['check the war support of a country', triggers, 'has_war_support'],
    ['repeat effects a fixed number of times', effects, 'for_loop_effect'],
    ['make a country a puppet of another', effects, 'puppet'],
    ['rename a political party', effects, 'set_party_name'],
    ['check whether a DLC is enabled', triggers, 'has_dlc'],
    ['check whether a country is controlled by the AI', triggers, 'is_ai'],
    ['give a country a war goal', effects, 'create_wargoal'],
  ] as const
)
  .map(([query, file, name]): DiscoveryCase => ({
    query,
    kind: 'question',
    answers: [
      { file, line: heading(name) },
      { file: wiki(file === effects ? 'Effects' : 'Triggers'), line: row(name) },
    ],
  }))
  .concat([
    {
      query: 'when is a scripted gui shown',
      kind: 'question',
      answers: [{ file: wiki('Scripted GUI modding'), line: section('Visible') }],
    },
    {
      query: 'define a sprite in a gfx file',
      kind: 'question',
      answers: [
        { file: wiki('Graphical asset modding'), line: section('spriteType') },
        { file: wiki('Graphical asset modding'), line: section('Sprite Types') },
      ],
    },
    {
      query: 'focus tree shared between several countries',
      kind: 'question',
      answers: [{ file: wiki('National focus modding'), line: section('Shared focuses') }],
    },
  ]);
