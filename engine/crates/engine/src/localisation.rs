//! Localisation in every language, for `hoi4-engine localisation` and the MCP tool
//! `hoi4.localisation_inspect`. It reads every loaded localisation file of the game, DLC,
//! dependencies and mod, and only the mod's own script for the keys it uses, so it does not pay
//! for a whole-workspace analysis.
//!
//! Modes:
//! - `key`: one key's text in every language, each definition with its file, line and layer, the
//!   shipped languages that lack it, and the files that mention it.
//! - `audit`: keys the mod uses that no language defines, keys missing from a shipped language,
//!   the same key twice in one language, placeholders that differ between languages, and file
//!   problems (byte order mark, language header, file name against header).
//! - `coverage`: per shipped language, the mod's keys and those missing against the main language.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::PathBuf;

use hoi4_syntax::localisation::LocFile;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::index::Kind;
use crate::vocab::Vocabulary;
use crate::workspace::{LayerKind, Workspace, WorkspaceOptions};

const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 200;
const MAX_TEXT: usize = 600;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Request {
    pub game: Option<PathBuf>,
    #[serde(rename = "mod")]
    pub target: Option<PathBuf>,
    #[serde(default)]
    pub dependencies: Vec<PathBuf>,
    #[serde(default = "yes")]
    pub include_dlc: bool,
    pub mode: Mode,
    pub key: Option<String>,
    /// Restricts `audit` and `coverage` to one language.
    pub language: Option<String>,
    pub limit: Option<usize>,
}

fn severity(code: &str) -> &'static str {
    // Translators often write a name out instead of keeping `$key$` (vanilla German does), so a
    // dropped placeholder is information, not a problem players see.
    if matches!(code, "LOC_SCRIPTED_TEXT_LITERAL" | "LOC_PLACEHOLDER_MISSING") { "info" } else { "warning" }
}

fn yes() -> bool {
    true
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Key,
    Audit,
    Coverage,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Definition {
    pub language: String,
    pub text: String,
    pub path: String,
    pub line: u32,
    pub layer: String,
    pub layer_kind: &'static str,
    /// Under `localisation/replace/`, which overrides other definitions on purpose.
    pub replace: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mention {
    pub path: String,
    pub line: u32,
    pub layer: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub code: &'static str,
    /// `warning` for a problem players see, `info` for text the game shows as written on purpose.
    pub severity: &'static str,
    pub key: Option<String>,
    pub language: Option<String>,
    pub path: String,
    pub line: u32,
    pub message: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LanguageCoverage {
    pub language: String,
    pub files: usize,
    pub keys: usize,
    /// Keys of the main language this language lacks.
    pub missing: usize,
    /// Holds at least a quarter of the main language's keys.
    pub supported: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub mode: &'static str,
    /// Languages with at least one localisation file in the mod (the checked layer).
    pub shipped_languages: Vec<String>,
    /// Shipped languages with at least a quarter of the main language's keys. Only these are checked
    /// for missing keys; a language with a few files is listed in `coverage` only.
    pub supported_languages: Vec<String>,
    /// The language the others are compared with: English when shipped, else the one with most keys.
    pub main_language: Option<String>,
    pub files_read: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<KeyAnswer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audit: Option<Audit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coverage: Option<Vec<LanguageCoverage>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyAnswer {
    pub key: String,
    pub found: bool,
    /// Definitions in load order, game first and the mod last.
    pub definitions: Vec<Definition>,
    pub missing_languages: Vec<String>,
    pub mentions: Vec<Mention>,
    pub mentions_truncated: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub suggestions: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Audit {
    /// Problem counts by code, over the whole mod.
    pub counts: BTreeMap<&'static str, usize>,
    /// Up to `limit` examples of each code.
    pub problems: Vec<Problem>,
    /// Some code has more problems than its examples show.
    pub truncated: bool,
}

/// Counts every problem and keeps up to `limit` examples of each code, so one noisy code cannot
/// hide the others and millions of findings are never built.
struct Sink {
    limit: usize,
    counts: BTreeMap<&'static str, usize>,
    samples: BTreeMap<&'static str, Vec<Problem>>,
}

impl Sink {
    fn add(&mut self, code: &'static str, build: impl FnOnce() -> Problem) {
        let count = self.counts.entry(code).or_insert(0);
        *count += 1;
        if *count <= self.limit {
            self.samples.entry(code).or_default().push(build());
        }
    }

    fn finish(self) -> Audit {
        let truncated = self.counts.values().any(|&c| c > self.limit);
        Audit { counts: self.counts, problems: self.samples.into_values().flatten().collect(), truncated }
    }
}

struct Entry {
    key: String,
    language: String,
    text: String,
    file: usize,
    line: u32,
}

struct LoadedFile {
    file: usize,
    language: Option<String>,
    diagnostics: Vec<(&'static str, String, u32)>,
}

fn layer_kind(kind: LayerKind) -> &'static str {
    match kind {
        LayerKind::Game => "game",
        LayerKind::Dlc => "dlc",
        LayerKind::Dependency => "dependency",
        LayerKind::Mod => "mod",
    }
}

fn is_localisation(relative: &str) -> bool {
    let path = relative.to_ascii_lowercase();
    (path.starts_with("localisation/") || path.starts_with("localization/"))
        && (path.ends_with(".yml") || path.ends_with(".yaml"))
        // The game's list of language names, one header per language, not text keys.
        && !path.ends_with("/languages.yml")
}

fn is_replace(relative: &str) -> bool {
    relative.to_ascii_lowercase().replace('\\', "/").contains("/replace/")
}

/// The language a file name claims (`foo_l_english.yml`, `Foo l_english.yml`).
fn file_name_language(relative: &str) -> Option<String> {
    let name = relative.rsplit('/').next()?.to_ascii_lowercase();
    let stem = name.strip_suffix(".yml").or_else(|| name.strip_suffix(".yaml"))?;
    let at = stem.rfind("l_")?;
    (at == 0 || matches!(stem.as_bytes()[at - 1], b'_' | b' ' | b'-' | b'.')).then(|| stem[at + 2..].to_owned())
}

fn line_of(bytes: &[u8], offset: u32) -> u32 {
    1 + bytes[..(offset as usize).min(bytes.len())].iter().filter(|&&b| b == b'\n').count() as u32
}

/// `$name$` tokens, which every translation of a key must keep. `[Scope.GetX]` is left out:
/// translators pick other getters for their grammar (vanilla French uses `GetDuDelaDelNP`).
fn placeholders(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let close = (bytes[i] == b'$').then_some(b'$');
        if let Some(close) = close
            && let Some(len) = bytes[i + 1..].iter().position(|&b| b == close)
        {
            let token = &text[i..i + len + 2];
            // `$$` is a literal dollar sign, not a placeholder.
            if len > 0 {
                out.insert(token.to_owned());
            }
            i += len + 2;
            continue;
        }
        i += 1;
    }
    out
}

pub fn respond_json(text: &str) -> (String, u8) {
    let request: Request = match serde_json::from_str(text) {
        Ok(r) => r,
        Err(e) => return (error("LOCALISATION_INVALID_REQUEST", &e.to_string()), 2),
    };
    match respond(&request) {
        Ok(response) => (serde_json::to_string(&response).unwrap_or_else(|e| error("LOCALISATION_INTERNAL", &e.to_string())), 0),
        Err((code, message)) => (error(code, &message), 2),
    }
}

fn error(code: &str, message: &str) -> String {
    serde_json::json!({ "error": { "code": code, "message": message } }).to_string()
}

pub fn respond(request: &Request) -> Result<Response, (&'static str, String)> {
    if request.mode == Mode::Key && request.key.as_deref().is_none_or(str::is_empty) {
        return Err(("LOCALISATION_KEY_REQUIRED", "mode key needs a key".into()));
    }
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let workspace = Workspace::load(&WorkspaceOptions {
        game: request.game.clone(),
        include_dlc: request.include_dlc,
        dependencies: request.dependencies.clone(),
        target: request.target.clone(),
    });
    let target = workspace.target_layer();
    let loc_files: Vec<usize> = workspace.loaded_files().filter(|(_, f)| is_localisation(&f.relative)).map(|(i, _)| i).collect();
    let parsed: Vec<(LoadedFile, Vec<Entry>)> = loc_files
        .par_iter()
        .filter_map(|&file| {
            let bytes = fs::read(&workspace.files[file].absolute).ok()?;
            let loc = LocFile::parse(bytes);
            let language = loc.language.clone().map(|l| l.to_ascii_lowercase());
            let entries = loc
                .entries
                .iter()
                .map(|e| Entry {
                    key: e.key.clone(),
                    language: language.clone().unwrap_or_default(),
                    text: String::from_utf8_lossy(&loc.bytes[e.value_range.start as usize..e.value_range.end as usize]).into_owned(),
                    file,
                    line: e.line,
                })
                .collect();
            // Mods blank a vanilla file by shipping it empty; a file with no entries needs no header.
            let empty = loc.entries.is_empty();
            let diagnostics = loc
                .diagnostics
                .iter()
                .filter(|d| !(empty && d.code == "LOC_MISSING_LANGUAGE_HEADER"))
                .map(|d| (d.code, d.message.clone(), line_of(&loc.bytes, d.start)))
                .collect();
            Some((LoadedFile { file, language, diagnostics }, entries))
        })
        .collect();

    let in_target = |file: usize| Some(workspace.files[file].layer) == target;
    let mut by_key: BTreeMap<&str, Vec<&Entry>> = BTreeMap::new();
    for (_, entries) in &parsed {
        for entry in entries {
            by_key.entry(entry.key.as_str()).or_default().push(entry);
        }
    }
    for defs in by_key.values_mut() {
        defs.sort_by_key(|e| (workspace.files[e.file].layer, e.file, e.line));
    }

    // The mod's languages; a mod with no localisation of its own uses those of the layers below.
    let count_languages = |only_target: bool| {
        let mut shipped: BTreeMap<String, (usize, usize)> = BTreeMap::new();
        for (file, entries) in &parsed {
            if only_target && !in_target(file.file) {
                continue;
            }
            if let Some(language) = &file.language {
                let slot = shipped.entry(language.clone()).or_default();
                slot.0 += 1;
                slot.1 += entries.len();
            }
        }
        shipped
    };
    let mut shipped = count_languages(true);
    if shipped.is_empty() {
        shipped = count_languages(false);
    }
    let main_language =
        if shipped.contains_key("english") { Some("english".to_owned()) } else { shipped.iter().max_by_key(|(_, (_, keys))| *keys).map(|(l, _)| l.clone()) };
    let shipped_languages: Vec<String> = shipped.keys().cloned().collect();
    let main_keys_count = main_language.as_ref().and_then(|m| shipped.get(m)).map_or(0, |(_, keys)| *keys);
    let supported_languages: Vec<String> = shipped.iter().filter(|(_, (_, keys))| *keys * 4 >= main_keys_count).map(|(l, _)| l.clone()).collect();
    let definition = |e: &Entry| {
        let source = &workspace.files[e.file];
        let layer = &workspace.layers[source.layer];
        Definition {
            language: e.language.clone(),
            text: e.text.chars().take(MAX_TEXT).collect(),
            path: source.relative.clone(),
            line: e.line,
            layer: layer.name.clone(),
            layer_kind: layer_kind(layer.kind),
            replace: is_replace(&source.relative),
        }
    };

    let mut response = Response {
        mode: match request.mode {
            Mode::Key => "key",
            Mode::Audit => "audit",
            Mode::Coverage => "coverage",
        },
        shipped_languages: shipped_languages.clone(),
        supported_languages: supported_languages.clone(),
        main_language: main_language.clone(),
        files_read: parsed.len(),
        key: None,
        audit: None,
        coverage: None,
    };

    match request.mode {
        Mode::Key => {
            let key = request.key.as_deref().unwrap_or_default();
            let defs = by_key.get(key).cloned().unwrap_or_default();
            let languages: BTreeSet<&str> = defs.iter().map(|e| e.language.as_str()).collect();
            let (mentions, mentions_truncated) = mentions(&workspace, key, limit);
            let suggestions = if defs.is_empty() { suggest(key, by_key.keys().copied()) } else { Vec::new() };
            response.key = Some(KeyAnswer {
                key: key.to_owned(),
                found: !defs.is_empty(),
                definitions: defs.iter().map(|e| definition(e)).collect(),
                // As in the audit, only a key of the main language can be missing elsewhere.
                missing_languages: if main_language.as_deref().is_some_and(|m| languages.contains(m)) {
                    supported_languages.iter().filter(|l| !languages.contains(l.as_str())).cloned().collect()
                } else {
                    Vec::new()
                },
                mentions,
                mentions_truncated,
                suggestions,
            });
        }
        Mode::Coverage => {
            let main_keys: HashSet<&str> = main_language
                .as_deref()
                .map(|main| parsed.iter().flat_map(|(_, es)| es).filter(|e| in_target(e.file) && e.language == main).map(|e| e.key.as_str()).collect())
                .unwrap_or_default();
            let mut out = Vec::new();
            for (language, (files, _)) in &shipped {
                if request.language.as_deref().is_some_and(|l| !l.eq_ignore_ascii_case(language)) {
                    continue;
                }
                let keys: HashSet<&str> = by_key.iter().filter(|(_, defs)| defs.iter().any(|e| &e.language == language)).map(|(k, _)| *k).collect();
                let mine = parsed
                    .iter()
                    .flat_map(|(_, es)| es)
                    .filter(|e| in_target(e.file) && &e.language == language)
                    .map(|e| e.key.as_str())
                    .collect::<HashSet<_>>();
                out.push(LanguageCoverage {
                    language: language.clone(),
                    files: *files,
                    keys: mine.len(),
                    missing: main_keys.iter().filter(|k| !keys.contains(*k)).count(),
                    supported: supported_languages.contains(language),
                });
            }
            response.coverage = Some(out);
        }
        Mode::Audit => {
            let mut sink = Sink { limit, counts: BTreeMap::new(), samples: BTreeMap::new() };
            // Keys the mod's script and interface files use that no language defines.
            let vocab = workspace.game_root().map(Vocabulary::from_game).unwrap_or_default();
            let unloaded = HashSet::new();
            let used: Vec<(usize, String, u32)> = workspace
                .loaded_files()
                .filter(|(i, f)| in_target(*i) && !is_localisation(&f.relative))
                .map(|(i, _)| i)
                .collect::<Vec<_>>()
                .par_iter()
                .flat_map_iter(|&file| {
                    let parsed = crate::analysis::parse_file(&workspace, &vocab, file, target, &unloaded);
                    let references = parsed.facts.map(|f| f.references).unwrap_or_default();
                    let line_starts = parsed.line_starts;
                    references
                        .into_iter()
                        .filter(|r| r.kind == Kind::LocalisationKey)
                        .map(move |r| {
                            let line = 1 + line_starts.partition_point(|&s| s <= r.start).saturating_sub(1) as u32;
                            (file, r.name, line)
                        })
                        .collect::<Vec<_>>()
                })
                .collect();
            let mut reported = HashSet::new();
            for (file, name, line) in &used {
                if by_key.contains_key(name.as_str()) || !reported.insert(name.clone()) {
                    continue;
                }
                // Scripted localisation often shows text as written on purpose (`localization_key =
                // "Planes"`, setting names in an export), so there it is information.
                let scripted = workspace.files[*file].relative.to_ascii_lowercase().starts_with("common/scripted_localisation/");
                let code = if scripted || name.contains(' ') { "LOC_SCRIPTED_TEXT_LITERAL" } else { "LOC_KEY_UNDEFINED" };
                sink.add(code, || Problem {
                    code,
                    severity: severity(code),
                    key: Some(name.clone()),
                    language: None,
                    path: workspace.files[*file].relative.clone(),
                    line: *line,
                    message: if code == "LOC_KEY_UNDEFINED" {
                        format!("`{name}` is used here but no language defines it, so the game shows the raw key")
                    } else {
                        format!("no language defines `{name}`, so the game shows it as written")
                    },
                });
            }
            for (key, defs) in &by_key {
                let mine: Vec<&&Entry> = defs.iter().filter(|e| in_target(e.file)).collect();
                if mine.is_empty() {
                    continue;
                }
                // Missing from a supported language. Only keys of the main language count: a
                // language may add its own grammar keys (vanilla RU_LOCKEYS_l_russian.yml).
                let languages: BTreeSet<&str> = defs.iter().map(|e| e.language.as_str()).collect();
                let in_main = main_language.as_deref().is_some_and(|main| mine.iter().any(|e| e.language == main));
                for language in supported_languages.iter().filter(|_| in_main) {
                    if languages.contains(language.as_str()) || request.language.as_deref().is_some_and(|l| !l.eq_ignore_ascii_case(language)) {
                        continue;
                    }
                    let first = mine[0];
                    sink.add("LOC_KEY_MISSING_LANGUAGE", || Problem {
                        code: "LOC_KEY_MISSING_LANGUAGE",
                        severity: severity("LOC_KEY_MISSING_LANGUAGE"),
                        key: Some((*key).to_owned()),
                        language: Some(language.clone()),
                        path: workspace.files[first.file].relative.clone(),
                        line: first.line,
                        message: format!("`{key}` has no {language} text, so {language} players see the raw key"),
                    });
                }
                // The same key twice in one language of the mod, outside replace folders.
                let mut seen: BTreeMap<&str, &Entry> = BTreeMap::new();
                for e in mine.iter().filter(|e| !is_replace(&workspace.files[e.file].relative)) {
                    if let Some(first) = seen.get(e.language.as_str()) {
                        sink.add("LOC_KEY_DUPLICATE", || Problem {
                            code: "LOC_KEY_DUPLICATE",
                            severity: severity("LOC_KEY_DUPLICATE"),
                            key: Some((*key).to_owned()),
                            language: Some(e.language.clone()),
                            path: workspace.files[e.file].relative.clone(),
                            line: e.line,
                            message: format!(
                                "`{key}` is defined again in {}; the first definition is in {} line {}",
                                e.language, workspace.files[first.file].relative, first.line
                            ),
                        });
                    } else {
                        seen.insert(e.language.as_str(), e);
                    }
                }
                // Placeholders that differ from the main language's text.
                if let Some(main) = main_language.as_deref()
                    && let Some(reference) = mine.iter().find(|e| e.language == main)
                {
                    let expected = placeholders(&reference.text);
                    for e in mine.iter().filter(|e| e.language != main) {
                        if request.language.as_deref().is_some_and(|l| !l.eq_ignore_ascii_case(&e.language)) {
                            continue;
                        }
                        // A placeholder the main language has and this translation dropped. An
                        // added one is a translator's choice.
                        let found = placeholders(&e.text);
                        let lost: Vec<_> = expected.difference(&found).cloned().collect();
                        if !lost.is_empty() {
                            sink.add("LOC_PLACEHOLDER_MISSING", || Problem {
                                code: "LOC_PLACEHOLDER_MISSING",
                                severity: severity("LOC_PLACEHOLDER_MISSING"),
                                key: Some((*key).to_owned()),
                                language: Some(e.language.clone()),
                                path: workspace.files[e.file].relative.clone(),
                                line: e.line,
                                message: format!("`{key}` in {} lacks {}, which the {main} text uses", e.language, lost.join(" ")),
                            });
                        }
                    }
                }
            }
            for (file, _) in parsed.iter().filter(|(f, _)| in_target(f.file)) {
                let relative = &workspace.files[file.file].relative;
                // The parser reports a missing byte order mark (LOC_MISSING_BOM) with the rest.
                if let (Some(named), Some(header)) = (file_name_language(relative), &file.language)
                    && &named != header
                {
                    sink.add("LOC_FILE_LANGUAGE_MISMATCH", || Problem {
                        code: "LOC_FILE_LANGUAGE_MISMATCH",
                        severity: severity("LOC_FILE_LANGUAGE_MISMATCH"),
                        key: None,
                        language: Some(header.clone()),
                        path: relative.clone(),
                        line: 1,
                        message: format!("the file name says l_{named} but the header says l_{header}"),
                    });
                }
                for (code, message, line) in &file.diagnostics {
                    sink.add(code, || Problem {
                        code,
                        severity: severity(code),
                        key: None,
                        language: file.language.clone(),
                        path: relative.clone(),
                        line: *line,
                        message: message.clone(),
                    });
                }
            }
            response.audit = Some(sink.finish());
        }
    }
    Ok(response)
}

/// Files of every loaded layer that contain the key as a whole token, outside localisation.
fn mentions(workspace: &Workspace, key: &str, limit: usize) -> (Vec<Mention>, bool) {
    let needle = key.as_bytes();
    let token_byte = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-' | b'\'');
    let files: Vec<usize> = workspace
        .loaded_files()
        .filter(|(_, f)| {
            let p = f.relative.to_ascii_lowercase();
            !is_localisation(&p) && (p.ends_with(".txt") || p.ends_with(".gui") || p.ends_with(".gfx"))
        })
        .map(|(i, _)| i)
        .collect();
    let mut found: Vec<(usize, u32)> = files
        .par_iter()
        .flat_map_iter(|&file| {
            let mut out = Vec::new();
            if let Ok(bytes) = fs::read(&workspace.files[file].absolute) {
                for start in memchr::memmem::find_iter(&bytes, needle) {
                    let end = start + needle.len();
                    if (start == 0 || !token_byte(bytes[start - 1])) && (end == bytes.len() || !token_byte(bytes[end])) {
                        out.push((file, line_of(&bytes, start as u32)));
                    }
                }
            }
            out
        })
        .collect();
    found.sort_by_key(|&(file, line)| (workspace.files[file].layer, file, line));
    let truncated = found.len() > limit;
    found.truncate(limit);
    let mentions = found
        .into_iter()
        .map(|(file, line)| Mention { path: workspace.files[file].relative.clone(), line, layer: workspace.layers[workspace.files[file].layer].name.clone() })
        .collect();
    (mentions, truncated)
}

/// Keys that differ only in case, or by at most two edits, for a not-found key.
fn suggest<'a>(key: &str, keys: impl Iterator<Item = &'a str>) -> Vec<String> {
    let lower = key.to_ascii_lowercase();
    let wanted: Vec<char> = lower.chars().collect();
    // Hundreds of thousands of keys: compare only those of a similar length that start alike.
    let first = lower.as_bytes().first().copied();
    let mut close: Vec<(usize, &str)> = keys
        .filter(|k| k.len().abs_diff(key.len()) <= 2 && k.as_bytes().first().map(u8::to_ascii_lowercase) == first)
        .filter_map(|k| {
            let d = crate::index::levenshtein(&k.to_ascii_lowercase().chars().collect::<Vec<_>>(), &wanted);
            (d <= 2).then_some((d, k))
        })
        .collect();
    close.sort();
    close.into_iter().take(3).map(|(_, k)| k.to_owned()).collect()
}
