# Reference world acceptance, 15 October 2026

The private reference world loaded in HOI4 1.19.3.0c01a, entered a campaign, advanced from 1 January to 7 February 1936, moved two infantry divisions between provinces, displayed working supply hubs and rail connections, saved and reloaded. This is acceptance of a provisional map sandbox, not evidence of long-term balance or a finished campaign.

The MCP server performed offline generation and atomic rewrites. Game acceptance was a separate, explicitly authorized private Linux evaluation using an isolated profile, display and shared game lease. The product contains no game launcher or control API. The Windows game and launcher playset were not controlled. Private artwork, generated mod source and game screenshots are not included in this repository or npm package.

## Input and measured runs

The original reference was a 447,024,071-byte, 17,520×12,720 colored-pencil mosaic with handwritten names and sheet joins. Its bytes were preserved and hashed. The final input was a separately cleaned raster, visually checked against the original. Small outlines remain approximate. Reviewed names were supplied separately from terrain pixels.

| Run                                               | Result                                                                                          | Elapsed   |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------- |
| Original-art baseline preview                     | 12,947 provinces, 1,595 states; lettering, seams and many small fragments remained              | 67.339 s  |
| First complete original-art rewrite               | 7,765 provinces, 816 states; native loading exposed tiny fragments and an extra building record | 77.827 s  |
| Cleaned input preview                             | 7,413 provinces, 814 states; two undersized lake/ocean pockets remained                         | 65.692 s  |
| Cleaned regeneration after water-component repair | 7,406 provinces, 814 states, 359 regions; obsolete generated files retired safely               | 123.993 s |
| Starting scenario and native compatibility update | 457 changed files; same geography, correct localised state names and country colors             | 75.991 s  |
| Fresh actual-map terrain render                   | Current generated map through `hoi4.map_inspect`                                                | 25.682 s  |

These are local wall-clock observations with concurrent work, not isolated benchmark guarantees. A full-world write includes source validation, durable rollback data and post-write checks. Replacing the complete raster set required about 554 MB of working journal space, exceeding the former 512 MiB cap; the bounded allowance is now 1 GiB.

## Generated content and native observations

The accepted 4096×3072 geography contains 13 countries, 6,444 land provinces, 785 sea provinces, 177 lake provinces, 814 states, 359 strategic regions, 817 victory-point settlements, 292 ports, 814 supply hubs, 544 railway records and 64 rivers. Country boundaries, capitals, demographics, industry, resources and relief are provisional assumptions.

The native test verified country selection, flags, provisional governments, a campaign start, two equipped infantry divisions, movement to another province, supply, time advancement and save/reload. State names in native supply tooltips initially inherited vanilla localisation; putting generated names in the localisation replacement folder fixed that. Explicit country color declarations align native political colors with the flags and offline preview. Building positions omit a final empty CSV record. The original tiny-province and one-pixel border messages disappeared after cleanup.

## Remaining limits

- Offline validation still reports 710 narrow-corridor and 59 enclave/hole review findings. There are no blocking or undersized-province findings in this build. The review findings are not a claim that every coast or enclave is ideal.
- Inactive inherited vanilla definitions refer to removed country-specific decisions and missions. The native debug counter reported 1,975 startup messages and stayed unchanged through 37 campaign days. This is not a zero-error-log claim. The final portrait fallback uses the installed unknown-leader asset; a fresh start then reported 1,961 messages, and successful reload still added 104 empty-icon messages. Those reload diagnostics remain unresolved.
- A cleaned illustration cannot establish exact coastlines, politics, population or economic balance. Only confirmed in-bounds names were accepted; uncertain and cropped-away labels remain documented in the private review.
- No authored events, decisions or national focus trees were added. The starter relies on shared base-game systems; a total conversion with custom campaign rules requires additional authoring outside this map workflow.
- The native test covered one selected country and a limited campaign interval. It does not prove every country, naval route, long campaign or Windows graphics configuration.

CI uses project-owned synthetic images and fixtures. Unit, integration, security, recovery and package checks are required before release; offline results alone do not establish native playability.
