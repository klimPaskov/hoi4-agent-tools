# ADR 0081: Plugins from configured paths

Status: accepted

## Context

Two tools served one Discord integration, `chaosx.visual_revision` and `chaosx.focus_country_assets`. They shipped in the public package behind `HOI4_AGENT_TOOLS_CHAOSX=1`, although they are no use to a coding agent and name one mod's workflow (decision M-14).

## Decision

The public package has no `chaosx.*` tools. The stdio server can load plugins instead.

- A plugin is a `.mjs` or `.js` module. The configuration key `plugins` lists its absolute path. The server loads plugins from those paths only, never from a mod folder or from the environment, so a mod cannot make the server run its code. The HTTP server never loads a plugin.
- A path must be absolute, a plain file with no link in it, and end in `.mjs` or `.js`. A listed file that does not exist is skipped with a `plugin_skipped` line on stderr, so one shared configuration can name a plugin that exists on one machine. Anything else that is wrong stops the server at startup.
- The module exports a default function. It receives a host with `serverVersion`, `importServerModule` (a module of this package by its path under `hoi4_agent_tools/`, nothing outside it) and `dependency` (the `zod` and `sharp` copies the server uses, so schemas and images are compatible). It returns a factory that builds the plugin's tools for an engine and request context.
- A tool has the definition of a built-in tool and a `call` function. Its name is `<plugin>.<tool>`, never starts with `hoi4.`, and no two plugin tools share a name; at most 16 plugin tools load. The server lists plugin tools beside its own on both protocol generations, validates input and output against the plugin's schemas, and marks results private and uncached.
- The private ChaosX tools moved to a plugin in a private repository.

## Consequences

The listed tools of a default server are the same as before without the flag. The environment flag `HOI4_AGENT_TOOLS_CHAOSX` no longer does anything. A plugin depends on the server's internal module paths, so it is versioned with the server release it was built for and the host reports `serverVersion`.

## Tests

`tests/unit/plugins.test.ts` covers loading, absence, relative paths, extensions, a module without a factory, links, tool names, the host import guard and the configuration. `tests/integration/stdio-transport.test.ts` lists and runs a synthetic plugin tool on both protocol generations, skips an absent plugin and refuses a reserved name.
