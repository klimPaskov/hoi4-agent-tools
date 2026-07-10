# ADR 0003: Preservation codecs plus Sharp and font metrics

- Status: accepted
- Date: 2026-07-10

## Decision

Use a preservation-oriented BMP codec for source map bitmaps, dedicated DDS/TGA decoders for game textures, Sharp for deterministic compositing/SVG rasterization/PNG output, fontkit for vector font metrics, and a BMFont parser for game bitmap fonts. Map source files are never round-tripped through a generic image encoder.

## Rationale

Current game assets include DIB40 and DIB124 BMPs, 24-bit RGB maps, indexed 8-bit maps, PNG, TGA, uncompressed and block-compressed DDS, and bitmap-font atlases. Generic decode/re-encode can change BMP headers, palettes, padding, orientation, or untouched pixels. Sharp is well maintained for generated PNG artifacts but is not the source-of-truth map writer.

## Consequences

Each decoded asset reports its exact supported format. Unsupported compression or font behavior is a fidelity item and cannot be silently replaced. PNG artifacts strip unstable metadata. CI uses synthetic project-owned images and a redistributable fixture font.
