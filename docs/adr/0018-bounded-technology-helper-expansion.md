# ADR 0018: Bounded technology helper expansion

- Status: accepted
- Date: 2026-07-26

## Decision

Technology scans automatically choose a focused graph for workspaces with a game root or more than 1,000 scanned files. Focused graphs retain technology definitions, placements, paths, direct external references, scripted-effect calls, diagnostics, and source locations, but do not materialise the workspace-wide projection of every scripted-effect call into every grant or bonus reference.

The graph records `analysisMode: "focused"`, marks the result partial when helper calls are present, and adds the `TECH_HELPER_EXPANSION_DEFERRED` unresolved boundary. Small synthetic workspaces and explicit internal full builds keep the existing complete helper projection.

## Rationale

Vanilla plus a large mod can contain thousands of scripted effects and hundreds of thousands of helper paths. Expanding all of them in one request consumed multiple gigabytes and left the MCP process alive long enough for a client timeout to close the stdio transport. Keeping the structural call index makes the technology and doctrine graph responsive while preserving evidence needed for source-linked follow-up work.

## Consequences

Large `hoi4.tech_inspect` calls return through the same MCP transport instead of timing out during graph construction. Reports identify the focused boundary and remain resource-backed. The tool does not claim complete helper attribution for a focused graph; direct references and all indexed helper calls remain available in the linked graph artifact.
