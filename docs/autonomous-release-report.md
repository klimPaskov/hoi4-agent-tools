# Completion report: 0.2.0 autonomous public release

- Released version: `0.2.0`
- Report date: 2026-07-12
- Status: complete; autonomous writes, public delivery, and clean installation are verified
- Release commit: `09bd1fa69f0985076720f1fdfb839be78730e5ec`
- Annotated tag object: `929c97d52a3793ce8b5a9a8493037437adfb590a`
- Exact-source CI: [run 29192501543](https://github.com/klimPaskov/hoi4-agent-tools/actions/runs/29192501543)
- Release workflow: [run 29192831853](https://github.com/klimPaskov/hoi4-agent-tools/actions/runs/29192831853)

## Outcome

Version 0.2.0 makes autonomous coding-agent use the primary write workflow. After an operator
persistently allowlists a workspace and selects `writePolicy: "autonomous"`, MCP discovery exposes
one-call `hoi4.focus_rewrite`, `hoi4.gui_rewrite`, and `hoi4.map_rewrite` tools. Each call resolves the
workspace, builds and validates the change, checks source freshness, applies it, rescans the result,
and returns source-linked diagnostics and resource-backed artifacts. Coding agents do not exchange
transaction IDs, expected plan hashes, separate apply calls, or rollback commands.

Read-only remains the installation default, and the reviewed transaction workflow remains an
explicit compatibility mode. Neither mode leaks into autonomous discovery. This preserves a safe
first installation without imposing per-call approval on a workspace whose owner has already opted
into autonomous writes.

The shared engine still records exact pre-write bytes internally while a multi-file rewrite is in
flight. That journal is automatic recovery data, not an agent-facing workflow: failures restore the
original bytes, successful autonomous journals are reclaimed, and autonomous responses expose only
the recovery outcome when a write fails. Git history cannot replace this because Git does not make
several uncommitted filesystem writes atomic.

The server does not display approval prompts. MCP hosts may independently prompt for tools marked
with truthful destructive annotations; that host policy is outside the server's control.

## Public delivery

| Surface        | Verified evidence                                                                                                                              | Status   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| GitHub source  | Public commit `09bd1fa6...`, annotated tag `v0.2.0`, and green exact-source CI                                                                 | Verified |
| npm            | [`hoi4-agent-tools@0.2.0`](https://www.npmjs.com/package/hoi4-agent-tools/v/0.2.0), registry signature, npm attestation, and SLSA provenance   | Verified |
| GitHub Release | Immutable [Release v0.2.0](https://github.com/klimPaskov/hoi4-agent-tools/releases/tag/v0.2.0), ID `352750817`, with four byte-verified assets | Verified |
| GHCR           | Anonymous `ghcr.io/klimpaskov/hoi4-agent-tools:0.2.0` multi-platform image with attached attestations                                          | Verified |
| MCP Registry   | `io.github.klimPaskov/hoi4-agent-tools@0.2.0`, official status `active`, `isLatest: true`                                                      | Verified |
| Public install | Clean stdio and authenticated Streamable HTTP installation qualification                                                                       | Verified |

The npm package was published at `2026-07-12T12:45:29.976Z`. Its tarball is 703,488 bytes,
contains 422 files, has SHA-1 `0e01ff4a64043e9d96dde9674317860b72ed6851`, and has SHA-256
`0de04ced601e15c241987af5b73b19cda49ca3cd35b00942b567b0a078f51410`. The npm and GitHub
Release tarballs are byte-identical.

The GHCR OCI index digest is
`sha256:9c7136b8ceed17e83a0ea9b950dd44f2ce7b894b7899b0a9199a38a1931fc022` and contains the
declared `linux/amd64` and `linux/arm64` runtime platforms. The official MCP Registry published the
active/latest record at `2026-07-12T12:50:49.774281Z` using the 2025-12-11 Registry schema.

## Qualification evidence

- `npm run check`: 47 test files, 507 tests passed, and one POSIX-only case skipped on Windows;
  deterministic fixtures and generated schemas, build, 422-file package allowlist, and Registry
  validation passed.
- Enforced coverage: 88.76% statements, 78.58% branches, 91.69% functions, and 90.17% lines.
- The official MCP Inspector passed against the production stdio server.
- Exact-source CI passed on Node 22 and 24 for Windows and Linux, plus the production container.
- Release dependency qualification found zero vulnerabilities and verified 448 registry signatures
  and 128 attestations. A separate clean public install verified 131 installed-package signatures and
  17 attestations.
- Public-package qualification initialized and discovered the autonomous surface over stdio and
  authenticated, Origin-validated Streamable HTTP.
- Tests cover autonomous focus, GUI, and map workflows; deterministic rendering; source
  preservation; no-change rewrites; stale-source rejection; traversal, symlink, cross-workspace, and
  command-injection boundaries; automatic recovery; isolation; limits; and large artifact resources.

## Simplifications, omissions, and blockers

None. The deliberate internal recovery journal and truthful destructive annotations are part of the
completed design, not user-visible approval or rollback choreography. No proprietary game or mod
content is included in any published artifact.
