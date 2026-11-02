//! Game-like previews for the shared Hearts of Iron IV engine: renders of interface screens drawn
//! from the game's own sprites, textures, bitmap fonts and `.gui` layouts, loaded the way the game
//! loads them (game, DLC, dependencies, mod). The first screen is the national focus view.
//!
//! A [`Preview`] keeps one [`Assets`] cache per workspace for the life of the resident engine
//! (`hoi4-engine serve`): parsed `.gfx` files, folder listings, decoded textures and fonts. Each
//! render refreshes only what changed on disk, so a repeat render costs the drawing alone.
//! Renders are tool evidence, never game screenshots.

pub mod assets;
pub mod canvas;
pub mod focus;
pub mod font;
pub mod gui;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

pub use assets::{Assets, CacheStats, LayerRoot};

/// Workspaces kept at once; the least recently used one is dropped beyond this. There is no
/// time-based eviction.
pub const MAX_WORKSPACES: usize = 8;

/// A cached workspace and the tick it was last used at.
type Cached = (Arc<RwLock<Assets>>, u64);

#[derive(Default)]
pub struct Preview {
    workspaces: Mutex<HashMap<Vec<LayerRoot>, Cached>>,
    clock: Mutex<u64>,
}

/// How long the parts of a call took, in milliseconds, and whether the cache was warm.
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timings {
    pub assets_ms: f64,
    pub render_ms: f64,
    pub encode_ms: f64,
    pub warm: bool,
}

fn ms(since: Instant) -> f64 {
    (since.elapsed().as_secs_f64() * 1000.0 * 10.0).round() / 10.0
}

impl Preview {
    pub fn new() -> Self {
        Preview::default()
    }

    /// The asset cache for these layers, refreshed against the disk. `bool` is true when the
    /// cache already existed.
    pub fn assets(&self, layers: Vec<LayerRoot>) -> (Arc<RwLock<Assets>>, bool) {
        let tick = {
            let mut clock = self.clock.lock().unwrap_or_else(|e| e.into_inner());
            *clock += 1;
            *clock
        };
        let existing = {
            let mut workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
            workspaces.get_mut(&layers).map(|(assets, used)| {
                *used = tick;
                Arc::clone(assets)
            })
        };
        if let Some(assets) = existing {
            assets.write().unwrap_or_else(|e| e.into_inner()).refresh();
            return (assets, true);
        }
        let assets = Arc::new(RwLock::new(Assets::new(layers.clone())));
        let mut workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
        if workspaces.len() >= MAX_WORKSPACES
            && let Some(oldest) = workspaces.iter().min_by_key(|(_, (_, used))| *used).map(|(k, _)| k.clone())
        {
            workspaces.remove(&oldest);
        }
        workspaces.insert(layers, (Arc::clone(&assets), tick));
        (assets, false)
    }

    /// Renders a focus tree and encodes it as PNG.
    pub fn focus_png(
        &self,
        layers: Vec<LayerRoot>,
        request: &focus::FocusRenderRequest,
    ) -> Result<(Vec<u8>, focus::FocusRenderReport, CacheStats, Timings), String> {
        let started = Instant::now();
        let (assets, warm) = self.assets(layers);
        let assets_ms = ms(started);
        let assets = assets.read().unwrap_or_else(|e| e.into_inner());
        let drawing = Instant::now();
        let rendered = focus::render(&assets, request)?;
        let render_ms = ms(drawing);
        let encoding = Instant::now();
        let png = hoi4_texture::pngio::encode(&rendered.image, true);
        let encode_ms = ms(encoding);
        let mut stats = assets.stats;
        stats.textures_cached = assets.cached_textures();
        Ok((png, rendered.report, stats, Timings { assets_ms, render_ms, encode_ms, warm }))
    }
}

/// The layers of a workspace in load order: the game, its DLC folders (when `include_dlc`), the
/// dependencies in order and the mod, each with the `replace_path` folders of its descriptor.
pub fn layers_for(game: Option<&std::path::Path>, include_dlc: bool, dependencies: &[std::path::PathBuf], target: Option<&std::path::Path>) -> Vec<LayerRoot> {
    let options = hoi4_engine::WorkspaceOptions {
        game: game.map(std::path::Path::to_path_buf),
        include_dlc,
        dependencies: dependencies.to_vec(),
        target: target.map(std::path::Path::to_path_buf),
    };
    let mut layers = Vec::new();
    if let Some(game) = &options.game {
        layers.push(LayerRoot { name: "game".into(), path: game.clone(), replace_paths: Vec::new() });
        if include_dlc {
            for (name, path) in hoi4_engine::workspace::dlc_roots(game) {
                layers.push(LayerRoot { name, path, replace_paths: Vec::new() });
            }
        }
    }
    for root in options.dependencies.iter().chain(options.target.iter()) {
        let descriptor = hoi4_engine::workspace::read_descriptor(root);
        layers.push(LayerRoot {
            name: descriptor.name.unwrap_or_else(|| root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()),
            path: root.clone(),
            replace_paths: descriptor.replace_paths.iter().map(|p| p.to_ascii_lowercase()).collect(),
        });
    }
    layers
}
