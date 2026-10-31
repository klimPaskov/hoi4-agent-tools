//! Where the game expects effects, triggers, weights, modifiers and references, per folder.
//!
//! A command position is an entry inside an effect or trigger block. Its key is resolved, in
//! order, as control flow, a scope switch, a documented command, a scripted effect or trigger, a
//! dynamic name (unknown), or nothing (unresolved). The documented vocabulary comes from the game
//! (see [`crate::vocab`]). Control flow and scope links below are the words the game accepts but
//! its documentation does not list; each list says how it was checked.
//!
//! Folders without a model here are counted as unmodelled and never reported as passing.

use hoi4_syntax::{Block, Document, Entry, Item, Operator, Value};

use crate::index::{Definition, Kind};
use crate::vocab::Vocabulary;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Ctx {
    Effect,
    Trigger,
}

#[derive(Clone, Copy)]
pub enum Slot {
    /// The value is a block of effects.
    Effect,
    /// The value is a block of triggers.
    Trigger,
    /// The entry itself is a command: unknown keys of an option, an `if` or an iterator.
    Command(Ctx),
    /// `ai_will_do`, `ai_chance`, `mean_time_to_happen`: numbers and `modifier = { factor triggers }`.
    Weight,
    /// Keys are modifier names.
    Modifiers,
    Skip,
    Schema(&'static Schema),
    /// A scalar, or a list of scalars, naming a symbol.
    Ref(Kind),
    /// A localisation key, or `{ text = key trigger = { } }`.
    LocText,
    /// A sprite name used as written.
    Sprite,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Plain,
    Event,
    EventOption,
    Focus,
    Decision,
    Idea,
    OnAction,
    RandomEvents,
}

pub struct Schema {
    pub fields: &'static [(&'static str, Slot)],
    pub other: Slot,
    pub role: Role,
    /// When set, each entry of this block is a definition named `<prefix>:<key>`, used as the
    /// context of findings inside it.
    pub entry_context: Option<&'static str>,
}

const fn schema(fields: &'static [(&'static str, Slot)], other: Slot) -> Schema {
    Schema { fields, other, role: Role::Plain, entry_context: None }
}

const fn role(fields: &'static [(&'static str, Slot)], other: Slot, role: Role) -> Schema {
    Schema { fields, other, role, entry_context: None }
}

const fn named(fields: &'static [(&'static str, Slot)], other: Slot, prefix: &'static str) -> Schema {
    Schema { fields, other, role: Role::Plain, entry_context: Some(prefix) }
}

// ---------------------------------------------------------------------------------------------
// Control flow inside effect and trigger blocks.

static IF_EFFECT: Schema = schema(&[("limit", Slot::Trigger)], Slot::Command(Ctx::Effect));
static IF_TRIGGER: Schema = schema(&[("limit", Slot::Trigger)], Slot::Command(Ctx::Trigger));
static RANDOM_EFFECT: Schema = schema(&[("chance", Slot::Skip)], Slot::Command(Ctx::Effect));
static WEIGHT_MODIFIER: Schema = schema(&[("factor", Slot::Skip), ("add", Slot::Skip), ("base", Slot::Skip)], Slot::Command(Ctx::Trigger));
static RANDOM_LIST_ENTRY: Schema = schema(&[("modifier", Slot::Schema(&WEIGHT_MODIFIER))], Slot::Command(Ctx::Effect));
static RANDOM_LIST: Schema = schema(&[("log", Slot::Skip), ("seed", Slot::Skip)], Slot::Schema(&RANDOM_LIST_ENTRY));
static LOOP_ARGS: &[(&str, Slot)] = &[
    ("array", Slot::Skip),
    ("value", Slot::Skip),
    ("index", Slot::Skip),
    ("break", Slot::Skip),
    ("start", Slot::Skip),
    ("end", Slot::Skip),
    ("compare", Slot::Skip),
    ("add", Slot::Skip),
    ("tooltip", Slot::Skip),
    ("limit", Slot::Trigger),
];
static LOOP_EFFECT: Schema = schema(LOOP_ARGS, Slot::Command(Ctx::Effect));
static LOOP_TRIGGER: Schema = schema(LOOP_ARGS, Slot::Command(Ctx::Trigger));
static CUSTOM_TRIGGER_TOOLTIP: Schema = schema(&[("tooltip", Slot::LocText)], Slot::Command(Ctx::Trigger));
static COUNT_TRIGGERS: Schema = schema(&[("amount", Slot::Skip)], Slot::Command(Ctx::Trigger));
/// `every_*`, `random_*` and `global_every_*` effects; `any_*` and `all_*` triggers. The
/// documentation of `every_owned_state` names `limit`, `tooltip`, `random_select_amount` and
/// `display_individual_scopes`.
static ITER_ARGS: &[(&str, Slot)] = &[
    ("limit", Slot::Trigger),
    ("tooltip", Slot::Skip),
    ("random_select_amount", Slot::Skip),
    ("display_individual_scopes", Slot::Skip),
    ("include_invisible", Slot::Skip),
    ("count", Slot::Skip),
    ("percent", Slot::Skip),
    // Selectors named in the documentation of `any_state_in`, `any_state_of`,
    // `any_country_with_original_tag` and the `random_*` state effects.
    ("array", Slot::Skip),
    ("target", Slot::Skip),
    ("continent", Slot::Skip),
    ("ai_area", Slot::Skip),
    ("strategic_region", Slot::Skip),
    ("original_tag_to_check", Slot::Skip),
    ("prioritize", Slot::Skip),
    ("visible_when_empty", Slot::Skip),
    // The collection iterators take the collection under `input`, `collection` or
    // `named_collection` depending on the command (documentation of `every_collection_element`
    // and `any_collection_element`).
    ("input", Slot::Skip),
    ("collection", Slot::Skip),
    ("named_collection", Slot::Skip),
];
static ITER_EFFECT: Schema = schema(ITER_ARGS, Slot::Command(Ctx::Effect));
static ITER_TRIGGER: Schema = schema(ITER_ARGS, Slot::Command(Ctx::Trigger));

static WEIGHT: Schema = schema(
    &[
        ("base", Slot::Skip),
        ("factor", Slot::Skip),
        ("add", Slot::Skip),
        ("days", Slot::Skip),
        ("months", Slot::Skip),
        ("years", Slot::Skip),
        ("modifier", Slot::Schema(&WEIGHT_MODIFIER)),
    ],
    Slot::Skip,
);

static LOC_TEXT: Schema = schema(&[("text", Slot::LocText), ("trigger", Slot::Trigger)], Slot::Skip);

// ---------------------------------------------------------------------------------------------
// Definition files.

static EVENT_OPTION: Schema =
    role(&[("name", Slot::LocText), ("trigger", Slot::Trigger), ("ai_chance", Slot::Schema(&WEIGHT))], Slot::Command(Ctx::Effect), Role::EventOption);
static EVENT: Schema = role(
    &[
        ("title", Slot::LocText),
        ("desc", Slot::LocText),
        ("picture", Slot::Sprite),
        ("trigger", Slot::Trigger),
        ("immediate", Slot::Effect),
        ("after", Slot::Effect),
        ("option", Slot::Schema(&EVENT_OPTION)),
        ("mean_time_to_happen", Slot::Schema(&WEIGHT)),
        ("show_major", Slot::Trigger),
    ],
    Slot::Skip,
    Role::Event,
);
static EVENTS_FILE: Schema = schema(
    &[
        ("country_event", Slot::Schema(&EVENT)),
        ("news_event", Slot::Schema(&EVENT)),
        ("state_event", Slot::Schema(&EVENT)),
        ("unit_leader_event", Slot::Schema(&EVENT)),
        ("operative_leader_event", Slot::Schema(&EVENT)),
    ],
    Slot::Skip,
);

static FOCUS_LINK: Schema = schema(&[("focus", Slot::Ref(Kind::Focus))], Slot::Skip);
static FOCUS_OFFSET: Schema = schema(&[("trigger", Slot::Trigger)], Slot::Skip);
static FOCUS_ICON: Schema = schema(&[("trigger", Slot::Trigger), ("value", Slot::Sprite)], Slot::Skip);
static FOCUS: Schema = role(
    &[
        ("icon", Slot::Schema(&FOCUS_ICON)),
        ("prerequisite", Slot::Schema(&FOCUS_LINK)),
        ("mutually_exclusive", Slot::Schema(&FOCUS_LINK)),
        ("relative_position_id", Slot::Ref(Kind::Focus)),
        ("available", Slot::Trigger),
        ("bypass", Slot::Trigger),
        ("allow_branch", Slot::Trigger),
        ("cancel", Slot::Trigger),
        ("completion_reward", Slot::Effect),
        ("select_effect", Slot::Effect),
        ("complete_tooltip", Slot::Effect),
        ("ai_will_do", Slot::Schema(&WEIGHT)),
        ("offset", Slot::Schema(&FOCUS_OFFSET)),
    ],
    Slot::Skip,
    Role::Focus,
);
static FOCUS_TREE: Schema = schema(
    &[
        ("country", Slot::Schema(&WEIGHT)),
        ("focus", Slot::Schema(&FOCUS)),
        ("shared_focus", Slot::Ref(Kind::Focus)),
        ("initial_show_position", Slot::Schema(&FOCUS_OFFSET_HOLDER)),
    ],
    Slot::Skip,
);
static FOCUS_OFFSET_HOLDER: Schema = schema(&[("offset", Slot::Schema(&FOCUS_OFFSET))], Slot::Skip);
static FOCUS_FILE: Schema =
    schema(&[("focus_tree", Slot::Schema(&FOCUS_TREE)), ("shared_focus", Slot::Schema(&FOCUS)), ("joint_focus", Slot::Schema(&FOCUS))], Slot::Skip);

static CONTINUOUS_FOCUS: Schema = schema(
    &[
        ("available", Slot::Trigger),
        ("enable", Slot::Trigger),
        ("cancel", Slot::Trigger),
        ("select_effect", Slot::Effect),
        ("completion_reward", Slot::Effect),
        ("modifier", Slot::Modifiers),
        ("ai_will_do", Slot::Schema(&WEIGHT)),
        ("icon", Slot::Sprite),
    ],
    Slot::Skip,
);
static CONTINUOUS_PALETTE: Schema = schema(&[("country", Slot::Schema(&WEIGHT)), ("focus", Slot::Schema(&CONTINUOUS_FOCUS))], Slot::Skip);
static CONTINUOUS_FILE: Schema = schema(&[("continuous_focus_palette", Slot::Schema(&CONTINUOUS_PALETTE))], Slot::Skip);

static TARGETED_MODIFIER: Schema = schema(&[("tag", Slot::Skip)], Slot::Modifiers);
static DECISION: Schema = role(
    &[
        ("allowed", Slot::Trigger),
        ("visible", Slot::Trigger),
        ("available", Slot::Trigger),
        ("activation", Slot::Trigger),
        ("cancel_trigger", Slot::Trigger),
        ("remove_trigger", Slot::Trigger),
        ("target_trigger", Slot::Trigger),
        ("target_root_trigger", Slot::Trigger),
        ("custom_cost_trigger", Slot::Trigger),
        ("complete_effect", Slot::Effect),
        ("remove_effect", Slot::Effect),
        ("timeout_effect", Slot::Effect),
        ("cancel_effect", Slot::Effect),
        ("ai_will_do", Slot::Schema(&WEIGHT)),
        ("modifier", Slot::Modifiers),
        ("targeted_modifier", Slot::Schema(&TARGETED_MODIFIER)),
    ],
    Slot::Skip,
    Role::Decision,
);
static DECISION_CATEGORY_BODY: Schema = schema(&[], Slot::Schema(&DECISION));
static DECISIONS_FILE: Schema = schema(&[], Slot::Schema(&DECISION_CATEGORY_BODY));
static DECISION_CATEGORY: Schema = schema(&[("allowed", Slot::Trigger), ("visible", Slot::Trigger), ("available", Slot::Trigger)], Slot::Skip);
static DECISION_CATEGORIES_FILE: Schema = named(&[], Slot::Schema(&DECISION_CATEGORY), "decision_category");

static IDEA: Schema = role(
    &[
        ("allowed", Slot::Trigger),
        ("visible", Slot::Trigger),
        ("available", Slot::Trigger),
        ("allowed_civil_war", Slot::Trigger),
        ("allowed_to_remove", Slot::Trigger),
        ("cancel", Slot::Trigger),
        ("on_add", Slot::Effect),
        ("on_remove", Slot::Effect),
        ("modifier", Slot::Modifiers),
        ("targeted_modifier", Slot::Schema(&TARGETED_MODIFIER)),
        ("ai_will_do", Slot::Schema(&WEIGHT)),
    ],
    Slot::Skip,
    Role::Idea,
);
static IDEA_CATEGORY: Schema = schema(&[], Slot::Schema(&IDEA));
static IDEAS_BODY: Schema = schema(&[], Slot::Schema(&IDEA_CATEGORY));
static IDEAS_FILE: Schema = schema(&[("ideas", Slot::Schema(&IDEAS_BODY))], Slot::Skip);

static RANDOM_EVENTS: Schema = role(&[], Slot::Ref(Kind::Event), Role::RandomEvents);
static ON_ACTION: Schema =
    role(&[("effect", Slot::Effect), ("random_events", Slot::Schema(&RANDOM_EVENTS)), ("events", Slot::Ref(Kind::Event))], Slot::Skip, Role::OnAction);
static ON_ACTIONS_BODY: Schema = schema(&[], Slot::Schema(&ON_ACTION));
static ON_ACTIONS_FILE: Schema = schema(&[("on_actions", Slot::Schema(&ON_ACTIONS_BODY))], Slot::Skip);

static ADVISOR: Schema = schema(
    &[
        ("allowed", Slot::Trigger),
        ("visible", Slot::Trigger),
        ("available", Slot::Trigger),
        ("on_add", Slot::Effect),
        ("on_remove", Slot::Effect),
        ("ai_will_do", Slot::Schema(&WEIGHT)),
        ("modifier", Slot::Modifiers),
    ],
    Slot::Skip,
);
static CHARACTER: Schema =
    schema(&[("advisor", Slot::Schema(&ADVISOR)), ("allowed", Slot::Trigger), ("visible", Slot::Trigger), ("instance", Slot::Schema(&CHARACTER))], Slot::Skip);
static CHARACTERS_BODY: Schema = named(&[], Slot::Schema(&CHARACTER), "character");
static CHARACTERS_FILE: Schema = schema(&[("characters", Slot::Schema(&CHARACTERS_BODY))], Slot::Skip);

static DYNAMIC_MODIFIER: Schema = schema(
    &[
        ("enable", Slot::Trigger),
        ("remove_trigger", Slot::Trigger),
        ("icon", Slot::Skip),
        ("attacker_modifier", Slot::Skip),
        ("valid_relation_trigger", Slot::Trigger),
    ],
    Slot::Skip,
);
static DYNAMIC_MODIFIERS_FILE: Schema = named(&[], Slot::Schema(&DYNAMIC_MODIFIER), "dynamic_modifier");

static DEFINED_TEXT_TEXT: Schema = schema(&[("trigger", Slot::Trigger), ("localization_key", Slot::LocText)], Slot::Skip);
static DEFINED_TEXT: Schema = schema(&[("text", Slot::Schema(&DEFINED_TEXT_TEXT))], Slot::Skip);
static SCRIPTED_LOCALISATION_FILE: Schema = schema(&[("defined_text", Slot::Schema(&DEFINED_TEXT))], Slot::Skip);

static SCRIPTED_GUI_EFFECTS: Schema = schema(&[], Slot::Effect);
static SCRIPTED_GUI_TRIGGERS: Schema = schema(&[], Slot::Trigger);
static SCRIPTED_GUI: Schema = schema(
    &[
        ("visible", Slot::Trigger),
        ("effects", Slot::Schema(&SCRIPTED_GUI_EFFECTS)),
        ("triggers", Slot::Schema(&SCRIPTED_GUI_TRIGGERS)),
        ("ai_check", Slot::Trigger),
    ],
    Slot::Skip,
);
static SCRIPTED_GUIS_BODY: Schema = named(&[], Slot::Schema(&SCRIPTED_GUI), "scripted_gui");
static SCRIPTED_GUIS_FILE: Schema = schema(&[("scripted_gui", Slot::Schema(&SCRIPTED_GUIS_BODY))], Slot::Skip);

/// The schema of a file, from its lower-case relative path. `None` means not modelled.
pub fn file_model(path: &str) -> Option<Slot> {
    let txt = path.ends_with(".txt");
    let under = |prefix: &str| txt && path.starts_with(prefix) && !path[prefix.len()..].contains('/');
    Some(if txt && path.starts_with("events/") {
        Slot::Schema(&EVENTS_FILE)
    } else if under("common/scripted_effects/") {
        Slot::Schema(&SCRIPTED_EFFECTS_FILE)
    } else if under("common/scripted_triggers/") {
        Slot::Schema(&SCRIPTED_TRIGGERS_FILE)
    } else if under("common/decisions/categories/") {
        Slot::Schema(&DECISION_CATEGORIES_FILE)
    } else if under("common/decisions/") {
        Slot::Schema(&DECISIONS_FILE)
    } else if under("common/national_focus/") {
        Slot::Schema(&FOCUS_FILE)
    } else if under("common/continuous_focus/") {
        Slot::Schema(&CONTINUOUS_FILE)
    } else if under("common/ideas/") {
        Slot::Schema(&IDEAS_FILE)
    } else if under("common/on_actions/") {
        Slot::Schema(&ON_ACTIONS_FILE)
    } else if under("common/characters/") {
        Slot::Schema(&CHARACTERS_FILE)
    } else if under("common/dynamic_modifiers/") {
        Slot::Schema(&DYNAMIC_MODIFIERS_FILE)
    } else if under("common/scripted_localisation/") {
        Slot::Schema(&SCRIPTED_LOCALISATION_FILE)
    } else if under("common/scripted_guis/") {
        Slot::Schema(&SCRIPTED_GUIS_FILE)
    } else {
        return None;
    })
}

static SCRIPTED_EFFECTS_FILE: Schema = named(&[], Slot::Effect, "scripted_effect");
static SCRIPTED_TRIGGERS_FILE: Schema = named(&[], Slot::Trigger, "scripted_trigger");

// ---------------------------------------------------------------------------------------------
// Words the game accepts in command positions that its documentation does not list.

/// Scope keywords. `ROOT`, `THIS`, `FROM` and `PREV` and their dotted chains are described in
/// the game's `script_concept_documentation.md` and the wiki's Scopes page.
const SCOPE_KEYWORDS: &[&str] = &["ROOT", "THIS", "FROM", "PREV"];

/// Scope links that move to a related object, for example `owner = { }` from a state. They are
/// not in the generated documentation. Each name here is used in a command position in vanilla
/// 1.19.3.0 and is listed on the offline wiki's Scopes page.
pub const SCOPE_LINKS: &[&str] = &[
    "owner",
    "controller",
    "capital_scope",
    "overlord",
    "faction_leader",
    "occupied",
    "occupied_country_tag",
    "exiled_government",
    "host",
    "event_target",
    "global",
    "mio",
    "character",
];

/// Effect and trigger control words. `if`, `hidden_effect`, `random_list` and the loops are
/// documented; `else_if`, `else`, `AND`, `OR` and `NOT` are not, and are described on the
/// offline wiki's Conditions page.
fn effect_control(key: &str) -> Option<Slot> {
    Some(match key.to_ascii_lowercase().as_str() {
        "if" | "else_if" => Slot::Schema(&IF_EFFECT),
        "else" | "hidden_effect" | "effect_tooltip" => Slot::Effect,
        "random_list" => Slot::Schema(&RANDOM_LIST),
        "random" => Slot::Schema(&RANDOM_EFFECT),
        "while_loop_effect" | "for_each_loop" | "for_each_scope_loop" | "for_loop_effect" | "random_scope_in_array" => Slot::Schema(&LOOP_EFFECT),
        _ => return None,
    })
}

fn trigger_control(key: &str) -> Option<Slot> {
    Some(match key.to_ascii_lowercase().as_str() {
        "and" | "or" | "not" | "else" | "hidden_trigger" => Slot::Trigger,
        "if" | "else_if" => Slot::Schema(&IF_TRIGGER),
        "custom_trigger_tooltip" => Slot::Schema(&CUSTOM_TRIGGER_TOOLTIP),
        "count_triggers" => Slot::Schema(&COUNT_TRIGGERS),
        "any_of" | "all_of" | "any_of_scopes" | "all_of_scopes" => Slot::Schema(&LOOP_TRIGGER),
        _ => return None,
    })
}

/// True for `ROOT`, `FROM.FROM`, `PREV.owner` and similar chains of keywords and links.
fn is_scope_chain(key: &str) -> bool {
    key.split('.').all(|part| SCOPE_KEYWORDS.iter().chain(SCOPE_LINKS).any(|w| w.eq_ignore_ascii_case(part)))
}

/// A country tag shape: three characters, an upper-case letter then upper-case letters or digits.
pub fn is_tag_shaped(key: &str) -> bool {
    let b = key.as_bytes();
    b.len() == 3 && b[0].is_ascii_uppercase() && b[1..].iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

/// Names built at run time: `$PARAM$` in scripted effects, `@constants`, `[?var]` and similar.
pub fn is_dynamic(name: &str) -> bool {
    name.contains('$') || name.contains('@') || name.contains('[') || name.contains('?') || name.contains('^')
}

/// References inside the arguments of documented commands.
fn arg_rules(command: &str) -> &'static [(&'static str, Kind)] {
    const EVENT: &[(&str, Kind)] = &[("", Kind::Event), ("id", Kind::Event)];
    const FOCUS: &[(&str, Kind)] = &[("", Kind::Focus), ("focus", Kind::Focus)];
    const TREE: &[(&str, Kind)] = &[("", Kind::FocusTree), ("tree", Kind::FocusTree)];
    const IDEAS: &[(&str, Kind)] = &[("", Kind::Idea), ("*", Kind::Idea)];
    const TIMED_IDEA: &[(&str, Kind)] = &[("idea", Kind::Idea)];
    const SWAP: &[(&str, Kind)] = &[("remove_idea", Kind::Idea), ("add_idea", Kind::Idea)];
    const DECISION: &[(&str, Kind)] = &[("", Kind::Decision)];
    const TARGETED_DECISION: &[(&str, Kind)] = &[("decision", Kind::Decision)];
    const CATEGORY: &[(&str, Kind)] = &[("", Kind::DecisionCategory)];
    const CHARACTER: &[(&str, Kind)] = &[("", Kind::Character), ("character", Kind::Character)];
    const OPINION: &[(&str, Kind)] = &[("modifier", Kind::OpinionModifier)];
    const OPINION_SCALAR: &[(&str, Kind)] = &[("", Kind::OpinionModifier)];
    const DYNAMIC: &[(&str, Kind)] = &[("modifier", Kind::DynamicModifier)];
    const LEADER_TRAIT: &[(&str, Kind)] = &[("", Kind::CountryLeaderTrait)];
    const TECH: &[(&str, Kind)] = &[("", Kind::Technology)];
    const LOC: &[(&str, Kind)] = &[("", Kind::LocalisationKey)];
    match command {
        "country_event" | "news_event" | "state_event" | "unit_leader_event" | "operative_leader_event" => EVENT,
        "has_completed_focus"
        | "complete_national_focus"
        | "unlock_national_focus"
        | "uncomplete_national_focus"
        | "focus_progress"
        | "activate_shine_on_focus"
        | "deactivate_shine_on_focus" => FOCUS,
        "has_focus_tree" | "load_focus_tree" => TREE,
        "add_ideas" | "remove_ideas" | "has_idea" => IDEAS,
        "add_timed_idea" | "modify_timed_idea" => TIMED_IDEA,
        "swap_ideas" => SWAP,
        "activate_decision" | "activate_mission" | "remove_mission" | "has_active_mission" | "unlock_decision_tooltip" | "activate_mission_tooltip" => DECISION,
        "activate_targeted_decision" | "remove_targeted_decision" => TARGETED_DECISION,
        "unlock_decision_category_tooltip" => CATEGORY,
        "recruit_character" | "has_character" => CHARACTER,
        "add_opinion_modifier" | "remove_opinion_modifier" | "reverse_add_opinion_modifier" => OPINION,
        "has_opinion_modifier" => OPINION_SCALAR,
        "add_dynamic_modifier" | "remove_dynamic_modifier" | "has_dynamic_modifier" => DYNAMIC,
        "add_country_leader_trait" | "remove_country_leader_trait" => LEADER_TRAIT,
        "has_tech" => TECH,
        "custom_effect_tooltip" => LOC,
        _ => &[],
    }
}

// ---------------------------------------------------------------------------------------------
// Facts collected from one file.

#[derive(Clone, Debug)]
pub struct Reference {
    pub kind: Kind,
    pub name: String,
    pub start: u32,
    pub end: u32,
    pub context: Option<String>,
    /// The command or field the reference came from.
    pub via: String,
}

#[derive(Clone, Debug)]
pub struct CommandUse {
    pub ctx: Ctx,
    pub key: String,
    pub start: u32,
    pub end: u32,
    pub context: Option<String>,
    pub has_block: bool,
}

#[derive(Clone, Debug, Default)]
pub struct CommandCounts {
    pub documented: usize,
    pub control: usize,
    pub scope: usize,
    /// Dynamic keys (`$PARAM$`, `@x`) and comparisons of variables. Counted as unknown.
    pub unknown: usize,
}

#[derive(Clone, Debug)]
pub struct EventFacts {
    pub id: Option<String>,
    pub start: u32,
    pub triggered_only: bool,
    pub mtth: Option<u32>,
    /// `(key, role, offset, option_has_trigger)` for title, desc and option names.
    pub loc_keys: Vec<(String, &'static str, u32, bool)>,
}

#[derive(Clone, Debug)]
pub struct FocusFacts {
    pub id: String,
    pub start: u32,
    pub exclusive: Vec<(String, u32)>,
}

#[derive(Clone, Debug)]
pub struct ModifierUse {
    pub key: String,
    pub start: u32,
    pub end: u32,
    pub context: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct FileFacts {
    pub modelled: bool,
    pub definitions: Vec<Definition>,
    pub references: Vec<Reference>,
    pub commands: Vec<CommandUse>,
    /// Commands resolved or left unknown without the index: `[effects, triggers]`.
    pub counts: [CommandCounts; 2],
    pub events: Vec<EventFacts>,
    pub focuses: Vec<FocusFacts>,
    pub modifiers: Vec<ModifierUse>,
    /// `(on_action, hook value)` pairs: `events:<id>`, `random_events:<id>` or `effect:<n>`.
    pub hooks: Vec<(String, String, u32)>,
}

pub struct Walker<'a> {
    doc: &'a Document,
    vocab: &'a Vocabulary,
    /// When false, only definitions-level facts are kept (other layers).
    pub collect_references: bool,
    pub facts: FileFacts,
    context: Option<String>,
    event: Option<EventFacts>,
    focus: Option<FocusFacts>,
}

impl<'a> Walker<'a> {
    pub fn new(doc: &'a Document, vocab: &'a Vocabulary, collect_references: bool) -> Self {
        Walker { doc, vocab, collect_references, facts: FileFacts::default(), context: None, event: None, focus: None }
    }

    pub fn walk_file(&mut self, slot: Slot) {
        self.facts.modelled = true;
        let root = &self.doc.root;
        self.walk_block(root, slot, None);
    }

    fn text(&self, token: u32) -> String {
        self.doc.text(token).into_owned()
    }

    fn reference(&mut self, kind: Kind, token: u32, via: &str) {
        if !self.collect_references {
            return;
        }
        let t = self.doc.token(token);
        self.facts.references.push(Reference { kind, name: self.text(token), start: t.start, end: t.end, context: self.context.clone(), via: via.to_string() });
    }

    fn walk_block(&mut self, block: &Block, slot: Slot, owner: Option<&Entry>) {
        match slot {
            Slot::Effect => self.walk_commands(block, Ctx::Effect),
            Slot::Trigger => self.walk_commands(block, Ctx::Trigger),
            Slot::Command(ctx) => self.walk_commands(block, ctx),
            Slot::Weight => self.walk_block(block, Slot::Schema(&WEIGHT), owner),
            Slot::Modifiers => {
                if self.collect_references {
                    for entry in block.entries() {
                        let key = self.doc.key(entry);
                        // `custom_modifier_tooltip` adds a tooltip line; `hidden_modifier` holds
                        // modifiers left out of the tooltip.
                        if key.eq_ignore_ascii_case("custom_modifier_tooltip") {
                            continue;
                        }
                        if key.eq_ignore_ascii_case("hidden_modifier") {
                            if let Some(inner) = entry.value.as_block() {
                                self.walk_block(inner, Slot::Modifiers, Some(entry));
                            }
                            continue;
                        }
                        let t = self.doc.token(entry.key);
                        self.facts.modifiers.push(ModifierUse { key: self.text(entry.key), start: t.start, end: t.end, context: self.context.clone() });
                    }
                }
            }
            Slot::Skip | Slot::Sprite => {}
            Slot::Ref(kind) => {
                for item in &block.items {
                    if let Item::Value(Value::Scalar(t)) = item {
                        self.reference(kind, *t, "list");
                    }
                }
            }
            Slot::LocText => self.walk_block(block, Slot::Schema(&LOC_TEXT), owner),
            Slot::Schema(schema) => self.walk_schema(block, schema, owner),
        }
    }

    fn field_slot(schema: &Schema, key: &str) -> Slot {
        schema.fields.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map_or(schema.other, |(_, s)| *s)
    }

    fn walk_schema(&mut self, block: &Block, schema: &'static Schema, owner: Option<&Entry>) {
        let saved_context = self.context.clone();
        match schema.role {
            Role::Event => self.begin_event(block),
            Role::Focus => self.begin_focus(block),
            Role::Decision | Role::Idea => {
                if let Some(owner) = owner {
                    let prefix = if schema.role == Role::Decision { "decision" } else { "idea" };
                    self.context = Some(format!("{prefix}:{}", self.doc.key(owner)));
                }
            }
            Role::OnAction => {
                if let Some(owner) = owner {
                    self.context = Some(format!("on_action:{}", self.doc.key(owner)));
                }
            }
            Role::EventOption => {
                let has_trigger = block.entries().any(|e| self.doc.key(e) == "trigger");
                for entry in block.entries() {
                    if self.doc.key(entry) == "name"
                        && let Some(t) = entry.value.as_scalar()
                        && let Some(event) = self.event.as_mut()
                    {
                        event.loc_keys.push((self.doc.text(t).into_owned(), "option", self.doc.token(t).start, has_trigger));
                    }
                }
            }
            Role::RandomEvents | Role::Plain => {}
        }
        for item in &block.items {
            let Item::Entry(entry) = item else {
                if let (Item::Value(Value::Scalar(t)), Slot::Ref(kind)) = (item, schema.other) {
                    self.reference(kind, *t, "list");
                }
                continue;
            };
            let key = self.doc.key(entry);
            let slot = Self::field_slot(schema, &key);
            if let Some(prefix) = schema.entry_context {
                self.context = Some(format!("{prefix}:{key}"));
            }
            if schema.role == Role::OnAction {
                self.record_hooks(entry, &key);
            }
            if let Slot::Command(ctx) = slot {
                self.command(entry, ctx);
                continue;
            }
            match (&entry.value, slot) {
                (Value::Scalar(t), Slot::Ref(kind)) => {
                    let value = self.doc.text(*t);
                    // `random_events = { 100 = my.1 0 = 0 }`: a zero weight placeholder is not a reference.
                    if !(schema.role == Role::RandomEvents && value == "0") {
                        self.reference(kind, *t, &key);
                    }
                }
                (Value::Scalar(t), Slot::LocText) => {
                    self.loc_reference(*t, &key);
                }
                (Value::Scalar(t), Slot::Sprite) => self.reference(Kind::Sprite, *t, &key),
                (Value::Scalar(_) | Value::Missing, _) => {}
                (value, slot) => {
                    if let Some(inner) = value.as_block() {
                        self.walk_block(inner, slot, Some(entry));
                    }
                }
            }
        }
        match schema.role {
            Role::Event => {
                if let Some(event) = self.event.take() {
                    self.facts.events.push(event);
                }
            }
            Role::Focus => {
                if let Some(focus) = self.focus.take() {
                    self.facts.focuses.push(focus);
                }
            }
            _ => {}
        }
        self.context = saved_context;
    }

    fn loc_reference(&mut self, token: u32, via: &str) {
        let text = self.doc.text(token);
        // Literal text with spaces or formatting is not a key; `key|arg` passes an argument.
        if text.is_empty()
            || text.contains(' ')
            || text.contains('|')
            || is_dynamic(&text)
            || text.contains('\u{a7}')
            || text.bytes().all(|b| b.is_ascii_digit())
        {
            return;
        }
        // Scripted localisation may return a sprite name for an icon.
        if text.starts_with("GFX_") {
            self.reference(Kind::Sprite, token, via);
            return;
        }
        if let Some(event) = self.event.as_mut()
            && (via == "title" || via == "desc")
        {
            event.loc_keys.push((text.to_string(), if via == "title" { "title" } else { "desc" }, self.doc.token(token).start, false));
        }
        self.reference(Kind::LocalisationKey, token, via);
    }

    fn begin_event(&mut self, block: &Block) {
        let mut facts = EventFacts { id: None, start: self.doc.token(block.tokens.start).start, triggered_only: false, mtth: None, loc_keys: Vec::new() };
        for entry in block.entries() {
            match self.doc.key(entry).as_ref() {
                "id" => facts.id = entry.value.as_scalar().map(|t| self.text(t)),
                "is_triggered_only" => facts.triggered_only = entry.value.as_scalar().is_some_and(|t| self.doc.text(t) == "yes"),
                "mean_time_to_happen" => facts.mtth = Some(self.doc.token(entry.key).start),
                _ => {}
            }
        }
        self.context = facts.id.as_ref().map(|id| format!("event:{id}"));
        self.event = Some(facts);
    }

    fn begin_focus(&mut self, block: &Block) {
        let mut id = None;
        let mut exclusive = Vec::new();
        for entry in block.entries() {
            match self.doc.key(entry).as_ref() {
                "id" => id = entry.value.as_scalar().map(|t| self.text(t)),
                "mutually_exclusive" => {
                    if let Some(inner) = entry.value.as_block() {
                        for e in inner.entries() {
                            if self.doc.key(e) == "focus"
                                && let Some(t) = e.value.as_scalar()
                            {
                                exclusive.push((self.text(t), self.doc.token(t).start));
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        if let Some(id) = id {
            self.context = Some(format!("focus:{id}"));
            self.focus = Some(FocusFacts { id, start: self.doc.token(block.tokens.start).start, exclusive });
        }
    }

    fn record_hooks(&mut self, entry: &Entry, key: &str) {
        let Some(inner) = entry.value.as_block() else { return };
        let on_action = self.context.as_deref().and_then(|c| c.strip_prefix("on_action:")).unwrap_or_default().to_string();
        let at = self.doc.token(entry.key).start;
        match key {
            "events" => {
                for item in &inner.items {
                    if let Item::Value(Value::Scalar(t)) = item {
                        self.facts.hooks.push((on_action.clone(), format!("events:{}", self.doc.text(*t)), at));
                    }
                }
            }
            "random_events" => {
                for e in inner.entries() {
                    if let Some(t) = e.value.as_scalar() {
                        let id = self.doc.text(t);
                        if id != "0" {
                            self.facts.hooks.push((on_action.clone(), format!("random_events:{id}"), at));
                        }
                    }
                }
            }
            "effect" => {
                // An effect hook is identified by its text without whitespace and comments.
                let mut text = String::new();
                for i in inner.tokens.clone() {
                    let t = self.doc.token(i);
                    if !t.is_trivia() {
                        text.push_str(&self.doc.text(i));
                        text.push(' ');
                    }
                }
                self.facts.hooks.push((on_action.clone(), format!("effect:{}", short_hash(&text)), at));
            }
            _ => {}
        }
    }

    fn walk_commands(&mut self, block: &Block, ctx: Ctx) {
        for entry in block.entries() {
            self.command(entry, ctx);
        }
    }

    fn command(&mut self, entry: &Entry, ctx: Ctx) {
        let key = self.doc.key(entry).into_owned();
        let op = self.doc.operator(entry);
        let inner = entry.value.as_block();
        let control = match ctx {
            Ctx::Effect => effect_control(&key),
            Ctx::Trigger => trigger_control(&key),
        };
        if let Some(slot) = control {
            self.facts.counts[ctx as usize].control += 1;
            if let Some(inner) = inner {
                self.walk_block(inner, slot, Some(entry));
            }
            return;
        }
        if is_scope_chain(&key) || key.contains(':') {
            self.facts.counts[ctx as usize].scope += 1;
            if let Some(inner) = inner {
                self.walk_commands(inner, ctx);
            }
            return;
        }
        if is_dynamic(&key) {
            self.facts.counts[ctx as usize].unknown += 1;
            if let Some(inner) = inner {
                self.walk_commands(inner, ctx);
            }
            return;
        }
        // The game matches command names without regard to case (`IF`, `OWNER`, `TAG` work).
        let lower = key.to_ascii_lowercase();
        let documented = match ctx {
            Ctx::Effect => self.vocab.effects.get(&lower),
            Ctx::Trigger => self.vocab.triggers.get(&lower),
        };
        if let Some(command) = documented {
            self.facts.counts[ctx as usize].documented += 1;
            if command.iterates
                && let Some(inner) = inner
            {
                let slot = match ctx {
                    Ctx::Effect => Slot::Schema(&ITER_EFFECT),
                    Ctx::Trigger => Slot::Schema(&ITER_TRIGGER),
                };
                self.walk_block(inner, slot, Some(entry));
                return;
            }
            self.argument_references(entry, &lower);
            return;
        }
        if op.is_some_and(|o| !o.is_assignment()) && op != Some(Operator::EqEq) {
            // `my_variable > 3` compares a variable; its name cannot be checked statically.
            self.facts.counts[ctx as usize].unknown += 1;
            return;
        }
        if !self.collect_references {
            return;
        }
        let t = self.doc.token(entry.key);
        self.facts.commands.push(CommandUse { ctx, key, start: t.start, end: t.end, context: self.context.clone(), has_block: inner.is_some() });
        // Country tags, state ids and characters used as scopes: the analysis resolves the key
        // against the index and, when it is a scope, the block holds commands of the same kind.
        if let Some(inner) = inner
            && (is_tag_shaped(&self.doc.key(entry)) || self.doc.key(entry).bytes().all(|b| b.is_ascii_digit()))
        {
            self.walk_commands(inner, ctx);
        }
    }

    fn argument_references(&mut self, entry: &Entry, command: &str) {
        let rules = arg_rules(command);
        if rules.is_empty() {
            return;
        }
        match &entry.value {
            Value::Scalar(t) => {
                if rules.iter().any(|(arg, _)| arg.is_empty()) {
                    let kind = rules.iter().find(|(arg, _)| arg.is_empty()).map(|(_, k)| *k);
                    if let Some(kind) = kind {
                        if kind == Kind::LocalisationKey {
                            self.loc_reference(*t, command);
                        } else {
                            self.reference(kind, *t, command);
                        }
                    }
                }
            }
            value => {
                let Some(block) = value.as_block() else { return };
                for item in &block.items {
                    match item {
                        Item::Value(Value::Scalar(t)) => {
                            if let Some((_, kind)) = rules.iter().find(|(arg, _)| *arg == "*") {
                                self.reference(*kind, *t, command);
                            }
                        }
                        Item::Entry(e) => {
                            let arg = self.doc.key(e);
                            if let Some((_, kind)) = rules.iter().find(|(a, _)| !a.is_empty() && *a == arg)
                                && let Some(t) = e.value.as_scalar()
                            {
                                self.reference(*kind, t, command);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

pub fn short_hash(text: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(text.as_bytes()).iter().take(6).map(|b| format!("{b:02x}")).collect()
}
