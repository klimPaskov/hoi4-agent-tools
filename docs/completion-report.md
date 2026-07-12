# Completion report: 0.1.7 public release

> Historical release record. Version 0.2.0 supersedes the agent-facing write workflow described here; see the [0.2.0 completion report](autonomous-release-report.md), [ADR 0012](adr/0012-autonomous-rewrites.md), and the current workflow documentation.

- Released version: `0.1.7`
- Report date: 2026-07-12
- Status: complete; public delivery, installation, and a real external-workspace transaction are verified
- Release commit: `9718388626a29dc4b584ae235bdbe325689e44b0`
- Annotated tag object: `d06a18d106a53007e12a202468cd85356ca91ef7`
- Exact-source CI: [run 29183088020](https://github.com/klimPaskov/hoi4-agent-tools/actions/runs/29183088020)
- Release workflow: [run 29183455724](https://github.com/klimPaskov/hoi4-agent-tools/actions/runs/29183455724)

## Outcome

The release provides one source-preserving engine for the Focus Tree Workbench, Scripted GUI Studio, Agent Nudger map workflow, MCP handlers, workspace resolution, Clausewitz parsing, symbol indexing, diagnostics, configuration, transactions, artifacts, diffs, and rollback data. It starts read-only, supports local stdio and secured Streamable HTTP, and is published as an installable package, a dual-platform container, an immutable GitHub Release, and an active/latest MCP Registry server.

The coding agent selects the server from repository and task context once its MCP host has a persistent registration. No special activation phrase or background daemon is required. The public documentation covers pinned `npx`, optional global installation, durable configuration, Codex and generic client registration, self-hosted HTTP, safe transactions, and large focus-tree repair and creation.

Version `0.1.7` additionally qualifies:

- uniform `reviewScale` output for large national-tree baseline, transaction, and final artifacts without changing logical geometry or compiled coordinates;
- exact import, schema, compilation, and targeted-update support for safe symbolic focus-cost constants;
- complete proposed and post-write focus diagnostics as MCP resources while the bounded inline/manifest limits remain enforced;
- sidecar-aware post-write focus validation without treating adjacent JSON planning metadata as Clausewitz focus source;
- agent-first discovery and setup wording, with no human-request activation framing.

No installed-game data, external-mod data, local configuration, runtime artifacts, test fixtures, source files, or tests are included in the npm payload.

## Qualification evidence

All 46 portable test files passed: 503 tests passed and one POSIX-only case was intentionally skipped on Windows. Enforced coverage is 88.58% statements, 78.34% branches, 91.38% functions, and 90.03% lines.

The release gate and exact-source CI also verified:

- deterministic project-owned focus, GUI, and map fixtures and generated schemas;
- a 417-file package allowlist and clean installed entry points;
- official MCP Inspector discovery against the production stdio server;
- Node 22 and 24 on Windows and Linux plus the production container build;
- zero dependency vulnerabilities, 448 dependency registry signatures, and 128 dependency attestations in the pinned release checkout;
- live official MCP Registry schema/API validation;
- strict tag, main ancestry, release ordering, immutable-release settings, and exact artifact identity;
- stdio stdout isolation, authenticated/Origin-validated Streamable HTTP, limits, isolation, progress, cancellation, sessions, and resource reads;
- source preservation, deterministic rendering, bitmap diffs, stale-plan rejection, atomic multi-file apply, post-write validation, exact rollback, symlink/path/cross-workspace security, and end-to-end coding-agent workflows.

Independent final code and documentation reviews found no actionable defects. The code review covered symbolic cost preservation, uniform review scaling, complete diagnostic resources, capacity accounting, rollback behavior, sidecar filtering, and security boundaries.

## Public delivery status

| Surface        | Verified public evidence                                                                                                                               | Status   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| GitHub source  | Public repository, annotated tag object `d06a18d...`, peeled commit `97183886...`, and green exact-source CI                                           | Verified |
| npm            | `hoi4-agent-tools@0.1.7`, Registry signature, npm publish attestation, and SLSA provenance v1                                                          | Verified |
| GitHub Release | Immutable [Release v0.1.7](https://github.com/klimPaskov/hoi4-agent-tools/releases/tag/v0.1.7), ID `352694363`, with exactly four byte-verified assets | Verified |
| GHCR           | Anonymous `ghcr.io/klimpaskov/hoi4-agent-tools:0.1.7` OCI index with exact amd64/arm64 runtimes and attached attestations                              | Verified |
| MCP Registry   | Exact `io.github.klimPaskov/hoi4-agent-tools@0.1.7` record with official `active` and `isLatest: true` state                                           | Verified |
| Public install | Clean install, signature/attestation audit, stdio discovery, and authenticated Streamable HTTP qualification                                           | Verified |

### npm and provenance

- Published at `2026-07-12T07:09:58.926Z`; `latest` resolves to `0.1.7`.
- Tarball: `688,684` bytes at `https://registry.npmjs.org/hoi4-agent-tools/-/hoi4-agent-tools-0.1.7.tgz`.
- SHA-1: `6c34d998f664b846de4a9b60a6dbadd39898a6cc`.
- SHA-256: `e0c08ca4db2347dfadc767eea230d4c24071b6f54b1927c7e2a9aa2eec524b0e`.
- SRI: `sha512-PmCgPyh/qA5dj6jgCpMKsKqFcQCVk0PdMa2PwATfcJ4EETbKgknJEKuaxHLb+UoPaFiDkHSQEJu2fF/UV8EGfQ==`.
- The npm and GitHub Release tarballs are byte-identical. The npm publish attestation is recorded at Rekor log index `2148574615`; SLSA provenance v1 is recorded at index `2148573874` and binds `release.yml`, `refs/tags/v0.1.7`, release commit `9718388626a29dc4b584ae235bdbe325689e44b0`, and release run `29183455724`.

### Immutable GitHub Release

The GitHub Actions bot published Release ID `352694363` at `2026-07-12T07:15:14Z`. It is neither a draft nor a prerelease and reports `immutable: true`.

| Asset                        |   Bytes | SHA-256                                                            |
| ---------------------------- | ------: | ------------------------------------------------------------------ |
| `container-image.json`       |     361 | `06695fa817a1ac9bc2fbb94840c817732875fec0988fe6caa23d46fec75983cb` |
| `hoi4-agent-tools-0.1.7.tgz` | 688,684 | `e0c08ca4db2347dfadc767eea230d4c24071b6f54b1927c7e2a9aa2eec524b0e` |
| `npm-pack.json`              |  50,050 | `9417225028ae5f516c5f727785eedf8764842d96e98a9674caab0c671dea3312` |
| `release-identity.json`      |     431 | `49318a7d830e410520e61c6d7f9e67af2be8f072ecde50645f2d19cb962c5a79` |

### GHCR image and attestations

- OCI index: `sha256:b9651c3647d6f0efe563f82a7973ab4dcde7165546507a7fe6e4e429b0c31f0c`.
- `linux/amd64`: `sha256:c4927b19b736ced1e528694e8f53bffd8f28066463ab806eacce1ee064715741`.
- `linux/arm64`: `sha256:372c9ac76ced1cd7afb03e985cbb17855f9e44500257ca816c5f376ad233db7b`.
- The index exposes exactly two runtime manifests and one attached attestation manifest per runtime. The checked-in release workflow verifies SPDX SBOM and SLSA statements, anonymous access, exact source identity, non-root execution, read-only container behavior, and both supported architectures.

### MCP Registry and public installation

The official Registry returned `io.github.klimPaskov/hoi4-agent-tools@0.1.7` with `status: active` and `isLatest: true`. `publishedAt`, `updatedAt`, and `statusChangedAt` are all `2026-07-12T07:15:29.426439Z`.

A fresh independent public install fetched 132 packages. Its signature audit verified 131 installed-package signatures and 17 attestations with no invalid or missing records. Installed stdio and authenticated, Origin-validated Streamable HTTP initialization/discovery and protocol workflows passed.

## Real large-focus transaction proof

The published `0.1.7` stdio server was exercised against a 238-focus external mod workspace without copying that workspace into this repository or package.

- Baseline import preserved all 238 focus IDs and symbolic costs and reported 15 avoidable connector crossings.
- The structured plan used 14 branch groups, 12 ordered lanes, 16 fixed anchors, and 222 automatically placed nodes.
- The proposed layout has 238 unique coordinates, zero parent-order violations, zero connector-crossing findings, and zero errors or blockers.
- Source and semantic projections are byte-identical after normalising only focus `x`/`y` and `continuous_focus_position`; prerequisites, exclusions, rewards, triggers, comments, unknown fields, raw blocks, ordering, encoding, and symbolic costs are preserved.
- The dry run emitted one complete transaction-diff page with 14 artifacts. A second fresh dry run reproduced every non-manifest artifact byte-for-byte.
- A public-package apply passed all eight validation checks. Explicit rollback restored the exact baseline source hash and removed the newly created planning sidecar. A fresh transaction was then applied and retained.
- Final scan/lint/render recovered all planning metadata and reproduced the reviewed 6317 by 1997 PNG exactly at `reviewScale: 0.4`.
- Complete proposed and post-write diagnostic resources retained 116 content-specific repeated-reward warnings with zero hard findings. The fixed transaction diagnostic ceiling was not raised or bypassed.

## Acceptance coverage

| Acceptance source                                 | Completion evidence                                                                                                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00_standalone_project_bootstrap.md`              | Independent public Git repository, Apache-2.0 licensing, project-owned instructions/docs/tests/workflows, installable npm package, immutable Release, and Registry metadata                         |
| `01_shared_architecture.md`                       | One engine and shared workspace/source/index/diagnostic/configuration/transaction/artifact services across Focus, GUI, map, and MCP tests                                                           |
| `02_focus_tree_workbench.md`                      | Source-preserving import/layout/lint/render/create/update workflows, complex route metadata, deterministic HTML/SVG/PNG/JSON, and source-linked diagnostics                                         |
| `03_scripted_gui_studio.md`                       | Deterministic full/crop/annotation/state/resolution/click-region/hierarchy/comparison rendering, integrated source graphs, bitmap diffs, and mandatory fidelity reports                             |
| `04_agent_nudger.md`                              | Declarative state/province/geometry/region/adjacency/supply/railway transactions, global ID/color scans, split-data blockers, map artifacts, and rollback tests                                     |
| `05_validation_delivery_and_agent_integration.md` | 503 portable tests, enforced coverage, synthetic CI fixtures, installed-data qualification, official Inspector, package/install checks, and coding-agent workflows                                  |
| `06_public_mcp_server.md`                         | Read-only-default stdio and secured Streamable HTTP, OAuth/origin/isolation/limit checks, typed handlers, resource-backed artifacts, package/Release/GHCR/Registry publication, and client examples |

## Simplifications, omissions, and blockers

No required feature was replaced by a mock tool, static placeholder diagram, manual editor, interactive dashboard, game automation, or unpublished package. No required acceptance item or release blocker remains.

Engine-unknown syntax and renderer fields are preserved and explicitly reported through refusal diagnostics and fidelity reports. Supported boundaries remain listed in [Known limitations](limitations.md), not hidden behind fallback rewrites. The real external focus workflow deliberately preserved 116 gameplay-design warnings because it was a layout-only transaction; those warnings are reported above and are not suppressed by the server.

Detailed release commands, ordering, recovery behavior, and the immutable earlier release-attempt history remain in [Release and MCP Registry publication](release.md).
