//! Per-file technology source analysis.
//!
//! Ported from `src/hoi4_agent_tools/technology/source-analysis.ts` (`analyzeTechnologySource` and
//! its parsers), commit `9b7dc80d`. A fragment is built as the JSON object the TypeScript server
//! produced, so graph assembly and the wire shape stay unchanged.
//!
//! Known defect not copied: the TypeScript analysis gave every technology without
//! `force_use_small_tech_layout = yes` an `unsupportedFields` entry for that field, even with no
//! expression at all. An entry is now written only when the field has a value that is not a yes or
//! no literal.

use std::collections::{HashMap, HashSet};

use hoi4_core::canonical::{canonical_json, compare_code_units, hash_canonical};
use hoi4_core::files::ScannedFile;
use hoi4_engine::symbol_index::reader::{Assignment, Block, Entry, Scalar, Value as Node, decode, parse_clausewitz_detailed, windows_1252_loss};
use serde_json::{Map, Value, json};

use crate::pos::Positions;

pub struct Context {
    pub helper_ids: HashSet<String>,
}

#[derive(Clone)]
struct Owner {
    kind: &'static str,
    id: String,
}

const STRUCTURAL: [&str; 29] = [
    "ai_research_weights",
    "ai_will_do",
    "allow",
    "allow_branch",
    "categories",
    "desc",
    "doctrine",
    "doctrine_name",
    "enable_ability",
    "enable_abilities",
    "enable_building",
    "enable_equipment_modules",
    "enable_equipments",
    "enable_subunits",
    "enable_tactic",
    "folder",
    "force_use_small_tech_layout",
    "on_research_complete",
    "on_research_complete_limit",
    "path",
    "research_cost",
    "show_equipment_icon",
    "start_year",
    "sub_technologies",
    "tags",
    "xp_boost_cost",
    "xp_research_bonus",
    "xp_unlock_cost",
    "xor",
];

const DOCTRINE_STRUCTURAL: [&str; 19] = [
    "active",
    "ai_will_do",
    "allow_in_multiple_tracks",
    "available",
    "description",
    "folder",
    "icon",
    "mastery",
    "max_track_columns",
    "max_track_rows",
    "milestones",
    "name",
    "rewards",
    "track",
    "tracks",
    "visible",
    "xp_cost",
    "xp_type",
    "xor",
];

const EVENT_KEYS: [&str; 5] = ["country_event", "news_event", "state_event", "unit_leader_event", "operative_leader_event"];

const DECISION_STRUCTURAL: [&str; 9] =
    ["allowed", "available", "icon", "picture", "priority", "scripted_gui", "target_root_trigger", "visible", "visible_when_empty"];

pub fn deterministic_id(prefix: &str, value: &Value) -> String {
    format!("{prefix}_{}", &hash_canonical(value)[..24])
}

fn sorted_unique(mut values: Vec<String>) -> Vec<String> {
    values.sort_by(|a, b| compare_code_units(a, b));
    values.dedup();
    values
}

fn is_static_identifier(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

fn is_dynamic(value: &str) -> bool {
    !is_static_identifier(value) || value.contains(['[', ']', '$', '?']) || value.starts_with("var:") || value.starts_with("event_target:")
}

fn boolean_value(value: Option<&str>) -> Option<bool> {
    match value?.to_lowercase().as_str() {
        "yes" => Some(true),
        "no" => Some(false),
        _ => None,
    }
}

/// `/^-?(?:\d+\.?\d*|\.\d+)$/` then `Number`.
fn numeric_literal(value: Option<&str>) -> Option<f64> {
    let v = value?;
    let body = v.strip_prefix('-').unwrap_or(v);
    let mut chars = body.chars().peekable();
    let mut int_digits = 0;
    while chars.peek().is_some_and(char::is_ascii_digit) {
        chars.next();
        int_digits += 1;
    }
    let mut frac_digits = 0;
    if chars.peek() == Some(&'.') {
        chars.next();
        while chars.peek().is_some_and(char::is_ascii_digit) {
            chars.next();
            frac_digits += 1;
        }
    }
    if chars.next().is_some() || (int_digits == 0 && frac_digits == 0) {
        return None;
    }
    let parsed: f64 = v.parse().ok()?;
    parsed.is_finite().then_some(parsed)
}

pub fn number_value(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9.0e15 { Value::from(value as i64) } else { Value::from(value) }
}

/// JavaScript's `String(number)`.
fn js_number_string(value: f64) -> String {
    canonical_json(&number_value(value))
}

fn resolved_number(value: Option<&str>, constants: &HashMap<String, String>) -> Option<f64> {
    let mut current = value.map(str::to_string);
    let mut seen = HashSet::new();
    for _ in 0..32 {
        if let Some(literal) = numeric_literal(current.as_deref()) {
            return Some(literal);
        }
        let c = current?;
        if !c.starts_with('@') || !seen.insert(c.clone()) {
            return None;
        }
        current = constants.get(&c).cloned();
    }
    None
}

fn resolved_numeric_scalar(value: Option<&str>, constants: &HashMap<String, String>) -> Option<String> {
    let v = value?;
    if !v.starts_with('@') {
        return Some(v.to_string());
    }
    Some(resolved_number(Some(v), constants).map_or_else(|| v.to_string(), js_number_string))
}

fn constants_in(block: &Block) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for a in block.assignments() {
        if a.key.value.starts_with('@')
            && let Node::Scalar(s) = &a.value
        {
            out.insert(a.key.value.to_string(), s.value.to_string());
        }
    }
    out
}

fn first_value(block: &Block, key: &str) -> Option<String> {
    block.first_scalar(key).map(|s| s.value.to_string())
}

fn scalar_values(block: &Block) -> Vec<String> {
    block.scalars().map(|s| s.value.to_string()).collect()
}

fn assignment_scalars<'b, 'a>(block: &'b Block<'a>, key: &str) -> Vec<&'b Scalar<'a>> {
    block
        .assignments()
        .filter(|a| a.key.value == key)
        .filter_map(|a| match &a.value {
            Node::Scalar(s) => Some(s),
            Node::Block(_) => None,
        })
        .collect()
}

fn child_blocks<'b, 'a>(block: &'b Block<'a>, key: &str) -> Vec<&'b Block<'a>> {
    block
        .assignments()
        .filter(|a| a.key.value == key)
        .filter_map(|a| match &a.value {
            Node::Block(b) => Some(b),
            Node::Scalar(_) => None,
        })
        .collect()
}

fn set(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(v) = value {
        map.insert(key.to_string(), v);
    }
}

fn s(value: Option<String>) -> Option<Value> {
    value.map(Value::from)
}

struct Ctx<'a> {
    file: &'a ScannedFile,
    text: &'a str,
    pos: &'a Positions<'a>,
    /// `normalizedPath`.
    normal: String,
}

impl Ctx<'_> {
    fn loc(&self, start: u32, end: u32, symbol: &str) -> Value {
        self.pos.node_location(&self.file.display_path, start, end, Some(symbol))
    }

    fn scalar_loc(&self, s: &Scalar, symbol: &str) -> Value {
        self.loc(s.start, s.end, symbol)
    }

    fn assignment_loc(&self, a: &Assignment, symbol: &str) -> Value {
        self.loc(a.key.start, a.end(), symbol)
    }

    fn unit(&self, byte: u32) -> u32 {
        self.pos.unit(byte)
    }

    fn provenance(&self, start: u32, end: u32, symbol: &str) -> Value {
        json!({
            "path": self.file.display_path,
            "rootKind": serde_json::to_value(self.file.root_kind).unwrap_or(Value::Null),
            "loadOrder": self.file.load_order,
            "location": self.loc(start, end, symbol),
            "sourceHash": self.file.sha256,
        })
    }

    fn text(&self, start: u32, end: u32) -> String {
        self.text.get(start as usize..end as usize).unwrap_or_default().to_string()
    }
}

fn unresolved(kind: &str, expression: &str, owner: Option<&str>, location: Option<Value>, code: &str, message: &str) -> Value {
    let mut identity = Map::new();
    identity.insert("kind".into(), kind.into());
    identity.insert("expression".into(), expression.into());
    set(&mut identity, "ownerId", owner.map(Value::from));
    set(&mut identity, "location", location.clone());
    let mut blocker = Map::new();
    blocker.insert("code".into(), code.into());
    blocker.insert("message".into(), message.into());
    set(&mut blocker, "location", location.clone());
    let mut out = Map::new();
    out.insert("id".into(), deterministic_id("tech-unresolved", &Value::Object(identity)).into());
    out.insert("kind".into(), kind.into());
    out.insert("expression".into(), expression.into());
    set(&mut out, "ownerId", owner.map(Value::from));
    set(&mut out, "location", location);
    out.insert("confidence".into(), "unresolved".into());
    out.insert("blockers".into(), Value::Array(vec![Value::Object(blocker)]));
    Value::Object(out)
}

fn ai_metadata(block: &Block) -> Value {
    let ai = child_blocks(block, "ai_will_do").first().copied();
    let mut weights = Map::new();
    if let Some(w) = child_blocks(block, "ai_research_weights").first() {
        let mut entries: Vec<(String, String)> = w
            .assignments()
            .filter_map(|a| match &a.value {
                Node::Scalar(v) => Some((a.key.value.to_string(), v.value.to_string())),
                Node::Block(_) => None,
            })
            .collect();
        entries.sort_by(|l, r| compare_code_units(&l.0, &r.0));
        for (k, v) in entries {
            weights.insert(k, v.into());
        }
    }
    let Some(ai) = ai else {
        return json!({ "present": false, "zero": "unknown", "researchWeights": weights });
    };
    let base = first_value(ai, "base");
    let factor = first_value(ai, "factor");
    let pick = base.clone().or_else(|| factor.clone());
    let zero: Value = if numeric_literal(pick.as_deref()) == Some(0.0) {
        true.into()
    } else if base.is_none() && factor.is_none() {
        "unknown".into()
    } else {
        false.into()
    };
    let expression = ai
        .assignments()
        .map(|a| {
            format!(
                "{}={}",
                a.key.value,
                match &a.value {
                    Node::Scalar(v) => v.value.to_string(),
                    Node::Block(_) => "{...}".into(),
                }
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    let mut out = Map::new();
    out.insert("present".into(), true.into());
    set(&mut out, "base", s(base));
    set(&mut out, "factor", s(factor));
    out.insert("zero".into(), zero);
    out.insert("researchWeights".into(), Value::Object(weights));
    out.insert("expression".into(), expression.into());
    Value::Object(out)
}

fn hidden_status(block: &Block) -> Value {
    let Some(allow) = child_blocks(block, "allow").first().copied() else { return false.into() };
    let always = boolean_value(first_value(allow, "always").as_deref());
    if always == Some(false) {
        return true.into();
    }
    if always == Some(true) && allow.assignments().count() == 1 {
        return false.into();
    }
    "unknown".into()
}

#[derive(Default)]
pub struct Fragment {
    pub technologies: Vec<Value>,
    pub folders: Vec<Value>,
    pub placements: Vec<Value>,
    pub gridboxes: Vec<Value>,
    pub item_layouts: Vec<Value>,
    pub year_markers: Vec<Value>,
    pub backgrounds: Option<Vec<Value>>,
    pub edges: Vec<Value>,
    pub categories: Vec<Value>,
    pub doctrine_definitions: Vec<Value>,
    pub unlock_targets: Vec<Value>,
    pub unlocks: Vec<Value>,
    pub external_references: Vec<Value>,
    pub helper_calls: Vec<Value>,
    pub unresolved: Vec<Value>,
    pub diagnostics: Vec<Value>,
}

impl Fragment {
    pub fn into_value(self, file: &ScannedFile) -> Value {
        let mut out = Map::new();
        out.insert("sourcePath".into(), file.display_path.clone().into());
        out.insert("sourceHash".into(), file.sha256.clone().into());
        out.insert("technologies".into(), self.technologies.into());
        out.insert("folders".into(), self.folders.into());
        out.insert("placements".into(), self.placements.into());
        out.insert("gridboxes".into(), self.gridboxes.into());
        out.insert("itemLayouts".into(), self.item_layouts.into());
        out.insert("yearMarkers".into(), self.year_markers.into());
        set(&mut out, "backgrounds", self.backgrounds.map(Value::from));
        out.insert("edges".into(), self.edges.into());
        out.insert("categories".into(), self.categories.into());
        out.insert("doctrineDefinitions".into(), self.doctrine_definitions.into());
        out.insert("unlockTargets".into(), self.unlock_targets.into());
        out.insert("unlocks".into(), self.unlocks.into());
        out.insert("externalReferences".into(), self.external_references.into());
        out.insert("helperCalls".into(), self.helper_calls.into());
        out.insert("unresolved".into(), self.unresolved.into());
        out.insert("diagnostics".into(), self.diagnostics.into());
        Value::Object(out)
    }
}

fn dynamic_reference(cx: &Ctx, v: &Scalar, owner: &str) -> Value {
    unresolved(
        "dynamic_reference",
        &v.value,
        Some(owner),
        Some(cx.scalar_loc(v, owner)),
        "TECH_DYNAMIC_REFERENCE_UNRESOLVED",
        &format!("Dynamic technology reference {} cannot be resolved statically", v.value),
    )
}

fn edge(cx: &Ctx, kind: &str, from: &str, target: &Scalar) -> Value {
    json!({
        "id": deterministic_id("tech-edge", &json!({ "kind": kind, "from": from, "to": target.value.to_string(), "path": cx.file.display_path, "offset": cx.unit(target.start) })),
        "kind": kind, "from": from, "to": target.value.to_string(),
        "location": cx.scalar_loc(target, from), "confidence": "confirmed",
    })
}

fn parse_technology_definitions(cx: &Ctx, root: &Block, fragment: &mut Fragment) {
    for wrapper in child_blocks(root, "technologies") {
        let mut constants = constants_in(root);
        constants.extend(constants_in(wrapper));
        for definition in wrapper.assignments() {
            if definition.key.value.starts_with('@') {
                continue;
            }
            let Node::Block(block) = &definition.value else { continue };
            let id = definition.key.value.to_string();
            let source = cx.provenance(definition.key.start, definition.end(), &id);
            let mut folders: Vec<String> = Vec::new();
            for folder in child_blocks(block, "folder") {
                let Some(folder_scalar) = folder.first_scalar("name") else { continue };
                let folder_id = folder_scalar.value.to_string();
                if is_dynamic(&folder_id) {
                    fragment.unresolved.push(unresolved(
                        "dynamic_reference",
                        &folder_id,
                        Some(&id),
                        Some(cx.scalar_loc(folder_scalar, &id)),
                        "TECH_DYNAMIC_FOLDER_UNRESOLVED",
                        &format!("Dynamic folder reference {folder_id} cannot be resolved statically"),
                    ));
                    continue;
                }
                folders.push(folder_id.clone());
                let position = child_blocks(folder, "position").first().copied();
                let x_scalar = position.and_then(|p| p.first_scalar("x"));
                let y_scalar = position.and_then(|p| p.first_scalar("y"));
                let x = resolved_number(x_scalar.map(|v| v.value.as_ref()), &constants);
                let y = resolved_number(y_scalar.map(|v| v.value.as_ref()), &constants);
                let mut p = Map::new();
                p.insert(
                    "id".into(),
                    deterministic_id(
                        "tech-placement",
                        &json!({ "technologyId": id, "folderId": folder_id, "offset": cx.unit(folder.start), "path": cx.file.display_path }),
                    )
                    .into(),
                );
                p.insert("technologyId".into(), id.clone().into());
                p.insert("folderId".into(), folder_id.clone().into());
                set(&mut p, "x", x.map(number_value));
                set(&mut p, "y", y.map(number_value));
                if let (Some(sc), None) = (x_scalar, x) {
                    p.insert("xExpression".into(), sc.value.to_string().into());
                }
                if let (Some(sc), None) = (y_scalar, y) {
                    p.insert("yExpression".into(), sc.value.to_string().into());
                }
                p.insert("sourceAccurate".into(), true.into());
                p.insert("location".into(), cx.loc(folder.start, folder.end, &id));
                fragment.placements.push(Value::Object(p));
            }

            for path_block in child_blocks(block, "path") {
                let Some(target) = path_block.first_scalar("leads_to_tech") else { continue };
                if is_dynamic(&target.value) {
                    fragment.unresolved.push(unresolved(
                        "dynamic_reference",
                        &target.value,
                        Some(&id),
                        Some(cx.scalar_loc(target, &id)),
                        "TECH_DYNAMIC_PREREQUISITE_UNRESOLVED",
                        &format!("Dynamic prerequisite target {} cannot be resolved statically", target.value),
                    ));
                    continue;
                }
                let mut e = edge(cx, "prerequisite", &id, target);
                let object = e.as_object_mut().expect("edge object");
                set(object, "coefficient", s(first_value(path_block, "research_cost_coeff")));
                set(object, "ignoreForLayout", boolean_value(first_value(path_block, "ignore_for_layout").as_deref()).map(Value::from));
                fragment.edges.push(e);
            }

            for xor in child_blocks(block, "xor") {
                for target in xor.scalars() {
                    if is_dynamic(&target.value) {
                        fragment.unresolved.push(dynamic_reference(cx, target, &id));
                    } else {
                        fragment.edges.push(edge(cx, "exclusive", &id, target));
                    }
                }
            }

            let mut sub_technologies: Vec<String> = Vec::new();
            for sub in child_blocks(block, "sub_technologies") {
                for target in sub.scalars() {
                    if is_dynamic(&target.value) {
                        fragment.unresolved.push(dynamic_reference(cx, target, &id));
                    } else {
                        sub_technologies.push(target.value.to_string());
                        fragment.edges.push(edge(cx, "sub_technology", &id, target));
                    }
                }
            }

            let mut unlock_signature: Vec<String> = Vec::new();
            let mut add_unlock = |fragment: &mut Fragment, kind: &str, target: &Scalar, level: Option<&str>| {
                if is_dynamic(&target.value) {
                    fragment.unresolved.push(unresolved(
                        "dynamic_reference",
                        &target.value,
                        Some(&id),
                        Some(cx.scalar_loc(target, &id)),
                        "TECH_DYNAMIC_UNLOCK_UNRESOLVED",
                        &format!("Dynamic unlock target {} cannot be resolved statically", target.value),
                    ));
                    return;
                }
                unlock_signature.push(format!("{kind}:{}:{}", target.value, level.unwrap_or("")));
                let mut identity = Map::new();
                identity.insert("technologyId".into(), id.clone().into());
                identity.insert("kind".into(), kind.into());
                identity.insert("targetId".into(), target.value.to_string().into());
                set(&mut identity, "level", level.map(Value::from));
                identity.insert("path".into(), cx.file.display_path.clone().into());
                identity.insert("offset".into(), cx.unit(target.start).into());
                let mut u = Map::new();
                u.insert("id".into(), deterministic_id("tech-unlock", &Value::Object(identity)).into());
                u.insert("technologyId".into(), id.clone().into());
                u.insert("kind".into(), kind.into());
                u.insert("targetId".into(), target.value.to_string().into());
                set(&mut u, "level", level.map(Value::from));
                u.insert("location".into(), cx.scalar_loc(target, &id));
                u.insert("confidence".into(), "confirmed".into());
                u.insert("resolved".into(), "unknown".into());
                fragment.unlocks.push(Value::Object(u));
            };
            for (field, kind) in [
                ("enable_equipments", "equipment"),
                ("enable_equipment_modules", "equipment_module"),
                ("enable_subunits", "sub_unit"),
                ("enable_abilities", "ability"),
            ] {
                for unlock_block in child_blocks(block, field) {
                    for target in unlock_block.scalars() {
                        add_unlock(fragment, kind, target, None);
                    }
                }
            }
            for building in child_blocks(block, "enable_building") {
                if let Some(target) = building.first_scalar("building") {
                    let level = first_value(building, "level");
                    add_unlock(fragment, "building", target, level.as_deref());
                }
            }
            for tactic in assignment_scalars(block, "enable_tactic") {
                add_unlock(fragment, "tactic", tactic, None);
            }
            for ability in assignment_scalars(block, "enable_ability") {
                add_unlock(fragment, "ability", ability, None);
            }
            for a in block.assignments() {
                if !a.key.value.starts_with("enable_") || STRUCTURAL.contains(&a.key.value.as_ref()) {
                    continue;
                }
                match &a.value {
                    Node::Scalar(v) => add_unlock(fragment, "other", v, None),
                    Node::Block(b) => {
                        for target in b.scalars() {
                            add_unlock(fragment, "other", target, None);
                        }
                    }
                }
            }

            let categories: Vec<String> = child_blocks(block, "categories").into_iter().flat_map(scalar_values).collect();
            let tags: Vec<String> = child_blocks(block, "tags").into_iter().flat_map(scalar_values).collect();
            let effect_keys = sorted_unique(
                block.assignments().map(|a| a.key.value.to_string()).filter(|k| !STRUCTURAL.contains(&k.as_str()) && !k.starts_with('@')).collect(),
            );
            let layout_expression = first_value(block, "force_use_small_tech_layout");
            let small = boolean_value(layout_expression.as_deref());
            let layout_size = if small == Some(true) { "small" } else { "unknown" };
            let mut unsupported: Vec<Value> = fragment
                .placements
                .iter()
                .filter(|p| p["technologyId"] == id.as_str() && (p.get("xExpression").is_some() || p.get("yExpression").is_some()))
                .map(|p| {
                    let part = |expr: &str, num: &str| {
                        p.get(expr).or_else(|| p.get(num)).map_or("?".to_string(), |v| v.as_str().map_or_else(|| canonical_json(v), str::to_string))
                    };
                    json!({
                        "field": "folder.position",
                        "expression": format!("{}:{}", part("xExpression", "x"), part("yExpression", "y")),
                        "location": p["location"],
                        "reason": "The source coordinate expression is not a resolvable file-local numeric constant",
                    })
                })
                .collect();
            if let Some(expression) = &layout_expression
                && boolean_value(Some(expression)).is_none()
            {
                unsupported.push(json!({
                    "field": "force_use_small_tech_layout",
                    "expression": expression,
                    "location": cx.loc(block.start, block.end, &id),
                    "reason": "The technology layout-size expression is not a literal yes or no",
                }));
            }
            let doctrine = boolean_value(first_value(block, "doctrine").as_deref()) == Some(true);
            let mut t = Map::new();
            t.insert("id".into(), id.clone().into());
            t.insert("kind".into(), (if doctrine { "legacy_doctrine" } else { "technology" }).into());
            t.insert("source".into(), source);
            t.insert("rawSource".into(), cx.text(definition.key.start, definition.end()).into());
            set(&mut t, "startYear", s(resolved_numeric_scalar(first_value(block, "start_year").as_deref(), &constants)));
            set(&mut t, "researchCost", s(resolved_numeric_scalar(first_value(block, "research_cost").as_deref(), &constants)));
            set(&mut t, "doctrineName", s(first_value(block, "doctrine_name")));
            t.insert("hidden".into(), hidden_status(block));
            t.insert("layoutSize".into(), layout_size.into());
            t.insert("folders".into(), sorted_unique(folders).into());
            t.insert("categories".into(), sorted_unique(categories).into());
            t.insert("tags".into(), sorted_unique(tags).into());
            t.insert("subTechnologies".into(), sorted_unique(sub_technologies).into());
            t.insert("ai".into(), ai_metadata(block));
            t.insert("iconSprite".into(), format!("GFX_{id}_medium").into());
            let mut signature: Vec<String> = effect_keys.clone();
            signature.extend(unlock_signature);
            signature.sort_by(|a, b| compare_code_units(a, b));
            t.insert("effectKeys".into(), effect_keys.into());
            t.insert("effectSignatureFields".into(), signature.into());
            t.insert("unsupportedFields".into(), unsupported.into());
            fragment.technologies.push(Value::Object(t));
        }
    }
}

fn parse_technology_tags(cx: &Ctx, root: &Block, fragment: &mut Fragment) {
    for (key, kind) in [("technology_categories", "category"), ("technology_tags", "tag")] {
        for block in child_blocks(root, key) {
            for scalar in block.scalars() {
                fragment.categories.push(json!({
                    "id": scalar.value.to_string(), "kind": kind,
                    "source": cx.provenance(scalar.start, scalar.end, &scalar.value),
                }));
            }
        }
    }
    for wrapper in child_blocks(root, "technology_folders") {
        for definition in wrapper.assignments() {
            let Node::Block(block) = &definition.value else { continue };
            let id = definition.key.value.to_string();
            let mut f = Map::new();
            f.insert("id".into(), id.clone().into());
            f.insert("doctrine".into(), (boolean_value(first_value(block, "doctrine").as_deref()) == Some(true)).into());
            set(&mut f, "ledger", s(first_value(block, "ledger")));
            if let Some(available) = child_blocks(block, "available").first() {
                f.insert("availableExpression".into(), cx.text(available.start, available.end).into());
            }
            f.insert("source".into(), cx.provenance(definition.key.start, definition.end(), &id));
            f.insert("localisation".into(), json!({ "language": "l_english", "status": "missing" }));
            fragment.folders.push(Value::Object(f));
        }
    }
}

fn parse_unlock_targets(cx: &Ctx, root: &Block, fragment: &mut Fragment) {
    let path = cx.normal.as_str();
    let mut wrappers: Vec<(&str, &str)> = Vec::new();
    if path.starts_with("common/units/equipment/modules/") {
        wrappers.push(("equipment_modules", "equipment_module"));
    } else if path.starts_with("common/units/equipment/") {
        wrappers.push(("equipments", "equipment"));
    }
    if path.starts_with("common/units/") && !path.starts_with("common/units/equipment/") {
        wrappers.push(("sub_units", "sub_unit"));
    }
    if path.starts_with("common/buildings/") {
        wrappers.push(("buildings", "building"));
    }
    if path.starts_with("common/abilities/") {
        wrappers.push(("ability", "ability"));
    }
    if path == "common/combat_tactics.txt" || path.starts_with("common/combat_tactics/") {
        wrappers.push(("combat_tactics", "tactic"));
    }
    for (key, kind) in wrappers {
        for wrapper in child_blocks(root, key) {
            for definition in wrapper.assignments() {
                if !matches!(definition.value, Node::Block(_)) || definition.key.value == "limit" {
                    continue;
                }
                let id = definition.key.value.to_string();
                fragment.unlock_targets.push(json!({
                    "id": format!("{kind}:{id}"), "kind": kind, "targetId": id,
                    "source": cx.provenance(definition.key.start, definition.end(), &id),
                }));
            }
        }
    }
}

fn doctrine_kind(path: &str) -> Option<&'static str> {
    if path.starts_with("common/doctrines/folders/") {
        Some("folder")
    } else if path.starts_with("common/doctrines/grand_doctrines/") {
        Some("grand_doctrine")
    } else if path.starts_with("common/doctrines/tracks/") {
        Some("track")
    } else if path.starts_with("common/doctrines/subdoctrines/") {
        Some("subdoctrine")
    } else {
        None
    }
}

fn parse_modern_doctrines(cx: &Ctx, root: &Block, fragment: &mut Fragment) {
    let Some(kind) = doctrine_kind(&cx.normal) else { return };
    for definition in root.assignments() {
        let Node::Block(block) = &definition.value else { continue };
        if definition.key.value.starts_with('@') {
            continue;
        }
        let id = definition.key.value.to_string();
        let mut track_ids: Vec<String> = assignment_scalars(block, "track").iter().map(|v| v.value.to_string()).collect();
        track_ids.extend(child_blocks(block, "track").into_iter().flat_map(scalar_values));
        track_ids.extend(child_blocks(block, "tracks").into_iter().flat_map(scalar_values));
        let exclusive_ids: Vec<String> = child_blocks(block, "xor").into_iter().flat_map(scalar_values).collect();
        let track_ids = sorted_unique(track_ids);
        let mut d = Map::new();
        d.insert("id".into(), id.clone().into());
        d.insert("kind".into(), kind.into());
        set(&mut d, "folderId", s(first_value(block, "folder")));
        d.insert("trackIds".into(), track_ids.clone().into());
        d.insert("exclusiveIds".into(), sorted_unique(exclusive_ids).into());
        set(&mut d, "nameKey", s(first_value(block, "name")));
        set(&mut d, "descriptionKey", s(first_value(block, "description")));
        set(&mut d, "xpCost", s(first_value(block, "xp_cost")));
        set(&mut d, "xpType", s(first_value(block, "xp_type")));
        d.insert("ai".into(), ai_metadata(block));
        let mut keys: Vec<String> = block.assignments().map(|a| a.key.value.to_string()).filter(|k| !DOCTRINE_STRUCTURAL.contains(&k.as_str())).collect();
        keys.sort_by(|a, b| compare_code_units(a, b));
        d.insert("effectKeys".into(), keys.into());
        d.insert("source".into(), cx.provenance(definition.key.start, definition.end(), &id));
        set(&mut d, "iconSprite", s(first_value(block, "icon")));
        fragment.doctrine_definitions.push(Value::Object(d));
        if kind != "subdoctrine" {
            continue;
        }
        for rewards in child_blocks(block, "rewards") {
            let mut index = 0;
            for entry in &rewards.entries {
                let (reward_id, reward_block, start, end) = match entry {
                    Entry::Scalar(_) => continue,
                    Entry::Assignment(a) => (a.key.value.to_string(), if let Node::Block(b) = &a.value { Some(b) } else { None }, a.key.start, a.end()),
                    Entry::Block(b) => (format!("{id}_reward_{}", index + 1), Some(b), b.start, b.end),
                };
                index += 1;
                let mut keys: Vec<String> = reward_block.map(|b| b.assignments().map(|a| a.key.value.to_string()).collect()).unwrap_or_default();
                keys.sort_by(|a, b| compare_code_units(a, b));
                fragment.doctrine_definitions.push(json!({
                    "id": reward_id, "kind": "reward", "trackIds": track_ids, "parentId": id, "exclusiveIds": [],
                    "ai": { "present": false, "zero": "unknown", "researchWeights": {} },
                    "effectKeys": keys, "source": cx.provenance(start, end, &reward_id),
                }));
            }
        }
    }
}

fn technology_folder_container(named: &[String]) -> Option<String> {
    named
        .iter()
        .rev()
        .find(|name| {
            let lower = name.to_ascii_lowercase();
            lower.match_indices("_folder").any(|(at, m)| matches!(lower.as_bytes().get(at + m.len()), None | Some(b'_')))
        })
        .cloned()
}

fn item_layout_name(name: &str) -> Option<(String, &'static str)> {
    let lower = name.to_ascii_lowercase();
    let middle = |suffix: &str| -> Option<String> {
        let inner = lower.strip_prefix("techtree_")?.strip_suffix(suffix)?;
        (!inner.is_empty()).then(|| name["techtree_".len()..name.len() - suffix.len()].to_string())
    };
    if let Some(folder) = middle("_small_item") {
        return Some((folder, "small"));
    }
    middle("_item").map(|folder| (folder, "large"))
}

fn fv_num(block: Option<&Block>, key: &str) -> Option<f64> {
    numeric_literal(block.and_then(|b| first_value(b, key)).as_deref())
}

fn xy_expression(position: Option<&Block>, local: Option<f64>, key: &str) -> Option<Value> {
    let p = position?;
    local.is_none().then(|| first_value(p, key).unwrap_or_else(|| "<missing>".into()).into())
}

struct GridFrame<'b, 'a> {
    block: &'b Block<'a>,
    containers: Vec<String>,
    offset_x: f64,
    offset_y: f64,
}

fn parse_gridboxes(cx: &Ctx, root: &Block, fragment: &mut Fragment) {
    if !cx.normal.ends_with(".gui") {
        return;
    }
    let mut stack = vec![GridFrame { block: root, containers: vec![], offset_x: 0.0, offset_y: 0.0 }];
    while let Some(current) = stack.pop() {
        for assignment in current.block.assignments() {
            let Node::Block(block) = &assignment.value else { continue };
            let element = assignment.key.value.to_lowercase();
            let name = block.first_scalar("name");
            let position = child_blocks(block, "position").first().copied();
            let local_x = fv_num(position, "x");
            let local_y = fv_num(position, "y");
            let abs_x = current.offset_x + local_x.unwrap_or(0.0);
            let abs_y = current.offset_y + local_y.unwrap_or(0.0);
            let folder_id = technology_folder_container(&current.containers);
            let background_sprite = first_value(block, "spriteType");
            let start = assignment.key.start;
            let end = assignment.end();
            let id_offset = cx.unit(start);
            if element == "containerwindowtype"
                && let Some(n) = name
                && n.value.ends_with("_folder")
            {
                let panel = child_blocks(block, "background").first().copied();
                if let Some(sprite) = panel.and_then(|p| first_value(p, "quadTextureSprite")) {
                    fragment.backgrounds.get_or_insert_with(Vec::new).push(json!({
                        "id": deterministic_id("tech-panel", &json!({ "name": n.value.to_string(), "path": cx.file.display_path, "offset": id_offset })),
                        "name": "folder_panel", "folderId": n.value.to_string(), "sprite": sprite,
                        "position": { "x": 0, "y": 0 }, "size": {},
                        "location": cx.loc(start, end, &n.value), "sourcePath": cx.file.display_path, "loadOrder": cx.file.load_order,
                    }));
                }
            }
            if element == "icontype"
                && let (Some(n), Some(folder), Some(sprite), Some(_), Some(_)) = (name, &folder_id, &background_sprite, local_x, local_y)
                && (n.value.ends_with("_techtree_bg") || sprite.ends_with("_techtree_bg"))
            {
                let size = child_blocks(block, "size").first().copied().or_else(|| child_blocks(current.block, "size").first().copied());
                let mut sz = Map::new();
                set(&mut sz, "width", fv_num(size, "width").map(number_value));
                set(&mut sz, "height", fv_num(size, "height").map(number_value));
                fragment.backgrounds.get_or_insert_with(Vec::new).push(json!({
                    "id": deterministic_id("tech-background", &json!({ "name": n.value.to_string(), "path": cx.file.display_path, "offset": id_offset })),
                    "name": n.value.to_string(), "folderId": folder, "sprite": sprite,
                    "position": { "x": number_value(abs_x), "y": number_value(abs_y) }, "size": sz,
                    "location": cx.loc(start, end, &n.value), "sourcePath": cx.file.display_path, "loadOrder": cx.file.load_order,
                }));
            }
            if element == "gridboxtype"
                && let Some(n) = name
                && n.value.ends_with("_tree")
            {
                let slot = child_blocks(block, "slotsize").first().copied();
                let width = fv_num(slot, "width");
                let height = fv_num(slot, "height");
                let mut pos = Map::new();
                set(&mut pos, "x", local_x.map(|_| number_value(abs_x)));
                set(&mut pos, "y", local_y.map(|_| number_value(abs_y)));
                set(&mut pos, "xExpression", xy_expression(position, local_x, "x"));
                set(&mut pos, "yExpression", xy_expression(position, local_y, "y"));
                let mut slot_size = Map::new();
                set(&mut slot_size, "width", width.map(number_value));
                set(&mut slot_size, "height", height.map(number_value));
                set(&mut slot_size, "widthExpression", xy_expression(slot, width, "width"));
                set(&mut slot_size, "heightExpression", xy_expression(slot, height, "height"));
                let mut g = Map::new();
                g.insert(
                    "id".into(),
                    deterministic_id("tech-gridbox", &json!({ "name": n.value.to_string(), "path": cx.file.display_path, "offset": id_offset })).into(),
                );
                g.insert("name".into(), n.value.to_string().into());
                set(&mut g, "folderId", s(folder_id.clone()));
                g.insert("position".into(), Value::Object(pos));
                g.insert("slotSize".into(), Value::Object(slot_size));
                set(&mut g, "format", s(first_value(block, "format")));
                g.insert("location".into(), cx.loc(start, end, &n.value));
                g.insert("sourcePath".into(), cx.file.display_path.clone().into());
                g.insert("loadOrder".into(), cx.file.load_order.into());
                fragment.gridboxes.push(Value::Object(g));
            }
            if element == "containerwindowtype"
                && let Some(n) = name
                && let Some((item_folder, layout_size)) = item_layout_name(&n.value)
            {
                let layout = ItemLayout { block, name: n, folder: &item_folder, layout_size, position, local_x, local_y, start, end, id_offset };
                fragment.item_layouts.push(item_layout(cx, &layout));
            }
            if element == "instanttextboxtype"
                && let (Some(n), Some(folder)) = (name, &folder_id)
            {
                let year = first_value(block, "text")
                    .filter(|t| t.len() == 4 && t.bytes().all(|b| b.is_ascii_digit()) && (t.starts_with("18") || t.starts_with("19") || t.starts_with("20")));
                if let (Some(year), Some(_), Some(_)) = (year, local_x, local_y) {
                    let year_number: u32 = year.parse().unwrap_or(0);
                    let mut style = Map::new();
                    set(&mut style, "fontName", s(first_value(block, "font")));
                    set(&mut style, "colour", s(first_value(block, "textColor")));
                    set(&mut style, "maxWidth", fv_num(Some(block), "maxWidth").map(number_value));
                    set(&mut style, "maxHeight", fv_num(Some(block), "maxHeight").map(number_value));
                    set(&mut style, "format", s(first_value(block, "format")));
                    set(&mut style, "orientation", s(first_value(block, "Orientation")));
                    fragment.year_markers.push(json!({
                        "id": deterministic_id("tech-year-marker", &json!({ "name": n.value.to_string(), "year": year_number, "path": cx.file.display_path, "offset": id_offset })),
                        "name": n.value.to_string(), "folderId": folder, "year": year_number,
                        "position": { "x": number_value(abs_x), "y": number_value(abs_y) }, "style": style,
                        "location": cx.loc(start, end, &n.value), "sourcePath": cx.file.display_path, "loadOrder": cx.file.load_order,
                    }));
                }
            }
            let positioned = element == "containerwindowtype" || element == "windowtype";
            let mut containers = current.containers.clone();
            if let (Some(n), true) = (name, positioned) {
                containers.push(n.value.to_string());
            }
            stack.push(GridFrame {
                block,
                containers,
                offset_x: if positioned { abs_x } else { current.offset_x },
                offset_y: if positioned { abs_y } else { current.offset_y },
            });
        }
    }
}

fn find_child<'b, 'a>(block: &'b Block<'a>, kind: &str, name: &str) -> Option<&'b Block<'a>> {
    child_blocks(block, kind).into_iter().find(|c| first_value(c, "name").as_deref() == Some(name))
}

struct ItemLayout<'b, 'a> {
    block: &'b Block<'a>,
    name: &'b Scalar<'a>,
    folder: &'b str,
    layout_size: &'b str,
    position: Option<&'b Block<'a>>,
    local_x: Option<f64>,
    local_y: Option<f64>,
    start: u32,
    end: u32,
    id_offset: u32,
}

fn item_layout(cx: &Ctx, item: &ItemLayout) -> Value {
    let block = item.block;
    let size = child_blocks(block, "size").first().copied();
    let width = fv_num(size, "width");
    let height = fv_num(size, "height");
    let mut slots: Vec<(u64, Value)> = Vec::new();
    for child in block.assignments() {
        let Node::Block(cb) = &child.value else { continue };
        if child.key.value.to_lowercase() != "containerwindowtype" {
            continue;
        }
        let slot_name = first_value(cb, "name").unwrap_or_default();
        let Some(digits) = slot_name.strip_prefix("sub_technology_slot_") else { continue };
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let sp = child_blocks(cb, "position").first().copied();
        let ss = child_blocks(cb, "size").first().copied();
        let (Some(x), Some(y), Some(w), Some(h)) = (fv_num(sp, "x"), fv_num(sp, "y"), fv_num(ss, "width"), fv_num(ss, "height")) else { continue };
        let sprite =
            child_blocks(cb, "iconType").into_iter().find(|i| first_value(i, "name").as_deref() == Some("picture")).and_then(|i| first_value(i, "spriteType"));
        let index: u64 = digits.parse().unwrap_or(0);
        let mut slot = Map::new();
        slot.insert("index".into(), index.into());
        slot.insert("position".into(), json!({ "x": number_value(x), "y": number_value(y) }));
        slot.insert("size".into(), json!({ "width": number_value(w), "height": number_value(h) }));
        set(&mut slot, "sprite", s(sprite));
        slots.push((index, Value::Object(slot)));
    }
    slots.sort_by_key(|(i, _)| *i);
    let background_sprite = child_blocks(block, "background").first().and_then(|b| first_value(b, "quadTextureSprite"));
    let icon = find_child(block, "iconType", "Icon");
    let icon_position = icon.and_then(|i| child_blocks(i, "position").first().copied());
    let (icon_x, icon_y) = (fv_num(icon_position, "x"), fv_num(icon_position, "y"));
    let design = find_child(block, "iconType", "can_assign_design_team_icon");
    let design_position = design.and_then(|i| child_blocks(i, "position").first().copied());
    let (design_x, design_y) = (fv_num(design_position, "x"), fv_num(design_position, "y"));
    let design_sprite = design.and_then(|d| first_value(d, "spriteType"));
    let name_box = find_child(block, "instantTextBoxType", "name");
    let name_position = name_box.and_then(|i| child_blocks(i, "position").first().copied());
    let (name_x, name_y) = (fv_num(name_position, "x"), fv_num(name_position, "y"));
    let name_max_width = fv_num(name_box, "maxWidth");

    let mut pos = Map::new();
    set(&mut pos, "x", item.local_x.map(number_value));
    set(&mut pos, "y", item.local_y.map(number_value));
    set(&mut pos, "xExpression", xy_expression(item.position, item.local_x, "x"));
    set(&mut pos, "yExpression", xy_expression(item.position, item.local_y, "y"));
    let mut sz = Map::new();
    set(&mut sz, "width", width.map(number_value));
    set(&mut sz, "height", height.map(number_value));
    set(&mut sz, "widthExpression", xy_expression(size, width, "width"));
    set(&mut sz, "heightExpression", xy_expression(size, height, "height"));
    let mut l = Map::new();
    l.insert(
        "id".into(),
        deterministic_id("tech-item-layout", &json!({ "name": item.name.value.to_string(), "path": cx.file.display_path, "offset": item.id_offset })).into(),
    );
    l.insert("name".into(), item.name.value.to_string().into());
    l.insert("folderId".into(), item.folder.into());
    l.insert("layoutSize".into(), item.layout_size.into());
    l.insert("position".into(), Value::Object(pos));
    l.insert("size".into(), Value::Object(sz));
    set(&mut l, "backgroundSprite", s(background_sprite));
    if let (Some(x), Some(y)) = (icon_x, icon_y) {
        l.insert(
            "iconPosition".into(),
            json!({ "x": number_value(x), "y": number_value(y), "centered": icon.is_some_and(|i| boolean_value(first_value(i, "centerposition").as_deref()) == Some(true)) }),
        );
    }
    if let (Some(x), Some(y), Some(sprite)) = (design_x, design_y, design_sprite) {
        l.insert("designTeamIcon".into(), json!({ "sprite": sprite, "x": number_value(x), "y": number_value(y) }));
    }
    if let (Some(x), Some(y)) = (name_x, name_y) {
        let mut np = Map::new();
        np.insert("x".into(), number_value(x));
        np.insert("y".into(), number_value(y));
        set(&mut np, "maxWidth", name_max_width.map(number_value));
        l.insert("namePosition".into(), Value::Object(np));
    }
    if !slots.is_empty() {
        l.insert("subTechnologySlots".into(), Value::Array(slots.into_iter().map(|(_, v)| v).collect()));
    }
    l.insert("location".into(), cx.loc(item.start, item.end, &item.name.value));
    l.insert("sourcePath".into(), cx.file.display_path.clone().into());
    l.insert("loadOrder".into(), cx.file.load_order.into());
    Value::Object(l)
}

fn initial_owner(file: &ScannedFile, normal: &str) -> Option<Owner> {
    if !normal.starts_with("history/countries/") {
        return None;
    }
    let rel = file.relative_path.replace('\\', "/");
    let base = rel.rsplit('/').next().unwrap_or("");
    let id: String = base.encode_utf16().take(3).map(|u| char::from_u32(u32::from(u)).unwrap_or('\u{fffd}')).collect::<String>().to_uppercase();
    Some(Owner { kind: "country_history", id })
}

fn next_owner(cx: &Ctx, a: &Assignment, depth: usize, ancestors: &[String], current: &Option<Owner>) -> Option<Owner> {
    let Node::Block(block) = &a.value else { return current.clone() };
    let path = cx.normal.as_str();
    let key = a.key.value.as_ref();
    if key == "focus"
        && let Some(id) = first_value(block, "id")
    {
        return Some(Owner { kind: "focus", id });
    }
    if EVENT_KEYS.contains(&key)
        && let Some(id) = first_value(block, "id")
    {
        return Some(Owner { kind: "event", id });
    }
    if path.starts_with("common/scripted_effects/") && depth == 0 {
        return Some(Owner { kind: "scripted_effect", id: key.to_string() });
    }
    if path.starts_with("common/on_actions/") && ancestors.last().map(String::as_str) == Some("on_actions") {
        return Some(Owner { kind: "on_action", id: key.to_string() });
    }
    if path.starts_with("common/decisions/") && depth == 1 && !DECISION_STRUCTURAL.contains(&key) {
        let mission =
            block.first_scalar("days_mission_timeout").is_some() || block.first_scalar("days_remove").is_some() || key.to_lowercase().contains("mission");
        return Some(Owner { kind: if mission { "mission" } else { "decision" }, id: key.to_string() });
    }
    if path.starts_with("common/ideas/") && ancestors.first().map(String::as_str) == Some("ideas") && !ancestors.is_empty() {
        return Some(Owner { kind: "idea", id: key.to_string() });
    }
    if path.starts_with("common/characters/") && !ancestors.is_empty() {
        return Some(Owner { kind: "character", id: key.to_string() });
    }
    if path.starts_with("history/countries/") && key == "1936.1.1" {
        return current.as_ref().map(|c| Owner { kind: "startup_effect", id: c.id.clone() });
    }
    current.clone()
}

fn reference_owner(file: &ScannedFile, owner: &Option<Owner>) -> Owner {
    owner.clone().unwrap_or_else(|| Owner { kind: "other", id: file.relative_path.replace('\\', "/") })
}

struct External<'a> {
    kind: &'a str,
    owner: &'a Owner,
    technology: Option<&'a str>,
    category: Option<&'a str>,
    expression: String,
    location: Value,
    confidence: &'a str,
    dynamic: bool,
    metadata: Value,
}

fn add_external(output: &mut Vec<Value>, e: External) {
    let mut identity = Map::new();
    identity.insert("kind".into(), e.kind.into());
    identity.insert("sourceKind".into(), e.owner.kind.into());
    identity.insert("sourceId".into(), e.owner.id.clone().into());
    set(&mut identity, "technologyId", e.technology.map(Value::from));
    set(&mut identity, "categoryId", e.category.map(Value::from));
    identity.insert("location".into(), e.location.clone());
    identity.insert("expression".into(), e.expression.clone().into());
    let mut out = Map::new();
    out.insert("id".into(), deterministic_id("tech-external", &Value::Object(identity)).into());
    out.insert("kind".into(), e.kind.into());
    out.insert("sourceKind".into(), e.owner.kind.into());
    out.insert("sourceId".into(), e.owner.id.clone().into());
    set(&mut out, "technologyId", e.technology.map(Value::from));
    set(&mut out, "categoryId", e.category.map(Value::from));
    out.insert("expression".into(), e.expression.into());
    out.insert("location".into(), e.location);
    let stack: Vec<String> = if e.owner.kind == "scripted_effect" { vec![e.owner.id.clone()] } else { vec![] };
    out.insert("helperStack".into(), stack.into());
    out.insert("confidence".into(), e.confidence.into());
    out.insert("dynamic".into(), e.dynamic.into());
    out.insert("metadata".into(), e.metadata);
    output.push(Value::Object(out));
}

struct RefFrame<'b, 'a> {
    block: &'b Block<'a>,
    depth: usize,
    ancestors: Vec<String>,
    owner: Option<Owner>,
}

fn helper_call(cx: &Ctx, owner: &Owner, key: &str, start: u32, end: u32) -> Value {
    json!({
        "id": deterministic_id("tech-helper-call", &json!({ "sourceKind": owner.kind, "sourceId": owner.id, "helperId": key, "path": cx.file.display_path, "offset": cx.unit(start) })),
        "sourceKind": owner.kind, "sourceId": owner.id, "helperId": key,
        "location": cx.loc(start, end, &owner.id), "confidence": "high",
    })
}

fn parse_external_references(cx: &Ctx, root: &Block, fragment: &mut Fragment, context: &Context) {
    let mut stack = vec![RefFrame { block: root, depth: 0, ancestors: vec![], owner: initial_owner(cx.file, &cx.normal) }];
    while let Some(current) = stack.pop() {
        let assignments: Vec<&Assignment> = current.block.assignments().collect();
        for assignment in assignments.into_iter().rev() {
            let key = assignment.key.value.as_ref();
            let current_owner = reference_owner(cx.file, &current.owner);
            let (a_start, a_end) = (assignment.key.start, assignment.end());
            let block = match &assignment.value {
                Node::Scalar(target) => {
                    if matches!(key, "has_tech" | "has_technology" | "is_researching_technology") {
                        let dynamic = is_dynamic(&target.value);
                        add_external(
                            &mut fragment.external_references,
                            External {
                                kind: "reference",
                                owner: &current_owner,
                                technology: Some(&target.value),
                                category: None,
                                expression: cx.text(a_start, a_end),
                                location: cx.scalar_loc(target, &current_owner.id),
                                confidence: if dynamic { "unresolved" } else { "confirmed" },
                                dynamic,
                                metadata: json!({ "trigger": key }),
                            },
                        );
                    }
                    if current.depth > 0 && context.helper_ids.contains(key) && !(current_owner.kind == "scripted_effect" && current_owner.id == key) {
                        fragment.helper_calls.push(helper_call(cx, &current_owner, key, a_start, a_end));
                    }
                    continue;
                }
                Node::Block(b) => b,
            };
            let owner = next_owner(cx, assignment, current.depth, &current.ancestors, &current.owner);
            let selected = reference_owner(cx.file, &owner);
            if key == "set_technology" {
                for target in block.assignments() {
                    if target.key.value == "popup" {
                        continue;
                    }
                    let target_id = target.key.value.to_string();
                    let expression = cx.text(target.key.start, target.end());
                    let location = cx.assignment_loc(target, &selected.id);
                    if is_dynamic(&target_id) {
                        fragment.unresolved.push(unresolved(
                            "dynamic_reference",
                            &expression,
                            Some(&selected.id),
                            Some(location),
                            "TECH_DYNAMIC_GRANT_UNRESOLVED",
                            "Dynamic set_technology target cannot be resolved statically",
                        ));
                        continue;
                    }
                    let value = match &target.value {
                        Node::Scalar(v) => v.value.to_string(),
                        Node::Block(_) => expression.clone(),
                    };
                    let removal = value == "0" || value.to_lowercase() == "no";
                    let kind = if selected.kind == "country_history" || selected.kind == "startup_effect" {
                        "starting_technology"
                    } else if removal {
                        "remove"
                    } else {
                        "grant"
                    };
                    add_external(
                        &mut fragment.external_references,
                        External {
                            kind,
                            owner: &selected,
                            technology: Some(&target_id),
                            category: None,
                            expression,
                            location,
                            confidence: "confirmed",
                            dynamic: false,
                            metadata: json!({ "value": value }),
                        },
                    );
                }
            }
            if key == "add_tech_bonus" || key == "add_doctrine_cost_reduction" {
                let technology = assignment_scalars(block, "technology");
                let category = assignment_scalars(block, "category");
                for (target, is_technology) in technology.iter().map(|t| (*t, true)).chain(category.iter().map(|t| (*t, false))) {
                    let expression = cx.text(target.start, target.end);
                    let location = cx.scalar_loc(target, &selected.id);
                    if is_dynamic(&target.value) {
                        fragment.unresolved.push(unresolved(
                            "dynamic_reference",
                            &expression,
                            Some(&selected.id),
                            Some(location),
                            "TECH_DYNAMIC_BONUS_UNRESOLVED",
                            "Dynamic research-bonus target cannot be resolved statically",
                        ));
                        continue;
                    }
                    let null_or = |v: Option<String>| v.map_or(Value::Null, Value::from);
                    add_external(
                        &mut fragment.external_references,
                        External {
                            kind: "research_bonus",
                            owner: &selected,
                            technology: is_technology.then_some(target.value.as_ref()),
                            category: (!is_technology).then_some(target.value.as_ref()),
                            expression,
                            location,
                            confidence: "confirmed",
                            dynamic: false,
                            metadata: json!({
                                "effect": key,
                                "bonus": null_or(first_value(block, "bonus").or_else(|| first_value(block, "cost_reduction"))),
                                "uses": null_or(first_value(block, "uses")),
                                "aheadReduction": null_or(first_value(block, "ahead_reduction")),
                            }),
                        },
                    );
                }
            }
            if key == "research_bonus" {
                for target in block.assignments() {
                    let Node::Scalar(v) = &target.value else { continue };
                    let dynamic = is_dynamic(&target.key.value);
                    add_external(
                        &mut fragment.external_references,
                        External {
                            kind: "research_bonus",
                            owner: &selected,
                            technology: None,
                            category: Some(&target.key.value),
                            expression: cx.text(target.key.start, target.end()),
                            location: cx.assignment_loc(target, &selected.id),
                            confidence: if dynamic { "unresolved" } else { "confirmed" },
                            dynamic,
                            metadata: json!({ "value": v.value.to_string(), "effect": "research_bonus" }),
                        },
                    );
                }
            }
            if key == "technology_sharing_group" {
                let sharing_id = first_value(block, "id").unwrap_or_else(|| format!("{}:{}", cx.file.display_path, cx.unit(a_start)));
                let sharing_owner = Owner { kind: "technology_sharing", id: sharing_id.clone() };
                for categories in child_blocks(block, "categories") {
                    for category in categories.scalars() {
                        let dynamic = is_dynamic(&category.value);
                        add_external(
                            &mut fragment.external_references,
                            External {
                                kind: "technology_sharing",
                                owner: &sharing_owner,
                                technology: None,
                                category: Some(&category.value),
                                expression: cx.text(category.start, category.end),
                                location: cx.scalar_loc(category, &sharing_id),
                                confidence: if dynamic { "unresolved" } else { "confirmed" },
                                dynamic,
                                metadata: json!({}),
                            },
                        );
                    }
                }
            }
            if current.depth > 0 && context.helper_ids.contains(key) && !(selected.kind == "scripted_effect" && selected.id == key) {
                fragment.helper_calls.push(helper_call(cx, &selected, key, a_start, a_end));
            }
            let mut ancestors = current.ancestors.clone();
            ancestors.push(key.to_string());
            stack.push(RefFrame { block, depth: current.depth + 1, ancestors, owner });
        }
    }
}

/// `analyzeTechnologySource`: the fragment of one file, as JSON.
pub fn analyze_source(file: &ScannedFile, bytes: &[u8], context: &Context) -> Value {
    let mut fragment = Fragment::default();
    let lower = file.relative_path.to_lowercase();
    if !(lower.ends_with(".txt") || lower.ends_with(".gui") || lower.ends_with(".gfx")) || !bytes.contains(&b'=') {
        return fragment.into_value(file);
    }
    let (text, lossy) = decode(bytes);
    let loss = if lossy { windows_1252_loss(bytes) } else { None };
    let document = parse_clausewitz_detailed(&text, bytes.len(), loss.as_ref());
    let pos = Positions::new(&text);
    let limits = document.diagnostics.retained_limits();
    if !limits.is_empty() {
        let limit_diagnostics: Vec<Value> = limits.iter().map(|d| pos.diagnostic(&file.display_path, d)).collect();
        let location = limit_diagnostics.iter().find_map(|d| d.get("location").cloned());
        fragment.unresolved.push(unresolved(
            "partial_source",
            &file.display_path,
            None,
            location,
            "TECH_SOURCE_PARTIAL",
            "Technology analysis skipped a source that exceeded a shared parser limit",
        ));
        fragment.diagnostics = limit_diagnostics;
        return fragment.into_value(file);
    }
    fragment.diagnostics = document.diagnostics.retained().iter().map(|d| pos.diagnostic(&file.display_path, d)).collect();
    let normal = file.relative_path.replace('\\', "/").to_lowercase();
    let cx = Ctx { file, text: &text, pos: &pos, normal };
    let root = &document.root;
    if cx.normal.starts_with("common/technologies/") {
        parse_technology_definitions(&cx, root, &mut fragment);
    }
    if cx.normal.starts_with("common/technology_tags/") {
        parse_technology_tags(&cx, root, &mut fragment);
    }
    parse_unlock_targets(&cx, root, &mut fragment);
    parse_modern_doctrines(&cx, root, &mut fragment);
    parse_gridboxes(&cx, root, &mut fragment);
    parse_external_references(&cx, root, &mut fragment, context);
    fragment.into_value(file)
}

/// `technologySourceFiles`: the active files technology analysis reads, by display path.
pub fn source_files(files: &[ScannedFile]) -> Vec<&ScannedFile> {
    const PREFIXES: [&str; 15] = [
        "common/technologies/",
        "common/technology_tags/",
        "common/technology_sharing/",
        "common/doctrines/",
        "common/units/",
        "common/buildings/",
        "common/abilities/",
        "common/national_focus/",
        "common/decisions/",
        "common/scripted_effects/",
        "common/on_actions/",
        "common/ideas/",
        "common/characters/",
        "events/",
        "history/countries/",
    ];
    let mut selected: Vec<&ScannedFile> = files
        .iter()
        .filter(|f| {
            if f.shadowed_by.is_some() {
                return false;
            }
            let path = f.relative_path.replace('\\', "/").to_lowercase();
            PREFIXES.iter().any(|p| path.starts_with(p)) || (path.starts_with("interface/") && path.ends_with(".gui")) || path == "common/combat_tactics.txt"
        })
        .collect();
    selected.sort_by(|a, b| compare_code_units(&a.display_path, &b.display_path));
    selected
}
