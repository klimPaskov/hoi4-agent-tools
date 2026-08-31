# ADR 0017: Arbitrary local mod roots

## Decision

Local startup must recognize ordinary HOI4 mod roots without requiring a repository-specific layout or a descriptor file in every case. Automatic discovery accepts a `descriptor.mod`, a recognized HOI4 `common` content directory, or populated standard mod content directories while walking upward from the MCP working directory. The resolver stops at recognizable installed-game markers so a game installation is never selected as a writable mod.

Explicit configuration remains available for empty roots, nonstandard source layouts, multiple mods, dependency load order, and remote deployments. Domain-specific source roots continue to come from the shared workspace configuration rather than from mod names or repository-specific conventions.

## Consequences

- Descriptor-less focus-only, event-only, localisation-only, interface-only, and map-only development roots work with the normal local startup path.
- An empty directory without a descriptor is rejected instead of guessing an unrelated ancestor directory.
- Installed game roots are not treated as writable local mods.
- Synthetic tests cover sparse roots and the shared index path without copying external mod content.
