# ADR 0012: Autonomous one-call rewrites over internal durable journals

- Status: accepted
- Date: 2026-07-12

## Context

The original public write protocol exposed planning as a dry-run transaction and required a coding agent to carry a transaction ID and plan hash through separate diff, apply, status, and rollback calls. Those checks protected source integrity, but the caller choreography conflicted with the product's agent-first model: an operator had already selected the allowed roots and principals, yet an authorized agent still had to perform a second transaction-approval protocol before completing one supported edit.

The integrity properties supplied by the shared transaction engine remain necessary. A multi-file HOI4 rewrite must still validate the complete proposal, reject stale input, journal exact original bytes, prevent cross-workspace access, recover from interrupted replacement, validate the written result, and restore the original state on failure.

## Decision

The server remains read-only by default. An operator may explicitly opt a canonical mod workspace into effective `writePolicy: "autonomous"`. That policy authorizes the supported domain rewrite tools for the already allowlisted workspace; it does not make game, dependency, fixture, artifact, cache, state, or unrelated roots writable.

The primary mutating MCP surface is one call per domain:

- `focus_rewrite`
- `gui_rewrite`
- `map_rewrite`

Each rewrite call performs one server-owned sequence:

1. authenticate and authorize the principal, workspace grant, and transport write scope;
2. resolve every target beneath the canonical writable mod root;
3. calculate the complete affected-file set and proposed bytes;
4. run mandatory in-memory validation and produce relevant source and visual evidence;
5. acquire the workspace lock and recheck roots, ownership, and all source hashes;
6. persist an authenticated internal journal containing exact before bytes and intended replacements;
7. stage and replace the affected files with recoverable logical atomicity;
8. rebuild the affected index and run mandatory post-write validation;
9. restore exact original bytes automatically if a write or required validation check fails; and
10. return the completed rewrite outcome, diagnostics, changed files, and evidence resources.

A blocker detected before mutation returns without changing source. A caller does not receive or resubmit a transaction ID or expected plan hash, page through a transaction diff as an authorization step, make a separate apply call, or invoke rollback. Internal plan hashes, manifests, protected revision heads, before blobs, and recovery states remain server implementation details and audit evidence where safe to expose in sanitized form; they are not bearer capabilities or caller approval tokens.

An explicitly enabled `writePolicy: "transactions"` mode may remain as a compatibility surface for existing clients. It is not the primary documentation, prompt, example, discovery, or acceptance path, and autonomous acceptance cannot depend on its manual tools.

Remote deployment retains the HTTP decision in ADR 0011: every request is authenticated, present Origin and Host values are checked, non-loopback access requires the configured HTTPS OAuth/OIDC policy, write calls require write scope, sessions are credential-bound routing state, and principal-to-workspace grants remain authoritative. Runtime registration cannot elevate itself to autonomous write authority; that authority must come from operator-controlled configuration or an equally explicit operator capability for the canonical root.

ADR 0007 remains authoritative for per-workspace storage, authenticated journals, locking, exact-byte recovery, and crash reconciliation. This decision supersedes only the interpretation that ADR 0007's transaction ID and plan hash must form the primary caller workflow.

## Rationale

The operator's explicit workspace policy is the durable authorization decision. Repeating that decision through a server-specific multi-call confirmation protocol adds agent steps without expanding the filesystem or principal boundary. Keeping the complete safety sequence inside the mutating call gives an authorized coding agent a reliable one-call capability while retaining the protections that matter at the write boundary.

Read-only scan, lint, layout, render, compare, and validation tools remain available for analysis and evidence. They are useful inputs to agent reasoning, but an autonomous rewrite does not depend on a mandatory preview transaction. A coding-agent host may still apply its own generic tool-use policy; the server protocol does not require a host-specific confirmation interface.

## Consequences

Public schemas, tool descriptions, prompts, examples, and acceptance tests use the domain rewrite tools and must not require transaction IDs, expected plan hashes, manual diff/apply sequences, or explicit rollback. Successful rewrites return review and validation evidence after the server has completed its protected sequence.

Recovery is automatic for failed or interrupted rewrites. Intentional reversal of a successful accepted change is a new source edit through version control or another authorized rewrite, not a caller-invoked journal rollback capability.

The server still provides recoverable logical atomicity rather than an operating-system transaction. Another process may briefly observe replacement steps, while stale-source checks and final validation prevent the server from reporting success for an unverified mixed state. Shared-filesystem deployments still require single-writer coordination as specified by ADR 0007.
