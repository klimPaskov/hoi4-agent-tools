//! `hoi4-engine`: checks a Hearts of Iron IV mod from the command line. `focus-layout` lays out focus trees
//! (JSON in, JSON out; exit 2 for an invalid request).
//!
//! Exit codes: 0 when no new finding reaches the failure severity, 1 when one does, 2 for usage
//! or input errors.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

use hoi4_engine::baseline::Baseline;
use hoi4_engine::findings::{Finding, Severity};
use hoi4_engine::repair;
use hoi4_engine::{Analysis, Vocabulary, Workspace, WorkspaceOptions};

mod serve;

const HELP: &str = "hoi4-engine: static checks for Hearts of Iron IV mods

USAGE:
    hoi4-engine check     [WORKSPACE] [--baseline FILE] [--fail-on error|warning|never]
                          [--format text|json] [--all] [--repair-plans] [--output FILE]
    hoi4-engine baseline  init|update [WORKSPACE] --baseline FILE [--force]
    hoi4-engine roundtrip PATH... [--format text|json]
    hoi4-engine delta     BEFORE.json AFTER.json [--format text|json]
    hoi4-engine vocab     --game DIR [--format text|json]
    hoi4-engine sprites   [--game DIR] [--mod DIR] [--dependency DIR]... [--no-dlc] [--allowlist FILE]
                          [--all-layers] [--index] [--format text|json] [--output FILE]
                          [--fail-on error|warning|never]
    hoi4-engine drawio    FILE [--prefix TAG]
    hoi4-engine focus-layout [--request FILE]
    hoi4-engine localisation [--request FILE]
    hoi4-engine ideas [--request FILE]
    hoi4-engine system [--request FILE]
    hoi4-engine units [--request FILE]
    hoi4-engine texture   FILE|DIR... [--format text|json] [--max-pixels N]
    hoi4-engine texture   FILE --output OUT.png [--max-pixels N]
    hoi4-engine focus-render [WORKSPACE] --output OUT.png [--request FILE]
    hoi4-engine serve
    hoi4-engine --version

WORKSPACE:
    --mod DIR          The mod to check. Without it, the game itself is checked.
    --game DIR         The game installation. Defaults to HOI4_GAME_DIR.
    --dependency DIR   A mod loaded before the checked mod. Repeat in load order.
    --no-dlc           Do not load the game's dlc/ and integrated_dlc/ folders.

The `sprites` command indexes every sprite in interface/**/*.gfx (texture resolved across the
game, DLC and mods, headers read), traces which sprite each focus, idea, decision, character,
event and more shows, and reports sprites or textures used by two asset families, missing
textures and focus sprites without a `_shine` companion. It traces the mod (or the game without
--mod); --all-layers traces every loaded file. --index adds every sprite to the JSON output.

The `texture` command decodes DDS and TGA files (folders are searched) and reports each format,
size and decoded-pixel hash, or why a file cannot be decoded; it exits 1 when one cannot.
With --output it writes one decoded texture as PNG. `serve` runs the resident engine that the
MCP server talks to over stdin and stdout (see crates/cli/src/serve.rs for the frames).

A check reports `pass`, `incomplete` (something could not be checked: no game, unknown names,
folders without a model) or `fail` (a new finding at or above --fail-on, default warning).
Findings recorded in --baseline never fail; `baseline update` only removes fixed entries.
";

struct Args {
    positional: Vec<String>,
    options: Vec<(String, Option<String>)>,
}

const VALUE_OPTIONS: &[&str] =
    &["--mod", "--game", "--dependency", "--baseline", "--fail-on", "--format", "--output", "--prefix", "--request", "--allowlist", "--max-pixels"];

impl Args {
    fn parse(raw: Vec<String>) -> Result<Args, String> {
        let mut args = Args { positional: Vec::new(), options: Vec::new() };
        let mut it = raw.into_iter();
        while let Some(arg) = it.next() {
            if let Some((name, value)) = arg.split_once('=').filter(|(n, _)| n.starts_with("--")) {
                args.options.push((name.to_string(), Some(value.to_string())));
            } else if VALUE_OPTIONS.contains(&arg.as_str()) {
                let value = it.next().ok_or_else(|| format!("{arg} needs a value"))?;
                args.options.push((arg, Some(value)));
            } else if arg.starts_with("--") {
                args.options.push((arg, None));
            } else {
                args.positional.push(arg);
            }
        }
        Ok(args)
    }

    fn value(&self, name: &str) -> Option<&str> {
        self.options.iter().rev().find(|(n, _)| n == name).and_then(|(_, v)| v.as_deref())
    }

    fn values(&self, name: &str) -> Vec<&str> {
        self.options.iter().filter(|(n, _)| n == name).filter_map(|(_, v)| v.as_deref()).collect()
    }

    fn flag(&self, name: &str) -> bool {
        self.options.iter().any(|(n, _)| n == name)
    }

    fn check_known(&self, known: &[&str]) -> Result<(), String> {
        for (name, _) in &self.options {
            if !known.contains(&name.as_str()) {
                return Err(format!("unknown option {name}"));
            }
        }
        Ok(())
    }
}

const WORKSPACE_OPTIONS: &[&str] = &["--mod", "--game", "--dependency", "--no-dlc", "--format"];

fn workspace_options(args: &Args) -> Result<WorkspaceOptions, String> {
    let game = args.value("--game").map(PathBuf::from).or_else(|| std::env::var_os("HOI4_GAME_DIR").map(PathBuf::from)).filter(|p| p.is_dir());
    let target = args.value("--mod").map(PathBuf::from);
    if let Some(t) = &target
        && !t.is_dir()
    {
        return Err(format!("mod folder {} does not exist", t.display()));
    }
    if target.is_none() && game.is_none() {
        return Err("give --mod, --game or HOI4_GAME_DIR".into());
    }
    let dependencies = args.values("--dependency").into_iter().map(PathBuf::from).collect::<Vec<_>>();
    for d in &dependencies {
        if !d.is_dir() {
            return Err(format!("dependency folder {} does not exist", d.display()));
        }
    }
    Ok(WorkspaceOptions { game, include_dlc: !args.flag("--no-dlc"), dependencies, target })
}

fn analyze(args: &Args) -> Result<Analysis, String> {
    let options = workspace_options(args)?;
    let vocab = options.game.as_deref().map(Vocabulary::from_game).unwrap_or_default();
    Ok(Analysis::run(Workspace::load(&options), vocab))
}

fn severity(name: &str) -> Result<Option<Severity>, String> {
    match name {
        "error" => Ok(Some(Severity::Error)),
        "warning" => Ok(Some(Severity::Warning)),
        "info" => Ok(Some(Severity::Info)),
        "never" => Ok(None),
        other => Err(format!("--fail-on must be error, warning, info or never, not {other}")),
    }
}

fn emit(args: &Args, text: &str) -> Result<(), String> {
    match args.value("--output") {
        Some(path) => fs::write(path, text).map_err(|e| format!("cannot write {path}: {e}")),
        None => {
            let mut out = std::io::stdout().lock();
            out.write_all(text.as_bytes()).map_err(|e| e.to_string())
        }
    }
}

fn json_format(args: &Args) -> Result<bool, String> {
    match args.value("--format").unwrap_or("text") {
        "text" => Ok(false),
        "json" => Ok(true),
        other => Err(format!("--format must be text or json, not {other}")),
    }
}

fn repair_for(analysis: &Analysis, f: &Finding) -> Option<repair::RepairPlan> {
    let suggestion = f.suggestion.as_ref()?;
    let subject = f.subject.as_ref()?;
    let file = analysis.workspace.files.iter().find(|s| s.relative == f.path && analysis.workspace.layers[s.layer].name == f.layer)?;
    let bytes = fs::read(&file.absolute).ok()?;
    repair::plan_replace(&bytes, f.start, f.end, subject, suggestion).ok()
}

fn location(f: &Finding) -> String {
    if f.line == 0 { f.path.clone() } else { format!("{}:{}:{}", f.path, f.line, f.column) }
}

fn cmd_check(args: &Args) -> Result<ExitCode, String> {
    let mut known = WORKSPACE_OPTIONS.to_vec();
    known.extend(["--baseline", "--fail-on", "--all", "--repair-plans", "--output"]);
    args.check_known(&known)?;
    let json = json_format(args)?;
    let fail_on = severity(args.value("--fail-on").unwrap_or("warning"))?;
    let baseline = match args.value("--baseline") {
        Some(path) => Some(Baseline::parse(&fs::read_to_string(path).map_err(|e| format!("cannot read baseline {path}: {e}"))?)?),
        None => None,
    };
    let analysis = analyze(args)?;
    let with_repairs = args.flag("--repair-plans");
    let repairs = |f: &Finding| if with_repairs { repair_for(&analysis, f) } else { None };
    let report = hoi4_engine::report::build(&analysis, baseline.as_ref(), fail_on.unwrap_or(Severity::Error), &repairs);
    let failed = fail_on.is_some() && report.verdict == "fail";
    let verdict = if fail_on.is_none() && report.verdict == "fail" { "incomplete" } else { report.verdict };
    if json {
        let mut text = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
        text.push('\n');
        emit(args, &text)?;
    } else {
        let mut text = String::new();
        let target = analysis.target_layer().map(|l| analysis.workspace.layers[l].name.clone()).unwrap_or_default();
        text.push_str(&format!(
            "hoi4-engine {} check of {target} (game {})\n",
            hoi4_engine::VERSION,
            analysis.vocab.game_version.as_deref().unwrap_or("not found")
        ));
        let show_all = args.flag("--all");
        let mut hidden = 0usize;
        for rf in &report.findings {
            let f = rf.finding;
            if !show_all && (rf.status == "baselined" || f.severity == Severity::Info) {
                hidden += 1;
                continue;
            }
            let sev = match f.severity {
                Severity::Error => "error",
                Severity::Warning => "warning",
                Severity::Info => "info",
            };
            text.push_str(&format!("{}: {sev} {}: {}", location(f), f.code, f.message));
            if let Some(s) = &f.suggestion {
                text.push_str(&format!(" (did you mean `{s}`?)"));
            }
            if rf.status == "baselined" {
                text.push_str(" [baselined]");
            }
            text.push('\n');
        }
        let s = &report.summary;
        text.push_str(&format!("\n{} errors, {} warnings, {} infos", s.errors, s.warnings, s.infos));
        if hidden > 0 {
            text.push_str(&format!(" ({hidden} info or baselined findings not shown; use --all)"));
        }
        text.push('\n');
        if let Some(b) = &report.baseline {
            text.push_str(&format!(
                "baseline: {} entries, {} still present, {} new, {} fixed{}\n",
                b.baseline_count,
                b.baselined,
                b.new,
                b.fixed,
                if b.fixed > 0 { " (run `hoi4-engine baseline update` to shrink it)" } else { "" }
            ));
        }
        let c = &analysis.coverage;
        text.push_str(&format!(
            "commands: effects {} resolved, {} unresolved, {} unknown; triggers {} resolved, {} unresolved, {} unknown\n",
            c.effect_commands.resolved,
            c.effect_commands.unresolved,
            c.effect_commands.unknown,
            c.trigger_commands.resolved,
            c.trigger_commands.unresolved,
            c.trigger_commands.unknown
        ));
        text.push_str("references (resolved/unresolved/unknown):");
        let mut empty = 0usize;
        for (kind, t) in &c.references {
            if t.resolved + t.unresolved + t.unknown == 0 {
                empty += 1;
                continue;
            }
            text.push_str(&format!(" {kind} {}/{}/{}", t.resolved, t.unresolved, t.unknown));
        }
        text.push_str(&format!("; {empty} kinds with none (listed in --format json)\n"));
        text.push_str(&format!(
            "files: {} checked, {} script files, {} with a context model",
            c.checked_files, c.checked_script_files, c.modelled_script_files
        ));
        if !c.unmodelled_script_folders.is_empty() {
            text.push_str(&format!("; {} folders without one (not checked)", c.unmodelled_script_folders.len()));
        }
        text.push('\n');
        if !c.vocabulary_available {
            text.push_str("the game documentation was not found, so effects and triggers are unknown, not checked\n");
        }
        text.push_str(&format!("verdict: {verdict} ({} ms)\n", analysis.stats.elapsed_ms));
        emit(args, &text)?;
    }
    Ok(if failed { ExitCode::from(1) } else { ExitCode::SUCCESS })
}

fn cmd_baseline(args: &Args) -> Result<ExitCode, String> {
    let mut known = WORKSPACE_OPTIONS.to_vec();
    known.extend(["--baseline", "--force"]);
    args.check_known(&known)?;
    let mode = args.positional.get(1).map(String::as_str).ok_or("baseline needs init or update")?;
    let path = args.value("--baseline").ok_or("baseline needs --baseline FILE")?;
    let analysis = analyze(args)?;
    let next = match mode {
        "init" => {
            if PathBuf::from(path).exists() && !args.flag("--force") {
                return Err(format!("{path} exists; use `baseline update` to shrink it, or --force to replace it"));
            }
            Baseline::from_findings(&analysis.findings)
        }
        "update" => {
            let current = Baseline::parse(&fs::read_to_string(path).map_err(|e| format!("cannot read baseline {path}: {e}"))?)?;
            let next = current.shrink(&analysis.findings);
            println!("baseline: {} entries before, {} after", current.findings.len(), next.findings.len());
            next
        }
        other => return Err(format!("baseline mode must be init or update, not {other}")),
    };
    fs::write(path, next.to_json()).map_err(|e| format!("cannot write {path}: {e}"))?;
    println!("baseline {path}: {} entries", next.findings.len());
    Ok(ExitCode::SUCCESS)
}

fn cmd_roundtrip(args: &Args) -> Result<ExitCode, String> {
    args.check_known(&["--format"])?;
    let json = json_format(args)?;
    if args.positional.len() < 2 {
        return Err("roundtrip needs at least one path".into());
    }
    let reports: Vec<_> = args.positional[1..].iter().map(|p| hoi4_engine::roundtrip::round_trip(&PathBuf::from(p))).collect();
    let ok = reports.iter().all(|r| r.passed());
    if json {
        println!("{}", serde_json::to_string_pretty(&reports).map_err(|e| e.to_string())?);
    } else {
        for r in &reports {
            println!(
                "{}: {} files ({} script, {} localisation, {} bytes), {} byte-identical, {} mismatched, {} structure errors, {} with syntax diagnostics, input sha256 {} ({} ms)",
                r.root,
                r.files,
                r.script_files,
                r.localisation_files,
                r.bytes,
                r.identical,
                r.mismatches.len(),
                r.structure_errors.len(),
                r.files_with_diagnostics,
                r.input_sha256,
                r.elapsed_ms
            );
            for m in r.mismatches.iter().chain(&r.structure_errors).chain(&r.unreadable) {
                println!("  {m}");
            }
        }
    }
    Ok(if ok { ExitCode::SUCCESS } else { ExitCode::from(1) })
}

fn read_findings(path: &str) -> Result<Vec<Finding>, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{path} is not JSON: {e}"))?;
    let findings = value.get("findings").cloned().ok_or_else(|| format!("{path} has no findings; pass `check --format json` reports"))?;
    serde_json::from_value(findings).map_err(|e| format!("{path}: {e}"))
}

fn cmd_delta(args: &Args) -> Result<ExitCode, String> {
    args.check_known(&["--format"])?;
    let json = json_format(args)?;
    let (Some(before), Some(after)) = (args.positional.get(1), args.positional.get(2)) else {
        return Err("delta needs BEFORE.json AFTER.json".into());
    };
    let delta = hoi4_engine::delta::compare(&read_findings(before)?, &read_findings(after)?);
    let summary = hoi4_engine::delta::summarize(&delta);
    if json {
        let value = serde_json::json!({ "summary": summary, "findings": delta });
        println!("{}", serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?);
    } else {
        for e in delta.iter().filter(|e| e.change != hoi4_engine::delta::Change::Unchanged) {
            println!("{:?}: {} {} {}", e.change, location(&e.finding), e.finding.code, e.finding.message);
        }
        println!(
            "introduced {}, worsened {}, changed {}, improved {}, unchanged {}, resolved {}",
            summary.introduced, summary.worsened, summary.changed, summary.improved, summary.unchanged, summary.resolved
        );
    }
    Ok(ExitCode::SUCCESS)
}

fn cmd_vocab(args: &Args) -> Result<ExitCode, String> {
    args.check_known(&["--game", "--format"])?;
    let json = json_format(args)?;
    let game = args.value("--game").map(PathBuf::from).or_else(|| std::env::var_os("HOI4_GAME_DIR").map(PathBuf::from)).ok_or("vocab needs --game")?;
    let vocab = Vocabulary::from_game(&game);
    if json {
        println!("{}", serde_json::to_string_pretty(&vocab).map_err(|e| e.to_string())?);
    } else {
        println!("game {}", vocab.game_version.as_deref().unwrap_or("unknown"));
        println!("{} effects, {} triggers, {} modifiers", vocab.effects.len(), vocab.triggers.len(), vocab.modifiers.len());
        for s in &vocab.sources {
            println!("  {} {} entries sha256 {}", s.file, s.entries, s.sha256);
        }
    }
    Ok(if vocab.has_commands() { ExitCode::SUCCESS } else { ExitCode::from(1) })
}

#[derive(serde::Serialize)]
struct SpriteView<'a> {
    #[serde(flatten)]
    def: &'a hoi4_engine::sprites::SpriteDef,
    texture: Option<&'a hoi4_engine::sprites::ResolvedTexture>,
}

#[derive(serde::Serialize)]
struct SpritesOut<'a> {
    #[serde(flatten)]
    report: &'a hoi4_engine::sprite_audit::SpriteReport,
    #[serde(skip_serializing_if = "Option::is_none")]
    sprites: Option<Vec<SpriteView<'a>>>,
}

fn cmd_sprites(args: &Args) -> Result<ExitCode, String> {
    let mut known = WORKSPACE_OPTIONS.to_vec();
    known.extend(["--allowlist", "--all-layers", "--index", "--output", "--fail-on"]);
    args.check_known(&known)?;
    let json = json_format(args)?;
    let fail_on = severity(args.value("--fail-on").unwrap_or("never"))?;
    let allow = match args.value("--allowlist") {
        Some(path) => hoi4_engine::sprite_audit::Allowlist::load(&PathBuf::from(path))?,
        None => hoi4_engine::sprite_audit::Allowlist::default(),
    };
    let ws = Workspace::load(&workspace_options(args)?);
    let options = hoi4_engine::sprite_trace::TraceOptions { all_layers: args.flag("--all-layers") };
    let (index, report) = hoi4_engine::sprite_audit::SpriteReport::run(&ws, &allow, &options);
    if json {
        let sprites = args.flag("--index").then(|| index.definitions().iter().map(|def| SpriteView { def, texture: index.texture_of(def) }).collect());
        let mut text = serde_json::to_string_pretty(&SpritesOut { report: &report, sprites }).map_err(|e| e.to_string())?;
        text.push('\n');
        emit(args, &text)?;
    } else {
        let s = &report.summary;
        let mut text = String::new();
        text.push_str(&format!(
            "sprites: {} indexed ({} definitions, {} shadowed); textures {} found, {} missing, {} unreadable headers\n",
            s.sprites_indexed, s.definitions, s.shadowed_definitions, s.textures_resolved, s.textures_missing, s.header_errors
        ));
        text.push_str(&format!(
            "uses: {} traced, {} undefined, {} dynamic, {} in unclassified slots ({} ms index, {} ms trace, {} ms audit)\n",
            s.uses, s.undefined_uses, s.dynamic_uses, s.unknown_family_uses, s.index_ms, s.trace_ms, s.audit_ms
        ));
        for (family, t) in &s.uses_by_family {
            text.push_str(&format!(
                "  {family}: {} uses, {} undefined, {} dynamic, {} texture paths, {} implicit, {} textures missing\n",
                t.uses, t.undefined, t.dynamic, t.direct_texture, t.implicit, t.texture_missing
            ));
        }
        let shown: Vec<&Finding> = report.findings.iter().filter(|f| f.severity != Severity::Info).collect();
        for f in shown.iter().take(25) {
            let message: String = f.message.chars().take(240).collect();
            text.push_str(&format!("{}: {:?} {}: {}\n", location(f), f.severity, f.code, message));
        }
        if shown.len() > 25 {
            text.push_str(&format!("... {} more warnings (use --format json for all; info findings are JSON only)\n", shown.len() - 25));
        }
        let counts: Vec<String> = s.findings_by_code.iter().map(|(c, n)| format!("{c} {n}")).collect();
        text.push_str(&format!("findings: {}\n", if counts.is_empty() { "none".to_string() } else { counts.join(", ") }));
        emit(args, &text)?;
    }
    let failed = fail_on.is_some_and(|level| report.findings.iter().any(|f| f.severity >= level));
    Ok(if failed { ExitCode::from(1) } else { ExitCode::SUCCESS })
}

fn cmd_drawio(args: &Args) -> Result<ExitCode, String> {
    args.check_known(&["--prefix"])?;
    let path = args.positional.get(1).ok_or("drawio needs a file")?;
    let text = fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?;
    let import = hoi4_drawio::parse(&text, args.value("--prefix").unwrap_or(""))?;
    println!("{}", serde_json::to_string_pretty(&import).map_err(|e| e.to_string())?);
    Ok(ExitCode::SUCCESS)
}

fn cmd_focus_layout(args: &Args) -> Result<ExitCode, String> {
    args.check_known(&["--request"])?;
    if args.positional.len() > 1 {
        return Err("focus-layout reads the request from --request FILE or stdin".into());
    }
    let text = match args.value("--request") {
        Some(path) => fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?,
        None => {
            let mut text = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin().lock(), &mut text).map_err(|e| format!("cannot read stdin: {e}"))?;
            text
        }
    };
    let (json, code) = hoi4_focus_layout::respond_json(&text);
    if code != 0
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(&json)
    {
        eprintln!("hoi4-engine: focus-layout: {}", value["error"]["message"].as_str().unwrap_or("invalid request"));
    }
    std::io::stdout().lock().write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(ExitCode::from(code))
}

/// One decoded texture in `texture` output.
#[derive(serde::Serialize)]
struct TextureReport {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
    /// SHA-256 of the decoded RGBA bytes.
    #[serde(skip_serializing_if = "Option::is_none")]
    rgba_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn texture_files(path: &std::path::Path, out: &mut Vec<PathBuf>) {
    if path.is_dir() {
        let Ok(entries) = fs::read_dir(path) else { return };
        let mut children: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
        children.sort();
        for child in children {
            texture_files(&child, out);
        }
    } else if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("dds") || e.eq_ignore_ascii_case("tga")) {
        out.push(path.to_path_buf());
    }
}

fn cmd_texture(args: &Args) -> Result<ExitCode, String> {
    use rayon::prelude::*;
    args.check_known(&["--output", "--format", "--max-pixels"])?;
    let max_pixels = match args.value("--max-pixels") {
        Some(v) => v.parse::<u64>().map_err(|_| format!("--max-pixels must be a number, not {v}"))?,
        None => hoi4_texture::DEFAULT_MAX_PIXELS,
    };
    let inputs = &args.positional[1..];
    if inputs.is_empty() {
        return Err("texture needs a file or folder".into());
    }
    if let Some(output) = args.value("--output") {
        let [input] = inputs else { return Err("--output takes exactly one texture".into()) };
        let decoded = hoi4_texture::decode_file(std::path::Path::new(input), max_pixels).map_err(|e| format!("{input}: {e}"))?;
        fs::write(output, hoi4_texture::pngio::encode(&decoded.image, false)).map_err(|e| format!("cannot write {output}: {e}"))?;
        return Ok(ExitCode::SUCCESS);
    }
    let json = json_format(args)?;
    let mut files = Vec::new();
    for input in inputs {
        texture_files(std::path::Path::new(input), &mut files);
    }
    let reports: Vec<TextureReport> = files
        .par_iter()
        .map(|path| {
            let shown = path.display().to_string();
            match hoi4_texture::decode_file(path, max_pixels) {
                Ok(decoded) => {
                    use sha2::Digest;
                    let hash = sha2::Sha256::digest(&decoded.image.rgba);
                    TextureReport {
                        path: shown,
                        format: Some(decoded.format),
                        width: Some(decoded.image.width),
                        height: Some(decoded.image.height),
                        rgba_sha256: Some(hash.iter().map(|b| format!("{b:02x}")).collect()),
                        error: None,
                    }
                }
                Err(e) => TextureReport { path: shown, format: Some(e.format.clone()), width: None, height: None, rgba_sha256: None, error: Some(e.message) },
            }
        })
        .collect();
    let failed = reports.iter().filter(|r| r.error.is_some()).count();
    let mut by_format = std::collections::BTreeMap::<String, (usize, usize)>::new();
    for report in &reports {
        let entry = by_format.entry(report.format.clone().unwrap_or_default()).or_default();
        if report.error.is_some() { entry.1 += 1 } else { entry.0 += 1 }
    }
    let text = if json {
        let formats: serde_json::Map<String, serde_json::Value> =
            by_format.iter().map(|(format, (ok, bad))| (format.clone(), serde_json::json!({ "decoded": ok, "failed": bad }))).collect();
        let value =
            serde_json::json!({ "schema": "hoi4-engine-textures/1", "files": reports.len(), "failed": failed, "formats": formats, "textures": reports });
        serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?
    } else {
        let mut text = String::new();
        for report in &reports {
            match (&report.error, &report.format) {
                (Some(error), format) => text.push_str(&format!("FAIL {} ({}): {error}\n", report.path, format.as_deref().unwrap_or("?"))),
                (None, format) => text.push_str(&format!(
                    "ok   {} {}x{} {}\n",
                    report.path,
                    report.width.unwrap_or(0),
                    report.height.unwrap_or(0),
                    format.as_deref().unwrap_or("?")
                )),
            }
        }
        for (format, (ok, bad)) in &by_format {
            text.push_str(&format!("{format}: {ok} decoded, {bad} failed\n"));
        }
        text.push_str(&format!("{} textures, {failed} failed\n", reports.len()));
        text
    };
    print!("{text}");
    Ok(if failed > 0 { ExitCode::from(1) } else { ExitCode::SUCCESS })
}

fn cmd_focus_render(args: &Args) -> Result<ExitCode, String> {
    args.check_known(&["--mod", "--game", "--dependency", "--no-dlc", "--request", "--output"])?;
    let output = args.value("--output").ok_or("focus-render needs --output FILE.png")?;
    let options = workspace_options(args)?;
    let text = match args.value("--request") {
        Some(path) => fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?,
        None => {
            let mut text = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin().lock(), &mut text).map_err(|e| format!("cannot read stdin: {e}"))?;
            text
        }
    };
    let request: hoi4_preview::focus::FocusRenderRequest = serde_json::from_str(&text).map_err(|e| format!("invalid focus render request: {e}"))?;
    let layers = hoi4_preview::layers_for(options.game.as_deref(), options.include_dlc, &options.dependencies, options.target.as_deref());
    let preview = hoi4_preview::Preview::new();
    let (png, report, cache, timings) = preview.focus_png(layers, &request)?;
    fs::write(output, png).map_err(|e| format!("cannot write {output}: {e}"))?;
    let value = serde_json::json!({ "schema": "hoi4-focus-render/1", "report": report, "cache": cache, "timings": timings });
    println!("{}", serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?);
    Ok(ExitCode::SUCCESS)
}

/// Reads a JSON request from --request FILE or stdin, answers it with `respond` and prints the
/// JSON answer. A failed request also names its error on stderr.
fn cmd_json_request(args: &Args, name: &str, respond: fn(&str) -> (String, u8)) -> Result<ExitCode, String> {
    args.check_known(&["--request"])?;
    if args.positional.len() > 1 {
        return Err(format!("{name} reads the request from --request FILE or stdin"));
    }
    let text = match args.value("--request") {
        Some(path) => fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?,
        None => {
            let mut text = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin().lock(), &mut text).map_err(|e| format!("cannot read stdin: {e}"))?;
            text
        }
    };
    let (json, code) = respond(&text);
    if code != 0
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(&json)
    {
        eprintln!("hoi4-engine: {name}: {}", value["error"]["message"].as_str().unwrap_or("invalid request"));
    }
    std::io::stdout().lock().write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(ExitCode::from(code))
}

fn main() -> ExitCode {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let args = match Args::parse(raw) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("hoi4-engine: {e}");
            return ExitCode::from(2);
        }
    };
    if args.flag("--version") {
        println!("hoi4-engine {}", hoi4_engine::VERSION);
        return ExitCode::SUCCESS;
    }
    let result = match args.positional.first().map(String::as_str) {
        Some("check") => cmd_check(&args),
        Some("baseline") => cmd_baseline(&args),
        Some("roundtrip") => cmd_roundtrip(&args),
        Some("delta") => cmd_delta(&args),
        Some("vocab") => cmd_vocab(&args),
        Some("drawio") => cmd_drawio(&args),
        Some("focus-layout") => cmd_focus_layout(&args),
        Some("localisation") => cmd_json_request(&args, "localisation", hoi4_engine::localisation::respond_json),
        Some("ideas") => cmd_json_request(&args, "ideas", hoi4_engine::ideas::respond_json),
        Some("system") => cmd_json_request(&args, "system", hoi4_engine::system::respond_json),
        Some("units") => cmd_json_request(&args, "units", hoi4_engine::system::respond_units_json),
        Some("sprites") => cmd_sprites(&args),
        Some("texture") => cmd_texture(&args),
        Some("focus-render") => cmd_focus_render(&args),
        Some("serve") => args.check_known(&[]).map(|()| ExitCode::from(serve::run())),
        Some("help") | None => {
            print!("{HELP}");
            return ExitCode::SUCCESS;
        }
        Some(other) => Err(format!("unknown command {other}; see `hoi4-engine help`")),
    };
    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("hoi4-engine: {e}");
            ExitCode::from(2)
        }
    }
}
