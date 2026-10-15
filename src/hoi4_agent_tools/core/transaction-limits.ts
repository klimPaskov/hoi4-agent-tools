// A generated world can contain thousands of state/region files. Review collections
// remain bounded independently of the unchanged 16 MiB authenticated manifest cap.
export const TRANSACTION_MAX_FILES = 5_000;
export const TRANSACTION_MAX_OPERATIONS = 1_000;
export const TRANSACTION_MAX_VALIDATION_CHECKS = 100;
export const TRANSACTION_MAX_DIAGNOSTICS = 100;
export const TRANSACTION_MAX_ARTIFACTS = 6_000;
export const TRANSACTION_MAX_APPLIED_FILES = TRANSACTION_MAX_FILES;
export const TRANSACTION_MAX_READ_DEPENDENCIES = 10_000;
export const TRANSACTION_MAX_MANIFEST_BYTES = 16_777_216;
export const TRANSACTION_MAX_PENDING_FILES = 16;
// A maximum-size world needs before/after blobs plus staging and rollback copies.
export const TRANSACTION_MAX_JOURNAL_BYTES = 1_073_741_824;
