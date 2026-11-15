//! The definition rules of the TypeScript index's `walkBlock`.
//!
//! Ported from this repository's `src/hoi4_agent_tools/core/index.ts` (`SymbolIndex.walkBlock`)
//! at commit `5c75b21`. Every assignment of every block is visited; the first rule that matches a
//! block-valued assignment records it, and the walk then descends into it. Two rules record
//! scalar-valued assignments: an advisor's `idea_token` and the entries of `common/script_constants`.

use super::SymbolKind as K;
use super::reader::{Block, SOURCE_MAX_NESTING, Scalar, Value};

/// A definition: kind, id, first line, last line.
pub type Found = (K, String, u32, u32);

/// A reference record of the TypeScript index (`ReferenceRecord`) to the symbol a lookup asked
/// about: what points at it, from which definition, and where.
#[derive(Clone, Debug)]
pub struct Reference {
    pub kind: std::borrow::Cow<'static, str>,
    pub from: String,
    pub to_kind: K,
    pub to: String,
    /// 1-based line of the node the reference is located at.
    pub line: u32,
    /// Start offset of that node, so two references of one line stay apart.
    pub offset: u32,
    /// End offset of that node (the TypeScript location's end); the semantic scan sets the start.
    pub end: u32,
    /// Position among all references of the file, to apply the index's ceiling in file order.
    pub ordinal: u32,
}

/// Which references a walk keeps. `Nothing` records none and counts none.
#[derive(Clone, Copy, Debug)]
pub enum Collect<'p> {
    Nothing,
    /// The references to one symbol.
    Symbol(&'p str),
    /// Every reference.
    All,
    /// None kept, but all counted.
    Count,
}

/// What a rich walk ([`walk_rich`]) adds to each definition: the span of the node its TypeScript
/// location names, in bytes of the decoded text, and the TypeScript record's `metadata`.
#[derive(Clone, Debug)]
pub struct Rich {
    pub start: u32,
    pub end: u32,
    pub metadata: serde_json::Map<String, serde_json::Value>,
}

pub struct Walked {
    pub symbols: Vec<Found>,
    /// One entry per symbol, in the same order, from a rich walk; empty otherwise.
    pub rich: Vec<Rich>,
    pub nesting_blocked: bool,
    /// The first block past the nesting ceiling (`SOURCE_INDEX_NESTING_LIMIT`), in bytes.
    pub nesting_block: Option<(u32, u32)>,
    /// References to the requested target, in the order the TypeScript walk recorded them.
    pub references: Vec<Reference>,
    /// Every reference the file recorded, whatever it points at.
    pub reference_total: usize,
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

type Metadata = serde_json::Map<String, serde_json::Value>;

/// `numeric` of the TypeScript index: a whole number written as one, if it is a safe integer.
fn numeric(value: Option<&str>) -> Option<serde_json::Value> {
    let value = value?;
    let digits = value.strip_prefix('-').unwrap_or(value);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let parsed: f64 = value.parse().ok()?;
    (parsed.abs() <= 9_007_199_254_740_991.0).then(|| serde_json::Value::from(parsed as i64))
}

/// A metadata object; `None` values are left out, as `undefined` members vanish from JSON.
fn meta<const N: usize>(entries: [(&str, Option<serde_json::Value>); N]) -> Metadata {
    entries.into_iter().filter_map(|(key, value)| value.map(|value| (key.to_string(), value))).collect()
}

fn text(value: Option<&Scalar<'_>>) -> Option<serde_json::Value> {
    value.map(|s| serde_json::Value::from(s.value.as_ref()))
}

struct Walker<'p> {
    path: &'p str,
    gfx: bool,
    symbols: Vec<Found>,
    /// The rich half of each symbol, for a rich walk.
    rich: Option<Vec<Rich>>,
    /// Which references to keep; all of them are counted unless this is `Nothing`.
    collect: Collect<'p>,
    references: Vec<Reference>,
    reference_total: usize,
    nesting_blocked: bool,
    /// The first block past the nesting ceiling, as a span in bytes.
    nesting_block: Option<(u32, u32)>,
    /// First and last line of the assignment being visited, so a definition recorded on its first
    /// line spans the whole assignment (`nodeLocation` of the assignment in the TypeScript index).
    current: (u32, u32),
}

impl Walker<'_> {
    /// `addSymbol`: `span` is the node its location names and `metadata` its record's metadata,
    /// built only for a rich walk.
    fn add(&mut self, kind: K, id: &str, line: u32, span: (u32, u32), metadata: impl FnOnce() -> Metadata) {
        let end = if line == self.current.0 { self.current.1 } else { line };
        self.symbols.push((kind, id.to_string(), line, end));
        if let Some(rich) = &mut self.rich {
            rich.push(Rich { start: span.0, end: span.1, metadata: metadata() });
        }
    }

    fn starts(&self, prefix: &str) -> bool {
        self.path.starts_with(prefix)
    }

    /// `addReference`; `node` is the start and end of the node its location names.
    fn reference(&mut self, kind: &'static str, from: &str, to_kind: K, to: &str, line: u32, node: (u32, u32)) {
        let keep = match self.collect {
            Collect::Nothing => return,
            Collect::Symbol(target) => to == target,
            Collect::All => true,
            Collect::Count => false,
        };
        let ordinal = self.reference_total as u32;
        self.reference_total += 1;
        if keep {
            self.references.push(Reference {
                kind: std::borrow::Cow::Borrowed(kind),
                from: from.to_string(),
                to_kind,
                to: to.to_string(),
                line,
                offset: node.0,
                end: node.1,
                ordinal,
            });
        }
    }

    /// The references of a technology block: its path, exclusions, folder, categories, tags,
    /// unlocks and buildings, in that order.
    fn technology_references(&mut self, key: &str, child: &Block<'_>) {
        if matches!(self.collect, Collect::Nothing) {
            return;
        }
        for path_block in child.child_blocks("path") {
            if let Some(target) = path_block.first_scalar("leads_to_tech") {
                self.reference("technology_prerequisite", key, K::Technology, &target.value, target.line, (target.start, target.end));
            }
        }
        for xor in child.child_blocks("xor") {
            for target in xor.scalars() {
                self.reference("technology_exclusive", key, K::Technology, &target.value, xor.start_line, (xor.start, xor.end));
            }
        }
        for folder in child.child_blocks("folder") {
            if let Some(target) = folder.first_scalar("name") {
                self.reference("technology_folder", key, K::TechnologyFolder, &target.value, target.line, (target.start, target.end));
            }
        }
        for categories in child.child_blocks("categories") {
            for target in categories.scalars() {
                self.reference("technology_category", key, K::TechnologyCategory, &target.value, categories.start_line, (categories.start, categories.end));
            }
        }
        for tags in child.child_blocks("tags") {
            for target in tags.scalars() {
                self.reference("technology_tag", key, K::TechnologyTag, &target.value, tags.start_line, (tags.start, tags.end));
            }
        }
        for (field, kind, to_kind) in [
            ("enable_equipments", "technology_enable_equipments", K::Equipment),
            ("enable_equipment_modules", "technology_enable_equipment_modules", K::EquipmentModule),
            ("enable_subunits", "technology_enable_subunits", K::SubUnit),
        ] {
            for unlock in child.child_blocks(field) {
                for target in unlock.scalars() {
                    self.reference(kind, key, to_kind, &target.value, unlock.start_line, (unlock.start, unlock.end));
                }
            }
        }
        for building in child.child_blocks("enable_building") {
            if let Some(target) = building.first_scalar("building") {
                self.reference("technology_enable_building", key, K::Building, &target.value, target.line, (target.start, target.end));
            }
        }
    }

    /// The references of a focus of a tree: prerequisites, exclusions, relative position and icon.
    fn focus_references(&mut self, id: &str, child: &Block<'_>) {
        if matches!(self.collect, Collect::Nothing) {
            return;
        }
        for (field, kind) in [("prerequisite", "focus_prerequisite"), ("mutually_exclusive", "focus_exclusion")] {
            for block in child.child_blocks(field) {
                for target in block.assignments().filter(|a| a.key.value == "focus") {
                    if let Value::Scalar(value) = &target.value {
                        self.reference(kind, id, K::Focus, &value.value, target.key.line, (target.key.start, target.end()));
                    }
                }
            }
        }
        if let Some(relative) = child.first_scalar("relative_position_id") {
            self.reference("focus_relative_position", id, K::Focus, &relative.value, relative.line, (relative.start, relative.end));
        }
        if let Some(icon) = child.first_scalar("icon") {
            self.reference("focus_icon", id, K::Sprite, &icon.value, icon.line, (icon.start, icon.end));
        }
    }

    fn walk<'b>(&mut self, block: &'b Block<'_>, ancestors: &mut Vec<&'b str>) {
        if ancestors.len() > SOURCE_MAX_NESTING {
            self.nesting_blocked = true;
            self.nesting_block.get_or_insert((block.start, block.end));
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
            let span = (assignment.key.start, assignment.end());
            let child = match &assignment.value {
                Value::Scalar(value) => {
                    if key == "idea_token" && self.starts("common/characters/") && parent == Some("advisor") {
                        self.add(K::Idea, &value.value, line, span, || meta([("advisor", Some(true.into()))]));
                    }
                    if self.starts("common/script_constants/") && key != "schema" && !ancestors.contains(&"schema") {
                        let id = if ancestors.is_empty() { key.to_string() } else { format!("{}.{key}", ancestors.join(".")) };
                        self.symbols.push((K::ScriptConstant, id, line, end_line.max(line)));
                        if let Some(rich) = &mut self.rich {
                            rich.push(Rich { start: span.0, end: span.1, metadata: meta([("value", Some(value.value.as_ref().into()))]) });
                        }
                    }
                    continue;
                }
                Value::Block(child) => child,
            };
            let id = child.first_scalar("id").map(|s| s.value.as_ref());
            if key == "focus_tree" && id.is_some() {
                self.add(K::FocusTree, id.unwrap_or_default(), line, span, Metadata::new);
            } else if key == "continuous_focus_palette" && id.is_some() {
                self.add(K::ContinuousFocusPalette, id.unwrap_or_default(), line, span, Metadata::new);
            } else if self.starts("common/technologies/") && depth == 1 && parent == Some("technologies") && !key.starts_with('@') {
                self.add(K::Technology, key, line, span, || {
                    meta([
                        ("startYear", text(child.first_scalar("start_year"))),
                        ("researchCost", text(child.first_scalar("research_cost"))),
                        ("doctrine", Some(child.first_scalar("doctrine").is_some_and(|s| s.value == "yes").into())),
                        ("icon", Some(format!("GFX_{key}_medium").into())),
                    ])
                });
                self.technology_references(key, child);
            } else if self.starts("common/technology_tags/") && key == "technology_categories" {
                for category in child.scalars() {
                    self.add(K::TechnologyCategory, &category.value, category.line, (category.start, category.end), Metadata::new);
                }
            } else if self.starts("common/technology_tags/") && key == "technology_tags" {
                for tag in child.scalars() {
                    self.add(K::TechnologyTag, &tag.value, tag.line, (tag.start, tag.end), Metadata::new);
                }
            } else if self.starts("common/technology_tags/") && parent == Some("technology_folders") {
                self.add(K::TechnologyFolder, key, line, span, || {
                    meta([
                        ("doctrine", Some(child.first_scalar("doctrine").is_some_and(|s| s.value == "yes").into())),
                        ("ledger", text(child.first_scalar("ledger"))),
                    ])
                });
            } else if self.starts("common/units/equipment/modules/") && parent == Some("equipment_modules") && key != "limit" {
                self.add(K::EquipmentModule, key, line, span, Metadata::new);
            } else if self.starts("common/units/equipment/")
                && !self.starts("common/units/equipment/modules/")
                && parent == Some("equipments")
                && key != "limit"
            {
                self.add(K::Equipment, key, line, span, Metadata::new);
            } else if self.starts("common/units/") && !self.starts("common/units/equipment/") && parent == Some("sub_units") {
                self.add(K::SubUnit, key, line, span, Metadata::new);
            } else if self.starts("common/buildings/") && parent == Some("buildings") {
                self.add(K::Building, key, line, span, Metadata::new);
            } else if self.starts("common/abilities/") && parent == Some("ability") {
                self.add(K::Ability, key, line, span, Metadata::new);
            } else if (self.path == "common/combat_tactics.txt" || self.starts("common/combat_tactics/")) && parent == Some("combat_tactics") {
                self.add(K::CombatTactic, key, line, span, Metadata::new);
            } else if self.starts("common/doctrines/folders/") && depth == 0 {
                self.add(K::DoctrineFolder, key, line, span, Metadata::new);
            } else if self.starts("common/doctrines/grand_doctrines/") && depth == 0 {
                self.add(K::GrandDoctrine, key, line, span, || meta([("folder", text(child.first_scalar("folder")))]));
            } else if self.starts("common/doctrines/tracks/") && depth == 0 {
                self.add(K::DoctrineTrack, key, line, span, Metadata::new);
            } else if self.starts("common/doctrines/subdoctrines/") && depth == 0 {
                self.add(K::Subdoctrine, key, line, span, Metadata::new);
            } else if key == "focus" && id.is_some() && parent == Some("continuous_focus_palette") {
                let id = id.unwrap_or_default();
                self.add(K::ContinuousFocus, id, line, span, Metadata::new);
                if let Some(icon) = child.first_scalar("icon") {
                    self.reference("continuous_focus_icon", id, K::Sprite, &icon.value, icon.line, (icon.start, icon.end));
                }
            } else if id.is_some() && (((key == "shared_focus" || key == "joint_focus") && depth == 0) || (key == "focus" && parent == Some("focus_tree"))) {
                let id = id.unwrap_or_default();
                // Shared and joint focuses sit outside any tree; trees add them by id.
                if key == "focus" {
                    self.add(K::Focus, id, line, span, || {
                        meta([
                            ("x", numeric(child.first_scalar("x").map(|s| s.value.as_ref()))),
                            ("y", numeric(child.first_scalar("y").map(|s| s.value.as_ref()))),
                        ])
                    });
                    // Only a focus of a tree names prerequisites; shared and joint ones record none.
                    self.focus_references(id, child);
                } else {
                    self.add(K::Focus, id, line, span, || meta([("shared", Some(key.into()))]));
                }
            } else if self.starts("events/") && depth == 0 && EVENT_BLOCK_KEYS.contains(&key) && id.is_some() {
                self.add(K::Event, id.unwrap_or_default(), line, span, || meta([("eventType", Some(key.into()))]));
            } else if self.starts("common/scripted_effects/") && depth == 0 {
                self.add(K::ScriptedEffect, key, line, span, Metadata::new);
            } else if self.starts("common/scripted_triggers/") && depth == 0 {
                self.add(K::ScriptedTrigger, key, line, span, Metadata::new);
            } else if self.starts("common/mtth/") && depth == 0 {
                self.add(K::MtthVariable, key, line, span, Metadata::new);
            } else if self.starts("common/ai_strategy/") && depth == 0 {
                self.add(K::AiStrategy, key, line, span, Metadata::new);
            } else if self.starts("common/ai_strategy_plans/") && depth == 0 {
                self.add(K::AiStrategyPlan, key, line, span, Metadata::new);
            } else if self.starts("common/decisions/") && depth == 0 {
                self.add(K::DecisionCategory, key, line, span, Metadata::new);
            } else if self.starts("common/decisions/") && !self.starts("common/decisions/categories/") && depth == 1 && !DECISION_CATEGORY_FIELDS.contains(&key)
            {
                let category = ancestors.first().copied().unwrap_or("");
                self.add(K::Decision, key, line, span, || meta([("category", Some(category.into()))]));
                let context = format!("{}:{category}", self.path);
                if contains_insensitive(&context, "formable") || contains_insensitive(&context, "form_country") || key.to_lowercase().starts_with("form_") {
                    self.add(K::Formable, key, line, span, || meta([("decision", Some(key.into()))]));
                }
            } else if self.starts("common/ideas/") && depth == 2 && ancestors[0] == "ideas" {
                let category = ancestors[1];
                self.add(K::Idea, key, line, span, || meta([("category", Some(category.into()))]));
            } else if self.starts("common/characters/") && depth == 1 && ancestors[0] == "characters" {
                self.add(K::Leader, key, line, span, Metadata::new);
            } else if self.gfx
                && SPRITE_DEFINITION_KEYS.contains(&key.to_lowercase().as_str())
                && let Some(name) = child.first_scalar_insensitive(&["name"])
            {
                let texture = child.first_scalar_insensitive(&["texturefile"]);
                self.add(K::Sprite, &name.value, line, span, || {
                    meta([
                        ("spriteType", Some(key.into())),
                        ("texture", text(texture)),
                        ("frames", numeric(child.first_scalar_insensitive(&["noofframes"]).map(|s| s.value.as_ref()))),
                    ])
                });
                if let Some(texture) = texture {
                    self.add(K::Texture, &texture.value, texture.line, (texture.start, texture.end), || meta([("sprite", Some(name.value.as_ref().into()))]));
                }
            } else if GUI_ELEMENT_KEYS.contains(&key)
                && let Some(name) = child.first_scalar("name")
            {
                self.add(K::GuiElement, &name.value, line, span, || {
                    meta([("elementType", Some(key.into())), ("ancestors", Some(ancestors.iter().map(|a| serde_json::Value::from(*a)).collect()))])
                });
                if let Some(sprite) = child.first_scalar("spriteType") {
                    self.reference("gui_sprite", &name.value, K::Sprite, &sprite.value, sprite.line, (sprite.start, sprite.end));
                }
            } else if parent == Some("scripted_gui") {
                self.add(K::ScriptedGui, key, line, span, || {
                    meta([("context", text(child.first_scalar("context_type"))), ("window", text(child.first_scalar("window_name")))])
                });
                if let Some(window) = child.first_scalar("window_name") {
                    self.reference("scripted_gui_window", key, K::GuiElement, &window.value, window.line, (window.start, window.end));
                }
            } else if key == "state" && id.is_some() {
                let id = id.unwrap_or_default();
                self.add(K::State, id, line, span, || provinces_and_name(child));
                if !matches!(self.collect, Collect::Nothing) {
                    for provinces in child.child_blocks("provinces") {
                        for province in provinces.scalars() {
                            self.reference("state_province", id, K::Province, &province.value, line, span);
                        }
                    }
                }
            } else if (key == "strategic_region" || key == "strategic_region_template") && id.is_some() {
                self.add(K::StrategicRegion, id.unwrap_or_default(), line, span, || provinces_and_name(child));
            }
            ancestors.push(key);
            self.walk(child, ancestors);
            ancestors.pop();
        }
    }
}

/// The metadata of a state or a strategic region: every scalar of its `provinces` blocks and its
/// `name`.
fn provinces_and_name(child: &Block<'_>) -> Metadata {
    let provinces: Vec<serde_json::Value> = child.child_blocks("provinces").flat_map(|b| b.scalars()).map(|s| s.value.as_ref().into()).collect();
    meta([("provinces", Some(provinces.into())), ("name", text(child.first_scalar("name")))])
}

/// The definitions of one parsed file. `path` is its relative path in lower case.
///
/// With a `collect` mode other than `Nothing`, references are counted, and kept as it says.
pub fn walk<'p>(root: &Block<'_>, path: &'p str, collect: Collect<'p>) -> Walked {
    walk_with(root, path, collect, false)
}

/// [`walk`] that also records each definition's node span and metadata ([`Walked::rich`]).
pub fn walk_rich<'p>(root: &Block<'_>, path: &'p str, collect: Collect<'p>) -> Walked {
    walk_with(root, path, collect, true)
}

fn walk_with<'p>(root: &Block<'_>, path: &'p str, collect: Collect<'p>, rich: bool) -> Walked {
    let mut walker = Walker {
        path,
        gfx: path.ends_with(".gfx"),
        symbols: Vec::new(),
        rich: rich.then(Vec::new),
        collect,
        references: Vec::new(),
        reference_total: 0,
        nesting_blocked: false,
        nesting_block: None,
        current: (0, 0),
    };
    walker.walk(root, &mut Vec::new());
    Walked {
        symbols: walker.symbols,
        rich: walker.rich.unwrap_or_default(),
        nesting_blocked: walker.nesting_blocked,
        nesting_block: walker.nesting_block,
        references: walker.references,
        reference_total: walker.reference_total,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::symbol_index::reader::parse_clausewitz;

    fn records(path: &str, text: &str) -> Vec<(&'static str, String)> {
        let document = parse_clausewitz(text, text.len(), false);
        walk(&document.root, path, Collect::Nothing).symbols.into_iter().map(|(k, id, _, _)| (k.as_str(), id)).collect()
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
        let found: Vec<(String, u32, u32)> =
            walk(&document.root, "events/x.txt", Collect::Nothing).symbols.into_iter().map(|(_, id, line, end)| (id, line, end)).collect();
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
