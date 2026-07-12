# ADR 0007: Per-workspace content-addressed storage and durable journals

- Status: accepted
- Date: 2026-07-10

## Decision

Store indexes, artifacts, recovery blobs, transaction manifests, and locks beneath each configured workspace's ignored `.hoi4-agent/` directory or its configured storage root. Artifacts and blobs are content-addressed. Artifact manifests bind the canonical configured-workspace identity.

Internal transactions bind the principal, workspace/root fingerprint, source hashes, plan hash, expiry, full affected-file set, validation, and recovery data. Writable mod workspaces require a canonical non-overlapping operator `serverStateRoot`. A random 256-bit key there HMAC-authenticates the complete mutable journal, and one protected latest-revision head per cache journal prevents replay. Cache-first exact-successor reconciliation covers the single crash window without treating a recomputable public hash as authority.

Apply acquires an exclusive workspace lock, rechecks preconditions, stages same-volume files, journals each replacement, validates the result, and restores original bytes on failure. Startup recovery rolls back incomplete journals before accepting writes.

## Rationale

External source remains authoritative and generated storage never leaks across unrelated configured workspaces or principals. Content hashes make cache invalidation safe. The small isolated state root supplies the secret and monotonic replay boundary that workspace files cannot provide; it is not a source database.

## Consequences

Atomicity is logical and recoverable across files. Another process can briefly observe replacements in progress; the server never reports success for a mixed state. External edits make an internal apply or restoration stale instead of being overwritten.

The built-in lock and automatic crash recovery assume one host owns a workspace cache. Lock metadata includes host and process-instance evidence; a lock from another or unknown host is never cleared automatically. Shared-filesystem deployments require external single-writer coordination and explicit recovery.

POSIX state/key permissions are enforced as `0700`/`0600`. Windows relies on an operator-provisioned dedicated-account DACL because Node has no portable ACL authoring API. Protected heads are removed before expired safe cache journals and retain only the latest revision, bounding server state without permitting old-cache replay.
