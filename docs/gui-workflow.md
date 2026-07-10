# Scripted GUI Studio

Scripted GUI Studio builds an offline source graph across `.gui`, `.gfx`, `common/scripted_guis`, localisation/scripted localisation, sprites/textures, frame animation, fonts, decision entry points, parents/contexts, button effects, triggers, properties, dynamic lists, and AI behavior.

It does not launch, automate, hook, or capture the game. Output is always labelled an offline representation.

## Preview scenarios

A scenario selects resolution, UI scale, root window, rendered state, global animation sample time, optional time-since-visible, explicit frame overrides, and mock country/state/variables/flags/lists/localisation/scripted-GUI values. `play_on_show = yes` samples `visibleTimeSeconds` (or the global clock when it is omitted); other animations sample `animationTimeSeconds`. Non-looping sprites clamp to the final frame, and looping sprites honor `pause_on_loop`. The exact scenario and source revision are stored with every artifact so another coding agent can reproduce it.

Required state coverage includes normal, hover, selected, locked, disabled, warning, active, completed, empty/full list, minimum/maximum values, long text, and missing localisation.

## Renderer

The renderer resolves nested parent offsets, positions, sizes, scale, clipping, z-order, sprite dimensions/frame strips, text alignment/wrapping, font metrics/kerning, button/icon states, list rows, visibility, and selected animation frames. Scanned TTF/OTF text is rendered from fontkit outline paths and uses the scanned ascent as its baseline. Scanned BMFont text defaults to the font's native `info size` when the GUI element has no `fontSize`, uses `common lineHeight` and `base`, and composes bounded crops of declared atlas pages with parsed offsets, advances, and kerning. Artifact-owned labels and unavailable workspace glyph data use paths from the pinned redistributable project font, so SVG-to-PNG output never depends on fonts installed on the host. It produces:

- full and cropped PNG/SVG renders;
- annotated bounds/ID render;
- click-region overlay;
- hierarchy and source-location reports;
- state gallery;
- resolution/UI-scale gallery;
- before/after comparison;
- JSON layout and fidelity reports.

Generated PNGs are real compositions from parsed synthetic or workspace assets, not placeholder diagrams.

Standalone comparison artifacts are bound to the exact source graph used for both renders. Their JSON evidence records both complete preview scenarios, both source revisions, both full fidelity reports, and the deterministic bitmap-diff statistics; PNG and JSON manifests repeat bounded fidelity summaries for both scenarios.

Studio discovery is two phase. `gui_scan` indexes configured `roots.interface`, `roots.gfx`, `roots.scriptedGui`, and `roots.localisation` definitions plus the fixed decision, scripted-localisation, font-definition, and animation-manifest paths. It does not eagerly read every texture in an installed game. Lint and render calls then resolve only the selected window's transitive sprites, static fallbacks, fonts, BMFont pages, and animation source frames by safe exact path or unique basename.

The complete source graph is never truncated to fit artifact storage. If its canonical JSON exceeds
the configured per-object ceiling, `gui_scan` and render storage return a `*.chunks.json` logical
artifact index. Its ordered content-addressed resource links reconstruct the exact original JSON
bytes and hash. The index, chunks, and their provenance manifests are admitted and rolled back as
one bounded artifact batch; all physical objects still consume the configured byte and entry
budgets. See [Artifact resources](artifacts.md) for the index format and reconstruction rule.

If an active definition source exceeds a fixed parser byte, line, token, entry, or nesting limit, broad GUI discovery skips that whole source before content sniffing or graph traversal. `gui_scan` returns `GUI_SCANNED_PARTIAL`, `complete: false`, the total skipped-source count, and a bounded source sample in both structured output and the graph artifact. Missing references become partial-inventory warnings only when the skipped source family could define that exact target kind; an unrelated capped source does not weaken validation. A lint/render target that cannot be found because a GUI definition source was skipped, and a patch aimed directly at a capped source, refuse with `GUI_TARGET_SOURCE_SKIPPED_LIMIT`.

Localisation is selected with the same bounded approach. Discovery indexes `l_english`; lint, render, state, resolution, and comparison calls derive the complete language set from their preview scenarios and scan those exact language directories. A French scenario therefore resolves `l_french` source without retaining every unrelated installed translation.

## Fidelity report

Every render groups fields into:

- `modelled`: represented from source values;
- `approximated`: deterministic but not asserted engine-identical;
- `ignored`: known nonvisual or intentionally excluded fields;
- `missing`: referenced asset/font/localisation is unavailable;
- `unsupported`: parsed construct has no renderer implementation;
- `unresolved`: dynamic value is absent from the scenario.

The report includes scenario, source revision, resolution, UI scale, state, font/asset hashes, and renderer version. `font_glyph_rendering` is modelled only when the rendered line comes from scanned TTF/OTF outlines or BMFont atlas glyphs with a declared baseline; a project-font or missing-baseline substitution is approximated and missing code points are separately reported. Every parsed element attribute is classified: attributes actually consulted by the scene model are `modelled`, while fields such as tooltips, sounds, shortcuts, engine-only window animation, and `fixedsize` are explicitly `ignored` until their behavior is represented. A missing or unsupported field is never given an invented appearance.

The primary frame of `textSpriteType`, `corneredTileSpriteType`, GFX `progressbarType`, and `maskedShieldType` can be shown for source review, but their engine text generation, tiling, progress composition, and masking semantics are not implemented. `textureFile2` and `effectFile` are retained in the source graph but are not composited or executed. Each affected element therefore receives explicit unsupported fields, an approximated `sprite_frame`, and a `GUI_SPRITE_RENDER_PARTIAL` warning; it is never labelled as a fully modelled appearance.

## Bounded resource admission

Studio discovery, graph construction, validation, and rendering use fixed process-safety ceilings. A render admits no more than 512 distinct raster/native-image operations, including selected GUI assets, galleries, focus icons, render plans, and bitmap comparisons. Rendered text is limited to 16,384 characters per element, 262,144 aggregate characters per scene, and 32,768 layout operations while preserving BMFont kerning across wrapping decisions.

BMFont text inputs stop at 2,097,152 bytes, 50,000 records, 32 fields per record, 256 pages, 32,768 characters, and 32,768 kerning pairs; binary font inputs stop at 8,388,608 bytes. Missing-glyph evidence retains 64 samples. Source-graph admission fails before retaining more than 50,000 GUI elements, 500,000 total nodes, or 1,000,000 edges; expanded scenes stop at 10,000 elements. Validation stops at 2,000 diagnostics, 2,000,000 pair comparisons, or 2,000,000 ancestor hops. Exceeding a bound returns an explicit blocker instead of a partial render, unbounded validation pass, or invented approximation.

## Source-preserving plans

Existing `.gui` files accept only hash-bound patches at parser-proven ranges. A patch may replace one known scalar assignment or scalar value, delete one known scalar assignment, or insert complete parsed entries immediately before a block close. Whole-file ranges, block rewrites, unknown-field rewrites, malformed insertions, stale text, and ambiguous ranges are refused. New files may be supplied in full only when no mod, dependency, or game source already owns the path. Every proposal is reparsed and rendered before it can become a transaction.

## Validation

The studio checks visible overlap, clipping, overflow, spacing, invalid size, child/clip escape, visual/click mismatch, invisible blockers, conflicting click regions, missing assets/fonts/localisation, frame/sheet/fallback errors, parent/context errors, z-order risks, cut scroll rows, resolution drift, conflicting tab states, button trigger/effect gaps, cost disagreements, AI equivalence, and renderer fidelity blockers.

Actual font metrics drive text checks; OCR is not used. GUI costs are derived from standard `£icon amount` tokens in the button's referenced localisation and compared with direct negative scripted-GUI resource effects such as `add_political_power = -12`. Diagnostics link the localisation, GUI element, and scripted effect source locations. Scenario `guiCosts`/`scriptCosts` remain optional preview assertions but are not the source-validation path.

## Animation source manifests

A project-owned animation may provide one manifest at `hoi4_agent/animation_sources/<animation>/manifest.json`, validated by `schemas/gui-animation-source.schema.json`. The manifest identifies the `frameAnimatedSpriteType`, final sheet path and hash, cell dimensions, independently authored source-frame paths/hashes/anchors, animation settings, and a source-derived static fallback.

For a selected window, the public Studio path verifies:

- manifest and sprite frame counts and animation settings;
- source, sheet, and fallback SHA-256 hashes;
- supported and identical source-frame dimensions;
- distinct source bytes and distinct decoded artwork;
- stable in-frame anchors;
- exact decoded pixels from each source frame against its sheet cell;
- sheet dimensions and declared sprite size;
- static-fallback sprite/path/hash/dimensions and exact equality to its declared source frame.

Without a manifest, the composed sheet remains renderable but validation emits `GUI_ANIMATION_SOURCE_PROVENANCE_UNAVAILABLE`; it is not accepted as proof of independent frames. Rendering checks cancellation between bounded element chunks and variants without changing deterministic output.
