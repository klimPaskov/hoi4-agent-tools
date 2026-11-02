//! Content to sprite trace: which sprite each piece of script content shows, under which
//! implicit prefixing rule, and which asset family the sprite belongs to.
//!
//! The rules are written down in [`RULES`]; every one was checked against the files of Hearts of
//! Iron IV 1.19.4.1 before it was encoded. `engine/README.md` lists each rule with a vanilla
//! example. A family is where a texture is consumed (its size and frame layout), so one sprite
//! used by two families is a likely mistake (see [`crate::sprite_audit`]).
//!
//! Only files of the checked layer are traced by default (the mod, or the game when no mod is
//! given). [`TraceOptions::all_layers`] traces every loaded file.

use std::collections::HashSet;
use std::fs;

use hoi4_syntax::{Block, Document, Item, Value};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::imagehdr::TextureHeader;
use crate::sprites::{ResolvedTexture, SpriteIndex};
use crate::workspace::Workspace;

macro_rules! families {
    ($($variant:ident => $name:literal),+ $(,)?) => {
        /// The asset family a sprite is consumed by. The serialised form is the id string.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        pub enum Family {
            $(#[serde(rename = $name)] $variant,)+
        }

        impl Family {
            /// Every family, in the order of the family list.
            pub const ALL: &'static [Family] = &[$(Family::$variant),+];

            /// The id string (`focus`, `idea_spirit`, ...).
            pub fn as_str(self) -> &'static str {
                match self { $(Family::$variant => $name,)+ }
            }

            /// Parses an id string.
            pub fn parse(text: &str) -> Option<Family> {
                match text { $($name => Some(Family::$variant),)+ _ => None }
            }
        }
    };
}

families! {
    Focus => "focus",
    IdeaSpirit => "idea_spirit",
    IdeaConcern => "idea_concern",
    OfficerCorpsSpirit => "officer_corps_spirit",
    Decision => "decision",
    DecisionCategoryIcon => "decision_category_icon",
    StateModifier => "state_modifier",
    SpecialProjectIcon => "special_project_icon",
    Raid => "raid",
    MioDepartment => "mio_department",
    MioTrait => "mio_trait",
    MioPolicy => "mio_policy",
    BopSide => "bop_side",
    Medal => "medal",
    AgencyUpgrade => "agency_upgrade",
    OperationIcon => "operation_icon",
    CommanderTrait => "commander_trait",
    PersonalTrait => "personal_trait",
    Doctrine => "doctrine",
    ReportEvent => "report_event",
    NewsEvent => "news_event",
    DecisionCategoryPicture => "decision_category_picture",
    OperationPicture => "operation_picture",
    Technology => "technology",
    Achievement => "achievement",
    LeaderPortrait => "leader_portrait",
    CommanderPortrait => "commander_portrait",
    OperativePortrait => "operative_portrait",
    ScientistPortrait => "scientist_portrait",
    AdvisorCard => "advisor_card",
    Flag => "flag",
    CounterLarge => "counter_large",
    CounterSmall => "counter_small",
    DivisionEmblem => "division_emblem",
    Building => "building",
    FactionLogo => "faction_logo",
    AgencyLogo => "agency_logo",
    ModifierStatIcon => "modifier_stat_icon",
    GuiTexture => "gui_texture",
    SuperEvent => "super_event",
    Unknown => "unknown",
}

/// One content key the trace reads: where it is, how its value becomes a sprite name, and the
/// family. `docs` is the rule as `engine/README.md` states it.
pub struct Rule {
    pub content_type: &'static str,
    pub family: &'static str,
    pub prefix: &'static str,
    pub docs: &'static str,
}

/// The rules, for documentation and for `hoi4-engine sprites --rules`.
pub const RULES: &[Rule] = &[
    Rule {
        content_type: "focus.icon",
        family: "focus",
        prefix: "none (explicit GFX_ name; conditional blocks list every name)",
        docs: "common/national_focus: focus `icon`",
    },
    Rule { content_type: "continuous_focus.icon", family: "focus", prefix: "none", docs: "common/continuous_focus: `icon`" },
    Rule {
        content_type: "idea.picture",
        family: "idea_spirit | idea_concern | officer_corps_spirit | advisor_card",
        prefix: "GFX_idea_<x> unless GFX_; omitted picture falls back to GFX_idea_<idea key>",
        docs: "family from the idea's slot",
    },
    Rule {
        content_type: "character.portrait.<block>.large",
        family: "leader_portrait | commander_portrait | operative_portrait | scientist_portrait",
        prefix: "none; a texture path is allowed",
        docs: "civilian by role, army/navy commander",
    },
    Rule { content_type: "character.portrait.<block>.small", family: "advisor_card", prefix: "none; a texture path is allowed", docs: "any portraits block" },
    Rule {
        content_type: "character.advisor.idea_token",
        family: "advisor_card",
        prefix: "GFX_idea_<token>, only without a small portrait and when defined",
        docs: "advisor role idea_token",
    },
    Rule { content_type: "decision.icon", family: "decision", prefix: "GFX_decision_<x> unless GFX_", docs: "also missions (days_mission_timeout)" },
    Rule {
        content_type: "decision_category.icon",
        family: "decision_category_icon",
        prefix: "GFX_decision_category_<x> unless GFX_",
        docs: "common/decisions/categories",
    },
    Rule {
        content_type: "decision_category.picture",
        family: "decision_category_picture",
        prefix: "GFX_decision_cat_picture_<x>, then GFX_<x>; GFX_ as written",
        docs: "common/decisions/categories",
    },
    Rule { content_type: "dynamic_modifier.icon", family: "state_modifier", prefix: "none", docs: "common/dynamic_modifiers" },
    Rule { content_type: "mio.organization.icon", family: "mio_department", prefix: "none", docs: "organization root icon" },
    Rule {
        content_type: "mio.trait.icon",
        family: "mio_trait | mio_department",
        prefix: "none; a *mio_department* sprite name is a department",
        docs: "add_trait, override_trait, initial_trait, trait",
    },
    Rule { content_type: "mio.policy.icon", family: "mio_policy", prefix: "none", docs: "common/military_industrial_organization/policies" },
    Rule { content_type: "bop.side.icon", family: "bop_side", prefix: "none", docs: "side block icon" },
    Rule { content_type: "effect.set_power_balance_gfx", family: "bop_side", prefix: "none", docs: "effect gfx" },
    Rule { content_type: "effect.set_mio_icon", family: "mio_department", prefix: "none", docs: "effect value" },
    Rule { content_type: "effect.create_country_leader", family: "leader_portrait", prefix: "none; a texture path is allowed", docs: "picture" },
    Rule { content_type: "event.picture", family: "report_event | news_event", prefix: "none", docs: "news_event is news; every other event type is report" },
    Rule { content_type: "special_project.icon", family: "special_project_icon", prefix: "none", docs: "projects and prototype rewards" },
    Rule { content_type: "operation.icon / operation.map_icon", family: "operation_icon", prefix: "none", docs: "common/operations" },
    Rule { content_type: "operation_phase.picture", family: "operation_picture", prefix: "none", docs: "common/operation_phases" },
    Rule { content_type: "operation_phase.icon / operation_token.icon", family: "operation_icon", prefix: "none", docs: "phase and token icons" },
    Rule { content_type: "agency_upgrade.picture", family: "agency_upgrade", prefix: "none", docs: "common/intelligence_agency_upgrades" },
    Rule { content_type: "agency.picture", family: "agency_logo", prefix: "none", docs: "common/intelligence_agencies" },
    Rule { content_type: "raid.target_icon / raid.custom_map_icon", family: "raid", prefix: "none", docs: "common/raids" },
    Rule { content_type: "medal.icon", family: "medal", prefix: "none", docs: "common/unit_medals" },
    Rule { content_type: "faction.icon", family: "faction_logo", prefix: "none", docs: "common/factions" },
    Rule { content_type: "doctrine.icon", family: "doctrine", prefix: "none", docs: "common/doctrines" },
    Rule {
        content_type: "technology.icon / technology.key",
        family: "technology",
        prefix: "technology key: GFX_<key>_medium when defined",
        docs: "common/technologies",
    },
    Rule { content_type: "scientist_trait.icon", family: "personal_trait", prefix: "none", docs: "common/scientist_traits" },
    Rule { content_type: "technology_sharing.picture / occupation_law.icon / ability.icon", family: "unknown", prefix: "none", docs: "slot not classified" },
];

/// What the trace reads out of the files.
#[derive(Clone, Copy, Debug, Default)]
pub struct TraceOptions {
    /// Trace every loaded file instead of the checked layer's files.
    pub all_layers: bool,
}

/// The resolved texture of a use, flattened.
#[derive(Clone, Debug, Serialize)]
pub struct TextureRef {
    /// The `texturefile` of the sprite (or the path a script names), forward slashes.
    pub path: String,
    pub exists: bool,
    pub layer: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub pixel_format: Option<String>,
}

impl TextureRef {
    fn from_resolved(path: &str, t: &ResolvedTexture) -> TextureRef {
        let header: Option<&TextureHeader> = t.header.as_ref();
        TextureRef {
            path: path.to_string(),
            exists: t.exists,
            layer: t.layer.clone(),
            width: header.map(|h| h.width),
            height: header.map(|h| h.height),
            pixel_format: header.map(|h| h.pixel_format.clone()),
        }
    }
}

/// One place where script content names a sprite.
#[derive(Clone, Debug, Serialize)]
pub struct SpriteUse {
    /// The sprite the game shows: the first candidate name that is defined, else the first
    /// candidate. Empty for a texture path.
    pub sprite: String,
    /// The value as written in the file.
    pub written: String,
    /// True when the sprite name is defined in a loaded `.gfx` file.
    pub defined: bool,
    /// The value is a texture path, not a sprite name.
    pub direct_texture: bool,
    /// The value is built at run time (`[...]`, `$...$`), so it cannot be resolved.
    pub dynamic: bool,
    /// The use comes from a fallback name (`GFX_idea_<idea key>`), not from a written value.
    pub implicit: bool,
    pub texture: Option<TextureRef>,
    /// Rule id such as `focus.icon` (see [`RULES`]).
    pub content_type: String,
    /// The key as written, with its parents (`news_event.picture`).
    pub slot: String,
    pub family: Family,
    /// The enclosing definition, such as `focus:GER_rearm`.
    pub subject: Option<String>,
    /// Name of the layer that holds the file.
    pub layer: String,
    /// Path relative to the layer root.
    pub path: String,
    #[serde(skip)]
    pub file: usize,
    pub line: u32,
    pub column: u32,
    pub start: u32,
    pub end: u32,
}

struct RawUse {
    written: String,
    candidates: Vec<String>,
    direct_texture: bool,
    dynamic: bool,
    implicit: bool,
    content_type: String,
    slot: String,
    family: Family,
    subject: Option<String>,
    line: u32,
    column: u32,
    start: u32,
    end: u32,
}

/// Idea slots by role, from the loaded `common/idea_tags` files and the game's own names.
#[derive(Clone, Debug, Default)]
pub struct IdeaSlots {
    advisor: HashSet<String>,
    officer: HashSet<String>,
}

impl IdeaSlots {
    fn with_defaults() -> IdeaSlots {
        let strings = |list: &[&str]| list.iter().map(|s| (*s).to_string()).collect();
        IdeaSlots {
            advisor: strings(&["political_advisor", "theorist", "army_chief", "navy_chief", "air_chief", "high_command"]),
            officer: strings(&[
                "academy_spirit",
                "army_spirit",
                "division_command_spirit",
                "naval_academy_spirit",
                "navy_spirit",
                "naval_command_spirit",
                "air_force_academy_spirit",
                "air_force_spirit",
                "air_force_command_spirit",
            ]),
        }
    }

    fn learn(&mut self, doc: &Document) {
        for categories in doc.root.entries().filter(|e| doc.key(e) == "idea_categories") {
            for category in categories.value.as_block().into_iter().flat_map(|b| b.entries()) {
                let Some(block) = category.value.as_block() else { continue };
                let kind = block.entries().find(|e| doc.key(e) == "type").and_then(|e| e.value.as_scalar()).map(|t| doc.text(t).into_owned());
                let officer = matches!(kind.as_deref(), Some("army_spirit" | "navy_spirit" | "air_spirit"));
                for entry in block.entries() {
                    let Some(token) = entry.value.as_scalar() else { continue };
                    match doc.key(entry).as_ref() {
                        "character_slot" => {
                            self.advisor.insert(doc.text(token).into_owned());
                        }
                        "slot" if officer => {
                            self.officer.insert(doc.text(token).into_owned());
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    /// The family of an idea declared under this slot (or category) name.
    pub fn family_of(&self, slot: &str) -> Family {
        if self.advisor.contains(slot) {
            Family::AdvisorCard
        } else if self.officer.contains(slot) {
            Family::OfficerCorpsSpirit
        } else if slot == "industrial_concern" || slot.ends_with("_manufacturer") {
            Family::IdeaConcern
        } else {
            Family::IdeaSpirit
        }
    }
}

#[derive(Clone, Copy)]
enum Prefix {
    None,
    /// Prepend unless the value already starts with `GFX_`.
    Add(&'static str),
    /// Decision category pictures: `GFX_decision_cat_picture_<x>`, then `GFX_<x>`.
    CategoryPicture,
}

struct Spec<'s> {
    family: Family,
    content_type: &'s str,
    slot: String,
    subject: Option<String>,
    prefix: Prefix,
}

struct Tracer<'a> {
    doc: &'a Document,
    out: Vec<RawUse>,
}

fn is_gfx(text: &str) -> bool {
    text.len() >= 4 && text[..4].eq_ignore_ascii_case("GFX_")
}

fn looks_like_texture(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains('/') || lower.contains('\\') || lower.ends_with(".dds") || lower.ends_with(".tga") || lower.ends_with(".png")
}

impl<'a> Tracer<'a> {
    fn scalar(&self, block: &Block, key: &str) -> Option<String> {
        block.entries().find(|e| self.doc.key(e) == key).and_then(|e| e.value.as_scalar()).map(|t| self.doc.text(t).into_owned())
    }

    /// Sprite name tokens of a value: a scalar, or the names in a conditional block (written as
    /// `GFX_x = { trigger }` or `value = GFX_x` or `picture = GFX_x`).
    fn name_tokens(&self, value: &Value) -> Vec<u32> {
        match value {
            Value::Scalar(t) => vec![*t],
            Value::Block(block) | Value::Tagged { block, .. } => {
                let mut tokens = Vec::new();
                for item in &block.items {
                    match item {
                        Item::Entry(e) => {
                            let key = self.doc.key(e);
                            if is_gfx(&key) {
                                tokens.push(e.key);
                            } else if matches!(key.to_ascii_lowercase().as_str(), "value" | "gfx" | "icon" | "picture" | "sprite")
                                && let Some(t) = e.value.as_scalar()
                            {
                                tokens.push(t);
                            }
                        }
                        Item::Value(Value::Scalar(t)) if is_gfx(&self.doc.text(*t)) => tokens.push(*t),
                        _ => {}
                    }
                }
                tokens
            }
            Value::Missing => Vec::new(),
        }
    }

    fn emit_token(&mut self, token: u32, spec: &Spec<'_>) {
        let written = self.doc.text(token).trim().to_string();
        if written.is_empty() {
            return;
        }
        let dynamic = written.contains('[') || written.contains('$') || written.contains('@');
        let direct_texture = !dynamic && !is_gfx(&written) && looks_like_texture(&written);
        let candidates = if dynamic || direct_texture {
            Vec::new()
        } else if is_gfx(&written) {
            vec![written.clone()]
        } else {
            match spec.prefix {
                Prefix::None => vec![written.clone()],
                Prefix::Add(p) => vec![format!("{p}{written}")],
                Prefix::CategoryPicture => vec![format!("GFX_decision_cat_picture_{written}"), format!("GFX_{written}")],
            }
        };
        let start = self.doc.token(token).start;
        let end = self.doc.token(token).end;
        self.out.push(RawUse {
            written,
            candidates,
            direct_texture,
            dynamic,
            implicit: false,
            content_type: spec.content_type.to_string(),
            slot: spec.slot.clone(),
            family: spec.family,
            subject: spec.subject.clone(),
            line: self.doc.position(start).0,
            column: self.doc.position(start).1,
            start,
            end,
        });
    }

    fn emit_value(&mut self, value: &Value, spec: &Spec<'_>) {
        for token in self.name_tokens(value) {
            self.emit_token(token, spec);
        }
    }

    /// Emits every entry of `block` named `key`.
    fn emit_key(&mut self, block: &Block, key: &str, spec: &Spec<'_>) {
        for entry in block.entries().filter(|e| self.doc.key(e) == key) {
            self.emit_value(&entry.value, spec);
        }
    }

    fn emit_implicit(&mut self, anchor: u32, name: String, spec: &Spec<'_>) {
        let start = self.doc.token(anchor).start;
        let end = self.doc.token(anchor).end;
        self.out.push(RawUse {
            written: name.clone(),
            candidates: vec![name],
            direct_texture: false,
            dynamic: false,
            implicit: true,
            content_type: spec.content_type.to_string(),
            slot: spec.slot.clone(),
            family: spec.family,
            subject: spec.subject.clone(),
            line: self.doc.position(start).0,
            column: self.doc.position(start).1,
            start,
            end,
        });
    }

    fn spec<'s>(&self, family: Family, content_type: &'s str, slot: &str, subject: Option<String>, prefix: Prefix) -> Spec<'s> {
        Spec { family, content_type, slot: slot.to_string(), subject, prefix }
    }

    fn events(&mut self) {
        let doc = self.doc;
        for entry in doc.root.entries() {
            let key = doc.key(entry).into_owned();
            if !matches!(key.as_str(), "country_event" | "news_event" | "state_event" | "unit_leader_event" | "operative_leader_event") {
                continue;
            }
            let Some(block) = entry.value.as_block() else { continue };
            let id = self.scalar(block, "id");
            let family = if key == "news_event" { Family::NewsEvent } else { Family::ReportEvent };
            let spec = self.spec(family, "event.picture", &format!("{key}.picture"), id.map(|i| format!("event:{i}")), Prefix::None);
            self.emit_key(block, "picture", &spec);
        }
    }

    fn focuses(&mut self) {
        let doc = self.doc;
        let focus_block = |this: &mut Tracer<'a>, block: &Block| {
            let id = this.scalar(block, "id");
            let spec = this.spec(Family::Focus, "focus.icon", "focus.icon", id.map(|i| format!("focus:{i}")), Prefix::None);
            this.emit_key(block, "icon", &spec);
        };
        for entry in doc.root.entries() {
            let Some(block) = entry.value.as_block() else { continue };
            match doc.key(entry).as_ref() {
                "focus_tree" => {
                    for focus in block.entries().filter(|e| doc.key(e) == "focus") {
                        if let Some(b) = focus.value.as_block() {
                            focus_block(self, b);
                        }
                    }
                }
                "shared_focus" | "joint_focus" => focus_block(self, block),
                _ => {}
            }
        }
    }

    fn continuous_focuses(&mut self) {
        let doc = self.doc;
        for palette in doc.root.entries().filter_map(|e| e.value.as_block()) {
            for focus in palette.entries().filter(|e| doc.key(e) == "focus") {
                let Some(block) = focus.value.as_block() else { continue };
                let id = self.scalar(block, "id");
                let spec = self.spec(Family::Focus, "continuous_focus.icon", "continuous_focus.icon", id.map(|i| format!("focus:{i}")), Prefix::None);
                self.emit_key(block, "icon", &spec);
            }
        }
    }

    fn ideas(&mut self, slots: &IdeaSlots) {
        let doc = self.doc;
        for ideas in doc.root.entries().filter(|e| doc.key(e) == "ideas") {
            for category in ideas.value.as_block().into_iter().flat_map(|b| b.entries()) {
                let Some(block) = category.value.as_block() else { continue };
                let slot = doc.key(category).into_owned();
                let family = slots.family_of(&slot);
                for idea in block.entries() {
                    let Some(body) = idea.value.as_block() else { continue };
                    let name = doc.key(idea).into_owned();
                    let spec = self.spec(family, "idea.picture", &format!("{slot}.picture"), Some(format!("idea:{name}")), Prefix::Add("GFX_idea_"));
                    if body.entries().any(|e| doc.key(e) == "picture") {
                        self.emit_key(body, "picture", &spec);
                    } else {
                        self.emit_implicit(idea.key, format!("GFX_idea_{name}"), &spec);
                    }
                }
            }
        }
    }

    fn characters(&mut self) {
        let doc = self.doc;
        fn collect<'d>(doc: &'d Document, block: &'d Block, roles: &mut HashSet<String>, portraits: &mut Vec<&'d hoi4_syntax::Entry>, tokens: &mut Vec<u32>) {
            for entry in block.entries() {
                let key = doc.key(entry).into_owned();
                match key.as_str() {
                    "country_leader" | "corps_commander" | "field_marshal" | "navy_leader" | "operative" | "scientist" => {
                        roles.insert(key);
                    }
                    "advisor" => {
                        roles.insert(key);
                        if let Some(b) = entry.value.as_block() {
                            tokens.extend(b.entries().filter(|e| doc.key(e) == "idea_token").filter_map(|e| e.value.as_scalar()));
                        }
                    }
                    "portraits" => portraits.push(entry),
                    "instance" => {
                        if let Some(b) = entry.value.as_block() {
                            collect(doc, b, roles, portraits, tokens);
                        }
                    }
                    _ => {}
                }
            }
        }
        for characters in doc.root.entries().filter(|e| doc.key(e) == "characters") {
            for character in characters.value.as_block().into_iter().flat_map(|b| b.entries()) {
                let Some(block) = character.value.as_block() else { continue };
                let id = doc.key(character).into_owned();
                let mut roles = HashSet::new();
                let mut portraits = Vec::new();
                let mut tokens = Vec::new();
                collect(doc, block, &mut roles, &mut portraits, &mut tokens);
                let civilian_family = if roles.contains("country_leader") {
                    Family::LeaderPortrait
                } else if roles.contains("operative") {
                    Family::OperativePortrait
                } else if roles.contains("scientist") {
                    Family::ScientistPortrait
                } else {
                    Family::LeaderPortrait
                };
                let mut has_small = false;
                for portrait in portraits {
                    for group in portrait.value.as_block().into_iter().flat_map(|b| b.entries()) {
                        let Some(inner) = group.value.as_block() else { continue };
                        let group_key = doc.key(group).into_owned();
                        for (part, is_small) in [("large", false), ("small", true)] {
                            if !inner.entries().any(|e| doc.key(e) == part) {
                                continue;
                            }
                            has_small |= is_small;
                            let family = if is_small {
                                Family::AdvisorCard
                            } else {
                                match group_key.as_str() {
                                    "civilian" => civilian_family,
                                    "army" | "navy" | "air" => Family::CommanderPortrait,
                                    _ => Family::Unknown,
                                }
                            };
                            let content = format!("character.portrait.{group_key}.{part}");
                            let spec = self.spec(family, &content, &format!("portraits.{group_key}.{part}"), Some(format!("character:{id}")), Prefix::None);
                            self.emit_key(inner, part, &spec);
                        }
                    }
                }
                if !has_small {
                    for token in tokens {
                        let name = format!("GFX_idea_{}", doc.text(token));
                        let spec =
                            self.spec(Family::AdvisorCard, "character.advisor.idea_token", "advisor.idea_token", Some(format!("character:{id}")), Prefix::None);
                        self.emit_implicit(token, name, &spec);
                    }
                }
            }
        }
    }

    fn decisions(&mut self, categories: bool) {
        let doc = self.doc;
        for entry in doc.root.entries() {
            let Some(block) = entry.value.as_block() else { continue };
            let key = doc.key(entry).into_owned();
            if categories {
                let spec = self.spec(
                    Family::DecisionCategoryIcon,
                    "decision_category.icon",
                    "icon",
                    Some(format!("decision_category:{key}")),
                    Prefix::Add("GFX_decision_category_"),
                );
                self.emit_key(block, "icon", &spec);
                let spec = self.spec(
                    Family::DecisionCategoryPicture,
                    "decision_category.picture",
                    "picture",
                    Some(format!("decision_category:{key}")),
                    Prefix::CategoryPicture,
                );
                self.emit_key(block, "picture", &spec);
            } else {
                for decision in block.entries() {
                    let Some(body) = decision.value.as_block() else { continue };
                    let name = doc.key(decision).into_owned();
                    let mission = body.entries().any(|e| doc.key(e) == "days_mission_timeout");
                    let content = if mission { "decision.mission.icon" } else { "decision.icon" };
                    let spec = self.spec(Family::Decision, content, "icon", Some(format!("decision:{name}")), Prefix::Add("GFX_decision_"));
                    self.emit_key(body, "icon", &spec);
                }
            }
        }
    }

    fn dynamic_modifiers(&mut self) {
        let doc = self.doc;
        for entry in doc.root.entries() {
            let Some(block) = entry.value.as_block() else { continue };
            let spec = self.spec(Family::StateModifier, "dynamic_modifier.icon", "icon", Some(format!("dynamic_modifier:{}", doc.key(entry))), Prefix::None);
            self.emit_key(block, "icon", &spec);
        }
    }

    fn mio_organizations(&mut self) {
        let doc = self.doc;
        for entry in doc.root.entries() {
            let Some(block) = entry.value.as_block() else { continue };
            let subject = Some(format!("mio:{}", doc.key(entry)));
            let spec = self.spec(Family::MioDepartment, "mio.organization.icon", "icon", subject.clone(), Prefix::None);
            self.emit_key(block, "icon", &spec);
            for trait_entry in block.entries() {
                if !matches!(doc.key(trait_entry).as_ref(), "add_trait" | "override_trait" | "initial_trait" | "trait") {
                    continue;
                }
                let Some(body) = trait_entry.value.as_block() else { continue };
                for icon in body.entries().filter(|e| doc.key(e) == "icon") {
                    for token in self.name_tokens(&icon.value) {
                        let department = doc.text(token).to_ascii_lowercase().contains("mio_department");
                        let family = if department { Family::MioDepartment } else { Family::MioTrait };
                        let spec = self.spec(family, "mio.trait.icon", "trait.icon", subject.clone(), Prefix::None);
                        self.emit_token(token, &spec);
                    }
                }
            }
        }
    }

    fn mio_policies(&mut self) {
        let doc = self.doc;
        for entry in doc.root.entries() {
            let Some(block) = entry.value.as_block() else { continue };
            let spec = self.spec(Family::MioPolicy, "mio.policy.icon", "icon", Some(format!("mio_policy:{}", doc.key(entry))), Prefix::None);
            self.emit_key(block, "icon", &spec);
        }
    }

    fn bop(&mut self) {
        let doc = self.doc;
        for entry in doc.root.entries() {
            let Some(block) = entry.value.as_block() else { continue };
            for side in block.entries().filter(|e| doc.key(e) == "side") {
                let Some(body) = side.value.as_block() else { continue };
                let id = self.scalar(body, "id");
                let spec = self.spec(Family::BopSide, "bop.side.icon", "side.icon", id.map(|i| format!("bop_side:{i}")), Prefix::None);
                self.emit_key(body, "icon", &spec);
            }
        }
    }

    fn technologies(&mut self) {
        let doc = self.doc;
        for techs in doc.root.entries().filter(|e| doc.key(e) == "technologies") {
            for tech in techs.value.as_block().into_iter().flat_map(|b| b.entries()) {
                let Some(body) = tech.value.as_block() else { continue };
                let key = doc.key(tech).into_owned();
                let subject = Some(format!("technology:{key}"));
                if body.entries().any(|e| doc.key(e) == "icon") {
                    let spec = self.spec(Family::Technology, "technology.icon", "icon", subject, Prefix::None);
                    self.emit_key(body, "icon", &spec);
                } else {
                    let spec = self.spec(Family::Technology, "technology.key", "key", subject, Prefix::None);
                    self.emit_implicit(tech.key, format!("GFX_{key}_medium"), &spec);
                }
            }
        }
    }

    /// Rules that read a key at any depth of a folder's files.
    fn deep(&mut self, keys: &[(&str, Family, &str)]) {
        fn walk(this: &mut Tracer<'_>, block: &Block, top: &str, keys: &[(&str, Family, &str)]) {
            let doc = this.doc;
            for entry in block.entries() {
                let key = doc.key(entry);
                let top_key = if top.is_empty() { key.to_string() } else { top.to_string() };
                if let Some((name, family, content)) = keys.iter().find(|(k, _, _)| *k == key) {
                    let slot = (*name).to_string();
                    let spec = Spec { family: *family, content_type: content, slot, subject: Some(top_key.clone()), prefix: Prefix::None };
                    this.emit_value(&entry.value, &spec);
                }
                if let Some(inner) = entry.value.as_block() {
                    walk(this, inner, &top_key, keys);
                }
            }
        }
        let root = &self.doc.root;
        walk(self, root, "", keys);
    }

    /// Effects that set a sprite or portrait, wherever they appear.
    fn effects(&mut self) {
        fn walk(this: &mut Tracer<'_>, block: &Block) {
            let doc = this.doc;
            for entry in block.entries() {
                let key = doc.key(entry).into_owned();
                match key.as_str() {
                    "set_power_balance_gfx" => {
                        if let Some(b) = entry.value.as_block() {
                            let spec = this.spec(Family::BopSide, "effect.set_power_balance_gfx", "set_power_balance_gfx.gfx", None, Prefix::None);
                            this.emit_key(b, "gfx", &spec);
                        }
                    }
                    "set_mio_icon" => {
                        if entry.value.as_scalar().is_some() {
                            let spec = this.spec(Family::MioDepartment, "effect.set_mio_icon", "set_mio_icon", None, Prefix::None);
                            this.emit_value(&entry.value, &spec);
                        }
                    }
                    "create_country_leader" => {
                        if let Some(b) = entry.value.as_block() {
                            let spec = this.spec(Family::LeaderPortrait, "effect.create_country_leader", "create_country_leader.picture", None, Prefix::None);
                            this.emit_key(b, "picture", &spec);
                        }
                    }
                    "create_corps_commander" | "create_field_marshal" | "create_navy_leader" => {
                        if let Some(b) = entry.value.as_block() {
                            let content = format!("effect.{key}");
                            let spec = this.spec(Family::CommanderPortrait, &content, &format!("{key}.portrait_path"), None, Prefix::None);
                            this.emit_key(b, "portrait_path", &spec);
                        }
                    }
                    _ => {}
                }
                if let Some(inner) = entry.value.as_block() {
                    walk(this, inner);
                }
            }
        }
        let root = &self.doc.root;
        walk(self, root);
    }
}

/// A key to read at any depth: key, family, content type.
type DeepKey = (&'static str, Family, &'static str);

const DEEP_RULES: &[(&str, &[DeepKey])] = &[
    ("common/special_projects/", &[("icon", Family::SpecialProjectIcon, "special_project.icon")]),
    ("common/operations/", &[("icon", Family::OperationIcon, "operation.icon"), ("map_icon", Family::OperationIcon, "operation.map_icon")]),
    ("common/operation_phases/", &[("picture", Family::OperationPicture, "operation_phase.picture"), ("icon", Family::OperationIcon, "operation_phase.icon")]),
    ("common/operation_tokens/", &[("icon", Family::OperationIcon, "operation_token.icon")]),
    ("common/intelligence_agency_upgrades/", &[("picture", Family::AgencyUpgrade, "agency_upgrade.picture")]),
    ("common/intelligence_agencies/", &[("picture", Family::AgencyLogo, "agency.picture")]),
    ("common/raids/", &[("target_icon", Family::Raid, "raid.target_icon"), ("custom_map_icon", Family::Raid, "raid.custom_map_icon")]),
    ("common/unit_medals/", &[("icon", Family::Medal, "medal.icon")]),
    ("common/factions/", &[("icon", Family::FactionLogo, "faction.icon")]),
    ("common/doctrines/", &[("icon", Family::Doctrine, "doctrine.icon")]),
    ("common/scientist_traits/", &[("icon", Family::PersonalTrait, "scientist_trait.icon")]),
    ("common/technology_sharing/", &[("picture", Family::Unknown, "technology_sharing.picture")]),
    ("common/occupation_laws/", &[("icon", Family::Unknown, "occupation_law.icon")]),
    ("common/abilities/", &[("icon", Family::Unknown, "ability.icon")]),
];

/// Folders whose files are read for effects that set a sprite.
const EFFECT_FOLDERS: &[&str] = &[
    "events/",
    "common/national_focus/",
    "common/decisions/",
    "common/scripted_effects/",
    "common/on_actions/",
    "common/bop/",
    "common/ideas/",
    "common/operations/",
    "common/operation_phases/",
    "common/special_projects/",
    "common/military_industrial_organization/",
    "common/characters/",
];

fn trace_document(doc: &Document, key: &str, slots: &IdeaSlots) -> Vec<RawUse> {
    let mut tracer = Tracer { doc, out: Vec::new() };
    if key.starts_with("events/") {
        tracer.events();
    } else if key.starts_with("common/national_focus/") {
        tracer.focuses();
    } else if key.starts_with("common/continuous_focus/") {
        tracer.continuous_focuses();
    } else if key.starts_with("common/ideas/") {
        tracer.ideas(slots);
    } else if key.starts_with("common/characters/") {
        tracer.characters();
    } else if key.starts_with("common/decisions/categories/") {
        tracer.decisions(true);
    } else if key.starts_with("common/decisions/") {
        tracer.decisions(false);
    } else if key.starts_with("common/dynamic_modifiers/") {
        tracer.dynamic_modifiers();
    } else if key.starts_with("common/military_industrial_organization/organizations/") {
        tracer.mio_organizations();
    } else if key.starts_with("common/military_industrial_organization/policies/") {
        tracer.mio_policies();
    } else if key.starts_with("common/bop/") {
        tracer.bop();
    } else if key.starts_with("common/technologies/") {
        tracer.technologies();
    } else if let Some((_, keys)) = DEEP_RULES.iter().find(|(prefix, _)| key.starts_with(prefix)) {
        tracer.deep(keys);
    }
    if EFFECT_FOLDERS.iter().any(|p| key.starts_with(p)) {
        tracer.effects();
    }
    tracer.out
}

fn wants(key: &str) -> bool {
    key.ends_with(".txt")
        && (key.starts_with("events/")
            || key.starts_with("common/")
                && (EFFECT_FOLDERS.iter().any(|p| key.starts_with(p))
                    || key.starts_with("common/continuous_focus/")
                    || key.starts_with("common/dynamic_modifiers/")
                    || key.starts_with("common/technologies/")
                    || DEEP_RULES.iter().any(|(p, _)| key.starts_with(p))))
}

/// Traces every sprite use in the workspace's content files.
pub fn trace(ws: &Workspace, index: &SpriteIndex, options: &TraceOptions) -> Vec<SpriteUse> {
    let target = ws.target_layer();
    let mut slots = IdeaSlots::with_defaults();
    for (_, file) in ws.loaded_files().filter(|(_, f)| f.key().starts_with("common/idea_tags/") && f.key().ends_with(".txt")) {
        if let Ok(bytes) = fs::read(&file.absolute) {
            slots.learn(&Document::parse(bytes));
        }
    }
    let files: Vec<(usize, String)> =
        ws.loaded_files().filter(|(_, f)| (options.all_layers || Some(f.layer) == target) && wants(&f.key())).map(|(i, f)| (i, f.key())).collect();
    let raw: Vec<(usize, Vec<RawUse>)> = files
        .par_iter()
        .map(|(i, key)| {
            let uses = match fs::read(&ws.files[*i].absolute) {
                Ok(bytes) => trace_document(&Document::parse(bytes), key, &slots),
                Err(_) => Vec::new(),
            };
            (*i, uses)
        })
        .collect();
    let mut uses = Vec::new();
    for (file, list) in raw {
        let source = &ws.files[file];
        let layer = &ws.layers[source.layer].name;
        for r in list {
            if let Some(u) = finish(r, file, layer, &source.relative, index) {
                uses.push(u);
            }
        }
    }
    uses
}

fn finish(r: RawUse, file: usize, layer: &str, path: &str, index: &SpriteIndex) -> Option<SpriteUse> {
    let mut sprite = String::new();
    let mut defined = false;
    let mut texture = None;
    if r.direct_texture {
        texture = Some(TextureRef::from_resolved(&crate::sprites::normalize_texture_path(&r.written), &index.texture(&r.written)));
    } else if !r.dynamic {
        let found = r.candidates.iter().find_map(|c| index.get(c));
        match found {
            Some(def) => {
                sprite = def.name.clone();
                defined = true;
                texture = def.texturefile.as_ref().map(|path| match index.texture_of(def) {
                    Some(t) => TextureRef::from_resolved(path, t),
                    None => TextureRef { path: path.clone(), exists: false, layer: None, width: None, height: None, pixel_format: None },
                });
            }
            None => sprite = r.candidates.first().cloned().unwrap_or_default(),
        }
        if r.implicit && !defined {
            return None;
        }
    } else {
        sprite = r.written.clone();
    }
    Some(SpriteUse {
        sprite,
        written: r.written,
        defined,
        direct_texture: r.direct_texture,
        dynamic: r.dynamic,
        implicit: r.implicit,
        texture,
        content_type: r.content_type,
        slot: r.slot,
        family: r.family,
        subject: r.subject,
        layer: layer.to_string(),
        path: path.to_string(),
        file,
        line: r.line,
        column: r.column,
        start: r.start,
        end: r.end,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn family_ids_round_trip_and_are_unique() {
        let mut seen = HashSet::new();
        for f in Family::ALL {
            assert_eq!(Family::parse(f.as_str()), Some(*f));
            assert!(seen.insert(f.as_str()));
        }
        assert_eq!(Family::ALL.len(), 41);
        assert_eq!(serde_json::to_string(&Family::DecisionCategoryIcon).unwrap(), "\"decision_category_icon\"");
    }

    #[test]
    fn idea_slots_split_by_role() {
        let slots = IdeaSlots::with_defaults();
        assert_eq!(slots.family_of("country"), Family::IdeaSpirit);
        assert_eq!(slots.family_of("political_advisor"), Family::AdvisorCard);
        assert_eq!(slots.family_of("tank_manufacturer"), Family::IdeaConcern);
        assert_eq!(slots.family_of("industrial_concern"), Family::IdeaConcern);
        assert_eq!(slots.family_of("army_spirit"), Family::OfficerCorpsSpirit);
    }

    #[test]
    fn mod_idea_tags_extend_the_slots() {
        let doc = Document::parse(
            b"idea_categories = { my_cat = { type = army_spirit slot = my_officer_slot }\n other = { character_slot = my_advisor_slot } }".to_vec(),
        );
        let mut slots = IdeaSlots::with_defaults();
        slots.learn(&doc);
        assert_eq!(slots.family_of("my_officer_slot"), Family::OfficerCorpsSpirit);
        assert_eq!(slots.family_of("my_advisor_slot"), Family::AdvisorCard);
    }
}
