# ADR 0049: Render worker memory and font provenance

## Context

A stopped job worker previously lost its exit status and stderr. `JOB_WORKER_EXIT` suggested memory exhaustion even when the cause was unknown. Large GUI work also rasterized several full-size canvases concurrently and could leave an oversized warm worker available for another domain request.

Full-workspace qualification of the chemical technology folder produced identical PNGs on the 3.10.0 tag and the installed 4.0.0 build. Cold super-event rendering also completed on 4.0.0. These calls do not establish a 4.0.0 regression or the cause of an earlier unobserved crash.

The super-event description colour was independently reproducible. A bitmap atlas creates an inferred font entry with the same name as a declared `bitmapfont`. Sorting or a later asset load order could select that entry, discarding the declaration's colour and styling. Testing declarations without their atlas files missed this case.

## Decision

The fixed-entry worker host captures exit codes, signals and a bounded stderr tail. Tool errors report a fixed-vocabulary cause without returning stderr, paths or source text. Unexpected-worker logs remain private server-state evidence; normal exits remove their logs and old unexpected logs are pruned.

Workers use the configured heap ceiling, or a quarter of physical memory bounded between 2,048 and 8,192 MiB. Warm workers recycle when their collected heap exceeds either 40% of that ceiling or 2 GiB. GUI variants, comparisons and galleries rasterize sequentially. No workspace grants, public tool arguments or rewrite semantics change.

Declared bitmap fonts outrank inferred atlas entries. Language-specific declarations and authored load order still select among declarations; the atlas continues to supply glyphs through normal asset resolution. Graph edges retain the declaration as the font's source evidence.

## Validation

Synthetic tests distinguish actual heap exhaustion, native crashes, external termination, host stops and uncaught errors; verify bounded heap defaults and sequential rasterization; reject truncated DDS data; and preserve declared dark text when a same-name atlas comes from a later root. The font test fails before the precedence fix. Full-mod renders are private qualification evidence, not game captures or bundled fixtures.
