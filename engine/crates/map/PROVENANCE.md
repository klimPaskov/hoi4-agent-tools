# Provenance: hoi4-map

Sources this crate adapts, one row per adapted file. Every source is in
`klimPaskov/hoi4-agent-tools` at commit `9b7dc80d`.

| Rust file | Adapted from | Functions |
| --------- | ------------ | --------- |
| `src/parse/source.rs` | `src/hoi4_agent_tools/core/source/encoding.ts`, `lexer.ts`, `parser.ts`, `limits.ts` | `decodeSource`, `createSourceLineIndex`, `positionAt`, `locationFor`, `lexClausewitz`, `parseClausewitz`, `assignments`, `childBlocks`, `firstScalar`, `nodeLocation`, `SourceDiagnosticCollector` |
| `src/parse/text.rs` | `src/hoi4_agent_tools/map/model.ts` | `parseTextDocument`, `lineLocation`, `splitDelimitedRow`, `whitespaceRow`, `parseInteger`, `parseNumber`, `parseMapDate` |
| `src/parse/localisation.rs` | `src/hoi4_agent_tools/core/source/localisation.ts` | `parseLocalisation`, `decodeLocalisationValue` |
| `src/parse/bmp.rs` | `src/hoi4_agent_tools/map/bmp.ts`, `src/hoi4_agent_tools/core/render-budget.ts` | `BmpImage.decode`, `rgbAt`, `paletteIndexAt`, `diffBounds`, `offsetAt`, `rgbKey`, `renderDimensionViolation` |
| `src/parse/records.rs` | `src/hoi4_agent_tools/map/model.ts` | `parseDefinitions`, `parseState`, `parseTerrainCategories`, `parseBuildingDefinitions`, `parseContinents`, `parseStrategicRegion`, `parseAdjacencies`, `parseSupplyNodes`, `parseRailways`, `parseBuildingPositions`, `parseUnitPositions`, `parseWeatherPositions`, `parseEntityLocators`, `defaultMapSelectorValue`, `earliestBookmarkDate`, `derivedStateCapital` |
| `src/model/mod.rs` | `src/hoi4_agent_tools/map/model.ts` | `MapWorkspaceIndex`, `MapModelBudget`, `selectActiveFiles`, `definitionFilesAcrossRoots`, `fileInRoots`, `inConfiguredRoot`, `provinceAtMapCoordinate` |
| `src/validate/mod.rs` | `src/hoi4_agent_tools/map/validation.ts` | `validateMap`, `validateDefinitions`, `validateGeometry`, `validateStatesAndRegions`, `validateNetworksAndAdjacencies`, `validatePositions`, `mapValidationChecks`, `sameLandmass`, `contiguousMissing` |
| `src/validate/limit.rs` | `src/hoi4_agent_tools/map/diagnostic-limit.ts` | `addMapDiagnostic`, `addActiveMapDiagnostic`, `addBoundedDiagnostic` |
| `src/validate/crossing.rs` | `src/hoi4_agent_tools/map/gameplay/crossing-validation.ts`, `gameplay/facts.ts` | `validateCrossings`, `checkRules`, `checkRows`, `checkRailways`, `checkUnitPositions`, `parseAdjacencyRules`, `pixelsOf`, `closestApproach`, `wrapDelta` |
| `src/validate/appearance.rs` | `src/hoi4_agent_tools/map/appearance-validation.ts`, `src/hoi4_agent_tools/map/water.ts` | `validateAppearance` and its checks, `landDistanceField` |
| `src/baseline/mod.rs` | `src/hoi4_agent_tools/map/baseline.ts` | `mapBaselineFingerprint`, `mapWriteFootprint` |
| `src/lib.rs` | none (new) | the `map.index` and `map.validate` operations |

The province raster itself comes from `hoi4-engine` (`map_provinces.rs`, ADR 0084) and DDS
decoding from `hoi4-texture`; this crate adapts neither.
