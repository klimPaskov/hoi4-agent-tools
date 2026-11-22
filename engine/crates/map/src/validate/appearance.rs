//! Checks of the files that decide how a map looks: the heightmap, terrain, river and tree
//! bitmaps, the colour maps, the normal map, the city map, lakes and the world edge.
//!
//! Ported from `src/hoi4_agent_tools/map/appearance-validation.ts` (`validateAppearance` and the
//! checks it runs) and `src/hoi4_agent_tools/map/water.ts` (`landDistanceField` and the lake
//! constants), commit `9b7dc80d`. Severities are calibrated against the installed base game,
//! which raises no error.
//!
//! DDS colour maps are decoded by `hoi4-texture`, which reads more formats than the TypeScript
//! GUI decoder did (BC4 to BC7 among them); a colour map the TypeScript reported as "a DDS
//! format this tool does not examine" is now examined.

use std::collections::{HashMap, HashSet};

use hoi4_core::diagnostics::{Severity, SourceLocation, SourcePosition};
use serde_json::{Value, json};

use super::{EdgeMode, Findings};
use crate::model::{MAP_PROVINCE_ENGINE_MAX_PIXELS, MapIndex, as_id, normalized_path};
use crate::parse::bmp::BmpImage;
use crate::parse::records::n;
use crate::parse::script::{assignments, with_script};
use crate::parse::text::is_js_space;
use crate::parse::text::json_number;
use hoi4_engine::symbol_index::reader::Value as Node;

const SEA: u8 = 0;
const LAND: u8 = 1;
const LAKE: u8 = 2;
const UNKNOWN: u8 = 3;
const SAMPLE_LIMIT: usize = 8;

pub const RIVER_PIXEL_LIMIT: u64 = 130_000;
pub const RIVER_LAND_SHARE_LIMIT: f64 = 0.025;
pub const COLORMAP_MEAN_VALUE_RANGE: [f64; 2] = [50.0, 100.0];
pub const COLORMAP_DISTINCT_MINIMUM: usize = 400;
pub const COLORMAP_DEVIATION_MINIMUM: f64 = 15.0;
pub const WATER_COLORMAP_DEVIATION_MINIMUM: f64 = 8.0;
/// Lake pixels at or below this height draw opaque (`water.ts`).
pub const WATER_OPAQUE_HEIGHT: u32 = 91;
/// A lake pixel within this distance of land may stand above `WATER_OPAQUE_HEIGHT`.
pub const LAKE_BANK_ALLOWANCE_PX: u8 = 3;
pub const LAKE_BANK_MAXIMUM_HEIGHT: u32 = 95;
pub const LAKE_MINIMUM_PIXELS: u64 = 60;
/// The DDS decode ceiling of the TypeScript render budget (`RENDER_MAX_DECODED_PIXELS`).
const DDS_MAX_PIXELS: u64 = 16_777_216;

/// `Number.prototype.toFixed`: halves of the exact value round away from zero.
pub fn js_to_fixed(value: f64, digits: usize) -> String {
    let exact = format!("{:.*}", digits + 40, value.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut kept: Vec<u8> = whole.bytes().chain(fraction.bytes().take(digits)).collect();
    let rest = &fraction[digits.min(fraction.len())..];
    if rest.as_bytes().first().is_some_and(|&d| d >= b'5') {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                break;
            }
            i -= 1;
            if kept[i] == b'9' {
                kept[i] = b'0';
            } else {
                kept[i] += 1;
                break;
            }
        }
    }
    let split = kept.len() - digits;
    let mut out = String::from_utf8(kept[..split].to_vec()).unwrap_or_default();
    if digits > 0 {
        out.push('.');
        out.push_str(std::str::from_utf8(&kept[split..]).unwrap_or_default());
    }
    if value < 0.0 {
        out.insert(0, '-');
    }
    out
}

/// `Math.round(value * 10) / 10` and the like.
fn round_to(value: f64, scale: f64) -> Value {
    json_number((value * scale + 0.5).floor() / scale)
}

fn locate(index: &MapIndex, file: usize) -> Option<SourceLocation> {
    let origin = SourcePosition { line: 1, column: 1, offset: 0 };
    Some(SourceLocation { path: index.file(file).display_path.clone(), start: origin, end: origin, symbol: None })
}

fn map_file(index: &MapIndex, name: &str) -> Option<usize> {
    index.roots.map.iter().find_map(|root| index.active_file(&normalized_path(&format!("{root}/{name}"))))
}

fn selected_file(index: &MapIndex, selector: &str, fallback: &str) -> Option<usize> {
    map_file(index, &index.selector(selector, fallback).ok()?)
}

fn relative(index: &MapIndex, file: usize) -> &str {
    &index.file(file).relative_path
}

fn decode_bitmap(index: &MapIndex, file: usize, out: &mut Findings, code: &str) -> Option<BmpImage> {
    match BmpImage::decode(&index.file(file).bytes) {
        Ok(image) => Some(image),
        Err(error) => {
            out.map(code, Severity::Error, format!("{} cannot be read: {}", relative(index, file), error.message), locate(index, file), None);
            None
        }
    }
}

/// A bitmap row in top-left order.
fn row_of(image: &BmpImage, y: u32) -> &[u8] {
    let row = if image.top_down { y } else { image.height - 1 - y } as usize;
    let start = image.pixel_offset + row * image.row_stride;
    let length = image.width as usize * if image.bits_per_pixel == 24 { 3 } else { 1 };
    &image.bytes[start..start + length]
}

/// The province type of every pixel (`buildRaster`).
struct Kinds {
    width: u32,
    height: u32,
    kind: Vec<u8>,
    land_pixels: u64,
    sea_pixels: u64,
}

fn build_kinds(index: &MapIndex) -> Option<Kinds> {
    let raster = index.raster.as_ref()?;
    let mut type_by_id: HashMap<i64, u8> = HashMap::new();
    for definition in &index.definitions {
        type_by_id.entry(definition.id).or_insert(match definition.kind.as_str() {
            "land" => LAND,
            "lake" => LAKE,
            _ => SEA,
        });
    }
    let (mut land_pixels, mut sea_pixels) = (0, 0);
    let kind: Vec<u8> = raster
        .inner
        .province_ids
        .iter()
        .map(|&id| {
            let kind = type_by_id.get(&i64::from(id)).copied().unwrap_or(UNKNOWN);
            if kind == LAND {
                land_pixels += 1;
            } else if kind == SEA {
                sea_pixels += 1;
            }
            kind
        })
        .collect();
    Some(Kinds { width: raster.width(), height: raster.height(), kind, land_pixels, sea_pixels })
}

/// `landDistanceField`: steps from the nearest land pixel through water, up to `limit`.
pub fn land_distance_field(kind: &[u8], width: usize, height: usize, limit: u8) -> Vec<u8> {
    let total = width * height;
    let mut distance = vec![limit; total];
    let mut queue = Vec::with_capacity(total);
    for (pixel, &k) in kind.iter().enumerate() {
        if k == LAND {
            distance[pixel] = 0;
            queue.push(pixel);
        }
    }
    let mut head = 0;
    while head < queue.len() {
        let pixel = queue[head];
        head += 1;
        let next = distance[pixel].saturating_add(1);
        if next >= limit {
            continue;
        }
        let x = pixel % width;
        let mut reach = |other: usize| {
            if distance[other] == limit && kind[other] != LAND {
                distance[other] = next;
                queue.push(other);
            }
        };
        if x > 0 {
            reach(pixel - 1);
        }
        if x < width - 1 {
            reach(pixel + 1);
        }
        if pixel >= width {
            reach(pixel - width);
        }
        if pixel < total - width {
            reach(pixel + width);
        }
    }
    distance
}

fn check_size(index: &MapIndex, file: usize, image: &BmpImage, kinds: &Kinds, out: &mut Findings, code: &str, expected_width: f64, expected_height: f64) {
    if f64::from(image.width) != expected_width || f64::from(image.height) != expected_height {
        out.map(
            code,
            Severity::Error,
            format!(
                "{} is {}x{}; the province map is {}x{}, so this file must be {}x{}",
                relative(index, file),
                image.width,
                image.height,
                kinds.width,
                kinds.height,
                n(expected_width),
                n(expected_height)
            ),
            locate(index, file),
            Some(json!({ "width": image.width, "height": image.height, "expectedWidth": json_number(expected_width), "expectedHeight": json_number(expected_height) })),
        );
    }
}

fn format_error(index: &MapIndex, file: usize, out: &mut Findings, code: &str, message: &str, bits: u8) {
    out.map(code, Severity::Error, format!("{} {message}", relative(index, file)), locate(index, file), Some(json!({ "bitsPerPixel": bits })));
}

fn height_value(image: &BmpImage, raw: u8) -> u32 {
    image.palette.get(raw as usize).map_or(u32::from(raw), |c| u32::from(c.r))
}

fn validate_heightmap(index: &MapIndex, kinds: &Kinds, out: &mut Findings) {
    let Some(file) = index.heightmap_file else { return };
    let Some(image) = decode_bitmap(index, file, out, "MAP_HEIGHT_UNREADABLE") else { return };
    if image.bits_per_pixel != 8 {
        return format_error(index, file, out, "MAP_HEIGHT_FORMAT", "must be an 8-bit greyscale bitmap", image.bits_per_pixel);
    }
    if image.width != kinds.width || image.height != kinds.height {
        return check_size(index, file, &image, kinds, out, "MAP_HEIGHT_SIZE", f64::from(kinds.width), f64::from(kinds.height));
    }
    let (width, height) = (kinds.width as usize, kinds.height as usize);
    let distance = kinds.kind.contains(&LAKE).then(|| land_distance_field(&kinds.kind, width, height, LAKE_BANK_ALLOWANCE_PX + 1));
    let (mut lake_pixels, mut land_below, mut sea_above, mut too_high, mut unrendered, mut seam_steps) = (0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
    let mut samples = Vec::new();
    for y in 0..height {
        let row = row_of(&image, y as u32);
        for x in 0..width {
            let h = height_value(&image, row[x]);
            match kinds.kind[y * width + x] {
                LAND if h < 94 => land_below += 1,
                SEA if h > 94 => sea_above += 1,
                LAKE => {
                    lake_pixels += 1;
                    if h > LAKE_BANK_MAXIMUM_HEIGHT {
                        unrendered += 1;
                    }
                    if h > WATER_OPAQUE_HEIGHT && distance.as_ref().map_or(0, |d| d[y * width + x]) > LAKE_BANK_ALLOWANCE_PX {
                        too_high += 1;
                        if samples.len() < SAMPLE_LIMIT {
                            samples.push(json!({ "x": x, "y": y, "height": h }));
                        }
                    }
                }
                _ => {}
            }
        }
        if height_value(&image, row[0]).abs_diff(height_value(&image, row[width - 1])) > 4 {
            seam_steps += 1;
        }
    }
    let location = || locate(index, file);
    if too_high > 0 {
        out.map(
            "MAP_LAKE_SURFACE_TOO_HIGH",
            if too_high as f64 / lake_pixels.max(1) as f64 > 0.05 { Severity::Error } else { Severity::Warning },
            format!("{too_high} lake pixels lie above height {WATER_OPAQUE_HEIGHT} away from the shore; the water layer draws them translucent, so the lake shows the ground through it. Write lake interiors at 89"),
            location(),
            Some(json!({ "pixels": too_high, "opaqueUpTo": WATER_OPAQUE_HEIGHT, "bankPx": LAKE_BANK_ALLOWANCE_PX, "samples": samples })),
        );
    }
    if unrendered > 0 && unrendered as f64 / lake_pixels.max(1) as f64 > 0.01 {
        out.map(
            "MAP_HEIGHT_LAKE_ABOVE_SURFACE",
            Severity::Warning,
            format!("{unrendered} lake pixels are at or above the water surface (height 95), so no water is drawn there"),
            location(),
            Some(json!({ "pixels": unrendered })),
        );
    }
    if land_below as f64 / kinds.land_pixels.max(1) as f64 > 0.005 {
        out.map(
            "MAP_HEIGHT_LAND_BELOW_COAST",
            Severity::Warning,
            format!("{land_below} land pixels lie below height 94, where the water layer covers them"),
            location(),
            Some(json!({ "pixels": land_below })),
        );
    }
    if sea_above as f64 / kinds.sea_pixels.max(1) as f64 > 0.005 {
        out.map(
            "MAP_HEIGHT_SEA_ABOVE_SURFACE",
            Severity::Warning,
            format!("{sea_above} sea pixels lie above height 94 and draw as shallow or dry ground"),
            location(),
            Some(json!({ "pixels": sea_above })),
        );
    }
    if seam_steps > 0 {
        out.map(
            "MAP_HEIGHT_SEAM_STEP",
            Severity::Warning,
            format!("{seam_steps} rows differ by more than 4 between the first and last column; the terrain steps where the world wraps"),
            location(),
            Some(json!({ "rows": seam_steps })),
        );
    }
}

struct TerrainEntry {
    name: String,
    index: u64,
    texture: Option<u64>,
}

fn digits(value: &str) -> Option<u64> {
    (!value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())).then(|| value.parse::<f64>().map_or(0, |v| v as u64))
}

/// `graphicalTerrain`: the graphical terrain entries of the active `common/terrain` files.
fn graphical_terrain(index: &MapIndex) -> Option<Vec<TerrainEntry>> {
    let files: Vec<usize> = index
        .active
        .iter()
        .copied()
        .filter(|&f| {
            normalized_path(&index.file(f).relative_path)
                .strip_prefix("common/terrain/")
                .is_some_and(|rest| !rest.contains('/') && rest.len() > 4 && rest.ends_with(".txt"))
        })
        .collect();
    if files.is_empty() {
        return None;
    }
    let mut entries = Vec::new();
    for file in files {
        with_script(&index.file(file).bytes, &index.file(file).display_path, |script| {
            for section in assignments(script.root(), "terrain") {
                let Node::Block(block) = &section.value else { continue };
                for entry in block.assignments() {
                    let Node::Block(inner) = &entry.value else { continue };
                    let kind = inner.first_scalar("type");
                    let texture = inner.first_scalar("texture").and_then(|s| digits(&s.value));
                    let colors = assignments(inner, "color").next().map(|a| &a.value);
                    let (Some(_), Some(Node::Block(colors))) = (kind, colors) else { continue };
                    for color in colors.scalars() {
                        if let Some(value) = digits(&color.value) {
                            entries.push(TerrainEntry { name: entry.key.value.to_string(), index: value, texture });
                        }
                    }
                }
            }
        });
    }
    (!entries.is_empty()).then_some(entries)
}

fn validate_terrain_bitmap(index: &MapIndex, kinds: &Kinds, out: &mut Findings) {
    let Some(file) = selected_file(index, "terrain", "terrain.bmp") else { return };
    let Some(image) = decode_bitmap(index, file, out, "MAP_TERRAIN_BITMAP_UNREADABLE") else { return };
    if image.bits_per_pixel != 8 {
        return format_error(index, file, out, "MAP_TERRAIN_BITMAP_FORMAT", "must be an 8-bit indexed bitmap", image.bits_per_pixel);
    }
    if image.width != kinds.width || image.height != kinds.height {
        return check_size(index, file, &image, kinds, out, "MAP_TERRAIN_BITMAP_SIZE", f64::from(kinds.width), f64::from(kinds.height));
    }
    let Some(entries) = graphical_terrain(index) else { return };
    let mut by_index: HashMap<u64, &TerrainEntry> = HashMap::new();
    for entry in &entries {
        by_index.entry(entry.index).or_insert(entry);
    }
    let (width, height) = (kinds.width as usize, kinds.height as usize);
    let mut counts = [0u64; 256];
    let mut lake_counts = [0u64; 256];
    for y in 0..height {
        let row = row_of(&image, y as u32);
        for x in 0..width {
            counts[row[x] as usize] += 1;
            if kinds.kind[y * width + x] == LAKE {
                lake_counts[row[x] as usize] += 1;
            }
        }
    }
    let (mut undefined, mut unrendered) = (Vec::new(), Vec::new());
    let mut undefined_pixels = 0;
    for value in 0..256usize {
        if counts[value] == 0 {
            continue;
        }
        match by_index.get(&(value as u64)) {
            None => {
                undefined_pixels += counts[value];
                undefined.push(json!({ "index": value, "pixels": counts[value] }));
            }
            Some(entry) if entry.texture == Some(255) => {
                unrendered.push((value, json!({ "index": value, "name": entry.name, "pixels": counts[value], "lakePixels": lake_counts[value] })));
            }
            Some(_) => {}
        }
    }
    let path = relative(index, file);
    if !undefined.is_empty() {
        out.map(
            "MAP_TERRAIN_BITMAP_INDEX_UNDEFINED",
            if undefined_pixels as f64 > (width * height) as f64 * 0.001 { Severity::Error } else { Severity::Warning },
            format!("{path} uses {} palette index(es) that no graphical terrain in common/terrain defines", undefined.len()),
            locate(index, file),
            Some(json!({ "indices": undefined.iter().take(32).collect::<Vec<_>>() })),
        );
    }
    if !unrendered.is_empty() {
        let list: Vec<String> = unrendered.iter().map(|(v, _)| v.to_string()).collect();
        out.map(
            "MAP_LAKE_TEXTURE_UNRENDERED",
            Severity::Error,
            format!(
                "{path} uses graphical terrain index {}, which selects no atlas tile (texture = 255); the engine draws nothing useful there. Use the ocean index for lakes",
                list.join(", ")
            ),
            locate(index, file),
            Some(json!({ "indices": unrendered.into_iter().map(|(_, v)| v).collect::<Vec<_>>() })),
        );
    }
}

fn validate_rivers(index: &MapIndex, kinds: &Kinds, out: &mut Findings) {
    let Some(file) = selected_file(index, "rivers", "rivers.bmp") else { return };
    let Some(image) = decode_bitmap(index, file, out, "MAP_RIVER_UNREADABLE") else { return };
    if image.bits_per_pixel != 8 {
        return format_error(index, file, out, "MAP_RIVER_FORMAT", "must be an 8-bit indexed bitmap (the engine refuses other depths)", image.bits_per_pixel);
    }
    let bytes = &index.file(file).bytes;
    let colors_used = u32::from_le_bytes([bytes[46], bytes[47], bytes[48], bytes[49]]);
    let path = relative(index, file).to_string();
    let location = || locate(index, file);
    if colors_used != 0 {
        out.map(
            "MAP_RIVER_PALETTE_COUNT",
            Severity::Warning,
            format!(
                "{path} declares {colors_used} palette colours; the engine logs \"Palette in rivers.bmp is probably not correct\" unless the header count is 0"
            ),
            location(),
            Some(json!({ "colorsUsed": colors_used })),
        );
    }
    if image.width != kinds.width || image.height != kinds.height {
        return check_size(index, file, &image, kinds, out, "MAP_RIVER_SIZE", f64::from(kinds.width), f64::from(kinds.height));
    }
    let (width, height) = (kinds.width as usize, kinds.height as usize);
    let river = |v: u8| v <= 11;
    let (mut river_pixels, mut bad_count, mut blocks, mut not_orthogonal, mut on_sea) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let (mut bad, mut block_samples, mut orthogonal_samples, mut sea_samples) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for y in 0..height {
        let current = row_of(&image, y as u32);
        let next = (y + 1 < height).then(|| row_of(&image, y as u32 + 1));
        let previous = (y > 0).then(|| row_of(&image, y as u32 - 1));
        for x in 0..width {
            let value = current[x];
            if !river(value) {
                if value < 254 {
                    bad_count += 1;
                    if bad.len() < SAMPLE_LIMIT {
                        bad.push(json!({ "x": x, "y": y, "value": value }));
                    }
                }
                continue;
            }
            river_pixels += 1;
            if kinds.kind[y * width + x] == SEA {
                on_sea += 1;
                if sea_samples.len() < SAMPLE_LIMIT {
                    sea_samples.push(json!({ "x": x, "y": y }));
                }
            }
            let east = x + 1 < width && river(current[x + 1]);
            let west = x > 0 && river(current[x - 1]);
            let south = next.is_some_and(|r| river(r[x]));
            let north = previous.is_some_and(|r| river(r[x]));
            let south_east = x + 1 < width && next.is_some_and(|r| river(r[x + 1]));
            if east && south && south_east {
                blocks += 1;
                if block_samples.len() < SAMPLE_LIMIT {
                    block_samples.push(json!({ "x": x, "y": y }));
                }
            }
            if !east && !west && !south && !north {
                not_orthogonal += 1;
                if orthogonal_samples.len() < SAMPLE_LIMIT {
                    orthogonal_samples.push(json!({ "x": x, "y": y }));
                }
            }
        }
    }
    if bad_count > 0 {
        out.map(
            "MAP_RIVER_INDEX_INVALID",
            Severity::Error,
            format!("{bad_count} river pixels use an index other than 0 to 11, 254 or 255"),
            location(),
            Some(json!({ "pixels": bad_count, "samples": bad })),
        );
    }
    if blocks > 0 {
        out.map(
            "MAP_RIVER_BLOCK",
            if blocks as f64 > river_pixels as f64 * 0.005 { Severity::Error } else { Severity::Warning },
            format!("{blocks} places hold a 2 x 2 block of river pixels; rivers are one pixel thick"),
            location(),
            Some(json!({ "blocks": blocks, "samples": block_samples })),
        );
    }
    if not_orthogonal > 0 {
        out.map(
            "MAP_RIVER_NOT_ORTHOGONAL",
            Severity::Warning,
            format!("{not_orthogonal} river pixels touch no other river pixel orthogonally (isolated or diagonal-only), which breaks the river path"),
            location(),
            Some(json!({ "pixels": not_orthogonal, "samples": orthogonal_samples })),
        );
    }
    if on_sea > 0 {
        out.map(
            "MAP_RIVER_ON_WATER",
            Severity::Warning,
            format!("{on_sea} river pixels lie on sea provinces"),
            location(),
            Some(json!({ "pixels": on_sea, "samples": sea_samples })),
        );
    }
    if river_pixels > RIVER_PIXEL_LIMIT || (kinds.land_pixels > 0 && river_pixels as f64 / kinds.land_pixels as f64 > RIVER_LAND_SHARE_LIMIT) {
        out.map(
            "MAP_RIVER_DENSITY",
            Severity::Warning,
            format!(
                "{river_pixels} river pixels ({}% of land) exceed the guard of {RIVER_PIXEL_LIMIT} pixels or 2.5% of land; long river networks slow the game",
                js_to_fixed(100.0 * river_pixels as f64 / kinds.land_pixels.max(1) as f64, 2)
            ),
            location(),
            Some(json!({ "pixels": river_pixels, "landPixels": kinds.land_pixels })),
        );
    }
    validate_river_sources(index, file, &image, out);
}

/// Every connected river should have exactly one green source (index 0).
fn validate_river_sources(index: &MapIndex, file: usize, image: &BmpImage, out: &mut Findings) {
    let width = image.width as usize;
    let mut offsets = Vec::new();
    for y in 0..image.height {
        let row = row_of(image, y);
        for (x, &v) in row.iter().enumerate() {
            if v <= 11 {
                offsets.push(y as usize * width + x);
            }
        }
    }
    if offsets.is_empty() {
        return;
    }
    let count = offsets.len();
    let mut parent: Vec<usize> = (0..count).collect();
    fn find(parent: &mut [usize], mut value: usize) -> usize {
        let mut root = value;
        while parent[root] != root {
            root = parent[root];
        }
        while parent[value] != root {
            let next = parent[value];
            parent[value] = root;
            value = next;
        }
        root
    }
    for i in 0..count {
        let offset = offsets[i];
        if offset % width + 1 < width
            && let Ok(east) = offsets.binary_search(&(offset + 1))
        {
            let (a, b) = (find(&mut parent, i), find(&mut parent, east));
            parent[a] = b;
        }
        if let Ok(south) = offsets.binary_search(&(offset + width)) {
            let (a, b) = (find(&mut parent, i), find(&mut parent, south));
            parent[a] = b;
        }
    }
    let mut order: Vec<usize> = Vec::new();
    let mut sources: HashMap<usize, u64> = HashMap::new();
    let mut first_of: HashMap<usize, usize> = HashMap::new();
    for i in 0..count {
        let root = find(&mut parent, i);
        first_of.entry(root).or_insert(offsets[i]);
        let (x, y) = (offsets[i] % width, offsets[i] / width);
        let source = row_of(image, y as u32)[x] == 0;
        if !sources.contains_key(&root) {
            order.push(root);
            sources.insert(root, 0);
        }
        if source {
            *sources.get_mut(&root).unwrap_or(&mut 0) += 1;
        }
    }
    let (mut none, mut several) = (0, 0);
    let mut samples = Vec::new();
    for root in order {
        let total = sources[&root];
        if total == 1 {
            continue;
        }
        if total == 0 {
            none += 1;
        } else {
            several += 1;
        }
        if samples.len() < SAMPLE_LIMIT {
            let offset = first_of[&root];
            samples.push(json!({ "x": offset % width, "y": offset / width, "sources": total }));
        }
    }
    if none + several > 0 {
        out.map(
            "MAP_RIVER_SOURCE_COUNT",
            Severity::Warning,
            format!(
                "{none} connected river(s) have no green source (index 0) and {several} have several; each river wants exactly one source on its main branch"
            ),
            locate(index, file),
            Some(json!({ "withoutSource": none, "withSeveralSources": several, "samples": samples })),
        );
    }
}

fn validate_trees(index: &MapIndex, kinds: &Kinds, out: &mut Findings) {
    let Some(file) = selected_file(index, "tree_definition", "trees.bmp") else { return };
    let Some(image) = decode_bitmap(index, file, out, "MAP_TREES_UNREADABLE") else { return };
    if image.bits_per_pixel != 8 {
        return format_error(index, file, out, "MAP_TREES_FORMAT", "must be an 8-bit indexed bitmap", image.bits_per_pixel);
    }
    let expected_width = (f64::from(kinds.width) * 75.0 / 256.0 + 0.5).floor();
    let expected_height = (f64::from(kinds.height) * 75.0 / 256.0 + 0.5).floor();
    if f64::from(image.width) != expected_width || f64::from(image.height) != expected_height {
        return check_size(index, file, &image, kinds, out, "MAP_TREES_SIZE", expected_width, expected_height);
    }
    let (rw, rh) = (f64::from(kinds.width), f64::from(kinds.height));
    let (iw, ih) = (f64::from(image.width), f64::from(image.height));
    let (mut invalid, mut on_water, mut non_zero) = (0u64, 0u64, 0u64);
    let mut samples = Vec::new();
    for y in 0..image.height {
        let row = row_of(&image, y);
        for x in 0..image.width {
            let value = row[x as usize];
            if value == 0 {
                continue;
            }
            non_zero += 1;
            if value as usize >= image.palette.len() {
                invalid += 1;
            }
            let all_water = [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0), (0.5, 0.5)].iter().all(|&(fx, fy)| {
                let sx = (((f64::from(x) + fx * 0.999) * rw) / iw).floor().min(rw - 1.0) as usize;
                let sy = (((f64::from(y) + fy * 0.999) * rh) / ih).floor().min(rh - 1.0) as usize;
                let kind = kinds.kind[sy * kinds.width as usize + sx];
                kind == SEA || kind == LAKE
            });
            if all_water {
                on_water += 1;
                if samples.len() < SAMPLE_LIMIT {
                    samples.push(json!({ "x": x, "y": y }));
                }
            }
        }
    }
    let path = relative(index, file);
    if invalid > 0 {
        out.map(
            "MAP_TREES_INDEX_INVALID",
            Severity::Error,
            format!("{invalid} tree cells use a palette index beyond the {} entries of {path}", image.palette.len()),
            locate(index, file),
            Some(json!({ "cells": invalid })),
        );
    }
    if non_zero > 0 && on_water as f64 / non_zero as f64 > 0.02 {
        out.map(
            "MAP_TREES_ON_WATER",
            Severity::Warning,
            format!("{on_water} tree cells ({}%) stand over sea or lake provinces", js_to_fixed(100.0 * on_water as f64 / non_zero as f64, 1)),
            locate(index, file),
            Some(json!({ "cells": on_water, "samples": samples })),
        );
    }
}

/// Decoded RGBA, top row first.
struct Pixels {
    width: usize,
    height: usize,
    data: Vec<u8>,
}

fn read_dds(index: &MapIndex, file: usize, out: &mut Findings) -> Option<Pixels> {
    let bytes = &index.file(file).bytes;
    let path = relative(index, file);
    if bytes.len() < 128 || u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) != 0x2053_4444 {
        out.map("MAP_COLORMAP_UNREADABLE", Severity::Error, format!("{path} is not a DDS texture"), locate(index, file), None);
        return None;
    }
    match hoi4_texture::decode(bytes, "dds", DDS_MAX_PIXELS) {
        Ok(decoded) => Some(Pixels { width: decoded.image.width as usize, height: decoded.image.height as usize, data: decoded.image.rgba }),
        Err(error) if error.kind == hoi4_texture::ErrorKind::TooLarge => {
            out.map(
                "MAP_COLORMAP_UNREADABLE",
                Severity::Info,
                format!("{path} could not be decoded within the raster limits and was not examined"),
                locate(index, file),
                None,
            );
            None
        }
        Err(error) => {
            out.map(
                "MAP_COLORMAP_UNREADABLE",
                Severity::Info,
                format!("{path} is in a DDS format this tool does not examine ({})", error.format),
                locate(index, file),
                Some(json!({ "format": error.format, "reason": error.message })),
            );
            None
        }
    }
}

fn header_size(bytes: &[u8]) -> (u32, u32) {
    let at = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    (at(16), at(12))
}

fn validate_colour_maps(index: &MapIndex, kinds: &Kinds, out: &mut Findings) {
    let (rw, rh) = (f64::from(kinds.width), f64::from(kinds.height));
    if let Some(land) = map_file(index, "terrain/colormap_rgb_cityemissivemask_a.dds")
        && index.file(land).bytes.len() >= 128
    {
        let (width, height) = header_size(&index.file(land).bytes);
        let (ew, eh) = (rw / 2.0, rh / 2.0);
        if f64::from(width) != ew || f64::from(height) != eh {
            out.map(
                "MAP_COLORMAP_SIZE",
                Severity::Error,
                format!("{} is {width}x{height}; the colour map must be half the province map, {}x{}", relative(index, land), n(ew), n(eh)),
                locate(index, land),
                Some(json!({ "width": width, "height": height, "expectedWidth": json_number(ew), "expectedHeight": json_number(eh) })),
            );
        } else if let Some(pixels) = read_dds(index, land, out) {
            land_colour_statistics(index, land, &pixels, kinds, out);
        }
    }
    for level in 0..3u32 {
        let Some(water) = map_file(index, &format!("terrain/colormap_water_{level}.dds")) else { continue };
        if index.file(water).bytes.len() < 128 {
            continue;
        }
        let factor = 2usize.pow(level + 1);
        let (width, height) = header_size(&index.file(water).bytes);
        let (ew, eh) = (rw / factor as f64, rh / factor as f64);
        if f64::from(width) != ew || f64::from(height) != eh {
            out.map(
                "MAP_COLORMAP_SIZE",
                Severity::Error,
                format!("{} is {width}x{height}; level {level} must be 1/{factor} of the province map, {}x{}", relative(index, water), n(ew), n(eh)),
                locate(index, water),
                Some(json!({ "width": width, "height": height, "expectedWidth": json_number(ew), "expectedHeight": json_number(eh) })),
            );
            continue;
        }
        if level != 0 {
            continue;
        }
        let Some(pixels) = read_dds(index, water, out) else { continue };
        let mut count = 0u64;
        let mut sums = [0f64; 3];
        let mut squares = [0f64; 3];
        for y in 0..pixels.height {
            for x in 0..pixels.width {
                if kinds.kind.get(y * factor * kinds.width as usize + x * factor) != Some(&SEA) {
                    continue;
                }
                let offset = (y * pixels.width + x) * 4;
                count += 1;
                for channel in 0..3 {
                    let value = f64::from(pixels.data[offset + channel]);
                    sums[channel] += value;
                    squares[channel] += value * value;
                }
            }
        }
        if count > 1000 {
            let c = count as f64;
            let deviation: Vec<f64> = (0..3).map(|ch| (squares[ch] / c - (sums[ch] / c).powi(2)).max(0.0).sqrt()).collect();
            let mean = (deviation[0] + deviation[1] + deviation[2]) / 3.0;
            if mean < WATER_COLORMAP_DEVIATION_MINIMUM {
                out.map(
                    "MAP_WATER_COLORMAP_FLAT",
                    Severity::Warning,
                    format!(
                        "{} is almost one colour over the sea (deviation {}); the base game's varies by about 40 and shows the shelf as a lighter band",
                        relative(index, water),
                        js_to_fixed(mean, 1)
                    ),
                    locate(index, water),
                    Some(json!({ "deviation": deviation.iter().map(|&d| round_to(d, 10.0)).collect::<Vec<_>>() })),
                );
            }
        }
    }
}

fn land_colour_statistics(index: &MapIndex, file: usize, pixels: &Pixels, kinds: &Kinds, out: &mut Findings) {
    let (mut land_count, mut value_sum, mut value_squares, mut lights_on_water) = (0u64, 0f64, 0f64, 0u64);
    let mut distinct = HashSet::new();
    for y in 0..pixels.height {
        for x in 0..pixels.width {
            let kind = kinds.kind.get(y * 2 * kinds.width as usize + x * 2).copied().unwrap_or(UNKNOWN);
            let offset = (y * pixels.width + x) * 4;
            if kind == LAND {
                let (r, g, b) = (pixels.data[offset], pixels.data[offset + 1], pixels.data[offset + 2]);
                let value = f64::from(r.max(g).max(b));
                land_count += 1;
                value_sum += value;
                value_squares += value * value;
                distinct.insert((u32::from(r >> 3) << 10) | (u32::from(g >> 3) << 5) | u32::from(b >> 3));
            } else if (kind == SEA || kind == LAKE) && pixels.data[offset + 3] > 0 {
                lights_on_water += 1;
            }
        }
    }
    if lights_on_water > 0 {
        out.map(
            "MAP_COLORMAP_ALPHA_CITY",
            Severity::Info,
            format!("{lights_on_water} colour map pixels over water carry city-light alpha"),
            locate(index, file),
            Some(json!({ "pixels": lights_on_water })),
        );
    }
    if land_count < 100 {
        return;
    }
    let c = land_count as f64;
    let mean = value_sum / c;
    let deviation = (value_squares / c - mean * mean).max(0.0).sqrt();
    let distinct_minimum = COLORMAP_DISTINCT_MINIMUM.min((land_count / 100) as usize);
    let mut problems = Vec::new();
    if mean < COLORMAP_MEAN_VALUE_RANGE[0] || mean > COLORMAP_MEAN_VALUE_RANGE[1] {
        problems.push(format!("mean value {} is outside 50 to 100 (the base game's is 74; a brighter colour map leaves the atlas pale)", js_to_fixed(mean, 0)));
    }
    if distinct.len() < distinct_minimum {
        problems.push(format!("{} distinct 5-bit colours is below {distinct_minimum}", distinct.len()));
    }
    if deviation < COLORMAP_DEVIATION_MINIMUM {
        problems.push(format!("value deviation {} is below 15", js_to_fixed(deviation, 0)));
    }
    if !problems.is_empty() {
        out.map(
            "MAP_COLORMAP_RANGE",
            Severity::Warning,
            format!("The land colour map looks flat or washed out: {}", problems.join("; ")),
            locate(index, file),
            Some(json!({ "meanValue": round_to(mean, 10.0), "valueDeviation": round_to(deviation, 10.0), "distinct5BitColours": distinct.len(), "landPixels": land_count })),
        );
    }
}

fn validate_normals(index: &MapIndex, kinds: &Kinds, out: &mut Findings) {
    let Some(file) = map_file(index, "world_normal.bmp") else { return };
    let Some(image) = decode_bitmap(index, file, out, "MAP_NORMAL_UNREADABLE") else { return };
    if image.bits_per_pixel != 24 {
        return format_error(index, file, out, "MAP_NORMAL_FORMAT", "must be a 24-bit bitmap", image.bits_per_pixel);
    }
    let (ew, eh) = (f64::from(kinds.width) / 2.0, f64::from(kinds.height) / 2.0);
    if f64::from(image.width) != ew || f64::from(image.height) != eh {
        return check_size(index, file, &image, kinds, out, "MAP_NORMAL_SIZE", ew, eh);
    }
    let (mut sampled, mut not_unit) = (0u64, 0u64);
    for y in (0..image.height).step_by(4) {
        let row = row_of(&image, y);
        for x in (0..image.width as usize).step_by(4) {
            let channel = |i: usize| (f64::from(row[x * 3 + i]) - 127.5) / 127.5;
            let (nx, ny, nz) = (channel(2), channel(1), channel(0));
            sampled += 1;
            if ((nx * nx + ny * ny + nz * nz).sqrt() - 1.0).abs() > 0.02 {
                not_unit += 1;
            }
        }
    }
    if sampled > 0 && not_unit as f64 / sampled as f64 > 0.25 {
        out.map(
            "MAP_NORMAL_NOT_UNIT",
            Severity::Warning,
            format!("{}% of sampled normals are not unit length within 2%", js_to_fixed(100.0 * not_unit as f64 / sampled as f64, 1)),
            locate(index, file),
            Some(json!({ "sampled": sampled, "notUnit": not_unit })),
        );
    }
    let Some(height_file) = index.heightmap_file else { return };
    let Ok(heights) = BmpImage::decode(&index.file(height_file).bytes) else { return };
    if heights.bits_per_pixel != 8 || heights.width != kinds.width || heights.height != kinds.height {
        return;
    }
    let (mut covariance, mut variance) = (0f64, 0f64);
    for y in (0..image.height).step_by(2) {
        let row = row_of(&image, y);
        let height_row = row_of(&heights, y * 2);
        let mut x = 1usize;
        while x + 1 < image.width as usize {
            let step = f64::from(height_value(&heights, height_row[x * 2 + 2])) - f64::from(height_value(&heights, height_row[x * 2 - 2]));
            covariance += (f64::from(row[x * 3 + 2]) - 128.0) * step;
            variance += step * step;
            x += 2;
        }
    }
    if variance < 2_000.0 {
        return;
    }
    let response = -covariance / variance;
    if !(0.5..=6.0).contains(&response) {
        out.map(
            "MAP_NORMAL_RESPONSE",
            Severity::Warning,
            format!(
                "The normal map responds {} per height step; the base game's is about 2.6, so shading will look {}",
                js_to_fixed(response, 2),
                if response < 0.5 { "flat" } else { "harsh" }
            ),
            locate(index, file),
            Some(json!({ "response": round_to(response, 100.0), "expected": [0.5, 6] })),
        );
    }
}

/// The values of `color_index = N` in `cities.txt` (`/color_index\s*=\s*(\d+)/gu`).
fn city_color_indices(text: &str) -> HashSet<u64> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let needle: Vec<u16> = "color_index".encode_utf16().collect();
    let mut found = HashSet::new();
    let mut i = 0;
    while i + needle.len() <= units.len() {
        if units[i..i + needle.len()] != needle[..] {
            i += 1;
            continue;
        }
        let mut j = i + needle.len();
        while j < units.len() && is_js_space(units[j]) {
            j += 1;
        }
        if units.get(j) == Some(&u16::from(b'=')) {
            j += 1;
            while j < units.len() && is_js_space(units[j]) {
                j += 1;
            }
            let start = j;
            while j < units.len() && (u16::from(b'0')..=u16::from(b'9')).contains(&units[j]) {
                j += 1;
            }
            if j > start {
                found.insert(String::from_utf16_lossy(&units[start..j]).parse::<f64>().map_or(u64::MAX, |v| v as u64));
                i = j;
                continue;
            }
        }
        i += 1;
    }
    found
}

fn validate_cities(index: &MapIndex, kinds: &Kinds, out: &mut Findings) {
    let Some(file) = map_file(index, "cities.bmp") else { return };
    let Some(image) = decode_bitmap(index, file, out, "MAP_CITIES_UNREADABLE") else { return };
    if image.bits_per_pixel != 8 {
        return format_error(index, file, out, "MAP_CITIES_FORMAT", "must be an 8-bit indexed bitmap", image.bits_per_pixel);
    }
    if image.width != kinds.width || image.height != kinds.height {
        return check_size(index, file, &image, kinds, out, "MAP_CITIES_SIZE", f64::from(kinds.width), f64::from(kinds.height));
    }
    let mut counts = [0u64; 256];
    for y in 0..image.height {
        for &v in row_of(&image, y) {
            counts[v as usize] += 1;
        }
    }
    let Some(definitions) = map_file(index, "cities.txt") else { return };
    let defined = city_color_indices(&String::from_utf8_lossy(&index.file(definitions).bytes));
    if defined.is_empty() {
        return;
    }
    let undefined: Vec<u64> = (0..256u64).filter(|&v| counts[v as usize] > 0 && !defined.contains(&v)).collect();
    if !undefined.is_empty() {
        let list: Vec<String> = undefined.iter().take(10).map(u64::to_string).collect();
        out.map(
            "MAP_CITIES_INDEX_UNDEFINED",
            Severity::Warning,
            format!("{} uses palette index(es) {} that no city_group in cities.txt defines", relative(index, file), list.join(", ")),
            locate(index, file),
            Some(json!({ "indices": undefined.iter().take(32).collect::<Vec<_>>() })),
        );
    }
}

fn validate_lakes_and_edge(index: &MapIndex, kinds: &Kinds, out: &mut Findings, edge: Option<EdgeMode>) {
    let (Some(provinces_file), Some(raster)) = (index.province_bitmap_file, &index.raster) else { return };
    let location = || locate(index, provinces_file);
    // The last definition of an id wins here (`new Map(definitions.map(...))`).
    let type_by_id: HashMap<i64, &str> = index.definitions.iter().map(|d| (d.id, d.kind.as_str())).collect();
    let is = |id: i64, kind: &str| type_by_id.get(&id).is_some_and(|k| *k == kind);
    let mut lakes: Vec<i64> = raster.inner.geometry.iter().map(|g| g.id).filter(|&id| is(id, "lake")).collect();
    lakes.sort_unstable();
    let mut body_of: HashMap<i64, i64> = HashMap::new();
    for &start in &lakes {
        if body_of.contains_key(&start) {
            continue;
        }
        body_of.insert(start, start);
        let mut stack = vec![start];
        while let Some(current) = stack.pop() {
            for &other in raster.ordered_neighbours(current) {
                if is(other, "lake") && !body_of.contains_key(&other) {
                    body_of.insert(other, start);
                    stack.push(other);
                }
            }
        }
    }
    let mut bodies: Vec<(i64, u64)> = Vec::new();
    for &id in &lakes {
        let body = body_of[&id];
        let pixels = raster.geometry(id).map_or(0, |g| g.count);
        match bodies.iter_mut().find(|(b, _)| *b == body) {
            Some(entry) => entry.1 += pixels,
            None => bodies.push((body, pixels)),
        }
    }
    for (body, pixels) in bodies {
        if pixels < LAKE_MINIMUM_PIXELS {
            out.map(
                "MAP_LAKE_TOO_SMALL",
                Severity::Warning,
                format!("Lake province {body} holds a lake of only {pixels} pixels; water below {LAKE_MINIMUM_PIXELS} pixels is too small to read as a lake"),
                location(),
                Some(json!({ "provinceId": body, "pixels": pixels })),
            );
        }
    }
    for &id in &lakes {
        for &other in raster.ordered_neighbours(id) {
            if is(other, "sea") {
                out.map(
                    "MAP_LAKE_CONNECTED_TO_SEA",
                    Severity::Warning,
                    format!("Lake province {id} borders sea province {other}; water that joins the sea is sea, not a lake"),
                    location(),
                    Some(json!({ "lakeProvinceId": id, "seaProvinceId": other })),
                );
            }
        }
    }
    let (width, height) = (kinds.width as usize, kinds.height as usize);
    let (mut left, mut right, mut rows) = (0usize, 0usize, 0usize);
    let mut row_samples = Vec::new();
    let mut pairs: Vec<(i64, i64)> = Vec::new();
    for y in 0..height {
        let start = kinds.kind[y * width] == LAND;
        let end = kinds.kind[y * width + width - 1] == LAND;
        left += usize::from(start);
        right += usize::from(end);
        if start || end {
            rows += 1;
            if row_samples.len() < SAMPLE_LIMIT {
                row_samples.push(y);
            }
        }
        if start && end {
            let (a, b) = (i64::from(raster.id_at(y * width)), i64::from(raster.id_at(y * width + width - 1)));
            if a != b && !pairs.contains(&(a.min(b), a.max(b))) {
                pairs.push((a.min(b), a.max(b)));
            }
        }
    }
    if edge == Some(EdgeMode::Wall) {
        let open = height * 2 - left - right;
        if open > 0 {
            out.map(
                "MAP_EDGE_WALL_OPEN",
                Severity::Error,
                format!(
                    "Water reaches the first or last column at {open} pixels ({} on the west edge, {} on the east); ships can cross the seam there",
                    height - left,
                    height - right
                ),
                location(),
                Some(json!({ "west": height - left, "east": height - right })),
            );
        }
    } else if rows > 0 {
        out.map(
            "MAP_EDGE_LAND_CUT",
            if edge == Some(EdgeMode::SeaBand) { Severity::Error } else { Severity::Warning },
            format!(
                "Land touches the first or last column on {rows} rows ({left} on the west edge, {right} on the east); where the world wraps, the coast is cut by a straight vertical line. Use edge.mode \"sea-band\", \"rim\" or \"wall\""
            ),
            location(),
            Some(json!({ "rows": rows, "west": left, "east": right, "firstRows": row_samples })),
        );
    }
    if !pairs.is_empty() {
        let covered: HashSet<(i64, i64)> =
            index.adjacencies.iter().filter(|a| a.kind == "impassable").filter_map(|a| Some((as_id(a.from.min(a.to))?, as_id(a.from.max(a.to))?))).collect();
        let open = pairs.iter().filter(|p| !covered.contains(p)).count();
        out.map(
            "MAP_SEAM_LAND_ADJACENCY",
            Severity::Info,
            format!("{} pairs of land provinces meet across the wrapping seam; {} are blocked by an impassable adjacency", pairs.len(), pairs.len() - open),
            location(),
            Some(json!({ "pairs": pairs.len(), "impassable": pairs.len() - open })),
        );
    }
    let top = (0..width).filter(|&x| kinds.kind[x] == LAND).count();
    let bottom = (0..width).filter(|&x| kinds.kind[(height - 1) * width + x] == LAND).count();
    if top + bottom > 0 {
        out.map(
            "MAP_POLAR_LAND",
            Severity::Info,
            format!("Land touches the top row on {top} columns and the bottom row on {bottom}; the north and south frame borders cover the map edge there"),
            location(),
            Some(json!({ "top": top, "bottom": bottom })),
        );
    }
}

/// `validateAppearance`: every appearance check for the files in the scanned set.
pub fn validate_appearance(index: &MapIndex, out: &mut Findings, edge: Option<EdgeMode>) {
    let Some(raster) = &index.raster else { return };
    if u64::from(raster.width()) * u64::from(raster.height()) > MAP_PROVINCE_ENGINE_MAX_PIXELS {
        return;
    }
    let Some(kinds) = build_kinds(index) else { return };
    validate_lakes_and_edge(index, &kinds, out, edge);
    validate_heightmap(index, &kinds, out);
    validate_terrain_bitmap(index, &kinds, out);
    validate_rivers(index, &kinds, out);
    validate_trees(index, &kinds, out);
    validate_colour_maps(index, &kinds, out);
    validate_normals(index, &kinds, out);
    validate_cities(index, &kinds, out);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_like_to_fixed() {
        assert_eq!(js_to_fixed(1.005, 2), "1.00");
        assert_eq!(js_to_fixed(0.125, 2), "0.13");
        assert_eq!(js_to_fixed(2.5, 0), "3");
        assert_eq!(js_to_fixed(-0.04, 1), "-0.0");
        assert_eq!(js_to_fixed(99.96, 1), "100.0");
        assert_eq!(js_to_fixed(12.0, 2), "12.00");
    }

    #[test]
    fn measures_the_distance_from_land() {
        let kind = [LAND, SEA, SEA, SEA, SEA];
        assert_eq!(land_distance_field(&kind, 5, 1, 4), [0, 1, 2, 3, 4]);
    }

    #[test]
    fn reads_city_colour_indices() {
        assert_eq!(city_color_indices("city_group = { color_index = 3 }\ncolor_index=12 color_index = x"), HashSet::from([3, 12]));
    }
}
