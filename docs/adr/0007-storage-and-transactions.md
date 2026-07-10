# ADR 0007: Per-workspace content-addressed storage and durable journals

- Status: accepted
- Date: 2026-07-10

## Decision

Store indexes, artifacts, rollback blobs, transaction manifests, and locks beneath each registered workspace's ignored `.hoi4-agent/` directory. Artifacts and blobs are content-addressed. Transactions bind the principal, workspace/root fingerprint, source hashes, plan hash, expiry, full affected-file set, validation, and rollback data.

Apply acquires an exclusive workspace lock, rechecks preconditions, stages same-volume files, journals each replacement, validates the result, and restores original bytes on failure. Startup recovery rolls back incomplete journals before accepting writes.

## Rationale

External source remains authoritative and storage never leaks across unrelated workspaces. Content hashes make cache invalidation safe. A database would add migration and recovery complexity without improving the file-centric transaction guarantee.

## Consequences

Atomicity is logical and recoverable across files. Another process can briefly observe replacements in progress; the server never reports success for a mixed state. External edits make apply or rollback stale instead of being overwritten.
