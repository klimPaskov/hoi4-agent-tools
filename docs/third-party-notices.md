# Third-party notices

## Roboto

HOI4 Agent Tools depends on `@fontsource-variable/roboto` version 5.3.0 for deterministic, host-independent artifact labels and the project-owned synthetic BMFont fixture.

Copyright 2011 The Roboto Project Authors (<https://github.com/googlefonts/roboto-classic>). Roboto-Italic[wdth,wght].ttf: Copyright 2011 The Roboto Project Authors (<https://github.com/googlefonts/roboto-classic>).

Roboto is licensed under the SIL Open Font License, Version 1.1 (`OFL-1.1`). The complete license text is distributed as `LICENSE` in the installed `@fontsource-variable/roboto` package. The font package is pinned in `package.json` and the published `npm-shrinkwrap.json`; generated SVG/PNG documents may contain derived glyph outlines or pixels as permitted by the OFL.

## Offline reference-image OCR

`tesseract.js` version 7.0.0 and its `tesseract.js-core` dependency provide the local WebAssembly OCR engine under Apache-2.0. English trained data is installed through `@tesseract.js-data/eng` version 1.0.0. That package declares MIT licensing for its packaging; its upstream [tessdata repository](https://github.com/naptha/tessdata) distributes Tesseract language data under [Apache-2.0](https://github.com/naptha/tessdata/blob/gh-pages/LICENSE). The project uses the unmodified `4.0.0_best_int/eng.traineddata.gz` model from the dependency. No reference artwork or language model is copied into project fixtures or source assets.

These dependencies are pinned by `package.json` and `npm-shrinkwrap.json`. OCR uses the installed worker, engine and language bytes without runtime network downloads or external OCR executables. The engine and language data retain their upstream licenses.

The application source remains licensed under Apache-2.0 as stated in the repository [LICENSE](../LICENSE). Third-party components retain their respective licenses.
