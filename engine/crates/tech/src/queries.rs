//! Technology graph queries.
//!
//! Ported from `src/hoi4_agent_tools/technology/queries.ts` (`technologyScanReport`,
//! `discoverTechnologyFolders`, `traceTechnology`, `explainTechnology`,
//! `inspectTechnologyUnlocks`, `technologyBonusCoverage`, `lintTechnologyGraph`,
//! `analyzeTechnologyImpact`, `technologyExplainSummary`), commit `9b7dc80d`. Every query reads
//! the graph snapshot as JSON and answers the JSON the TypeScript query answered.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use hoi4_core::canonical::compare_code_units;
use serde_json::{Map, Value, json};

use crate::source_analysis::deterministic_id;

/// A refusal with the stable code of the TypeScript `ServiceError`.
#[derive(Debug)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
    pub details: Value,
}

fn refuse(code: &'static str, message: String, details: Value) -> Refusal {
    Refusal { code, message, details }
}

const MAX_TRACE_DEPTH: i64 = 256;
const MAX_TRACE_NODES: i64 = 25_000;
const SCAN_FULL_GRAPH_RECORD_LIMIT: usize = 100_000;
const EXPLAIN_SUMMARY_LIST_LIMIT: usize = 20;

fn list<'a>(graph: &'a Value, key: &str) -> &'a [Value] {
    graph[key].as_array().map_or(&[], Vec::as_slice)
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn sort_units(values: &mut [String]) {
    values.sort_by(|a, b| compare_code_units(a, b));
}

fn require_technology(graph: &Value, id: &str) -> Result<(), Refusal> {
    if list(graph, "technologies").iter().any(|t| text(t, "id") == Some(id)) {
        return Ok(());
    }
    Err(refuse("TECHNOLOGY_NOT_FOUND", format!("Technology {id} was not found"), json!({ "technologyId": id })))
}

fn grouped_counts<'a>(values: impl Iterator<Item = &'a Value>, key: impl Fn(&Value) -> String) -> Value {
    let mut counts: Vec<(String, u64)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for value in values {
        let k = key(value);
        if let Some(i) = index.get(&k) {
            counts[*i].1 += 1;
        } else {
            index.insert(k.clone(), counts.len());
            counts.push((k, 1));
        }
    }
    counts.sort_by(|a, b| compare_code_units(&a.0, &b.0));
    Value::Object(counts.into_iter().map(|(k, n)| (k, Value::from(n))).collect())
}

fn record_count(graph: &Value) -> usize {
    [
        "technologies",
        "folders",
        "categories",
        "placements",
        "gridboxes",
        "itemLayouts",
        "yearMarkers",
        "edges",
        "unlocks",
        "unlockTargets",
        "externalReferences",
        "helperCalls",
        "issues",
        "diagnostics",
        "unresolved",
        "doctrineDefinitions",
    ]
    .iter()
    .map(|k| list(graph, k).len())
    .sum()
}

fn head(values: &[Value], count: usize) -> Value {
    Value::Array(values.iter().take(count).cloned().collect())
}

/// `technologyScanReport`.
pub fn scan_report(graph: &Value, full_graph_record_limit: Option<usize>) -> Value {
    let limit = full_graph_record_limit.unwrap_or(SCAN_FULL_GRAPH_RECORD_LIMIT);
    let records = record_count(graph);
    let issues = list(graph, "issues");
    let mut classifications = Map::new();
    for class in ["confirmed_error", "probable_defect", "design_warning", "unresolved_analysis"] {
        classifications.insert(class.into(), issues.iter().filter(|i| text(i, "classification") == Some(class)).count().into());
    }
    let ids = |key: &str, kind: Option<&str>| -> Value {
        Value::Array(list(graph, key).iter().filter(|d| kind.is_none_or(|k| text(d, "kind") == Some(k))).map(|d| d["id"].clone()).collect())
    };
    let counts = |keys: &[&str]| -> Value { Value::Object(keys.iter().map(|k| ((*k).to_string(), Value::from(list(graph, k).len()))).collect()) };
    let record_counts = counts(&[
        "technologies",
        "folders",
        "categories",
        "placements",
        "gridboxes",
        "itemLayouts",
        "yearMarkers",
        "edges",
        "unlocks",
        "unlockTargets",
        "externalReferences",
        "issues",
        "diagnostics",
        "unresolved",
        "doctrineDefinitions",
    ]);
    let mut summary = Map::new();
    for key in ["schemaVersion", "parserVersion", "workspaceId", "workspaceIdentity", "revision"] {
        summary.insert(key.into(), graph[key].clone());
    }
    summary.insert("analysisMode".into(), graph.get("analysisMode").cloned().unwrap_or_else(|| "full".into()));
    summary.insert("complete".into(), graph["complete"].clone());
    summary.insert("statistics".into(), graph["statistics"].clone());
    summary.insert("issueClassifications".into(), Value::Object(classifications));
    summary.insert("folderIds".into(), ids("folders", None));
    summary.insert("modernDoctrineFolders".into(), ids("doctrineDefinitions", Some("folder")));
    summary.insert("sourceHashCount".into(), graph["sourceHashes"].as_object().map_or(0, Map::len).into());
    summary.insert("skippedSourceCount".into(), graph["skippedSourceCount"].clone());
    summary.insert("analysisBoundary".into(), graph["analysisBoundary"].clone());
    summary.insert("issueSamples".into(), head(issues, 100));
    summary.insert("unresolvedSamples".into(), head(list(graph, "unresolved"), 100));
    summary.insert("recordCounts".into(), record_counts.clone());
    if records <= limit {
        summary.insert("authoritativeGraphIncluded".into(), true.into());
        summary.insert("graph".into(), graph.clone());
        return Value::Object(summary);
    }
    summary.insert("authoritativeGraphIncluded".into(), false.into());
    summary.insert(
        "graphSummary".into(),
        json!({
            "revision": graph["revision"],
            "recordCounts": record_counts,
            "technologyKinds": grouped_counts(list(graph, "technologies").iter(), |v| text(v, "kind").unwrap_or("").to_string()),
            "edgeKinds": grouped_counts(list(graph, "edges").iter(), |v| text(v, "kind").unwrap_or("").to_string()),
            "issueCodes": grouped_counts(issues.iter(), |v| text(v, "code").unwrap_or("").to_string()),
            "issueSeverities": grouped_counts(issues.iter(), |v| text(v, "severity").unwrap_or("").to_string()),
            "diagnosticCodes": grouped_counts(list(graph, "diagnostics").iter(), |v| text(v, "code").unwrap_or("").to_string()),
            "diagnosticSeverities": grouped_counts(list(graph, "diagnostics").iter(), |v| text(v, "severity").unwrap_or("").to_string()),
        }),
    );
    summary.insert("diagnosticSamples".into(), head(list(graph, "diagnostics"), 100));
    summary.insert(
        "artifactProjection".into(),
        json!({
            "mode": "large-scan-summary",
            "fullGraphRecordCount": records,
            "fullGraphRecordLimit": limit,
            "detailQueries": ["folders", "trace", "explain", "unlocks", "bonus_coverage", "lint", "impact"],
        }),
    );
    Value::Object(summary)
}

/// `discoverTechnologyFolders`.
pub fn discover_folders(graph: &Value, folder_id: Option<&str>) -> Result<Value, Refusal> {
    let incoming: HashSet<&str> = list(graph, "edges").iter().filter(|e| text(e, "kind") == Some("prerequisite")).filter_map(|e| text(e, "to")).collect();
    let selected: Vec<&Value> = list(graph, "folders").iter().filter(|f| folder_id.is_none_or(|id| text(f, "id") == Some(id))).collect();
    if let (Some(id), true) = (folder_id, selected.is_empty()) {
        return Err(refuse("TECH_FOLDER_NOT_FOUND", format!("Technology folder {id} was not found"), json!({ "folderId": id })));
    }
    let folders: Vec<Value> = selected
        .iter()
        .map(|folder| {
            let id = text(folder, "id").unwrap_or("");
            let placements: Vec<&Value> = list(graph, "placements").iter().filter(|p| text(p, "folderId") == Some(id)).collect();
            let mut technology_ids: Vec<String> = placements.iter().filter_map(|p| text(p, "technologyId")).map(str::to_string).collect();
            sort_units(&mut technology_ids);
            technology_ids.dedup();
            let roots: Vec<&String> = technology_ids.iter().filter(|t| !incoming.contains(t.as_str())).collect();
            json!({
                "folder": folder,
                "placementCount": placements.len(),
                "technologyCount": technology_ids.len(),
                "roots": roots,
                "placements": placements,
                "issues": list(graph, "issues").iter().filter(|i| text(&i["details"], "folderId") == Some(id)).collect::<Vec<_>>(),
            })
        })
        .collect();
    let doctrines = list(graph, "doctrineDefinitions");
    let modern: Vec<Value> = doctrines
        .iter()
        .filter(|d| text(d, "kind") == Some("folder") && folder_id.is_none_or(|id| text(d, "id") == Some(id)))
        .map(|folder| {
            json!({
                "folder": folder,
                "grandDoctrines": doctrines.iter().filter(|d| text(d, "kind") == Some("grand_doctrine") && text(d, "folderId") == text(folder, "id")).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(json!({ "folders": folders, "modernDoctrines": modern }))
}

pub struct TraceInput<'a> {
    pub technology_id: &'a str,
    pub direction: &'a str,
    pub max_depth: i64,
    pub max_nodes: i64,
    pub include_sub_technologies: bool,
}

/// `traceTechnology`.
pub fn trace(graph: &Value, input: &TraceInput) -> Result<Value, Refusal> {
    require_technology(graph, input.technology_id)?;
    let (direction, max_depth, max_nodes) = (input.direction, input.max_depth, input.max_nodes);
    if !(0..=MAX_TRACE_DEPTH).contains(&max_depth) || !(1..=MAX_TRACE_NODES).contains(&max_nodes) {
        return Err(refuse(
            "TECH_TRACE_LIMIT_INVALID",
            "Technology trace limits are outside supported bounds".into(),
            json!({ "maxDepth": max_depth, "maxNodes": max_nodes, "maximumDepth": MAX_TRACE_DEPTH, "maximumNodes": MAX_TRACE_NODES }),
        ));
    }
    let relevant: Vec<&Value> = list(graph, "edges")
        .iter()
        .filter(|e| text(e, "kind") == Some("prerequisite") || (input.include_sub_technologies && text(e, "kind") == Some("sub_technology")))
        .collect();
    let mut incoming: HashMap<&str, Vec<&Value>> = HashMap::new();
    let mut outgoing: HashMap<&str, Vec<&Value>> = HashMap::new();
    for edge in &relevant {
        incoming.entry(text(edge, "to").unwrap_or("")).or_default().push(edge);
        outgoing.entry(text(edge, "from").unwrap_or("")).or_default().push(edge);
    }
    let mut selected: HashSet<String> = HashSet::from([input.technology_id.to_string()]);
    let mut selected_edges: BTreeMap<String, &Value> = BTreeMap::new();
    let mut depth_by_id: Vec<(String, i64)> = vec![(input.technology_id.to_string(), 0)];
    let mut depth_lookup: HashMap<String, i64> = HashMap::from([(input.technology_id.to_string(), 0)]);
    let mut queue: VecDeque<String> = VecDeque::from([input.technology_id.to_string()]);
    let mut boundary: HashSet<String> = HashSet::new();
    let mut truncated = false;
    while let Some(current) = queue.pop_front() {
        let depth = depth_lookup.get(&current).copied().unwrap_or(0);
        let mut candidates: Vec<(&Value, &str)> = Vec::new();
        if direction != "descendants" {
            candidates.extend(incoming.get(current.as_str()).into_iter().flatten().map(|e| (*e, text(e, "from").unwrap_or(""))));
        }
        if direction != "prerequisites" {
            candidates.extend(outgoing.get(current.as_str()).into_iter().flatten().map(|e| (*e, text(e, "to").unwrap_or(""))));
        }
        candidates.sort_by(|l, r| compare_code_units(text(l.0, "id").unwrap_or(""), text(r.0, "id").unwrap_or("")));
        for (edge, next) in candidates {
            selected_edges.insert(text(edge, "id").unwrap_or("").to_string(), edge);
            if selected.contains(next) {
                continue;
            }
            if depth >= max_depth || selected.len() as i64 >= max_nodes {
                truncated = true;
                boundary.insert(next.to_string());
                continue;
            }
            selected.insert(next.to_string());
            depth_by_id.push((next.to_string(), depth + 1));
            depth_lookup.insert(next.to_string(), depth + 1);
            queue.push_back(next.to_string());
        }
    }
    let mut depths: Vec<i64> = depth_by_id.iter().map(|(_, d)| *d).collect();
    depths.sort_unstable();
    depths.dedup();
    let layers: Vec<Value> = depths
        .into_iter()
        .map(|depth| {
            let mut ids: Vec<String> = depth_by_id.iter().filter(|(_, d)| *d == depth).map(|(id, _)| id.clone()).collect();
            sort_units(&mut ids);
            json!({ "depth": depth, "technologyIds": ids })
        })
        .collect();
    let mut nodes: Vec<String> = selected.into_iter().collect();
    sort_units(&mut nodes);
    let mut boundary: Vec<String> = boundary.into_iter().collect();
    sort_units(&mut boundary);
    let mut edges: Vec<(&String, &&Value)> = selected_edges.iter().collect();
    edges.sort_by(|a, b| compare_code_units(a.0, b.0));
    Ok(json!({
        "technologyId": input.technology_id,
        "direction": direction,
        "nodes": nodes,
        "edges": edges.into_iter().map(|(_, e)| *e).collect::<Vec<_>>(),
        "layers": layers,
        "truncated": truncated,
        "boundary": boundary,
    }))
}

fn edges_where<'a>(graph: &'a Value, predicate: impl Fn(&Value) -> bool) -> Vec<&'a Value> {
    list(graph, "edges").iter().filter(|e| predicate(e)).collect()
}

/// `explainTechnology`.
pub fn explain(graph: &Value, technology_id: &str) -> Result<Value, Refusal> {
    require_technology(graph, technology_id)?;
    let technology = list(graph, "technologies").iter().find(|t| text(t, "id") == Some(technology_id)).cloned().unwrap_or(Value::Null);
    let wide =
        |direction: &'static str| trace(graph, &TraceInput { technology_id, direction, max_depth: 256, max_nodes: 25_000, include_sub_technologies: false });
    let prerequisites = wide("prerequisites")?;
    let descendants = wide("descendants")?;
    let categories: Vec<&str> = technology["categories"].as_array().map_or(vec![], |a| a.iter().filter_map(Value::as_str).collect());
    let prerequisite_edge = |e: &Value| text(e, "kind") == Some("prerequisite");
    let issues: Vec<&Value> = list(graph, "issues")
        .iter()
        .filter(|i| {
            let d = &i["details"];
            text(d, "technologyId") == Some(technology_id) || d["technologyIds"].as_array().is_some_and(|a| a.iter().any(|v| v.as_str() == Some(technology_id)))
        })
        .collect();
    Ok(json!({
        "technology": technology,
        "placements": list(graph, "placements").iter().filter(|p| text(p, "technologyId") == Some(technology_id)).collect::<Vec<_>>(),
        "directPrerequisites": edges_where(graph, |e| prerequisite_edge(e) && text(e, "to") == Some(technology_id)),
        "transitivePrerequisites": prerequisites,
        "directDescendants": edges_where(graph, |e| prerequisite_edge(e) && text(e, "from") == Some(technology_id)),
        "descendants": descendants,
        "exclusiveChoices": edges_where(graph, |e| text(e, "kind") == Some("exclusive") && (text(e, "from") == Some(technology_id) || text(e, "to") == Some(technology_id))),
        "unlocks": list(graph, "unlocks").iter().filter(|u| text(u, "technologyId") == Some(technology_id)).collect::<Vec<_>>(),
        "externalGrants": list(graph, "externalReferences").iter().filter(|r| text(r, "technologyId") == Some(technology_id) && matches!(text(r, "kind"), Some("grant" | "starting_technology"))).collect::<Vec<_>>(),
        "matchingBonuses": list(graph, "externalReferences").iter().filter(|r| {
            text(r, "kind") == Some("research_bonus") && (text(r, "technologyId") == Some(technology_id) || text(r, "categoryId").is_some_and(|c| categories.contains(&c)))
        }).collect::<Vec<_>>(),
        "issues": issues,
        "unresolved": list(graph, "unresolved").iter().filter(|u| text(u, "ownerId") == Some(technology_id)).collect::<Vec<_>>(),
        "confidenceLimits": graph["analysisBoundary"],
    }))
}

/// `inspectTechnologyUnlocks`.
pub fn inspect_unlocks(graph: &Value, technology_id: Option<&str>, target_kind: Option<&str>, target_id: Option<&str>) -> Result<Value, Refusal> {
    if let Some(id) = technology_id {
        require_technology(graph, id)?;
    }
    let unlocks: Vec<&Value> = list(graph, "unlocks")
        .iter()
        .filter(|u| {
            technology_id.is_none_or(|t| text(u, "technologyId") == Some(t))
                && target_kind.is_none_or(|k| text(u, "kind") == Some(k))
                && target_id.is_none_or(|t| text(u, "targetId") == Some(t))
        })
        .collect();
    let mut selector = Map::new();
    for (key, value) in [("technologyId", technology_id), ("targetKind", target_kind), ("targetId", target_id)] {
        if let Some(v) = value {
            selector.insert(key.into(), v.into());
        }
    }
    Ok(json!({
        "selector": selector,
        "unlocks": unlocks,
        "targets": list(graph, "unlockTargets").iter().filter(|t| unlocks.iter().any(|u| u["kind"] == t["kind"] && u["targetId"] == t["targetId"])).collect::<Vec<_>>(),
        "externalGrants": list(graph, "externalReferences").iter().filter(|r| {
            r.get("technologyId").is_some_and(|t| unlocks.iter().any(|u| u["technologyId"] == *t)) && matches!(text(r, "kind"), Some("grant" | "starting_technology"))
        }).collect::<Vec<_>>(),
        "issues": list(graph, "issues").iter().filter(|i| {
            text(i, "code") == Some("TECH_UNLOCK_TARGET_MISSING")
                && unlocks.iter().any(|u| i["details"]["technologyId"] == u["technologyId"] && i["details"]["targetKind"] == u["kind"] && i["details"]["targetId"] == u["targetId"])
        }).collect::<Vec<_>>(),
    }))
}

/// `technologyBonusCoverage`.
pub fn bonus_coverage(graph: &Value, category_id: Option<&str>, technology_id: Option<&str>) -> Result<Value, Refusal> {
    if let Some(id) = technology_id {
        require_technology(graph, id)?;
    }
    let categories: Vec<&Value> = list(graph, "categories").iter().filter(|c| category_id.is_none_or(|id| text(c, "id") == Some(id))).collect();
    if let (Some(id), true) = (category_id, categories.is_empty()) {
        return Err(refuse("TECH_CATEGORY_NOT_FOUND", format!("Technology category {id} was not found"), json!({ "categoryId": id })));
    }
    let references = list(graph, "externalReferences");
    let rows: Vec<Value> = categories
        .iter()
        .map(|category| {
            let cid = text(category, "id").unwrap_or("");
            let technology_ids: Vec<&str> = list(graph, "technologies")
                .iter()
                .filter(|t| {
                    t["categories"].as_array().is_some_and(|a| a.iter().any(|c| c.as_str() == Some(cid)))
                        && technology_id.is_none_or(|id| text(t, "id") == Some(id))
                })
                .filter_map(|t| text(t, "id"))
                .collect();
            let bonus: Vec<&Value> = references
                .iter()
                .filter(|r| {
                    text(r, "kind") == Some("research_bonus")
                        && (text(r, "categoryId") == Some(cid) || text(r, "technologyId").is_some_and(|t| technology_ids.contains(&t)))
                })
                .collect();
            let sharing: Vec<&Value> =
                references.iter().filter(|r| text(r, "kind") == Some("technology_sharing") && text(r, "categoryId") == Some(cid)).collect();
            let covered = !bonus.is_empty() || !sharing.is_empty();
            json!({ "category": category, "technologyIds": technology_ids, "bonusSources": bonus, "sharingSources": sharing, "covered": covered })
        })
        .collect();
    let mut selector = Map::new();
    for (key, value) in [("categoryId", category_id), ("technologyId", technology_id)] {
        if let Some(v) = value {
            selector.insert(key.into(), v.into());
        }
    }
    Ok(json!({
        "selector": selector,
        "uncoveredCategoryIds": rows.iter().filter(|r| r["covered"] == false).map(|r| r["category"]["id"].clone()).collect::<Vec<_>>(),
        "rows": rows,
        "technologySpecificBonuses": references.iter().filter(|r| {
            text(r, "kind") == Some("research_bonus") && text(r, "technologyId").is_some_and(|t| technology_id.is_none_or(|id| id == t))
        }).collect::<Vec<_>>(),
        "invalidBonusSources": list(graph, "issues").iter().filter(|i| matches!(text(i, "code"), Some("TECH_EXTERNAL_CATEGORY_MISSING" | "TECH_BONUS_TARGET_MISSING"))).collect::<Vec<_>>(),
    }))
}

pub struct LintFilter<'a> {
    pub classifications: Option<&'a [String]>,
    pub codes: Option<&'a [String]>,
    pub folder_id: Option<&'a str>,
    pub technology_id: Option<&'a str>,
}

/// `lintTechnologyGraph`.
pub fn lint(graph: &Value, filter: &LintFilter) -> Value {
    let issues: Vec<&Value> = list(graph, "issues")
        .iter()
        .filter(|i| {
            filter.classifications.is_none_or(|c| c.iter().any(|x| Some(x.as_str()) == text(i, "classification")))
                && filter.codes.is_none_or(|c| c.iter().any(|x| Some(x.as_str()) == text(i, "code")))
                && filter.folder_id.is_none_or(|f| text(&i["details"], "folderId") == Some(f))
                && filter.technology_id.is_none_or(|t| {
                    text(&i["details"], "technologyId") == Some(t)
                        || i["details"]["technologyIds"].as_array().is_some_and(|a| a.iter().any(|v| v.as_str() == Some(t)))
                })
        })
        .collect();
    let mut applied = Map::new();
    if let Some(c) = filter.classifications {
        applied.insert("classifications".into(), json!(c));
    }
    if let Some(c) = filter.codes {
        applied.insert("codes".into(), json!(c));
    }
    if let Some(f) = filter.folder_id {
        applied.insert("folderId".into(), f.into());
    }
    if let Some(t) = filter.technology_id {
        applied.insert("technologyId".into(), t.into());
    }
    json!({
        "filter": applied,
        "issueCount": issues.len(),
        "byClassification": grouped_counts(issues.iter().copied(), |i| text(i, "classification").unwrap_or("").to_string()),
        "byCode": grouped_counts(issues.iter().copied(), |i| text(i, "code").unwrap_or("").to_string()),
        "issues": issues,
        "unresolved": list(graph, "unresolved").iter().filter(|u| filter.technology_id.is_none_or(|t| text(u, "ownerId") == Some(t))).collect::<Vec<_>>(),
    })
}

pub struct ImpactInput<'a> {
    pub kind: &'a str,
    pub id: &'a str,
    pub operation: &'a str,
    pub replacement_id: Option<&'a str>,
}

/// `analyzeTechnologyImpact`.
pub fn impact(graph: &Value, input: &ImpactInput) -> Result<Value, Refusal> {
    if input.operation == "rename" && input.replacement_id.is_none() {
        return Err(refuse("TECH_IMPACT_REPLACEMENT_REQUIRED", "Rename impact requires replacementId".into(), Value::Null));
    }
    let id = input.id;
    let has = |value: &Value, key: &str| value[key].as_array().is_some_and(|a| a.iter().any(|v| v.as_str() == Some(id)));
    let mut references: Vec<&Value> = Vec::new();
    match input.kind {
        "technology" => {
            require_technology(graph, id)?;
            references.extend(list(graph, "edges").iter().filter(|e| text(e, "from") == Some(id) || text(e, "to") == Some(id)));
            references.extend(list(graph, "placements").iter().filter(|p| text(p, "technologyId") == Some(id)));
            references.extend(list(graph, "unlocks").iter().filter(|u| text(u, "technologyId") == Some(id)));
            references.extend(list(graph, "externalReferences").iter().filter(|r| text(r, "technologyId") == Some(id)));
        }
        "category" => {
            references.extend(list(graph, "technologies").iter().filter(|t| has(t, "categories")));
            references.extend(list(graph, "externalReferences").iter().filter(|r| text(r, "categoryId") == Some(id)));
        }
        "folder" => {
            references.extend(list(graph, "placements").iter().filter(|p| text(p, "folderId") == Some(id)));
            references.extend(list(graph, "technologies").iter().filter(|t| has(t, "folders")));
        }
        _ => references.extend(list(graph, "unlocks").iter().filter(|u| text(u, "targetId") == Some(id))),
    }
    let locations: Vec<&Value> = references
        .iter()
        .filter_map(|r| r.get("location").filter(|l| !l.is_null()).or_else(|| r.get("source").filter(|s| s.is_object()).and_then(|s| s.get("location"))))
        .collect();
    let mut subject = Map::new();
    subject.insert("kind".into(), input.kind.into());
    subject.insert("id".into(), id.into());
    subject.insert("operation".into(), input.operation.into());
    if let Some(r) = input.replacement_id {
        subject.insert("replacementId".into(), r.into());
    }
    let subject = Value::Object(subject);
    let collision = input
        .replacement_id
        .is_some_and(|r| ["technologies", "categories", "folders"].iter().any(|key| list(graph, key).iter().any(|v| text(v, "id") == Some(r))));
    Ok(json!({
        "id": deterministic_id("tech-impact", &subject),
        "subject": subject,
        "referenceCount": references.len(),
        "references": references,
        "sourceLocations": locations,
        "wouldBreakReferences": !references.is_empty(),
        "replacementCollision": collision,
        "limitations": graph["analysisBoundary"]["unsupportedConstructs"],
    }))
}

fn limited(values: impl Iterator<Item = String>) -> (Vec<String>, bool) {
    let mut sorted: Vec<String> = values.collect();
    sort_units(&mut sorted);
    sorted.dedup();
    let cut = sorted.len() > EXPLAIN_SUMMARY_LIST_LIMIT;
    sorted.truncate(EXPLAIN_SUMMARY_LIST_LIMIT);
    (sorted, cut)
}

/// `technologyExplainSummary`.
pub fn explain_summary(report: &Value) -> Option<Value> {
    let technology = report.get("technology")?;
    let id = text(technology, "id")?;
    let strings =
        |key: &str, field: &str| -> Vec<String> { report[key].as_array().into_iter().flatten().filter_map(|e| text(e, field)).map(str::to_string).collect() };
    let (prerequisites, p_cut) = limited(strings("directPrerequisites", "from").into_iter());
    let (leads_to, l_cut) = limited(strings("directDescendants", "to").into_iter());
    let (exclusive, e_cut) = limited(report["exclusiveChoices"].as_array().into_iter().flatten().map(|e| {
        let (from, to) = (text(e, "from").unwrap_or(""), text(e, "to").unwrap_or(""));
        (if from == id { to } else { from }).to_string()
    }));
    let mut unlocks: Vec<(String, String)> = report["unlocks"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|u| (text(u, "kind").unwrap_or("").to_string(), text(u, "targetId").unwrap_or("").to_string()))
        .collect();
    unlocks.sort_by(|a, b| compare_code_units(&a.0, &b.0).then_with(|| compare_code_units(&a.1, &b.1)));
    let sorted_strings = |key: &str| -> Vec<String> {
        let mut v: Vec<String> = technology[key].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
        sort_units(&mut v);
        v
    };
    let mut out = Map::new();
    out.insert("id".into(), id.into());
    out.insert("path".into(), technology["source"]["path"].clone());
    out.insert("line".into(), technology["source"]["location"]["start"]["line"].clone());
    for (key, value) in
        [("name", technology["localisation"].get("name")), ("startYear", technology.get("startYear")), ("researchCost", technology.get("researchCost"))]
    {
        if let Some(v) = value {
            out.insert(key.into(), v.clone());
        }
    }
    out.insert("folders".into(), sorted_strings("folders").into());
    out.insert("categories".into(), sorted_strings("categories").into());
    out.insert("prerequisites".into(), prerequisites.into());
    out.insert("leadsTo".into(), leads_to.into());
    out.insert("exclusiveWith".into(), exclusive.into());
    out.insert("unlocks".into(), unlocks.iter().take(EXPLAIN_SUMMARY_LIST_LIMIT).map(|(k, t)| json!({ "kind": k, "targetId": t })).collect::<Vec<_>>().into());
    out.insert("allPrerequisites".into(), (report["transitivePrerequisites"]["nodes"].as_array().map_or(0, Vec::len) as i64 - 1).into());
    out.insert("allDescendants".into(), (report["descendants"]["nodes"].as_array().map_or(0, Vec::len) as i64 - 1).into());
    out.insert("unlockCount".into(), unlocks.len().into());
    out.insert("grantedBy".into(), report["externalGrants"].as_array().map_or(0, Vec::len).into());
    out.insert("issues".into(), report["issues"].as_array().map_or(0, Vec::len).into());
    out.insert(
        "truncated".into(),
        (p_cut
            || l_cut
            || e_cut
            || unlocks.len() > EXPLAIN_SUMMARY_LIST_LIMIT
            || report["transitivePrerequisites"]["truncated"] == true
            || report["descendants"]["truncated"] == true)
            .into(),
    );
    Some(Value::Object(out))
}
