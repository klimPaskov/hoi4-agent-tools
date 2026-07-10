# Performance benchmark

Performance is recorded by an explicit developer command, not by a required CI timing assertion:

```bash
npm ci
npm run benchmark
```

The command prints a structured JSON report to stdout and exits nonzero only for correctness failures such as a fixture below its required size, a changed deterministic output, or unsafe cache invalidation. It has no elapsed-time or memory pass threshold. Timing and memory naturally vary by host, runtime, system load, and native codec build.

## Workload and methodology

The benchmark reads only checked-in, project-owned synthetic fixtures:

- `fixtures/focus`: 255 focuses in ten route families, scanned and indexed through `CoreEngine`, then laid out, linted, rendered, and stored through `FocusWorkbench`;
- `fixtures/gui`: 158 source elements and 203 visible scene elements, rendered through `ScriptedGuiStudio` as fourteen state scenes, three resolution/UI-scale scenes, five primary variants, comparison evidence, and 24 stored artifacts;
- `fixtures/map`: the complete 256×256 map fixture across game, dependency, and mod fixture roots, scanned and indexed through `AgentNudger`, then rendered in all ten current base layers (including continent) with all twelve current overlays enabled;
- a temporary copy of the focus workspace for metadata/content-hash cache checks.

The 255-focus fixture's 13,152×3,600 raster (47,347,200 pixels) is intentionally below the fixed 48-Mi-pixel per-artifact ceiling. The vanilla 5,632×2,048 map is also below the ceiling at scale 1, and its diff/before/proposed output trio charges 34,603,008 of the 64-Mi-pixel aggregate request budget. Larger scale or variant combinations are refused before allocation rather than included in benchmark timing.

Each workload runs twice in one process. **Cold** means the first invocation using a fresh service and empty temporary artifact/cache roots. **Warm** means the immediate repeat in the same Node process. The script does not evict the operating system's file cache, so “cold” is an application-level cold run, not a physical-disk cold run. With `--expose-gc`, garbage collection is requested before each measured pass.

Elapsed values use the monotonic Node performance clock. Memory is the process endpoint measurement from `process.memoryUsage()`, not a sampled peak. RSS includes native allocations from Sharp/libvips; because suites run sequentially, native allocator retention can affect later baselines and deltas. One cold and one warm pass keep the command bounded; rerun it several times externally when investigating variance.

The GUI total deliberately includes an explicit source scan followed by `renderAndStore`, which performs its own scan as part of the public workflow. The map render phase operates on the fully scanned index and renders all base layers without artifact-store I/O. Output fingerprints must match between cold and warm passes.

## Recorded result

Recorded at `2026-07-10T22:22:50.905Z` with this exact command from the repository root:

```bash
npm run benchmark
```

Runtime and platform:

- Windows (`win32`) release `10.0.26200`, x64;
- AMD Ryzen 5 7500F 6-Core Processor; 12 logical processors;
- 32,375.906 MiB total physical memory;
- Node.js `v24.15.0`, V8 `13.6.233.17-node.48`;
- Sharp `0.35.3`, libvips `8.18.3`.

Times are milliseconds. Memory columns are endpoint delta MiB for the measured pass.

| Workload                       | Pass |      Total |           Scan/index |                      Layout or render/store |   RSS Δ | Heap-used Δ |
| ------------------------------ | ---- | ---------: | -------------------: | ------------------------------------------: | ------: | ----------: |
| Focus (255 nodes)              | Cold | 15,082.652 |               36.402 | layout 62.085; lint/render/store 14,983.948 |  21.820 |      12.223 |
| Focus (255 nodes)              | Warm | 16,721.268 |                8.274 | layout 59.933; lint/render/store 16,652.932 |  55.937 |       4.343 |
| GUI (158 source / 203 visible) | Cold | 11,507.893 | 59.041 explicit scan |             gallery render/store 11,448.837 | 200.343 |      47.387 |
| GUI (158 source / 203 visible) | Warm |  5,607.155 | 46.417 explicit scan |              gallery render/store 5,560.708 |  49.492 |      48.742 |
| Map (65,536 pixels)            | Cold |    852.390 |               31.467 |        ten layers × twelve overlays 820.908 | -38.598 |      58.195 |
| Map (65,536 pixels)            | Warm |    671.601 |               21.518 |        ten layers × twelve overlays 650.073 |  20.762 |      30.028 |

Relevant output and input counts from the same run:

| Workload | Counts                                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focus    | 8 scanned files; 255 focuses; 10 route families; 6 artifacts                                                                                                                          |
| GUI      | 7 scanned files; 158 source elements; 203 visible elements; 14 states; 3 resolutions; 5 primary variants; 24 artifacts; 14,455,435 output bytes                                       |
| Map      | 21 scanned files / 198,897 bytes; 65,536 pixels; 5 definition rows; 4 provinces with geometry; 3 states; 2 strategic regions; 10 base layers; 12 overlays per layer; 14,339 PNG bytes |

Cold and warm output fingerprints matched for all three workloads.

## Cache invalidation behavior

`WorkspaceScanner` reads file metadata and bytes on every scan and computes a SHA-256 content hash. `CoreEngine` derives its revision from each file's display path, load order, and content hash, then keys its in-memory scan/index cache by workspace ID and revision. Size and modification time are recorded as evidence but are not trusted as the semantic cache key.

Scan admission normally serializes physical scans for a workspace. If a scanner ignores cancellation, one replacement scan may run after the original request is aborted so current callers are not held behind abandoned work. At most two physical scanners may exist for that workspace in this state; a third request waits. Generation fencing prevents a stale late completion from replacing the current cache entry.

The benchmark changes only the copied fixture's modification time and confirms that the revision remains unchanged and the in-memory snapshot is reused. It then changes source bytes without changing file size or modification time and confirms that the content hash changes, the revision changes, and the cached snapshot is not reused. In the recorded run:

- baseline scan: 21.353 ms;
- metadata-only rescan/cache hit: 5.431 ms;
- same-size, same-mtime content change/rescan: 20.300 ms.

The deterministic unit test in `tests/unit/core-cache.test.ts` continuously checks this correctness property without asserting timing. Explicit transaction apply/rollback paths also invalidate the workspace cache; the content-derived revision remains the safety backstop for external edits.

The Scripted GUI Studio and Agent Nudger benchmark paths currently rebuild their domain scans/indexes on each call. Their warm figures therefore reflect runtime/JIT and operating-system cache effects rather than a domain-level memoization claim. Stored artifacts are content-addressed, but artifact storage is not treated as a parsed-source cache.

## Reproducing and comparing runs

Run from a clean install on the host being measured:

```bash
npm ci
npm run --silent benchmark > benchmark-result.json
```

No game installation, mod workspace, environment variable, network access, or proprietary input is used. The script creates all runtime storage below the operating system temporary directory and removes it on completion. Compare the JSON phase timings, memory samples, counts, and runtime/platform block; do not compare only the total time across unlike hosts.

To check cache correctness without collecting performance data:

```bash
npm test -- tests/unit/core-cache.test.ts
```

## Opt-in installed-data qualification

The opt-in local suite is a compatibility qualification, not a CI performance threshold. It reads configured installed-game and external-mod roots in place, writes only to an operating-system temporary directory, and neither launches the game nor copies proprietary inputs into the project.

On the same Windows/Node host documented above, the final `2026-07-10` qualification completed all three required tests through the fail-closed `npm run test:local` harness:

| Workflow                                                                                                    |   Elapsed |
| ----------------------------------------------------------------------------------------------------------- | --------: |
| Large vanilla focus import, stable layout, and two deterministic renders, plus an external-mod focus render |  83.551 s |
| External GUI/GFX/font graph construction and two deterministic full/annotated renders                       |  56.019 s |
| External map scan plus state/coastline/supply/railway render and content-addressed PNG/JSON/HTML storage    |  22.981 s |
| Total test time                                                                                             | 162.578 s |

The GUI qualification's canonical source-graph JSON was 302,497,021 bytes. The default
134,217,728-byte per-object ceiling remained enabled: storage produced a byte-exact three-chunk
resource bundle plus its canonical index, repeated the same render/storage call, and verified
deterministic output without truncating the graph or increasing the ceiling.

The reporter independently confirmed three completed tests and no unhandled worker error. Root paths and source-derived content are intentionally absent from the report. These timings vary with installed data, disk/cache state, processor, memory, and codec versions; only completion and deterministic/correct output are assertions.
