//! The definition rules of the TypeScript index's `walkBlock`.
//!
//! Ported from this repository's `src/hoi4_agent_tools/core/index.ts` (`SymbolIndex.walkBlock`)
//! at commit `5c75b21`. Every assignment of every block is visited; the first rule that matches a
//! block-valued assignment records it, and the walk then descends into it. Two rules record
//! scalar-valued assignments: an advisor's `idea_token` and the entries of `common/script_constants`.

use super::SymbolKind as K;
use super::reader::{Block, SOURCE_MAX_NESTING, Value};

/// A definition: kind, id, first line, last line.
pub type Found = (K, String, u32, u32);

pub struct Walked {
    pub symbols: Vec<Found>,
    pub nesting_blocked: bool,
}

const EVENT_BLOCK_KEYS: &[&str] = &["country_event", "news_event", "state_event", "unit_leader_event", "operative_leader_event"];

const DECISION_CATEGORY_FIELDS: &[&str] =
    &["allowed", "available", "icon", "picture", "priority", "scripted_gui", "target_root_trigger", "visible", "visible_when_empty"];

const SPRITE_DEFINITION_KEYS: &[&str] = &["spritetype", "textspritetype", "frameanimatedspritetype", "corneredtilespritetype", "maskedshieldtype"];

const GUI_ELEMENT_KEYS: &[&str] = &[
    "containerWindowType",
    "windowType",
    "iconType",
    "buttonType",
    "instantTextBoxType",
    "textBoxType",
    "gridBoxType",
    "listboxType",
    "smoothListboxType",
    "scrollbarType",
    "checkboxType",
    "editBoxType",
    "OverlappingElementsBoxType",
];

/// `/(?:^|\/)focus(?:es)?(?:\/|$)|national_focus|continuous_focus/` on a lower-case path.
pub fn focus_path(path: &str) -> bool {
    if path.contains("national_focus") || path.contains("continuous_focus") {
        return true;
    }
    let bytes = path.as_bytes();
    let mut from = 0;
    while let Some(found) = path[from..].find("focus") {
        let start = from + found;
        let mut end = start + "focus".len();
        let before_ok = start == 0 || bytes[start - 1] == b'/';
        if before_ok {
            let boundary = |at: usize| at == bytes.len() || bytes[at] == b'/';
            if boundary(end) {
                return true;
            }
            if path[end..].starts_with("es") {
                end += 2;
                if boundary(end) {
                    return true;
                }
            }
        }
        from = start + 1;
    }
    false
}

/// `/^(?:formable|form_country)/`-style tests of the TypeScript rules, case-insensitive.
fn contains_insensitive(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(needle)
}

struct Walker<'p> {
    path: &'p str,
    gfx: bool,
    symbols: Vec<Found>,
    nesting_blocked: bool,
    /// First and last line of the assignment being visited, so a definition recorded on its first
    /// line spans the whole assignment (`nodeLocation` of the assignment in the TypeScript index).
    current: (u32, u32),
}

impl Walker<'_> {
    fn add(&mut self, kind: K, id: &str, line: u32) {
        let end = if line == self.current.0 { self.current.1 } else { line };
        self.symbols.push((kind, id.to_string(), line, end));
    }

    fn starts(&self, prefix: &str) -> bool {
        self.path.starts_with(prefix)
    }

    fn walk<'b>(&mut self, block: &'b Block<'_>, ancestors: &mut Vec<&'b str>) {
        if ancestors.len() > SOURCE_MAX_NESTING {
            self.nesting_blocked = true;
            return;
        }
        let parent = ancestors.last().copied();
        let depth = ancestors.len();
        for assignment in block.assignments() {
            let key: &'b str = &assignment.key.value;
            let line = assignment.key.line;
            let end_line = match &assignment.value {
                Value::Scalar(value) => value.line,
                Value::Block(block) if block.end_line > 0 => block.end_line,
                Value::Block(_) => line,
            };
            self.current = (line, end_line.max(line));
            let child = match &assignment.value {
                Value::Scalar(value) => {
                    if key == "idea_token" && self.starts("common/characters/") && parent == Some("advisor") {
                        self.add(K::Idea, &value.value, line);
                    }
                    if self.starts("common/script_constants/") && key != "schema" && !ancestors.contains(&"schema") {
                        let id = if ancestors.is_empty() { key.to_string() } else { format!("{}.{key}", ancestors.join(".")) };
                        self.symbols.push((K::ScriptConstant, id, line, end_line.max(line)));
                    }
                    continue;
                }
                Value::Block(child) => child,
            };
            let id = child.first_scalar("id").map(|s| s.value.as_ref());
            if key == "focus_tree" && id.is_some() {
                self.add(K::FocusTree, id.unwrap_or_default(), line);
            } else if key == "continuous_focus_palette" && id.is_some() {
                self.add(K::ContinuousFocusPalette, id.unwrap_or_default(), line);
            } else if self.starts("common/technologies/") && depth == 1 && parent == Some("technologies") && !key.starts_with('@') {
                self.add(K::Technology, key, line);
            } else if self.starts("common/technology_tags/") && key == "technology_categories" {
                for category in child.scalars() {
                    self.add(K::TechnologyCategory, &category.value, category.line);
                }
            } else if self.starts("common/technology_tags/") && key == "technology_tags" {
                for tag in child.scalars() {
                    self.add(K::TechnologyTag, &tag.value, tag.line);
                }
            } else if self.starts("common/technology_tags/") && parent == Some("technology_folders") {
                self.add(K::TechnologyFolder, key, line);
            } else if self.starts("common/units/equipment/modules/") && parent == Some("equipment_modules") && key != "limit" {
                self.add(K::EquipmentModule, key, line);
            } else if self.starts("common/units/equipment/")
                && !self.starts("common/units/equipment/modules/")
                && parent == Some("equipments")
                && key != "limit"
            {
                self.add(K::Equipment, key, line);
            } else if self.starts("common/units/") && !self.starts("common/units/equipment/") && parent == Some("sub_units") {
                self.add(K::SubUnit, key, line);
            } else if self.starts("common/buildings/") && parent == Some("buildings") {
                self.add(K::Building, key, line);
            } else if self.starts("common/abilities/") && parent == Some("ability") {
                self.add(K::Ability, key, line);
            } else if (self.path == "common/combat_tactics.txt" || self.starts("common/combat_tactics/")) && parent == Some("combat_tactics") {
                self.add(K::CombatTactic, key, line);
            } else if self.starts("common/doctrines/folders/") && depth == 0 {
                self.add(K::DoctrineFolder, key, line);
            } else if self.starts("common/doctrines/grand_doctrines/") && depth == 0 {
                self.add(K::GrandDoctrine, key, line);
            } else if self.starts("common/doctrines/tracks/") && depth == 0 {
                self.add(K::DoctrineTrack, key, line);
            } else if self.starts("common/doctrines/subdoctrines/") && depth == 0 {
                self.add(K::Subdoctrine, key, line);
            } else if key == "focus" && id.is_some() && parent == Some("continuous_focus_palette") {
                self.add(K::ContinuousFocus, id.unwrap_or_default(), line);
            } else if id.is_some() && (((key == "shared_focus" || key == "joint_focus") && depth == 0) || (key == "focus" && parent == Some("focus_tree"))) {
                // Shared and joint focuses sit outside any tree; trees add them by id.
                self.add(K::Focus, id.unwrap_or_default(), line);
            } else if self.starts("events/") && depth == 0 && EVENT_BLOCK_KEYS.contains(&key) && id.is_some() {
                self.add(K::Event, id.unwrap_or_default(), line);
            } else if self.starts("common/scripted_effects/") && depth == 0 {
                self.add(K::ScriptedEffect, key, line);
            } else if self.starts("common/scripted_triggers/") && depth == 0 {
                self.add(K::ScriptedTrigger, key, line);
            } else if self.starts("common/mtth/") && depth == 0 {
                self.add(K::MtthVariable, key, line);
            } else if self.starts("common/ai_strategy/") && depth == 0 {
                self.add(K::AiStrategy, key, line);
            } else if self.starts("common/ai_strategy_plans/") && depth == 0 {
                self.add(K::AiStrategyPlan, key, line);
            } else if self.starts("common/decisions/") && depth == 0 {
                self.add(K::DecisionCategory, key, line);
            } else if self.starts("common/decisions/") && !self.starts("common/decisions/categories/") && depth == 1 && !DECISION_CATEGORY_FIELDS.contains(&key)
            {
                self.add(K::Decision, key, line);
                let category = ancestors.first().copied().unwrap_or("");
                let context = format!("{}:{category}", self.path);
                if contains_insensitive(&context, "formable") || contains_insensitive(&context, "form_country") || key.to_lowercase().starts_with("form_") {
                    self.add(K::Formable, key, line);
                }
            } else if self.starts("common/ideas/") && depth == 2 && ancestors[0] == "ideas" {
                self.add(K::Idea, key, line);
            } else if self.starts("common/characters/") && depth == 1 && ancestors[0] == "characters" {
                self.add(K::Leader, key, line);
            } else if self.gfx
                && SPRITE_DEFINITION_KEYS.contains(&key.to_lowercase().as_str())
                && let Some(name) = child.first_scalar_insensitive(&["name"])
            {
                self.add(K::Sprite, &name.value, line);
                if let Some(texture) = child.first_scalar_insensitive(&["texturefile"]) {
                    self.add(K::Texture, &texture.value, texture.line);
                }
            } else if GUI_ELEMENT_KEYS.contains(&key)
                && let Some(name) = child.first_scalar("name")
            {
                self.add(K::GuiElement, &name.value, line);
            } else if parent == Some("scripted_gui") {
                self.add(K::ScriptedGui, key, line);
            } else if key == "state" && id.is_some() {
                self.add(K::State, id.unwrap_or_default(), line);
            } else if (key == "strategic_region" || key == "strategic_region_template") && id.is_some() {
                self.add(K::StrategicRegion, id.unwrap_or_default(), line);
            }
            ancestors.push(key);
            self.walk(child, ancestors);
            ancestors.pop();
        }
    }
}

/// The definitions of one parsed file. `path` is its relative path in lower case.
pub fn walk(root: &Block<'_>, path: &str) -> Walked {
    let mut walker = Walker { path, gfx: path.ends_with(".gfx"), symbols: Vec::new(), nesting_blocked: false, current: (0, 0) };
    walker.walk(root, &mut Vec::new());
    Walked { symbols: walker.symbols, nesting_blocked: walker.nesting_blocked }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::symbol_index::reader::parse_clausewitz;

    fn records(path: &str, text: &str) -> Vec<(&'static str, String)> {
        let document = parse_clausewitz(text, text.len(), false);
        walk(&document.root, path).symbols.into_iter().map(|(k, id, _, _)| (k.as_str(), id)).collect()
    }

    #[test]
    fn a_definition_spans_its_assignment() {
        let text = "country_event = {
  id = a.1
  title = x
}
country_event = { id = a.2 }
country_event = {
  id = a.3
";
        let document = parse_clausewitz(text, text.len(), false);
        let found: Vec<(String, u32, u32)> = walk(&document.root, "events/x.txt").symbols.into_iter().map(|(_, id, line, end)| (id, line, end)).collect();
        assert_eq!(found[0], ("a.1".to_string(), 1, 4));
        assert_eq!(found[1], ("a.2".to_string(), 5, 5));
        // An unclosed block ends on the file's last token.
        assert_eq!(found[2], ("a.3".to_string(), 6, 7));
    }

    #[test]
    fn focus_paths_match_the_typescript_pattern() {
        assert!(focus_path("common/national_focus/a.txt"));
        assert!(focus_path("focus/a.txt"));
        assert!(focus_path("x/focuses/a.txt"));
        assert!(!focus_path("x/focusing/a.txt"));
        assert!(!focus_path("x/myfocus/a.txt"));
    }

    #[test]
    fn decisions_categories_and_formables() {
        let found = records("common/decisions/x.txt", "cat = { icon = a allowed = { } form_italy = { } normal = { } }\nformable_nations = { take = { } }\n");
        assert_eq!(
            found,
            [
                ("decision_category", "cat".to_string()),
                ("decision", "form_italy".into()),
                ("formable", "form_italy".into()),
                ("decision", "normal".into()),
                ("decision_category", "formable_nations".into()),
                ("decision", "take".into()),
                ("formable", "take".into()),
            ]
        );
    }

    #[test]
    fn sprites_are_case_insensitive_and_gui_elements_are_not() {
        let found = records("interface/x.gfx", "spriteTypes = { SpriteType = { NAME = GFX_a texturefile = \"gfx/a.dds\" } }\n");
        assert_eq!(found, [("sprite", "GFX_a".to_string()), ("texture", "gfx/a.dds".into())]);
        let gui = records("interface/x.gui", "guiTypes = { containerWindowType = { name = w iconType = { name = i } } ICONTYPE = { name = n } }\n");
        assert_eq!(gui, [("gui_element", "w".to_string()), ("gui_element", "i".into())]);
    }

    #[test]
    fn script_constants_join_their_ancestors_and_skip_schemas() {
        let found = records("common/script_constants/x.txt", "a = 1\ngroup = { b = 2 schema = { c = 3 } }\nschema = 4\n");
        assert_eq!(found, [("script_constant", "a".to_string()), ("script_constant", "group.b".into())]);
    }

    #[test]
    fn events_need_an_id_at_the_top_level() {
        let found =
            records("events/x.txt", "add_namespace = n\ncountry_event = { id = n.1 }\nnews_event = { title = t }\nx = { country_event = { id = n.2 } }\n");
        assert_eq!(found, [("event", "n.1".to_string())]);
    }
}
