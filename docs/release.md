# Release and MCP Registry publication

Releases use strict stable Semantic Versioning and an immutable Git tag. Every public writer
re-queries both the direct tag and its optional annotated-tag peel immediately before the write.
The peeled commit must equal `GITHUB_SHA` and the commit recorded in the release artifact.

## Prerequisites

- a clean tested commit on `main`;
- package, server, source, schema, documentation, lockfile, and changelog versions synchronized;
- the public GitHub repository owned by the canonical `klimPaskov` account;
- GitHub release immutability enabled in repository settings before the first stable release;
- a public, pre-bootstrapped `ghcr.io/klimpaskov/hoi4-agent-tools` package;
- the npm namespace bootstrap completed and the trusted publisher configured;
- GitHub Actions OIDC available for ordinary npm and MCP Registry publication.

The release workflow uses the npm 11.15.0 CLI bundled with the pinned Node 24.18.0 LTS distribution.
No release job upgrades npm globally. The ordinary npm OIDC publisher does not check out source,
run `npm ci`, execute dependency lifecycle scripts, or install any package. It downloads the one
artifact made by `validate_pack`, checks its recorded commit and SHA-256/SHA-512 digests, rechecks
the public npm state and peeled Git tag, and publishes that exact tarball with `--ignore-scripts`
and provenance. If either the legacy `NPM_TOKEN` or one-use `NPM_BOOTSTRAP_TOKEN` repository secret exists, the ordinary release fails
before requesting or using trusted-publisher credentials.

## One-time npm namespace bootstrap

An unclaimed package cannot have a trusted publisher configured. The one-time manual
`Bootstrap npm trusted publishing` workflow claims the namespace with the non-executable
prerelease `0.0.0-bootstrap.0`; it never publishes a stable release.

1. Create the immutable tag `npm-bootstrap-v0.0.0-bootstrap.0` on the reviewed `main` commit.
2. Create a short-lived npm granular access token with read/write access to **All Packages** and
   bypass-2FA enabled. This broad initial scope is an npm limitation for an unclaimed namespace.
   Give it the shortest practical expiry and store it only as `NPM_BOOTSTRAP_TOKEN`.
3. Dispatch `bootstrap-npm.yml` from that exact tag. The workflow has no `id-token` permission,
   accepts only the hard-coded package/version/dist-tag, runs `npm audit signatures` before the
   write, publishes a two-file non-executable tarball under the `bootstrap` dist-tag, and verifies
   the public bytes and npm registry signature without the token.
4. Revoke the granular token immediately and delete `NPM_BOOTSTRAP_TOKEN`.
5. Configure npm trusted publishing for GitHub owner `klimPaskov`, repository
   `hoi4-agent-tools`, and workflow `release.yml`; explicitly select the required allowed action `npm publish`.
   npm requires an allowed action for configurations created after May 20, 2026.

The ordinary release workflow never supports token fallback. Do not create an `NPM_TOKEN`
secret, and delete `NPM_BOOTSTRAP_TOKEN` immediately after the namespace claim; either secret's
presence deliberately blocks the OIDC publisher.

## One-time GHCR visibility bootstrap

GitHub creates the first personal-account container package as private. Run the pinned manual
`Bootstrap GHCR` workflow from public `main`, then change package visibility to **Public** in the
package settings. The bootstrap uses only the repository-scoped `GITHUB_TOKEN`, publishes only
the `bootstrap` tag, and verifies anonymous `linux/amd64` and `linux/arm64` access.

```bash
gh workflow run bootstrap-ghcr.yml --repo klimPaskov/hoi4-agent-tools --ref main
gh run watch --repo klimPaskov/hoi4-agent-tools
```

Verify visibility with a Docker configuration that contains no credentials:

```bash
ANONYMOUS_DOCKER_CONFIG="$(mktemp -d)"
MANIFEST="$(DOCKER_CONFIG="$ANONYMOUS_DOCKER_CONFIG" \
  docker buildx imagetools inspect --raw \
  ghcr.io/klimpaskov/hoi4-agent-tools:bootstrap)"
RUNTIME_PLATFORMS="$(jq --raw-output \
  '[.manifests[] | select(.platform.os == "linux") | "\(.platform.os)/\(.platform.architecture)"] | unique | sort | join(",")' \
  <<<"$MANIFEST")"
rm -rf "$ANONYMOUS_DOCKER_CONFIG"
test "$RUNTIME_PLATFORMS" = 'linux/amd64,linux/arm64'
```

## Local release audit

```bash
npm ci --ignore-scripts
npm audit --audit-level=high
npm audit signatures --ignore-scripts
npm run check
npm run test:coverage
npm run inspector
REGISTRY_LIVE_VALIDATION=1 npm run registry:validate
npm pack --dry-run --ignore-scripts --json
```

The workflow repeats `npm audit signatures` as a mandatory gate before any public writer can
start. It verifies the package-manager inputs used by the build and later verifies the newly
published package with `npm audit signatures --json --include-attestations`.

## Enforced publication chain

1. `validate_pack` verifies the remote peeled tag, `main` ancestry, canonical identity, npm
   release order, repository/GHCR visibility, all checks, dependency signatures, and coverage. It
   creates one tarball, `npm-pack.json`, and `release-identity.json` bound to the tarball digests
   and source commit. This job has no OIDC permission.
2. `publish_npm` is the minimal OIDC job. It rejects both npm bearer-token secrets, downloads and validates the
   exact artifact, rechecks npm ordering and the remote peeled tag, then publishes only when the
   version is absent. It performs no checkout or dependency installation.
3. `verify_npm` has no OIDC permission. It downloads the public tarball byte-for-byte, runs the
   official npm signature verifier, and passes the exact returned Sigstore bundle to npm's bundled
   official Sigstore verifier with the expected Fulcio issuer and workflow certificate identity.
   Verification requires one signed DSSE envelope, Rekor inclusion, the exact npm PURL and
   SHA-512 subject, GitHub-hosted runner builder, release workflow/tag, and release commit. A
   replayed bundle that differs from the current registry response is rejected.
4. `publish_image` first checks the anonymous exact SemVer tag and GitHub release as one state
   matrix. A completed identical rerun is accepted only when the tag digest equals the immutable
   `container-image.json` release asset. If the tag exists but the later GitHub release does not,
   the workflow reconstructs `container-image.json` from the exact anonymous digest and permits
   recovery only after the normal anonymous verifier proves the index digest, two runtime
   platforms, image source/revision/version labels, SBOM subjects, provenance subjects, source
   tag, and source SHA against `GITHUB_SHA`. A release without its image tag, any mismatched
   release asset, or any failed provenance check stops the chain. A first publication builds from
   the action's default Git context, pushes by digest without a tag, rechecks the Git tag, then
   creates the exact SemVer tag once. No mutable major/minor tag is published.
5. `github_release` creates a release only when none exists and attaches the npm tarball, both npm
   manifests, and `container-image.json`. A rerun never overwrites release assets. Repository-level
   release immutability protects the assets and Git tag after creation.
6. `publish_registry` validates a checksum-pinned official publisher, uses GitHub OIDC, rechecks
   the peeled tag after login, and publishes the exact `server.json` only when absent.
7. `verify_public` re-queries the peeled tag and verifies npm, immutable GitHub release assets,
   anonymous GHCR digest/SBOM/provenance, and complete MCP Registry metadata. It also performs a
   clean public install and registry-signature audit.

The global non-cancelling `release` concurrency group serializes releases. npm, GitHub release,
the exact container tag, and MCP Registry version are treated as immutable: existing matching
objects may make a completed rerun idempotent, while absent records, moved tags, ambiguous state,
or differing bytes/digests stop the chain. The Registry hosts metadata, not package bytes; local
validation alone is never treated as publication evidence.
