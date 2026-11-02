//! The assets a preview draws, resolved the way the game resolves them: sprites and bitmap fonts
//! from every loaded `interface/**/*.gfx` file (a later definition wins), and texture files from
//! the highest layer that has them, matched without regard to case.
//!
//! An [`Assets`] value lives as long as the resident engine keeps a workspace. `refresh` re-reads
//! only what changed: `.gfx` files whose size or modification time moved, and folder listings
//! whose folder changed. Decoded textures are cached by path, size and modification time.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use hoi4_engine::sprites::normalize_texture_path;
use hoi4_engine::workspace::walk_sources;
use hoi4_syntax::{Block, Document, Item, Value};
use hoi4_texture::Image;
use rayon::prelude::*;

use crate::font::{Font, FontFile, default_text_colours};

/// One source root in load order: the game, a DLC, a dependency or the mod.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct LayerRoot {
    pub name: String,
    pub path: PathBuf,
    /// `replace_path` folders (lower case, `/`-separated) that hide every earlier layer's files.
    pub replace_paths: Vec<String>,
}

/// A sprite definition with what drawing needs.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Sprite {
    pub name: String,
    /// `spriteType`, `corneredTileSpriteType`, `frameAnimatedSpriteType`, ...
    pub kind: String,
    pub texture: Option<String>,
    pub frames: u32,
    pub border: Option<(i32, i32)>,
    pub size: Option<(i32, i32)>,
    pub tiling_center: bool,
    /// Where it is defined: layer name and relative path.
    pub source: String,
}

#[derive(Clone, Debug, Default)]
pub struct FontDef {
    pub files: Vec<String>,
    pub colour: [u8; 4],
    pub text_colours: HashMap<char, [u8; 3]>,
}

type Stamp = (u64, Option<SystemTime>);

fn stamp(path: &Path) -> Option<Stamp> {
    let meta = fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()))
}

fn scalar(doc: &Document, block: &Block, key: &str) -> Option<String> {
    block.entries().filter(|e| doc.key(e).eq_ignore_ascii_case(key)).filter_map(|e| e.value.as_scalar()).map(|t| doc.text(t).trim().to_string()).last()
}

fn pair(doc: &Document, block: &Block, key: &str) -> Option<(i32, i32)> {
    let inner = block.entries().filter(|e| doc.key(e).eq_ignore_ascii_case(key)).filter_map(|e| e.value.as_block()).last()?;
    let x = scalar(doc, inner, "x")?.parse::<f64>().ok()? as i32;
    let y = scalar(doc, inner, "y")?.parse::<f64>().ok()? as i32;
    Some((x, y))
}

fn yes(value: Option<String>) -> bool {
    value.is_some_and(|v| v.eq_ignore_ascii_case("yes"))
}

/// Sprites and fonts defined in one `.gfx` file.
#[derive(Default)]
struct GfxFile {
    sprites: Vec<Sprite>,
    fonts: Vec<(String, FontDef)>,
}

fn parse_colour(text: &str) -> Option<[u8; 4]> {
    let hex = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X"))?;
    let value = u32::from_str_radix(hex, 16).ok()?;
    // `color = 0xffffffff` is RGBA.
    Some([(value >> 24) as u8, (value >> 16) as u8, (value >> 8) as u8, value as u8])
}

fn parse_gfx(bytes: Vec<u8>, source: &str) -> GfxFile {
    let doc = Document::parse(bytes);
    let mut out = GfxFile::default();
    for top in doc.root.entries() {
        let Some(list) = top.value.as_block() else { continue };
        let section = doc.key(top).to_ascii_lowercase();
        for entry in list.entries() {
            let kind = doc.key(entry).into_owned();
            let Some(block) = entry.value.as_block() else { continue };
            let Some(name) = scalar(&doc, block, "name").filter(|n| !n.is_empty()) else { continue };
            if section == "spritetypes" {
                out.sprites.push(Sprite {
                    texture: scalar(&doc, block, "texturefile").filter(|t| !t.is_empty()).map(|t| normalize_texture_path(&t)),
                    frames: scalar(&doc, block, "noOfFrames").and_then(|t| t.parse().ok()).unwrap_or(1).max(1),
                    border: pair(&doc, block, "borderSize"),
                    size: pair(&doc, block, "size"),
                    tiling_center: yes(scalar(&doc, block, "tilingCenter")),
                    kind,
                    name,
                    source: source.to_string(),
                });
            } else if section == "bitmapfonts" && kind.eq_ignore_ascii_case("bitmapfont") {
                let mut files = Vec::new();
                if let Some(list) = block.entries().find(|e| doc.key(e).eq_ignore_ascii_case("fontfiles")).and_then(|e| e.value.as_block()) {
                    for item in &list.items {
                        if let Item::Value(Value::Scalar(token)) = item {
                            files.push(normalize_texture_path(&doc.text(*token)));
                        }
                    }
                }
                if let Some(path) = scalar(&doc, block, "path") {
                    files.push(normalize_texture_path(&path));
                }
                let mut text_colours = default_text_colours();
                if let Some(colours) = block.entries().find(|e| doc.key(e).eq_ignore_ascii_case("textcolors")).and_then(|e| e.value.as_block()) {
                    for colour in colours.entries() {
                        let key = doc.key(colour);
                        let Some(code) = key.chars().next() else { continue };
                        let Some(rgb) = colour.value.as_block() else { continue };
                        let values: Vec<u8> = rgb
                            .items
                            .iter()
                            .filter_map(|item| match item {
                                Item::Value(Value::Scalar(t)) => doc.text(*t).parse::<f64>().ok().map(|v| v.clamp(0.0, 255.0) as u8),
                                _ => None,
                            })
                            .collect();
                        if let [r, g, b, ..] = values[..] {
                            text_colours.insert(code, [r, g, b]);
                        }
                    }
                }
                let colour = scalar(&doc, block, "color").and_then(|c| parse_colour(&c)).unwrap_or([255, 255, 255, 255]);
                out.fonts.push((name, FontDef { files, colour, text_colours }));
            }
        }
    }
    out
}

/// A folder listing: lower-case name to the actual names with that spelling.
struct Listing {
    stamp: Option<SystemTime>,
    names: HashMap<String, Vec<String>>,
}

/// Every decoded texture and font, shared by the renders of one workspace.
#[derive(Default)]
struct Decoded {
    textures: HashMap<PathBuf, (Stamp, Result<Arc<Image>, String>)>,
    bytes: usize,
    fonts: HashMap<String, Arc<Font>>,
}

/// Counters a render reports, to show what the cache saved.
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub gfx_files: usize,
    pub gfx_files_parsed: usize,
    pub sprites: usize,
    pub textures_decoded: usize,
    pub textures_cached: usize,
}

pub struct Assets {
    layers: Vec<LayerRoot>,
    /// Effective `.gfx` files by lower-case relative path: (stamp, absolute path, parsed).
    gfx: HashMap<String, (Stamp, PathBuf, Arc<GfxFile>)>,
    gfx_order: Vec<String>,
    sprites: HashMap<String, Sprite>,
    fonts: HashMap<String, FontDef>,
    listings: Mutex<HashMap<PathBuf, Listing>>,
    decoded: Mutex<Decoded>,
    /// Decoded textures are dropped, oldest first, above this many bytes.
    cache_limit: usize,
    pub stats: CacheStats,
}

/// The decoded-texture cache limit.
pub const DEFAULT_CACHE_BYTES: usize = 768 * 1024 * 1024;

impl Assets {
    pub fn new(layers: Vec<LayerRoot>) -> Assets {
        let mut assets = Assets {
            layers,
            gfx: HashMap::new(),
            gfx_order: Vec::new(),
            sprites: HashMap::new(),
            fonts: HashMap::new(),
            listings: Mutex::new(HashMap::new()),
            decoded: Mutex::new(Decoded::default()),
            cache_limit: DEFAULT_CACHE_BYTES,
            stats: CacheStats::default(),
        };
        assets.refresh();
        assets
    }

    pub fn layers(&self) -> &[LayerRoot] {
        &self.layers
    }

    /// Re-reads the `.gfx` files that changed since the last call and rebuilds the sprite and
    /// font tables when any did. Cheap when nothing changed: one folder walk and one stat per file.
    pub fn refresh(&mut self) {
        let mut effective: HashMap<String, (usize, PathBuf)> = HashMap::new();
        for (index, layer) in self.layers.iter().enumerate() {
            for (relative, absolute) in walk_sources(&layer.path, Some(&["interface"])) {
                if !relative.to_ascii_lowercase().ends_with(".gfx") {
                    continue;
                }
                let key = relative.to_ascii_lowercase();
                let folder = key.rsplit_once('/').map_or("", |(dir, _)| dir).to_string();
                let hidden = self.layers.iter().skip(index + 1).any(|l| l.replace_paths.contains(&folder));
                if !hidden {
                    effective.insert(key, (index, absolute));
                }
            }
        }
        let mut order: Vec<(usize, String)> = effective.iter().map(|(key, (layer, _))| (*layer, key.clone())).collect();
        order.sort();
        let previous = std::mem::take(&mut self.gfx);
        let parsed: Vec<(String, Stamp, PathBuf, Arc<GfxFile>, bool)> = order
            .par_iter()
            .filter_map(|(layer, key)| {
                let (_, absolute) = &effective[key];
                let current = stamp(absolute)?;
                if let Some((old, old_path, file)) = previous.get(key)
                    && *old == current
                    && old_path == absolute
                {
                    return Some((key.clone(), current, absolute.clone(), Arc::clone(file), false));
                }
                let bytes = fs::read(absolute).ok()?;
                let source = format!("{}:{}", self.layers[*layer].name, key);
                Some((key.clone(), current, absolute.clone(), Arc::new(parse_gfx(bytes, &source)), true))
            })
            .collect();
        let changed = parsed.iter().any(|p| p.4) || parsed.len() != previous.len() || self.gfx_order.is_empty();
        self.stats.gfx_files = parsed.len();
        self.stats.gfx_files_parsed = parsed.iter().filter(|p| p.4).count();
        self.gfx_order = parsed.iter().map(|p| p.0.clone()).collect();
        for (key, current, absolute, file, _) in parsed {
            self.gfx.insert(key, (current, absolute, file));
        }
        if changed {
            self.sprites.clear();
            self.fonts.clear();
            for key in &self.gfx_order {
                let file = &self.gfx[key].2;
                for sprite in &file.sprites {
                    self.sprites.insert(sprite.name.to_ascii_lowercase(), sprite.clone());
                }
                for (name, font) in &file.fonts {
                    self.fonts.insert(name.to_ascii_lowercase(), font.clone());
                }
            }
            // Fonts are built from their definitions; a changed definition needs a new build.
            self.decoded.lock().unwrap_or_else(|e| e.into_inner()).fonts.clear();
        }
        self.stats.sprites = self.sprites.len();
    }

    pub fn sprite(&self, name: &str) -> Option<&Sprite> {
        self.sprites.get(&name.to_ascii_lowercase())
    }

    /// The absolute path of a game-relative file, from the highest layer that has it.
    pub fn resolve(&self, relative: &str) -> Option<PathBuf> {
        let key = normalize_texture_path(relative).to_ascii_lowercase();
        let parts: Vec<&str> = key.split('/').filter(|p| !p.is_empty()).collect();
        if parts.is_empty() || parts.contains(&"..") {
            return None;
        }
        let folder = key.rsplit_once('/').map_or("", |(dir, _)| dir).to_string();
        for index in (0..self.layers.len()).rev() {
            if self.layers.iter().skip(index + 1).any(|l| l.replace_paths.contains(&folder)) {
                continue;
            }
            if let Some(found) = self.walk(&self.layers[index].path, &parts) {
                return Some(found);
            }
        }
        None
    }

    fn walk(&self, dir: &Path, parts: &[&str]) -> Option<PathBuf> {
        let (first, rest) = parts.split_first()?;
        for actual in self.names(dir, first) {
            let next = dir.join(&actual);
            if rest.is_empty() {
                if next.is_file() {
                    return Some(next);
                }
            } else if let Some(found) = self.walk(&next, rest) {
                return Some(found);
            }
        }
        None
    }

    /// The actual names in `dir` that match `lower` without regard to case. A folder listing is
    /// reused until the folder's modification time changes (adding or removing a file changes it).
    fn names(&self, dir: &Path, lower: &str) -> Vec<String> {
        let current = fs::metadata(dir).ok().and_then(|m| m.modified().ok());
        let mut listings = self.listings.lock().unwrap_or_else(|e| e.into_inner());
        let fresh = listings.get(dir).is_some_and(|l| l.stamp == current && current.is_some());
        if !fresh {
            let mut names: HashMap<String, Vec<String>> = HashMap::new();
            if let Ok(entries) = fs::read_dir(dir) {
                let mut all: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
                all.sort();
                for name in all {
                    names.entry(name.to_ascii_lowercase()).or_default().push(name);
                }
            }
            listings.insert(dir.to_path_buf(), Listing { stamp: current, names });
        }
        listings.get(dir).and_then(|l| l.names.get(lower)).cloned().unwrap_or_default()
    }

    /// Decodes a texture file (cached). `Err` names the problem: missing or undecodable.
    pub fn texture(&self, relative: &str) -> Result<Arc<Image>, String> {
        let Some(path) = self.resolve(relative) else {
            return Err(format!("texture file {relative} does not exist in any loaded layer"));
        };
        self.texture_at(&path)
    }

    fn texture_at(&self, path: &Path) -> Result<Arc<Image>, String> {
        let current = stamp(path).ok_or_else(|| format!("cannot read {}", path.display()))?;
        {
            let decoded = self.decoded.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((old, result)) = decoded.textures.get(path)
                && *old == current
            {
                return result.clone();
            }
        }
        let result =
            hoi4_texture::decode_file(path, hoi4_texture::DEFAULT_MAX_PIXELS).map(|d| Arc::new(d.image)).map_err(|e| format!("{}: {e}", path.display()));
        let mut decoded = self.decoded.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(image) = &result {
            decoded.bytes += image.rgba.len();
        }
        if decoded.bytes > self.cache_limit {
            // Simple and rare: drop everything but this texture.
            decoded.textures.clear();
            decoded.bytes = result.as_ref().map_or(0, |i| i.rgba.len());
        }
        decoded.textures.insert(path.to_path_buf(), (current, result.clone()));
        result
    }

    /// Number of decoded textures held.
    pub fn cached_textures(&self) -> usize {
        self.decoded.lock().unwrap_or_else(|e| e.into_inner()).textures.len()
    }

    /// A bitmap font by `bitmapfont` name (cached). `Err` says what is missing.
    pub fn font(&self, name: &str) -> Result<Arc<Font>, String> {
        let key = name.to_ascii_lowercase();
        if let Some(font) = self.decoded.lock().unwrap_or_else(|e| e.into_inner()).fonts.get(&key) {
            return Ok(Arc::clone(font));
        }
        let def = self.fonts.get(&key).ok_or_else(|| format!("bitmap font {name} is not defined"))?;
        let mut files = Vec::new();
        for file in &def.files {
            let fnt = format!("{file}.fnt");
            let Some(path) = self.resolve(&fnt) else { continue };
            let Ok(text) = fs::read(&path) else { continue };
            let parsed = FontFile::parse(&String::from_utf8_lossy(&text));
            let folder = normalize_texture_path(file).rsplit_once('/').map_or(String::new(), |(dir, _)| dir.to_string());
            let pages = parsed
                .pages
                .iter()
                .map(|page| {
                    let relative = if folder.is_empty() { page.clone() } else { format!("{folder}/{page}") };
                    self.texture(&relative).ok()
                })
                .collect();
            files.push((parsed, pages));
        }
        if files.is_empty() {
            return Err(format!("bitmap font {name}: none of its .fnt files exist"));
        }
        let font = Arc::new(Font { files, colour: def.colour, text_colours: def.text_colours.clone() });
        self.decoded.lock().unwrap_or_else(|e| e.into_inner()).fonts.insert(key, Arc::clone(&font));
        Ok(font)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sprites_and_fonts() {
        let gfx = br#"spriteTypes = {
            spriteType = { name = "GFX_a" texturefile = "gfx//interface\\a.dds" noOfFrames = 4 }
            corneredTileSpriteType = { name = "GFX_bg" size = { x=988 y=1031 } texturefile = "gfx/b.dds" borderSize = { x = 495 y = 495 } tilingCenter = no }
        }
        bitmapfonts = {
            bitmapfont = { name = "hoi_16mbs" fontfiles = { "gfx/fonts/hoi_16mbs" "gfx/fonts/x" } color = 0xff0000ff textcolors = { Y = { 1 2 3 } } }
        }"#;
        let parsed = parse_gfx(gfx.to_vec(), "game:interface/x.gfx");
        assert_eq!(parsed.sprites[0].texture.as_deref(), Some("gfx/interface/a.dds"));
        assert_eq!(parsed.sprites[0].frames, 4);
        assert_eq!(parsed.sprites[1].border, Some((495, 495)));
        assert_eq!(parsed.sprites[1].size, Some((988, 1031)));
        assert!(!parsed.sprites[1].tiling_center);
        let (name, font) = &parsed.fonts[0];
        assert_eq!(name, "hoi_16mbs");
        assert_eq!(font.files, ["gfx/fonts/hoi_16mbs", "gfx/fonts/x"]);
        assert_eq!(font.colour, [255, 0, 0, 255]);
        assert_eq!(font.text_colours[&'Y'], [1, 2, 3]);
    }
}
