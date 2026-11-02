//! The focus view's layout numbers, read from the loaded `interface/nationalfocusview.gui` (a mod
//! may replace it), with the game 1.19.4.1 values as defaults.

use std::fs;

use hoi4_syntax::{Block, Document};

use crate::assets::Assets;

/// Where the parts of a focus sit, in pixels at UI scale 1.
#[derive(Clone, Debug, PartialEq)]
pub struct FocusView {
    /// Grid step: pixels per focus column and per row (`focus_spacing`).
    pub spacing: (i32, i32),
    /// Size of one focus item (`national_focus_item`).
    pub item: (i32, i32),
    /// Plaque (`bg`) position inside the item.
    pub plaque: (i32, i32),
    /// Icon (`symbol`) position; with `icon_centered` it is the icon's centre relative to the
    /// item's centre.
    pub icon: (i32, i32),
    pub icon_centered: bool,
    /// Title box (`name`): position, width, height and font.
    pub name: (i32, i32),
    pub name_size: (i32, i32),
    pub name_font: String,
    /// Connector start under the parent and end above the child (`link_begin`, `link_end`), and
    /// the drop from the start to the horizontal bar (`link_offsets`).
    pub link_begin: (i32, i32),
    pub link_end: (i32, i32),
    pub link_offset: (i32, i32),
    /// The exclusive mark: container position and the offsets from the left and right items.
    pub exclusive_item: (i32, i32),
    pub exclusive_offset: (i32, i32),
    pub exclusive_offset_left: (i32, i32),
    /// Top-left of the focus grid inside the tree window (`grid`).
    pub grid: (i32, i32),
    /// The tree window's two background sprites, drawn in order.
    pub backgrounds: Vec<String>,
}

impl Default for FocusView {
    fn default() -> Self {
        FocusView {
            spacing: (96, 130),
            item: (165, 128),
            plaque: (5, 40),
            icon: (5, -44),
            icon_centered: true,
            name: (15, 58),
            name_size: (147, 20),
            name_font: "hoi_16mbs".into(),
            link_begin: (80, 64),
            link_end: (80, 0),
            link_offset: (0, 32),
            exclusive_item: (-5, 28),
            exclusive_offset: (172, 24),
            exclusive_offset_left: (12, 24),
            grid: (50, 50),
            backgrounds: vec!["GFX_tiled_bg".into(), "GFX_tiled_focus_bg".into()],
        }
    }
}

fn scalar(doc: &Document, block: &Block, key: &str) -> Option<String> {
    block.entries().filter(|e| doc.key(e).eq_ignore_ascii_case(key)).filter_map(|e| e.value.as_scalar()).map(|t| doc.text(t).trim().to_string()).last()
}

fn pair(doc: &Document, block: &Block, key: &str) -> Option<(i32, i32)> {
    let inner = block.entries().filter(|e| doc.key(e).eq_ignore_ascii_case(key)).filter_map(|e| e.value.as_block()).last()?;
    let read = |names: [&str; 2]| names.iter().find_map(|n| scalar(doc, inner, n)).and_then(|v| v.trim_end_matches('%').parse::<f64>().ok());
    Some((read(["x", "width"])? as i32, read(["y", "height"])? as i32))
}

/// The first block (depth first) whose `name` is `name`.
fn named<'a>(doc: &Document, block: &'a Block, name: &str) -> Option<&'a Block> {
    for entry in block.entries() {
        let Some(inner) = entry.value.as_block() else { continue };
        if scalar(doc, inner, "name").is_some_and(|n| n.eq_ignore_ascii_case(name)) {
            return Some(inner);
        }
        if let Some(found) = named(doc, inner, name) {
            return Some(found);
        }
    }
    None
}

impl FocusView {
    /// Reads the loaded `nationalfocusview.gui`; anything it does not say keeps the default.
    pub fn load(assets: &Assets) -> FocusView {
        let mut view = FocusView::default();
        let Some(path) = assets.resolve("interface/nationalfocusview.gui") else { return view };
        let Ok(bytes) = fs::read(path) else { return view };
        let doc = Document::parse(bytes);
        let root = &doc.root;
        let position = |name: &str| named(&doc, root, name).and_then(|b| pair(&doc, b, "position"));
        if let Some(p) = position("focus_spacing") {
            view.spacing = p;
        }
        for (name, target) in [
            ("link_begin", &mut view.link_begin),
            ("link_end", &mut view.link_end),
            ("link_offsets", &mut view.link_offset),
            ("exclusive_offset", &mut view.exclusive_offset),
            ("exclusive_offset_left", &mut view.exclusive_offset_left),
        ] {
            if let Some(p) = position(name) {
                *target = p;
            }
        }
        if let Some(p) = position("national_focus_exclusive_item") {
            view.exclusive_item = p;
        }
        if let Some(item) = named(&doc, root, "national_focus_item") {
            if let Some(size) = pair(&doc, item, "size") {
                view.item = size;
            }
            if let Some(bg) = named(&doc, item, "bg").and_then(|b| pair(&doc, b, "position")) {
                view.plaque = bg;
            }
            if let Some(symbol) = named(&doc, item, "symbol") {
                if let Some(p) = pair(&doc, symbol, "position") {
                    view.icon = p;
                }
                view.icon_centered = scalar(&doc, symbol, "centerposition").is_some_and(|v| v.eq_ignore_ascii_case("yes"));
            }
            if let Some(name) = named(&doc, item, "name") {
                if let Some(p) = pair(&doc, name, "position") {
                    view.name = p;
                }
                let width = scalar(&doc, name, "maxWidth").and_then(|v| v.parse().ok());
                let height = scalar(&doc, name, "maxHeight").and_then(|v| v.parse().ok());
                if let (Some(w), Some(h)) = (width, height) {
                    view.name_size = (w, h);
                }
                if let Some(font) = scalar(&doc, name, "font") {
                    view.name_font = font;
                }
            }
        }
        if let Some(tree) = named(&doc, root, "tree") {
            let backgrounds: Vec<String> = tree
                .entries()
                .filter(|e| doc.key(e).eq_ignore_ascii_case("background"))
                .filter_map(|e| e.value.as_block())
                .filter_map(|b| scalar(&doc, b, "quadTextureSprite").or_else(|| scalar(&doc, b, "spriteType")))
                .collect();
            if !backgrounds.is_empty() {
                view.backgrounds = backgrounds;
            }
            if let Some(grid) = named(&doc, tree, "grid").and_then(|b| pair(&doc, b, "position")) {
                view.grid = grid;
            }
        }
        view
    }
}
