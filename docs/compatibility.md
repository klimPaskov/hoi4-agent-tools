# Compatibility and versioning

## Runtime and platforms

| Component | Supported                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js   | 22.x and 24.x                                                                                                                                     |
| Windows   | Windows 10/11 x64                                                                                                                                 |
| Linux     | Current x64/arm64 distributions supported by Node and Sharp                                                                                       |
| macOS     | Source package supported; CI coverage may lag Windows/Linux                                                                                       |
| MCP       | Final `2025-11-25` only; initialization requests for other revisions receive `2025-11-25` so clients without that revision can disconnect cleanly |
| HOI4      | Current file formats are capability-scanned; no fixed game installation path                                                                      |

The `2026-07-28` protocol was a release candidate at 0.1.0 development time. Adopting its breaking stateless core and SDK v2 requires a compatibility release after it is final and supported by clients.

The pinned SDK also recognizes `2025-06-18`, `2025-03-26`, `2024-11-05`, and `2024-10-07`, but this server does not claim them: its public contracts use the final revision's structured output and resource-link behavior. Both stdio and Streamable HTTP gate negotiation to `2025-11-25`. After initialization, every Streamable HTTP POST, GET, or DELETE must carry `MCP-Protocol-Version: 2025-11-25`; a missing or different value receives a JSON-RPC error with HTTP status 400.

## Public schemas

Tool names and input/output schemas are public API. Additive compatible changes use a minor release. Removing/renaming a tool or changing accepted/returned meaning requires a major release or a documented deprecation period. Schema version, package version, server implementation version, changelog, container tag, and Registry metadata stay synchronized.

Focus consumers can use `focus-plan.schema.json`, `focus-planning-sidecar.schema.json`, and `continuous-focus-palette.schema.json`. The planning sidecar is hash-bound enrichment data; it is not Clausewitz source and is never loaded by HOI4.

Focus reward import ships a reviewed native-effect identifier catalog derived from the official
HOI4 1.19.2 `effects_documentation.md`. This lets the importer distinguish engine effects from
direct `scripted_effect_id = yes/{ ... }` calls without requiring an installed game at runtime.
Compatibility reviews must refresh the catalog when official effect identifiers change; unknown
effect-position scalars remain source-linked helper references so stale or misspelled calls lint
as missing instead of disappearing.

## Configuration migration

Config has an integer `version`. Unknown versions or fields fail with deterministic diagnostics. A future migration utility must print a reviewable proposed config and never edit a client or workspace silently.
