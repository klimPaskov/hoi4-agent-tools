import type { DiscoveryCase } from './reference-discovery-cases.js';

/**
 * A second set of common modder questions (issue 64, round four), written by a fresh author who
 * saw no ranking code, no phrasing data and no results. It is the blind set for the build-time
 * phrasing round and was scored once after the phrasing data and its weight were final. Questions
 * and identifier patterns only, never documentation text.
 */
export const commonBlind2Cases: DiscoveryCase[] = [
  {
    query: 'how do I give a country a national spirit that disappears after a set number of days',
    kind: 'question',
    answers: [{ file: 'effects_documentation.md', line: /^## add_timed_idea$/u }],
  },
  {
    query: 'replace one national spirit with another in a single step',
    kind: 'question',
    answers: [{ file: 'effects_documentation.md', line: /^## swap_ideas$/u }],
  },
  {
    query: 'make a country hold its elections right now instead of waiting',
    kind: 'question',
    answers: [{ file: 'effects_documentation.md', line: /^## hold_election$/u }],
  },
  {
    query: 'stop two countries from fighting each other for a while after a war',
    kind: 'question',
    answers: [{ file: 'effects_documentation.md', line: /^## set_truce$/u }],
  },
  {
    query: 'end a war with nobody winning',
    kind: 'question',
    answers: [{ file: 'effects_documentation.md', line: /^## white_peace$/u }],
  },
  {
    query: 'turn a state into a demilitarized zone',
    kind: 'question',
    answers: [{ file: 'effects_documentation.md', line: /^## set_demilitarized_zone$/u }],
  },
  {
    query: 'change how harshly an occupied country is treated',
    kind: 'question',
    answers: [{ file: 'effects_documentation.md', line: /^## set_occupation_law$/u }],
  },
  {
    query: 'hand over some tanks from my stockpile to another country',
    kind: 'question',
    answers: [{ file: 'effects_documentation.md', line: /^## send_equipment$/u }],
  },
  {
    query: 'instantly move my armies out of a state to somewhere else',
    kind: 'question',
    answers: [{ file: 'effects_documentation.md', line: /^## teleport_armies$/u }],
  },
  {
    query: 'make a puppet country independent again',
    kind: 'question',
    answers: [{ file: 'effects_documentation.md', line: /^## end_puppet$/u }],
  },
  {
    query: 'let the player take a decision again that is stuck on cooldown',
    kind: 'question',
    answers: [{ file: 'effects_documentation.md', line: /^## remove_decision_on_cooldown$/u }],
  },
  {
    query: 'make one specific national focus finish faster',
    kind: 'question',
    answers: [{ file: 'effects_documentation.md', line: /^## reduce_focus_completion_cost$/u }],
  },
  {
    query: 'place naval mines in a sea region',
    kind: 'question',
    answers: [{ file: 'effects_documentation.md', line: /^## add_mines$/u }],
  },
  {
    query: 'copy every technology another country has',
    kind: 'question',
    answers: [{ file: 'effects_documentation.md', line: /^## inherit_technology$/u }],
  },
  {
    query: 'stop the player from editing a division template',
    kind: 'question',
    answers: [{ file: 'effects_documentation.md', line: /^## set_division_template_lock$/u }],
  },
  {
    query: 'bring back the volunteers I sent to another country',
    kind: 'question',
    answers: [{ file: 'effects_documentation.md', line: /^## recall_volunteers_from$/u }],
  },
  {
    query: 'make the AI lean toward befriending or attacking a particular country',
    kind: 'question',
    answers: [{ file: 'effects_documentation.md', line: /^## add_ai_strategy$/u }],
  },
  {
    query: 'how many days ago did this country surrender',
    kind: 'question',
    answers: [{ file: 'triggers_documentation.md', line: /^## days_since_capitulated$/u }],
  },
  {
    query: 'check how many of the neighbouring states of this state belong to a country',
    kind: 'question',
    answers: [{ file: 'triggers_documentation.md', line: /^## num_owned_neighbour_states$/u }],
  },
  {
    query: 'is this character currently working as an advisor',
    kind: 'question',
    answers: [{ file: 'triggers_documentation.md', line: /^## is_hired_as_advisor$/u }],
  },
  {
    query: 'is the country in the middle of researching a certain technology',
    kind: 'question',
    answers: [{ file: 'triggers_documentation.md', line: /^## is_researching_technology$/u }],
  },
  {
    query: 'how dangerous are enemy submarines to my convoys',
    kind: 'question',
    answers: [{ file: 'triggers_documentation.md', line: /^## convoy_threat$/u }],
  },
  {
    query: 'count the ships sitting in the ports of a state',
    kind: 'question',
    answers: [{ file: 'triggers_documentation.md', line: /^## ships_in_state_ports$/u }],
  },
  {
    query: 'is the country close to giving up the war',
    kind: 'question',
    answers: [{ file: 'triggers_documentation.md', line: /^## surrender_progress$/u }],
  },
  {
    query: 'are these two countries fighting on the same side',
    kind: 'question',
    answers: [{ file: 'triggers_documentation.md', line: /^## has_war_together_with$/u }],
  },
  {
    query: 'has my country been fighting a specific enemy for more than a year',
    kind: 'question',
    answers: [{ file: 'triggers_documentation.md', line: /^## war_length_with$/u }],
  },
  {
    query: 'is a particular game rule option switched on',
    kind: 'question',
    answers: [{ file: 'triggers_documentation.md', line: /^## has_game_rule$/u }],
  },
  {
    query: 'am I currently allowed to declare war on this country',
    kind: 'question',
    answers: [{ file: 'triggers_documentation.md', line: /^## can_declare_war_on$/u }],
  },
  {
    query: 'reduce how much attrition my troops suffer',
    kind: 'question',
    answers: [
      { file: 'modifiers_documentation.md', line: /^## attrition$/u },
      { file: 'list_of_modifiers.md', line: /^\| attrition \|/u },
    ],
  },
  {
    query: 'change the stability penalty for starting offensive wars',
    kind: 'question',
    answers: [
      { file: 'modifiers_documentation.md', line: /^## offensive_war_stability_factor$/u },
      { file: 'list_of_modifiers.md', line: /^\| offensive_war_stability_factor \|/u },
    ],
  },
  {
    query: 'make buildings get constructed faster across the whole country',
    kind: 'question',
    answers: [
      { file: 'modifiers_documentation.md', line: /^## production_speed_buildings_factor$/u },
      { file: 'list_of_modifiers.md', line: /^\| production_speed_buildings_factor \|/u },
    ],
  },
  {
    query: 'make my divisions get reinforced faster',
    kind: 'question',
    answers: [
      { file: 'modifiers_documentation.md', line: /^## land_reinforce_rate$/u },
      { file: 'list_of_modifiers.md', line: /^\| land_reinforce_rate \|/u },
    ],
  },
  {
    query: 'change how many victory points a country must lose before it capitulates',
    kind: 'question',
    answers: [
      { file: 'modifiers_documentation.md', line: /^## surrender_limit$/u },
      { file: 'modifiers.md', line: /^\| surrender_limit \|/u },
    ],
  },
  {
    query: 'how does resistance grow in occupied states and what numbers drive it',
    kind: 'question',
    answers: [
      { file: 'occupation_and_resistance_modding.md', line: /^#{2,4} Numbers behind the system/u },
      { file: 'occupation_and_resistance_modding.md', line: /^#{2,4} Overview/u },
    ],
  },
  {
    query: 'how does a balance of power bar with two sides and ranges work',
    kind: 'question',
    answers: [
      { file: 'balance_of_power_modding.md', line: /^#{2,4} Code structure/u },
      { file: 'balance_of_power_modding.md', line: /^#{2,4} Side /u },
    ],
  },
  {
    query: 'when several cost modifiers apply in a peace conference how are they combined',
    kind: 'question',
    answers: [{ file: 'peace_conference_modding.md', line: /^#{2,4} How modifiers multiply/u }],
  },
  {
    query: 'which automatic hooks fire when countries declare war or make peace',
    kind: 'question',
    answers: [{ file: 'on_actions.md', line: /^#{2,4} Diplomacy\/War/u }],
  },
  {
    query: 'how does a raid decide whether it succeeds or fails',
    kind: 'question',
    answers: [
      { file: 'raid_modding.md', line: /^#{2,4} Success chance/u },
      { file: 'raid_modding.md', line: /^#{2,4} How the odds become outcomes/u },
    ],
  },
  {
    query: 'how are intelligence operations divided into stages',
    kind: 'question',
    answers: [{ file: 'intelligence_operation_modding.md', line: /^#{2,4} Phases/u }],
  },
  {
    query: 'how do grand doctrines, tracks and subdoctrines fit together',
    kind: 'question',
    answers: [
      { file: 'doctrine_modding.md', line: /^#{2,4} Structure/u },
      { file: 'doctrine_modding.md', line: /^#{2,4} Kit: How the doctrine files link/u },
    ],
  },
  {
    query: 'add_state_resistance_compliance_modifier',
    kind: 'identifier',
    answers: [
      { file: 'effects_documentation.md', line: /^## add_state_resistance_compliance_modifier$/u },
    ],
  },
  {
    query: 'has_mio_number_of_completed_traits',
    kind: 'identifier',
    answers: [
      { file: 'triggers_documentation.md', line: /^## has_mio_number_of_completed_traits$/u },
    ],
  },
  {
    query: 'transfer_units_fraction',
    kind: 'identifier',
    answers: [{ file: 'effects_documentation.md', line: /^## transfer_units_fraction$/u }],
  },
  { query: 'how long do I bake sourdough bread', kind: 'negative', answers: [] },
  { query: 'who won the football world cup in 2018', kind: 'negative', answers: [] },
  { query: 'best way to repot a houseplant', kind: 'negative', answers: [] },
  { query: 'marathon training plan for beginners', kind: 'negative', answers: [] },
  { query: 'recipe for chocolate chip cookies', kind: 'negative', answers: [] },
];
