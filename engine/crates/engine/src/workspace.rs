//! Source layers and load order.
//!
//! The game loads the base game, then installed DLC folders in order of their internal ID, then
//! mods in load order. A later file with the same relative path replaces an earlier one, and a
//! mod's `replace_path` unloads every earlier-loaded file directly inside that folder (not in its
//! subfolders). Sources: the offline Paradox wiki's Modding page ("Loading files" and
//! "replace_path") and agent-tools ADR 0041 for the DLC layers.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use hoi4_syntax::{Document, Grammar, grammar_for};
use serde::Serialize;

/// Top-level folders the game indexes. Other folders in a mod (documentation, tools, `.git`)
/// are not game sources.
pub const CONTENT_FOLDERS: &[&str] =
    &["common", "events", "history", "interface", "localisation", "localization", "map", "gfx", "music", "sound", "portraits", "tutorial"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LayerKind {
    Game,
    Dlc,
    Dependency,
    Mod,
}

#[derive(Clone, Debug, Serialize)]
pub struct Layer {
    pub kind: LayerKind,
    pub name: String,
    pub path: PathBuf,
    pub replace_paths: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SourceFile {
    pub layer: usize,
    /// Path relative to the layer root, with forward slashes and the original case.
    pub relative: String,
    #[serde(skip)]
    pub absolute: PathBuf,
}

impl SourceFile {
    /// Load-order key: the game resolves paths without regard to case on Windows.
    pub fn key(&self) -> String {
        self.relative.to_ascii_lowercase()
    }

    pub fn folder(&self) -> &str {
        self.relative.rsplit_once('/').map_or("", |(dir, _)| dir)
    }

    pub fn file_name(&self) -> &str {
        self.relative.rsplit_once('/').map_or(self.relative.as_str(), |(_, name)| name)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Hidden {
    /// A later layer has a file at the same path.
    Overridden { by: usize },
    /// A later layer's `replace_path` unloads this file's folder.
    ReplacePath { by_layer: usize, path: String },
}

#[derive(Debug, Default, Serialize)]
pub struct Workspace {
    pub layers: Vec<Layer>,
    pub files: Vec<SourceFile>,
    /// For each file, why it is not loaded, or `None` when it is.
    pub hidden: Vec<Option<Hidden>>,
    /// Lower-case relative path to the loaded file.
    #[serde(skip)]
    pub effective: BTreeMap<String, usize>,
}

#[derive(Debug, Default, Clone)]
pub struct WorkspaceOptions {
    pub game: Option<PathBuf>,
    pub include_dlc: bool,
    pub dependencies: Vec<PathBuf>,
    /// The mod being checked. When absent, the game itself is the checked layer.
    pub target: Option<PathBuf>,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct Descriptor {
    pub name: Option<String>,
    pub replace_paths: Vec<String>,
    pub dependencies: Vec<String>,
    pub supported_version: Option<String>,
}

pub fn read_descriptor(root: &Path) -> Descriptor {
    let mut descriptor = Descriptor::default();
    let Ok(bytes) = fs::read(root.join("descriptor.mod")) else {
        return descriptor;
    };
    if bytes.len() > 64 * 1024 {
        return descriptor;
    }
    let doc = Document::parse(bytes);
    for entry in doc.root.entries() {
        let key = doc.key(entry).to_ascii_lowercase();
        match (key.as_str(), &entry.value) {
            ("name", hoi4_syntax::Value::Scalar(t)) => descriptor.name = Some(doc.text(*t).into_owned()),
            ("supported_version", hoi4_syntax::Value::Scalar(t)) => descriptor.supported_version = Some(doc.text(*t).into_owned()),
            ("replace_path", hoi4_syntax::Value::Scalar(t)) => {
                if let Some(path) = normalize_replace_path(&doc.text(*t)) {
                    descriptor.replace_paths.push(path);
                }
            }
            ("dependencies", hoi4_syntax::Value::Block(block)) => {
                for item in &block.items {
                    if let hoi4_syntax::Item::Value(hoi4_syntax::Value::Scalar(t)) = item {
                        descriptor.dependencies.push(doc.text(*t).into_owned());
                    }
                }
            }
            _ => {}
        }
    }
    descriptor
}

/// Accepts only plain relative folders, like agent-tools ADR 0041.
fn normalize_replace_path(raw: &str) -> Option<String> {
    let path = raw.trim().replace('\\', "/");
    let path = path.trim_matches('/');
    if path.is_empty() || path.contains("..") || path.contains('*') || path.contains(':') || raw.trim().starts_with('/') {
        return None;
    }
    Some(path.to_string())
}

/// Lists source files under a layer root, sorted by relative path. Symbolic links and folders
/// whose names start with a dot are skipped.
pub fn walk_sources(root: &Path, folders: Option<&[&str]>) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    match folders {
        Some(folders) => {
            for folder in folders {
                let dir = root.join(folder);
                if dir.is_dir() {
                    walk_dir(&dir, folder, &mut out);
                }
            }
        }
        None => walk_dir(root, "", &mut out),
    }
    out.retain(|(rel, _)| grammar_for(rel).is_some());
    out.sort();
    out
}

fn walk_dir(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        if file_type.is_dir() {
            walk_dir(&entry.path(), &rel, out);
        } else if file_type.is_file() {
            out.push((rel, entry.path()));
        }
    }
}

/// DLC folders under `dlc/` and `integrated_dlc/` that hold a `.dlc` descriptor, ordered by the
/// internal ID in the folder name and then by name.
pub fn dlc_roots(game: &Path) -> Vec<(String, PathBuf)> {
    let mut roots = Vec::new();
    for parent in ["dlc", "integrated_dlc"] {
        let Ok(entries) = fs::read_dir(game.join(parent)) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let has_descriptor =
                fs::read_dir(&path).map(|it| it.flatten().any(|f| f.path().extension().is_some_and(|e| e.eq_ignore_ascii_case("dlc")))).unwrap_or(false);
            if has_descriptor {
                roots.push((entry.file_name().to_string_lossy().into_owned(), path));
            }
        }
    }
    roots.sort_by_key(|(name, _)| (dlc_id(name), name.clone()));
    roots
}

fn dlc_id(name: &str) -> u32 {
    name.strip_prefix("dlc").map_or(u32::MAX, |rest| rest.chars().take_while(char::is_ascii_digit).collect::<String>().parse().unwrap_or(u32::MAX))
}

/// Names of installed DLCs, read from each `.dlc` descriptor's `name`.
pub fn dlc_names(game: &Path) -> Vec<String> {
    let mut names = Vec::new();
    for (_, root) in dlc_roots(game) {
        let Ok(entries) = fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("dlc"))
                && let Ok(bytes) = fs::read(&path)
            {
                let doc = Document::parse(bytes);
                for e in doc.root.entries() {
                    if doc.key(e) == "name"
                        && let Some(t) = e.value.as_scalar()
                    {
                        names.push(doc.text(t).into_owned());
                    }
                }
            }
        }
    }
    names.sort();
    names.dedup();
    names
}

impl Workspace {
    pub fn load(options: &WorkspaceOptions) -> Workspace {
        let mut ws = Workspace::default();
        if let Some(game) = &options.game {
            ws.layers.push(Layer { kind: LayerKind::Game, name: "game".into(), path: game.clone(), replace_paths: Vec::new() });
            if options.include_dlc {
                for (name, path) in dlc_roots(game) {
                    ws.layers.push(Layer { kind: LayerKind::Dlc, name, path, replace_paths: Vec::new() });
                }
            }
        }
        for dep in &options.dependencies {
            let descriptor = read_descriptor(dep);
            let name = descriptor.name.clone().unwrap_or_else(|| dep.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
            ws.layers.push(Layer { kind: LayerKind::Dependency, name, path: dep.clone(), replace_paths: descriptor.replace_paths });
        }
        if let Some(target) = &options.target {
            let descriptor = read_descriptor(target);
            let name = descriptor.name.clone().unwrap_or_else(|| target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
            ws.layers.push(Layer { kind: LayerKind::Mod, name, path: target.clone(), replace_paths: descriptor.replace_paths });
        }
        for (index, layer) in ws.layers.iter().enumerate() {
            for (relative, absolute) in walk_sources(&layer.path, Some(CONTENT_FOLDERS)) {
                ws.files.push(SourceFile { layer: index, relative, absolute });
            }
        }
        ws.resolve();
        ws
    }

    /// Builds a workspace from in-memory layer descriptions, for tests.
    pub fn from_layers(layers: Vec<Layer>) -> Workspace {
        let mut ws = Workspace { layers, ..Workspace::default() };
        for (index, layer) in ws.layers.iter().enumerate() {
            for (relative, absolute) in walk_sources(&layer.path, Some(CONTENT_FOLDERS)) {
                ws.files.push(SourceFile { layer: index, relative, absolute });
            }
        }
        ws.resolve();
        ws
    }

    fn resolve(&mut self) {
        self.hidden = vec![None; self.files.len()];
        self.effective.clear();
        for (index, file) in self.files.iter().enumerate() {
            let folder = file.folder().to_ascii_lowercase();
            let unloaded = self.layers.iter().enumerate().skip(file.layer + 1).find_map(|(layer_index, layer)| {
                layer.replace_paths.iter().find(|p| p.to_ascii_lowercase() == folder).map(|p| Hidden::ReplacePath { by_layer: layer_index, path: p.clone() })
            });
            if let Some(reason) = unloaded {
                self.hidden[index] = Some(reason);
                continue;
            }
            // Files are listed layer by layer, so a later layer replaces the earlier entry.
            if let Some(previous) = self.effective.insert(file.key(), index) {
                self.hidden[previous] = Some(Hidden::Overridden { by: index });
            }
        }
    }

    /// Index of the layer whose files are checked: the mod, or the game when no mod is given.
    pub fn target_layer(&self) -> Option<usize> {
        self.layers.iter().rposition(|l| l.kind == LayerKind::Mod).or_else(|| (!self.layers.is_empty()).then_some(0))
    }

    pub fn is_loaded(&self, file: usize) -> bool {
        self.hidden[file].is_none()
    }

    pub fn loaded_files(&self) -> impl Iterator<Item = (usize, &SourceFile)> {
        self.files.iter().enumerate().filter(|(i, _)| self.hidden[*i].is_none())
    }

    pub fn game_root(&self) -> Option<&Path> {
        self.layers.iter().find(|l| l.kind == LayerKind::Game).map(|l| l.path.as_path())
    }

    pub fn grammar(file: &SourceFile) -> Option<Grammar> {
        grammar_for(&file.relative)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replace_paths_are_plain_relative_folders() {
        assert_eq!(normalize_replace_path("common/ideas/").as_deref(), Some("common/ideas"));
        assert_eq!(normalize_replace_path("gfx\\loadingscreens").as_deref(), Some("gfx/loadingscreens"));
        assert_eq!(normalize_replace_path("../common"), None);
        assert_eq!(normalize_replace_path("/abs"), None);
        assert_eq!(normalize_replace_path("common/*"), None);
        assert_eq!(normalize_replace_path("  "), None);
    }

    #[test]
    fn dlc_ids_order_numerically() {
        let mut names = vec!["dlc100_x".to_string(), "dlc020_y".to_string(), "dlc3_z".to_string()];
        names.sort_by_key(|n| dlc_id(n));
        assert_eq!(names, ["dlc3_z", "dlc020_y", "dlc100_x"]);
    }
}
