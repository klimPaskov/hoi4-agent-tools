//! `hoi4-engine`: checks a Hearts of Iron IV mod from the command line.
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

const HELP: &str = "hoi4-engine: static checks for Hearts of Iron IV mods

USAGE:
    hoi4-engine check     [WORKSPACE] [--baseline FILE] [--fail-on error|warning|never]
                          [--format text|json] [--all] [--repair-plans] [--output FILE]
    hoi4-engine baseline  init|update [WORKSPACE] --baseline FILE [--force]
    hoi4-engine roundtrip PATH... [--format text|json]
    hoi4-engine delta     BEFORE.json AFTER.json [--format text|json]
    hoi4-engine vocab     --game DIR [--format text|json]
    hoi4-engine drawio    FILE [--prefix TAG]
    hoi4-engine --version

WORKSPACE:
    --mod DIR          The mod to check. Without it, the game itself is checked.
    --game DIR         The game installation. Defaults to HOI4_GAME_DIR.
    --dependency DIR   A mod loaded before the checked mod. Repeat in load order.
    --no-dlc           Do not load the game's dlc/ and integrated_dlc/ folders.

A check reports `pass`, `incomplete` (something could not be checked: no game, unknown names,
folders without a model) or `fail` (a new finding at or above --fail-on, default warning).
Findings recorded in --baseline never fail; `baseline update` only removes fixed entries.
";

struct Args {
    positional: Vec<String>,
    options: Vec<(String, Option<String>)>,
}

const VALUE_OPTIONS: &[&str] = &["--mod", "--game", "--dependency", "--baseline", "--fail-on", "--format", "--output", "--prefix"];

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

fn cmd_drawio(args: &Args) -> Result<ExitCode, String> {
    args.check_known(&["--prefix"])?;
    let path = args.positional.get(1).ok_or("drawio needs a file")?;
    let text = fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?;
    let import = hoi4_drawio::parse(&text, args.value("--prefix").unwrap_or(""))?;
    println!("{}", serde_json::to_string_pretty(&import).map_err(|e| e.to_string())?);
    Ok(ExitCode::SUCCESS)
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
