//! Definitions per folder: which keys in which files create a symbol.

use hoi4_syntax::{Block, Document, Item, LocFile, Value};

use crate::index::{Definition, Kind};

fn def(doc: &Document, kind: Kind, token: u32, file: usize, out: &mut Vec<Definition>) {
    let name = doc.text(token).into_owned();
    if name.is_empty() || name.starts_with('@') {
        return;
    }
    let start = doc.token(token).start;
    out.push(Definition { kind, name, file, start, line: doc.position(start).0 });
}

/// Top-level keys whose value is a block.
fn top_level(doc: &Document, block: &Block, kind: Kind, file: usize, out: &mut Vec<Definition>) {
    for entry in block.entries() {
        if entry.value.as_block().is_some() {
            def(doc, kind, entry.key, file, out);
        }
    }
}

/// Block-valued keys inside every top-level `wrapper = { ... }`.
fn inside(doc: &Document, block: &Block, wrapper: &str, kind: Kind, file: usize, out: &mut Vec<Definition>) {
    for entry in block.entries() {
        if doc.key(entry) == wrapper
            && let Some(inner) = entry.value.as_block()
        {
            top_level(doc, inner, kind, file, out);
        }
    }
}

fn id_of(doc: &Document, block: &Block) -> Option<u32> {
    block.entries().find(|e| doc.key(e) == "id").and_then(|e| e.value.as_scalar())
}

const EVENT_TYPES: &[&str] = &["country_event", "news_event", "state_event", "unit_leader_event", "operative_leader_event"];

/// Definitions in a script file, from its lower-case relative path.
pub fn script_definitions(doc: &Document, path: &str, file: usize) -> Vec<Definition> {
    let mut out = Vec::new();
    let root = &doc.root;
    let under = |prefix: &str| path.starts_with(prefix) && path.ends_with(".txt") && !path[prefix.len()..].contains('/');
    if path.starts_with("events/") && path.ends_with(".txt") {
        for entry in root.entries() {
            let key = doc.key(entry);
            if key == "add_namespace" {
                if let Some(t) = entry.value.as_scalar() {
                    def(doc, Kind::EventNamespace, t, file, &mut out);
                }
            } else if EVENT_TYPES.contains(&key.as_ref())
                && let Some(block) = entry.value.as_block()
                && let Some(id) = id_of(doc, block)
            {
                def(doc, Kind::Event, id, file, &mut out);
            }
        }
    } else if under("common/scripted_effects/") {
        top_level(doc, root, Kind::ScriptedEffect, file, &mut out);
    } else if under("common/scripted_triggers/") {
        top_level(doc, root, Kind::ScriptedTrigger, file, &mut out);
    } else if under("common/decisions/categories/") {
        top_level(doc, root, Kind::DecisionCategory, file, &mut out);
    } else if under("common/decisions/") {
        for entry in root.entries() {
            if let Some(category) = entry.value.as_block() {
                top_level(doc, category, Kind::Decision, file, &mut out);
            }
        }
    } else if under("common/national_focus/") {
        for entry in root.entries() {
            let key = doc.key(entry);
            let Some(block) = entry.value.as_block() else { continue };
            if key == "focus_tree" {
                if let Some(id) = id_of(doc, block) {
                    def(doc, Kind::FocusTree, id, file, &mut out);
                }
                for focus in block.entries().filter(|e| doc.key(e) == "focus") {
                    if let Some(id) = focus.value.as_block().and_then(|b| id_of(doc, b)) {
                        def(doc, Kind::Focus, id, file, &mut out);
                    }
                }
            } else if (key == "shared_focus" || key == "joint_focus")
                && let Some(id) = id_of(doc, block)
            {
                def(doc, Kind::Focus, id, file, &mut out);
            }
        }
    } else if under("common/continuous_focus/") {
        for palette in root.entries().filter_map(|e| e.value.as_block()) {
            for focus in palette.entries().filter(|e| doc.key(e) == "focus") {
                if let Some(id) = focus.value.as_block().and_then(|b| id_of(doc, b)) {
                    def(doc, Kind::ContinuousFocus, id, file, &mut out);
                }
            }
        }
    } else if under("common/ideas/") {
        for ideas in root.entries().filter(|e| doc.key(e) == "ideas") {
            for category in ideas.value.as_block().into_iter().flat_map(|b| b.entries()) {
                if let Some(block) = category.value.as_block() {
                    top_level(doc, block, Kind::Idea, file, &mut out);
                }
            }
        }
    } else if under("common/characters/") {
        inside(doc, root, "characters", Kind::Character, file, &mut out);
        // An advisor role's `idea_token` is the idea that `has_idea` and `add_ideas` name. Roles
        // sit on the character or inside its DLC-dependent `instance` blocks.
        fn advisor_tokens(doc: &Document, block: &Block, file: usize, out: &mut Vec<Definition>) {
            for entry in block.entries() {
                match doc.key(entry).as_ref() {
                    "advisor" => {
                        for token in entry.value.as_block().into_iter().flat_map(|b| b.entries()).filter(|e| doc.key(e) == "idea_token") {
                            if let Some(t) = token.value.as_scalar() {
                                def(doc, Kind::Idea, t, file, out);
                            }
                        }
                    }
                    "instance" => {
                        if let Some(inner) = entry.value.as_block() {
                            advisor_tokens(doc, inner, file, out);
                        }
                    }
                    _ => {}
                }
            }
        }
        for characters in root.entries().filter(|e| doc.key(e) == "characters") {
            for character in characters.value.as_block().into_iter().flat_map(|b| b.entries()) {
                if let Some(block) = character.value.as_block() {
                    advisor_tokens(doc, block, file, &mut out);
                }
            }
        }
    } else if under("common/country_leader/") {
        inside(doc, root, "leader_traits", Kind::CountryLeaderTrait, file, &mut out);
    } else if under("common/unit_leader/") {
        inside(doc, root, "leader_traits", Kind::UnitLeaderTrait, file, &mut out);
    } else if under("common/opinion_modifiers/") {
        inside(doc, root, "opinion_modifiers", Kind::OpinionModifier, file, &mut out);
    } else if under("common/dynamic_modifiers/") {
        top_level(doc, root, Kind::DynamicModifier, file, &mut out);
    } else if under("common/modifiers/") {
        top_level(doc, root, Kind::StaticModifier, file, &mut out);
    } else if under("common/technologies/") {
        inside(doc, root, "technologies", Kind::Technology, file, &mut out);
    } else if under("common/scripted_localisation/") {
        for text in root.entries().filter(|e| doc.key(e) == "defined_text") {
            if let Some(name) = text.value.as_block().and_then(|b| b.entries().find(|e| doc.key(e) == "name")).and_then(|e| e.value.as_scalar()) {
                def(doc, Kind::ScriptedLocalisation, name, file, &mut out);
            }
        }
    } else if under("common/country_tag_aliases/") {
        // `SPA = { original_tag = SPR ... }`: aliases are usable wherever a tag is.
        for entry in root.entries() {
            if crate::context::is_tag_shaped(&doc.key(entry)) {
                def(doc, Kind::CountryTag, entry.key, file, &mut out);
            }
        }
    } else if under("common/country_tags/") {
        for entry in root.entries() {
            if entry.value.as_scalar().is_some() && crate::context::is_tag_shaped(&doc.key(entry)) {
                def(doc, Kind::CountryTag, entry.key, file, &mut out);
            }
        }
    } else if under("history/states/") {
        for state in root.entries().filter(|e| doc.key(e) == "state") {
            if let Some(id) = state.value.as_block().and_then(|b| id_of(doc, b)) {
                def(doc, Kind::State, id, file, &mut out);
            }
        }
    } else if under("common/ideologies/") {
        for ideologies in root.entries().filter(|e| doc.key(e) == "ideologies") {
            for ideology in ideologies.value.as_block().into_iter().flat_map(|b| b.entries()) {
                if let Some(block) = ideology.value.as_block() {
                    def(doc, Kind::Ideology, ideology.key, file, &mut out);
                    for types in block.entries().filter(|e| doc.key(e) == "types") {
                        if let Some(types) = types.value.as_block() {
                            top_level(doc, types, Kind::Ideology, file, &mut out);
                        }
                    }
                }
            }
        }
    } else if under("common/on_actions/") {
        inside(doc, root, "on_actions", Kind::OnAction, file, &mut out);
    } else if under("common/scripted_guis/") {
        inside(doc, root, "scripted_gui", Kind::ScriptedGui, file, &mut out);
    } else if under("common/units/") {
        inside(doc, root, "sub_units", Kind::SubUnit, file, &mut out);
    } else if under("common/units/equipment/") {
        inside(doc, root, "equipments", Kind::Equipment, file, &mut out);
    } else if under("common/buildings/") {
        inside(doc, root, "buildings", Kind::Building, file, &mut out);
    } else if path == "common/combat_tactics.txt" {
        for entry in root.entries() {
            if entry.value.as_block().is_some() && doc.key(entry) != "phase" {
                def(doc, Kind::CombatTactic, entry.key, file, &mut out);
            }
        }
    } else if under("common/resources/") {
        inside(doc, root, "resources", Kind::Resource, file, &mut out);
    } else if under("common/terrain/") {
        inside(doc, root, "categories", Kind::Terrain, file, &mut out);
    } else if path.ends_with(".gfx") {
        for sprites in root.entries().filter(|e| doc.key(e).eq_ignore_ascii_case("spriteTypes")) {
            for sprite in sprites.value.as_block().into_iter().flat_map(|b| b.entries()) {
                if let Some(block) = sprite.value.as_block() {
                    for name in block.entries().filter(|e| doc.key(e).eq_ignore_ascii_case("name")) {
                        if let Some(t) = name.value.as_scalar() {
                            def(doc, Kind::Sprite, t, file, &mut out);
                        }
                    }
                }
            }
        }
    }
    out
}

pub fn localisation_definitions(loc: &LocFile, file: usize) -> Vec<Definition> {
    loc.entries.iter().map(|e| Definition { kind: Kind::LocalisationKey, name: e.key.clone(), file, start: e.key_range.start, line: e.line }).collect()
}

/// Every entry in the document, depth first, with its parent keys. Used by lexical scans that do
/// not depend on a context model (flags, `has_dlc`).
pub fn visit_entries<'d>(block: &'d Block, visit: &mut dyn FnMut(&'d hoi4_syntax::Entry)) {
    for item in &block.items {
        match item {
            Item::Entry(entry) => {
                visit(entry);
                if let Some(inner) = entry.value.as_block() {
                    visit_entries(inner, visit);
                }
            }
            Item::Value(Value::Block(inner)) => visit_entries(inner, visit),
            _ => {}
        }
    }
}
