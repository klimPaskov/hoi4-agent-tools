//! Deterministic layout engine for Hearts of Iron IV focus trees.
//!
//! `layout` places every `auto` focus of a tree (fixed and relative focuses stay where they are);
//! `insert` places a new branch among focuses that keep their coordinates exactly. Both read and
//! write the JSON contract in `model` (documented in this crate's `README.md`). The engine never
//! edits prerequisites or exclusions; its hashes let callers check that.

pub mod band;
pub mod canonical;
pub mod geometry;
pub mod model;
mod ops;
pub mod place;
pub mod tree;

use std::time::Instant;

pub use model::{Invalid, Request, Response};

/// Parses and runs one request.
pub fn respond(text: &str) -> Result<Response, Invalid> {
    let started = Instant::now();
    let request: Request = serde_json::from_str(text).map_err(|e| Invalid::new("FOCUS_ENGINE_REQUEST_INVALID", format!("request is not valid: {e}")))?;
    run(&request, started)
}

/// Runs a parsed request.
pub fn run(request: &Request, started: Instant) -> Result<Response, Invalid> {
    if request.schema != model::REQUEST_SCHEMA {
        return Err(Invalid::new("FOCUS_ENGINE_SCHEMA_UNSUPPORTED", format!("schema must be {}, not {}", model::REQUEST_SCHEMA, request.schema)));
    }
    ops::run(request, started)
}

/// The response or error as pretty JSON with a final newline, and the exit code (0 or 2).
pub fn respond_json(text: &str) -> (String, u8) {
    match respond(text) {
        Ok(response) => (to_json(&response), 0),
        Err(invalid) => {
            let mut out = serde_json::to_string_pretty(&invalid.to_json()).expect("serializable");
            out.push('\n');
            (out, 2)
        }
    }
}

pub fn to_json(response: &Response) -> String {
    let mut out = serde_json::to_string_pretty(response).expect("serializable");
    out.push('\n');
    out
}
