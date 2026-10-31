//! Script vocabulary generated from the installed game's `documentation/*.md`.
//!
//! The game writes `effects_documentation.md`, `triggers_documentation.md` and
//! `modifiers_documentation.md` from its own command tables. Each command is a `## name` heading;
//! effects and triggers follow it with `* Supported Scopes:` and `* Supported Targets:` lines. The
//! vocabulary is read at run time from the user's game, so no game text is stored in this
//! repository. Words the documentation omits (control flow and scope links) are listed in
//! [`crate::context`] with the reason each one is there.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Default, Serialize)]
pub struct Command {
    pub scopes: Vec<String>,
    pub targets: Vec<String>,
    /// The command runs its block for each matching object (`every_owned_state`, `any_country`),
    /// so the block holds commands, not arguments. Read from the documentation text: iterating
    /// effects describe a `limit`, iterating triggers describe what "meets the trigger".
    pub iterates: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DocKind {
    Effects,
    Triggers,
}

const ITERATOR_PREFIXES: &[&str] = &["every_", "random_", "global_every_", "any_", "all_"];

#[derive(Clone, Debug, Default, Serialize)]
pub struct SourceDoc {
    pub file: String,
    pub sha256: String,
    pub entries: usize,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Vocabulary {
    pub effects: BTreeMap<String, Command>,
    pub triggers: BTreeMap<String, Command>,
    /// Lower case, because the game matches modifier names without regard to case.
    pub modifiers: BTreeSet<String>,
    pub sources: Vec<SourceDoc>,
    pub game_version: Option<String>,
}

fn is_command_name(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Parses one documentation file into `name -> command`.
pub fn parse_commands(text: &str, kind: DocKind) -> BTreeMap<String, Command> {
    let mut out = BTreeMap::new();
    let mut current: Option<(String, Command)> = None;
    let finish = |name: String, mut command: Command, body: &str, out: &mut BTreeMap<String, Command>| {
        let body = body.to_ascii_lowercase();
        let marker = match kind {
            DocKind::Effects => "limit",
            DocKind::Triggers => "trigger",
        };
        command.iterates = ITERATOR_PREFIXES.iter().any(|p| name.starts_with(p)) && body.contains(marker);
        out.insert(name, command);
    };
    let mut body = String::new();
    for line in text.lines() {
        let line = line.trim_end();
        if let Some(heading) = line.strip_prefix("## ") {
            if let Some((name, command)) = current.take() {
                finish(name, command, &body, &mut out);
            }
            body.clear();
            let heading = heading.trim();
            if is_command_name(heading) {
                current = Some((heading.to_string(), Command::default()));
            }
            continue;
        }
        if let Some((_, command)) = current.as_mut() {
            body.push_str(line);
            body.push('\n');
            let parse_list = |rest: &str| rest.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect::<Vec<_>>();
            if let Some(rest) = line.strip_prefix("* Supported Scopes:") {
                command.scopes = parse_list(rest);
            } else if let Some(rest) = line.strip_prefix("* Supported Targets:") {
                command.targets = parse_list(rest);
            }
        }
    }
    if let Some((name, command)) = current {
        finish(name, command, &body, &mut out);
    }
    // Table-of-contents and scope headings never carry scope lines, and they are not identifiers
    // anyway ("Effects for scope COUNTRY"), so nothing else needs filtering.
    out
}

/// Modifier names. Plain entries are `## name` headings. Templated entries look like
/// `## <span id="_cost_factor"></span><IdeaGroup>_cost_factor` followed by
/// `* **Modified types**: a, b`, and expand to `a_cost_factor`, `b_cost_factor`.
pub fn parse_modifiers(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut suffix: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(heading) = line.strip_prefix("## ") {
            let heading = heading.trim();
            suffix = None;
            if is_command_name(heading) {
                out.insert(heading.to_ascii_lowercase());
            } else if let Some(rest) = heading.strip_prefix("<span id=\"")
                && let Some((id, _)) = rest.split_once('"')
            {
                suffix = Some(id.to_string());
            }
        } else if let Some(types) = line.strip_prefix("* **Modified types**:")
            && let Some(suffix) = &suffix
        {
            for t in types.split(',').map(str::trim).filter(|t| is_command_name(t)) {
                out.insert(format!("{t}{suffix}").to_ascii_lowercase());
            }
        }
    }
    out
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

impl Vocabulary {
    /// Reads the documentation of a game installation. Missing files leave that part empty, and
    /// [`Vocabulary::has_commands`] then reports false so checks stay `unknown` instead of passing.
    pub fn from_game(game: &Path) -> Vocabulary {
        let doc = game.join("documentation");
        let mut vocab = Vocabulary::default();
        for (name, slot) in [("effects_documentation.md", 0), ("triggers_documentation.md", 1), ("modifiers_documentation.md", 2)] {
            let Ok(bytes) = fs::read(doc.join(name)) else { continue };
            let text = String::from_utf8_lossy(&bytes);
            let entries = match slot {
                0 => {
                    vocab.effects = parse_commands(&text, DocKind::Effects);
                    vocab.effects.len()
                }
                1 => {
                    vocab.triggers = parse_commands(&text, DocKind::Triggers);
                    vocab.triggers.len()
                }
                _ => {
                    vocab.modifiers = parse_modifiers(&text);
                    vocab.modifiers.len()
                }
            };
            vocab.sources.push(SourceDoc { file: format!("documentation/{name}"), sha256: sha256_hex(&bytes), entries });
        }
        vocab.game_version = read_game_version(game);
        vocab
    }

    pub fn has_commands(&self) -> bool {
        !self.effects.is_empty() && !self.triggers.is_empty()
    }

    pub fn has_modifiers(&self) -> bool {
        !self.modifiers.is_empty()
    }
}

/// `rawVersion` from `launcher-settings.json`, without a JSON parser dependency on its layout.
pub fn read_game_version(game: &Path) -> Option<String> {
    let text = fs::read_to_string(game.join("launcher-settings.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("rawVersion").and_then(|v| v.as_str()).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EFFECTS: &str = "# Effects\n\n## Table of Content\n\n* [COUNTRY](#effects-for-scope-country)\n\n## Effects for scope COUNTRY\n\n* [add_political_power](#add_political_power)\n\n## add_political_power\n\n* Supported Scopes: COUNTRY\n* Supported Targets: none\n\n```\nadds political power\n```\n\n## every_owned_state\n\n* Supported Scopes: COUNTRY\n* Supported Targets: none\n\n### Example:\n```\nExecutes children effects on every owned state that fulfills the limit trigger.\n```\n";

    #[test]
    fn reads_command_headings_with_scopes() {
        let commands = parse_commands(EFFECTS, DocKind::Effects);
        assert_eq!(commands.keys().collect::<Vec<_>>(), ["add_political_power", "every_owned_state"]);
        assert_eq!(commands["add_political_power"].scopes, ["COUNTRY"]);
        assert_eq!(commands["add_political_power"].targets, ["none"]);
        assert!(commands["every_owned_state"].iterates);
        assert!(!commands["add_political_power"].iterates);
    }

    #[test]
    fn reads_modifier_headings() {
        let modifiers =
            parse_modifiers("# Modifiers\n\n## Table of Content\n\n## Modifiers for scope army\n\n* [a](#a)\n\n## army_org\n\n* Number\n\n## max_planning\n");
        assert_eq!(modifiers.into_iter().collect::<Vec<_>>(), ["army_org", "max_planning"]);
    }
}
