//! The map index: definitions, states, strategic regions, the province raster, adjacencies and
//! the other map tables, built from the scanned files of one workspace (packet P13a).
//!
//! Ported from `src/hoi4_agent_tools/map/model.ts` (`MapWorkspaceIndex`, `MapModelBudget`,
//! `selectActiveFiles`, `definitionFilesAcrossRoots`, `fileInRoots`, `inConfiguredRoot`,
//! `earliestBookmarkDate`, `provinceAtMapCoordinate`), commit `9b7dc80d`. Lists and maps keep the
//! iteration order of the TypeScript arrays and `Map`s they replace, because validation reports
//! findings in that order.
//!
//! Issue 172: the TypeScript model counted building, unit and weather positions against the
//! 500,000 domain-record ceiling, so a map with large position tables (Old World Blues,
//! 533,984 records) could not be modelled. Positions are fixed-size rows, so they now have their
//! own ceiling ([`MAP_MODEL_MAX_POSITION_RECORDS`]); every other ceiling is unchanged.

use std::collections::{HashMap, HashSet};
use std::hash::Hash;

use hoi4_core::canonical::compare_code_units;
use hoi4_core::diagnostics::{Category, Diagnostic, Severity};
use hoi4_core::files::{RootKind, ScannedFile};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::parse::bmp::BmpImage;
use crate::parse::localisation::parse_localisation;
use crate::parse::records::{self, *};
use crate::parse::source::{self, Document};
use crate::parse::text::{TextDocument, parse_text_document};
use crate::validate::limit::add_map_diagnostic;

pub const MAP_PROVINCE_ENGINE_MAX_PIXELS: u64 = 13_238_272;
pub const MAP_MODEL_MAX_SCRIPT_FILES: usize = 5_000;
pub const MAP_MODEL_MAX_SOURCE_TOKENS: usize = 1_000_000;
pub const MAP_MODEL_MAX_RECORDS: usize = 500_000;
/// Building, unit and weather positions (issue 172).
pub const MAP_MODEL_MAX_POSITION_RECORDS: usize = 2_000_000;
pub const MAP_MODEL_MAX_LOCALISATION_RECORDS: usize = 2_000_000;
pub const MAP_MODEL_MAX_MEMBERSHIP_EDGES: usize = 1_000_000;

/// A refusal with a stable upper-case code, as a TypeScript `ServiceError` carries it.
#[derive(Clone, Debug, PartialEq)]
pub struct MapError {
    pub code: String,
    pub message: String,
    pub details: Value,
}

impl MapError {
    pub fn new(code: &str, message: impl Into<String>, details: Value) -> Self {
        Self { code: code.into(), message: message.into(), details }
    }

    pub fn plain(code: &str, message: impl Into<String>) -> Self {
        Self::new(code, message, json!({}))
    }

    /// The engine's error object: code, message and the details beside them.
    pub fn to_json(&self) -> Value {
        let mut value = json!({ "code": self.code, "message": self.message });
        if let Value::Object(details) = &self.details
            && !details.is_empty()
        {
            value["details"] = Value::Object(details.clone());
        }
        value
    }
}

impl std::fmt::Display for MapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for MapError {}

/// A map in insertion order, where setting an existing key keeps its place (a JavaScript `Map`).
#[derive(Clone, Debug, PartialEq)]
pub struct OrderedMap<K, V> {
    entries: Vec<(K, V)>,
    slots: HashMap<K, usize>,
}

impl<K, V> Default for OrderedMap<K, V> {
    fn default() -> Self {
        Self { entries: Vec::new(), slots: HashMap::new() }
    }
}

impl<K: Hash + Eq + Clone, V> OrderedMap<K, V> {
    pub fn set(&mut self, key: K, value: V) {
        match self.slots.get(&key) {
            Some(&slot) => self.entries[slot].1 = value,
            None => {
                self.slots.insert(key.clone(), self.entries.len());
                self.entries.push((key, value));
            }
        }
    }

    pub fn get(&self, key: &K) -> Option<&V> {
        self.slots.get(key).map(|&slot| &self.entries[slot].1)
    }

    pub fn get_mut(&mut self, key: &K) -> Option<&mut V> {
        self.slots.get(key).map(|&slot| &mut self.entries[slot].1)
    }

    /// The value of `key`, inserted with `make` when missing.
    pub fn entry(&mut self, key: K, make: impl FnOnce() -> V) -> &mut V {
        let slot = match self.slots.get(&key) {
            Some(&slot) => slot,
            None => {
                self.slots.insert(key.clone(), self.entries.len());
                self.entries.push((key, make()));
                self.entries.len() - 1
            }
        };
        &mut self.entries[slot].1
    }

    pub fn contains(&self, key: &K) -> bool {
        self.slots.contains_key(key)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
        self.entries.iter().map(|(k, v)| (k, v))
    }

    pub fn keys(&self) -> impl Iterator<Item = &K> {
        self.entries.iter().map(|(k, _)| k)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl<K: Serialize, V: Serialize> Serialize for OrderedMap<K, V> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.entries.len()))?;
        for (k, v) in &self.entries {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

/// The configured map, state and localisation roots (`MapIndexSourceRoots`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceRoots {
    pub map: Vec<String>,
    pub states: Vec<String>,
    pub localisation: Vec<String>,
}

impl Default for SourceRoots {
    fn default() -> Self {
        Self { map: vec!["map".into()], states: vec!["history/states".into()], localisation: vec!["localisation".into(), "localisation_synced".into()] }
    }
}

/// `normalizedPath`: forward slashes, no leading `./`, lower case.
pub fn normalized_path(value: &str) -> String {
    let slashed = value.replace('\\', "/");
    slashed.strip_prefix("./").unwrap_or(&slashed).to_lowercase()
}

fn normalize_root(value: &str) -> String {
    let path = normalized_path(value);
    let path = path.strip_prefix("./").unwrap_or(&path);
    path.strip_suffix('/').unwrap_or(path).to_string()
}

fn in_roots(relative: &str, roots: &[String]) -> bool {
    let value = normalized_path(relative);
    roots.iter().any(|root| value == *root || value.starts_with(&format!("{root}/")))
}

/// `path.posix.join(root, name).replaceAll('\\', '/')`.
fn posix_join(root: &str, name: &str) -> String {
    let joined = if root.is_empty() { name.to_string() } else { format!("{root}/{name}") };
    let absolute = joined.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|p| *p != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let mut out = parts.join("/");
    if absolute {
        out.insert(0, '/');
    }
    if out.is_empty() {
        out.push('.');
    }
    out.replace('\\', "/")
}

pub fn root_kind_name(kind: RootKind) -> &'static str {
    match kind {
        RootKind::Mod => "mod",
        RootKind::Game => "game",
        RootKind::Dlc => "dlc",
        RootKind::Dependency => "dependency",
        RootKind::Artifact => "artifact",
        RootKind::Cache => "cache",
        RootKind::Fixture => "fixture",
    }
}

/// `MapModelBudget`.
#[derive(Default)]
struct Budget {
    documents: HashSet<String>,
    tokens: usize,
    records: usize,
    positions: usize,
    localisation: usize,
    edges: usize,
}

impl Budget {
    fn block(kind: &str, observed: usize, limit: usize) -> MapError {
        MapError::new("MAP_MODEL_BUDGET_BLOCKED", format!("Map workspace model exceeds the fixed {kind} ceiling"), json!({ "kind": kind, "observed": observed, "limit": limit }))
    }

    fn script_files(count: usize) -> Result<(), MapError> {
        if count > MAP_MODEL_MAX_SCRIPT_FILES { Err(Self::block("script files", count, MAP_MODEL_MAX_SCRIPT_FILES)) } else { Ok(()) }
    }

    fn document(&mut self, document: &Document) -> Result<(), MapError> {
        if !self.documents.insert(document.path.clone()) {
            return Ok(());
        }
        self.tokens += document.tokens.len();
        if self.tokens > MAP_MODEL_MAX_SOURCE_TOKENS { Err(Self::block("retained source tokens", self.tokens, MAP_MODEL_MAX_SOURCE_TOKENS)) } else { Ok(()) }
    }

    fn records(&mut self, count: usize) -> Result<(), MapError> {
        self.records += count;
        if self.records > MAP_MODEL_MAX_RECORDS { Err(Self::block("domain records", self.records, MAP_MODEL_MAX_RECORDS)) } else { Ok(()) }
    }

    fn positions(&mut self, count: usize) -> Result<(), MapError> {
        self.positions += count;
        if self.positions > MAP_MODEL_MAX_POSITION_RECORDS { Err(Self::block("position records", self.positions, MAP_MODEL_MAX_POSITION_RECORDS)) } else { Ok(()) }
    }

    fn localisation(&mut self, count: usize) -> Result<(), MapError> {
        self.localisation += count;
        if self.localisation > MAP_MODEL_MAX_LOCALISATION_RECORDS {
            Err(Self::block("localisation records", self.localisation, MAP_MODEL_MAX_LOCALISATION_RECORDS))
        } else {
            Ok(())
        }
    }

    fn edges(&mut self, count: usize) -> Result<(), MapError> {
        self.edges += count;
        if self.edges > MAP_MODEL_MAX_MEMBERSHIP_EDGES { Err(Self::block("membership edges", self.edges, MAP_MODEL_MAX_MEMBERSHIP_EDGES)) } else { Ok(()) }
    }
}

/// The province raster with lookups (`ProvinceRaster`).
#[derive(Debug, Default)]
pub struct Raster {
    pub inner: hoi4_engine::map_provinces::Raster,
    adjacency: HashMap<i64, HashSet<i64>>,
    geometry: HashMap<i64, usize>,
    pub coastal: HashSet<i64>,
    pub components: HashMap<i64, u64>,
    pub holes: HashMap<i64, i64>,
    pub thin: HashSet<i64>,
}

impl Raster {
    fn new(inner: hoi4_engine::map_provinces::Raster) -> Self {
        let adjacency = inner.adjacency.iter().map(|(id, others)| (*id, others.iter().copied().collect())).collect();
        let geometry = inner.geometry.iter().enumerate().map(|(i, g)| (g.id, i)).collect();
        let coastal = inner.coastal.iter().copied().collect();
        let components = inner.components.iter().copied().collect();
        let holes = inner.holes.iter().copied().collect();
        let thin = inner.thin.iter().copied().collect();
        Self { inner, adjacency, geometry, coastal, components, holes, thin }
    }

    pub fn width(&self) -> u32 {
        self.inner.width
    }

    pub fn height(&self) -> u32 {
        self.inner.height
    }

    pub fn id_at(&self, offset: usize) -> i32 {
        self.inner.province_ids[offset]
    }

    pub fn neighbours(&self, id: i64) -> Option<&HashSet<i64>> {
        self.adjacency.get(&id)
    }

    /// Neighbours in first-touch order, as the TypeScript `Set` iterates them.
    pub fn ordered_neighbours(&self, id: i64) -> &[i64] {
        self.inner.adjacency.iter().find(|(p, _)| *p == id).map_or(&[], |(_, n)| n.as_slice())
    }

    pub fn adjacent(&self, a: i64, b: i64) -> bool {
        self.adjacency.get(&a).is_some_and(|set| set.contains(&b))
    }

    pub fn geometry(&self, id: i64) -> Option<&hoi4_engine::map_provinces::Geometry> {
        self.geometry.get(&id).map(|&i| &self.inner.geometry[i])
    }
}

/// A float that is an exact province id.
pub fn as_id(value: f64) -> Option<i64> {
    (value.fract() == 0.0 && value.abs() < 9e15).then_some(value as i64)
}

/// `MapWorkspaceIndex`.
pub struct MapIndex {
    /// Every scanned file, shadowed ones included, in the order given.
    pub files: Vec<ScannedFile>,
    pub roots: SourceRoots,
    /// The winning file of each relative path, by load order then relative path.
    pub active: Vec<usize>,
    by_relative: HashMap<String, usize>,
    pub earliest_bookmark: Option<BookmarkDate>,
    pub diagnostics: Vec<Diagnostic>,
    pub documents: Vec<TextDocument>,
    pub definitions: Vec<ProvinceDefinition>,
    pub definitions_across_roots: Vec<ProvinceDefinition>,
    definitions_by_id: HashMap<i64, usize>,
    pub definition_ids_in_order: Vec<i64>,
    definitions_by_color: HashMap<u32, usize>,
    pub definition_colors_in_order: Vec<u32>,
    pub duplicate_ids: OrderedMap<i64, Vec<usize>>,
    pub duplicate_colors: OrderedMap<String, Vec<usize>>,
    pub states: Vec<StateRecord>,
    pub states_across_roots: usize,
    states_by_id: HashMap<i64, usize>,
    states_by_province: HashMap<i64, Vec<usize>>,
    pub regions: Vec<StrategicRegionRecord>,
    regions_by_id: HashMap<i64, usize>,
    pub localisation_keys: HashSet<String>,
    pub province_bitmap_file: Option<usize>,
    pub province_bitmap: Option<BmpImage>,
    pub raster: Option<Raster>,
    pub default_map_file: Option<usize>,
    pub definition_file: Option<usize>,
    pub adjacency_file: Option<usize>,
    pub continent_file: Option<usize>,
    pub continents: Option<Vec<String>>,
    pub terrain_categories: Option<OrderedMap<String, TerrainCategory>>,
    pub building_definitions: OrderedMap<String, BuildingDefinition>,
    pub building_spawn_points: OrderedMap<String, BuildingSpawnPoint>,
    pub supply_node_file: Option<usize>,
    pub railway_file: Option<usize>,
    pub heightmap_file: Option<usize>,
    pub rivers_file: Option<usize>,
    pub terrain_bitmap_file: Option<usize>,
    pub adjacencies: Vec<AdjacencyRecord>,
    pub supply_nodes: Vec<SupplyNodeRecord>,
    pub railways: Vec<RailwayRecord>,
    pub building_positions: Vec<BuildingPositionRecord>,
    pub unit_positions: Vec<UnitPositionRecord>,
    pub weather_positions: Vec<WeatherPositionRecord>,
    pub entity_locators: Vec<EntityLocatorRecord>,
    /// The parsed `default.map`, for the selectors of the appearance checks.
    pub default_map: Option<Document>,
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

impl MapIndex {
    /// The file of a relative path among the active files.
    pub fn active_file(&self, relative: &str) -> Option<usize> {
        self.by_relative.get(&normalized_path(relative)).copied()
    }

    /// `fileInRoots` / `mapFile`.
    pub fn map_file(&self, name: &str) -> Option<usize> {
        self.roots.map.iter().find_map(|root| self.active_file(&posix_join(root, name)))
    }

    pub fn file(&self, index: usize) -> &ScannedFile {
        &self.files[index]
    }

    /// `defaultMapSelectorValue` on the active `default.map`.
    pub fn selector(&self, key: &str, fallback: &str) -> Result<String, MapError> {
        let file = self.default_map_file.map(|i| &self.files[i]);
        records::default_map_selector(
            self.default_map.as_ref(),
            file.map(|f| (f.display_path.as_str(), f.relative_path.as_str(), root_kind_name(f.root_kind), f.load_order)),
            key,
            fallback,
        )
    }

    pub fn definition(&self, id: i64) -> Option<&ProvinceDefinition> {
        self.definitions_by_id.get(&id).map(|&i| &self.definitions[i])
    }

    pub fn definition_f(&self, id: f64) -> Option<&ProvinceDefinition> {
        as_id(id).and_then(|id| self.definition(id))
    }

    pub fn definition_by_color(&self, packed: u32) -> Option<&ProvinceDefinition> {
        self.definitions_by_color.get(&packed).map(|&i| &self.definitions[i])
    }

    pub fn has_state(&self, id: i64) -> bool {
        self.states_by_id.contains_key(&id)
    }

    pub fn state(&self, id: i64) -> Option<&StateRecord> {
        self.states_by_id.get(&id).map(|&i| &self.states[i])
    }

    pub fn state_ids(&self) -> impl Iterator<Item = i64> + '_ {
        self.states_by_id.keys().copied()
    }

    pub fn has_region(&self, id: i64) -> bool {
        self.regions_by_id.contains_key(&id)
    }

    /// `stateForProvince`: the states listing a province.
    pub fn states_of(&self, province: i64) -> &[usize] {
        self.states_by_province.get(&province).map_or(&[], Vec::as_slice)
    }

    pub fn coastal(&self, id: i64) -> bool {
        self.raster.as_ref().is_some_and(|r| r.coastal.contains(&id))
    }

    /// `provinceAtMapCoordinate`: the province under a map position (x east, z north).
    pub fn province_at(&self, x: f64, z: f64) -> Option<i64> {
        let raster = self.raster.as_ref()?;
        let px = x.floor();
        let py = f64::from(raster.height()) - 1.0 - z.floor();
        if px < 0.0 || px >= f64::from(raster.width()) || py < 0.0 || py >= f64::from(raster.height()) {
            return None;
        }
        let id = raster.id_at(py as usize * raster.width() as usize + px as usize);
        (id >= 0).then_some(i64::from(id))
    }

    /// `MapWorkspaceIndex.build`.
    pub fn build(files: Vec<ScannedFile>, roots: SourceRoots) -> Result<MapIndex, MapError> {
        let roots = SourceRoots {
            map: roots.map.iter().map(|r| normalize_root(r)).collect(),
            states: roots.states.iter().map(|r| normalize_root(r)).collect(),
            localisation: roots.localisation.iter().map(|r| normalize_root(r)).collect(),
        };
        // `selectActiveFiles`.
        let mut order: Vec<usize> = (0..files.len()).collect();
        order.sort_by(|&a, &b| files[a].load_order.cmp(&files[b].load_order).then_with(|| compare_code_units(&files[a].display_path, &files[b].display_path)));
        let mut by_relative = HashMap::new();
        for &i in &order {
            by_relative.insert(normalized_path(&files[i].relative_path), i);
        }
        let mut active: Vec<usize> = by_relative.values().copied().collect();
        active.sort_by(|&a, &b| files[a].load_order.cmp(&files[b].load_order).then_with(|| compare_code_units(&files[a].relative_path, &files[b].relative_path)));

        let mut index = MapIndex {
            files,
            roots,
            active,
            by_relative,
            earliest_bookmark: None,
            diagnostics: Vec::new(),
            documents: Vec::new(),
            definitions: Vec::new(),
            definitions_across_roots: Vec::new(),
            definitions_by_id: HashMap::new(),
            definition_ids_in_order: Vec::new(),
            definitions_by_color: HashMap::new(),
            definition_colors_in_order: Vec::new(),
            duplicate_ids: OrderedMap::default(),
            duplicate_colors: OrderedMap::default(),
            states: Vec::new(),
            states_across_roots: 0,
            states_by_id: HashMap::new(),
            states_by_province: HashMap::new(),
            regions: Vec::new(),
            regions_by_id: HashMap::new(),
            localisation_keys: HashSet::new(),
            province_bitmap_file: None,
            province_bitmap: None,
            raster: None,
            default_map_file: None,
            definition_file: None,
            adjacency_file: None,
            continent_file: None,
            continents: None,
            terrain_categories: None,
            building_definitions: OrderedMap::default(),
            building_spawn_points: OrderedMap::default(),
            supply_node_file: None,
            railway_file: None,
            heightmap_file: None,
            rivers_file: None,
            terrain_bitmap_file: None,
            adjacencies: Vec::new(),
            supply_nodes: Vec::new(),
            railways: Vec::new(),
            building_positions: Vec::new(),
            unit_positions: Vec::new(),
            weather_positions: Vec::new(),
            entity_locators: Vec::new(),
            default_map: None,
        };
        index.load()?;
        Ok(index)
    }

    fn display(&self, file: usize) -> &str {
        &self.files[file].display_path
    }

    fn parse_script(&self, file: usize) -> Document {
        source::parse(&self.files[file].bytes, &self.files[file].display_path)
    }

    fn text_document(&mut self, file: usize) -> Result<usize, MapError> {
        let f = &self.files[file];
        let document = parse_text_document(&f.bytes, &f.display_path, &f.relative_path)?;
        self.documents.push(document);
        Ok(self.documents.len() - 1)
    }

    fn is_region_file(&self, relative: &str) -> bool {
        let path = normalized_path(relative);
        self.roots.map.iter().any(|root| path.starts_with(&format!("{root}/strategicregions/")))
    }

    fn is_locator_asset(file: &ScannedFile) -> bool {
        matches!(file.root_kind, RootKind::Mod | RootKind::Fixture) && normalized_path(&file.relative_path).ends_with(".asset") && contains_bytes(&file.bytes, b"locator")
    }

    fn load(&mut self) -> Result<(), MapError> {
        // `earliestBookmarkDate` over the active files.
        for &file in &self.active.clone() {
            let path = normalized_path(&self.files[file].relative_path);
            if !(path.starts_with("common/bookmarks/") && path.ends_with(".txt")) {
                continue;
            }
            let document = self.parse_script(file);
            for (value, ordinal) in records::bookmark_dates(&document) {
                if self.earliest_bookmark.as_ref().is_none_or(|e| ordinal < e.ordinal) {
                    self.earliest_bookmark = Some(BookmarkDate { value, ordinal, source_path: self.files[file].display_path.clone() });
                }
            }
        }
        let mut budget = Budget::default();
        let script_files = self
            .files
            .iter()
            .filter(|f| in_roots(&f.relative_path, &self.roots.states) || self.is_region_file(&f.relative_path) || Self::is_locator_asset(f))
            .count();
        Budget::script_files(script_files)?;

        self.default_map_file = self.roots.map.iter().find_map(|root| self.active_file(&posix_join(root, "default.map")));
        self.default_map = self.default_map_file.map(|f| self.parse_script(f));
        let definitions_name = self.selector("definitions", "definition.csv")?;
        let provinces_name = self.selector("provinces", "provinces.bmp")?;
        self.definition_file = self.map_file(&definitions_name);
        self.province_bitmap_file = self.map_file(&provinces_name);

        // `definitionFilesAcrossRoots`.
        let mut groups: OrderedMap<(RootKind, u32), Vec<usize>> = OrderedMap::default();
        for (i, file) in self.files.iter().enumerate() {
            groups.entry((file.root_kind, file.load_order), Vec::new).push(i);
        }
        let mut selected: OrderedMap<String, usize> = OrderedMap::default();
        for (_, group) in groups.iter() {
            let mut by_path: HashMap<String, usize> = HashMap::new();
            for &i in group {
                by_path.insert(normalized_path(&self.files[i].relative_path), i);
            }
            for root in &self.roots.map {
                let default_map = by_path.get(&normalized_path(&posix_join(root, "default.map"))).copied();
                let document = default_map.map(|f| self.parse_script(f));
                let file = default_map.map(|f| &self.files[f]);
                let name = records::default_map_selector(
                    document.as_ref(),
                    file.map(|f| (f.display_path.as_str(), f.relative_path.as_str(), root_kind_name(f.root_kind), f.load_order)),
                    "definitions",
                    &definitions_name,
                )?;
                if let Some(&definition) = by_path.get(&normalized_path(&posix_join(root, &name))) {
                    selected.set(self.files[definition].display_path.clone(), definition);
                }
            }
        }
        let mut definition_files: Vec<usize> = selected.iter().map(|(_, &i)| i).collect();
        definition_files.sort_by(|&a, &b| self.files[a].load_order.cmp(&self.files[b].load_order).then_with(|| compare_code_units(self.display(a), self.display(b))));
        let mut parsed: HashMap<String, Vec<ProvinceDefinition>> = HashMap::new();
        let active_definition_path = self.definition_file.map(|f| self.files[f].display_path.clone());
        let mut parse_definitions_of = |index: &mut MapIndex, file: usize, budget: &mut Budget| -> Result<Vec<ProvinceDefinition>, MapError> {
            let path = index.files[file].display_path.clone();
            if let Some(cached) = parsed.get(&path) {
                return Ok(cached.clone());
            }
            let document = index.text_document(file)?;
            let mut sink = Vec::new();
            let target = if active_definition_path.as_deref() == Some(path.as_str()) { &mut index.diagnostics } else { &mut sink };
            let definitions = records::parse_definitions(&index.documents[document], document, target);
            budget.records(definitions.len())?;
            parsed.insert(path, definitions.clone());
            Ok(definitions)
        };
        let mut across = Vec::new();
        for file in definition_files {
            across.extend(parse_definitions_of(self, file, &mut budget)?);
        }
        self.definitions_across_roots = across;
        self.definitions = match self.definition_file {
            Some(file) => parse_definitions_of(self, file, &mut budget)?,
            None => Vec::new(),
        };
        for (i, definition) in self.definitions.iter().enumerate() {
            self.duplicate_ids.entry(definition.id, Vec::new).push(i);
            self.duplicate_colors.entry(definition.color.key(), Vec::new).push(i);
            if !self.definitions_by_id.contains_key(&definition.id) {
                self.definitions_by_id.insert(definition.id, i);
                self.definition_ids_in_order.push(definition.id);
            }
            let packed = definition.color.packed();
            if !self.definitions_by_color.contains_key(&packed) {
                self.definitions_by_color.insert(packed, i);
                self.definition_colors_in_order.push(packed);
            }
        }

        if let Some(file) = self.province_bitmap_file {
            match BmpImage::decode(&self.files[file].bytes) {
                Ok(bitmap) => self.province_bitmap = Some(bitmap),
                Err(error) => add_map_diagnostic(&mut self.diagnostics, source::diagnostic(&error.code, Severity::Error, Category::Map, error.message, None, None), None),
            }
        }
        if let Some(bitmap) = &self.province_bitmap {
            let request = hoi4_engine::map_provinces::Request {
                schema: hoi4_engine::map_provinces::REQUEST_SCHEMA.into(),
                width: bitmap.width,
                height: bitmap.height,
                top_down: bitmap.top_down,
                bits_per_pixel: bitmap.bits_per_pixel,
                pixel_offset: bitmap.pixel_offset,
                row_stride: bitmap.row_stride,
                palette: bitmap.palette.iter().map(|c| [c.r, c.g, c.b]).collect(),
                colors: self.definition_colors_in_order.iter().map(|&c| (c, self.definitions[self.definitions_by_color[&c]].id)).collect(),
                types: self.definition_ids_in_order.iter().map(|&id| (id, self.definitions[self.definitions_by_id[&id]].kind.clone())).collect(),
            };
            let raster = hoi4_engine::map_provinces::build(&request, &bitmap.bytes)
                .map_err(|e| MapError::new(e.code, e.message, json!({ "x": e.x, "y": e.y, "index": e.index })))?;
            self.raster = Some(Raster::new(raster));
        }

        // States: every state file across roots is parsed once; only active ones report findings.
        let state_files: Vec<usize> = self.active.iter().copied().filter(|&f| in_roots(&self.files[f].relative_path, &self.roots.states)).collect();
        let active_state_paths: HashSet<String> = state_files.iter().map(|&f| self.files[f].display_path.clone()).collect();
        let mut parsed_states: HashMap<String, Option<StateRecord>> = HashMap::new();
        let mut across_count = 0;
        let all_state_files: Vec<usize> = (0..self.files.len()).filter(|&f| in_roots(&self.files[f].relative_path, &self.roots.states)).collect();
        let earliest = self.earliest_bookmark.clone();
        let mut state_for = |index: &mut MapIndex, file: usize, budget: &mut Budget| -> Result<Option<StateRecord>, MapError> {
            let path = index.files[file].display_path.clone();
            if let Some(cached) = parsed_states.get(&path) {
                return Ok(cached.clone());
            }
            let document = index.parse_script(file);
            let mut sink = Vec::new();
            let target = if active_state_paths.contains(&path) { &mut index.diagnostics } else { &mut sink };
            let state = records::parse_state(&document, target, earliest.as_ref());
            if let Some(state) = &state {
                budget.document(&document)?;
                budget.records(1)?;
                budget.edges(state.provinces.len() + state.victory_points.len() + state.province_buildings.len() + state.cores.len() + state.claims.len())?;
            }
            parsed_states.insert(path, state.clone());
            Ok(state)
        };
        for file in all_state_files {
            if state_for(self, file, &mut budget)?.is_some() {
                across_count += 1;
            }
        }
        self.states_across_roots = across_count;
        let mut states = Vec::new();
        for file in state_files {
            if let Some(state) = state_for(self, file, &mut budget)? {
                states.push(state);
            }
        }
        self.states = states;
        for (i, state) in self.states.iter().enumerate() {
            self.states_by_id.entry(state.id).or_insert(i);
            for &province in &state.provinces {
                self.states_by_province.entry(province).or_default().push(i);
            }
        }

        let region_files: Vec<usize> = self.active.iter().copied().filter(|&f| self.is_region_file(&self.files[f].relative_path)).collect();
        for file in region_files {
            let document = self.parse_script(file);
            if let Some(region) = records::parse_strategic_region(&document, &mut self.diagnostics) {
                budget.document(&document)?;
                budget.records(1)?;
                budget.edges(region.provinces.len())?;
                self.regions.push(region);
            }
        }
        for (i, region) in self.regions.iter().enumerate() {
            self.regions_by_id.entry(region.id).or_insert(i);
        }

        let continent_name = self.selector("continent", "continent.txt")?;
        self.continent_file = self.map_file(&continent_name);
        if let Some(file) = self.continent_file {
            let document = self.parse_script(file);
            self.continents = records::parse_continents(&document, &mut self.diagnostics);
        }
        let mut terrain_files: Vec<usize> = self
            .active
            .iter()
            .copied()
            .filter(|&f| {
                let path = normalized_path(&self.files[f].relative_path);
                path.strip_prefix("common/terrain/").is_some_and(|rest| !rest.is_empty() && !rest.contains('/') && rest.len() > 4 && rest.ends_with(".txt"))
            })
            .collect();
        if !terrain_files.is_empty() {
            terrain_files.sort_by(|&a, &b| compare_code_units(&normalized_path(&self.files[a].relative_path), &normalized_path(&self.files[b].relative_path)));
            let mut categories = OrderedMap::default();
            for file in terrain_files {
                let document = self.parse_script(file);
                records::add_terrain_categories(&document, &mut categories, &mut self.diagnostics);
            }
            self.terrain_categories = Some(categories);
        }
        self.heightmap_file = self.map_file(&self.selector("heightmap", "heightmap.bmp")?);
        self.rivers_file = self.map_file(&self.selector("rivers", "rivers.bmp")?);
        self.terrain_bitmap_file = self.map_file(&self.selector("terrain", "terrain.bmp")?);
        let mut building_files: Vec<usize> = self
            .active
            .iter()
            .copied()
            .filter(|&f| {
                let path = normalized_path(&self.files[f].relative_path);
                path.strip_prefix("common/buildings/").is_some_and(|rest| !rest.contains('/') && rest.len() > 4 && rest.ends_with(".txt"))
            })
            .collect();
        building_files.sort_by(|&a, &b| compare_code_units(&normalized_path(&self.files[a].relative_path), &normalized_path(&self.files[b].relative_path)));
        for file in building_files {
            let document = self.parse_script(file);
            records::add_building_definitions(&document, &mut self.building_definitions, &mut self.building_spawn_points);
        }

        self.adjacency_file = self.map_file(&self.selector("adjacencies", "adjacencies.csv")?);
        if let Some(file) = self.adjacency_file {
            let document = self.text_document(file)?;
            self.adjacencies = records::parse_adjacencies(&self.documents[document], document, &mut self.diagnostics);
        }
        budget.records(self.adjacencies.len())?;
        self.supply_node_file = self.map_file(&self.selector("supply_nodes", "supply_nodes.txt")?);
        if let Some(file) = self.supply_node_file {
            let document = self.text_document(file)?;
            self.supply_nodes = records::parse_supply_nodes(&self.documents[document], document, &mut self.diagnostics);
        }
        budget.records(self.supply_nodes.len())?;
        budget.edges(self.supply_nodes.len())?;
        self.railway_file = self.map_file(&self.selector("railways", "railways.txt")?);
        if let Some(file) = self.railway_file {
            let document = self.text_document(file)?;
            self.railways = records::parse_railways(&self.documents[document], document, &mut self.diagnostics);
        }
        budget.records(self.railways.len())?;
        budget.edges(self.railways.iter().map(|r| r.provinces.len()).sum())?;
        if let Some(file) = self.map_file("buildings.txt") {
            let document = self.text_document(file)?;
            self.building_positions = records::parse_building_positions(&self.documents[document], document, &mut self.diagnostics);
        }
        budget.positions(self.building_positions.len())?;
        let unitstacks = self.map_file("unitstacks.txt");
        let positions = self.map_file(&self.selector("positions", "positions.txt")?);
        for file in [unitstacks, positions].into_iter().flatten() {
            if self.files[file].size == 0 {
                continue;
            }
            let document = self.text_document(file)?;
            let rows = records::parse_unit_positions(&self.documents[document], document, &mut self.diagnostics);
            self.unit_positions.extend(rows);
        }
        budget.positions(self.unit_positions.len())?;
        if let Some(file) = self.map_file("weatherpositions.txt") {
            let document = self.text_document(file)?;
            self.weather_positions = records::parse_weather_positions(&self.documents[document], document, &mut self.diagnostics);
        }
        budget.positions(self.weather_positions.len())?;
        for file in self.active.clone() {
            if !Self::is_locator_asset(&self.files[file]) {
                continue;
            }
            let document = self.parse_script(file);
            let locators = records::parse_entity_locators(&document, &mut self.diagnostics);
            if !locators.is_empty() {
                budget.document(&document)?;
            }
            budget.records(locators.len())?;
            self.entity_locators.extend(locators);
        }
        for file in self.active.clone() {
            let f = &self.files[file];
            if !in_roots(&f.relative_path, &self.roots.localisation) || !normalized_path(&f.relative_path).ends_with(".yml") {
                continue;
            }
            let document = parse_localisation(&f.bytes, &f.display_path);
            if matches!(f.root_kind, RootKind::Mod | RootKind::Fixture) {
                for d in document.diagnostics {
                    add_map_diagnostic(&mut self.diagnostics, d, None);
                }
            }
            budget.localisation(document.entries.len())?;
            for entry in document.entries {
                self.localisation_keys.insert(format!("{}:{}", entry.language, entry.key));
            }
        }
        Ok(())
    }

    /// The index in the shape `map.index` answers: counts, records and the model's findings.
    pub fn summary(&self) -> Value {
        json!({
            "files": self.active.len(),
            "provinceBitmap": self.province_bitmap.as_ref().map(|b| json!({ "width": b.width, "height": b.height, "bitsPerPixel": b.bits_per_pixel })),
            "definitions": self.definitions,
            "states": self.states,
            "strategicRegions": self.regions,
            "adjacencies": self.adjacencies,
            "supplyNodes": self.supply_nodes,
            "railways": self.railways,
            "buildingPositions": self.building_positions.len(),
            "unitPositions": self.unit_positions.len(),
            "weatherPositions": self.weather_positions.len(),
            "entityLocators": self.entity_locators,
            "continents": self.continents,
            "terrainCategories": self.terrain_categories,
            "earliestBookmark": self.earliest_bookmark,
            "localisationKeys": self.localisation_keys.len(),
            "coastalProvinces": self.raster.as_ref().map(|r| r.inner.coastal.clone()),
            "diagnostics": self.diagnostics,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_like_posix_path_join() {
        assert_eq!(posix_join("map", "definition.csv"), "map/definition.csv");
        assert_eq!(posix_join("map", "./sub/../x.csv"), "map/x.csv");
        assert_eq!(posix_join("map", "..\\x.csv"), "map/../x.csv");
        assert_eq!(normalize_root("./Map/"), "map");
    }

    #[test]
    fn ordered_map_keeps_the_first_insertion_place() {
        let mut map = OrderedMap::default();
        map.set("b", 1);
        map.set("a", 2);
        map.set("b", 3);
        assert_eq!(map.iter().map(|(k, v)| (*k, *v)).collect::<Vec<_>>(), [("b", 3), ("a", 2)]);
    }
}
