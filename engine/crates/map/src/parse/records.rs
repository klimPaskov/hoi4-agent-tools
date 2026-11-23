//! The map's records: province definitions, states, strategic regions, terrain categories,
//! buildings, continents, adjacencies, supply nodes, railways, positions and entity locators.
//!
//! Ported from `src/hoi4_agent_tools/map/model.ts` (`parseDefinitions`, `parseState`,
//! `parseTerrainCategories`, `parseBuildingDefinitions`, `parseContinents`,
//! `parseStrategicRegion`, `parseAdjacencies`, `parseSupplyNodes`, `parseRailways`,
//! `parseBuildingPositions`, `parseUnitPositions`, `parseWeatherPositions`,
//! `parseEntityLocators`, `defaultMapSelectorValue`, `earliestBookmarkDate`,
//! `derivedStateCapital`), commit `9b7dc80d`.
//!
//! A record keeps what validation and the engine operations read: values, the source it came
//! from and its location. The syntax nodes the TypeScript writers edit stay in TypeScript until
//! the map writer moves (packet P13b).

use hoi4_core::diagnostics::{Category, Diagnostic, Severity, SourceLocation};
use serde::Serialize;
use serde_json::json;

use super::bmp::Rgb;
use hoi4_engine::symbol_index::reader::{Block, Value as Node};

use super::script::{self, Script, assignments, scalar_list};
use super::text::{TextDocument, js_number, parse_integer, parse_map_date, parse_number, split_delimited, string, utf16, whitespace_fields};
use crate::model::{MapError, OrderedMap};
use crate::validate::limit::add_map_diagnostic;

/// Index of a text table in [`crate::model::MapIndex::documents`].
pub type DocumentId = usize;

fn map_diagnostic(code: &str, severity: Severity, message: impl Into<String>, location: Option<SourceLocation>) -> Diagnostic {
    script::diagnostic(code, severity, Category::Map, message, location, None)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvinceDefinition {
    pub id: i64,
    #[serde(serialize_with = "serialize_rgb")]
    pub color: Rgb,
    #[serde(rename = "type")]
    pub kind: String,
    pub coastal: bool,
    pub terrain: String,
    pub continent: i64,
    pub line: usize,
    #[serde(skip)]
    pub document: DocumentId,
}

fn serialize_rgb<S: serde::Serializer>(rgb: &Rgb, serializer: S) -> Result<S::Ok, S::Error> {
    json!({ "r": rgb.r, "g": rgb.g, "b": rgb.b }).serialize(serializer)
}

/// `parseDefinitions`.
pub fn parse_definitions(document: &TextDocument, id: DocumentId, diagnostics: &mut Vec<Diagnostic>) -> Vec<ProvinceDefinition> {
    let mut definitions = Vec::new();
    for line in &document.lines {
        let text = document.line_text(line);
        let trimmed = super::text::js_trim(text);
        if trimmed.is_empty() || trimmed[0] == u16::from(b'#') {
            continue;
        }
        let parts = split_delimited(text, 9);
        if parts.len() < 8 {
            add_map_diagnostic(
                diagnostics,
                map_diagnostic(
                    "MAP_DEFINITION_ROW_MALFORMED",
                    Severity::Error,
                    "Province definition row must contain eight semicolon-separated fields",
                    Some(document.line_location(line)),
                ),
                None,
            );
            continue;
        }
        let number = |i: usize| parse_integer(parts.get(i).map(String::as_str));
        let (Some(province), Some(r), Some(g), Some(b), Some(continent)) = (number(0), number(1), number(2), number(3), number(7)) else {
            add_map_diagnostic(diagnostics, invalid_definition(document, line), None);
            continue;
        };
        let channel = |v: i64| (0..=255).contains(&v);
        if !(0..=2_147_483_647).contains(&province) || !(0..=2_147_483_647).contains(&continent) || !channel(r) || !channel(g) || !channel(b) {
            add_map_diagnostic(diagnostics, invalid_definition(document, line), None);
            continue;
        }
        definitions.push(ProvinceDefinition {
            id: province,
            color: Rgb { r: r as u8, g: g as u8, b: b as u8 },
            kind: parts[4].clone(),
            coastal: parts[5].to_lowercase() == "true",
            terrain: parts[6].clone(),
            continent,
            line: line.index + 1,
            document: id,
        });
    }
    definitions
}

fn invalid_definition(document: &TextDocument, line: &super::text::TextLine) -> Diagnostic {
    map_diagnostic(
        "MAP_DEFINITION_VALUE_INVALID",
        Severity::Error,
        "Province definition contains an invalid ID, color, or continent",
        Some(document.line_location(line)),
    )
}

/// The date of the earliest bookmark (`MapBookmarkDate`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkDate {
    pub value: String,
    pub ordinal: i64,
    pub source_path: String,
}

/// `earliestBookmarkDate` over one bookmark file; the caller keeps the earliest over all files.
pub fn bookmark_dates(script: &Script) -> Vec<(String, i64)> {
    let mut dates = Vec::new();
    for root in script.root().child_blocks("bookmarks") {
        for bookmark in root.child_blocks("bookmark") {
            let Some(value) = bookmark.first_scalar("date") else { continue };
            if let Some(ordinal) = parse_map_date(&value.value) {
                dates.push((value.value.to_string(), ordinal));
            }
        }
    }
    dates
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VictoryPoint {
    pub province_id: i64,
    pub value: f64,
}

/// `derivedStateCapital`: the province of the highest victory point, the lowest id on a tie.
pub fn derived_state_capital(points: &[VictoryPoint]) -> Option<i64> {
    points.iter().max_by(|a, b| a.value.total_cmp(&b.value).then(b.province_id.cmp(&a.province_id))).map(|p| p.province_id)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateRecord {
    pub id: i64,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capital: Option<i64>,
    pub manpower: f64,
    pub category: String,
    pub provinces: Vec<i64>,
    pub resources: OrderedMap<String, f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controller: Option<String>,
    pub cores: Vec<String>,
    pub claims: Vec<String>,
    pub victory_points: Vec<VictoryPoint>,
    pub province_buildings: OrderedMap<i64, OrderedMap<String, f64>>,
    pub state_buildings: OrderedMap<String, f64>,
    /// Display path of the state file.
    pub path: String,
    /// `stateLocation`: the `state` assignment, with the id as its symbol.
    #[serde(skip)]
    pub location: SourceLocation,
}

fn numeric_map(block: Option<&Block>) -> OrderedMap<String, f64> {
    let mut result = OrderedMap::default();
    if let Some(block) = block {
        for assignment in block.assignments() {
            if let Node::Scalar(scalar) = &assignment.value
                && let Some(value) = parse_number(Some(&scalar.value))
            {
                result.set(assignment.key.value.to_string(), value);
            }
        }
    }
    result
}

fn add_parser_findings(script: &Script, diagnostics: &mut Vec<Diagnostic>) {
    for d in script.diagnostics() {
        add_map_diagnostic(diagnostics, d, None);
    }
}

fn block_of<'b, 'a>(value: &'b Node<'a>) -> Option<&'b Block<'a>> {
    match value {
        Node::Block(b) => Some(b),
        Node::Scalar(_) => None,
    }
}

/// `parseState`. Parser diagnostics go to `diagnostics`.
pub fn parse_state(script: &Script, diagnostics: &mut Vec<Diagnostic>, earliest: Option<&BookmarkDate>) -> Option<StateRecord> {
    add_parser_findings(script, diagnostics);
    let assignment = assignments(script.root(), "state").next()?;
    let block = block_of(&assignment.value)?;
    let id_scalar = block.first_scalar("id");
    let id = parse_integer(id_scalar.map(|s| s.value.as_ref())).filter(|&id| id > 0 && id <= 2_147_483_647);
    let Some(id) = id else {
        let (code, message) = if id_scalar.is_none() {
            ("MAP_STATE_ID_MISSING", "State file has no integer ID")
        } else {
            ("MAP_STATE_ID_INVALID", "State ID must be a positive signed 32-bit integer")
        };
        add_map_diagnostic(diagnostics, map_diagnostic(code, Severity::Error, message, Some(script.assignment_location(assignment, None))), None);
        return None;
    };
    let provinces: Vec<i64> = scalar_list(block.child_blocks("provinces").next()).into_iter().filter_map(|v| parse_integer(Some(v))).collect();
    let history = block.child_blocks("history").next();
    let resources = block.child_blocks("resources").next();
    let buildings = history.and_then(|h| h.child_blocks("buildings").next());
    let mut province_buildings: OrderedMap<i64, OrderedMap<String, f64>> = OrderedMap::default();
    let mut state_buildings: OrderedMap<String, f64> = OrderedMap::default();
    if let Some(buildings) = buildings {
        for entry in buildings.assignments() {
            match &entry.value {
                Node::Block(inner) => {
                    if let Some(province) = parse_integer(Some(&entry.key.value)) {
                        province_buildings.set(province, numeric_map(Some(inner)));
                    }
                }
                Node::Scalar(scalar) => {
                    if let Some(level) = parse_number(Some(&scalar.value)) {
                        state_buildings.set(entry.key.value.to_string(), level);
                    }
                }
            }
        }
    }
    let mut victory_points = Vec::new();
    if let Some(history) = history {
        for entry in assignments(history, "victory_points") {
            let Some(inner) = block_of(&entry.value) else { continue };
            let values = scalar_list(Some(inner));
            if let (Some(province_id), Some(value)) = (parse_integer(values.first().copied()), parse_number(values.get(1).copied())) {
                victory_points.push(VictoryPoint { province_id, value });
            }
        }
    }
    let scope = history.unwrap_or(block);
    let mut owner = scope.first_scalar("owner").map(|s| s.value.to_string());
    let mut controller = scope.first_scalar("controller").map(|s| s.value.to_string());
    let scalars_of = |key: &'static str| -> Vec<String> {
        history.map_or_else(Vec::new, |h| {
            assignments(h, key)
                .filter_map(|a| match &a.value {
                    Node::Scalar(s) => Some(s.value.to_string()),
                    Node::Block(_) => None,
                })
                .collect()
        })
    };
    let mut cores = scalars_of("add_core_of");
    let mut claims = scalars_of("add_claim_by");
    if let Some(history) = history {
        let mut dated: Vec<(&hoi4_engine::symbol_index::reader::Assignment, i64)> =
            history.assignments().filter(|e| matches!(e.value, Node::Block(_))).filter_map(|e| parse_map_date(&e.key.value).map(|d| (e, d))).collect();
        dated.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.key.start.cmp(&b.0.key.start)));
        if let Some((first, _)) = dated.first()
            && earliest.is_none()
        {
            add_map_diagnostic(
                diagnostics,
                map_diagnostic(
                    "MAP_STATE_DATED_HISTORY_UNRESOLVED",
                    Severity::Warning,
                    format!("State {id} has dated history but no active bookmark date was found"),
                    Some(script.assignment_location(first, None)),
                ),
                None,
            );
        }
        for (entry, date) in &dated {
            let Some(earliest) = earliest else { continue };
            if *date >= earliest.ordinal {
                continue;
            }
            let Some(inner) = block_of(&entry.value) else { continue };
            for command in inner.assignments() {
                let key = command.key.value.as_ref();
                match &command.value {
                    Node::Scalar(value) => {
                        let value = value.value.to_string();
                        match key {
                            "owner" => owner = Some(value),
                            "controller" => controller = Some(value),
                            "add_core_of" if !cores.contains(&value) => cores.push(value),
                            "remove_core_of" => cores.retain(|tag| *tag != value),
                            "add_claim_by" if !claims.contains(&value) => claims.push(value),
                            "remove_claim_by" => claims.retain(|tag| *tag != value),
                            _ => {}
                        }
                    }
                    Node::Block(value) if key == "victory_points" => {
                        let values = scalar_list(Some(value));
                        let (Some(province_id), Some(amount)) = (parse_integer(values.first().copied()), parse_number(values.get(1).copied())) else {
                            continue;
                        };
                        victory_points.retain(|p| p.province_id != province_id);
                        victory_points.push(VictoryPoint { province_id, value: amount });
                    }
                    Node::Block(value) if key == "buildings" => {
                        for building in value.assignments() {
                            match &building.value {
                                Node::Block(levels) => {
                                    let Some(province_id) = parse_integer(Some(&building.key.value)) else { continue };
                                    let mut merged = province_buildings.get(&province_id).cloned().unwrap_or_default();
                                    for (k, level) in numeric_map(Some(levels)).iter() {
                                        merged.set(k.clone(), *level);
                                    }
                                    province_buildings.set(province_id, merged);
                                }
                                Node::Scalar(level) => {
                                    if let Some(level) = parse_number(Some(&level.value)) {
                                        state_buildings.set(building.key.value.to_string(), level);
                                    }
                                }
                            }
                        }
                    }
                    Node::Block(_) => {}
                }
            }
        }
    }
    Some(StateRecord {
        id,
        name: block.first_scalar("name").map_or_else(|| format!("STATE_{id}"), |s| s.value.to_string()),
        capital: derived_state_capital(&victory_points),
        manpower: parse_number(block.first_scalar("manpower").map(|s| s.value.as_ref())).unwrap_or(0.0),
        category: block.first_scalar("state_category").map_or_else(String::new, |s| s.value.to_string()),
        provinces,
        resources: numeric_map(resources),
        owner,
        controller,
        cores,
        claims,
        victory_points,
        province_buildings,
        state_buildings,
        path: script.path.to_string(),
        location: script.record_location(assignment, id),
    })
}

/// A provincial terrain category (`TerrainCategory`).
#[derive(Clone, Debug, Serialize)]
pub struct TerrainCategory {
    pub water: bool,
    pub naval: bool,
}

/// `parseTerrainCategories` over one file, in the caller's path order; a later file replaces a
/// category of the same name.
pub fn add_terrain_categories(script: &Script, categories: &mut OrderedMap<String, TerrainCategory>, diagnostics: &mut Vec<Diagnostic>) {
    add_parser_findings(script, diagnostics);
    for assignment in assignments(script.root(), "categories") {
        let Some(block) = block_of(&assignment.value) else { continue };
        for category in block.assignments() {
            let Some(inner) = block_of(&category.value) else { continue };
            let flag = |key: &str| inner.first_scalar(key).is_some_and(|s| s.value == "yes");
            categories.set(category.key.value.to_string(), TerrainCategory { water: flag("is_water"), naval: flag("naval_terrain") });
        }
    }
}

/// A building type (`BuildingDefinition`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildingDefinition {
    pub shares_slots: bool,
    pub provincial: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub province_max: Option<f64>,
    pub show_on_map: f64,
    pub only_coastal: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawn_point: Option<String>,
}

/// A spawn point (`BuildingSpawnPoint`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildingSpawnPoint {
    pub provincial: bool,
    pub max: f64,
    pub only_coastal: bool,
    pub auto_nudged: bool,
}

/// `Number(value)` of a JavaScript scalar, for the building numbers.
fn js_to_number(value: &str) -> Option<f64> {
    let trimmed = string(super::text::js_trim(&utf16(value)));
    if trimmed.is_empty() {
        return Some(0.0);
    }
    if let Some(hex) = trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")) {
        return u64::from_str_radix(hex, 16).ok().map(|v| v as f64);
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("inf") || lower.contains("nan") {
        return None;
    }
    trimmed.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// `parseBuildingDefinitions` over one file, in the caller's path order.
pub fn add_building_definitions(
    script: &Script,
    definitions: &mut OrderedMap<String, BuildingDefinition>,
    spawn_points: &mut OrderedMap<String, BuildingSpawnPoint>,
) {
    let yes = |block: &Block, key: &str| block.first_scalar(key).is_some_and(|s| s.value == "yes");
    let number_in = |block: Option<&Block>, key: &str| -> Option<f64> { block?.first_scalar(key).and_then(|s| js_to_number(&s.value)) };
    for assignment in script.root().assignments() {
        let Some(block) = block_of(&assignment.value) else { continue };
        if assignment.key.value == "buildings" {
            for building in block.assignments() {
                let Some(inner) = block_of(&building.value) else { continue };
                let cap = assignments(inner, "level_cap").next().and_then(|a| block_of(&a.value));
                let province_max = number_in(cap, "province_max").or_else(|| number_in(Some(inner), "province_max"));
                let state_max = number_in(cap, "state_max").or_else(|| number_in(Some(inner), "state_max"));
                definitions.set(
                    building.key.value.to_string(),
                    BuildingDefinition {
                        shares_slots: yes(inner, "shares_slots") || cap.is_some_and(|c| yes(c, "shares_slots")),
                        provincial: yes(inner, "provincial") || province_max.is_some(),
                        state_max,
                        province_max,
                        show_on_map: number_in(Some(inner), "show_on_map").unwrap_or(0.0),
                        only_coastal: yes(inner, "only_costal"),
                        spawn_point: inner.first_scalar("spawn_point").map(|s| s.value.to_string()),
                    },
                );
            }
        } else if assignment.key.value == "spawn_points" {
            for point in block.assignments() {
                let Some(inner) = block_of(&point.value) else { continue };
                spawn_points.set(
                    point.key.value.to_string(),
                    BuildingSpawnPoint {
                        provincial: inner.first_scalar("type").is_some_and(|s| s.value == "province"),
                        max: number_in(Some(inner), "max").unwrap_or(1.0),
                        only_coastal: yes(inner, "only_costal"),
                        auto_nudged: !yes(inner, "disable_auto_nudging"),
                    },
                );
            }
        }
    }
}

/// `parseContinents`.
pub fn parse_continents(script: &Script, diagnostics: &mut Vec<Diagnostic>) -> Option<Vec<String>> {
    add_parser_findings(script, diagnostics);
    let block = block_of(&assignments(script.root(), "continents").next()?.value)?;
    Some(scalar_list(Some(block)).into_iter().map(str::to_string).collect())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategicRegionRecord {
    pub id: i64,
    pub name: String,
    pub provinces: Vec<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub naval_terrain: Option<String>,
    pub path: String,
    #[serde(skip)]
    pub location: SourceLocation,
}

/// `parseStrategicRegion`.
pub fn parse_strategic_region(script: &Script, diagnostics: &mut Vec<Diagnostic>) -> Option<StrategicRegionRecord> {
    add_parser_findings(script, diagnostics);
    let assignment = assignments(script.root(), "strategic_region").next().or_else(|| assignments(script.root(), "strategic_region_template").next())?;
    let block = block_of(&assignment.value)?;
    let id_scalar = block.first_scalar("id");
    let id = parse_integer(id_scalar.map(|s| s.value.as_ref())).filter(|&id| id > 0 && id <= 2_147_483_647);
    let Some(id) = id else {
        let (code, message) = if id_scalar.is_none() {
            ("MAP_REGION_ID_MISSING", "Strategic region has no integer ID")
        } else {
            ("MAP_REGION_ID_INVALID", "Strategic-region ID must be a positive signed 32-bit integer")
        };
        add_map_diagnostic(diagnostics, map_diagnostic(code, Severity::Error, message, Some(script.assignment_location(assignment, None))), None);
        return None;
    };
    Some(StrategicRegionRecord {
        id,
        name: block.first_scalar("name").map_or_else(|| format!("STRATEGICREGION_{id}"), |s| s.value.to_string()),
        provinces: scalar_list(block.child_blocks("provinces").next()).into_iter().filter_map(|v| parse_integer(Some(v))).collect(),
        naval_terrain: block.first_scalar("naval_terrain").map(|s| s.value.to_string()),
        path: script.path.to_string(),
        location: script.record_location(assignment, id),
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjacencyRecord {
    pub index: usize,
    pub from: f64,
    pub to: f64,
    #[serde(rename = "type")]
    pub kind: String,
    pub through: f64,
    pub start_x: f64,
    pub start_y: f64,
    pub stop_x: f64,
    pub stop_y: f64,
    pub rule: String,
    pub comment: String,
    pub line: usize,
    #[serde(skip)]
    pub document: DocumentId,
}

/// `parseAdjacencies`.
pub fn parse_adjacencies(document: &TextDocument, id: DocumentId, diagnostics: &mut Vec<Diagnostic>) -> Vec<AdjacencyRecord> {
    let mut result = Vec::new();
    let mut terminator = false;
    let mut ignored = Vec::new();
    for line in &document.lines {
        let text = document.line_text(line);
        let trimmed = super::text::js_trim(text);
        if line.index == 0 || trimmed.is_empty() || trimmed[0] == u16::from(b'#') {
            continue;
        }
        if terminator {
            ignored.push(line);
            continue;
        }
        let parts = split_delimited(text, 10);
        if parts[0] == "-1" {
            terminator = true;
            continue;
        }
        if parts.len() < 9 {
            add_map_diagnostic(
                diagnostics,
                map_diagnostic("MAP_ADJACENCY_ROW_MALFORMED", Severity::Error, "Adjacency row has fewer than nine fields", Some(document.line_location(line))),
                None,
            );
            continue;
        }
        let numbers: Vec<Option<f64>> = [0, 1, 3, 4, 5, 6, 7].iter().map(|&i| parse_number(Some(&parts[i]))).collect();
        if numbers.iter().any(Option::is_none) {
            add_map_diagnostic(
                diagnostics,
                map_diagnostic(
                    "MAP_ADJACENCY_VALUE_INVALID",
                    Severity::Error,
                    "Adjacency row contains a non-numeric province or coordinate field",
                    Some(document.line_location(line)),
                ),
                None,
            );
            continue;
        }
        let n: Vec<f64> = numbers.into_iter().flatten().collect();
        result.push(AdjacencyRecord {
            index: result.len(),
            from: n[0],
            to: n[1],
            kind: if parts[2].is_empty() { "sea".into() } else { parts[2].clone() },
            through: n[2],
            start_x: n[3],
            start_y: n[4],
            stop_x: n[5],
            stop_y: n[6],
            rule: parts[8].clone(),
            comment: parts.get(9).cloned().unwrap_or_default(),
            line: line.index + 1,
            document: id,
        });
    }
    if let Some(first) = ignored.first() {
        let mut d = map_diagnostic(
            "MAP_ADJACENCY_AFTER_TERMINATOR",
            Severity::Warning,
            format!("{} adjacency row(s) follow the -1 terminator row and are not read", ignored.len()),
            Some(document.line_location(first)),
        );
        d.details = Some(script::details(json!({ "ignoredRows": ignored.len() })));
        add_map_diagnostic(diagnostics, d, None);
    }
    if !terminator {
        let location = document.lines.last().map(|line| document.line_location(line));
        add_map_diagnostic(
            diagnostics,
            map_diagnostic("MAP_ADJACENCY_TERMINATOR_MISSING", Severity::Warning, "Adjacency file has no -1;-1;-1;-1;-1;-1;-1;-1;-1 terminator row", location),
            None,
        );
    }
    result
}

/// `parseWhitespaceRows`: the non-empty rows of a whitespace table, with the field-limit finding.
fn whitespace_rows<'a>(document: &'a TextDocument, diagnostics: &mut Vec<Diagnostic>) -> Vec<(&'a super::text::TextLine, Vec<String>)> {
    let mut rows = Vec::new();
    for line in &document.lines {
        match whitespace_fields(document.line_text(line)) {
            None => {
                let mut d = map_diagnostic(
                    "MAP_TEXT_FIELD_LIMIT",
                    Severity::Blocker,
                    "Map text-table row exceeds the fixed field limit",
                    Some(document.line_location(line)),
                );
                d.details = Some(script::details(json!({ "limit": super::text::MAP_TEXT_FIELD_LIMIT })));
                add_map_diagnostic(diagnostics, d, None);
            }
            Some(values) if values.is_empty() => {}
            Some(values) => rows.push((line, values)),
        }
    }
    rows
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplyNodeRecord {
    pub level: i64,
    pub province_id: i64,
    pub line: usize,
    #[serde(skip)]
    pub document: DocumentId,
}

/// `parseSupplyNodes`.
pub fn parse_supply_nodes(document: &TextDocument, id: DocumentId, diagnostics: &mut Vec<Diagnostic>) -> Vec<SupplyNodeRecord> {
    let mut result = Vec::new();
    for (line, values) in whitespace_rows(document, diagnostics) {
        let level = parse_integer(values.first().map(String::as_str));
        let province = parse_integer(values.get(1).map(String::as_str));
        match (values.len(), level, province) {
            (2, Some(level), Some(province_id)) => result.push(SupplyNodeRecord { level, province_id, line: line.index + 1, document: id }),
            _ => add_map_diagnostic(
                diagnostics,
                map_diagnostic("MAP_SUPPLY_NODE_ROW_MALFORMED", Severity::Error, "Supply node row must be: level province", Some(document.line_location(line))),
                None,
            ),
        }
    }
    result
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RailwayRecord {
    pub level: i64,
    pub declared_count: i64,
    pub provinces: Vec<i64>,
    pub line: usize,
    #[serde(skip)]
    pub document: DocumentId,
}

/// `parseRailways`.
pub fn parse_railways(document: &TextDocument, id: DocumentId, diagnostics: &mut Vec<Diagnostic>) -> Vec<RailwayRecord> {
    let mut result = Vec::new();
    for (line, values) in whitespace_rows(document, diagnostics) {
        let level = parse_integer(values.first().map(String::as_str));
        let declared = parse_integer(values.get(1).map(String::as_str));
        let provinces: Option<Vec<i64>> = values.iter().skip(2).map(|v| parse_integer(Some(v))).collect();
        match (level, declared, provinces) {
            (Some(level), Some(declared_count), Some(provinces)) => {
                result.push(RailwayRecord { level, declared_count, provinces, line: line.index + 1, document: id })
            }
            _ => add_map_diagnostic(
                diagnostics,
                map_diagnostic(
                    "MAP_RAILWAY_ROW_MALFORMED",
                    Severity::Error,
                    "Railway row must contain an integer level, count, and province list",
                    Some(document.line_location(line)),
                ),
                None,
            ),
        }
    }
    result
}

fn is_blank_or_comment(text: &[u16]) -> bool {
    let trimmed = super::text::js_trim(text);
    trimmed.is_empty() || trimmed[0] == u16::from(b'#')
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildingPositionRecord {
    pub state_id: i64,
    pub building: String,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub rotation: f64,
    pub adjacent_sea_province: f64,
    pub line: usize,
    #[serde(skip)]
    pub document: DocumentId,
}

/// `parseBuildingPositions`.
pub fn parse_building_positions(document: &TextDocument, id: DocumentId, diagnostics: &mut Vec<Diagnostic>) -> Vec<BuildingPositionRecord> {
    let mut result = Vec::new();
    for line in &document.lines {
        let text = document.line_text(line);
        if is_blank_or_comment(text) {
            continue;
        }
        let parts = split_delimited(text, 8);
        let state_id = parse_integer(parts.first().map(String::as_str));
        let numbers: Vec<Option<f64>> = parts.iter().skip(2).take(5).map(|p| parse_number(Some(p))).collect();
        match state_id {
            Some(state_id) if parts.len() >= 7 && !parts[1].is_empty() && numbers.iter().all(Option::is_some) => {
                let n: Vec<f64> = numbers.into_iter().flatten().collect();
                result.push(BuildingPositionRecord {
                    state_id,
                    building: parts[1].clone(),
                    x: n[0],
                    y: n[1],
                    z: n[2],
                    rotation: n[3],
                    adjacent_sea_province: n[4],
                    line: line.index + 1,
                    document: id,
                });
            }
            _ => add_map_diagnostic(
                diagnostics,
                map_diagnostic(
                    "MAP_BUILDING_POSITION_ROW_MALFORMED",
                    Severity::Error,
                    "Building position row is malformed",
                    Some(document.line_location(line)),
                ),
                None,
            ),
        }
    }
    result
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitPositionRecord {
    pub province_id: f64,
    #[serde(rename = "type")]
    pub kind: f64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub rotation: f64,
    pub offset: f64,
    pub line: usize,
    #[serde(skip)]
    pub document: DocumentId,
}

/// `parseUnitPositions` (`parseDelimitedNumbers` with seven fields).
pub fn parse_unit_positions(document: &TextDocument, id: DocumentId, diagnostics: &mut Vec<Diagnostic>) -> Vec<UnitPositionRecord> {
    let mut result = Vec::new();
    for line in &document.lines {
        let text = document.line_text(line);
        if is_blank_or_comment(text) {
            continue;
        }
        let parts = split_delimited(text, 8);
        let numbers: Vec<Option<f64>> = parts.iter().take(7).map(|p| parse_number(Some(p))).collect();
        if parts.len() < 7 || numbers.iter().any(Option::is_none) {
            add_map_diagnostic(
                diagnostics,
                map_diagnostic(
                    "MAP_UNIT_POSITION_ROW_MALFORMED",
                    Severity::Error,
                    "Position row must contain at least 7 semicolon-separated fields",
                    Some(document.line_location(line)),
                ),
                None,
            );
            continue;
        }
        let n: Vec<f64> = numbers.into_iter().flatten().collect();
        result.push(UnitPositionRecord {
            province_id: n[0],
            kind: n[1],
            x: n[2],
            y: n[3],
            z: n[4],
            rotation: n[5],
            offset: n[6],
            line: line.index + 1,
            document: id,
        });
    }
    result
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherPositionRecord {
    pub strategic_region_id: i64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub size: String,
    pub line: usize,
    #[serde(skip)]
    pub document: DocumentId,
}

/// `parseWeatherPositions`.
pub fn parse_weather_positions(document: &TextDocument, id: DocumentId, diagnostics: &mut Vec<Diagnostic>) -> Vec<WeatherPositionRecord> {
    let mut result = Vec::new();
    for line in &document.lines {
        let text = document.line_text(line);
        if is_blank_or_comment(text) {
            continue;
        }
        let parts = split_delimited(text, 6);
        let region = parse_integer(parts.first().map(String::as_str));
        let coordinates: Vec<Option<f64>> = parts.iter().skip(1).take(3).map(|p| parse_number(Some(p))).collect();
        match region {
            Some(strategic_region_id) if parts.len() >= 5 && coordinates.iter().all(Option::is_some) && !parts[4].is_empty() => {
                let c: Vec<f64> = coordinates.into_iter().flatten().collect();
                result.push(WeatherPositionRecord {
                    strategic_region_id,
                    x: c[0],
                    y: c[1],
                    z: c[2],
                    size: parts[4].clone(),
                    line: line.index + 1,
                    document: id,
                });
            }
            _ => add_map_diagnostic(
                diagnostics,
                map_diagnostic("MAP_WEATHER_POSITION_ROW_MALFORMED", Severity::Error, "Weather position row is malformed", Some(document.line_location(line))),
                None,
            ),
        }
    }
    result
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityLocatorRecord {
    pub entity: String,
    pub name: String,
    pub position: [f64; 3],
    pub path: String,
}

/// `parseEntityLocators`.
pub fn parse_entity_locators(script: &Script, diagnostics: &mut Vec<Diagnostic>) -> Vec<EntityLocatorRecord> {
    add_parser_findings(script, diagnostics);
    let mut result = Vec::new();
    for entity_assignment in assignments(script.root(), "entity") {
        let Some(entity_block) = block_of(&entity_assignment.value) else { continue };
        let Some(entity) = entity_block.first_scalar("name") else { continue };
        for locator in assignments(entity_block, "locator") {
            let Some(locator_block) = block_of(&locator.value) else { continue };
            let name = locator_block.first_scalar("name");
            let position = locator_block.child_blocks("position").next();
            let values: Vec<Option<f64>> = scalar_list(position).into_iter().map(|v| parse_number(Some(v))).collect();
            match name {
                Some(name) if position.is_some() && values.len() == 3 && values.iter().all(Option::is_some) => result.push(EntityLocatorRecord {
                    entity: entity.value.to_string(),
                    name: name.value.to_string(),
                    position: [values[0].unwrap_or(0.0), values[1].unwrap_or(0.0), values[2].unwrap_or(0.0)],
                    path: script.path.to_string(),
                }),
                _ => add_map_diagnostic(
                    diagnostics,
                    map_diagnostic(
                        "MAP_ENTITY_LOCATOR_MALFORMED",
                        Severity::Error,
                        "Entity locator must have a name and three-number position",
                        Some(script.assignment_location(locator, Some(&entity.value))),
                    ),
                    None,
                ),
            }
        }
    }
    result
}

/// The parsed selectors of a `default.map`: the first scalar of each top-level key, or the
/// refusal `defaultMapSelectorValue` gives when the file has any parser finding.
pub type Selectors = Result<std::collections::HashMap<String, Option<String>>, MapError>;

/// Reads a `default.map` once for [`default_map_selector`]. `file` is its display path, relative
/// path, root kind and load order.
pub fn read_selectors(script: &Script, file: (&str, &str, &str, u32)) -> Selectors {
    let findings = script.diagnostics();
    if !findings.is_empty() {
        let mut codes: Vec<&str> = findings.iter().map(|d| d.code.as_str()).collect();
        codes.sort_unstable();
        codes.dedup();
        let (path, relative, root_kind, load_order) = file;
        let diagnostics: Vec<serde_json::Value> = findings
            .iter()
            .map(|d| {
                let mut value = json!({ "code": d.code, "severity": d.severity, "category": d.category });
                if let Some(location) = &d.location {
                    value["location"] = serde_json::to_value(location).unwrap_or_default();
                }
                value
            })
            .collect();
        return Err(MapError::new(
            "MAP_DEFAULT_MAP_SELECTOR_BLOCKED",
            format!("The map selector cannot be trusted: {path}"),
            json!({ "path": path, "relativePath": relative, "rootKind": root_kind, "loadOrder": load_order, "reasonCodes": codes, "diagnostics": diagnostics }),
        ));
    }
    let mut selectors = std::collections::HashMap::new();
    for assignment in script.root().assignments() {
        selectors.entry(assignment.key.value.to_string()).or_insert_with(|| match &assignment.value {
            Node::Scalar(s) => Some(s.value.to_string()),
            Node::Block(_) => None,
        });
    }
    Ok(selectors)
}

/// `defaultMapSelectorValue`: a key of `default.map`, or `fallback`.
pub fn default_map_selector(selectors: Option<&Selectors>, key: &str, fallback: &str) -> Result<String, MapError> {
    match selectors {
        None => Ok(fallback.to_string()),
        Some(Err(error)) => Err(error.clone()),
        Some(Ok(map)) => Ok(map.get(key).cloned().flatten().unwrap_or_else(|| fallback.to_string())),
    }
}

/// The number in a message, as JavaScript prints it.
pub fn n(value: f64) -> String {
    js_number(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::text::parse_text_document;

    fn text(body: &str) -> TextDocument {
        parse_text_document(body.as_bytes(), "mod:map/x.csv", "map/x.csv").unwrap()
    }

    #[test]
    fn reads_definitions_and_reports_bad_rows() {
        let mut diagnostics = Vec::new();
        let doc = text("0;0;0;0;land;false;unknown;0\n1;10;20;30;land;TRUE;plains;1\n2;300;0;0;sea;false;ocean;0\nbad\n");
        let definitions = parse_definitions(&doc, 0, &mut diagnostics);
        assert_eq!(definitions.len(), 2);
        assert_eq!((definitions[1].id, definitions[1].color.key(), definitions[1].coastal, definitions[1].line), (1, "10,20,30".to_string(), true, 2));
        let codes: Vec<_> = diagnostics.iter().map(|d| d.code.as_str()).collect();
        assert_eq!(codes, ["MAP_DEFINITION_VALUE_INVALID", "MAP_DEFINITION_ROW_MALFORMED"]);
    }

    #[test]
    fn applies_dated_history_before_the_earliest_bookmark() {
        let source: &[u8] = b"state = { id = 3 name = STATE_3 provinces = { 1 2 } history = { owner = AAA victory_points = { 1 5 } buildings = { infrastructure = 2 1 = { naval_base = 1 } }\n 1930.1.1 = { owner = BBB add_core_of = BBB victory_points = { 2 9 } }\n 1950.1.1 = { owner = CCC } } }";
        let earliest = BookmarkDate { value: "1936.1.1".into(), ordinal: parse_map_date("1936.1.1").unwrap(), source_path: "x".into() };
        let mut diagnostics = Vec::new();
        let state = script::with_script(source, "mod:history/states/3.txt", |s| parse_state(s, &mut diagnostics, Some(&earliest))).unwrap();
        assert!(diagnostics.is_empty());
        assert_eq!((state.owner.as_deref(), state.cores.clone(), state.capital), (Some("BBB"), vec!["BBB".to_string()], Some(2)));
        assert_eq!(state.province_buildings.get(&1).unwrap().get(&"naval_base".to_string()), Some(&1.0));
        assert_eq!(state.location.symbol.as_deref(), Some("3"));
        let state = script::with_script(source, "mod:history/states/3.txt", |s| parse_state(s, &mut diagnostics, None)).unwrap();
        assert_eq!(state.owner.as_deref(), Some("AAA"));
        assert_eq!(diagnostics[0].code, "MAP_STATE_DATED_HISTORY_UNRESOLVED");
    }

    #[test]
    fn reads_adjacencies_with_the_terminator_rules() {
        let mut diagnostics = Vec::new();
        let doc = text(
            "From;To;Type;Through;start_x;start_y;stop_x;stop_y;adjacency_rule_name;Comment\n1;2;;3;-1;-1;-1;-1;;a;b\n1;x;sea;3;-1;-1;-1;-1;\n-1;-1;-1;-1;-1;-1;-1;-1;-1\n4;5;sea;-1;-1;-1;-1;-1;\n",
        );
        let rows = parse_adjacencies(&doc, 0, &mut diagnostics);
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].kind.as_str(), rows[0].comment.as_str()), ("sea", "a;b"));
        let codes: Vec<_> = diagnostics.iter().map(|d| d.code.as_str()).collect();
        assert_eq!(codes, ["MAP_ADJACENCY_VALUE_INVALID", "MAP_ADJACENCY_AFTER_TERMINATOR"]);
    }

    #[test]
    fn refuses_an_untrusted_map_selector() {
        let file = ("game:map/default.map", "map/default.map", "game", 0);
        let good = script::with_script(b"definitions = \"my.csv\"", file.0, |s| read_selectors(s, file));
        assert_eq!(default_map_selector(Some(&good), "definitions", "definition.csv").unwrap(), "my.csv");
        assert_eq!(default_map_selector(Some(&good), "provinces", "provinces.bmp").unwrap(), "provinces.bmp");
        assert_eq!(default_map_selector(None, "provinces", "provinces.bmp").unwrap(), "provinces.bmp");
        let bad = script::with_script(b"definitions = {", file.0, |s| read_selectors(s, file));
        assert_eq!(default_map_selector(Some(&bad), "definitions", "x").unwrap_err().code, "MAP_DEFAULT_MAP_SELECTOR_BLOCKED");
    }
}
