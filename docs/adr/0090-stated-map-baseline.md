# ADR 0090: A stated baseline for map writes over pre-existing errors

Status: accepted (coordinator decision under D-18, 2026-11-22, open to the maintainer's overturn; issue 272)

## Context

A map write validates the map before and after the change. Every error after the change whose fingerprint also existed before is kept and marked `pre-existing-baseline`, and a second blocker, `MAP_VALIDATION_OPERATION_UNOWNED`, is added for it. Only warnings and info roll up by code. Errors and blockers are counted one by one against the 100-diagnostic review limit of a transaction (`TRANSACTION_MAX_DIAGNOSTICS`).

On a map that already has many errors, no write can pass. The reported case had 3,957 findings before the change and 45 new ones, so every write was refused with `REWRITE_STRUCTURE_LIMIT`. Raising the limit would not help: each pre-existing error also blocks through its `UNOWNED` blocker. The map validation also keeps only 2,000 findings and counts the rest in one `MAP_DIAGNOSTICS_TRUNCATED` marker. A comparison over a cut list could hide a new error among the omitted ones.

4.18.0, 4.19.0 and main behave the same.

## Decision

**The default stays.** A write that states no baseline is judged exactly as before: every error blocks, pre-existing or new.

**A stated baseline is an explicit opt-in that the host checks.** A full `hoi4.map_inspect` returns `baselineFingerprint`. It is the SHA-256 of the tool version and of the display path, load order and SHA-256 of every file of the map scan. The findings of a full validation follow from exactly these inputs, so equal fingerprints mean equal findings, however many a result lists. A write passes it back as `baselineFingerprint`. The host recomputes the fingerprint on the current source over the same scan and refuses the write with `MAP_BASELINE_STALE` when the two differ. The caller's value is only its opt-in. The host's own computation is the evidence, so a caller cannot invent a baseline.

**With a matching fingerprint:**

- Both validations keep every finding up to 50,000 (`MAP_BASELINE_DIAGNOSTIC_LIMIT`), so none hides behind the 2,000 cut. A validation that is still cut keeps its hard marker, which blocks.
- A pre-existing error that belongs to nothing the write touches no longer blocks. It stays in the evidence as a warning with `attributionStatus: "accepted-baseline"` and its `baselineSeverity`, and its family check no longer fails for it.
- Accepted errors roll up apart from real warnings, one entry per code with the count, samples and the complete validation artifact. The 100-diagnostic limit counts what remains.
- A pre-existing error inside the write's footprint still blocks, as before. So does every new error.
- `create_world` replaces the whole map and has no baseline (ADR 0070). A stated baseline on it is refused with `MAP_BASELINE_NOT_APPLICABLE`.

**The footprint.** An error belongs to the objects its location and related locations name, and to the provinces its details name (`province`, `provinceId`, `provinceIds`, `provinces`).

- A location in a file the write leaves unchanged is untouched.
- A location on a row of a changed province definition file is the province on that row. That province is touched when the write changes its definition row, adds or removes it, or changes any of its pixels. A bitmap whose size changed, or that cannot be compared, touches every province.
- Every other location in a changed file is touched, and so is a path named only in the details.
- An error that names no object at all counts as touched. What cannot be shown to lie outside the write lies inside it.

The result reports `baseline: { stated, matched, accepted, insideFootprint }`.

## Consequences

- A large existing map can be edited in small steps while its old findings are fixed separately. Each step still has to add no error and touch no broken object.
- The finer object model covers province definition rows. States and strategic regions are one object per file, which matches the usual layout of one state or region per file. A file that holds several is treated as one object, so the rule errs toward blocking.
- `hoi4.map_inspect` results gain the `baselineFingerprint` field, and `hoi4.map_rewrite` gains the optional `baselineFingerprint` input. The change is additive, so it ships in a minor version (4.20.0).
- The Rust port of the map (ADR 0089, step 6) carries this behavior, with its tests, onto the engine.
