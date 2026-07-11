# Completion report: 0.1.6 public release

- Released version: `0.1.6`
- Report date: 2026-07-11
- Status: complete; public delivery and installation independently verified
- Release commit: `a7eeb31532c067fa2fe4e297f1710615b49a1273`
- Annotated tag object: `4933d5bc28cc7941304d8573fcc1fea65ad74328`
- Exact-source CI: [run 29161368937](https://github.com/klimPaskov/hoi4-agent-tools/actions/runs/29161368937)
- Release workflow: [run 29161750887](https://github.com/klimPaskov/hoi4-agent-tools/actions/runs/29161750887)

## Implemented scope

The release provides the shared source-preserving core, Focus Tree Workbench, Scripted GUI Studio, Agent Nudger map workflow, read-only-by-default transaction controls, stdio and authenticated Streamable HTTP transports, package entry points, schemas, synthetic portable fixtures, and public deployment documentation described by this repository.

The npm payload is explicitly limited to compiled entry points, documentation, schemas, `server.json`, and the project license, security policy, README, and changelog. Installed-game data, third-party mod data, fixtures, tests, source files, local configuration, and workspace artifacts are excluded.

## Qualification evidence

The release passed all 46 portable test files: 495 tests passed and one POSIX case was intentionally skipped on Windows. Enforced coverage is 88.44% statements, 78.25% branches, 91.28% functions, and 89.90% lines.

Release-specific qualification also covers:

- installation of the actual `npm pack` tarball into an isolated consumer, including an empty-cache install that proves `--prefer-offline` can fetch missing dependencies;
- execution of the installed stdio, HTTP, and setup entry points;
- package-content allowlisting, workspace-path leak checks, synchronized package and Registry metadata, and generated-schema checks;
- npm dependency audit, registry signatures, and attestations;
- live validation against the official MCP Registry API and pinned schema;
- official MCP Inspector discovery against the production stdio entry point;
- a production Docker build and protocol-only container stdio initialization/discovery; the release workflow records the final non-self-referential image digest in `container-image.json` rather than embedding an obsolete candidate digest into documentation copied inside that image;
- immutable GitHub Action references, workflow and shell linting, strict release ordering, and byte-for-byte npm/GitHub release verification;
- pinned Dockerfile-frontend and Node base-image digests, a multi-platform base supporting `linux/amd64` and `linux/arm64`, and a warning-free Docker build check;
- read-only production-container checks proving OAuth metadata discovery, unauthenticated `401`, invalid-Origin `403`, protocol-only stdio initialization/discovery of all 26 tools, and a real read-only `hoi4.project_status` call from the non-root Node 22.23.1 runtime;
- reusable bounded GUI helper templates, source-valid typed helper output, explicit state variants, deterministic scrolling and static meter handoffs, and refusal tests for unsafe or ambiguous helper compilation;
- explicit even-odd province polygons with raster-boundary bounds checking before rasterization, pixel-center sampling, and refusal rather than clipping;
- interrupted GitHub release recovery through a uniquely selected, byte-verified draft without asset overwrite or deletion, followed by exact immutable-release verification;
- three installed-data qualifications covering a large vanilla/external focus workflow, a real GUI/GFX/font graph with deterministic full/annotated renders, and full province-map scan/render/storage without launching the game; the 302,497,021-byte canonical GUI graph was stored exactly as three bounded resources plus its one-read index while the default 128 MiB per-object ceiling remained enabled;
- deterministic cold/warm benchmark output for the 255-focus, 203-visible-element GUI, and all-layer map workloads, including same-size/same-mtime content-hash invalidation.

Known refusal cases and intentional boundaries remain documented in [Known limitations](limitations.md). They are explicit product constraints, not fallback implementations.

## Public delivery status

The immutable `v0.1.2` release attempt published npm with trusted-publisher provenance and then
stopped in independent verification because the pinned npm subprocess reported the configured
official Registry URL without a trailing slash while the strict verifier required the canonical
slash-terminated spelling. npm's signature audit itself verified 448 registry signatures and 128
attestations. The workflow correctly skipped GHCR, GitHub Release, MCP Registry, and final public
verification. The public npm `0.1.2` bytes and tag are retained as immutable audit evidence.

The immutable `v0.1.3` release attempt published and independently verified npm, then published
the exact two-platform GHCR image with SPDX SBOM and SLSA v0.2 provenance attached to each runtime
manifest. BuildKit correctly resolved its Git context URI to the immutable commit while recording
the exact release tag and workflow identity in the provenance environment; the verifier had
incorrectly required the URI itself to retain the tag. GitHub Release, MCP Registry, and final
public verification were skipped. The npm `0.1.3` bytes, GHCR `0.1.3` digest, and tag are retained
as immutable audit evidence.

The immutable `v0.1.4` release attempt published and independently verified npm and the exact
two-platform GHCR image, then staged a four-asset GitHub draft with the expected names, sizes,
SHA-256 digests, upload states, and GitHub Actions bot ownership. The live Releases API represented
the omitted optional asset label as an empty string while the verifier accepted only `null`, so the
draft remained unpublished. MCP Registry and final public verification were skipped. The npm
`0.1.4` bytes, GHCR `0.1.4` digest, tag, draft, and draft assets are retained as immutable or
unchanged audit evidence.

The immutable `v0.1.5` release attempt published and independently verified npm, the exact
two-platform GHCR image with attestations, an immutable four-asset GitHub Release, and an
active/latest official MCP Registry record. Its final cross-surface verifier stopped because the
Registry canonically omitted explicit `isSecret: false`; the pinned official schema defines false
as that field's default. Every public object had already passed its dedicated publication gate and
remains unchanged as audit evidence.

The `v0.1.6` workflow completed every validation, writer, and final verification job. Independent
post-release audits then downloaded the public bytes again without changing release state.

| Surface        | Verified public evidence                                                                                                                                                           | Status   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| GitHub source  | Public repository, annotated tag object `4933d5bc...`, and peeled commit `a7eeb315...`                                                                                             | Verified |
| npm            | `hoi4-agent-tools@0.1.6`, exact tarball bytes, Registry signature, npm publish attestation, and SLSA provenance v1                                                                 | Verified |
| GitHub release | Immutable [Release v0.1.6](https://github.com/klimPaskov/hoi4-agent-tools/releases/tag/v0.1.6), ID `352573210`, with exactly four byte-verified assets                             | Verified |
| GHCR           | Anonymous `ghcr.io/klimpaskov/hoi4-agent-tools:0.1.6` index with exact amd64/arm64 runtimes and per-runtime SPDX/SLSA attestations                                                 | Verified |
| MCP Registry   | Exact `io.github.klimPaskov/hoi4-agent-tools@0.1.6` record, strict-equal to `server.json`, with official `active` and `isLatest: true` state                                       | Verified |
| Public install | Clean npm install, signature/attestation audit, setup diagnostics, stdio initialization/discovery, and authenticated Streamable HTTP session/resource/progress/cancellation checks | Verified |

### npm and provenance

- Published at `2026-07-11T17:41:29.169Z`; `latest` resolves to `0.1.6`.
- Tarball: `669,550` bytes at `https://registry.npmjs.org/hoi4-agent-tools/-/hoi4-agent-tools-0.1.6.tgz`.
- SHA-1: `0b240508a9dab4bc31a84ba1733ded3eb6983390`.
- SHA-256: `b3925c8600fbb8eda44b7aaf36edb7d7bd056b84766e2b0cd6b4fa8fdbc385ce`.
- SRI: `sha512-OaWY67zCEuwNj4AQZHlGBg59BoAQlgBoJ7soV5cOD2DiVClcjdz+8z0gBB02I1UXkoxFQgCcWw8YMVkBl0iLhg==`.
- The npm and GitHub Release tarballs are byte-identical. Pinned npm `11.16.0` verified the
  Registry signature, npm publish attestation, and SLSA provenance v1 with Rekor log index
  `2145861311`. The provenance binds `release.yml`, `refs/tags/v0.1.6`, release commit
  `a7eeb31532c067fa2fe4e297f1710615b49a1273`, and workflow run `29161750887`.

### Immutable GitHub Release

The GitHub Actions bot published Release ID `352573210` at `2026-07-11T17:46:42Z`; it is neither a
draft nor a prerelease and reports `immutable: true`. Its body exactly matches tagged
`CHANGELOG.md`. All assets have canonical empty labels, uploaded state, the canonical bot uploader,
and API digest/size values matching independently downloaded bytes:

| Asset                        |   Bytes | SHA-256                                                            |
| ---------------------------- | ------: | ------------------------------------------------------------------ |
| `container-image.json`       |     361 | `0830611b33f26cb24baf05a8e997512db962ad4297966aa3b7db0bd1a37da179` |
| `hoi4-agent-tools-0.1.6.tgz` | 669,550 | `b3925c8600fbb8eda44b7aaf36edb7d7bd056b84766e2b0cd6b4fa8fdbc385ce` |
| `npm-pack.json`              |  49,941 | `a359bc1e0e64d119606a9c6bfb3f1a77725089e7cd5ada82c7efef839594543f` |
| `release-identity.json`      |     431 | `d289937579f1e6e272264b09b4d9286a62e2c05c01a921d56dbc3d678fb5f576` |

### GHCR image and attestations

- OCI index: `sha256:9593b77b50938a76341d293dd4ef97bb42224661a6a25dc28a1378e0109e0e5b`.
- `linux/amd64`: `sha256:bda20a48cff5d5597467e22bb53b142bcb698420b637fe5cdc1f05107e7bce0f`.
- `linux/arm64`: `sha256:52ed0aa7bf35de90f49364a94bb41fbd0136895a155af624fc26b4275631d735`.
- The index has exactly two runtime and two attached attestation manifests, without orphans. Each
  runtime has one SPDX 2.3 and one SLSA v0.2 statement whose sole SHA-256 subject is that runtime
  digest. Provenance binds `Dockerfile`, `publish_image`, `refs/tags/v0.1.6`, the release workflow,
  and the exact commit.
- A fresh pull with an empty Docker configuration succeeded anonymously. A non-root, read-only,
  network-disabled stdio smoke negotiated MCP `2025-11-25`, reported version `0.1.6`, and listed 26
  tools. The default HTTP entry point also returned an authenticated Streamable HTTP initialization.

### MCP Registry and public installation

The exact official Registry endpoint returned a server object strict-equal to checked-in
`server.json`, plus `status: active` and `isLatest: true`. `publishedAt`, `updatedAt`, and
`statusChangedAt` are all `2026-07-11T17:46:54.873191Z`.

A clean public installation fetched 132 packages only from `https://registry.npmjs.org`; its
lockfile had no `file:`, `workspace:`, `link:`, repository-path, or other local resolution. The
signature audit verified 131 installed package signatures and 17 attestations with no invalid or
missing records. The installed setup entry point passed help, read-only config initialization,
diagnostics, rendering probe, and client-config output. Installed stdio and authenticated,
Origin-validated Streamable HTTP passed initialization, discovery, resources, prompts, progress,
cancellation, and session deletion.

## Acceptance coverage

| Acceptance source                                 | Completion evidence                                                                                                                                                                                |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00_standalone_project_bootstrap.md`              | Independent public Git repository, Apache-2.0 licensing, project-owned instructions/docs/tests/workflows, installable npm package, immutable Release, and Registry metadata                        |
| `01_shared_architecture.md`                       | One engine and shared workspace/source/index/diagnostic/configuration/transaction/artifact services exercised across Focus, GUI, map, and MCP acceptance tests                                     |
| `02_focus_tree_workbench.md`                      | Synthetic and installed-data import/layout/lint/render workflows with deterministic HTML/SVG/PNG/JSON artifacts and source-linked diagnostics                                                      |
| `03_scripted_gui_studio.md`                       | Deterministic full/crop/annotation/state/resolution/click-region/hierarchy/comparison rendering, source graph integration, bitmap diffs, and mandatory fidelity reports                            |
| `04_agent_nudger.md`                              | Declarative state/province/geometry/region/adjacency/supply/railway transactions, global ID/color scans, split-data blockers, map artifacts, and rollback tests                                    |
| `05_validation_delivery_and_agent_integration.md` | 495 portable tests, enforced coverage, synthetic CI fixtures, installed-data qualification, official MCP Inspector discovery, package/install tests, and end-to-end coding-agent workflows         |
| `06_public_mcp_server.md`                         | Read-only-default stdio and secured Streamable HTTP, OAuth/origin/isolation/limit checks, typed handlers, resource-backed large artifacts, package/Release/GHCR/Registry publication, and examples |

## Simplifications, omissions, and blockers

No required feature was replaced by a mock tool, static placeholder diagram, manual editor,
interactive dashboard, game automation, or unpublished package. No required acceptance item or
release blocker remains. Engine-unknown syntax and renderer fields are preserved and explicitly
reported through refusal diagnostics and fidelity reports; the supported boundaries are listed in
[Known limitations](limitations.md), not hidden behind fallback rewrites.

The immutable earlier release attempts and the exact unpublished `v0.1.4` draft remain unchanged as
audit evidence. One independent post-release Registry read timed out and succeeded on retry; it did
not affect the green release workflow or repeated successful verification.

Detailed commands and failure behavior are documented in [Release and MCP Registry publication](release.md).
