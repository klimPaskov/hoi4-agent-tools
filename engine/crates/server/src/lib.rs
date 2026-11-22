//! MCP transport: stdio, Streamable HTTP, authentication, Origin and Host checks, grants, limits,
//! session isolation and the protocol gate (packet P15, ADR 0089 step 8).
//!
//! Ported from `src/hoi4_agent_tools/mcp/transports/`, `src/hoi4_agent_tools/mcp/security/` and
//! the HTTP part of `src/hoi4_agent_tools/core/configuration.ts`; each file names its source in
//! its header and in this crate's `PROVENANCE.md`. Tool wiring comes last (ADR 0089 step 8):
//! until then the server runs only in this crate's tests, and it registers no engine operation.

pub mod auth;
pub mod config;
pub mod error;
pub mod event_store;
pub mod grants;
pub mod headers;
pub mod http;
pub mod jsonrpc;
pub mod limits;
pub mod protocol;
pub mod random;
pub mod session;
pub mod stdio;

use hoi4_core::ops::Registry;

/// Adds this crate's engine operations to the registry `hoi4-engine serve` dispatches through.
/// The transport is the server itself, not an operation, so it adds none.
pub fn register(registry: &mut Registry) {
    let _ = registry;
}
