# Completion report: 0.1.4 release candidate

- Candidate version: `0.1.4`
- Report date: 2026-07-11
- Status: fix-forward implementation in qualification; public delivery incomplete

## Implemented scope

The release candidate provides the shared source-preserving core, Focus Tree Workbench, Scripted GUI Studio, Agent Nudger map workflow, read-only-by-default transaction controls, stdio and authenticated Streamable HTTP transports, package entry points, schemas, synthetic portable fixtures, and public deployment documentation described by this repository.

The npm payload is explicitly limited to compiled entry points, documentation, schemas, `server.json`, and the project license, security policy, README, and changelog. Installed-game data, third-party mod data, fixtures, tests, source files, local configuration, and workspace artifacts are excluded.

## Qualification evidence

The candidate has passed all 46 portable test files: 495 tests passed and one POSIX case was intentionally skipped on Windows. The latest enforced coverage is 88.44% statements, 78.25% branches, 91.28% functions, and 89.90% lines.

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

No complete multi-surface public release is claimed in this report. The following evidence remains
pending until the `0.1.4` fix-forward workflow finishes:

| Surface        | Required completion evidence                                                                              | Status       |
| -------------- | --------------------------------------------------------------------------------------------------------- | ------------ |
| GitHub source  | Public canonical repository containing the tested commit and immutable `v0.1.4` tag                       | Pending      |
| npm            | Public `hoi4-agent-tools@0.1.4` with exact tarball integrity and SLSA provenance                          | `0.1.3` only |
| GitHub release | Immutable `v0.1.4` release containing the exact npm and container digest manifests                        | Pending      |
| GHCR           | Public anonymous `0.1.4` digest with two runtime platforms and source-bound SBOM/provenance subjects      | `0.1.3` only |
| MCP Registry   | Exact `io.github.klimPaskov/hoi4-agent-tools@0.1.4` metadata with official `active` and `isLatest` status | Pending      |
| Public install | Clean registry installation, signature audit, MCP initialization, and tool discovery                      | Pending      |

## First-release completion sequence

1. Commit the tested candidate on `main` and push it to the canonical public repository.
2. Run the manual GHCR bootstrap workflow, make the new package public in GitHub, and verify the bootstrap index without saved credentials.
3. Create `npm-bootstrap-v0.0.0-bootstrap.1`, store a shortest-lived npm granular token only as `NPM_BOOTSTRAP_TOKEN`, and run the manual non-OIDC npm bootstrap workflow from that tag. The earlier immutable `.0` attempt stopped before publication; it is retained as audit evidence rather than rewritten.
4. Revoke and delete `NPM_BOOTSTRAP_TOKEN`, then configure npm trusted publishing for `klimPaskov/hoi4-agent-tools`, `release.yml`, and the explicit `npm publish` allowed action.
5. Preserve `v0.1.0` and `v0.1.1`, the immutable `v0.1.2` npm-only state, and the immutable `v0.1.3` npm-plus-GHCR state. Do not create `NPM_TOKEN`; the OIDC workflow rejects it.
6. Qualify the synchronized `0.1.4` fix-forward commit, including strict commit-resolved BuildKit provenance plus independent tag/workflow bindings, then create `v0.1.4` only from an exact green commit.
7. Allow the release workflow to publish and verify npm, digest-immutable GHCR, the immutable GitHub release, and MCP Registry in its enforced order.
8. Update this report with the commit, workflow run, public URLs, npm and image digests, and Registry status. Only then is public delivery complete.

Detailed commands and failure behavior are documented in [Release and MCP Registry publication](release.md).
