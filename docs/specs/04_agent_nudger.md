# Agent Nudger

## Purpose

Create an MCP map-modification system for coding agents. It must support safe state and province work through headless agent calls, declarative one-call rewrites, map renders, and machine-readable diagnostics.

There is no interactive map editor. Visual outputs are artifacts that help the coding agent inspect geography, IDs, layers, and proposed changes.

## Indexed map surface

Inspect the current game version and registered mod workspace. Index every relevant file that exists, including:

- province bitmap and definition table
- state history
- strategic regions
- terrain and continent data
- adjacency definitions
- supply nodes and railways
- victory points
- buildings and resources
- owners, controllers, cores, and claims
- ports and coastal status
- positions and locators
- localisation
- dependency-mod overrides

Do not assume an older map format is current. Use installed documentation and vanilla files.

## Declarative operations

Every edit is described by one complete declarative `map_rewrite` request. Before mutating source, the server compiles that request into an authenticated internal journal containing the complete affected-file set and exact original bytes. Support:

- create a state from existing provinces
- split and merge states
- move provinces between states
- change state capital, manpower, resources, buildings, owner, controller, cores, and claims
- assign provinces to strategic regions
- split a province with an exact polygon or raster mask
- merge, create, or remove provinces
- change province type, terrain, continent, and coastal state
- add or remove normal and special adjacencies
- update ports, victory points, supply nodes, railways, positions, and locators

Natural language may help the coding agent draft the request. Geometry-changing work still requires exact selected provinces, polygons, masks, or pixel regions before the one-call rewrite can mutate source.

## ID and color allocation

Scan vanilla, the active mod, and configured dependencies before allocating IDs or province RGB colors.

The allocator must find actual free values, detect load-order collisions, remain deterministic, record allocation evidence, allow explicit values, and refuse conflicts.

Never assume the numerically next ID is available.

## Agent map artifacts

Generate map resources with pan-and-zoom HTML where useful, plus PNG and JSON outputs for:

- province, state, and strategic-region borders
- terrain and continent layers
- owner and controller layers
- cores and claims
- victory points, resources, and buildings
- supply nodes and railways
- adjacencies
- coasts and ports
- before and after comparison
- changed pixels and affected IDs
- affected files
- unresolved distribution choices
- validation results

HTML may provide inspection controls, but source changes happen only through the authorized MCP rewrite tool. It is not a supported manual editor.

## Bitmap rules

Province bitmap edits must use exact colors with no anti-aliasing. Preserve dimensions and required image mode. Record changed bounds and reject unintended changes outside them.

Detect unknown colors, unregistered colors, holes, one-pixel artifacts, accidental thin corridors, and disconnected components for review. Do not classify every island or separated component as invalid.

## State split and merge policies

Never guess the distribution of manpower, resources, buildings, victory points, ownership, control, cores, claims, supply nodes, or railways.

Require explicit policies such as:

- remain with original state
- move with a named province
- proportional distribution
- exact values in manifest
- block until resolved

Build the proposed result and its artifacts before mutation within the rewrite call. Keep the rewrite blocked and leave source untouched while required choices remain unresolved.

## Validation

Detect at least:

- duplicate IDs or province colors
- bitmap colors missing from definitions
- definition rows unused by the bitmap
- invalid province references
- provinces in no state
- land provinces in multiple states
- invalid capitals, victory points, ports, strategic regions, adjacencies, supply nodes, railways, positions, or locators
- missing or conflicting strategic-region membership
- references to removed provinces
- coastal inconsistencies
- duplicate state IDs
- missing state localisation
- ownership and control inconsistencies
- lost resources or buildings after a split
- bitmap format changes
- pixel changes outside transaction bounds
- dependency conflicts

Run supported static and local engine-compatible validation without launching the game. Connect every error to the manifest operation. A map render alone is never sufficient.

## MCP operations

Expose agent tools for scan, inspect, allocate, render, validate, and one-call rewrite. Read-only planning evidence may be produced by the scan, inspect, render, and validate tools, but the mutating path is `map_rewrite`; it does not require a transaction ID, expected plan hash, separate diff/apply sequence, or caller rollback.

## Acceptance fixtures

Create synthetic fixtures for state creation, province movement, province split by mask, province merge, safe ID and color allocation, strategic-region updates, supply or railway updates, adjacency changes, exact automatic recovery after an injected failure, orphan-pixel detection, and invalid-reference detection. Prove that each authorized successful edit completes in one `map_rewrite` call and that blocked or failed calls leave no mixed source state.

Also run local integration tests against the installed game and at least one external mod workspace. Prove that unrelated files and unrelated bitmap regions remain unchanged.
