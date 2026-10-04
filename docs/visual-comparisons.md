# Focus and technology examples

Compare supplied in-game captures with MCP previews from real Chaos Redux and installed HOI4 files.
Focus previews help review structure and routes; they do not reproduce the game's entire focus-screen styling.
Technology previews follow the loaded source's card layouts and artwork.

## Focus trees

| In game                                                               | MCP preview                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| ![Medium focus tree in game](images/comparisons/fury-ingame.png)      | ![Medium focus tree preview](images/comparisons/fury-mcp.png)      |
| ![Large focus tree in game](images/comparisons/holy-realm-ingame.png) | ![Large focus tree preview](images/comparisons/holy-realm-mcp.png) |
| ![Branching focus tree in game](images/comparisons/utopia-ingame.png) | ![Branching focus tree preview](images/comparisons/utopia-mcp.png) |

The recorded trees contain 52, 111 and 124 focuses.
The MCP uses cards and curved connectors for structural review, while the game uses its own icons, labels, frame and continuous-focus panel.

## Technology folders

| In game                                                     | MCP preview                                              |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| ![Infantry in game](images/comparisons/infantry-ingame.png) | ![Infantry preview](images/comparisons/infantry-mcp.png) |

The infantry example resolves all 43 nodes, including 14 wide equipment cards.
Its armored-car artwork is defined in an installed DLC folder, which the server reads as a layer between the base game and the mod.

### Mod folder with wide cards

| Supplied mod-folder capture                                                     | Matching historical-source preview                                                      |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| ![Mod technology folder in game](images/comparisons/chemical-recent-ingame.png) | ![Historical-source mod folder preview](images/comparisons/chemical-historical-mcp.png) |

The matching source version produces all nine wide equipment cards visible in the capture.
Their cylinder artwork uses its native 131×52 size rather than being squeezed into a square icon area.
Names, research-state colors and surrounding interface text still differ, so this is not whole-image parity.

## What these comparisons establish

They demonstrate real source layouts, resolved artwork, wide-card sizing and dotted alternative links.
They do not establish 99.9% whole-image accuracy or prove runtime state.
Use the [examples guide](examples.md) for practical prompts and the [interface gallery](gui-comparisons.md) for GUI previews.

<details>
<summary>Measurements, source versions and reproduction</summary>

The [manifest](images/comparisons/manifest.json) records tool version, source revisions, folder/tree coverage, layouts and sprite resolution.
Captures were supplied in September 2026.
On 4 October 2026 the 3.7.0 renderer reproduced all three focus previews and the historical mod-folder preview byte for byte.
The infantry preview changed only where DLC-provided armored-car artwork replaced missing silhouettes.
The captures lack complete zoom, viewport, country, research-state and DLC metadata.

The focus previews use 96-pixel horizontal and 130-pixel vertical spacing.
The three trees contain 1, 1 and 5 alternative prerequisite groups in the recorded source.

Infantry resolves 50 requested sprites across 29 small and 14 wide items.
The supplied wide-card capture matches technology and research-GUI definitions at Chaos Redux revision `4efc01fc87f1137e98c864f928dd5603e6b7d2f1`.
That version stacks Phosgene below Chlorine, includes Sarin/Soman folder placements, and has year headings through 1946.

The historical preview uses that revision's technology and research-GUI files over the other currently installed assets.
It contains 30 placed technologies: nine wide and 21 small, with no unresolved requested sprites.
Its labels use technology names rather than equipment names, its declared research state produces gray cards, and some section text/tabs/framing are absent.

To reproduce, set `HOI4_GAME_ROOT` and `HOI4_EXTERNAL_MOD_ROOT`, then run `npm run docs:comparison-examples`.
The historical mod-folder comparison also requires the pinned commit in the mod checkout.
The command reads the checked-in captures and writes renders and the manifest.

Images are published with permission for comparison, are excluded from the npm package, and are not covered by the repository's Apache-2.0 code license.
Game imagery belongs to Paradox Interactive and mod material to its respective creators.

</details>
