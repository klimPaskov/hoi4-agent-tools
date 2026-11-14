import type { DiscoveryCase } from './reference-discovery-cases.js';

/**
 * Questions a new modder or a coding agent asks in plain words (issue 64). A fresh author wrote
 * them from the documentation alone, without seeing the ranking code or any result, and checked
 * each answer line by hand. The first half tunes the ranking (`--common-dev`). The second half
 * stays untouched until a change is final and is scored once (`--common-blind`). The cases hold
 * questions and identifier patterns only, never documentation text.
 */
export const commonDevCases: DiscoveryCase[] = [
  {
    query: 'How do I check that my country is currently fighting a war?',
    kind: 'question',
    answers: [
      { file: 'triggers_documentation.md', line: /^## has_war$/u },
      { file: 'triggers.md', line: /^\| has_war \|/u },
    ],
  },
  { query: 'sourdough starter recipe for beginners', kind: 'negative', answers: [] },
  {
    query: 'How do I give a country a national spirit through script?',
    kind: 'question',
    answers: [
      { file: 'effects_documentation.md', line: /^## add_ideas$/u },
      { file: 'effects.md', line: /^\| add_ideas \|/u },
    ],
  },
  {
    query: 'Why do my events not load until I declare something called a namespace?',
    kind: 'question',
    answers: [{ file: 'event_modding.md', line: /^### ID rules/u }],
  },
  {
    query: 'How do I add a temporary bonus that goes away after some days?',
    kind: 'question',
    answers: [
      { file: 'effects_documentation.md', line: /^## add_timed_idea$/u },
      { file: 'effects.md', line: /^\| add_timed_idea \|/u },
    ],
  },
  {
    query: 'hold_election',
    kind: 'identifier',
    answers: [
      { file: 'effects_documentation.md', line: /^## hold_election$/u },
      { file: 'effects.md', line: /^\| hold_election \|/u },
    ],
  },
  {
    query: 'How do I free a puppet so it becomes independent?',
    kind: 'question',
    answers: [
      { file: 'effects_documentation.md', line: /^## end_puppet$/u },
      { file: 'effects.md', line: /^\| end_puppet \|/u },
    ],
  },
  {
    query: 'How do prerequisites on focuses work when I want one focus OR another?',
    kind: 'question',
    answers: [{ file: 'national_focus_modding.md', line: /^### Interaction with other focuses/u }],
  },
  {
    query: 'How can I tell whether a state has access to the sea?',
    kind: 'question',
    answers: [
      { file: 'triggers_documentation.md', line: /^## is_coastal$/u },
      { file: 'triggers.md', line: /^\| is_coastal \|/u },
    ],
  },
  { query: 'how to adjust the gears on a bicycle for steep hills', kind: 'negative', answers: [] },
  {
    query: 'How do I make a decision invisible until some condition becomes true?',
    kind: 'question',
    answers: [{ file: 'decision_modding.md', line: /^### Triggers/u }],
  },
  {
    query: 'How do missions differ from ordinary decisions?',
    kind: 'question',
    answers: [{ file: 'decision_modding.md', line: /^## Missions/u }],
  },
  {
    query: 'How do I check who the owner of a state is?',
    kind: 'question',
    answers: [
      { file: 'triggers_documentation.md', line: /^## is_owned_by$/u },
      { file: 'triggers_documentation.md', line: /^## owns_state$/u },
      { file: 'triggers.md', line: /^\| is_owned_by \|/u },
    ],
  },
  {
    query: 'How do I start a civil war in a country?',
    kind: 'question',
    answers: [
      { file: 'effects_documentation.md', line: /^## start_civil_war$/u },
      { file: 'effects.md', line: /^\| start_civil_war \|/u },
    ],
  },
  {
    query: 'has_stability',
    kind: 'identifier',
    answers: [
      { file: 'triggers_documentation.md', line: /^## has_stability$/u },
      { file: 'triggers.md', line: /^\| has_stability \|/u },
    ],
  },
  {
    query: 'How do I make an event fire randomly, roughly once every few months?',
    kind: 'question',
    answers: [
      { file: 'event_modding.md', line: /^### Triggering/u },
      { file: 'ai_modding.md', line: /^## MTTH blocks/u },
    ],
  },
  {
    query: 'How do I change how likely the AI is to pick a certain focus?',
    kind: 'question',
    answers: [{ file: 'national_focus_modding.md', line: /^### AI will do/u }],
  },
  {
    query: 'How do I colour a single word in my localisation text?',
    kind: 'question',
    answers: [{ file: 'localisation.md', line: /^### Colouring characters/u }],
  },
  {
    query: 'How do I give a country an extra research slot?',
    kind: 'question',
    answers: [
      { file: 'effects_documentation.md', line: /^## add_research_slot$/u },
      { file: 'effects.md', line: /^\| add_research_slot \|/u },
    ],
  },
  {
    query: 'How do state categories decide how many building slots a state gets?',
    kind: 'question',
    answers: [{ file: 'state_modding.md', line: /^## State categories/u }],
  },
  {
    query: 'How do I hand a state over to another country?',
    kind: 'question',
    answers: [
      { file: 'effects_documentation.md', line: /^## transfer_state$/u },
      { file: 'effects_documentation.md', line: /^## transfer_state_to$/u },
      { file: 'effects_documentation.md', line: /^## set_state_owner$/u },
    ],
  },
  {
    query: 'How do I find out how many factories a country has?',
    kind: 'question',
    answers: [
      { file: 'triggers_documentation.md', line: /^## num_of_factories$/u },
      { file: 'triggers_documentation.md', line: /^## num_of_military_factories$/u },
    ],
  },
  { query: 'how long should I roast a turkey per kilo', kind: 'negative', answers: [] },
];

export const commonBlindCases: DiscoveryCase[] = [
  {
    query: 'How do I take away a national spirit from a country?',
    kind: 'question',
    answers: [
      { file: 'effects_documentation.md', line: /^## remove_ideas$/u },
      { file: 'effects.md', line: /^\| remove_ideas \|/u },
    ],
  },
  {
    query: 'How do I run some script every month for every country?',
    kind: 'question',
    answers: [{ file: 'on_actions.md', line: /^\| on_monthly \|/u }],
  },
  {
    query: 'How do I make one country declare war on another?',
    kind: 'question',
    answers: [
      { file: 'effects_documentation.md', line: /^## declare_war_on$/u },
      { file: 'effects.md', line: /^\| declare_war_on \|/u },
    ],
  },
  {
    query: 'swap_ideas',
    kind: 'identifier',
    answers: [
      { file: 'effects_documentation.md', line: /^## swap_ideas$/u },
      { file: 'effects.md', line: /^\| swap_ideas \|/u },
    ],
  },
  {
    query: 'How can I tell whether the player has already taken a given national focus?',
    kind: 'question',
    answers: [
      { file: 'triggers_documentation.md', line: /^## has_completed_focus$/u },
      { file: 'triggers.md', line: /^\| has_completed_focus \|/u },
    ],
  },
  {
    query: 'What do PREV and ROOT mean when I scope into other things?',
    kind: 'question',
    answers: [
      { file: 'scopes.md', line: /^## PREV usage/u },
      { file: 'scopes.md', line: /^## Dual scopes/u },
    ],
  },
  {
    query: 'How do I give a country a technology immediately?',
    kind: 'question',
    answers: [
      { file: 'effects_documentation.md', line: /^## set_technology$/u },
      { file: 'effects.md', line: /^\| set_technology \|/u },
    ],
  },
  { query: 'tax deductions for a home office', kind: 'negative', answers: [] },
  {
    query: 'How do shared focuses let me reuse a branch between several focus trees?',
    kind: 'question',
    answers: [{ file: 'national_focus_modding.md', line: /^## Shared focuses/u }],
  },
  {
    query: 'How do I check that a country is a vassal of Germany?',
    kind: 'question',
    answers: [
      { file: 'triggers_documentation.md', line: /^## is_puppet_of$/u },
      { file: 'triggers_documentation.md', line: /^## is_subject_of$/u },
    ],
  },
  {
    query: 'How do I do an effect that only has a 25 percent chance of happening?',
    kind: 'question',
    answers: [
      { file: 'effects_documentation.md', line: /^## random_list$/u },
      { file: 'effects_documentation.md', line: /^## random$/u },
    ],
  },
  {
    query: 'on_state_control_changed',
    kind: 'identifier',
    answers: [{ file: 'on_actions.md', line: /^\| on_state_control_changed \|/u }],
  },
  {
    query: 'How do I show a tooltip line in an effect without actually doing anything?',
    kind: 'question',
    answers: [
      { file: 'effects_documentation.md', line: /^## effect_tooltip$/u },
      { file: 'effects_documentation.md', line: /^## custom_effect_tooltip$/u },
    ],
  },
  {
    query: 'How do technology sharing groups work?',
    kind: 'question',
    answers: [{ file: 'technology_modding.md', line: /^## Technology sharing groups/u }],
  },
  {
    query: 'How do I loop over every state a country owns and do something to each?',
    kind: 'question',
    answers: [
      { file: 'effects_documentation.md', line: /^## every_owned_state$/u },
      { file: 'effects.md', line: /^\| every_owned_state \|/u },
    ],
  },
  {
    query: 'How do I give a country one-time research speed on a specific tech category?',
    kind: 'question',
    answers: [
      { file: 'effects_documentation.md', line: /^## add_tech_bonus$/u },
      { file: 'effects.md', line: /^\| add_tech_bonus \|/u },
    ],
  },
  {
    query: 'How do I add political power as a reward in an event option?',
    kind: 'question',
    answers: [
      { file: 'effects_documentation.md', line: /^## add_political_power$/u },
      { file: 'effects.md', line: /^\| add_political_power \|/u },
    ],
  },
  {
    query: 'How does scripted localisation pick different text depending on a condition?',
    kind: 'question',
    answers: [{ file: 'localisation.md', line: /^## Scripted localisation/u }],
  },
  {
    query: 'every_neighbor_state',
    kind: 'identifier',
    answers: [
      { file: 'effects_documentation.md', line: /^## every_neighbor_state$/u },
      { file: 'effects.md', line: /^\| every_neighbor_state \|/u },
    ],
  },
  {
    query: 'How do I make an event pop up a few days after a focus completes?',
    kind: 'question',
    answers: [
      { file: 'effects_documentation.md', line: /^## country_event$/u },
      { file: 'event_modding.md', line: /^## Effect/u },
    ],
  },
  {
    query: 'How do I make my factories produce more output with a modifier?',
    kind: 'question',
    answers: [
      { file: 'modifiers_documentation.md', line: /^## industrial_capacity_factory$/u },
      { file: 'list_of_modifiers.md', line: /^\| industrial_capacity_factory \|/u },
    ],
  },
  {
    query: 'What are event targets and how do global ones differ from regular ones?',
    kind: 'question',
    answers: [{ file: 'data_structures.md', line: /^## Event targets/u }],
  },
  {
    query: 'How do I set up a clickable button in a custom interface?',
    kind: 'question',
    answers: [{ file: 'interface_modding.md', line: /^## buttonType/u }],
  },
  { query: 'how to reset a home wifi router', kind: 'negative', answers: [] },
];
