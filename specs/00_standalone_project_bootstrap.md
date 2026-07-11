# Standalone Project Bootstrap

## Fixed project location

Create a new standalone Git project at:

```text
C:\Users\klimp\Documents\Projects\hoi4-agent-tools
```

This is the source repository for the MCP server and all shared tool logic. It must not be created inside Chaos Redux, another HOI4 mod, a mod `tools` folder, or the Hearts of Iron IV installation.

Run `git init` in this folder and treat it as an independent public project with its own history, releases, issues, documentation, tests, and package publishing workflow.

## Product boundary

The product is an MCP server built for coding agents. The focus, GUI, and map capabilities are MCP tools used by agents while they work on an external HOI4 mod project.

The product does not provide an interactive focus editor, GUI editor, map editor, dashboard, or full command line application. An operator installs and configures the MCP server once; compatible coding agents then select its capabilities autonomously while working in registered external workspaces. Proposed writes remain subject to the coding-agent host's configured approval policy.

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

The server operates on registered external workspaces. A workspace may point to:

- a HOI4 mod repository
- an installed game directory used as read-only reference material
- dependency mod directories
- a generated artifact directory

The first development workspace may be Chaos Redux, but no Chaos Redux code, paths, naming rules, skills, or documentation structure may be hardwired into the generic product.

Every registered mod workspace keeps its own source files. The MCP server reads and edits those files through allowlisted paths and transactions. It never copies a mod into the MCP project.

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
