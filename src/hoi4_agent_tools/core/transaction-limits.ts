// A generated world holds thousands of state and region files, and a whole-mod content apply
// (ADR 0047 amendment) more than 8,000; a manifest entry is about 1 KB, so 15,000 files fit
// the 32 MiB authenticated manifest cap with room for longer paths.
export const TRANSACTION_MAX_FILES = 15_000;
export const TRANSACTION_MAX_OPERATIONS = 1_000;
export const TRANSACTION_MAX_VALIDATION_CHECKS = 100;
export const TRANSACTION_MAX_DIAGNOSTICS = 100;
export const TRANSACTION_MAX_ARTIFACTS = 6_000;
export const TRANSACTION_MAX_APPLIED_FILES = TRANSACTION_MAX_FILES;
export const TRANSACTION_MAX_READ_DEPENDENCIES = 10_000;
export const TRANSACTION_MAX_MANIFEST_BYTES = 33_554_432;
/** Smallest replacement batch: one intent and one checkpoint manifest write per batch. */
export const TRANSACTION_MAX_PENDING_FILES = 16;
/** Large transactions use bigger batches, so they write the manifest about this many times. */
export const TRANSACTION_TARGET_BATCHES = 64;
/** Largest replacement batch, bounding the identity checks one intent records. */
export const TRANSACTION_MAX_BATCH_FILES = 256;

/**
 * Files per replacement batch. Every batch rewrites the whole manifest twice, and the manifest
 * grows with the file count, so fixed batches made large applies quadratic; up to 1,024 files
 * the batch stays at 16 as before.
 */
export function transactionBatchSize(files: number): number {
  return Math.min(
    TRANSACTION_MAX_BATCH_FILES,
    Math.max(TRANSACTION_MAX_PENDING_FILES, Math.ceil(files / TRANSACTION_TARGET_BATCHES)),
  );
}
// A maximum-size world needs before/after blobs plus staging and rollback copies.
export const TRANSACTION_MAX_JOURNAL_BYTES = 1_073_741_824;
