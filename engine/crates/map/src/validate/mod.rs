//! Map validation: every check with its codes, severities, messages and limits (packet P13a).
//!
//! Ported from `src/hoi4_agent_tools/map/validation.ts` (`validateMap`, `validateDefinitions`,
//! `validateGeometry`, `validateStatesAndRegions`, `validateNetworksAndAdjacencies`,
//! `validatePositions`, `mapValidationChecks`, `sameLandmass`, `contiguousMissing`), commit
//! `9b7dc80d`. The checks run in the TypeScript order and report findings in the TypeScript
//! order, because the finding ceiling keeps the first ones and the sort is stable.
//!
//! - [`limit`]: the finding ceiling.
//! - [`crossing`]: straits and other crossings (`gameplay/crossing-validation.ts`).
//! - [`appearance`]: heightmap, terrain, rivers, trees, colours and the world edge
//!   (`appearance-validation.ts`).

pub mod appearance;
pub mod crossing;
pub mod limit;

use std::collections::{HashMap, HashSet};

use hoi4_core::diagnostics::{Category, Diagnostic, Severity, SourceLocation, sort_diagnostics};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::model::{MAP_PROVINCE_ENGINE_MAX_PIXELS, MapIndex, OrderedMap, as_id};
use crate::parse::bmp::BmpImage;
use crate::parse::records::{ProvinceDefinition, n};
use crate::parse::script::details;
use limit::{add_active_map_diagnostic, add_map_diagnostic};

const DETAIL_SAMPLE_LIMIT: usize = 100;

/// The world edge policy of a world being created (`EdgeMode` of `world-edge.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EdgeMode {
    SeaBand,
    Rim,
    Wall,
    None,
}

/// What the baseline index of a write contributes to validation.
#[derive(Default)]
pub struct Baseline {
    pub state_ids: HashSet<i64>,
    pub province_bitmap: Option<BmpImage>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub min_x: i64,
    pub min_y: i64,
    pub max_x: i64,
    pub max_y: i64,
}

/// `MapValidationOptions`.
#[derive(Default)]
pub struct Options {
    pub operation_id: Option<String>,
    pub expected_changed_bounds: Option<Bounds>,
    pub baseline: Option<Baseline>,
    pub include_baseline_diagnostics: bool,
    pub diagnostic_limit: Option<usize>,
    pub edge_mode: Option<EdgeMode>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Check {
    pub id: &'static str,
    pub passed: bool,
    pub message: &'static str,
}

/// `MapValidationResult`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ValidationResult {
    pub passed: bool,
    pub diagnostics: Vec<Diagnostic>,
    pub checks: Vec<Check>,
}

/// The findings of one validation with its options.
pub struct Findings<'a> {
    pub list: Vec<Diagnostic>,
    options: &'a Options,
    /// Collect every finding as reported, without the ceiling or the operation id.
    raw: bool,
}

impl Findings<'_> {
    /// `addDiagnostic`: the operation id when the finding has none, under the ceiling.
    pub fn add(&mut self, mut diagnostic: Diagnostic) {
        if self.raw {
            self.list.push(diagnostic);
            return;
        }
        if diagnostic.operation_id.is_none() {
            diagnostic.operation_id.clone_from(&self.options.operation_id);
        }
        if self.options.include_baseline_diagnostics {
            add_active_map_diagnostic(&mut self.list, diagnostic, self.options.diagnostic_limit);
        } else {
            add_map_diagnostic(&mut self.list, diagnostic, self.options.diagnostic_limit);
        }
    }

    /// A map finding.
    pub fn map(&mut self, code: &str, severity: Severity, message: impl Into<String>, location: Option<SourceLocation>, detail: Option<Value>) {
        let mut d = Diagnostic::new(code, severity, Category::Map, message);
        d.location = location;
        d.details = detail.map(details);
        self.add(d);
    }
}

fn definition_location(index: &MapIndex, definition: &ProvinceDefinition) -> SourceLocation {
    index.documents[definition.document].required_location(definition.line)
}

/// `contiguousMissing`: the ids missing from `start` up, as a sample of 100 and a total.
fn contiguous_missing(ids: &[i64], start: i64) -> (Vec<i64>, i64) {
    let mut sorted: Vec<i64> = ids.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut sample = Vec::new();
    let mut total = 0;
    let mut expected = start;
    for id in sorted {
        if id < expected {
            continue;
        }
        if id > expected {
            total += id - expected;
            let mut missing = expected;
            while missing < id && sample.len() < 100 {
                sample.push(missing);
                missing += 1;
            }
        }
        expected = id + 1;
    }
    (sample, total)
}

fn validate_definitions(index: &MapIndex, out: &mut Findings) {
    if index.definition_file.is_none() {
        out.map("MAP_DEFINITION_FILE_MISSING", Severity::Error, "The active definition.csv file is missing", None, None);
    }
    if index.province_bitmap_file.is_none() {
        out.map("MAP_PROVINCE_BITMAP_MISSING", Severity::Error, "The active provinces.bmp file is missing", None, None);
    }
    for (id, rows) in index.duplicate_ids.iter() {
        if rows.len() < 2 {
            continue;
        }
        let first = &index.definitions[rows[0]];
        let related: Vec<SourceLocation> = rows[1..].iter().take(DETAIL_SAMPLE_LIMIT).map(|&i| definition_location(index, &index.definitions[i])).collect();
        let mut d = Diagnostic::new("MAP_PROVINCE_ID_DUPLICATE", Severity::Error, Category::Map, format!("Province ID {id} is defined more than once"));
        d.location = Some(definition_location(index, first));
        d.related = Some(related);
        d.details = Some(details(json!({ "duplicateLocations": rows.len() - 1 })));
        out.add(d);
    }
    for (color, rows) in index.duplicate_colors.iter() {
        if rows.len() < 2 {
            continue;
        }
        let first = &index.definitions[rows[0]];
        out.map(
            "MAP_PROVINCE_COLOR_DUPLICATE",
            Severity::Error,
            format!("Province color {color} is assigned more than once"),
            Some(definition_location(index, first)),
            None,
        );
    }
    let ids: Vec<i64> = index.definitions.iter().map(|d| d.id).collect();
    let (sample, total) = contiguous_missing(&ids, 0);
    if total > 0 {
        out.map(
            "MAP_PROVINCE_ID_GAP",
            Severity::Error,
            "Province IDs must remain contiguous from zero",
            None,
            Some(json!({ "missing": sample, "total": total })),
        );
    }
    for definition in &index.definitions {
        // Province 0 is the reserved null row (0;0;0;0;land;false;unknown;0) the game expects.
        if definition.id == 0 && definition.terrain == "unknown" {
            continue;
        }
        let location = || Some(definition_location(index, definition));
        let terrain = index.terrain_categories.as_ref().and_then(|c| c.get(&definition.terrain));
        if index.terrain_categories.is_some() && terrain.is_none() {
            out.map(
                "MAP_TERRAIN_UNKNOWN",
                Severity::Error,
                format!("Province {} uses terrain {}, which no common/terrain category defines", definition.id, definition.terrain),
                location(),
                None,
            );
        }
        if definition.kind == "land"
            && let Some(continents) = &index.continents
            && definition.continent > continents.len() as i64
        {
            out.map(
                "MAP_CONTINENT_UNKNOWN",
                Severity::Error,
                format!("Land province {} uses continent {}, but continent.txt defines {}", definition.id, definition.continent, continents.len()),
                location(),
                None,
            );
        }
        if definition.kind == "land" && terrain.is_some_and(|t| t.water) {
            out.map(
                "MAP_LAND_TERRAIN_WATER",
                Severity::Error,
                format!("Land province {} uses water terrain {}", definition.id, definition.terrain),
                location(),
                None,
            );
        }
        if definition.kind == "land" && definition.continent == 0 {
            out.map("MAP_LAND_CONTINENT_MISSING", Severity::Error, format!("Land province {} has continent zero", definition.id), location(), None);
        }
        let water = |fallback: &str| if index.terrain_categories.is_none() { definition.terrain == fallback } else { terrain.is_none_or(|t| t.water) };
        let known = index.terrain_categories.is_some();
        if definition.kind == "sea" && !water("ocean") {
            let message = if known {
                format!("Sea province {} must use a water terrain (is_water = yes)", definition.id)
            } else {
                format!("Sea province {} must use ocean terrain", definition.id)
            };
            out.map("MAP_SEA_TERRAIN_INVALID", Severity::Error, message, location(), None);
        }
        if definition.kind == "lake" && !water("lakes") {
            let message = if known {
                format!("Lake province {} must use a water terrain (is_water = yes)", definition.id)
            } else {
                format!("Lake province {} must use lakes terrain", definition.id)
            };
            out.map("MAP_LAKE_TERRAIN_INVALID", Severity::Error, message, location(), None);
        }
    }
}

fn palette_keys(bitmap: &BmpImage) -> Vec<String> {
    bitmap.palette.iter().map(|c| c.key()).collect()
}

fn validate_geometry(index: &MapIndex, out: &mut Findings) {
    let (Some(bitmap), Some(raster)) = (&index.province_bitmap, &index.raster) else { return };
    let baseline_bitmap = out.options.baseline.as_ref().and_then(|b| b.province_bitmap.as_ref());
    if let Some(before) = baseline_bitmap {
        let orientation = |b: &BmpImage| if b.top_down { "top-down" } else { "bottom-up" };
        let changes: [(bool, &str, &str, Value, Value); 7] = [
            (
                before.width != bitmap.width || before.height != bitmap.height,
                "MAP_BMP_DIMENSIONS_CHANGED",
                "Province bitmap dimensions changed from the baseline",
                json!({ "width": before.width, "height": before.height }),
                json!({ "width": bitmap.width, "height": bitmap.height }),
            ),
            (
                before.dib_size != bitmap.dib_size,
                "MAP_BMP_DIB_CHANGED",
                "Province bitmap DIB header type changed from the baseline",
                json!(before.dib_size),
                json!(bitmap.dib_size),
            ),
            (
                before.top_down != bitmap.top_down,
                "MAP_BMP_ORIENTATION_CHANGED",
                "Province bitmap row orientation changed from the baseline",
                json!(orientation(before)),
                json!(orientation(bitmap)),
            ),
            (
                before.pixel_offset != bitmap.pixel_offset,
                "MAP_BMP_PIXEL_OFFSET_CHANGED",
                "Province bitmap pixel-array offset changed from the baseline",
                json!(before.pixel_offset),
                json!(bitmap.pixel_offset),
            ),
            (
                before.bits_per_pixel != bitmap.bits_per_pixel,
                "MAP_BMP_BIT_DEPTH_CHANGED",
                "Province bitmap bit depth changed from the baseline",
                json!(before.bits_per_pixel),
                json!(bitmap.bits_per_pixel),
            ),
            (
                palette_keys(before) != palette_keys(bitmap),
                "MAP_BMP_PALETTE_CHANGED",
                "Province bitmap palette changed from the baseline",
                json!(palette_keys(before)),
                json!(palette_keys(bitmap)),
            ),
            (
                before.bytes[..before.pixel_offset] != bitmap.bytes[..bitmap.pixel_offset],
                "MAP_BMP_HEADER_CHANGED",
                "Province bitmap file/DIB header bytes changed from the baseline",
                json!({ "bytes": before.pixel_offset }),
                json!({ "bytes": bitmap.pixel_offset }),
            ),
        ];
        for (changed, code, message, before, after) in changes {
            if changed {
                out.map(code, Severity::Blocker, message, None, Some(json!({ "before": before, "after": after })));
            }
        }
    }
    if bitmap.bits_per_pixel != 24 {
        out.map("MAP_PROVINCES_BPP_INVALID", Severity::Error, "provinces.bmp must be an uncompressed 24-bit RGB bitmap", None, None);
    }
    if bitmap.width % 256 != 0 || bitmap.height % 256 != 0 {
        out.map(
            "MAP_DIMENSIONS_NOT_MULTIPLE_256",
            Severity::Error,
            "Province bitmap width and height must be multiples of 256",
            None,
            Some(json!({ "width": bitmap.width, "height": bitmap.height })),
        );
    }
    let pixels = u64::from(bitmap.width) * u64::from(bitmap.height);
    if pixels > MAP_PROVINCE_ENGINE_MAX_PIXELS {
        out.map("MAP_AREA_ENGINE_LIMIT", Severity::Error, "Province bitmap exceeds the documented engine area limit", None, Some(json!({ "pixels": pixels })));
    }
    // `unknownColors` sorted by colour key (the TypeScript raster sorts them so).
    let mut unknown: Vec<_> = raster.inner.unknown_colors.iter().collect();
    let key = |rgb: u32| format!("{},{},{}", rgb >> 16, (rgb >> 8) & 0xFF, rgb & 0xFF);
    unknown.sort_by(|a, b| hoi4_core::canonical::compare_code_units(&key(a.rgb), &key(b.rgb)));
    for color in &unknown {
        let k = key(color.rgb);
        out.map(
            "MAP_BITMAP_COLOR_UNREGISTERED",
            Severity::Error,
            format!("Bitmap color {k} has no definition"),
            None,
            Some(json!({ "color": k, "count": color.count, "firstX": color.first_x, "firstY": color.first_y })),
        );
    }
    if raster.inner.unknown_color_count > unknown.len() as u64 {
        out.map(
            "MAP_BITMAP_COLOR_SAMPLE_LIMIT",
            Severity::Blocker,
            "Bitmap contains more undefined colors than can be reported individually",
            None,
            Some(json!({ "distinctColors": raster.inner.unknown_color_count, "retainedSamples": unknown.len() })),
        );
    }
    for definition in &index.definitions {
        if definition.id == 0 {
            continue;
        }
        let location = || Some(definition_location(index, definition));
        let Some(geometry) = raster.geometry(definition.id) else {
            out.map("MAP_DEFINITION_UNUSED", Severity::Error, format!("Province {} has no pixels in provinces.bmp", definition.id), location(), None);
            continue;
        };
        if geometry.count <= 8 {
            out.map("MAP_PROVINCE_TOO_SMALL", Severity::Warning, format!("Province {} has only {} pixels", definition.id, geometry.count), location(), None);
        }
        if f64::from(geometry.max_x - geometry.min_x + 1) > f64::from(bitmap.width) / 8.0
            || f64::from(geometry.max_y - geometry.min_y + 1) > f64::from(bitmap.height) / 8.0
        {
            out.map(
                "MAP_PROVINCE_LARGE_BOUNDS",
                Severity::Warning,
                format!("Province {} spans more than one eighth of a map dimension", definition.id),
                location(),
                None,
            );
        }
        let components = raster.components.get(&definition.id).copied().unwrap_or(0);
        if components > 1 {
            out.map(
                "MAP_PROVINCE_DISCONNECTED_REVIEW",
                Severity::Warning,
                format!("Province {} has multiple disconnected components; review islands intentionally", definition.id),
                location(),
                Some(json!({ "components": components })),
            );
        }
        let holes = raster.holes.get(&definition.id).copied().unwrap_or(0);
        if holes > 0 {
            out.map(
                "MAP_PROVINCE_HOLE_REVIEW",
                Severity::Warning,
                format!("Province {} encloses one or more holes; review enclaves and inland regions intentionally", definition.id),
                location(),
                Some(json!({ "holes": holes })),
            );
        }
        if raster.thin.contains(&definition.id) {
            out.map(
                "MAP_PROVINCE_THIN_CORRIDOR_REVIEW",
                Severity::Warning,
                format!("Province {} contains a one-pixel corridor", definition.id),
                location(),
                None,
            );
        }
        let derived = raster.coastal.contains(&definition.id);
        if (definition.kind == "land" || definition.kind == "sea") && definition.coastal != derived {
            out.map(
                "MAP_COASTAL_MISMATCH",
                Severity::Error,
                format!("Province {} coastal field disagrees with bitmap adjacency", definition.id),
                location(),
                Some(json!({ "declared": definition.coastal, "derived": derived })),
            );
        }
    }
    let (width, height) = (raster.width() as usize, raster.height() as usize);
    for y in 0..height.saturating_sub(1) {
        for x in 0..width {
            let right = if x == width - 1 { 0 } else { x + 1 };
            let mut ids =
                [raster.id_at(y * width + x), raster.id_at(y * width + right), raster.id_at((y + 1) * width + x), raster.id_at((y + 1) * width + right)];
            ids.sort_unstable();
            if ids[0] < 0 || ids.windows(2).any(|w| w[0] == w[1]) {
                continue;
            }
            out.map(
                "MAP_INVALID_X_CROSSING",
                Severity::Error,
                format!("Four provinces meet at one pixel corner near {x},{y}"),
                None,
                Some(json!({ "x": x, "y": y, "provinceIds": ids })),
            );
        }
    }
    if let (Some(before), Some(expected)) = (baseline_bitmap, out.options.expected_changed_bounds) {
        let bounds = if before.width == bitmap.width && before.height == bitmap.height { before.diff_bounds(bitmap).ok().flatten() } else { None };
        if let Some([min_x, min_y, max_x, max_y, count]) = bounds
            && (i64::from(min_x) < expected.min_x
                || i64::from(min_y) < expected.min_y
                || i64::from(max_x) > expected.max_x
                || i64::from(max_y) > expected.max_y)
        {
            out.map(
                "MAP_PIXELS_CHANGED_OUTSIDE_OPERATION",
                Severity::Blocker,
                "Province bitmap changed outside the operation bounds",
                None,
                Some(json!({ "actual": { "minX": min_x, "minY": min_y, "maxX": max_x, "maxY": max_y, "count": count }, "expected": expected })),
            );
        }
    }
}

/// `sameLandmass`: whether a path of bordering land provinces joins `from` and `to`.
fn same_landmass(from: i64, to: i64, index: &MapIndex) -> bool {
    let Some(raster) = &index.raster else { return false };
    let mut seen = HashSet::from([from]);
    let mut queue = vec![from];
    let mut head = 0;
    while head < queue.len() {
        let current = queue[head];
        head += 1;
        for &neighbour in raster.ordered_neighbours(current) {
            if neighbour == to {
                return true;
            }
            if seen.contains(&neighbour) || index.definition(neighbour).is_none_or(|d| d.kind != "land") {
                continue;
            }
            seen.insert(neighbour);
            queue.push(neighbour);
        }
    }
    false
}

/// Groups in first-seen order with more than one member (`duplicateValues`).
fn duplicates<T, K: std::hash::Hash + Eq + Clone>(values: &[T], key: impl Fn(&T) -> K) -> Vec<(K, Vec<usize>)> {
    let mut groups: OrderedMap<K, Vec<usize>> = OrderedMap::default();
    for (i, value) in values.iter().enumerate() {
        groups.entry(key(value), Vec::new).push(i);
    }
    groups.iter().filter(|(_, g)| g.len() > 1).map(|(k, g)| (k.clone(), g.clone())).collect()
}

fn validate_states_and_regions(index: &MapIndex, out: &mut Findings) {
    for (id, rows) in duplicates(&index.states, |s| s.id) {
        let mut d = Diagnostic::new("MAP_STATE_ID_DUPLICATE", Severity::Error, Category::Map, format!("State ID {id} is defined more than once"));
        d.location = Some(index.states[rows[0]].location.clone());
        d.related = Some(rows[1..].iter().take(DETAIL_SAMPLE_LIMIT).map(|&i| index.states[i].location.clone()).collect());
        d.details = Some(details(json!({ "duplicateLocations": rows.len() - 1 })));
        out.add(d);
    }
    let mut state_membership: HashMap<i64, Vec<usize>> = HashMap::new();
    for (si, state) in index.states.iter().enumerate() {
        let location = || Some(state.location.clone());
        if state.owner.is_none() {
            out.map("MAP_STATE_OWNER_MISSING", Severity::Warning, format!("State {} has no owner and is unsafe for many effects", state.id), location(), None);
        }
        if state.controller.is_some() && state.owner.is_none() {
            out.map(
                "MAP_STATE_CONTROLLER_WITHOUT_OWNER",
                Severity::Error,
                format!("State {} defines a controller without an owner", state.id),
                location(),
                None,
            );
        }
        if !index.localisation_keys.contains(&format!("l_english:{}", state.name)) {
            let proposed = out.options.baseline.as_ref().is_some_and(|b| !b.state_ids.contains(&state.id));
            out.map(
                if proposed { "MAP_NEW_STATE_LOCALISATION_MISSING" } else { "MAP_STATE_LOCALISATION_MISSING" },
                if proposed { Severity::Error } else { Severity::Warning },
                format!("{} state {} name key {} has no English localisation", if proposed { "Proposed" } else { "Existing" }, state.id, state.name),
                location(),
                None,
            );
        }
        if let Some(capital) = state.capital
            && !state.provinces.contains(&capital)
        {
            out.map(
                "MAP_STATE_CAPITAL_OUTSIDE_STATE",
                Severity::Error,
                format!("State {} capital {capital} is not a member province", state.id),
                location(),
                None,
            );
        }
        for &province in &state.provinces {
            state_membership.entry(province).or_default().push(si);
            if index.definition(province).is_none() {
                out.map("MAP_STATE_PROVINCE_INVALID", Severity::Error, format!("State {} refers to missing province {province}", state.id), location(), None);
            }
        }
        for point in &state.victory_points {
            if !state.provinces.contains(&point.province_id) {
                out.map(
                    "MAP_VICTORY_POINT_OUTSIDE_STATE",
                    Severity::Error,
                    format!("Victory point {} is not in state {}", point.province_id, state.id),
                    location(),
                    None,
                );
            }
        }
        for province in state.province_buildings.keys() {
            if !state.provinces.contains(province) {
                out.map(
                    "MAP_PROVINCE_BUILDING_OUTSIDE_STATE",
                    Severity::Error,
                    format!("Province building entry {province} is not in state {}", state.id),
                    location(),
                    None,
                );
            }
        }
    }
    for definition in &index.definitions {
        if definition.id == 0 {
            continue;
        }
        let memberships = state_membership.get(&definition.id).map_or(&[][..], Vec::as_slice);
        let location = || Some(definition_location(index, definition));
        if definition.kind == "land" && memberships.is_empty() {
            out.map("MAP_LAND_PROVINCE_STATE_MISSING", Severity::Error, format!("Land province {} is in no state", definition.id), location(), None);
        }
        if memberships.len() > 1 {
            let mut d = Diagnostic::new(
                "MAP_PROVINCE_STATE_DUPLICATE",
                Severity::Error,
                Category::Map,
                format!("Province {} is assigned to multiple states", definition.id),
            );
            d.location = location();
            d.related = Some(memberships.iter().take(DETAIL_SAMPLE_LIMIT).map(|&i| index.states[i].location.clone()).collect());
            d.details = Some(details(json!({ "memberships": memberships.len() })));
            out.add(d);
        }
        if (definition.kind == "sea" || definition.kind == "lake") && !memberships.is_empty() {
            let sea = definition.kind == "sea";
            out.map(
                if sea { "MAP_SEA_PROVINCE_IN_STATE" } else { "MAP_LAKE_PROVINCE_IN_STATE" },
                Severity::Error,
                format!("{} province {} must not be assigned to a state", if sea { "Sea" } else { "Lake" }, definition.id),
                location(),
                None,
            );
        }
    }
    if let Some(categories) = &index.terrain_categories {
        for region in &index.regions {
            let Some(naval) = &region.naval_terrain else { continue };
            let category = categories.get(naval);
            if category.is_some_and(|c| c.naval) {
                continue;
            }
            let message = match category {
                None => format!("Strategic region {} names naval terrain {naval}, which no common/terrain category defines", region.id),
                Some(_) => format!("Strategic region {} names {naval}, which is not a naval terrain (naval_terrain = yes)", region.id),
            };
            out.map("MAP_REGION_NAVAL_TERRAIN_INVALID", Severity::Error, message, Some(region.location.clone()), None);
        }
    }
    for (id, rows) in duplicates(&index.regions, |r| r.id) {
        let mut d =
            Diagnostic::new("MAP_STRATEGIC_REGION_ID_DUPLICATE", Severity::Error, Category::Map, format!("Strategic region ID {id} is defined more than once"));
        d.location = Some(index.regions[rows[0]].location.clone());
        d.related = Some(rows[1..].iter().take(DETAIL_SAMPLE_LIMIT).map(|&i| index.regions[i].location.clone()).collect());
        d.details = Some(details(json!({ "duplicateLocations": rows.len() - 1 })));
        out.add(d);
    }
    let mut region_membership: HashMap<i64, Vec<usize>> = HashMap::new();
    for (ri, region) in index.regions.iter().enumerate() {
        for &province in &region.provinces {
            region_membership.entry(province).or_default().push(ri);
            if index.definition(province).is_none() {
                out.map(
                    "MAP_REGION_PROVINCE_INVALID",
                    Severity::Error,
                    format!("Strategic region {} refers to missing province {province}", region.id),
                    Some(region.location.clone()),
                    None,
                );
            }
        }
    }
    for definition in &index.definitions {
        if definition.id == 0 {
            continue;
        }
        let memberships = region_membership.get(&definition.id).map_or(&[][..], Vec::as_slice);
        let location = Some(definition_location(index, definition));
        if memberships.is_empty() {
            out.map("MAP_PROVINCE_REGION_MISSING", Severity::Error, format!("Province {} is in no strategic region", definition.id), location, None);
        } else if memberships.len() > 1 {
            let mut d = Diagnostic::new(
                "MAP_PROVINCE_REGION_DUPLICATE",
                Severity::Error,
                Category::Map,
                format!("Province {} is in multiple strategic regions", definition.id),
            );
            d.location = location;
            d.related = Some(memberships.iter().take(DETAIL_SAMPLE_LIMIT).map(|&i| index.regions[i].location.clone()).collect());
            d.details = Some(details(json!({ "memberships": memberships.len() })));
            out.add(d);
        }
    }
    // A region of exactly two land provinces that do not border each other but lie on one landmass
    // crashed game 1.19.4 at load (issue 223); the exact cause is not known, so this is a warning.
    if let Some(raster) = &index.raster {
        for region in &index.regions {
            let mut provinces: Vec<i64> = Vec::new();
            for &p in &region.provinces {
                if !provinces.contains(&p) && index.definition(p).is_some() {
                    provinces.push(p);
                }
            }
            if provinces.len() != 2 || provinces.iter().any(|&p| index.definition(p).is_none_or(|d| d.kind != "land")) {
                continue;
            }
            let touching = provinces.iter().any(|&p| raster.ordered_neighbours(p).iter().any(|&n| n != p && provinces.contains(&n)));
            if touching || !same_landmass(provinces[0], provinces[1], index) {
                continue;
            }
            out.map(
                "MAP_STRATEGIC_REGION_PROVINCES_APART",
                Severity::Warning,
                format!(
                    "Strategic region {} has exactly two land provinces, {} and {}, on one landmass with other provinces between them. Game 1.19.4 crashed at load on regions of this shape; give the region a province that joins them, or move them into the regions around them.",
                    region.id, provinces[0], provinces[1]
                ),
                Some(region.location.clone()),
                Some(json!({ "provinceIds": provinces, "provinceCount": provinces.len() })),
            );
        }
    }
    for state in &index.states {
        let mut region_ids: Vec<i64> = Vec::new();
        for province in &state.provinces {
            for &ri in region_membership.get(province).map_or(&[][..], Vec::as_slice) {
                let id = index.regions[ri].id;
                if !region_ids.contains(&id) {
                    region_ids.push(id);
                }
            }
        }
        if region_ids.len() > 1 {
            region_ids.sort_unstable();
            out.map(
                "MAP_STATE_CROSSES_STRATEGIC_REGIONS",
                Severity::Error,
                format!("State {} spans multiple strategic regions", state.id),
                Some(state.location.clone()),
                Some(
                    json!({ "strategicRegionIds": region_ids.iter().take(DETAIL_SAMPLE_LIMIT).collect::<Vec<_>>(), "strategicRegionCount": region_ids.len() }),
                ),
            );
        }
    }
}

fn validate_networks(index: &MapIndex, out: &mut Findings) {
    let adjacent = |a: f64, b: f64| match (&index.raster, as_id(a), as_id(b)) {
        (Some(raster), Some(a), Some(b)) => raster.adjacent(a, b),
        _ => false,
    };
    let mut special_pairs: HashSet<(String, String)> = HashSet::new();
    for adjacency in index.adjacencies.iter().filter(|a| a.kind == "sea") {
        special_pairs.insert((n(adjacency.from), n(adjacency.to)));
        special_pairs.insert((n(adjacency.to), n(adjacency.from)));
    }
    for adjacency in &index.adjacencies {
        let location = index.documents[adjacency.document].one_based_location(adjacency.line);
        let from = index.definition_f(adjacency.from);
        let to = index.definition_f(adjacency.to);
        let (Some(from), Some(to)) = (from, to) else {
            out.map(
                "MAP_ADJACENCY_PROVINCE_INVALID",
                Severity::Error,
                format!("Adjacency {}-{} has invalid endpoints", n(adjacency.from), n(adjacency.to)),
                location,
                None,
            );
            continue;
        };
        if adjacency.from == adjacency.to {
            out.map(
                "MAP_ADJACENCY_PROVINCE_INVALID",
                Severity::Error,
                format!("Adjacency {}-{} has invalid endpoints", n(adjacency.from), n(adjacency.to)),
                location,
                None,
            );
            continue;
        }
        if adjacency.kind == "sea" {
            if from.kind != to.kind {
                out.map("MAP_SEA_ADJACENCY_TYPE_MISMATCH", Severity::Error, "Sea adjacency endpoints must have the same province type", location.clone(), None);
            }
            if !adjacent(adjacency.from, adjacency.to) && adjacency.through < 0.0 {
                out.map("MAP_ADJACENCY_THROUGH_MISSING", Severity::Error, "Non-border sea adjacency requires a through province", location.clone(), None);
            }
            if adjacency.through >= 0.0 && index.definition_f(adjacency.through).is_none() {
                out.map(
                    "MAP_ADJACENCY_THROUGH_INVALID",
                    Severity::Error,
                    format!("Adjacency through province {} does not exist", n(adjacency.through)),
                    location,
                    None,
                );
            }
        } else if adjacency.kind == "impassable" {
            if adjacency.through != -1.0
                || adjacency.start_x != -1.0
                || adjacency.start_y != -1.0
                || adjacency.stop_x != -1.0
                || adjacency.stop_y != -1.0
                || !adjacency.rule.is_empty()
            {
                out.map(
                    "MAP_IMPASSABLE_FIELDS_INVALID",
                    Severity::Error,
                    "Impassable adjacency must leave through, coordinates, and rule unset",
                    location,
                    None,
                );
            }
        } else {
            out.map("MAP_ADJACENCY_TYPE_UNKNOWN", Severity::Error, format!("Unknown adjacency type {}", adjacency.kind), location, None);
        }
    }
    for (province, rows) in duplicates(&index.supply_nodes, |s| s.province_id) {
        let first = &index.supply_nodes[rows[0]];
        out.map(
            "MAP_SUPPLY_NODE_DUPLICATE",
            Severity::Error,
            format!("Province {province} contains multiple starting supply nodes"),
            Some(index.documents[first.document].required_location(first.line)),
            None,
        );
    }
    for node in &index.supply_nodes {
        let land = index.definition(node.province_id).is_some_and(|d| d.kind == "land");
        if node.level != 1 || !land || index.states_of(node.province_id).len() != 1 {
            out.map(
                "MAP_SUPPLY_NODE_INVALID",
                Severity::Error,
                format!("Supply node {} must be level 1 in one stateful land province", node.province_id),
                Some(index.documents[node.document].required_location(node.line)),
                None,
            );
        }
    }
    for railway in &index.railways {
        let location = index.documents[railway.document].one_based_location(railway.line);
        if railway.level < 1 || railway.level > 5 || railway.declared_count != railway.provinces.len() as i64 || railway.provinces.len() < 2 {
            out.map("MAP_RAILWAY_HEADER_INVALID", Severity::Error, "Railway level, count, or length is invalid", location.clone(), None);
        }
        for &province in &railway.provinces {
            if index.definition(province).is_none_or(|d| d.kind != "land") || index.states_of(province).len() != 1 {
                out.map(
                    "MAP_RAILWAY_PROVINCE_INVALID",
                    Severity::Error,
                    format!("Railway uses missing or stateless non-land province {province}"),
                    location.clone(),
                    None,
                );
            }
        }
        for pair in railway.provinces.windows(2) {
            let (left, right) = (pair[0], pair[1]);
            let joined = index.raster.as_ref().is_some_and(|r| r.adjacent(left, right)) || special_pairs.contains(&(left.to_string(), right.to_string()));
            if !joined {
                out.map(
                    "MAP_RAILWAY_DISJOINT",
                    Severity::Error,
                    format!("Railway jumps between non-adjacent provinces {left} and {right}"),
                    location.clone(),
                    None,
                );
            }
        }
    }
}

fn validate_positions(index: &MapIndex, out: &mut Findings) {
    if index.active_file("map/buildings.txt").is_some() && index.building_positions.is_empty() {
        out.map("MAP_BUILDINGS_FILE_EMPTY", Severity::Error, "buildings.txt must not be entirely empty", None, None);
    }
    let mut naval_locators: HashSet<i64> = HashSet::new();
    for position in &index.building_positions {
        let location = index.documents[position.document].one_based_location(position.line);
        let state = index.state(position.state_id);
        let province = index.province_at(position.x, position.z);
        if position.building == "floating_harbor" {
            let sea = province.and_then(|p| index.definition(p));
            let land = index.definition_f(position.adjacent_sea_province);
            if sea.is_none_or(|d| d.kind != "sea") {
                out.map(
                    "MAP_FLOATING_HARBOR_POSITION_REVIEW",
                    Severity::Warning,
                    "Floating-harbor position resolves outside a sea province; review the installed-map precedent",
                    location.clone(),
                    Some(province.map_or_else(|| json!({}), |p| json!({ "resolvedProvince": p }))),
                );
            }
            let landing = crate::parse::text::json_number(position.adjacent_sea_province);
            if land.is_none_or(|d| d.kind != "land") {
                out.map(
                    "MAP_FLOATING_HARBOR_LAND_INVALID",
                    Severity::Error,
                    "Floating-harbor final field must name an existing land province",
                    location,
                    Some(json!({ "landingProvince": landing, "stateId": position.state_id })),
                );
            } else {
                let landing_id = as_id(position.adjacent_sea_province).unwrap_or(-1);
                if state.is_none_or(|s| !s.provinces.contains(&landing_id)) || !index.coastal(landing_id) {
                    out.map(
                        "MAP_FLOATING_HARBOR_ASSOCIATION_REVIEW",
                        Severity::Warning,
                        "Floating-harbor target differs from its state or computed coastal membership",
                        location,
                        Some(json!({ "landingProvince": landing, "stateId": position.state_id })),
                    );
                }
            }
            continue;
        }
        let inside = match (state, province) {
            (Some(state), Some(province)) => state.provinces.contains(&province),
            _ => false,
        };
        if !inside {
            out.map(
                "MAP_BUILDING_POSITION_INVALID",
                Severity::Error,
                format!("Building position does not resolve inside state {}", position.state_id),
                location.clone(),
                Some(province.map_or_else(|| json!({}), |p| json!({ "resolvedProvince": p }))),
            );
        }
        if position.building == "naval_base_spawn" {
            if let Some(province) = province {
                naval_locators.insert(province);
            }
            let adjacent = index.definition_f(position.adjacent_sea_province);
            if adjacent.is_none_or(|d| d.kind != "sea") {
                out.map(
                    "MAP_PORT_ADJACENT_SEA_INVALID",
                    Severity::Error,
                    format!("{} must identify an adjacent sea province", position.building),
                    location,
                    None,
                );
            } else if let Some(province) = province
                && !index.raster.as_ref().is_some_and(|r| as_id(position.adjacent_sea_province).is_some_and(|sea| r.adjacent(province, sea)))
            {
                out.map(
                    "MAP_PORT_SEA_NOT_ADJACENT",
                    Severity::Error,
                    format!("Port position sea {} does not border province {province}", n(position.adjacent_sea_province)),
                    location,
                    None,
                );
            }
        } else if position.adjacent_sea_province != 0.0 {
            out.map(
                "MAP_NON_PORT_ADJACENT_SEA_SET",
                Severity::Warning,
                format!("{} should leave adjacent sea province at zero", position.building),
                location,
                None,
            );
        }
    }
    for state in &index.states {
        for (province, buildings) in state.province_buildings.iter() {
            if buildings.get(&"naval_base".to_string()).copied().unwrap_or(0.0) > 0.0 {
                if !index.coastal(*province) {
                    out.map(
                        "MAP_PORT_NOT_COASTAL",
                        Severity::Error,
                        format!("Naval base province {province} is not coastal"),
                        Some(state.location.clone()),
                        None,
                    );
                }
                if !naval_locators.contains(province) {
                    out.map(
                        "MAP_PORT_LOCATOR_MISSING",
                        Severity::Error,
                        format!("Naval base province {province} has no naval_base_spawn entry"),
                        Some(state.location.clone()),
                        None,
                    );
                }
            }
        }
    }
    for position in &index.unit_positions {
        let location = index.documents[position.document].one_based_location(position.line);
        let resolved = index.province_at(position.x, position.z);
        if index.definition_f(position.province_id).is_none() || resolved.map(|r| r as f64) != Some(position.province_id) {
            out.map(
                "MAP_UNIT_POSITION_INVALID",
                Severity::Error,
                format!(
                    "Unit position for province {} resolves to {}",
                    n(position.province_id),
                    resolved.map_or_else(|| "no province".to_string(), |r| r.to_string())
                ),
                location.clone(),
                None,
            );
        }
        if position.kind < 0.0 || position.kind > 38.0 || position.kind.fract() != 0.0 {
            out.map("MAP_UNIT_POSITION_TYPE_INVALID", Severity::Error, format!("Unit position type {} is outside 0..38", n(position.kind)), location, None);
        }
    }
    let (mut small, mut big) = (false, false);
    for position in &index.weather_positions {
        let location = || Some(index.documents[position.document].required_location(position.line));
        if !index.has_region(position.strategic_region_id) {
            out.map(
                "MAP_WEATHER_REGION_INVALID",
                Severity::Error,
                format!("Weather position refers to missing region {}", position.strategic_region_id),
                location(),
                None,
            );
        }
        small |= position.size == "small";
        big |= position.size == "big";
        if position.size != "small" && position.size != "big" {
            out.map(
                "MAP_WEATHER_SIZE_INVALID",
                Severity::Error,
                format!("Weather position size must be small or big, not {}", position.size),
                location(),
                None,
            );
        }
    }
    if !index.weather_positions.is_empty() && (!small || !big) {
        out.map("MAP_WEATHER_SIZE_CLASS_MISSING", Severity::Error, "weatherpositions.txt must contain at least one small and one big object", None, None);
    }
    for (key, rows) in duplicates(&index.entity_locators, |l| format!("{}:{}", l.entity, l.name)) {
        let files: Vec<&str> = rows.iter().take(DETAIL_SAMPLE_LIMIT).map(|&i| index.entity_locators[i].path.as_str()).collect();
        out.map(
            "MAP_ENTITY_LOCATOR_DUPLICATE",
            Severity::Error,
            format!("Entity locator {key} is defined more than once in the same indexed set"),
            None,
            Some(json!({ "files": files, "fileCount": rows.len() })),
        );
    }
}

/// `validateMap`.
pub fn validate(index: &MapIndex, options: &Options) -> ValidationResult {
    let mut out = Findings { list: index.diagnostics.clone(), options, raw: false };
    validate_definitions(index, &mut out);
    validate_geometry(index, &mut out);
    validate_states_and_regions(index, &mut out);
    validate_networks(index, &mut out);
    crossing::validate_crossings(index, &mut out);
    validate_positions(index, &mut out);
    appearance::validate_appearance(index, &mut out, options.edge_mode);
    let mut diagnostics = out.list;
    sort_diagnostics(&mut diagnostics);
    let checks = map_validation_checks(&diagnostics);
    let passed = checks.iter().all(|c| c.passed) && !diagnostics.iter().any(|d| d.severity.blocks());
    ValidationResult { passed, diagnostics, checks }
}

/// The crossing, wall, railway and unit-position findings alone, as `validateCrossings` reports
/// them: every finding, unbounded and without an operation id.
pub fn crossing_findings(index: &MapIndex) -> Vec<Diagnostic> {
    let options = Options::default();
    let mut out = Findings { list: Vec::new(), options: &options, raw: true };
    crossing::validate_crossings(index, &mut out);
    out.list
}

fn starts(code: &str, prefixes: &[&str]) -> bool {
    prefixes.iter().any(|p| code.starts_with(p))
}

/// The family of an appearance code: `^MAP_(RIVER|TERRAIN_BITMAP|...)_`.
fn appearance_family(code: &str) -> bool {
    const FAMILIES: [&str; 12] = ["RIVER", "TERRAIN_BITMAP", "HEIGHT", "TREES", "COLORMAP", "WATER", "NORMAL", "CITIES", "LAKE", "EDGE", "SEAM", "POLAR"];
    code.strip_prefix("MAP_").is_some_and(|rest| FAMILIES.iter().any(|f| rest.strip_prefix(f).is_some_and(|tail| tail.starts_with('_'))))
}

/// `mapValidationChecks`: one check per finding family, failed by an error or blocker of it.
pub fn map_validation_checks(diagnostics: &[Diagnostic]) -> Vec<Check> {
    let failed = |family: &dyn Fn(&str) -> bool| diagnostics.iter().any(|d| d.severity.blocks() && family(&d.code));
    vec![
        Check {
            id: "map-files-and-definitions",
            passed: !failed(&|c| starts(c, &["MAP_DEFINITION", "MAP_PROVINCE_ID", "MAP_PROVINCE_COLOR"]) || c == "MAP_PROVINCE_BITMAP_MISSING"),
            message: "Province definitions, IDs, colors, and required files are valid",
        },
        Check {
            id: "map-bitmap-geometry",
            passed: !failed(&|c| starts(c, &["MAP_BMP", "MAP_BITMAP", "MAP_INVALID_X", "MAP_DIMENSIONS", "MAP_PIXELS"])),
            message: "Bitmap format and province geometry are valid",
        },
        Check {
            id: "map-state-region-membership",
            passed: !failed(&|c| starts(c, &["MAP_STATE", "MAP_LAND_PROVINCE_STATE", "MAP_PROVINCE_STATE", "MAP_PROVINCE_REGION", "MAP_STRATEGIC_REGION"])),
            message: "State and strategic-region memberships are valid",
        },
        Check {
            id: "map-networks-adjacencies",
            passed: !failed(&|c| starts(c, &["MAP_ADJACENCY", "MAP_IMPASSABLE", "MAP_STRAIT", "MAP_SEA_ADJACENCY", "MAP_SUPPLY", "MAP_RAILWAY"])),
            message: "Adjacencies, supply nodes, and railways are valid",
        },
        Check {
            id: "map-positions-locators",
            passed: !failed(&|c| starts(c, &["MAP_BUILDING", "MAP_PORT", "MAP_UNIT_POSITION", "MAP_WEATHER", "MAP_ENTITY_LOCATOR"])),
            message: "Map positions, ports, and entity locators are valid",
        },
        Check {
            id: "map-appearance-files",
            passed: !failed(&appearance_family),
            message: "Heightmap, terrain, river, tree, colour, normal and city bitmaps, lakes and the world edge are valid",
        },
    ]
}
