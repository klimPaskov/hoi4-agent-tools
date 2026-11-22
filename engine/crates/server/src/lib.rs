//! MCP transport: stdio, Streamable HTTP, authentication, Origin and Host checks, grants, limits, session isolation and schemas (packet P15).
//!
//! Skeleton crate of the parallel port (ADR 0091). It will be ported from
//! `src/hoi4_agent_tools/mcp/, schemas/, runtime.ts`; each adapted file names its source in its header and in this
//! crate's `PROVENANCE.md`. Only this crate's packet edits files under `crates/server/`.

use hoi4_core::ops::Registry;

/// Adds this crate's engine operations to the registry `hoi4-engine serve` dispatches through.
pub fn register(registry: &mut Registry) {
    let _ = registry;
}
