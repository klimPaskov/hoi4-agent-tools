//! The province raster of `hoi4.map_inspect` and the other map tools (ADR 0084): every pixel's
//! province, each province's extent, the neighbour graph, the pairs that touch only across the
//! wrapping seam, colours without a definition, coastal provinces, and the geometry checks
//! (4-connected parts, enclosed holes and one-pixel-thin runs).
//!
//! Port of `buildProvinceRaster` in `src/hoi4_agent_tools/map/model.ts` and of
//! `provinceComponents`, `provinceHoleCounts` and `provinceThinPixels` in
//! `src/hoi4_agent_tools/map/validation.ts` (hoi4-agent-tools 4.16.0). Every list keeps the
//! iteration order of the TypeScript `Map` or `Set` it replaces, because the server builds those
//! from these lists and later steps iterate them.
//!
//! The server has already decoded and checked the bitmap's headers; this module reads pixels
//! through the offsets it was given.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::{Value, json};

pub const REQUEST_SCHEMA: &str = "hoi4-map-provinces-request/1";
pub const RESPONSE_SCHEMA: &str = "hoi4-map-provinces/1";

/// Where the pixels of a decoded BMP are, as `BmpImage` describes them.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub schema: String,
    pub width: u32,
    pub height: u32,
    pub top_down: bool,
    pub bits_per_pixel: u8,
    pub pixel_offset: usize,
    pub row_stride: usize,
    /// Palette of an 8-bit bitmap as `[r, g, b]`.
    #[serde(default)]
    pub palette: Vec<[u8; 3]>,
    /// `[0xRRGGBB, province id]` for each defined colour (`definitionsByColor`).
    pub colors: Vec<(u32, i64)>,
    /// `[province id, type]` for each definition (`definitionsById`).
    pub types: Vec<(i64, String)>,
}

/// One province's pixel count, bounding box and coordinate sums (the centre is sum / count).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Geometry {
    pub id: i64,
    pub count: u64,
    pub min_x: u32,
    pub min_y: u32,
    pub max_x: u32,
    pub max_y: u32,
    pub sum_x: u64,
    pub sum_y: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownColor {
    pub rgb: u32,
    pub count: u64,
    pub first_x: u32,
    pub first_y: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Raster {
    pub width: u32,
    pub height: u32,
    /// Province id per pixel, row by row from the top; -1 where the colour has no definition.
    pub province_ids: Vec<i32>,
    pub geometry: Vec<Geometry>,
    /// Each province's neighbours, provinces and neighbours both in first-touch order.
    pub adjacency: Vec<(i64, Vec<i64>)>,
    pub seam_only_pairs: Vec<(i64, i64)>,
    /// The first 256 undefined colours, in first-seen order.
    pub unknown_colors: Vec<UnknownColor>,
    pub unknown_color_count: u64,
    pub coastal: Vec<i64>,
    pub components: Vec<(i64, u64)>,
    pub holes: Vec<(i64, i64)>,
    pub thin: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PixelError {
    pub code: &'static str,
    pub message: String,
    pub x: u32,
    pub y: u32,
    pub index: u8,
}

const UNKNOWN_SAMPLE_LIMIT: usize = 256;

/// Neighbour sets in insertion order, as a TypeScript `Map<number, Set<number>>` keeps them.
#[derive(Default)]
struct Adjacency {
    slots: HashMap<i64, usize>,
    entries: Vec<(i64, Vec<i64>)>,
}

impl Adjacency {
    fn slot(&mut self, id: i64) -> usize {
        if let Some(&slot) = self.slots.get(&id) {
            return slot;
        }
        self.entries.push((id, Vec::new()));
        self.slots.insert(id, self.entries.len() - 1);
        self.entries.len() - 1
    }

    /// `addNeighbor`: both directions, ignoring unknown pixels and a province's own pixels.
    fn add(&mut self, left: i64, right: i64) {
        if left < 0 || right < 0 || left == right {
            return;
        }
        let left_slot = self.slot(left);
        let right_slot = self.slot(right);
        if !self.entries[left_slot].1.contains(&right) {
            self.entries[left_slot].1.push(right);
        }
        if !self.entries[right_slot].1.contains(&left) {
            self.entries[right_slot].1.push(left);
        }
    }
}

fn pair(a: i64, b: i64) -> (i64, i64) {
    (a.min(b), a.max(b))
}

/// Build the raster and run the geometry checks. Colours and pixels are read in the order the
/// TypeScript reads them, so the first bad palette index reported is the same pixel.
pub fn build(request: &Request, bytes: &[u8]) -> Result<Raster, PixelError> {
    let width = request.width as usize;
    let height = request.height as usize;
    let colors: HashMap<u32, i64> = request.colors.iter().copied().collect();
    let total = width * height;
    let mut province_ids = vec![-1i32; total];
    let mut geometry: Vec<Geometry> = Vec::new();
    let mut geometry_slot: HashMap<i64, usize> = HashMap::new();
    let mut unknown: Vec<UnknownColor> = Vec::new();
    let mut unknown_slot: HashMap<u32, usize> = HashMap::new();
    let mut unknown_seen: HashSet<u32> = HashSet::new();
    let bytes_per_pixel = usize::from(request.bits_per_pixel / 8);
    // Runs of one colour are the rule in a province map; remember the last lookup.
    let mut last: Option<(u32, Option<i64>, usize)> = None;
    for y in 0..height {
        let stored_row = if request.top_down { y } else { height - 1 - y };
        let row_start = request.pixel_offset + stored_row * request.row_stride;
        for x in 0..width {
            let offset = row_start + x * bytes_per_pixel;
            let rgb = if request.bits_per_pixel == 24 {
                (u32::from(bytes[offset + 2]) << 16) | (u32::from(bytes[offset + 1]) << 8) | u32::from(bytes[offset])
            } else {
                let index = bytes[offset];
                let Some(color) = request.palette.get(usize::from(index)) else {
                    return Err(PixelError {
                        code: "MAP_BMP_PALETTE_INDEX_INVALID",
                        message: "Pixel refers outside the BMP palette".into(),
                        x: x as u32,
                        y: y as u32,
                        index,
                    });
                };
                (u32::from(color[0]) << 16) | (u32::from(color[1]) << 8) | u32::from(color[2])
            };
            let (id, slot) = match last {
                Some((cached, id, slot)) if cached == rgb => (id, slot),
                _ => {
                    let id = colors.get(&rgb).copied();
                    let slot = match id {
                        Some(id) => *geometry_slot.entry(id).or_insert_with(|| {
                            geometry.push(Geometry { id, count: 0, min_x: x as u32, min_y: y as u32, max_x: x as u32, max_y: y as u32, sum_x: 0, sum_y: 0 });
                            geometry.len() - 1
                        }),
                        None => usize::MAX,
                    };
                    last = Some((rgb, id, slot));
                    (id, slot)
                }
            };
            match id {
                None => {
                    unknown_seen.insert(rgb);
                    if let Some(&slot) = unknown_slot.get(&rgb) {
                        unknown[slot].count += 1;
                    } else if unknown.len() < UNKNOWN_SAMPLE_LIMIT {
                        unknown.push(UnknownColor { rgb, count: 1, first_x: x as u32, first_y: y as u32 });
                        unknown_slot.insert(rgb, unknown.len() - 1);
                    }
                }
                Some(id) => {
                    province_ids[y * width + x] = id as i32;
                    let g = &mut geometry[slot];
                    g.count += 1;
                    g.min_x = g.min_x.min(x as u32);
                    g.min_y = g.min_y.min(y as u32);
                    g.max_x = g.max_x.max(x as u32);
                    g.max_y = g.max_y.max(y as u32);
                    g.sum_x += x as u64;
                    g.sum_y += y as u64;
                }
            }
        }
    }

    let id_at = |offset: usize| i64::from(province_ids[offset]);
    let mut adjacency = Adjacency::default();
    let mut seam_pairs: Vec<(i64, i64)> = Vec::new();
    let mut seam_seen: HashSet<(i64, i64)> = HashSet::new();
    for y in 0..height {
        for x in 0..width {
            let current = id_at(y * width + x);
            let right_x = if x == width - 1 { 0 } else { x + 1 };
            let right = id_at(y * width + right_x);
            if right_x == 0 && current >= 0 && right >= 0 && current != right && seam_seen.insert(pair(current, right)) {
                seam_pairs.push(pair(current, right));
            }
            adjacency.add(current, right);
            if y + 1 < height {
                adjacency.add(current, id_at((y + 1) * width + x));
            }
        }
    }
    let mut seam_only_pairs = Vec::new();
    if !seam_pairs.is_empty() {
        let mut inside: HashSet<(i64, i64)> = HashSet::new();
        for y in 0..height {
            for x in 0..width {
                let current = id_at(y * width + x);
                if current < 0 {
                    continue;
                }
                let neighbours = [if x + 1 < width { id_at(y * width + x + 1) } else { -1 }, if y + 1 < height { id_at((y + 1) * width + x) } else { -1 }];
                for other in neighbours {
                    if other < 0 || other == current {
                        continue;
                    }
                    let key = pair(current, other);
                    if seam_seen.contains(&key) {
                        inside.insert(key);
                    }
                }
            }
        }
        seam_only_pairs = seam_pairs.into_iter().filter(|key| !inside.contains(key)).collect();
    }

    let types: HashMap<i64, &str> = request.types.iter().map(|(id, kind)| (*id, kind.as_str())).collect();
    let coastal = adjacency
        .entries
        .iter()
        .filter(|(id, neighbours)| {
            let Some(kind) = types.get(id) else { return false };
            neighbours.iter().any(|neighbour| {
                let other = types.get(neighbour).copied();
                (*kind == "land" && other == Some("sea")) || (*kind == "sea" && other == Some("land"))
            })
        })
        .map(|(id, _)| *id)
        .collect();

    let mut raster = Raster {
        width: request.width,
        height: request.height,
        province_ids,
        geometry,
        adjacency: adjacency.entries,
        seam_only_pairs,
        unknown_colors: unknown,
        unknown_color_count: unknown_seen.len() as u64,
        coastal,
        ..Raster::default()
    };
    raster.components = components(&raster);
    raster.holes = holes(&raster);
    raster.thin = thin(&raster);
    Ok(raster)
}

/// `provinceComponents`: 4-connected parts per province, wrapping across the left and right
/// edges and not across the top and bottom.
fn components(raster: &Raster) -> Vec<(i64, u64)> {
    let width = raster.width as usize;
    let height = raster.height as usize;
    let ids = &raster.province_ids;
    let mut visited = vec![false; ids.len()];
    let mut counts: Vec<(i64, u64)> = Vec::new();
    let mut slot: HashMap<i64, usize> = HashMap::new();
    let mut queue: Vec<usize> = Vec::new();
    for start in 0..ids.len() {
        let id = ids[start];
        if id < 0 || visited[start] {
            continue;
        }
        let index = *slot.entry(i64::from(id)).or_insert_with(|| {
            counts.push((i64::from(id), 0));
            counts.len() - 1
        });
        counts[index].1 += 1;
        queue.clear();
        queue.push(start);
        visited[start] = true;
        let mut head = 0;
        while head < queue.len() {
            let offset = queue[head];
            head += 1;
            let x = offset % width;
            let y = offset / width;
            let row = y * width;
            let neighbours = [
                Some(row + if x == 0 { width - 1 } else { x - 1 }),
                Some(row + if x == width - 1 { 0 } else { x + 1 }),
                if y == 0 { None } else { Some(offset - width) },
                if y == height - 1 { None } else { Some(offset + width) },
            ];
            for neighbour in neighbours.into_iter().flatten() {
                if visited[neighbour] || ids[neighbour] != id {
                    continue;
                }
                visited[neighbour] = true;
                queue.push(neighbour);
            }
        }
    }
    counts
}

#[derive(Default, Clone, Copy)]
struct EulerSamples {
    one: i64,
    three: i64,
    diagonal: i64,
}

/// `provinceHoleCounts`: enclosed holes from the 4-connected digital Euler characteristic of one
/// padded 2x2 pass. Provinces on the first or last column are left out (the map wraps there).
fn holes(raster: &Raster) -> Vec<(i64, i64)> {
    let width = raster.width as i64;
    let height = raster.height as i64;
    let at =
        |x: i64, y: i64| -> i64 { if x < 0 || x >= width || y < 0 || y >= height { -1 } else { i64::from(raster.province_ids[(y * width + x) as usize]) } };
    let mut samples: Vec<(i64, EulerSamples)> = Vec::new();
    let mut slot: HashMap<i64, usize> = HashMap::new();
    let mut add = |id: i64, tl: i64, tr: i64, bl: i64, br: i64| {
        if id <= 0 {
            return;
        }
        let matches = i64::from(tl == id) + i64::from(tr == id) + i64::from(bl == id) + i64::from(br == id);
        if !(1..=3).contains(&matches) {
            return;
        }
        let index = *slot.entry(id).or_insert_with(|| {
            samples.push((id, EulerSamples::default()));
            samples.len() - 1
        });
        let current = &mut samples[index].1;
        if matches == 1 {
            current.one += 1;
        } else if matches == 3 {
            current.three += 1;
        } else if (tl == id && br == id && tr != id && bl != id) || (tr == id && bl == id && tl != id && br != id) {
            current.diagonal += 1;
        }
    };
    for y in -1..height {
        for x in -1..width {
            let tl = at(x, y);
            let tr = at(x + 1, y);
            let bl = at(x, y + 1);
            let br = at(x + 1, y + 1);
            add(tl, tl, tr, bl, br);
            if tr != tl {
                add(tr, tl, tr, bl, br);
            }
            if bl != tl && bl != tr {
                add(bl, tl, tr, bl, br);
            }
            if br != tl && br != tr && br != bl {
                add(br, tl, tr, bl, br);
            }
        }
    }
    let geometry: HashMap<i64, &Geometry> = raster.geometry.iter().map(|g| (g.id, g)).collect();
    let components: HashMap<i64, u64> = raster.components.iter().copied().collect();
    let mut result = Vec::new();
    for (id, sample) in samples {
        let Some(g) = geometry.get(&id) else { continue };
        if g.min_x == 0 || g.max_x == raster.width - 1 {
            continue;
        }
        // JavaScript's Math.round: halves round up.
        let euler = (((sample.one - sample.three - 2 * sample.diagonal) as f64) / 4.0 + 0.5).floor() as i64;
        let count = components.get(&id).copied().unwrap_or(0) as i64 - euler;
        if count > 0 {
            result.push((id, count));
        }
    }
    result
}

/// `provinceThinPixels`: provinces with a pixel whose own province continues only left and
/// right or only up and down, from the second row to the second-to-last, wrapping sideways.
fn thin(raster: &Raster) -> Vec<i64> {
    let width = raster.width as usize;
    let height = raster.height as usize;
    let ids = &raster.province_ids;
    let mut seen: HashSet<i32> = HashSet::new();
    let mut result = Vec::new();
    if height < 3 {
        return result;
    }
    for y in 1..height - 1 {
        let row = y * width;
        for x in 0..width {
            let offset = row + x;
            let id = ids[offset];
            if id < 0 {
                continue;
            }
            let left = ids[row + if x == 0 { width - 1 } else { x - 1 }] == id;
            let right = ids[row + if x == width - 1 { 0 } else { x + 1 }] == id;
            let up = ids[offset - width] == id;
            let down = ids[offset + width] == id;
            if ((left && right && !up && !down) || (!left && !right && up && down)) && seen.insert(id) {
                result.push(i64::from(id));
            }
        }
    }
    result
}

fn check_request(request: &Request, bytes: &[u8]) -> Result<(), String> {
    if request.schema != REQUEST_SCHEMA {
        return Err(format!("schema must be {REQUEST_SCHEMA}"));
    }
    if request.width == 0 || request.height == 0 {
        return Err("width and height must be positive".into());
    }
    if request.bits_per_pixel != 8 && request.bits_per_pixel != 24 {
        return Err("bitsPerPixel must be 8 or 24".into());
    }
    let row_bytes = request.width as usize * usize::from(request.bits_per_pixel / 8);
    if request.row_stride < row_bytes {
        return Err("rowStride is shorter than a row".into());
    }
    let end = request
        .row_stride
        .checked_mul(request.height as usize - 1)
        .and_then(|rows| rows.checked_add(request.pixel_offset))
        .and_then(|start| start.checked_add(row_bytes));
    if end.is_none_or(|end| end > bytes.len()) {
        return Err("the pixel rows reach past the end of the bitmap".into());
    }
    Ok(())
}

/// Answer one framed request: the JSON result and the province ids as little-endian `i32`.
pub fn respond(request: &Value, bytes: &[u8]) -> Result<(Value, Vec<u8>), Value> {
    // The frame's own fields are not part of the request.
    let mut request = request.clone();
    if let Some(fields) = request.as_object_mut() {
        for framing in ["id", "op", "payload"] {
            fields.remove(framing);
        }
    }
    let request: Request =
        serde_json::from_value(request).map_err(|e| json!({ "code": "invalid_request", "message": format!("invalid map-provinces request: {e}") }))?;
    check_request(&request, bytes).map_err(|message| json!({ "code": "invalid_request", "message": message }))?;
    let raster = build(&request, bytes).map_err(|e| json!({ "code": e.code, "message": e.message, "x": e.x, "y": e.y, "index": e.index }))?;
    let mut payload = Vec::with_capacity(raster.province_ids.len() * 4);
    for id in &raster.province_ids {
        payload.extend_from_slice(&id.to_le_bytes());
    }
    let result = json!({
        "schema": RESPONSE_SCHEMA,
        "width": raster.width,
        "height": raster.height,
        "geometry": raster.geometry.iter().map(|g| json!([g.id, g.count, g.min_x, g.min_y, g.max_x, g.max_y, g.sum_x, g.sum_y])).collect::<Vec<_>>(),
        "adjacency": raster.adjacency.iter().map(|(id, neighbours)| json!([id, neighbours])).collect::<Vec<_>>(),
        "seamOnlyPairs": raster.seam_only_pairs.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>(),
        "unknownColors": raster.unknown_colors.iter().map(|u| json!([u.rgb, u.count, u.first_x, u.first_y])).collect::<Vec<_>>(),
        "unknownColorCount": raster.unknown_color_count,
        "coastal": raster.coastal,
        "components": raster.components.iter().map(|(id, n)| json!([id, n])).collect::<Vec<_>>(),
        "holes": raster.holes.iter().map(|(id, n)| json!([id, n])).collect::<Vec<_>>(),
        "thin": raster.thin,
    });
    Ok((result, payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(width: u32, height: u32, colors: Vec<(u32, i64)>, types: Vec<(i64, &str)>) -> Request {
        Request {
            schema: REQUEST_SCHEMA.into(),
            width,
            height,
            top_down: true,
            bits_per_pixel: 24,
            pixel_offset: 0,
            row_stride: width as usize * 3,
            palette: Vec::new(),
            colors,
            types: types.into_iter().map(|(id, kind)| (id, kind.to_string())).collect(),
        }
    }

    /// Rows of colour codes, top first, as packed BGR.
    fn pixels(rows: &[&[u32]]) -> Vec<u8> {
        rows.iter().flat_map(|row| row.iter().flat_map(|rgb| [(*rgb & 0xff) as u8, ((rgb >> 8) & 0xff) as u8, (rgb >> 16) as u8])).collect()
    }

    #[test]
    fn neighbours_seam_coast_and_unknown_colours_keep_first_seen_order() {
        let (land, sea, other, stray) = (0x0000ff, 0xff0000, 0x00ff00, 0x123456);
        let bytes = pixels(&[&[land, land, sea, other], &[land, stray, sea, other], &[other, other, other, land]]);
        let req = request(4, 3, vec![(land, 1), (sea, 2), (other, 3)], vec![(1, "land"), (2, "sea"), (3, "land")]);
        let raster = build(&req, &bytes).unwrap();
        assert_eq!(raster.province_ids, vec![1, 1, 2, 3, 1, -1, 2, 3, 3, 3, 3, 1]);
        assert_eq!(raster.geometry.iter().map(|g| g.id).collect::<Vec<_>>(), vec![1, 2, 3]);
        let one = &raster.geometry[0];
        assert_eq!((one.count, one.min_x, one.max_x, one.min_y, one.max_y, one.sum_x, one.sum_y), (4, 0, 3, 0, 2, 4, 3));
        assert_eq!(raster.adjacency, vec![(1, vec![2, 3]), (2, vec![1, 3]), (3, vec![2, 1])]);
        // 3 and 1 touch inside the map as well as across the seam; 1 only meets 3 at the seam
        // in row one, but row three makes them ordinary neighbours.
        assert_eq!(raster.seam_only_pairs, Vec::<(i64, i64)>::new());
        assert_eq!(raster.unknown_colors, vec![UnknownColor { rgb: stray, count: 1, first_x: 1, first_y: 1 }]);
        assert_eq!(raster.unknown_color_count, 1);
        assert_eq!(raster.coastal, vec![1, 2, 3]);
        // The pixel of 1 at (3, 2) is cut off from the others, and 3's two pieces meet only 1.
        assert_eq!(raster.components, vec![(1, 2), (2, 1), (3, 2)]);
    }

    #[test]
    fn a_ring_has_one_hole_and_a_line_is_thin() {
        let (ring, inner, line, bg) = (0x010101, 0x020202, 0x030303, 0x040404);
        let bytes = pixels(&[
            &[bg, bg, bg, bg, bg, bg],
            &[bg, ring, ring, ring, bg, bg],
            &[bg, ring, inner, ring, line, bg],
            &[bg, ring, ring, ring, line, bg],
            &[bg, bg, bg, bg, line, bg],
            &[bg, bg, bg, bg, bg, bg],
        ]);
        let req = request(6, 6, vec![(ring, 1), (inner, 2), (line, 3), (bg, 4)], vec![(1, "land"), (2, "land"), (3, "land"), (4, "sea")]);
        let raster = build(&req, &bytes).unwrap();
        assert_eq!(raster.holes, vec![(1, 1)]);
        assert_eq!(raster.thin, vec![1, 3]);
    }

    #[test]
    fn pairs_that_touch_only_across_the_seam_are_kept() {
        let (a, b, c) = (0x0a0a0a, 0x0b0b0b, 0x0c0c0c);
        let bytes = pixels(&[&[a, c, c, b], &[a, c, c, b]]);
        let req = request(4, 2, vec![(a, 1), (b, 2), (c, 3)], vec![(1, "land"), (2, "land"), (3, "land")]);
        assert_eq!(build(&req, &bytes).unwrap().seam_only_pairs, vec![(1, 2)]);
    }

    #[test]
    fn a_bottom_up_palette_bitmap_reads_the_same_and_names_a_bad_index() {
        let mut req = request(2, 2, vec![(0x0000ff, 1), (0xff0000, 2)], vec![(1, "land"), (2, "sea")]);
        req.bits_per_pixel = 8;
        req.top_down = false;
        req.row_stride = 4;
        req.palette = vec![[0, 0, 255], [255, 0, 0]];
        // Stored bottom row first: bottom row [1, 0], top row [0, 1] in palette indices.
        let raster = build(&req, &[1, 0, 0, 0, 0, 1, 0, 0]).unwrap();
        assert_eq!(raster.province_ids, vec![1, 2, 2, 1]);
        let error = build(&req, &[1, 0, 0, 0, 0, 7, 0, 0]).unwrap_err();
        assert_eq!((error.code, error.x, error.y, error.index), ("MAP_BMP_PALETTE_INDEX_INVALID", 1, 0, 7));
    }

    #[test]
    fn a_request_whose_rows_reach_past_the_bytes_is_refused() {
        let req = request(4, 4, vec![], vec![]);
        let error = respond(&serde_json::to_value(RequestJson(&req)).unwrap(), &[0; 10]).unwrap_err();
        assert_eq!(error["code"], "invalid_request");
    }

    struct RequestJson<'a>(&'a Request);

    impl serde::Serialize for RequestJson<'_> {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            let r = self.0;
            json!({
                "schema": r.schema, "width": r.width, "height": r.height, "topDown": r.top_down,
                "bitsPerPixel": r.bits_per_pixel, "pixelOffset": r.pixel_offset, "rowStride": r.row_stride,
                "palette": r.palette, "colors": r.colors, "types": r.types,
            })
            .serialize(serializer)
        }
    }
}
