# ADR 0003: Preservation codecs plus Sharp and font metrics

- Status: accepted
- Date: 2026-07-10

## Decision

Use a preservation-oriented BMP codec for source map bitmaps, dedicated DDS/TGA decoders for game textures, Sharp for deterministic compositing/SVG rasterization/PNG output, fontkit for vector font metrics and outline extraction, and a BMFont parser plus bounded atlas-crop compositor for game bitmap fonts. Map source files are never round-tripped through a generic image encoder.

SVG and PNG review artifacts never delegate text rasterization to host fonts. Supplied TTF/OTF glyphs become source-hashed SVG outline paths using the scanned ascent; supplied BMFont glyphs become source-hashed atlas crops placed with parsed native size, offsets, advances, line height, baseline, and kerning. Tool-owned headings, diagnostics, and missing-workspace-font substitutions use the exact pinned `@fontsource-variable/roboto@5.2.10` Latin, Cyrillic, Greek, and Vietnamese WOFF2 files. Their combined hash is recorded in SVG markup. Roboto is redistributed under the SIL Open Font License 1.1; see [third-party notices](../third-party-notices.md).

## Rationale

Current game assets include DIB40 and DIB124 BMPs, 24-bit RGB maps, indexed 8-bit maps, PNG, TGA, uncompressed and block-compressed DDS, and bitmap-font atlases. Generic decode/re-encode can change BMP headers, palettes, padding, orientation, or untouched pixels. Sharp is well maintained for generated PNG artifacts but is not the source-of-truth map writer.

## Consequences

Each decoded asset reports its exact supported format. Unsupported compression or font behavior is a fidelity item and cannot be silently replaced. A deterministic project-font substitution is classified as approximated, never as supplied-font fidelity. PNG artifacts strip unstable metadata. CI generates a real BMFont atlas from the pinned redistributable font, verifies distinct glyph crops and fixed SVG placement, and locks both outline-text and complete GUI PNG byte goldens.
