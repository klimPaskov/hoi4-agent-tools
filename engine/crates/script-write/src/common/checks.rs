//! The per-kind checks of `common.block_write`, run on the definition after the edit.
//!
//! New in the tutorial-path packet T3. An `error` finding refuses the write; a `warning` is
//! returned with the plan and the write still happens. The engine holds no game data: the
//! strategy tokens a check compares with come in with the request, and what a definition refers
//! to (localisation keys, sprites, categories, focuses) goes out as `references` for the caller
//! to look up in the mod's index.

use serde_json::{Value as Json, json};

use crate::source::{Block, assignments, block_of, scalar_of};

#[derive(Clone, Debug, PartialEq)]
pub struct Finding {
    pub severity: &'static str,
    pub code: &'static str,
    pub message: String,
}

impl Finding {
    pub fn error(code: &'static str, message: impl Into<String>) -> Self {
        Self { severity: "error", code, message: message.into() }
    }

    pub fn warning(code: &'static str, message: impl Into<String>) -> Self {
        Self { severity: "warning", code, message: message.into() }
    }

    pub fn to_json(&self) -> Json {
        json!({ "severity": self.severity, "code": self.code, "message": self.message })
    }
}

/// What a definition refers to and the mod may not define; the caller looks each up.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct References {
    pub localisation: Vec<String>,
    pub sprites: Vec<String>,
    pub categories: Vec<String>,
    pub focuses: Vec<String>,
}

impl References {
    pub fn to_json(&self) -> Json {
        json!({ "localisation": self.localisation, "sprites": self.sprites, "categories": self.categories, "focuses": self.focuses })
    }
}

fn push(list: &mut Vec<String>, value: String) {
    if !list.contains(&value) {
        list.push(value);
    }
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub findings: Vec<Finding>,
    pub references: References,
}

/// What a check may read besides the block.
pub struct CheckContext<'a> {
    pub id: &'a str,
    /// The strategy tokens the game documents, when the caller read them.
    pub known_tokens: Option<&'a [String]>,
}

pub type CheckFn = fn(&CheckContext<'_>, &Block<'_>) -> Outcome;

pub fn none(_: &CheckContext<'_>, _: &Block<'_>) -> Outcome {
    Outcome::default()
}

fn scalar(block: &Block<'_>, key: &str) -> Option<String> {
    assignments(block, Some(key)).into_iter().find_map(|entry| scalar_of(entry).map(|v| v.into_owned()))
}

fn blocks<'b, 'a>(block: &'b Block<'a>, key: &str) -> Vec<&'b Block<'a>> {
    assignments(block, Some(key)).into_iter().filter_map(|entry| block_of(entry)).collect()
}

struct Range {
    id: String,
    min: f64,
    max: f64,
}

const EDGE: f64 = 1e-6;

/// A balance of power: sides, ranges and their coverage of -1 to 1.
pub fn bop(context: &CheckContext<'_>, block: &Block<'_>) -> Outcome {
    let mut out = Outcome::default();
    push(&mut out.references.localisation, context.id.to_string());
    if let Some(category) = scalar(block, "decision_category") {
        push(&mut out.references.categories, category);
    }
    let mut side_ids: Vec<String> = Vec::new();
    let mut range_blocks: Vec<&Block<'_>> = blocks(block, "range");
    for side in blocks(block, "side") {
        match scalar(side, "id") {
            Some(id) => {
                if side_ids.contains(&id) {
                    out.findings.push(Finding::error("BOP_SIDE_DUPLICATE_ID", format!("The side id {id} is used twice")));
                } else {
                    push(&mut out.references.localisation, id.clone());
                    side_ids.push(id);
                }
            }
            None => out.findings.push(Finding::error("BOP_SIDE_ID_MISSING", "A side has no id")),
        }
        if let Some(icon) = scalar(side, "icon") {
            push(&mut out.references.sprites, icon);
        }
        range_blocks.extend(blocks(side, "range"));
    }
    let left = scalar(block, "left_side");
    let right = scalar(block, "right_side");
    for (name, value) in [("left_side", &left), ("right_side", &right)] {
        if let Some(value) = value
            && !side_ids.contains(value)
        {
            out.findings.push(Finding::error("BOP_SIDE_UNKNOWN", format!("{name} is {value}, and no side block has that id")));
        }
    }
    if left.is_some() && left == right {
        out.findings.push(Finding::error("BOP_SIDES_IDENTICAL", "left_side and right_side name the same side"));
    }
    if let Some(initial) = scalar(block, "initial_value") {
        match initial.parse::<f64>() {
            Ok(value) if (-1.0..=1.0).contains(&value) => {}
            _ => out.findings.push(Finding::warning("BOP_INITIAL_VALUE_RANGE", format!("initial_value {initial} is not a number from -1 to 1"))),
        }
    }
    let mut ranges: Vec<Range> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut count = 0usize;
    for range in range_blocks {
        count += 1;
        let id = scalar(range, "id");
        let min = scalar(range, "min").and_then(|v| v.parse::<f64>().ok());
        let max = scalar(range, "max").and_then(|v| v.parse::<f64>().ok());
        let (Some(id), Some(min), Some(max)) = (id, min, max) else {
            out.findings.push(Finding::error("BOP_RANGE_INCOMPLETE", "A range needs an id and numeric min and max"));
            continue;
        };
        if seen.contains(&id) {
            out.findings.push(Finding::error("BOP_RANGE_DUPLICATE_ID", format!("The range id {id} is used twice")));
        }
        seen.push(id.clone());
        push(&mut out.references.localisation, id.clone());
        if min >= max {
            out.findings.push(Finding::error("BOP_RANGE_EMPTY", format!("The range {id} has min {min} not below max {max}")));
            continue;
        }
        ranges.push(Range { id, min, max });
    }
    if count == 0 {
        out.findings.push(Finding::error("BOP_RANGES_MISSING", "A balance of power needs ranges that cover -1 to 1"));
        return out;
    }
    ranges.sort_by(|a, b| a.min.total_cmp(&b.min).then(a.max.total_cmp(&b.max)));
    if let Some(first) = ranges.first()
        && (first.min + 1.0).abs() > EDGE
    {
        out.findings.push(Finding::error("BOP_RANGE_COVERAGE", format!("The lowest range {} starts at {}, not -1", first.id, first.min)));
    }
    if let Some(last) = ranges.last()
        && (last.max - 1.0).abs() > EDGE
    {
        out.findings.push(Finding::error("BOP_RANGE_COVERAGE", format!("The highest range {} ends at {}, not 1", last.id, last.max)));
    }
    for pair in ranges.windows(2) {
        let (a, b) = (&pair[0], &pair[1]);
        if b.min < a.max - EDGE {
            out.findings.push(Finding::error("BOP_RANGE_OVERLAP", format!("The ranges {} and {} overlap", a.id, b.id)));
        } else if b.min > a.max + EDGE {
            out.findings.push(Finding::error("BOP_RANGE_GAP", format!("The values from {} to {} are in no range ({} to {})", a.max, b.min, a.id, b.id)));
        }
    }
    out
}

/// An AI strategy block: its `ai_strategy` entries and when it aborts.
pub fn ai_strategy(context: &CheckContext<'_>, block: &Block<'_>) -> Outcome {
    let mut out = Outcome::default();
    let strategies = blocks(block, "ai_strategy");
    if strategies.is_empty() {
        out.findings.push(Finding::warning("AI_STRATEGY_EMPTY", format!("{} has no ai_strategy entry, so it sets nothing", context.id)));
    }
    for strategy in strategies {
        match scalar(strategy, "type") {
            Some(token) => {
                if let Some(known) = context.known_tokens
                    && !known.is_empty()
                    && !known.iter().any(|k| k == &token)
                {
                    out.findings.push(Finding::warning("AI_STRATEGY_TYPE_UNKNOWN", format!("The strategy type {token} is not among the documented tokens")));
                }
            }
            None => out.findings.push(Finding::warning("AI_STRATEGY_TYPE_MISSING", "An ai_strategy entry has no type")),
        }
        if let Some(value) = scalar(strategy, "value")
            && value.parse::<f64>().is_err()
        {
            out.findings.push(Finding::warning("AI_STRATEGY_VALUE_NOT_NUMBER", format!("The value {value} is not a number")));
        }
    }
    if assignments(block, Some("abort")).is_empty() && assignments(block, Some("abort_when_not_enabled")).is_empty() {
        out.findings.push(Finding::warning("AI_STRATEGY_NO_ABORT", format!("{} has neither abort nor abort_when_not_enabled, so it never ends", context.id)));
    }
    out
}

/// An AI strategy plan: its name, description and the focuses it asks the AI to take.
pub fn ai_strategy_plan(context: &CheckContext<'_>, block: &Block<'_>) -> Outcome {
    let mut out = Outcome::default();
    for key in ["name", "desc"] {
        if let Some(value) = scalar(block, key) {
            push(&mut out.references.localisation, value);
        }
    }
    match blocks(block, "ai_national_focuses").into_iter().next() {
        Some(focuses) => {
            for focus in focuses.scalars() {
                push(&mut out.references.focuses, focus.value.to_string());
            }
        }
        None => out.findings.push(Finding::warning("AI_PLAN_NO_FOCUSES", format!("{} has no ai_national_focuses block", context.id))),
    }
    out
}
