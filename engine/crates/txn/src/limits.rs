//! Fixed limits of the atomic rewrite engine.
//!
//! Ported from `src/hoi4_agent_tools/core/transaction-limits.ts` (all constants and
//! `transactionBatchSize`), commit `9b7dc80d`.

/// A generated world holds thousands of state and region files, and a whole-mod content apply
/// more than 8,000; 15,000 files fit the manifest cap with room for longer paths.
pub const MAX_FILES: usize = 15_000;
pub const MAX_DIAGNOSTICS: usize = 100;
pub const MAX_MANIFEST_BYTES: u64 = 33_554_432;
/// Smallest replacement batch: one intent and one checkpoint manifest write per batch.
pub const MAX_PENDING_FILES: usize = 16;
/// Large plans use bigger batches, so they write the manifest about this many times.
pub const TARGET_BATCHES: usize = 64;
/// Largest replacement batch, bounding the identity checks one intent records.
pub const MAX_BATCH_FILES: usize = 256;
/// A maximum-size world needs before blobs plus staging and rollback copies.
pub const MAX_JOURNAL_BYTES: u64 = 1_073_741_824;
/// Journals kept at once in one workspace (`maxJournals` of the TypeScript manager).
pub const MAX_JOURNALS: usize = 128;
/// A journal folder without a manifest is removed once it is older than this.
pub const JOURNAL_TTL_SECONDS: u64 = 3_600;

/// Files per replacement batch. Every batch rewrites the whole manifest twice, and the manifest
/// grows with the file count, so fixed batches made large applies quadratic; up to 1,024 files
/// the batch stays at 16.
pub fn batch_size(files: usize) -> usize {
    MAX_BATCH_FILES.min(MAX_PENDING_FILES.max(files.div_ceil(TARGET_BATCHES)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ported from `tests/unit/transaction-size.test.ts` ("keeps 16-file batches for ordinary
    /// rewrites and bounds the manifest writes of large ones").
    #[test]
    fn keeps_small_batches_and_bounds_large_ones() {
        assert_eq!(batch_size(1), 16);
        assert_eq!(batch_size(1_024), 16);
        assert_eq!(batch_size(1_025), 17);
        assert_eq!(batch_size(5_051), 79);
        assert!(12_000_usize.div_ceil(batch_size(12_000)) <= TARGET_BATCHES);
        assert!(batch_size(MAX_FILES) <= MAX_BATCH_FILES);
        assert_eq!(batch_size(100_000), MAX_BATCH_FILES);
    }
}
