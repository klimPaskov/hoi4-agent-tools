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

/**
 * One name for a documentation file across snapshot naming schemes. Wiki snapshots taken
 * since 2026-10-31 name pages `event_modding.md`; earlier ones used
 * `Event modding - Hearts of Iron 4 Wiki.md`. Both reduce to `event_modding.md`.
 */
export function documentKey(file: string): string {
  return file
    .replace(/ - Hearts of Iron 4 Wiki\.md$/u, '.md')
    .toLowerCase()
    .replaceAll(' ', '_');
}

const effects = 'effects_documentation.md';
const triggers = 'triggers_documentation.md';
const heading = (name: string) => new RegExp(`^## ${name}$`, 'u');
const row = (name: string) => new RegExp(`^\\| ${name} \\|`, 'u');
const wiki = (page: string) => documentKey(`${page}.md`);
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

/**
 * Held-out questions written on 2026-11-01 by a separate agent that was not told about the
 * player vocabulary, before that change was measured on them. Two validation misses had
 * already been named as examples for the vocabulary, so this set is the cleaner check.
 */
export const heldOutCases: DiscoveryCase[] = [
  {
    query: 'change a country name and flag mid-game',
    kind: 'question',
    answers: [
      { file: effects, line: heading('set_cosmetic_tag') },
      { file: wiki('Effects'), line: row('set_cosmetic_tag') },
      { file: wiki('Cosmetic tag modding'), line: section('Application') },
    ],
  },
  {
    query: 'let a country claim a state it does not own',
    kind: 'question',
    answers: [
      { file: effects, line: heading('add_state_claim') },
      { file: effects, line: heading('add_claim_by') },
      { file: wiki('Effects'), line: row('add_state_claim') },
      { file: wiki('Effects'), line: row('add_claim_by') },
    ],
  },
  {
    query: 'make one country guarantee the independence of another',
    kind: 'question',
    answers: [
      { file: effects, line: heading('give_guarantee') },
      { file: wiki('Effects'), line: row('give_guarantee') },
    ],
  },
  {
    query: 'free a puppet so it becomes independent again',
    kind: 'question',
    answers: [
      { file: effects, line: heading('end_puppet') },
      { file: wiki('Effects'), line: row('end_puppet') },
    ],
  },
  {
    query: 'create a new leader for a country with a portrait and ideology',
    kind: 'question',
    answers: [
      { file: effects, line: heading('create_country_leader') },
      { file: wiki('Effects'), line: row('create_country_leader') },
    ],
  },
  {
    query: 'start a civil war in a country',
    kind: 'question',
    answers: [
      { file: effects, line: heading('start_civil_war') },
      { file: wiki('Effects'), line: row('start_civil_war') },
    ],
  },
  {
    query: 'create a division template with infantry and artillery regiments',
    kind: 'question',
    answers: [
      { file: effects, line: heading('division_template') },
      { file: wiki('Effects'), line: row('division_template') },
      { file: wiki('Division modding'), line: section('Division template') },
    ],
  },
  {
    query: 'check if a country has researched a technology',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('has_tech') },
      { file: wiki('Triggers'), line: row('has_tech') },
    ],
  },
  {
    query: 'check whether a country currently has a certain national spirit',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('has_idea') },
      { file: wiki('Triggers'), line: row('has_idea') },
    ],
  },
  {
    query: 'check if a country still exists on the map',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('country_exists') },
      { file: triggers, line: heading('exists') },
      { file: wiki('Triggers'), line: row('country_exists') },
      { file: wiki('Triggers'), line: row('exists') },
    ],
  },
  {
    query: 'check if a state has access to the sea',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('is_coastal') },
      { file: wiki('Triggers'), line: row('is_coastal') },
    ],
  },
  {
    query: 'check how many members a faction has',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('num_faction_members') },
      { file: wiki('Triggers'), line: row('num_faction_members') },
    ],
  },
  {
    query: 'check if two countries share a border',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('is_neighbor_of') },
      { file: wiki('Triggers'), line: row('is_neighbor_of') },
    ],
  },
  {
    query: 'check whether a country has enough tanks in its equipment stockpile',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('has_equipment') },
      { file: wiki('Triggers'), line: row('has_equipment') },
    ],
  },
  {
    query: 'make an event that happens silently without a popup',
    kind: 'question',
    answers: [{ file: wiki('Event modding'), line: section('Additional arguments') }],
  },
  {
    query: 'make two national focuses that cannot both be taken',
    kind: 'question',
    answers: [
      { file: wiki('National focus modding'), line: section('Interaction with other focuses') },
    ],
  },
  {
    query: 'let a decision be taken again after a cooldown',
    kind: 'question',
    answers: [{ file: wiki('Decision modding'), line: section('Decision reappearing') }],
  },
  {
    query: 'run effects when the player clicks a button in my custom window',
    kind: 'question',
    answers: [
      { file: wiki('Scripted GUI modding'), line: section('Effects') },
      { file: wiki('Scripted GUI modding'), line: section('Template') },
    ],
  },
  {
    query: 'color part of a localisation string red',
    kind: 'question',
    answers: [{ file: wiki('Localisation'), line: section('Colouring characters') }],
  },
  {
    query: 'give a state oil and steel',
    kind: 'question',
    answers: [
      { file: wiki('State modding'), line: section('Optional') },
      { file: effects, line: heading('add_resource') },
      { file: wiki('Effects'), line: row('add_resource') },
    ],
  },
  {
    query: 'make a technology unlock a new building',
    kind: 'question',
    answers: [{ file: wiki('Technology modding'), line: section('Enabling objects') }],
  },
  {
    query: 'run an effect when a country changes its government',
    kind: 'question',
    answers: [
      { file: wiki('On actions'), line: row('on_government_change') },
      { file: wiki('On actions'), line: row('on_ruling_party_change') },
      { file: wiki('On actions'), line: section('Politics') },
    ],
  },
  {
    query: 'make the AI want to conquer a specific country',
    kind: 'question',
    answers: [
      { file: wiki('AI modding'), line: section('AI strategies') },
      { file: wiki('AI modding'), line: row('conquer') },
      { file: effects, line: heading('add_ai_strategy') },
      { file: wiki('Effects'), line: row('add_ai_strategy') },
    ],
  },
  {
    query: 'make a country research faster',
    kind: 'question',
    answers: [
      { file: 'modifiers_documentation.md', line: /^## research_speed_factor$/u },
      { file: wiki('Modifiers'), line: row('research_speed_factor') },
      { file: wiki('List of modifiers'), line: row('research_speed_factor') },
    ],
  },
];

/**
 * Final test questions written on 2026-11-01 by a second agent that saw none of the other
 * sets' results. Ranking changes are developed on the three sets above; this one is scored
 * only to report a finished change.
 */
export const testCases: DiscoveryCase[] = [
  ...(
    [
      ['give a country extra manpower', effects, 'add_manpower'],
      ['raise war support by a few percent', effects, 'add_war_support'],
      ['give a country some command power', effects, 'add_command_power'],
      [
        "queue up tanks or rifles in a country's equipment production",
        effects,
        'add_equipment_production',
      ],
      ['change the ruling party and turn elections on or off', effects, 'set_politics'],
      ['rename a state, for example when a country takes it over', effects, 'set_state_name'],
      [
        'improve how much one country likes another with a diplomatic opinion bonus',
        effects,
        'add_opinion_modifier',
      ],
      ['switch a country over to a different focus tree', effects, 'load_focus_tree'],
      [
        'tell the AI to prioritise or avoid something towards another country',
        effects,
        'add_ai_strategy',
      ],
      ['give a research bonus that discounts the next few technologies', effects, 'add_tech_bonus'],
      ['give a general or advisor a new trait', effects, 'add_trait'],
      ['check if a country is at war with anyone', triggers, 'has_war'],
      ['check how much political power a country has', triggers, 'has_political_power'],
      ['check if a country is a member of any faction', triggers, 'is_in_faction'],
      ['check whether a decision is currently active', triggers, 'has_decision'],
      ["check if a country is someone else's puppet", triggers, 'is_puppet'],
      ['check whether a country owns a particular state', triggers, 'owns_state'],
      ['check if a country has enough army experience', triggers, 'has_army_experience'],
      ['check if a character exists for a country', triggers, 'has_character'],
      ['check if two countries are allies', triggers, 'is_ally_with'],
      ["check how big a country's navy is", triggers, 'has_navy_size'],
    ] as const
  ).map(([query, file, name]): DiscoveryCase => ({
    query,
    kind: 'question',
    answers: [
      { file, line: heading(name) },
      { file: wiki(file === effects ? 'Effects' : 'Triggers'), line: row(name) },
    ],
  })),
  {
    query: 'add a number to a variable',
    kind: 'question',
    answers: [
      { file: effects, line: heading('add_to_variable') },
      { file: wiki('Effects'), line: row('add_to_variable') },
      { file: wiki('Data structures'), line: row('add_to_variable') },
    ],
  },
  ...(
    [
      ['gain more political power every day', 'political_power_gain'],
      ['make all buildings construct faster', 'production_speed_buildings_factor'],
      ['make my army use less supply', 'supply_consumption_factor'],
      ['increase how much of the population can be recruited', 'conscription_factor'],
    ] as const
  ).map(([query, name]): DiscoveryCase => ({
    query,
    kind: 'question',
    answers: [
      { file: 'modifiers_documentation.md', line: heading(name) },
      { file: wiki('Modifiers'), line: row(name) },
      { file: wiki('List of modifiers'), line: row(name) },
    ],
  })),
  ...(
    [
      [
        'how do I give an event several option buttons with different outcomes',
        'Event modding',
        ['Options'],
      ],
      [
        'place a focus on the tree relative to another focus',
        'National focus modding',
        ['Position'],
      ],
      [
        'decision that works as a timed mission with a deadline',
        'Decision modding',
        ['Missions', 'Mission example'],
      ],
      [
        'how are idea categories and slots defined for advisors',
        'Idea modding',
        ['Idea category arguments', 'Categories'],
      ],
      ['set up a political advisor as a character', 'Character modding', ['Advisors']],
      ['put a little icon inside a piece of text', 'Localisation', ['Text icons']],
      [
        'write a state history file with buildings and owner',
        'State modding',
        ['History', 'Buildings'],
      ],
      [
        'add a new tab to the research screen for my own technologies',
        'Technology modding',
        ['Folders', 'Folder tabs'],
      ],
      [
        'create a new start date with its own description and list of featured countries',
        'Bookmark modding',
        ['Attributes', 'File example'],
      ],
    ] as const
  ).map(([query, page, titles]): DiscoveryCase => ({
    query,
    kind: 'question',
    answers: titles.map((title) => ({ file: wiki(page), line: section(title) })),
  })),
  {
    query: 'run something when a state is captured by another country',
    kind: 'question',
    answers: [
      { file: wiki('On actions'), line: section('States') },
      { file: wiki('On actions'), line: row('on_state_control_changed') },
    ],
  },
  {
    query: 'swap_ideas',
    kind: 'identifier',
    answers: [{ file: effects, line: heading('swap_ideas') }],
  },
  {
    query: 'activate_decision',
    kind: 'identifier',
    answers: [{ file: effects, line: heading('activate_decision') }],
  },
  {
    query: 'has_template',
    kind: 'identifier',
    answers: [{ file: triggers, line: heading('has_template') }],
  },
  {
    query: 'any_neighbor_country',
    kind: 'identifier',
    answers: [{ file: triggers, line: heading('any_neighbor_country') }],
  },
  { query: 'banana bread recipe with extra walnuts', kind: 'negative', answers: [] },
  {
    query: 'how to fix my graphics card driver crashing in a shooter',
    kind: 'negative',
    answers: [],
  },
];

/**
 * A second blind set, written on 2026-11-02 by an agent that saw no ranking code, no search
 * results and none of the sets above. It was scored once, for the change in ADR 0077.
 */
export const freshCases: DiscoveryCase[] = [
  // Effects
  {
    query: 'move the capital of a country to another state',
    kind: 'question',
    answers: [
      { file: effects, line: heading('set_capital') },
      { file: wiki('effects'), line: row('set_capital') },
    ],
  },
  {
    query: 'absorb another nation completely into mine',
    kind: 'question',
    answers: [
      { file: effects, line: heading('annex_country') },
      { file: wiki('effects'), line: row('annex_country') },
    ],
  },
  {
    query: 'start a war against another country from script',
    kind: 'question',
    answers: [
      { file: effects, line: heading('declare_war_on') },
      { file: wiki('effects'), line: row('declare_war_on') },
    ],
  },
  {
    query: 'hand a state over to a different owner',
    kind: 'question',
    answers: [
      { file: effects, line: heading('transfer_state') },
      { file: wiki('effects'), line: row('transfer_state') },
    ],
  },
  {
    query: 'make fascism more popular in a country',
    kind: 'question',
    answers: [
      { file: effects, line: heading('add_popularity') },
      { file: wiki('effects'), line: row('add_popularity') },
    ],
  },
  {
    query: 'grant a country a tech without researching it',
    kind: 'question',
    answers: [
      { file: effects, line: heading('set_technology') },
      { file: wiki('effects'), line: row('set_technology') },
    ],
  },
  {
    query: 'change the displayed name and flag of a country after an event',
    kind: 'question',
    answers: [
      { file: effects, line: heading('set_cosmetic_tag') },
      { file: wiki('effects'), line: row('set_cosmetic_tag') },
    ],
  },
  {
    query: 'mark a national focus as finished through script',
    kind: 'question',
    answers: [
      { file: effects, line: heading('complete_national_focus') },
      { file: wiki('effects'), line: row('complete_national_focus') },
    ],
  },
  {
    query: 'split a country in two with a revolt',
    kind: 'question',
    answers: [
      { file: effects, line: heading('start_civil_war') },
      { file: wiki('effects'), line: row('start_civil_war') },
    ],
  },
  {
    query: 'bring a country into my alliance',
    kind: 'question',
    answers: [
      { file: effects, line: heading('add_to_faction') },
      { file: wiki('effects'), line: row('add_to_faction') },
    ],
  },
  {
    query: 'give a country a justification to attack a neighbour',
    kind: 'question',
    answers: [
      { file: effects, line: heading('create_wargoal') },
      { file: wiki('effects'), line: row('create_wargoal') },
    ],
  },
  {
    query: 'give a country a national spirit',
    kind: 'question',
    answers: [
      { file: effects, line: heading('add_ideas') },
      { file: wiki('effects'), line: row('add_ideas') },
    ],
  },
  // Triggers
  {
    query: 'has the player already finished this focus',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('has_completed_focus') },
      { file: wiki('triggers'), line: row('has_completed_focus') },
    ],
  },
  {
    query: 'only run this for computer-controlled countries',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('is_ai') },
      { file: wiki('triggers'), line: row('is_ai') },
    ],
  },
  {
    query: 'check whether the people support the war effort enough',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('has_war_support') },
      { file: wiki('triggers'), line: row('has_war_support') },
    ],
  },
  {
    query: 'how close is a country to capitulating',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('surrender_progress') },
      { file: wiki('triggers'), line: row('surrender_progress') },
    ],
  },
  {
    query: 'is this country a vassal of anyone',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('is_subject') },
      { file: wiki('triggers'), line: row('is_subject') },
    ],
  },
  {
    query: 'does the country possess a particular state',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('owns_state') },
      { file: wiki('triggers'), line: row('owns_state') },
    ],
  },
  {
    query: 'condition on how tense the world currently is',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('threat') },
      { file: wiki('triggers'), line: row('threat') },
    ],
  },
  {
    query: 'do these two countries share a border',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('is_neighbor_of') },
      { file: wiki('triggers'), line: row('is_neighbor_of') },
    ],
  },
  {
    query: 'how many scientists can a country research with at once',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('amount_research_slots') },
      { file: wiki('triggers'), line: row('amount_research_slots') },
    ],
  },
  {
    query: 'are these two nations in the same alliance',
    kind: 'question',
    answers: [
      { file: triggers, line: heading('is_in_faction_with') },
      { file: wiki('triggers'), line: row('is_in_faction_with') },
    ],
  },
  // Modifiers
  {
    query: 'make buildings get constructed faster',
    kind: 'question',
    answers: [
      { file: 'modifiers_documentation.md', line: heading('production_speed_buildings_factor') },
      { file: wiki('modifiers'), line: row('production_speed_buildings_factor') },
      { file: wiki('list_of_modifiers'), line: row('production_speed_buildings_factor') },
    ],
  },
  {
    query: 'shorten the time it takes to train divisions',
    kind: 'question',
    answers: [
      { file: 'modifiers_documentation.md', line: heading('training_time_factor') },
      { file: wiki('modifiers'), line: row('training_time_factor') },
      { file: wiki('list_of_modifiers'), line: row('training_time_factor') },
    ],
  },
  {
    query: 'share of industry spent on civilian goods',
    kind: 'question',
    answers: [
      { file: 'modifiers_documentation.md', line: heading('consumer_goods_factor') },
      { file: wiki('modifiers'), line: row('consumer_goods_factor') },
      { file: wiki('list_of_modifiers'), line: row('consumer_goods_factor') },
    ],
  },
  {
    query: 'how many victory points can be lost before a country gives up',
    kind: 'question',
    answers: [
      { file: 'modifiers_documentation.md', line: heading('surrender_limit') },
      { file: wiki('modifiers'), line: row('surrender_limit') },
      { file: wiki('list_of_modifiers'), line: row('surrender_limit') },
    ],
  },
  // Modding concepts
  {
    query: 'how do I give an event several choices for the player',
    kind: 'question',
    answers: [{ file: wiki('event_modding'), line: section('Options') }],
  },
  {
    query: 'require two other focuses before a focus can be taken',
    kind: 'question',
    answers: [
      { file: wiki('national_focus_modding'), line: section('Interaction with other focuses') },
    ],
  },
  {
    query: 'make the AI more likely to pick a focus',
    kind: 'question',
    answers: [{ file: wiki('national_focus_modding'), line: section('AI will do') }],
  },
  {
    query: 'how to colour part of a text string in game',
    kind: 'question',
    answers: [{ file: wiki('localisation'), line: section('Colouring characters') }],
  },
  {
    query: 'decision that lasts some days and then runs a cleanup effect',
    kind: 'question',
    answers: [{ file: wiki('decision_modding'), line: section('Timer upon selection') }],
  },
  {
    query: 'what bonuses can a national spirit give while active',
    kind: 'question',
    answers: [{ file: wiki('idea_modding'), line: section('Modifiers') }],
  },
  {
    query: 'let units cross a strait between two provinces that are not touching',
    kind: 'question',
    answers: [{ file: wiki('map_modding'), line: section('Adjacencies') }],
  },
  {
    query: 'add a clickable button with an image and text to a custom window',
    kind: 'question',
    answers: [{ file: wiki('interface_modding'), line: section('buttonType') }],
  },
  // Identifiers
  {
    query: 'add_political_power',
    kind: 'identifier',
    answers: [
      { file: effects, line: heading('add_political_power') },
      { file: wiki('effects'), line: row('add_political_power') },
    ],
  },
  {
    query: 'has_government',
    kind: 'identifier',
    answers: [
      { file: triggers, line: heading('has_government') },
      { file: wiki('triggers'), line: row('has_government') },
    ],
  },
  {
    query: 'political_power_factor',
    kind: 'identifier',
    answers: [
      { file: 'modifiers_documentation.md', line: heading('political_power_factor') },
      { file: wiki('modifiers'), line: row('political_power_factor') },
      { file: wiki('list_of_modifiers'), line: row('political_power_factor') },
    ],
  },
  {
    query: 'set_country_flag',
    kind: 'identifier',
    answers: [
      { file: effects, line: heading('set_country_flag') },
      { file: wiki('effects'), line: row('set_country_flag') },
    ],
  },
  // Negatives
  { query: 'best hydration percentage for sourdough pizza dough', kind: 'negative', answers: [] },
  { query: 'how to fix a flat bicycle tire', kind: 'negative', answers: [] },
];
