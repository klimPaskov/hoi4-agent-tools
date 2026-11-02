//! The JSON contract: request `hoi4-focus-layout-request/1` and response `hoi4-focus-layout/1`.
//! `README.md` and `schemas/` in this crate describe the same shapes.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const REQUEST_SCHEMA: &str = "hoi4-focus-layout-request/1";
pub const RESPONSE_SCHEMA: &str = "hoi4-focus-layout/1";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub schema: String,
    pub operation: Operation,
    #[serde(default)]
    pub tree_id: Option<String>,
    #[serde(default)]
    pub options: Options,
    #[serde(default)]
    pub lanes: Vec<Lane>,
    pub focuses: Vec<Focus>,
    #[serde(default)]
    pub insert: Option<InsertSpec>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Layout,
    Insert,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct Options {
    /// Smallest horizontal distance between two focuses of one row.
    pub node_spacing: i64,
    /// Extra columns between two lane bands, on top of `node_spacing`.
    pub lane_spacing: i64,
}

impl Default for Options {
    fn default() -> Self {
        Options { node_spacing: 2, lane_spacing: 2 }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lane {
    pub id: String,
    #[serde(default)]
    pub order: i64,
    #[serde(default)]
    pub minimum_x: Option<i64>,
    #[serde(default)]
    pub maximum_x: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Focus {
    pub id: String,
    /// AND of OR groups, as in the game's `prerequisite` blocks.
    #[serde(default)]
    pub prerequisites: Vec<Vec<String>>,
    #[serde(default)]
    pub mutually_exclusive: Vec<String>,
    #[serde(default)]
    pub lane_id: Option<String>,
    #[serde(default)]
    pub position: Position,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
pub enum Position {
    Fixed {
        x: i64,
        y: i64,
    },
    Relative {
        x: i64,
        y: i64,
        #[serde(rename = "relativeTo")]
        relative_to: String,
    },
    Auto {
        #[serde(default, rename = "preferredX")]
        preferred_x: Option<i64>,
        #[serde(default, rename = "preferredY")]
        preferred_y: Option<i64>,
    },
}

impl Default for Position {
    fn default() -> Self {
        Position::Auto { preferred_x: None, preferred_y: None }
    }
}

impl Position {
    pub fn is_auto(&self) -> bool {
        matches!(self, Position::Auto { .. })
    }

    pub fn preferred_x(&self) -> Option<i64> {
        match self {
            Position::Auto { preferred_x, .. } => *preferred_x,
            _ => None,
        }
    }

    pub fn preferred_y(&self) -> Option<i64> {
        match self {
            Position::Auto { preferred_y, .. } => *preferred_y,
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InsertSpec {
    pub focus_ids: Vec<String>,
    #[serde(default)]
    pub anchor_id: Option<String>,
    #[serde(default)]
    pub prefer_side: Side,
    #[serde(default)]
    pub allow_shift: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Left,
    Right,
    #[default]
    Either,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    Blocked,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub schema: &'static str,
    pub status: Status,
    pub operation: Operation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tree_id: Option<String>,
    pub nodes: Vec<NodeOut>,
    pub source: Vec<SourceOut>,
    pub diagnostics: Vec<Diagnostic>,
    pub metrics: Option<Metrics>,
    pub hashes: Hashes,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_room: Option<NeedsRoom>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub shifted: Vec<Shift>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeOut {
    pub id: String,
    pub x: i64,
    pub y: i64,
    pub lane_id: String,
    /// True when this call set the coordinates (placed, shifted, or relative to a placed focus).
    pub moved: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceOut {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_to: Option<String>,
    pub x: i64,
    pub y: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub code: &'static str,
    pub severity: Severity,
    pub focus_ids: Vec<String>,
    pub message: String,
    pub details: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub columns: i64,
    pub rows: i64,
    pub orthogonal_crossings: usize,
    pub stems_through_plaques: usize,
    pub merged_bars: usize,
    pub duration_micros: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hashes {
    /// Absent (null) when the call is blocked and places nothing.
    pub layout: Option<String>,
    pub untouched: String,
    pub prerequisites: String,
    pub exclusions: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeedsRoom {
    pub shift: Vec<Shift>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Right,
    Left,
}

/// Every existing focus with `x >= fromX` (direction right) or `x <= fromX` (direction left)
/// moves `columns` columns in that direction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shift {
    pub from_x: i64,
    pub columns: i64,
    pub direction: Direction,
    pub focus_ids: Vec<String>,
}

/// A request the engine refuses: exit code 2.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid {
    pub code: &'static str,
    pub message: String,
}

impl Invalid {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Invalid { code, message: message.into() }
    }

    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "schema": RESPONSE_SCHEMA,
            "status": "invalid",
            "error": { "code": self.code, "message": self.message },
        })
    }
}
