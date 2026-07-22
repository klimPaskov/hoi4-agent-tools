# Standalone Project Bootstrap

## Fixed project location

Create a new standalone Git project at:

```text
C:\Users\klimp\Documents\Projects\hoi4-agent-tools
```

This is the source repository for the MCP server and all shared tool logic. It must not be created inside Chaos Redux, another HOI4 mod, a mod `tools` folder, or the Hearts of Iron IV installation.

Run `git init` in this folder and treat it as an independent public project with its own history, releases, issues, documentation, tests, and package publishing workflow.

## Product boundary

The product is an MCP server built for coding agents. The focus, GUI, map, read-only event-chain, and read-only technology-tree capabilities are MCP tools used by agents while they work on an external HOI4 mod project.

The public surface has sixteen tools: four focus tools plus three tools in each of the GUI, map, event, and technology families. Local calls omit workspace selection and resolve the mod containing the MCP working directory.

The product does not provide an interactive focus editor, GUI editor, map editor, event editor, technology editor, dashboard, or full command line application. An agent can start the MCP from inside a mod and use it immediately; optional configuration adds game references or explicit multi-mod deployments. Canonical mod workspaces are writable; game, dependency, fixture, artifact, cache, and unrelated roots are not source-write targets. Supported focus, GUI, and map rewrites complete through one domain tool call without a caller-managed transaction ID, plan hash, diff/apply sequence, or rollback call. Event-chain and technology-tree tools inspect, render, and compare source without editing it.

The repository may contain process entry points, maintenance scripts, test harnesses, and package diagnostics. These are infrastructure for launching and validating the MCP server. They are not separate interactive versions of the tools.

## Proposed repository structure

```text
C:\Users\klimp\Documents\Projects\hoi4-agent-tools\
  .github/
  docs/
  examples/
  fixtures/
  schemas/
  scripts/
  src/
    hoi4_agent_tools/
      core/
      event/
      focus/
      gui/
      map/
      mcp/
  tests/
  AGENTS.md
  CHANGELOG.md
  LICENSE
  README.md
  SECURITY.md
  server.json
```

The final language-specific package files should be selected after the architecture decision record. Keep package, module, and import names stable once published.

## External workspaces

The server operates on external workspaces. A local startup inside a mod creates one workspace from the current directory without a config file. Configured workspaces come from explicit `workspaces` entries or direct-child mod discovery beneath `modRoots`; there is no runtime registration API. A workspace may point to:

- a HOI4 mod repository
- an installed game directory used as read-only reference material
- dependency mod directories
- a generated artifact directory

The first development workspace may be Chaos Redux, but no Chaos Redux code, paths, naming rules, skills, or documentation structure may be hardwired into the generic product.

Every registered mod workspace keeps its own source files. The MCP server reads those files through allowlisted paths and edits only an operator-authorized mod workspace. An autonomous rewrite still uses the shared internal validation, durable journal, exact-before-byte, stale-check, locking, post-validation, and automatic-recovery services. It never copies a mod into the MCP project.

Installed-game, dependency, and fixture roots remain read-only. Remote access additionally remains subject to authentication, origin and Host validation, transport write scope, and principal-to-workspace grants. `allowDiscoveredMods` grants only discovered mod IDs and does not broaden configured roots or grant unrelated explicit workspaces.

## Repository foundations

Create and maintain:

- an independent `AGENTS.md` for this project
- a public README focused on coding-agent integration
- a permissive or otherwise user-approved open-source license
- security and responsible-disclosure policy
- semantic versioning and changelog
- automated tests and release workflows
- dependency lock files
- contribution guidance
- MCP Registry metadata

Do not copy Chaos Redux's `AGENTS.md` or skills as the new project's operating rules. Use the reviewed project files as design references, then write clean standalone instructions suited to a public agent tool server.
