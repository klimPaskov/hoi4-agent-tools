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

The release workflow uses the npm 11.16.0 CLI bundled with the pinned Node 24.18.0 LTS distribution.
No release job upgrades npm globally. The ordinary npm OIDC publisher does not check out source,
run `npm ci`, execute dependency lifecycle scripts, or install any package. It downloads the one
artifact made by `validate_pack`, checks its recorded commit and SHA-256/SHA-512 digests, rechecks
the public npm state and peeled Git tag, resolves the validated basename to a contained absolute
artifact path, and publishes that exact tarball with `--ignore-scripts` and provenance. The
absolute path is required because npm can parse a slash-containing relative path as a GitHub
repository shorthand. If either the legacy `NPM_TOKEN` or one-use `NPM_BOOTSTRAP_TOKEN` repository secret exists, the ordinary release fails
before requesting or using trusted-publisher credentials.

## One-time npm namespace bootstrap

An unclaimed package cannot have a trusted publisher configured. The one-time manual
`Bootstrap npm trusted publishing` workflow claims the namespace with the non-executable
prerelease `0.0.0-bootstrap.1`; it never publishes a stable release. The `.1` suffix preserves
the immutable audit trail of an earlier `.0` tag whose run stopped before npm accepted any
publication.

1. Create the immutable tag `npm-bootstrap-v0.0.0-bootstrap.1` on the reviewed `main` commit.
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

On an entirely new npm package, the registry can additionally assign the sole bootstrap version
to `latest` even when the publish command explicitly selects `bootstrap`. The first stable release
accepts only the exact observed recovery state: versions contains only `0.0.0-bootstrap.1`, and
the only dist-tags are `bootstrap` and `latest`, both naming that version. Any extra version, tag,
different prerelease, missing bootstrap tag, or malformed state stops publication. Once the first
stable package is published, the normal strict stable-version monotonic and exact-rerun rules apply.

## Immutable fix-forward history

Stable tags and public package versions are never moved, deleted, or overwritten after a failed
release attempt. The retained history is:

- `v0.1.0` stopped during prepublication validation, before any public writer ran;
- `v0.1.1` stopped before npm accepted bytes because npm interpreted a slash-containing relative
  tarball operand as GitHub repository shorthand;
- `v0.1.2` published the exact npm package with trusted-publisher provenance, then stopped in the
  independent verifier because the pinned npm subprocess had been configured with the official
  Registry URL without its trailing slash while the strict verifier required the canonical
  slash-terminated spelling. npm signatures and attestations themselves verified successfully;
  GHCR, GitHub Release, and MCP Registry writers were skipped.
- `v0.1.3` published and independently verified npm, then published the exact two-platform GHCR
  image with SPDX SBOM and SLSA v0.2 provenance for both runtime manifests. Its post-push verifier
  incorrectly required BuildKit's `configSource.uri` to retain the Git tag even though the action
  resolves the default Git context to the immutable commit. The provenance digest and URI were
  commit-bound, and its environment separately carried the exact tag, repository, release workflow,
  workflow SHA, event, and job. GitHub Release and MCP Registry writers were skipped.
- `v0.1.4` published and independently verified npm and the exact two-platform GHCR image, then
  staged an exact four-asset GitHub draft. The live Releases API represented an omitted optional
  asset label as an empty string while the verifier accepted only `null`, so the draft remained
  unpublished and MCP Registry publication was skipped. The tag, npm package, image, draft, and
  draft assets remain unchanged as audit evidence.
- `v0.1.5` published and independently verified npm, the exact two-platform GHCR image, an
  immutable four-asset GitHub Release, and an active/latest MCP Registry record. The final
  cross-surface verifier rejected the Registry's omission of explicit `isSecret: false`, although
  the pinned official schema defines false as that field's default and every public object passed
  its preceding publication gate. All public objects remain unchanged as audit evidence.
- `v0.1.6` completed the ordered workflow and independent verification across npm, GHCR, the
  immutable GitHub Release, and the official MCP Registry.
- `v0.1.7` completed the same ordered workflow with agent-first persistent setup guidance, large
  focus-tree review scaling, symbolic focus-cost preservation, and complete resource-backed focus
  validation. Its exact public evidence is retained in
  [the 0.1.7 completion report](completion-report.md).

`0.2.0` is the current strictly monotonic release candidate. The normal stable-version gate treats
public `0.1.7` as immutable history; only a strictly newer version may be published. Rerunning or fixing a
release never authorizes rewriting a tag, package version, image tag, release asset, or Registry
version.

## Required pre-tag immutability check

GitHub's immutable-release settings endpoint requires repository `Administration:read`, which
the short-lived repository `GITHUB_TOKEN` cannot request. Do not add a long-lived administration
token to Actions for this check. Instead, the repository owner must run the authenticated check
below immediately before pushing each stable release tag:

```bash
test "$(gh api \
  --header 'X-GitHub-Api-Version: 2026-03-10' \
  repos/klimPaskov/hoi4-agent-tools/immutable-releases \
  --jq '.enabled')" = 'true'
```

This owner check is a release prerequisite and must pass before the first public writer starts.
The workflow also requires the completed release to report `immutable: true` before MCP Registry
publication and final verification. That post-publication gate detects a skipped prerequisite,
but it cannot undo a mutable release; an administrator changing the setting between the owner
check and release publication is an external GitHub settings race that the release API offers no
conditional publish operation to close.

## One-time GHCR visibility bootstrap

GitHub creates the first personal-account container package as private. Run the pinned manual
`Bootstrap GHCR` workflow from public `main`, then change package visibility to **Public** in the
package settings. The bootstrap uses only the repository-scoped `GITHUB_TOKEN`, publishes only
the `bootstrap` tag, and verifies the authenticated index contains exact `linux/amd64` and
`linux/arm64` runtime manifests. GitHub exposes no supported API for changing a personal GHCR
package's visibility, so the bootstrap cannot prove anonymous access until an administrator makes
that newly created package public in the package settings.

```bash
gh workflow run bootstrap-ghcr.yml --repo klimPaskov/hoi4-agent-tools --ref main
gh run watch --repo klimPaskov/hoi4-agent-tools
```

After changing visibility to **Public**, prove anonymous visibility and both runtime manifests with
a Docker configuration that contains no credentials:

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
   exact artifact, rechecks npm ordering and the remote peeled tag, resolves the tarball to a
   contained absolute file path, then publishes only when the version is absent. It performs no
   checkout or dependency installation.
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
5. `github_release` uses the authenticated, fully paginated List releases endpoint because
   GitHub's by-tag endpoint exposes published releases but not drafts. It requires zero or one
   exact tag match, cross-checks the published endpoint, and classifies the state as absent, a
   mutable draft, or an already-complete immutable release. Drafts and publications must be owned
   by the canonical GitHub Actions bot, use the exact tag-derived title and checked-in changelog
   body, and expose no asset-label override. An existing draft may contain only a byte-for-byte
   verified subset of the four expected uploaded assets from that same bot; unexpected,
   duplicate, differently uploaded, non-uploaded, or differing assets stop the workflow without
   deletion or replacement. The pinned release action stages missing assets with overwrite
   disabled, canonicalizes the title and body, and leaves the release as a draft. Its numeric
   release ID must match the unique authenticated listing. The workflow then requires the exact
   npm tarball, both npm manifests, and `container-image.json`, repeats the unique-ID, metadata,
   and byte checks, rechecks the peeled tag, and publishes that verified draft once.
   Repository-level release immutability protects the assets and Git tag after publication. An
   exact uploaded subset is resumable; a failed GitHub upload left in `starter` state or a draft
   with noncanonical authorship or labels is a manual draft-cleanup blocker rather than permission
   to overwrite or delete assets automatically. A completed rerun must match the one listed/public
   release ID, canonical metadata, and all four immutable assets exactly.
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
