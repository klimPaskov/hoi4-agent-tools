# Completion report: 0.1.0 release candidate

- Candidate version: `0.1.0`
- Report date: 2026-07-10
- Status: implementation and local release qualification complete; public delivery pending

## Implemented scope

The release candidate provides the shared source-preserving core, Focus Tree Workbench, Scripted GUI Studio, Agent Nudger map workflow, read-only-by-default transaction controls, stdio and authenticated Streamable HTTP transports, package entry points, schemas, synthetic portable fixtures, and public deployment documentation described by this repository.

The npm payload is explicitly limited to compiled entry points, documentation, schemas, `server.json`, and the project license, security policy, README, and changelog. Installed-game data, third-party mod data, fixtures, tests, source files, local configuration, and workspace artifacts are excluded.

## Qualification evidence

The candidate has passed all 45 portable test files: 450 tests passed and one POSIX case was intentionally skipped on Windows. The latest enforced coverage is 88.16% statements, 77.78% branches, 91.23% functions, and 89.72% lines.

Release-specific qualification also covers:

- installation of the actual `npm pack` tarball into an isolated consumer, including an empty-cache install that proves `--prefer-offline` can fetch missing dependencies;
- execution of the installed stdio, HTTP, and setup entry points;
- package-content allowlisting, workspace-path leak checks, synchronized package and Registry metadata, and generated-schema checks;
- npm dependency audit, registry signatures, and attestations;
- live validation against the official MCP Registry API and pinned schema;
- official MCP Inspector discovery against the production stdio entry point;
- a production Docker build and protocol-only container stdio initialization/discovery, with local image digest `sha256:bd4dacc98870d59ddf6ec649f797880d829af46756377cd5235541c63e0fc127`;
- immutable GitHub Action references, workflow and shell linting, strict release ordering, and byte-for-byte npm/GitHub release verification;
- pinned Dockerfile-frontend and Node base-image digests, a multi-platform base supporting `linux/amd64` and `linux/arm64`, and a warning-free Docker build check;
- read-only production-container checks proving OAuth metadata discovery, unauthenticated `401`, invalid-Origin `403`, protocol-only stdio initialization/discovery, and a real `hoi4.project_status` call;
- three installed-data qualifications covering a large vanilla/external focus workflow, a real GUI/GFX/font graph with deterministic full/annotated renders, and full province-map scan/render/storage without launching the game; the 302,497,021-byte canonical GUI graph was stored exactly as three bounded resources plus its one-read index while the default 128 MiB per-object ceiling remained enabled;
- deterministic cold/warm benchmark output for the 255-focus, 203-visible-element GUI, and all-layer map workloads, including same-size/same-mtime content-hash invalidation.

Known refusal cases and intentional boundaries remain documented in [Known limitations](limitations.md). They are explicit product constraints, not fallback implementations.

## Public delivery status

No public endpoint is claimed as complete in this report. The following evidence remains pending until the first release workflow finishes:

| Surface        | Required completion evidence                                                                              | Status  |
| -------------- | --------------------------------------------------------------------------------------------------------- | ------- |
| GitHub source  | Public canonical repository containing the tested commit and immutable `v0.1.0` tag                       | Pending |
| npm            | Public `hoi4-agent-tools@0.1.0` with exact tarball integrity and SLSA provenance                          | Pending |
| GitHub release | Immutable `v0.1.0` release containing the exact npm and container digest manifests                        | Pending |
| GHCR           | Public anonymous `0.1.0` digest with two runtime platforms and source-bound SBOM/provenance subjects      | Pending |
| MCP Registry   | Exact `io.github.klimPaskov/hoi4-agent-tools@0.1.0` metadata with official `active` and `isLatest` status | Pending |
| Public install | Clean registry installation, signature audit, MCP initialization, and tool discovery                      | Pending |

## First-release completion sequence

1. Commit the tested candidate on `main` and push it to the canonical public repository.
2. Run the manual GHCR bootstrap workflow, make the new package public in GitHub, and verify the bootstrap index without saved credentials.
3. Create `npm-bootstrap-v0.0.0-bootstrap.0`, store a shortest-lived npm granular token only as `NPM_BOOTSTRAP_TOKEN`, and run the manual non-OIDC npm bootstrap workflow from that tag.
4. Revoke and delete `NPM_BOOTSTRAP_TOKEN`, then configure npm trusted publishing for `klimPaskov/hoi4-agent-tools`, `release.yml`, and the explicit `npm publish` allowed action.
5. Create and push the immutable `v0.1.0` tag only after CI passes on the tagged commit. Do not create `NPM_TOKEN`; the OIDC workflow rejects it.
6. Allow the release workflow to publish and verify npm, digest-immutable GHCR, the immutable GitHub release, and MCP Registry in its enforced order.
7. Update this report with the commit, workflow run, public URLs, npm and image digests, and Registry status. Only then is public delivery complete.

Detailed commands and failure behavior are documented in [Release and MCP Registry publication](release.md).
