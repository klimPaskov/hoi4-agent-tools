//! The national focus view as the game draws it: the tree window's background, each focus's
//! plaque, icon and title, the connector tiles between prerequisites and the mark between
//! mutually exclusive focuses.
//!
//! Geometry comes from `interface/nationalfocusview.gui` ([`FocusView`]) and was checked against
//! in-game screenshots of game 1.19.4.1 at the default UI scale (hoi4-factory run27): plaques,
//! icons, connector tiles and the exclusive mark land on the same pixels, and titles on the same
//! box. Not modelled: focus states other than "can start" and "unavailable" (no save is read),
//! `available` and `bypass` triggers, joint-focus plaques, the shine and glow animations, and
//! exclusive marks between focuses on different rows or more than two columns apart.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use hoi4_texture::Image;
use serde::{Deserialize, Serialize};

use crate::assets::Assets;
use crate::canvas::{Canvas, Rect};
use crate::font::Font;
use crate::gui::FocusView;

/// What a player sees on a focus at the start of a game.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FocusState {
    /// No prerequisite: the plaque shows "can start".
    #[default]
    Auto,
    Available,
    Unavailable,
    Current,
    Completed,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusNode {
    pub id: String,
    pub x: i32,
    pub y: i32,
    /// Sprite name of the icon (`GFX_goal_unknown`).
    #[serde(default)]
    pub icon: Option<String>,
    /// The title as the player reads it: localised, or the raw key when the game has none.
    pub title: String,
    #[serde(default)]
    pub state: FocusState,
    /// Prerequisite groups: every group is required, any focus of a group satisfies it.
    #[serde(default)]
    pub prerequisites: Vec<Vec<String>>,
    #[serde(default)]
    pub mutually_exclusive: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusRenderRequest {
    pub focuses: Vec<FocusNode>,
    /// Output scale, 0 < scale <= 1.
    #[serde(default = "one")]
    pub scale: f64,
    /// Largest output image in pixels; the scale shrinks to fit.
    #[serde(default)]
    pub max_pixels: Option<u64>,
}

fn one() -> f64 {
    1.0
}

/// Where a focus landed in the output image, for hover and click maps.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusBox {
    pub id: String,
    /// Plaque and icon together, in output pixels.
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// An asset the render could not draw, and the focuses it affects.
#[derive(Clone, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct Missing {
    /// `sprite`, `texture`, `font` or `glyph`.
    pub kind: String,
    pub name: String,
    pub message: String,
    pub focus_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Drawn {
    pub plaques: usize,
    pub icons: usize,
    pub titles: usize,
    pub link_tiles: usize,
    pub exclusive_marks: usize,
    /// Mutually exclusive pairs the game draws no mark for, or that this renderer cannot place.
    pub exclusive_pairs_without_mark: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusRenderReport {
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    /// Size at scale 1.
    pub full_width: u32,
    pub full_height: u32,
    pub focuses: Vec<FocusBox>,
    pub missing: Vec<Missing>,
    pub drawn: Drawn,
}

/// One drawing step, in full-scale pixels.
enum Op {
    Blit { image: Arc<Image>, source: Rect, x: i32, y: i32 },
    Tile { image: Arc<Image>, source: Rect, target: Rect },
    Cornered { image: Arc<Image>, border: (i32, i32), tiling_center: bool, target: Rect },
    Text { font: Arc<Font>, text: String, area: Rect },
}

impl Op {
    fn bounds(&self) -> Rect {
        match self {
            Op::Blit { source, x, y, .. } => Rect::new(*x, *y, source.width, source.height),
            Op::Tile { target, .. } | Op::Cornered { target, .. } => *target,
            Op::Text { area, .. } => Rect::new(area.x - 8, area.y - 24, area.width + 16, area.height + 48),
        }
    }

    fn draw(&self, canvas: &mut Canvas, ox: i32, oy: i32) {
        match self {
            Op::Blit { image, source, x, y } => canvas.blit(image, *source, x - ox, y - oy, 255),
            Op::Tile { image, source, target } => canvas.tile(image, *source, Rect::new(target.x - ox, target.y - oy, target.width, target.height), 255),
            Op::Cornered { image, border, tiling_center, target } => {
                canvas.cornered_tile(image, *border, *tiling_center, Rect::new(target.x - ox, target.y - oy, target.width, target.height), 255)
            }
            Op::Text { font, text, area } => {
                font.draw_centered(canvas, text, Rect::new(area.x - ox, area.y - oy, area.width, area.height));
            }
        }
    }
}

/// The frame `frame` (1-based, as `.gui` files count) of a sprite sheet.
fn frame_rect(image: &Image, frames: u32, frame: u32) -> Rect {
    let frames = frames.max(1);
    let width = image.width as i32 / frames as i32;
    let index = frame.clamp(1, frames) as i32 - 1;
    Rect::new(index * width, 0, width, image.height as i32)
}

const UP: u8 = 1;
const DOWN: u8 = 2;
const LEFT: u8 = 4;
const RIGHT: u8 = 8;

fn link_sprite(mask: u8) -> &'static str {
    match mask {
        m if m == UP | DOWN => "GFX_focus_link_up_down",
        m if m == LEFT | RIGHT => "GFX_focus_link_left_right",
        m if m == DOWN | LEFT => "GFX_focus_link_down_left",
        m if m == DOWN | RIGHT => "GFX_focus_link_down_right",
        m if m == UP | LEFT => "GFX_focus_link_up_left",
        m if m == UP | RIGHT => "GFX_focus_link_up_right",
        m if m == DOWN | LEFT | RIGHT => "GFX_focus_link_down_left_right",
        m if m == UP | LEFT | RIGHT => "GFX_focus_link_up_left_right",
        m if m == UP | DOWN | LEFT => "GFX_focus_link_up_down_left",
        m if m == UP | DOWN | RIGHT => "GFX_focus_link_up_down_right",
        m if m == UP | DOWN | LEFT | RIGHT => "GFX_focus_link_up_down_left_right",
        m if m & (UP | DOWN) != 0 => "GFX_focus_link_up_down",
        _ => "GFX_focus_link_left_right",
    }
}

/// A connector tile: its directions, and whether any line through it is solid.
#[derive(Default, Clone, Copy)]
struct Cell {
    mask: u8,
    solid: bool,
    completed: bool,
}

struct Builder<'a> {
    assets: &'a Assets,
    ops: Vec<Op>,
    missing: BTreeMap<(String, String), (String, Vec<String>)>,
    drawn: Drawn,
}

impl Builder<'_> {
    fn miss(&mut self, kind: &str, name: &str, message: String, focus: Option<&str>) {
        let entry = self.missing.entry((kind.to_string(), name.to_string())).or_insert_with(|| (message, Vec::new()));
        if let Some(id) = focus
            && !entry.1.iter().any(|f| f == id)
        {
            entry.1.push(id.to_string());
        }
    }

    /// A sprite's texture, frame count and definition, or a recorded miss.
    fn sprite(&mut self, name: &str, focus: Option<&str>) -> Option<(Arc<Image>, crate::assets::Sprite)> {
        let Some(sprite) = self.assets.sprite(name).cloned() else {
            self.miss("sprite", name, format!("sprite {name} is not defined in any loaded interface/*.gfx file"), focus);
            return None;
        };
        let Some(texture) = sprite.texture.clone() else {
            self.miss("sprite", name, format!("sprite {name} has no texturefile"), focus);
            return None;
        };
        match self.assets.texture(&texture) {
            Ok(image) => Some((image, sprite)),
            Err(message) => {
                self.miss("texture", &texture, format!("{name}: {message}"), focus);
                None
            }
        }
    }
}

fn state_of(node: &FocusNode) -> FocusState {
    match node.state {
        FocusState::Auto if node.prerequisites.iter().all(Vec::is_empty) => FocusState::Available,
        FocusState::Auto => FocusState::Unavailable,
        other => other,
    }
}

fn plaque_sprite(state: FocusState) -> &'static str {
    match state {
        FocusState::Completed => "GFX_focus_completed",
        FocusState::Current => "GFX_focus_current",
        FocusState::Available | FocusState::Auto => "GFX_focus_can_start",
        FocusState::Unavailable => "GFX_focus_unavailable",
    }
}

/// The finished render: pixels and what was drawn and missed.
pub struct FocusRender {
    pub image: Image,
    pub report: FocusRenderReport,
}

/// The default output ceiling, the TypeScript renderers' per-image limit.
pub const DEFAULT_MAX_PIXELS: u64 = 50_331_648;

pub fn render(assets: &Assets, request: &FocusRenderRequest) -> Result<FocusRender, String> {
    if request.focuses.is_empty() {
        return Err("the focus tree has no focuses to draw".into());
    }
    if !(request.scale > 0.0 && request.scale <= 1.0) {
        return Err(format!("scale must be above 0 and at most 1, not {}", request.scale));
    }
    let view = FocusView::load(assets);
    let min_x = request.focuses.iter().map(|f| f.x).min().unwrap_or(0);
    let min_y = request.focuses.iter().map(|f| f.y).min().unwrap_or(0);
    let max_x = request.focuses.iter().map(|f| f.x).max().unwrap_or(0);
    let max_y = request.focuses.iter().map(|f| f.y).max().unwrap_or(0);
    // The tree window's margin around the grid, as the game leaves it (`margin` and `grid`).
    let margin = 13;
    let origin = (margin + view.grid.0, margin + view.grid.1);
    let full_width = (origin.0 * 2 + (max_x - min_x) * view.spacing.0 + view.item.0).max(320);
    let full_height = (origin.1 * 2 + (max_y - min_y) * view.spacing.1 + view.item.1).max(240);
    let item_of = |node: &FocusNode| (origin.0 + (node.x - min_x) * view.spacing.0, origin.1 + (node.y - min_y) * view.spacing.1);

    let mut builder = Builder { assets, ops: Vec::new(), missing: BTreeMap::new(), drawn: Drawn::default() };
    let full = Rect::new(0, 0, full_width, full_height);
    for background in &view.backgrounds {
        let Some((image, sprite)) = builder.sprite(background, None) else { continue };
        let source = Rect::new(0, 0, image.width as i32, image.height as i32);
        match sprite.border {
            Some(border) if sprite.kind.eq_ignore_ascii_case("corneredTileSpriteType") => {
                builder.ops.push(Op::Cornered { image, border, tiling_center: sprite.tiling_center, target: full });
            }
            _ => builder.ops.push(Op::Tile { image, source, target: full }),
        }
    }

    // Connector tiles, merged so that crossing and joining lines use the game's junction tiles.
    let by_id: HashMap<&str, &FocusNode> = request.focuses.iter().map(|f| (f.id.as_str(), f)).collect();
    let mut cells: BTreeMap<(i32, i32), Cell> = BTreeMap::new();
    let mut add = |x: i32, y: i32, mask: u8, solid: bool, completed: bool| {
        let cell = cells.entry((x, y)).or_default();
        cell.mask |= mask;
        cell.solid |= solid;
        cell.completed |= completed;
    };
    let tile = 16;
    for child in &request.focuses {
        let (cx, cy) = item_of(child);
        for group in &child.prerequisites {
            let solid = group.len() <= 1;
            for parent_id in group {
                let Some(parent) = by_id.get(parent_id.as_str()) else { continue };
                let completed = state_of(parent) == FocusState::Completed;
                let (px, py) = item_of(parent);
                // Tile columns sit two pixels left of the link points (`national_focus_link`).
                let (x0, x1) = (px + view.link_begin.0 - 2, cx + view.link_end.0 - 2);
                let start = py + view.link_begin.1;
                let bar = start + view.link_offset.1;
                let end = cy + view.link_end.1;
                if end <= bar {
                    // A child level with or above its parent: the game draws no connector.
                    continue;
                }
                let mut y = start;
                while y < bar {
                    add(x0, y, UP | DOWN, solid, completed);
                    y += tile;
                }
                if x0 == x1 {
                    add(x0, bar, UP | DOWN, solid, completed);
                } else {
                    let (towards, back) = if x1 > x0 { (RIGHT, LEFT) } else { (LEFT, RIGHT) };
                    add(x0, bar, UP | towards, solid, completed);
                    let step = if x1 > x0 { tile } else { -tile };
                    let mut x = x0 + step;
                    while (step > 0 && x < x1) || (step < 0 && x > x1) {
                        add(x, bar, LEFT | RIGHT, solid, completed);
                        x += step;
                    }
                    add(x1, bar, DOWN | back, solid, completed);
                }
                let mut y = bar + tile;
                while y < end {
                    add(x1, y, UP | DOWN, solid, completed);
                    y += tile;
                }
            }
        }
    }
    let mut link_sheets: HashMap<&'static str, Option<(Arc<Image>, u32)>> = HashMap::new();
    for ((x, y), cell) in cells {
        let name = link_sprite(cell.mask);
        let sheet = match link_sheets.get(name) {
            Some(sheet) => sheet.clone(),
            None => {
                let loaded = builder.sprite(name, None).map(|(image, sprite)| (image, sprite.frames));
                link_sheets.insert(name, loaded.clone());
                loaded
            }
        };
        let Some((image, frames)) = sheet else { continue };
        // Frames: 1 and 2 completed (solid, dotted), 3 and 4 not yet (solid, dotted).
        let frame = match (cell.completed, cell.solid) {
            (true, true) => 1,
            (true, false) => 2,
            (false, true) => 3,
            (false, false) => 4,
        };
        let source = frame_rect(&image, frames, frame);
        builder.ops.push(Op::Blit { image, source, x, y });
        builder.drawn.link_tiles += 1;
    }

    // Exclusive marks between focuses on one row, two columns apart (the case the in-game check
    // confirmed); other pairs are counted, not drawn.
    let mut pairs: Vec<(&FocusNode, &FocusNode)> = Vec::new();
    for node in &request.focuses {
        for other in &node.mutually_exclusive {
            let Some(other) = by_id.get(other.as_str()) else { continue };
            let (left, right) = if (node.x, &node.id) < (other.x, &other.id) { (node, *other) } else { (*other, node) };
            if !pairs.iter().any(|(a, b)| a.id == left.id && b.id == right.id) {
                pairs.push((left, right));
            }
        }
    }
    for (left, right) in pairs {
        let (lx, ly) = item_of(left);
        let (rx, _) = item_of(right);
        let start = lx + view.exclusive_offset.0 + view.exclusive_item.0;
        let finish = rx + view.exclusive_offset_left.0 + view.exclusive_item.0;
        if left.y != right.y || finish - start < 0 {
            builder.drawn.exclusive_pairs_without_mark += 1;
            continue;
        }
        let Some((image, sprite)) = builder.sprite("GFX_focus_link_exclusive", Some(&left.id)) else { continue };
        let mark = frame_rect(&image, sprite.frames, 1);
        let y = ly + view.exclusive_offset.1 + view.exclusive_item.1;
        let x = start + (finish - start - mark.width) / 2;
        builder.ops.push(Op::Blit { image, source: mark, x, y });
        builder.drawn.exclusive_marks += 1;
    }

    // Focus items: plaque, icon, title.
    let font = match assets.font(&view.name_font) {
        Ok(font) => Some(font),
        Err(message) => {
            builder.miss("font", &view.name_font, message, None);
            None
        }
    };
    let mut boxes = Vec::new();
    let mut order: Vec<&FocusNode> = request.focuses.iter().collect();
    order.sort_by_key(|f| (f.y, f.x));
    for node in order {
        let (ix, iy) = item_of(node);
        let mut bounds = Rect::new(ix + view.plaque.0, iy + view.plaque.1, 0, 0);
        if let Some((image, _)) = builder.sprite(plaque_sprite(state_of(node)), Some(&node.id)) {
            let source = Rect::new(0, 0, image.width as i32, image.height as i32);
            bounds = Rect::new(ix + view.plaque.0, iy + view.plaque.1, source.width, source.height);
            builder.ops.push(Op::Blit { image, source, x: bounds.x, y: bounds.y });
            builder.drawn.plaques += 1;
        }
        if let Some(icon) = &node.icon {
            if let Some((image, sprite)) = builder.sprite(icon, Some(&node.id)) {
                let source = frame_rect(&image, sprite.frames, 1);
                let (x, y) = if view.icon_centered {
                    (ix + view.item.0 / 2 + view.icon.0 - source.width / 2, iy + view.item.1 / 2 + view.icon.1 - source.height / 2)
                } else {
                    (ix + view.icon.0, iy + view.icon.1)
                };
                let top = bounds.y.min(y);
                let left = bounds.x.min(x);
                let right = (bounds.x + bounds.width).max(x + source.width);
                let bottom = (bounds.y + bounds.height).max(y + source.height);
                bounds = Rect::new(left, top, right - left, bottom - top);
                builder.ops.push(Op::Blit { image, source, x, y });
                builder.drawn.icons += 1;
            }
        } else {
            builder.miss("sprite", "(none)", "the focus has no icon".into(), Some(&node.id));
        }
        if let Some(font) = &font {
            let area = Rect::new(ix + view.name.0, iy + view.name.1, view.name_size.0, view.name_size.1);
            let missing: Vec<char> = crate::font::strip_codes(&node.title).chars().filter(|c| !c.is_whitespace() && !font_has(font, *c)).collect();
            for c in missing {
                builder.miss("glyph", &format!("U+{:04X}", c as u32), format!("font {} has no glyph for {c:?}", view.name_font), Some(&node.id));
            }
            builder.ops.push(Op::Text { font: Arc::clone(font), text: node.title.clone(), area });
            builder.drawn.titles += 1;
        }
        boxes.push((node.id.clone(), bounds));
    }

    // Fit the output under the pixel ceiling.
    let max_pixels = request.max_pixels.unwrap_or(DEFAULT_MAX_PIXELS) as f64;
    let mut scale = request.scale;
    let area = f64::from(full_width) * f64::from(full_height);
    if area * scale * scale > max_pixels {
        scale = (max_pixels / area).sqrt();
    }
    let width = ((f64::from(full_width) * scale).floor() as u32).max(1);
    let height = ((f64::from(full_height) * scale).floor() as u32).max(1);
    let image = rasterize(&builder.ops, full_width as u32, full_height as u32, width, height);
    let sx = f64::from(width) / f64::from(full_width);
    let sy = f64::from(height) / f64::from(full_height);
    let focuses = boxes
        .into_iter()
        .map(|(id, b)| FocusBox {
            id,
            x: (f64::from(b.x) * sx).floor() as i32,
            y: (f64::from(b.y) * sy).floor() as i32,
            width: (f64::from(b.width) * sx).ceil() as i32,
            height: (f64::from(b.height) * sy).ceil() as i32,
        })
        .collect();
    let missing = builder
        .missing
        .into_iter()
        .map(|((kind, name), (message, mut focus_ids))| {
            focus_ids.sort();
            Missing { kind, name, message, focus_ids }
        })
        .collect();
    Ok(FocusRender {
        image,
        report: FocusRenderReport {
            width,
            height,
            scale: sx,
            full_width: full_width as u32,
            full_height: full_height as u32,
            focuses,
            missing,
            drawn: builder.drawn,
        },
    })
}

fn font_has(font: &Font, c: char) -> bool {
    font.files.iter().any(|(file, _)| file.glyphs.contains_key(&(c as u32)))
}

/// Draws the operations at full scale band by band and averages each band down to the output,
/// so a large tree never needs its full-scale image in memory.
fn rasterize(ops: &[Op], full_width: u32, full_height: u32, width: u32, height: u32) -> Image {
    use rayon::prelude::*;
    let bounds: Vec<Rect> = ops.iter().map(Op::bounds).collect();
    let draw_band = |sy0: i32, sy1: i32| {
        let mut canvas = Canvas::new(full_width, (sy1 - sy0) as u32);
        for (op, b) in ops.iter().zip(&bounds) {
            if b.y < sy1 && b.y + b.height > sy0 {
                op.draw(&mut canvas, 0, sy0);
            }
        }
        canvas
    };
    if width == full_width && height == full_height {
        // Bands in parallel, then stacked.
        let band = 256;
        let bands: Vec<Canvas> =
            (0..full_height.div_ceil(band)).into_par_iter().map(|i| draw_band((i * band) as i32, ((i + 1) * band).min(full_height) as i32)).collect();
        let mut image = Image::new(width, height);
        let mut offset = 0;
        for canvas in bands {
            let len = canvas.image.rgba.len();
            image.rgba[offset..offset + len].copy_from_slice(&canvas.image.rgba);
            offset += len;
        }
        return image;
    }
    let (fw, fh) = (full_width as usize, full_height as usize);
    let rows_per_band = (2048 * 2048 / fw.max(1)).max(1) * height as usize / fh.max(1);
    let rows_per_band = rows_per_band.max(1);
    let bands: Vec<(usize, Vec<u8>)> = (0..height as usize)
        .step_by(rows_per_band)
        .collect::<Vec<_>>()
        .into_par_iter()
        .map(|oy0| {
            let oy1 = (oy0 + rows_per_band).min(height as usize);
            let sy0 = oy0 * fh / height as usize;
            let sy1 = (oy1 * fh / height as usize).max(sy0 + 1).min(fh);
            let canvas = draw_band(sy0 as i32, sy1 as i32);
            let mut out = vec![0u8; (oy1 - oy0) * width as usize * 4];
            for oy in oy0..oy1 {
                let y0 = oy * fh / height as usize;
                let y1 = ((oy + 1) * fh / height as usize).max(y0 + 1).min(fh);
                for ox in 0..width as usize {
                    let x0 = ox * fw / width as usize;
                    let x1 = ((ox + 1) * fw / width as usize).max(x0 + 1).min(fw);
                    let pixel = crate::canvas::average(&canvas.image.rgba, fw, x0..x1, y0 - sy0..y1 - sy0);
                    let index = ((oy - oy0) * width as usize + ox) * 4;
                    out[index..index + 4].copy_from_slice(&pixel);
                }
            }
            (oy0, out)
        })
        .collect();
    let mut image = Image::new(width, height);
    for (oy0, rows) in bands {
        let offset = oy0 * width as usize * 4;
        image.rgba[offset..offset + rows.len()].copy_from_slice(&rows);
    }
    image
}
