# ADR 0041: DLC source layers and descriptor replace paths

Status: accepted

## Context

An installed Hearts of Iron IV keeps much of its DLC artwork and interface definitions in folders under `dlc/` and `integrated_dlc/`, each identified by a `dlcNNN.dlc` descriptor.
In the measured installation those folders define 4,454 sprite names that the base `interface/` folder does not, along with DLC interface layouts and portraits.
Workspace roots covered only the base game, dependencies, and the mod, so a source lookup for a DLC sprite such as `GFX_POL_CAS1_medium` found no definition, and renders that referenced DLC artwork reported it missing.
The Chaos Redux mod referenced fifteen such DLC-only sprites directly.

Mods also declare `replace_path` in `descriptor.mod` to unload earlier-loaded files under a folder.
Replace paths applied only when an operator configured them, so a mod's own declaration, such as Chaos Redux's `replace_path="gfx/loadingscreens"`, was ignored.

The offline wiki's Modding page states the load order: the base game, then DLC in order of internal ID, then the user directory, then mods; it also notes that `replace_path` unloads previously loaded files without changing the order.

## Decision

Each real directory directly under the game root's `dlc/` or `integrated_dlc/` that contains a `dlcNNN.dlc` descriptor and resolves inside the game root becomes a read-only `dlc` source root.
DLC roots load after the base game and before dependencies and the mod, ordered by internal ID and then folder name.
A game workspace is itself the base game, so its DLC roots follow it.
Scanner display paths label a DLC root by its folder name.
Every place that read the base game alongside mod sources reads DLC roots as well: the default scan, focus and package scans, technology and event vanilla passes, and the GUI fallback for vanilla window layouts.
`includeGameDlc` on a workspace registration, default `true`, turns the layers off.
Archives inside DLC folders are not unpacked, and at most 256 layers are admitted.

`replace_path` entries in the mod's and each dependency's `descriptor.mod` are parsed with the shared Clausewitz parser and added to that root's configured replace paths.
Only plain relative folders are accepted; absolute, parent-relative, wildcard, and empty entries are ignored.
Descriptors larger than 64 KiB or that are not regular files contribute nothing.

## Consequences

Source lookups, focus and technology icons, event pictures, and GUI layouts resolve definitions that live only in installed DLC folders, and same-named files follow the documented DLC order.
Dependency and mod load-order numbers shift by the number of DLC layers, so cached analyses and workspace identities computed before this change no longer match and are rebuilt.
An installed folder shows that DLC content exists on disk, not that a playset enables it; agents should still check `has_dlc` conditions.
The engine's exact precedence for two DLC folders that share an ID is not documented; folder name breaks such ties.
A mod that relied on vanilla loading screens or other files under a declared `replace_path` now sees them unloaded, matching what the game loads.
