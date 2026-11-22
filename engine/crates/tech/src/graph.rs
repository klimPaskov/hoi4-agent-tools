//! Technology graph assembly and diagnosis.
//!
//! Ported from `src/hoi4_agent_tools/technology/graph.ts` (`technologyGraphAnalysis` and its
//! helpers) and the helper-reference walk of `src/hoi4_agent_tools/core/dependency-walk.ts`
//! (`DependencyWalk.advance`, path policy), commit `9b7dc80d`. Records stay JSON objects with the
//! TypeScript wire shape. The symbol index lookups (sprites, localisation, whether a source of a
//! kind was skipped) arrive from the caller as plain tables.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use hoi4_core::canonical::{compare_code_units, hash_canonical};
use hoi4_core::files::ScannedFile;
use serde_json::{Map, Value, json};

use crate::queries::Refusal;
use crate::source_analysis::{deterministic_id, number_value};

const MAX_TECHNOLOGIES: usize = 100_000;
const MAX_EDGES: usize = 500_000;
const MAX_EXTERNAL_REFERENCES: usize = 1_000_000;
const MAX_ISSUES: usize = 100_000;
const MAX_HELPER_DEPTH: usize = 64;
const MAX_HELPER_PROJECTIONS: usize = 500_000;
const MAX_FULL_HELPER_CALLS: usize = 4_096;
const MAX_WALK_STEPS: u64 = 10_000_000;

pub const SCHEMA_VERSION: u64 = 2;
pub const PARSER_VERSION: &str = "clausewitz-cst.v1";

/// What the TypeScript `SymbolIndex` answered for the graph.
#[derive(Default)]
pub struct Lookups {
    /// Active sprites by name: the file defining it and its texture.
    pub sprites: HashMap<String, (String, Option<String>)>,
    pub skipped_sprite_source: bool,
    /// Active English localisation values by key.
    pub localisation: HashMap<String, String>,
    pub skipped_localisation_source: bool,
}

pub struct Scan {
    pub workspace_id: String,
    pub workspace_identity: String,
    pub revision: String,
    pub complete: bool,
    pub skipped_source_count: u64,
    pub skipped_sources: Value,
    pub diagnostics: Vec<Value>,
    pub files: Vec<ScannedFile>,
    pub asset_files: Vec<ScannedFile>,
    pub analysis_mode: Option<String>,
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn offset(value: &Value) -> i64 {
    value["location"]["start"]["offset"].as_i64().unwrap_or(0)
}

fn units(left: &str, right: &str) -> Ordering {
    compare_code_units(left, right)
}

fn id_of(value: &Value) -> &str {
    text(value, "id").unwrap_or("")
}

/// A map that keeps the order its keys were first seen in, as a JavaScript `Map` does.
struct Groups<T> {
    order: Vec<String>,
    values: HashMap<String, Vec<T>>,
}

impl<T> Groups<T> {
    fn new() -> Self {
        Groups { order: Vec::new(), values: HashMap::new() }
    }

    fn push(&mut self, key: String, value: T) {
        if !self.values.contains_key(&key) {
            self.order.push(key.clone());
        }
        self.values.entry(key).or_default().push(value);
    }

    fn get(&self, key: &str) -> &[T] {
        self.values.get(key).map_or(&[], Vec::as_slice)
    }

    fn into_groups(mut self) -> Vec<Vec<T>> {
        self.order.iter().filter_map(|k| self.values.remove(k)).collect()
    }
}

fn source_key(source: &Value) -> String {
    format!("{}:{}", text(source, "path").unwrap_or(""), source["location"]["start"]["offset"].as_i64().unwrap_or(0))
}

/// `activeDefinitions`: the highest load order per id, with same-level duplicates reported.
fn active_definitions(values: Vec<Value>) -> (Vec<Value>, Vec<Vec<Value>>) {
    let mut groups = Groups::new();
    for value in values {
        groups.push(id_of(&value).to_string(), value);
    }
    let mut active = Vec::new();
    let mut duplicates = Vec::new();
    for mut group in groups.into_groups() {
        group.sort_by(|l, r| {
            r["source"]["loadOrder"].as_i64().cmp(&l["source"]["loadOrder"].as_i64()).then_with(|| units(&source_key(&l["source"]), &source_key(&r["source"])))
        });
        let maximum = group[0]["source"]["loadOrder"].as_i64();
        let same: Vec<Value> = group.into_iter().filter(|v| v["source"]["loadOrder"].as_i64() == maximum).collect();
        active.push(same[0].clone());
        if same.len() > 1 {
            duplicates.push(same);
        }
    }
    active.sort_by(|l, r| units(id_of(l), id_of(r)));
    duplicates.sort_by(|l, r| units(id_of(&l[0]), id_of(&r[0])));
    (active, duplicates)
}

fn normalized_asset_path(value: &str) -> String {
    let mut out = value.replace('\\', "/");
    while out.contains("//") {
        out = out.replace("//", "/");
    }
    out.strip_prefix("./").unwrap_or(&out).to_lowercase()
}

fn asset_map(files: &[ScannedFile]) -> HashSet<String> {
    files.iter().filter(|f| f.shadowed_by.is_none()).map(|f| normalized_asset_path(&f.relative_path)).collect()
}

fn icon_status(sprite: &str, lookups: &Lookups, assets: &HashSet<String>) -> Value {
    let Some((path, texture)) = lookups.sprites.get(sprite) else {
        return json!({ "sprite": sprite, "status": if lookups.skipped_sprite_source { "partial" } else { "missing_sprite" } });
    };
    let Some(texture) = texture else {
        return json!({ "sprite": sprite, "spritePath": path, "status": "missing_texture" });
    };
    json!({
        "sprite": sprite, "spritePath": path, "texturePath": texture,
        "status": if assets.contains(&normalized_asset_path(texture)) { "resolved" } else { "missing_texture" },
    })
}

fn localisation_status(name: Option<&String>, description: Option<&String>, partial: bool) -> &'static str {
    if name.is_some() && description.is_some() {
        "resolved"
    } else if partial {
        "partial"
    } else {
        "missing"
    }
}

fn localise_technology(mut technology: Value, lookups: &Lookups, assets: &HashSet<String>) -> Value {
    let object = technology.as_object_mut().expect("technology object");
    let icon_sprite = object.remove("iconSprite").and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
    let fields: Vec<String> = object.remove("effectSignatureFields").and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    let id = object.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let description_key = format!("{id}_desc");
    let name = lookups.localisation.get(&id);
    let description = lookups.localisation.get(&description_key);
    let mut localisation = Map::new();
    localisation.insert("language".into(), "l_english".into());
    localisation.insert("nameKey".into(), id.clone().into());
    localisation.insert("descriptionKey".into(), description_key.into());
    if let Some(n) = name {
        localisation.insert("name".into(), n.clone().into());
    }
    if let Some(d) = description {
        localisation.insert("description".into(), d.clone().into());
    }
    localisation.insert("status".into(), localisation_status(name, description, lookups.skipped_localisation_source).into());
    object.insert("icon".into(), icon_status(&icon_sprite, lookups, assets));
    object.insert("localisation".into(), Value::Object(localisation));
    object.insert("effectSignature".into(), hash_canonical(&json!(fields)).into());
    technology
}

fn localise_folder(mut folder: Value, lookups: &Lookups) -> Value {
    let id = id_of(&folder).to_string();
    let name = lookups.localisation.get(&id);
    let description = lookups.localisation.get(&format!("{id}_desc"));
    let mut localisation = Map::new();
    localisation.insert("language".into(), "l_english".into());
    if let Some(n) = name {
        localisation.insert("name".into(), n.clone().into());
    }
    if let Some(d) = description {
        localisation.insert("description".into(), d.clone().into());
    }
    localisation.insert("status".into(), localisation_status(name, description, lookups.skipped_localisation_source).into());
    folder["localisation"] = Value::Object(localisation);
    folder
}

fn localise_doctrine(mut definition: Value, lookups: &Lookups, assets: &HashSet<String>) -> Value {
    let object = definition.as_object_mut().expect("doctrine object");
    if let Some(sprite) = object.remove("iconSprite").and_then(|v| v.as_str().map(str::to_string)) {
        object.insert("icon".into(), icon_status(&sprite, lookups, assets));
    }
    definition
}

/// `selectOwnedRecords`.
fn select_owned(values: Vec<Value>, owner: &str, active: &HashMap<String, String>) -> Vec<Value> {
    values.into_iter().filter(|v| active.get(text(v, owner).unwrap_or("")).map(String::as_str) == v["location"]["path"].as_str()).collect()
}

fn active_by_group(values: Vec<Value>, key: impl Fn(&Value) -> String, order: impl Fn(&Value, &Value) -> Ordering) -> Vec<Value> {
    let mut groups = Groups::new();
    for value in values {
        groups.push(key(&value), value);
    }
    let mut out: Vec<Value> = groups
        .into_groups()
        .into_iter()
        .map(|mut group| {
            group.sort_by(|l, r| {
                r["loadOrder"].as_i64().cmp(&l["loadOrder"].as_i64()).then_with(|| units(text(l, "sourcePath").unwrap_or(""), text(r, "sourcePath").unwrap_or(""))).then_with(|| offset(l).cmp(&offset(r)))
            });
            group.swap_remove(0)
        })
        .collect();
    out.sort_by(|l, r| order(l, r));
    out
}

fn num(value: &Value) -> Option<f64> {
    value.as_f64()
}

#[allow(clippy::too_many_lines)]
fn enrich_placements(placements: Vec<Value>, edges: &[Value], gridboxes: &[Value], technologies: &[Value], unlocks: &[Value], layouts: &[Value]) -> Vec<Value> {
    let by_id: HashMap<&str, &Value> = technologies.iter().map(|t| (id_of(t), t)).collect();
    let mut unlock_kinds: HashMap<&str, HashSet<&str>> = HashMap::new();
    for unlock in unlocks {
        unlock_kinds.entry(text(unlock, "technologyId").unwrap_or("")).or_default().insert(text(unlock, "kind").unwrap_or(""));
    }
    let mut layouts_by_folder: HashMap<&str, HashMap<&str, &Value>> = HashMap::new();
    for layout in layouts {
        layouts_by_folder.entry(text(layout, "folderId").unwrap_or("")).or_default().insert(text(layout, "layoutSize").unwrap_or(""), layout);
    }
    let mut placements_by_tech: HashMap<&str, Vec<&Value>> = HashMap::new();
    for p in &placements {
        placements_by_tech.entry(text(p, "technologyId").unwrap_or("")).or_default().push(p);
    }
    let mut parents: HashMap<&str, Vec<&str>> = HashMap::new();
    for e in edges.iter().filter(|e| text(e, "kind") == Some("prerequisite") && e["ignoreForLayout"] != true) {
        parents.entry(text(e, "to").unwrap_or("")).or_default().push(text(e, "from").unwrap_or(""));
    }
    let roots_for = |technology: &str, folder: &str| -> Vec<String> {
        let mut roots: HashSet<&str> = HashSet::new();
        let mut pending = vec![technology];
        let mut visited: HashSet<&str> = HashSet::new();
        while let Some(current) = pending.pop() {
            if !visited.insert(current) {
                continue;
            }
            let current_parents = parents.get(current).map_or(&[][..], Vec::as_slice);
            if current_parents.is_empty() {
                if current == technology || placements_by_tech.get(current).is_some_and(|ps| ps.iter().any(|p| text(p, "folderId") == Some(folder))) {
                    roots.insert(current);
                }
                continue;
            }
            pending.extend(current_parents.iter().copied());
        }
        let mut out: Vec<String> = roots.into_iter().map(str::to_string).collect();
        out.sort_by(|a, b| units(a, b));
        out
    };
    placements
        .iter()
        .map(|placement| {
            let technology_id = text(placement, "technologyId").unwrap_or("");
            let folder_id = text(placement, "folderId").unwrap_or("");
            let roots = roots_for(technology_id, folder_id);
            let branch_root = (roots.len() == 1).then(|| roots[0].clone());
            let expected = format!("{}_tree", branch_root.as_deref().unwrap_or(technology_id));
            let gridbox = gridboxes.iter().find(|g| text(g, "name") == Some(&expected) && g.get("folderId").is_none_or(|f| f.as_str() == Some(folder_id)));
            let technology = by_id.get(technology_id);
            let folder_layouts = layouts_by_folder.get(folder_id);
            let kinds = unlock_kinds.get(technology_id);
            let unlocks_equipment = kinds.is_some_and(|k| k.contains("equipment") || k.contains("equipment_module"));
            let small = technology.is_some_and(|t| text(t, "layoutSize") == Some("small")) || (folder_layouts.is_some_and(|l| l.contains_key("small")) && !unlocks_equipment);
            let layout_size = if small { "small" } else { "large" };
            let item_layout = folder_layouts.and_then(|l| l.get(layout_size).or_else(|| l.get("large")));
            let (mut pixel_x, mut pixel_y) = (None, None);
            if let (Some(g), Some(x), Some(y)) = (gridbox, num(&placement["x"]), num(&placement["y"]))
                && let (Some(gx), Some(gy), Some(w), Some(h)) = (num(&g["position"]["x"]), num(&g["position"]["y"]), num(&g["slotSize"]["width"]), num(&g["slotSize"]["height"]))
            {
                match text(g, "format").unwrap_or("UP").to_uppercase().as_str() {
                    "LEFT" => {
                        pixel_x = Some(gx + y * w);
                        pixel_y = Some(gy + x * h);
                    }
                    "UP" => {
                        pixel_x = Some(gx + x * w);
                        pixel_y = Some(gy + y * h);
                    }
                    _ => {}
                }
            }
            let mut out = placement.as_object().cloned().unwrap_or_default();
            if let Some(root) = &branch_root {
                out.insert("branchRootId".into(), root.clone().into());
            }
            if let Some(g) = gridbox {
                out.insert("gridboxId".into(), g["id"].clone());
            }
            if let Some(px) = pixel_x {
                out.insert("pixelX".into(), number_value(px));
            }
            if let Some(py) = pixel_y {
                out.insert("pixelY".into(), number_value(py));
            }
            out.insert("layoutSize".into(), layout_size.into());
            if let Some(l) = item_layout {
                out.insert("itemLayoutId".into(), l["id"].clone());
                for (key, value) in [("layoutWidth", &l["size"]["width"]), ("layoutHeight", &l["size"]["height"]), ("layoutOffsetX", &l["position"]["x"]), ("layoutOffsetY", &l["position"]["y"])] {
                    if !value.is_null() {
                        out.insert(key.into(), value.clone());
                    }
                }
            }
            let status = if pixel_x.is_some() && pixel_y.is_some() {
                "source_pixel"
            } else if placement.get("x").is_some() && placement.get("y").is_some() {
                "source_coordinate"
            } else {
                "unresolved"
            };
            out.insert("geometryStatus".into(), status.into());
            Value::Object(out)
        })
        .collect()
}

struct Issue {
    code: &'static str,
    classification: &'static str,
    severity: &'static str,
    message: String,
    confidence: String,
    location: Option<Value>,
    related: Option<Vec<Value>>,
    blockers: Vec<Value>,
    details: Value,
}

fn add_issue(issues: &mut Vec<Value>, issue: Issue) {
    if issues.len() >= MAX_ISSUES {
        return;
    }
    let mut out = Map::new();
    out.insert("code".into(), issue.code.into());
    out.insert("classification".into(), issue.classification.into());
    out.insert("severity".into(), issue.severity.into());
    out.insert("message".into(), issue.message.into());
    out.insert("confidence".into(), issue.confidence.into());
    if let Some(l) = issue.location {
        out.insert("location".into(), l);
    }
    if let Some(r) = issue.related {
        out.insert("related".into(), Value::Array(r));
    }
    out.insert("blockers".into(), Value::Array(issue.blockers));
    out.insert("details".into(), issue.details);
    issues.push(Value::Object(out));
}

fn issue(code: &'static str, classification: &'static str, severity: &'static str, message: String, confidence: &str, location: Option<Value>, details: Value) -> Issue {
    Issue { code, classification, severity, message, confidence: confidence.into(), location, related: None, blockers: vec![], details }
}

fn stable_issues(issues: Vec<Value>) -> Vec<Value> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<Value> = Vec::new();
    for issue in issues {
        let key = hash_canonical(&json!({ "code": issue["code"], "classification": issue["classification"], "location": issue.get("location"), "details": issue["details"] }));
        if seen.insert(key) {
            out.push(issue);
        }
    }
    out.sort_by(|l, r| {
        let path = |v: &Value| v["location"]["path"].as_str().unwrap_or("").to_string();
        let start = |v: &Value| v["location"]["start"]["offset"].as_i64().unwrap_or(0);
        units(text(l, "code").unwrap_or(""), text(r, "code").unwrap_or("")).then_with(|| units(&path(l), &path(r))).then_with(|| start(l).cmp(&start(r)))
    });
    out
}

/// `stronglyConnectedComponents` over prerequisite edges (Kosaraju, sorted adjacency).
fn strongly_connected(node_ids: &[String], edges: &[Value]) -> Vec<Vec<String>> {
    let index: HashMap<&str, usize> = node_ids.iter().enumerate().map(|(i, n)| (n.as_str(), i)).collect();
    let mut adjacency: Vec<Vec<&str>> = vec![Vec::new(); node_ids.len()];
    let mut reverse: Vec<Vec<&str>> = vec![Vec::new(); node_ids.len()];
    for edge in edges.iter().filter(|e| text(e, "kind") == Some("prerequisite")) {
        let (from, to) = (text(edge, "from").unwrap_or(""), text(edge, "to").unwrap_or(""));
        let (Some(&f), Some(&t)) = (index.get(from), index.get(to)) else { continue };
        adjacency[f].push(to);
        reverse[t].push(from);
    }
    for list in adjacency.iter_mut().chain(reverse.iter_mut()) {
        list.sort_by(|a, b| units(a, b));
    }
    let mut starts: Vec<&str> = node_ids.iter().map(String::as_str).collect();
    starts.sort_by(|a, b| units(a, b));
    let mut visited: HashSet<&str> = HashSet::new();
    let mut order: Vec<&str> = Vec::new();
    for start in starts {
        if visited.contains(start) {
            continue;
        }
        let mut stack: Vec<(&str, usize)> = vec![(start, 0)];
        visited.insert(start);
        while let Some(frame) = stack.last_mut() {
            let targets = &adjacency[index[frame.0]];
            match targets.get(frame.1) {
                None => {
                    order.push(frame.0);
                    stack.pop();
                }
                Some(&target) => {
                    frame.1 += 1;
                    if visited.insert(target) {
                        stack.push((target, 0));
                    }
                }
            }
        }
    }
    let mut assigned: HashSet<&str> = HashSet::new();
    let mut components: Vec<Vec<String>> = Vec::new();
    for start in order.into_iter().rev() {
        if assigned.contains(start) {
            continue;
        }
        let mut component: Vec<String> = Vec::new();
        let mut stack = vec![start];
        assigned.insert(start);
        while let Some(current) = stack.pop() {
            component.push(current.to_string());
            for &target in &reverse[index[current]] {
                if assigned.insert(target) {
                    stack.push(target);
                }
            }
        }
        component.sort_by(|a, b| units(a, b));
        components.push(component);
    }
    components.sort_by(|l, r| units(l.first().map_or("", String::as_str), r.first().map_or("", String::as_str)));
    components
}

fn confidence_rank(value: &str) -> u8 {
    match value {
        "confirmed" => 0,
        "high" => 1,
        "medium" => 2,
        "low" => 3,
        _ => 4,
    }
}

fn worse<'a>(left: &'a str, right: &'a str) -> &'a str {
    if confidence_rank(left) >= confidence_rank(right) { left } else { right }
}

/// A visit or depth record of the helper walk: the calls from the root call to it.
struct WalkRecord {
    kind: &'static str,
    root: usize,
    path: Vec<usize>,
}

/// `DependencyWalk` with the `path` policy: every route through the scripted-effect call
/// network from each root call, up to `MAX_HELPER_DEPTH` calls deep.
fn walk_helper_calls(calls: &[Value]) -> Result<Vec<WalkRecord>, Refusal> {
    let from = |c: &Value| format!("{}:{}", text(c, "sourceKind").unwrap_or(""), text(c, "sourceId").unwrap_or(""));
    let to = |c: &Value| format!("scripted_effect:{}", text(c, "helperId").unwrap_or(""));
    let mut outgoing: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, c) in calls.iter().enumerate() {
        outgoing.entry(from(c)).or_default().push(i);
    }
    let branches: HashSet<String> = calls.iter().map(&to).collect();
    let roots: Vec<usize> = calls.iter().enumerate().filter(|(_, c)| text(c, "sourceKind") != Some("scripted_effect")).map(|(i, _)| i).collect();
    let mut records: Vec<WalkRecord> = Vec::new();
    let mut steps: u64 = 0;
    let limit = |steps: u64, root: usize, total: usize| -> Result<(), Refusal> {
        if steps >= MAX_WALK_STEPS {
            return Err(Refusal {
                code: "DEPENDENCY_WORK_LIMIT",
                message: "Dependency expansion reached its explicit work ceiling".into(),
                details: json!({ "maximum": MAX_WALK_STEPS, "completedRoots": root, "totalRoots": total }),
            });
        }
        Ok(())
    };
    for (root_index, &root_call) in roots.iter().enumerate() {
        limit(steps, root_index, roots.len())?;
        steps += 1;
        // `paths[i]` is (call, parent path).
        let mut paths: Vec<(usize, Option<usize>)> = vec![(root_call, None)];
        let mut stack: Vec<usize> = vec![0];
        let mut visited: HashSet<String> = HashSet::new();
        let route = |paths: &[(usize, Option<usize>)], mut cursor: Option<usize>| -> Vec<usize> {
            let mut calls_on_route = Vec::new();
            while let Some(c) = cursor {
                calls_on_route.push(paths[c].0);
                cursor = paths[c].1;
            }
            calls_on_route.reverse();
            calls_on_route
        };
        loop {
            limit(steps, root_index, roots.len())?;
            steps += 1;
            let Some(path) = stack.pop() else { break };
            let on_route = route(&paths, Some(path));
            let key = on_route.iter().map(|&c| to(&calls[c])).collect::<Vec<_>>().join("\0");
            if !visited.insert(key) {
                continue;
            }
            records.push(WalkRecord { kind: "visit", root: root_index, path: on_route.clone() });
            let node = to(&calls[paths[path].0]);
            let candidates = outgoing.get(&node).cloned().unwrap_or_default();
            for candidate in candidates {
                limit(steps, root_index, roots.len())?;
                steps += 1;
                let target = to(&calls[candidate]);
                if !branches.contains(&target) {
                    continue;
                }
                let ancestors: Vec<String> = on_route.iter().map(|&c| to(&calls[c])).collect();
                if ancestors.contains(&target) {
                    continue;
                }
                if ancestors.len() >= MAX_HELPER_DEPTH {
                    let mut deep = on_route.clone();
                    deep.push(candidate);
                    records.push(WalkRecord { kind: "depth", root: root_index, path: deep });
                    continue;
                }
                paths.push((candidate, Some(path)));
                stack.push(paths.len() - 1);
            }
            limit(steps, root_index, roots.len())?;
            steps += 1;
        }
    }
    Ok(records)
}

fn dedupe_sorted_by_id(references: Vec<Value>) -> Vec<Value> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<Value> = references.into_iter().filter(|r| seen.insert(id_of(r).to_string())).collect();
    out.sort_by(|l, r| units(id_of(l), id_of(r)));
    out
}

fn expand_helper_references(references: Vec<Value>, calls: &[Value], unresolved: &mut Vec<Value>, mode: &str) -> Result<Vec<Value>, Refusal> {
    let (direct, public): (Vec<Value>, Vec<Value>) = references.into_iter().partition(|r| text(r, "sourceKind") == Some("scripted_effect"));
    if mode == "focused" {
        if !calls.is_empty() {
            unresolved.push(json!({
                "id": "tech-unresolved-helper-expansion-deferred", "kind": "unsupported_construct", "expression": "scripted_effect expansion", "confidence": "unresolved",
                "blockers": [{ "code": "TECH_HELPER_EXPANSION_DEFERRED", "message": "Large-workspace technology analysis retains scripted-effect calls and direct references without materialising the full helper projection." }],
            }));
        }
        return Ok(dedupe_sorted_by_id(public.into_iter().chain(direct).collect()));
    }
    let mut by_helper: HashMap<String, Vec<&Value>> = HashMap::new();
    for r in &direct {
        by_helper.entry(text(r, "sourceId").unwrap_or("").to_string()).or_default().push(r);
    }
    let mut projected: Vec<Value> = public;
    projected.extend(direct.iter().cloned());
    let roots: Vec<&Value> = calls.iter().filter(|c| text(c, "sourceKind") != Some("scripted_effect")).collect();
    let mut projection_count = 0usize;
    for record in walk_helper_calls(calls)? {
        let root_call = roots[record.root];
        let path: Vec<&Value> = record.path.iter().map(|&c| &calls[c]).collect();
        let helper_stack: Vec<&str> = path.iter().map(|c| text(c, "helperId").unwrap_or("")).collect();
        if record.kind == "depth" {
            unresolved.push(json!({
                "id": deterministic_id("tech-unresolved", &json!({ "rootCall": root_call, "helperStack": helper_stack })),
                "kind": "unsupported_construct", "expression": helper_stack.join(" -> "), "ownerId": root_call["sourceId"], "location": root_call["location"],
                "confidence": "unresolved",
                "blockers": [{ "code": "TECH_HELPER_DEPTH_BLOCKED", "message": format!("Scripted-effect expansion exceeds depth {MAX_HELPER_DEPTH}"), "location": root_call["location"] }],
            }));
            continue;
        }
        let confidence = path.iter().fold(text(root_call, "confidence").unwrap_or("high"), |value, call| worse(value, text(call, "confidence").unwrap_or("high")));
        let last = path.last().and_then(|c| text(c, "helperId")).unwrap_or("");
        for reference in by_helper.get(last).map_or(&[][..], Vec::as_slice) {
            projection_count += 1;
            if projection_count > MAX_HELPER_PROJECTIONS {
                break;
            }
            let mut copy = (*reference).clone();
            let object = copy.as_object_mut().expect("reference object");
            object.insert("id".into(), deterministic_id("tech-external-projection", &json!({ "root": root_call["id"], "reference": reference["id"], "helperStack": helper_stack })).into());
            object.insert("sourceKind".into(), root_call["sourceKind"].clone());
            object.insert("sourceId".into(), root_call["sourceId"].clone());
            object.insert("helperStack".into(), json!(helper_stack));
            object.insert("confidence".into(), worse(confidence, text(reference, "confidence").unwrap_or("confirmed")).into());
            let mut metadata = reference["metadata"].as_object().cloned().unwrap_or_default();
            metadata.insert("projectedFromScriptedEffect".into(), reference["sourceId"].clone());
            metadata.insert("callLocation".into(), hoi4_core::canonical::canonical_json(&root_call["location"]).into());
            object.insert("metadata".into(), Value::Object(metadata));
            projected.push(copy);
        }
        if projection_count > MAX_HELPER_PROJECTIONS {
            break;
        }
    }
    if projection_count > MAX_HELPER_PROJECTIONS {
        unresolved.push(json!({
            "id": "tech-unresolved-helper-projection-limit", "kind": "unsupported_construct", "expression": "scripted_effect expansion", "confidence": "unresolved",
            "blockers": [{ "code": "TECH_HELPER_PROJECTION_LIMIT", "message": format!("Scripted-effect reference expansion exceeds {MAX_HELPER_PROJECTIONS} projections") }],
        }));
    }
    Ok(dedupe_sorted_by_id(projected))
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value[key].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

fn js_number(value: Option<&str>) -> Option<f64> {
    let parsed: f64 = value?.trim().parse().ok()?;
    parsed.is_finite().then_some(parsed)
}

fn group_by<'a>(values: &'a [Value], key: &str) -> Groups<&'a Value> {
    let mut groups = Groups::new();
    for v in values {
        groups.push(text(v, key).unwrap_or("").to_string(), v);
    }
    groups
}

#[allow(clippy::too_many_lines, clippy::too_many_arguments)]
fn diagnose(
    technologies: &[Value],
    folders: &[Value],
    placements: &[Value],
    gridboxes: &[Value],
    edges: &[Value],
    categories: &[Value],
    doctrines: &[Value],
    unlocks: &[Value],
    external: &[Value],
    duplicates: &[Vec<Value>],
    unresolved: &[Value],
) -> Vec<Value> {
    let mut issues: Vec<Value> = Vec::new();
    let tech_by_id: HashMap<&str, &Value> = technologies.iter().map(|t| (id_of(t), t)).collect();
    let folder_ids: HashSet<&str> = folders.iter().map(id_of).collect();
    let category_by_id: HashMap<&str, &Value> = categories.iter().map(|c| (id_of(c), c)).collect();
    let placements_by_tech = group_by(placements, "technologyId");
    let prerequisites: Vec<&Value> = edges.iter().filter(|e| text(e, "kind") == Some("prerequisite")).collect();
    let mut incoming: HashMap<&str, Vec<&Value>> = HashMap::new();
    let mut outgoing: HashMap<&str, Vec<&Value>> = HashMap::new();
    for e in &prerequisites {
        incoming.entry(text(e, "to").unwrap_or("")).or_default().push(e);
        outgoing.entry(text(e, "from").unwrap_or("")).or_default().push(e);
    }
    let incoming_of = |id: &str| incoming.get(id).map_or(&[][..], Vec::as_slice);
    let outgoing_of = |id: &str| outgoing.get(id).map_or(&[][..], Vec::as_slice);

    for group in duplicates {
        let first = &group[0];
        let tid = id_of(first);
        let mut i = issue("TECH_DUPLICATE_ID", "confirmed_error", "error", format!("Technology {tid} has multiple active definitions at the same load order"), "confirmed", Some(first["source"]["location"].clone()), json!({ "technologyId": tid }));
        i.related = Some(group[1..].iter().map(|t| t["source"]["location"].clone()).collect());
        add_issue(&mut issues, i);
    }
    for edge in edges {
        let from = text(edge, "from").unwrap_or("");
        let to = text(edge, "to").unwrap_or("");
        let kind = text(edge, "kind").unwrap_or("");
        if from == to {
            add_issue(&mut issues, issue("TECH_SELF_LINK", "confirmed_error", "error", format!("Technology {from} links to itself through {kind}"), "confirmed", Some(edge["location"].clone()), json!({ "technologyId": from, "edgeKind": kind })));
        }
        if !tech_by_id.contains_key(to) {
            let code = if kind == "exclusive" { "TECH_EXCLUSIVE_TARGET_MISSING" } else { "TECH_TARGET_MISSING" };
            add_issue(&mut issues, issue(code, "confirmed_error", "error", format!("Technology {from} references missing {kind} target {to}"), "confirmed", Some(edge["location"].clone()), json!({ "technologyId": from, "targetId": to, "edgeKind": kind })));
        }
    }
    let tech_ids: Vec<String> = technologies.iter().map(|t| id_of(t).to_string()).collect();
    for component in strongly_connected(&tech_ids, edges) {
        if component.len() < 2 {
            continue;
        }
        let first = tech_by_id[component[0].as_str()];
        add_issue(&mut issues, issue("TECH_PREREQUISITE_CYCLE", "confirmed_error", "error", format!("Technology prerequisite cycle: {}", component.join(" -> ")), "confirmed", Some(first["source"]["location"].clone()), json!({ "technologyIds": component })));
    }

    let mut coordinate_groups: Groups<&Value> = Groups::new();
    for placement in placements {
        let tid = text(placement, "technologyId").unwrap_or("");
        let fid = text(placement, "folderId").unwrap_or("");
        if !folder_ids.contains(fid) {
            add_issue(&mut issues, issue("TECH_FOLDER_REFERENCE_MISSING", "confirmed_error", "error", format!("Technology {tid} references missing folder {fid}"), "confirmed", Some(placement["location"].clone()), json!({ "technologyId": tid, "folderId": fid })));
        }
        if placement.get("x").is_none() || placement.get("y").is_none() {
            let mut i = issue(
                "TECH_PLACEMENT_COORDINATE_UNRESOLVED", "unresolved_analysis", "warning",
                format!("Technology {tid} has an unresolved source coordinate in {fid}"), "unresolved", Some(placement["location"].clone()),
                json!({ "technologyId": tid, "folderId": fid, "xExpression": placement.get("xExpression").cloned().unwrap_or(Value::Null), "yExpression": placement.get("yExpression").cloned().unwrap_or(Value::Null) }),
            );
            i.blockers = vec![json!({ "code": "TECH_COORDINATE_EXPRESSION_UNSUPPORTED", "message": "The coordinate is not a numeric literal or resolvable file-local constant", "location": placement["location"] })];
            add_issue(&mut issues, i);
            continue;
        }
        let show = |v: &Value| hoi4_core::canonical::canonical_json(v);
        let key = if placement.get("pixelX").is_some() && placement.get("pixelY").is_some() {
            format!("{fid}\0pixel\0{}\0{}", show(&placement["pixelX"]), show(&placement["pixelY"]))
        } else {
            format!("{fid}\0{}\0{}\0{}", text(placement, "branchRootId").unwrap_or("<ambiguous>"), show(&placement["x"]), show(&placement["y"]))
        };
        coordinate_groups.push(key, placement);
    }
    for group in coordinate_groups.into_groups() {
        let mut ids: Vec<&str> = Vec::new();
        for p in &group {
            let t = text(p, "technologyId").unwrap_or("");
            if !ids.contains(&t) {
                ids.push(t);
            }
        }
        if ids.len() < 2 {
            continue;
        }
        let first = group[0];
        let mut i = issue(
            "TECH_FOLDER_COORDINATE_OVERLAP", "confirmed_error", "error",
            format!("Technologies {} overlap at one source coordinate in {}", ids.join(", "), text(first, "folderId").unwrap_or("")), "confirmed", Some(first["location"].clone()),
            json!({
                "folderId": first["folderId"], "x": first["x"], "y": first["y"],
                "pixelX": first.get("pixelX").cloned().unwrap_or(Value::Null), "pixelY": first.get("pixelY").cloned().unwrap_or(Value::Null), "technologyIds": ids,
            }),
        );
        i.related = Some(group[1..].iter().map(|p| p["location"].clone()).collect());
        add_issue(&mut issues, i);
    }
    for tid in &placements_by_tech.order {
        let mut by_folder: Groups<&Value> = Groups::new();
        for p in placements_by_tech.get(tid) {
            by_folder.push(text(p, "folderId").unwrap_or("").to_string(), p);
        }
        for group in by_folder.into_groups() {
            let mut coordinates: Vec<String> = Vec::new();
            for p in &group {
                let part = |a: &str, b: &str| {
                    let v = p.get(a).or_else(|| p.get(b));
                    v.map_or("undefined".to_string(), |v| v.as_str().map_or_else(|| hoi4_core::canonical::canonical_json(v), str::to_string))
                };
                let c = format!("{}:{}", part("x", "xExpression"), part("y", "yExpression"));
                if !coordinates.contains(&c) {
                    coordinates.push(c);
                }
            }
            if coordinates.len() < 2 {
                continue;
            }
            coordinates.sort_by(|a, b| units(a, b));
            let mut i = issue(
                "TECH_PLACEMENT_CONFLICT", "confirmed_error", "error",
                format!("Technology {tid} has conflicting placements in folder {}", text(group[0], "folderId").unwrap_or("")), "confirmed", Some(group[0]["location"].clone()),
                json!({ "technologyId": tid, "folderId": group[0]["folderId"], "coordinates": coordinates }),
            );
            i.related = Some(group[1..].iter().map(|p| p["location"].clone()).collect());
            add_issue(&mut issues, i);
        }
    }

    let gridbox_by_id: HashMap<&str, &Value> = gridboxes.iter().map(|g| (id_of(g), g)).collect();
    for placement in placements {
        if text(placement, "geometryStatus") == Some("source_pixel") {
            continue;
        }
        let tid = text(placement, "technologyId").unwrap_or("");
        let fid = text(placement, "folderId").unwrap_or("");
        let location = Some(placement["location"].clone());
        match (text(placement, "branchRootId"), text(placement, "gridboxId")) {
            (None, _) => add_issue(&mut issues, issue("TECH_GRIDBOX_BRANCH_AMBIGUOUS", "probable_defect", "warning", format!("Technology {tid} cannot be assigned to one source branch gridbox in {fid}"), "high", location, json!({ "technologyId": tid, "folderId": fid }))),
            (Some(root), None) => add_issue(&mut issues, issue("TECH_GRIDBOX_MISSING", "probable_defect", "warning", format!("Technology branch {root} has no matching {root}_tree gridbox in {fid}"), "high", location, json!({ "technologyId": tid, "folderId": fid, "branchRootId": root }))),
            (Some(_), Some(gid)) => {
                let gridbox = gridbox_by_id.get(gid);
                add_issue(
                    &mut issues,
                    issue(
                        "TECH_GRIDBOX_GEOMETRY_UNRESOLVED", "unresolved_analysis", "warning",
                        format!("Gridbox geometry for technology {tid} cannot be reduced to source pixel coordinates"), "unresolved",
                        Some(gridbox.map_or_else(|| placement["location"].clone(), |g| g["location"].clone())),
                        json!({ "technologyId": tid, "folderId": fid, "gridbox": gridbox.map_or(Value::Null, |g| g["name"].clone()), "format": gridbox.and_then(|g| g.get("format")).cloned().unwrap_or(Value::Null) }),
                    ),
                );
            }
        }
    }

    let roots: Vec<&str> = technologies.iter().filter(|t| t["hidden"] != true && incoming_of(id_of(t)).is_empty()).map(id_of).collect();
    let mut reachable: HashSet<&str> = HashSet::new();
    let mut pending = roots;
    while let Some(current) = pending.pop() {
        if !reachable.insert(current) {
            continue;
        }
        for edge in outgoing_of(current) {
            let to = text(edge, "to").unwrap_or("");
            if tech_by_id.contains_key(to) {
                pending.push(to);
            }
        }
    }
    let grant_ids: HashSet<&str> = external.iter().filter(|r| matches!(text(r, "kind"), Some("grant" | "starting_technology"))).filter_map(|r| text(r, "technologyId")).collect();
    let unlocks_by_tech = group_by(unlocks, "technologyId");
    for technology in technologies {
        let tid = id_of(technology);
        let tech_placements = placements_by_tech.get(tid);
        let location = Some(technology["source"]["location"].clone());
        let hidden = &technology["hidden"];
        if *hidden != true && !tech_placements.is_empty() && !reachable.contains(tid) {
            add_issue(&mut issues, issue("TECH_VISIBLE_WITHOUT_ROOT_PATH", "probable_defect", "warning", format!("Visible technology {tid} has no valid prerequisite path from a visible root"), "high", location.clone(), json!({ "technologyId": tid })));
        }
        if (*hidden == true || tech_placements.is_empty()) && !grant_ids.contains(tid) {
            add_issue(
                &mut issues,
                issue(
                    "TECH_HIDDEN_OR_UNPLACED_WITHOUT_GRANT", "design_warning", "warning",
                    format!("Technology {tid} is hidden or unplaced and has no discovered static grant path"), if hidden == "unknown" { "medium" } else { "high" }, location.clone(),
                    json!({ "technologyId": tid, "hidden": hidden, "placementCount": tech_placements.len() }),
                ),
            );
        }
        let direct_parents: Vec<&Value> = incoming_of(tid).iter().filter_map(|e| tech_by_id.get(text(e, "from").unwrap_or("")).copied()).filter(|t| t["hidden"] != true).collect();
        let year = js_number(text(technology, "startYear"));
        let parent_years: Vec<f64> = direct_parents.iter().filter_map(|p| js_number(text(p, "startYear"))).collect();
        if let Some(y) = year
            && !parent_years.is_empty()
            && parent_years.iter().all(|p| y < *p)
        {
            add_issue(&mut issues, issue("TECH_CHILD_EARLIER_THAN_PARENTS", "design_warning", "warning", format!("Technology {tid} is dated earlier than every visible direct prerequisite"), "high", location.clone(), json!({ "technologyId": tid, "startYear": number_value(y), "parentYears": parent_years.iter().map(|p| number_value(*p)).collect::<Vec<_>>() })));
        }
        for edge in incoming_of(tid).iter().filter(|e| e.get("coefficient").is_some()) {
            let Some(c) = js_number(text(edge, "coefficient")) else { continue };
            if (0.1..=5.0).contains(&c) {
                continue;
            }
            let (from, to) = (text(edge, "from").unwrap_or(""), text(edge, "to").unwrap_or(""));
            let coefficient = text(edge, "coefficient").unwrap_or("");
            add_issue(&mut issues, issue("TECH_EDGE_COEFFICIENT_OUTLIER", "design_warning", "warning", format!("Prerequisite edge {from} -> {to} has unusual research coefficient {coefficient}"), "high", Some(edge["location"].clone()), json!({ "from": from, "to": to, "coefficient": coefficient })));
        }
        let degree = incoming_of(tid).len() + outgoing_of(tid).len();
        let no_effects = technology["effectKeys"].as_array().is_none_or(Vec::is_empty);
        let tech_unlocks = unlocks_by_tech.get(tid);
        if no_effects && tech_unlocks.is_empty() && degree == 0 {
            add_issue(&mut issues, issue("TECH_NO_VISIBLE_ROLE", "design_warning", "warning", format!("Technology {tid} has no visible effect, unlock, or routing role"), "high", location.clone(), json!({ "technologyId": tid })));
        } else if no_effects && tech_unlocks.is_empty() && !incoming_of(tid).is_empty() && outgoing_of(tid).is_empty() {
            add_issue(&mut issues, issue("TECH_TERMINAL_WITHOUT_VISIBLE_PAYOFF", "design_warning", "warning", format!("Terminal technology {tid} has no visible effect or unlock"), "high", location.clone(), json!({ "technologyId": tid })));
        }
        if technology["localisation"]["status"] == "missing" {
            add_issue(&mut issues, issue("TECH_LOCALISATION_MISSING", "confirmed_error", "error", format!("Technology {tid} is missing English name or description localisation"), "confirmed", location.clone(), json!({ "technologyId": tid, "nameKey": technology["localisation"]["nameKey"], "descriptionKey": technology["localisation"]["descriptionKey"] })));
        }
        let icon_status = text(&technology["icon"], "status").unwrap_or("");
        if icon_status == "missing_sprite" || icon_status == "missing_texture" {
            let sprite = text(&technology["icon"], "sprite").unwrap_or("");
            let (code, message) = if icon_status == "missing_sprite" {
                ("TECH_ICON_SPRITE_MISSING", format!("Technology {tid} references missing sprite {sprite}"))
            } else {
                ("TECH_ICON_TEXTURE_MISSING", format!("Technology {tid} cannot resolve texture for sprite {sprite}"))
            };
            add_issue(&mut issues, issue(code, "confirmed_error", "error", message, "confirmed", location.clone(), json!({ "technologyId": tid, "sprite": sprite, "texturePath": technology["icon"].get("texturePath").cloned().unwrap_or(Value::Null) })));
        }
        for category in strings(technology, "categories") {
            if !category_by_id.contains_key(category.as_str()) {
                add_issue(&mut issues, issue("TECH_CATEGORY_REFERENCE_MISSING", "confirmed_error", "error", format!("Technology {tid} references missing category {category}"), "confirmed", location.clone(), json!({ "technologyId": tid, "categoryId": category })));
            }
        }
        for tag in strings(technology, "tags") {
            if category_by_id.get(tag.as_str()).is_some_and(|c| c["kind"] == "tag") {
                continue;
            }
            add_issue(&mut issues, issue("TECH_TAG_REFERENCE_MISSING", "confirmed_error", "error", format!("Technology {tid} references missing tag {tag}"), "confirmed", location.clone(), json!({ "technologyId": tid, "tagId": tag })));
        }
        let mut peers: Vec<&str> = Vec::new();
        for e in incoming_of(tid) {
            for sibling in outgoing_of(text(e, "from").unwrap_or("")) {
                peers.push(text(sibling, "to").unwrap_or(""));
            }
        }
        for e in outgoing_of(tid) {
            for sibling in incoming_of(text(e, "to").unwrap_or("")) {
                peers.push(text(sibling, "from").unwrap_or(""));
            }
        }
        let branch_peers: Vec<&Value> = peers.iter().filter(|p| **p != tid).filter_map(|p| tech_by_id.get(p).copied()).collect();
        let peer_active = branch_peers.iter().any(|p| p["ai"]["present"] == true && p["ai"]["zero"] != true);
        if *hidden != true && degree > 0 && peer_active && (technology["ai"]["present"] != true || technology["ai"]["zero"] == true) {
            add_issue(&mut issues, issue("TECH_BRANCH_AI_COVERAGE_GAP", "design_warning", "warning", format!("Technology {tid} has missing or zero AI willingness while adjacent branch peers have active AI metadata"), "medium", location, json!({ "technologyId": tid, "aiPresent": technology["ai"]["present"], "aiZero": technology["ai"]["zero"] })));
        }
    }

    for unlock in unlocks.iter().filter(|u| u["resolved"] == false) {
        let (tid, kind, target) = (text(unlock, "technologyId").unwrap_or(""), text(unlock, "kind").unwrap_or(""), text(unlock, "targetId").unwrap_or(""));
        add_issue(&mut issues, issue("TECH_UNLOCK_TARGET_MISSING", "confirmed_error", "error", format!("Technology {tid} unlocks missing {kind} {target}"), "confirmed", Some(unlock["location"].clone()), json!({ "technologyId": tid, "targetKind": kind, "targetId": target })));
    }
    let mut by_category: HashMap<&str, usize> = HashMap::new();
    for technology in technologies {
        for category in technology["categories"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            *by_category.entry(category).or_default() += 1;
        }
    }
    for reference in external {
        let source = format!("{} {}", text(reference, "sourceKind").unwrap_or(""), text(reference, "sourceId").unwrap_or(""));
        let confidence = text(reference, "confidence").unwrap_or("confirmed");
        let dynamic = reference["dynamic"] == true;
        if let Some(t) = text(reference, "technologyId")
            && !tech_by_id.contains_key(t)
            && !dynamic
        {
            let code = if text(reference, "kind") == Some("research_bonus") { "TECH_BONUS_TARGET_MISSING" } else { "TECH_EXTERNAL_REFERENCE_MISSING" };
            add_issue(&mut issues, issue(code, "confirmed_error", "error", format!("{source} references missing technology {t}"), confidence, Some(reference["location"].clone()), json!({ "sourceKind": reference["sourceKind"], "sourceId": reference["sourceId"], "technologyId": t, "referenceKind": reference["kind"] })));
        }
        if let Some(c) = text(reference, "categoryId") {
            if !category_by_id.contains_key(c) && !dynamic {
                add_issue(&mut issues, issue("TECH_EXTERNAL_CATEGORY_MISSING", "confirmed_error", "error", format!("{source} references missing technology category {c}"), confidence, Some(reference["location"].clone()), json!({ "sourceKind": reference["sourceKind"], "sourceId": reference["sourceId"], "categoryId": c, "referenceKind": reference["kind"] })));
            } else if text(reference, "kind") == Some("research_bonus") && by_category.get(c).copied().unwrap_or(0) == 0 {
                add_issue(&mut issues, issue("TECH_BONUS_CATEGORY_EMPTY", "probable_defect", "warning", format!("Research bonus category {c} matches no indexed technology"), "high", Some(reference["location"].clone()), json!({ "sourceKind": reference["sourceKind"], "sourceId": reference["sourceId"], "categoryId": c })));
            }
        }
    }

    for doctrine in doctrines {
        let did = id_of(doctrine);
        let location = Some(doctrine["source"]["location"].clone());
        if let Some(f) = text(doctrine, "folderId")
            && !doctrines.iter().any(|d| text(d, "kind") == Some("folder") && id_of(d) == f)
        {
            add_issue(&mut issues, issue("TECH_DOCTRINE_FOLDER_MISSING", "confirmed_error", "error", format!("Doctrine {did} references missing doctrine folder {f}"), "confirmed", location.clone(), json!({ "doctrineId": did, "folderId": f })));
        }
        for track in strings(doctrine, "trackIds") {
            if doctrines.iter().any(|d| text(d, "kind") == Some("track") && id_of(d) == track) {
                continue;
            }
            add_issue(&mut issues, issue("TECH_DOCTRINE_TRACK_MISSING", "confirmed_error", "error", format!("Doctrine {did} references missing doctrine track {track}"), "confirmed", location.clone(), json!({ "doctrineId": did, "trackId": track })));
        }
        for exclusive in strings(doctrine, "exclusiveIds") {
            if doctrines.iter().any(|d| id_of(d) == exclusive) {
                continue;
            }
            add_issue(&mut issues, issue("TECH_DOCTRINE_EXCLUSIVE_TARGET_MISSING", "confirmed_error", "error", format!("Doctrine {did} references missing exclusive choice {exclusive}"), "confirmed", location.clone(), json!({ "doctrineId": did, "targetId": exclusive })));
        }
    }

    let mut signature_groups: Groups<&Value> = Groups::new();
    for technology in technologies {
        if technology["effectKeys"].as_array().is_none_or(Vec::is_empty) && unlocks_by_tech.get(id_of(technology)).is_empty() {
            continue;
        }
        let key = hash_canonical(&json!({
            "signature": technology["effectSignature"], "year": technology.get("startYear").cloned().unwrap_or(Value::Null),
            "folders": technology["folders"], "categories": technology["categories"],
        }));
        signature_groups.push(key, technology);
    }
    for group in signature_groups.into_groups() {
        if group.len() < 2 {
            continue;
        }
        let ids: Vec<&str> = group.iter().map(|t| id_of(t)).collect();
        let mut i = issue(
            "TECH_SUSPICIOUS_IDENTICAL_SIGNATURE", "design_warning", "warning",
            format!("Technologies {} have identical effects, unlocks, year, folders, and categories", ids.join(", ")), "medium", Some(group[0]["source"]["location"].clone()), json!({ "technologyIds": ids }),
        );
        i.related = Some(group[1..].iter().map(|t| t["source"]["location"].clone()).collect());
        add_issue(&mut issues, i);
    }

    for item in unresolved {
        let expression = text(item, "expression").unwrap_or("");
        let mut i = issue(
            "TECH_ANALYSIS_UNRESOLVED", "unresolved_analysis", "warning", format!("Static technology analysis could not resolve {expression}"),
            text(item, "confidence").unwrap_or("unresolved"), item.get("location").cloned(),
            json!({ "unresolvedId": item["id"], "kind": item["kind"], "ownerId": item.get("ownerId").cloned().unwrap_or(Value::Null) }),
        );
        i.blockers = item["blockers"].as_array().cloned().unwrap_or_default();
        add_issue(&mut issues, i);
    }
    stable_issues(issues)
}

fn severity_rank(value: &str) -> u8 {
    match value {
        "blocker" => 0,
        "error" => 1,
        "warning" => 2,
        _ => 3,
    }
}

fn sort_diagnostics(diagnostics: &mut [Value]) {
    diagnostics.sort_by(|l, r| {
        let path = |v: &Value| v["location"]["path"].as_str().unwrap_or("").to_string();
        let start = |v: &Value| v["location"]["start"]["offset"].as_i64().unwrap_or(0);
        severity_rank(text(l, "severity").unwrap_or("")).cmp(&severity_rank(text(r, "severity").unwrap_or("")))
            .then_with(|| units(&path(l), &path(r)))
            .then_with(|| start(l).cmp(&start(r)))
            .then_with(|| units(text(l, "code").unwrap_or(""), text(r, "code").unwrap_or("")))
    });
}

fn flat(fragments: &[Value], key: &str) -> Vec<Value> {
    fragments.iter().flat_map(|f| f[key].as_array().cloned().unwrap_or_default()).collect()
}

fn sorted_by_id(mut values: Vec<Value>) -> Vec<Value> {
    values.sort_by(|l, r| units(id_of(l), id_of(r)));
    values
}

/// `technologyGraphAnalysis`: the graph snapshot of a scan, from the fragments of its sources.
#[allow(clippy::too_many_lines)]
pub fn build_graph(fragments: &[Value], scan: &Scan, lookups: &Lookups) -> Result<Value, Refusal> {
    let assets = asset_map(&scan.asset_files);
    let (selected_technologies, duplicate_technologies) = active_definitions(flat(fragments, "technologies"));
    let technologies: Vec<Value> = selected_technologies.iter().cloned().map(|t| localise_technology(t, lookups, &assets)).collect();
    let owner_paths: HashMap<String, String> = technologies.iter().map(|t| (id_of(t).to_string(), text(&t["source"], "path").unwrap_or("").to_string())).collect();
    let (selected_folders, _) = active_definitions(flat(fragments, "folders"));
    let folders: Vec<Value> = selected_folders.into_iter().map(|f| localise_folder(f, lookups)).collect();
    let gridboxes = active_by_group(
        flat(fragments, "gridboxes"),
        |g| format!("{}\0{}", text(g, "folderId").unwrap_or("<global>"), text(g, "name").unwrap_or("")),
        |l, r| units(text(l, "folderId").unwrap_or(""), text(r, "folderId").unwrap_or("")).then_with(|| units(text(l, "name").unwrap_or(""), text(r, "name").unwrap_or(""))),
    );
    let item_layouts = active_by_group(
        flat(fragments, "itemLayouts"),
        |l| format!("{}\0{}", text(l, "folderId").unwrap_or(""), text(l, "layoutSize").unwrap_or("")),
        |l, r| units(text(l, "folderId").unwrap_or(""), text(r, "folderId").unwrap_or("")).then_with(|| units(text(l, "layoutSize").unwrap_or(""), text(r, "layoutSize").unwrap_or(""))),
    );
    let year_markers = active_by_group(
        flat(fragments, "yearMarkers"),
        |m| format!("{}\0{}", text(m, "folderId").unwrap_or(""), text(m, "name").unwrap_or("")),
        |l, r| {
            units(text(l, "folderId").unwrap_or(""), text(r, "folderId").unwrap_or(""))
                .then_with(|| l["year"].as_i64().cmp(&r["year"].as_i64()))
                .then_with(|| units(text(l, "name").unwrap_or(""), text(r, "name").unwrap_or("")))
        },
    );
    let backgrounds = active_by_group(
        flat(fragments, "backgrounds"),
        |b| format!("{}\0{}", text(b, "folderId").unwrap_or(""), text(b, "name").unwrap_or("")),
        |l, r| units(text(l, "folderId").unwrap_or(""), text(r, "folderId").unwrap_or("")).then_with(|| units(text(l, "name").unwrap_or(""), text(r, "name").unwrap_or(""))),
    );
    let (categories, _) = active_definitions(flat(fragments, "categories"));
    let (selected_doctrines, _) = active_definitions(flat(fragments, "doctrineDefinitions"));
    let doctrine_definitions: Vec<Value> = selected_doctrines.into_iter().map(|d| localise_doctrine(d, lookups, &assets)).collect();
    let targets: Vec<Value> = flat(fragments, "unlockTargets").into_iter().filter(|t| t.get("source").is_some()).collect();
    let (unlock_targets, _) = active_definitions(targets);
    let base_placements = sorted_by_id(select_owned(flat(fragments, "placements"), "technologyId", &owner_paths));
    let edges = sorted_by_id(select_owned(flat(fragments, "edges"), "from", &owner_paths));
    let target_keys: HashSet<String> = unlock_targets.iter().map(|t| format!("{}:{}", text(t, "kind").unwrap_or(""), text(t, "targetId").unwrap_or(""))).collect();
    let unlocks: Vec<Value> = sorted_by_id(select_owned(flat(fragments, "unlocks"), "technologyId", &owner_paths))
        .into_iter()
        .map(|mut u| {
            let key = format!("{}:{}", text(&u, "kind").unwrap_or(""), text(&u, "targetId").unwrap_or(""));
            u["resolved"] = if target_keys.contains(&key) { true.into() } else if scan.complete { false.into() } else { "unknown".into() };
            u
        })
        .collect();
    let placements = enrich_placements(base_placements, &edges, &gridboxes, &technologies, &unlocks, &item_layouts);
    let mut unresolved = flat(fragments, "unresolved");
    let mut helper_calls = flat(fragments, "helperCalls");
    let mode = scan.analysis_mode.clone().unwrap_or_else(|| if helper_calls.len() > MAX_FULL_HELPER_CALLS { "focused".into() } else { "full".into() });
    let external = expand_helper_references(flat(fragments, "externalReferences"), &helper_calls, &mut unresolved, &mode)?;
    let duplicate_localised: Vec<Vec<Value>> = duplicate_technologies
        .into_iter()
        .map(|group| {
            group
                .into_iter()
                .map(|t| {
                    let mut localised = localise_technology(t, lookups, &assets);
                    let id = id_of(&localised).to_string();
                    localised["localisation"] = json!({ "language": "l_english", "nameKey": id, "descriptionKey": format!("{id}_desc"), "status": "missing" });
                    localised
                })
                .collect()
        })
        .collect();
    let issues = diagnose(&technologies, &folders, &placements, &gridboxes, &edges, &categories, &doctrine_definitions, &unlocks, &external, &duplicate_localised, &unresolved);

    let mut hashes: Vec<(String, String)> = scan.files.iter().chain(scan.asset_files.iter()).filter(|f| f.shadowed_by.is_none()).map(|f| (f.display_path.clone(), f.sha256.clone())).collect();
    hashes.sort_by(|l, r| units(&l.0, &r.0));
    let hash_map: Map<String, Value> = hashes.iter().map(|(p, h)| (p.clone(), Value::from(h.clone()))).collect();
    let technology_ids: Vec<&str> = technologies.iter().map(id_of).collect();
    let revision = hash_canonical(&json!({ "scanRevision": scan.revision, "sourceHashes": hash_map, "technologyIds": technology_ids }));
    let mut diagnostics = scan.diagnostics.clone();
    for fragment in fragments {
        for d in fragment["diagnostics"].as_array().into_iter().flatten() {
            let path = d["location"]["path"].as_str().unwrap_or("");
            if path.starts_with("mod:") || path.starts_with("fixture:") {
                diagnostics.push(d.clone());
            }
        }
    }
    sort_diagnostics(&mut diagnostics);
    let complete = scan.complete
        && unresolved.iter().all(|u| text(u, "kind") != Some("partial_source"))
        && !unresolved.iter().any(|u| u["blockers"].as_array().into_iter().flatten().any(|b| matches!(text(b, "code"), Some("TECH_HELPER_DEPTH_BLOCKED" | "TECH_HELPER_PROJECTION_LIMIT"))))
        && !(mode == "focused" && !helper_calls.is_empty());
    let mut unsupported = vec![
        "runtime-evaluated visibility and allow triggers".to_string(),
        "meta-generated or variable technology identifiers".to_string(),
        "exact AI research choice and runtime research time".to_string(),
        "dynamic scripted localisation without supplied runtime values".to_string(),
    ];
    if mode == "focused" && !helper_calls.is_empty() {
        unsupported.push("large-workspace scripted-effect helper projections are deferred".into());
    }
    helper_calls.sort_by(|l, r| units(id_of(l), id_of(r)));
    unresolved.sort_by(|l, r| units(id_of(l), id_of(r)));
    let count_kind = |values: &[Value], kind: &str| values.iter().filter(|v| text(v, "kind") == Some(kind)).count();
    let statistics = json!({
        "technologyCount": count_kind(&technologies, "technology"),
        "legacyDoctrineCount": count_kind(&technologies, "legacy_doctrine"),
        "folderCount": folders.len(), "placementCount": placements.len(), "gridboxCount": gridboxes.len(), "itemLayoutCount": item_layouts.len(),
        "yearMarkerCount": year_markers.len(), "prerequisiteCount": count_kind(&edges, "prerequisite"), "exclusiveCount": count_kind(&edges, "exclusive"),
        "categoryCount": categories.len(), "doctrineDefinitionCount": doctrine_definitions.len(), "unlockCount": unlocks.len(),
        "externalReferenceCount": external.len(), "issueCount": issues.len(), "unresolvedCount": unresolved.len(),
    });
    if technologies.len() > MAX_TECHNOLOGIES {
        return Err(Refusal { code: "TECH_GRAPH_NODE_LIMIT", message: format!("Technology graph exceeds {MAX_TECHNOLOGIES} technologies"), details: Value::Null });
    }
    if edges.len() > MAX_EDGES {
        return Err(Refusal { code: "TECH_GRAPH_EDGE_LIMIT", message: format!("Technology graph exceeds {MAX_EDGES} edges"), details: Value::Null });
    }
    if external.len() > MAX_EXTERNAL_REFERENCES {
        return Err(Refusal { code: "TECH_GRAPH_REFERENCE_LIMIT", message: format!("Technology graph exceeds {MAX_EXTERNAL_REFERENCES} external references"), details: Value::Null });
    }
    let files_scanned: Vec<&String> = hashes.iter().map(|(p, _)| p).collect();
    Ok(json!({
        "schemaVersion": SCHEMA_VERSION,
        "parserVersion": PARSER_VERSION,
        "analysisMode": mode,
        "workspaceId": scan.workspace_id,
        "workspaceIdentity": scan.workspace_identity,
        "revision": revision,
        "complete": complete,
        "analysisBoundary": {
            "staticAnalysis": true,
            "language": "l_english",
            "loadOrder": "game -> dependencies -> active mod; same-path files are shadowed and duplicate active IDs are retained as diagnostics",
            "generatedLayoutsLabelled": true,
            "unsupportedConstructs": unsupported,
            "assumptions": [
                "classic technology paths point from the defining technology to leads_to_tech",
                "GFX_<technology>_medium is the default technology icon sprite",
                "file-local @ constants are resolved only when they reduce to numeric literals",
            ],
        },
        "sourceHashes": hash_map,
        "filesScanned": files_scanned,
        "skippedSourceCount": scan.skipped_source_count,
        "skippedSources": scan.skipped_sources,
        "technologies": technologies, "folders": folders, "placements": placements, "gridboxes": gridboxes, "itemLayouts": item_layouts,
        "yearMarkers": year_markers, "backgrounds": backgrounds, "edges": edges, "categories": categories, "doctrineDefinitions": doctrine_definitions,
        "unlockTargets": unlock_targets, "unlocks": unlocks, "externalReferences": external, "helperCalls": helper_calls, "issues": issues,
        "diagnostics": diagnostics, "unresolved": unresolved, "statistics": statistics,
    }))
}
