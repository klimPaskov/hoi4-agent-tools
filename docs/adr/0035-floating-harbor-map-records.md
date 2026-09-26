# 0035. Floating-harbor positions are distinct from fixed naval bases

## Context

The map validator treated `floating_harbor` rows in `map/buildings.txt` like `naval_base_spawn`: the position had to lie inside the declared state and the final field had to name an adjacent sea province. On the installed HOI4 map, 2,334 vanilla floating-harbor rows have a land province in the final field, while their position commonly lies in sea. Chaos Redux includes these vanilla rows. The previous rule produced thousands of false blocking diagnostics and prevented a real-workspace map validation pass.

## Decision

`naval_base_spawn` remains the fixed naval-base locator. A floating-harbor row names a sea-side placement and a land target, and it does not satisfy a state's static `naval_base` locator requirement or appear as a starting port record. A final field that is missing or not land is an error. An off-sea position, cross-state land target, or target outside computed coastal membership receives a source-linked warning because the installed vanilla map contains those cases. Province-type rewrites preserve the sea/land roles of floating-harbor references rather than applying fixed-port rules to them.

## Consequences

The real Chaos Redux plus installed-vanilla map scan validates 13,414 province definitions, 1,081 states, and 304 strategic regions with no blocking diagnostics; it reports 33 source-linked floating-harbor review warnings. A bounded owner-layer tile renders successfully. Synthetic tests cover valid sea/land placement and invalid or unusual targets. The warnings are not hidden or converted into an unsupported accuracy claim.
