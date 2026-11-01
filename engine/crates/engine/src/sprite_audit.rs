//! Sprite findings: a sprite or texture consumed by two families, missing textures, undefined
//! sprites and focus sprites without a shine companion, plus the report that bundles the index
//! summary, the traced uses and the findings.
//!
//! | Code                    | Severity | Meaning                                                                                   |
//! | ----------------------- | -------- | ----------------------------------------------------------------------------------------- |
//! | `GFX-FAMILY-REUSE`      | warning  | A sprite name, or a resolved texture, is used by two or more different families            |
//! | `GFX-TEXTURE-MISSING`   | warning  | A sprite's `texturefile` (or a texture path a script names) resolves to no file            |
//! | `GFX-SPRITE-UNDEFINED`  | warning  | A script names a sprite that no loaded `.gfx` file defines                                 |
//! | `GFX-FOCUS-SHINE-MISSING` | error  | A focus sprite has no `<name>_shine` sprite (the game then draws a ? for the icon)        |
//!
//! An allowlist (JSON, see [`Allowlist`]) records intentional aliases.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::Path;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::findings::{Finding, Severity, finalize};
use crate::sprite_trace::{Family, SpriteUse, TraceOptions, trace};
use crate::sprites::SpriteIndex;
use crate::workspace::Workspace;

/// One intentional alias: this sprite or texture may be used by more than one family.
///
/// ```json
/// { "aliases": [
///     { "sprite": "GFX_idea_shared", "families": ["idea_spirit", "decision"], "reason": "same art on purpose" },
///     { "texture": "gfx/interface/shared.dds" }
/// ] }
/// ```
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Alias {
    /// Sprite name, compared without case.
    #[serde(default)]
    pub sprite: Option<String>,
    /// Texture path, compared without case and slash style.
    #[serde(default)]
    pub texture: Option<String>,
    /// The families the alias allows. Absent: any combination.
    #[serde(default)]
    pub families: Option<Vec<String>>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// The per-mod allowlist.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Allowlist {
    /// Intentional cross-family reuse.
    #[serde(default)]
    pub aliases: Vec<Alias>,
    /// Focus sprites that intentionally have no `_shine` companion (sprite names).
    #[serde(default)]
    pub no_shine: Vec<String>,
    /// Sprites or texture paths that are intentionally missing.
    #[serde(default)]
    pub missing_textures: Vec<String>,
}

impl Allowlist {
    /// Parses allowlist JSON. Unknown family ids and entries without a sprite or texture are errors.
    pub fn parse(text: &str) -> Result<Allowlist, String> {
        let list: Allowlist = serde_json::from_str(text).map_err(|e| format!("allowlist is not valid: {e}"))?;
        for (n, alias) in list.aliases.iter().enumerate() {
            if alias.sprite.is_none() && alias.texture.is_none() {
                return Err(format!("allowlist alias {n} needs a sprite or a texture"));
            }
            for family in alias.families.iter().flatten() {
                if Family::parse(family).is_none() {
                    return Err(format!("allowlist alias {n}: unknown family `{family}`"));
                }
            }
        }
        Ok(list)
    }

    /// Reads and parses an allowlist file.
    pub fn load(path: &Path) -> Result<Allowlist, String> {
        let text = fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        Allowlist::parse(text.strip_prefix('\u{feff}').unwrap_or(&text))
    }

    fn allows_reuse(&self, sprite: Option<&str>, texture: Option<&str>, families: &BTreeSet<Family>) -> bool {
        self.aliases.iter().any(|a| {
            let target = match (&a.sprite, &a.texture, sprite, texture) {
                (Some(s), _, Some(name), _) => s.eq_ignore_ascii_case(name),
                (_, Some(t), _, Some(path)) => crate::sprites::texture_key(t) == crate::sprites::texture_key(path),
                _ => false,
            };
            target && a.families.as_ref().is_none_or(|list| families.iter().all(|f| list.iter().any(|l| l == f.as_str())))
        })
    }

    fn allows_missing(&self, sprite: Option<&str>, texture: &str) -> bool {
        let key = crate::sprites::texture_key(texture);
        self.missing_textures.iter().any(|m| sprite.is_some_and(|s| m.eq_ignore_ascii_case(s)) || crate::sprites::texture_key(m) == key)
    }

    fn allows_no_shine(&self, sprite: &str) -> bool {
        self.no_shine.iter().any(|s| s.eq_ignore_ascii_case(sprite))
    }
}

fn at(f: &mut Finding, u: &SpriteUse) {
    f.path = u.path.clone();
    f.layer = u.layer.clone();
    f.line = u.line;
    f.column = u.column;
    f.start = u.start;
    f.end = u.end;
    f.context = u.subject.clone();
}

fn describe(u: &SpriteUse) -> String {
    format!(
        "{} {}:{}{} ({}{})",
        u.family.as_str(),
        u.path,
        u.line,
        u.subject.as_ref().map(|s| format!(" {s}")).unwrap_or_default(),
        u.content_type,
        if u.implicit { ", implicit" } else { "" }
    )
}

/// Findings for the traced uses and the sprites of the checked layer.
pub fn audit(ws: &Workspace, index: &SpriteIndex, uses: &[SpriteUse], allow: &Allowlist, options: &TraceOptions) -> Vec<Finding> {
    let mut findings = Vec::new();
    let target = ws.target_layer();

    // Reuse by sprite name.
    let mut by_sprite: BTreeMap<String, Vec<&SpriteUse>> = BTreeMap::new();
    let mut by_texture: BTreeMap<String, Vec<&SpriteUse>> = BTreeMap::new();
    for u in uses {
        if !u.sprite.is_empty() {
            by_sprite.entry(u.sprite.to_ascii_lowercase()).or_default().push(u);
        }
        if let Some(t) = &u.texture {
            by_texture.entry(crate::sprites::texture_key(&t.path)).or_default().push(u);
        }
    }
    let families_of = |list: &[&SpriteUse]| -> BTreeSet<Family> { list.iter().map(|u| u.family).filter(|f| *f != Family::Unknown).collect() };
    for list in by_sprite.values() {
        let families = families_of(list);
        if families.len() < 2 {
            continue;
        }
        let name = &list[0].sprite;
        if allow.allows_reuse(Some(name), None, &families) {
            continue;
        }
        let names: Vec<&str> = families.iter().map(|f| f.as_str()).collect();
        let mut f = Finding::new(
            "GFX-FAMILY-REUSE",
            Severity::Warning,
            format!(
                "sprite {name} is used by {} families ({}): {}",
                families.len(),
                names.join(", "),
                list.iter().map(|u| describe(u)).collect::<Vec<_>>().join("; ")
            ),
        );
        at(&mut f, list[0]);
        f.subject = Some(name.clone());
        findings.push(f);
    }
    for (key, list) in &by_texture {
        let families = families_of(list);
        let sprites: BTreeSet<String> = list.iter().map(|u| u.sprite.to_ascii_lowercase()).collect();
        if families.len() < 2 || sprites.len() < 2 {
            continue;
        }
        if allow.allows_reuse(None, Some(key), &families) {
            continue;
        }
        let names: Vec<&str> = families.iter().map(|f| f.as_str()).collect();
        let mut f = Finding::new(
            "GFX-FAMILY-REUSE",
            Severity::Warning,
            format!(
                "texture {key} is used through {} sprites by {} families ({}): {}",
                sprites.len(),
                families.len(),
                names.join(", "),
                list.iter()
                    .map(|u| format!("{} via {}", describe(u), if u.sprite.is_empty() { "a texture path" } else { &u.sprite }))
                    .collect::<Vec<_>>()
                    .join("; ")
            ),
        );
        at(&mut f, list[0]);
        f.subject = Some(key.clone());
        findings.push(f);
    }

    // Missing textures of the checked layer's sprites.
    for def in index.effective() {
        let ours = options.all_layers || ws.layers.iter().position(|l| l.name == def.layer) == target;
        if !ours {
            continue;
        }
        let (Some(file), Some(texture)) = (&def.texturefile, index.texture_of(def)) else { continue };
        if texture.exists || allow.allows_missing(Some(&def.name), file) {
            continue;
        }
        let mut f = Finding::new("GFX-TEXTURE-MISSING", Severity::Warning, format!("sprite {} points at {file}, which no layer provides", def.name));
        f.path = def.path.clone();
        f.layer = def.layer.clone();
        f.line = def.line;
        f.column = def.column;
        f.start = def.start;
        f.end = def.end;
        f.subject = Some(def.name.clone());
        f.context = Some(format!("sprite:{}", def.name));
        findings.push(f);
    }
    for u in uses.iter().filter(|u| u.direct_texture) {
        let Some(t) = &u.texture else { continue };
        if t.exists || allow.allows_missing(None, &t.path) {
            continue;
        }
        let mut f = Finding::new("GFX-TEXTURE-MISSING", Severity::Warning, format!("{} names the texture {}, which no layer provides", u.slot, t.path));
        at(&mut f, u);
        f.subject = Some(t.path.clone());
        findings.push(f);
    }

    // Sprites a script names that nothing defines.
    for u in uses.iter().filter(|u| !u.defined && !u.dynamic && !u.direct_texture) {
        if allow.allows_missing(Some(&u.sprite), "") {
            continue;
        }
        let mut f = Finding::new(
            "GFX-SPRITE-UNDEFINED",
            Severity::Warning,
            format!("{} {} uses sprite {}, which no loaded .gfx file defines", u.family.as_str(), u.slot, u.sprite),
        );
        at(&mut f, u);
        f.subject = Some(u.sprite.clone());
        findings.push(f);
    }

    // Focus sprites without a shine companion.
    let mut seen: HashMap<String, ()> = HashMap::new();
    for u in uses.iter().filter(|u| u.family == Family::Focus && u.defined) {
        let key = u.sprite.to_ascii_lowercase();
        if seen.insert(key, ()).is_some() || index.contains(&format!("{}_shine", u.sprite)) || allow.allows_no_shine(&u.sprite) {
            continue;
        }
        let mut f = Finding::new(
            "GFX-FOCUS-SHINE-MISSING",
            Severity::Error,
            format!(
                "focus sprite {} has no {}_shine sprite; the game logs \"Missing icon shine for focus\" and draws a ? instead of the icon",
                u.sprite, u.sprite
            ),
        );
        at(&mut f, u);
        f.subject = Some(u.sprite.clone());
        f.suggestion = Some(format!("{}_shine", u.sprite));
        findings.push(f);
    }
    finalize(&mut findings);
    findings
}

/// Uses per family.
#[derive(Clone, Debug, Default, Serialize)]
pub struct FamilyTally {
    pub uses: usize,
    pub defined: usize,
    pub undefined: usize,
    pub dynamic: usize,
    pub direct_texture: usize,
    pub implicit: usize,
    /// Uses whose texture exists.
    pub texture_found: usize,
    pub texture_missing: usize,
}

/// Totals of one run.
#[derive(Clone, Debug, Default, Serialize)]
pub struct SpriteSummary {
    /// Distinct sprite names (compared without case).
    pub sprites_indexed: usize,
    /// Definitions, including shadowed ones.
    pub definitions: usize,
    pub shadowed_definitions: usize,
    pub textures_resolved: usize,
    pub textures_missing: usize,
    pub header_errors: usize,
    pub uses: usize,
    pub uses_by_family: BTreeMap<String, FamilyTally>,
    /// Uses of a name that nothing defines (not counting dynamic names).
    pub undefined_uses: usize,
    /// Uses whose value is built at run time.
    pub dynamic_uses: usize,
    /// Uses in slots no family covers.
    pub unknown_family_uses: usize,
    pub findings_by_code: BTreeMap<String, usize>,
    pub index_ms: u128,
    pub trace_ms: u128,
    pub audit_ms: u128,
}

/// The result of one run: summary, every traced use and the findings.
#[derive(Clone, Debug, Serialize)]
pub struct SpriteReport {
    pub schema: &'static str,
    pub summary: SpriteSummary,
    pub uses: Vec<SpriteUse>,
    pub findings: Vec<Finding>,
}

impl SpriteReport {
    /// Builds the index, traces the uses and audits them. The index is returned for lookups.
    pub fn run(ws: &Workspace, allow: &Allowlist, options: &TraceOptions) -> (SpriteIndex, SpriteReport) {
        let t0 = Instant::now();
        let index = SpriteIndex::build(ws);
        let index_ms = t0.elapsed().as_millis();
        let t1 = Instant::now();
        let uses = trace(ws, &index, options);
        let trace_ms = t1.elapsed().as_millis();
        let t2 = Instant::now();
        let findings = audit(ws, &index, &uses, allow, options);
        let audit_ms = t2.elapsed().as_millis();

        let mut summary =
            SpriteSummary { sprites_indexed: index.len(), definitions: index.definitions().len(), index_ms, trace_ms, audit_ms, ..SpriteSummary::default() };
        summary.shadowed_definitions = summary.definitions - index.effective().count();
        let mut seen = BTreeSet::new();
        for def in index.effective() {
            if let Some(key) = &def.texture_key
                && seen.insert(key.clone())
                && let Some(t) = index.texture_of(def)
            {
                if t.exists {
                    summary.textures_resolved += 1;
                    summary.header_errors += usize::from(t.header_error.is_some());
                } else {
                    summary.textures_missing += 1;
                }
            }
        }
        summary.uses = uses.len();
        for u in &uses {
            let tally = summary.uses_by_family.entry(u.family.as_str().to_string()).or_default();
            tally.uses += 1;
            tally.defined += usize::from(u.defined);
            tally.dynamic += usize::from(u.dynamic);
            tally.direct_texture += usize::from(u.direct_texture);
            tally.implicit += usize::from(u.implicit);
            if !u.defined && !u.dynamic && !u.direct_texture {
                tally.undefined += 1;
                summary.undefined_uses += 1;
            }
            if let Some(t) = &u.texture {
                if t.exists {
                    tally.texture_found += 1;
                } else {
                    tally.texture_missing += 1;
                }
            }
            summary.dynamic_uses += usize::from(u.dynamic);
            summary.unknown_family_uses += usize::from(u.family == Family::Unknown);
        }
        for f in &findings {
            *summary.findings_by_code.entry(f.code.clone()).or_default() += 1;
        }
        (index, SpriteReport { schema: "hoi4-engine-sprites/1", summary, uses, findings })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_rejects_unknown_families_and_empty_aliases() {
        assert!(Allowlist::parse(r#"{"aliases":[{"sprite":"GFX_a","families":["nope"]}]}"#).is_err());
        assert!(Allowlist::parse(r#"{"aliases":[{"reason":"x"}]}"#).is_err());
        assert!(Allowlist::parse("not json").is_err());
        assert!(Allowlist::parse(r#"{"aliases":[{"sprite":"GFX_a","families":["focus","decision"]}],"no_shine":["GFX_b"]}"#).is_ok());
    }

    #[test]
    fn an_alias_covers_only_the_families_it_lists() {
        let allow = Allowlist::parse(r#"{"aliases":[{"sprite":"GFX_A","families":["focus","decision"]}]}"#).unwrap();
        let two: BTreeSet<Family> = [Family::Focus, Family::Decision].into();
        let three: BTreeSet<Family> = [Family::Focus, Family::Decision, Family::Doctrine].into();
        assert!(allow.allows_reuse(Some("gfx_a"), None, &two));
        assert!(!allow.allows_reuse(Some("gfx_a"), None, &three));
        assert!(!allow.allows_reuse(Some("GFX_other"), None, &two));
    }
}
