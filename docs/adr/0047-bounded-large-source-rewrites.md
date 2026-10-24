# ADR 0047: Bounded large source rewrites

## Context

A generated world may contain thousands of state, region, country, and supporting files. The shared rewrite engine previously limited a plan to 1,000 files and 512 artifact links, including a separate durable review artifact for each changed file. A valid generated world could therefore fail after generation and validation. Thousands of separate artifact writes and sequential staging also magnified filesystem synchronization latency.

## Decision

The shared transaction engine permits at most 5,000 changed files and 6,000 logical evidence links. Its authenticated manifest remains limited to 16 MiB. Operation, dependency, diagnostic, and validation-check ceilings remain unchanged. Artifact storage still enforces its independently configured byte, entry, and single-resource limits; the transaction ceiling does not enlarge those budgets.

The journal storage allowance is 1 GiB, shared by normal admission and startup recovery. Replacing an existing 4096×3072 world requires about 554 MB when the before/after blobs, staging and rollback copies are counted, exceeding the former 512 MiB allowance even though initial generation fits. Admission still computes the complete working footprint before replacing any source. Limit errors expose only numeric required, retained and maximum byte counts; canonical paths and journal identifiers stay private.

Plans with more than 1,000 changed files store one content-addressed JSON review bundle. It contains every changed path, original media type, before and after source hashes, diff media type, and the complete existing text or binary review diff. Smaller plans retain individual file diff links. A large bundle uses the existing bounded chunked artifact mechanism when its single-resource limit requires it. Its logical artifact link is authenticated with the plan, and optional individual file artifact links are omitted.

Independent path resolution, streaming source verification, journal blob preparation, and staging run in batches of at most 16. Every target retains canonical-path resolution and verified source-blob reads. Each batch joins all successful and failed operations before delivering hooks in source order or beginning cleanup. Source replacements and rollback remain sequential and internal to the shared engine.

New journals use internal transaction protocol version 2. Before replacing any source in a batch, the engine durably records at most 16 pending paths and the exact device/inode identities of their original and staged files. This intent is authenticated and committed to the protected anti-replay head before source mutation. Replacements retain per-file stale checks and occur sequentially. The batch completion checkpoint durably records applied paths and clears pending intent.

Recovery uses pending stage and backup identities to distinguish a completed rename from an untouched pending path. A matching external creation is preserved; ambiguous or externally edited output is refused rather than overwritten. This also covers a new file renamed into place before its completion checkpoint. Version-one journals remain readable and retain their existing apply/recovery path. Their absent optional pending field is never defaulted into authenticated content, and their immutable version-one plan payload and hashes remain unchanged.

During the replacement loop only, immutable manifest fields use a request-local snapshot of their canonical JSON bytes. The snapshot retains no writable source references, stays within the existing manifest byte ceiling, and produces exactly the same serialized bytes, integrity hashes, authentication tags, and protected head hashes as ordinary canonical serialization. Mutable revision and progress fields are serialized on every checkpoint. The snapshot leaves scope before post-write validation; subsequent validation, evidence updates, final status, and recovery use the ordinary serialization path.

Public rewrite structure failures report only allowlisted nonnegative integer counts and their limits. Internal identifiers, paths, source text, and unexpected failure details remain private.

## Consequences

Large worlds retain complete inspectable evidence without thousands of separate review artifacts, and staging can overlap filesystem latency. A failure in one staging operation cannot leave an asynchronous writer running after recovery starts.

Version-two journals advance the authenticated head before and after each replacement batch. They do not rely on an unrecorded interval of source mutations: the durable intent is sufficient to recover a crash at either rename boundary or before completion. Version-one journals continue to use per-file completion checkpoints. Manifest and artifact byte budgets remain fixed and independent of batching.

## Amendment (2026-10-24): whole-mod applies

A mod that applies its whole content tree through the engine (the ZIN overhaul, request ZR-5) changes more than 5,000 files in one apply and will pass 8,000. The file ceiling rises to 15,000 and the authenticated manifest ceiling to 32 MiB: a manifest entry measured about 940 bytes (3.4 to 4.7 MB for 5,051 files), so 15,000 files fit with room for longer paths. The operation, dependency, diagnostic, validation-check and artifact ceilings are unchanged, and the journal ceiling stays a constructor option.

Applying wrote the whole manifest twice for every 16 replaced files (an intent and a checkpoint), and the manifest grows with the file count, so a large apply was quadratic: 632 manifest writes of up to 4.7 MB for 5,051 files. The batch now grows with the file count to about 64 batches (16 files up to 1,024, at most 256), so a large apply writes the manifest about 128 times; up to 1,024 files nothing changes. Recovery already handles pending intents of any length. `TRANSACTION_STRUCTURE_LIMIT` names each exceeded limit and the remedy.
