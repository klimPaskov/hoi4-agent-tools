# ADR 0088: A strict production audit and reviewed exceptions for development tools

Status: accepted (maintainer decision D-80, 2026-11-17)

## Context

CI, the release workflow and the npm bootstrap each ran `npm audit --audit-level=high` over every dependency. On 2026-11-17, GHSA-fc5q-39xc-vjpf was widened to cover every picomatch release up to 4.0.7, the newest, and no fixed version was published. picomatch reaches only development tools: vitest, vite through the MCP inspector, and typescript-eslint. The published package doesn't depend on it. The check failed on every pull request and would have blocked every release, though nothing users install was affected and no update could clear it.

## Decision

Each workflow runs two audits in place of the old one:

1. **`npm audit --omit=dev --audit-level=high`**: what users install. Strict, with no exceptions.
2. **`npm run audit:gate`** (`scripts/audit-gate.ts`): the full audit, development dependencies included. It fails on every high or critical advisory except one listed in `scripts/audit-exceptions.json`. Each entry names the advisory, the exact package, the reason, the approval date and a review date.

An entry passes only while all of these hold:

- **Development only:** the advisory does not appear in the production audit (`--omit=dev`). An advisory that reaches what users install never passes, even when listed.
- **No fix published:** the package has no published stable version outside the advisory's vulnerable range. Once one exists, the gate fails until the dependency is updated and the entry removed. If the gate can't read the published versions, it fails.
- **Within its review date.**
- **Still current:** the entry still matches an advisory. A stale entry fails until it is removed.

Adding an entry needs the maintainer's approval, recorded in the pull request.

## Consequences

- A development-only advisory with no fix no longer blocks pull requests or releases. The production audit stays as strict as before.
- No entry can outlive its reason: a published fix, a review date, or the advisory going away each fail the gate.
- The first entry is GHSA-fc5q-39xc-vjpf in picomatch, to be reviewed by 2026-12-01.
