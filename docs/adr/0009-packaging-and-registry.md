# ADR 0009: npm package, container, and MCP Registry

- Status: accepted
- Date: 2026-07-10

## Decision

Publish the unscoped npm package `hoi4-agent-tools`, with `mcpName` set to `io.github.klimPaskov/hoi4-agent-tools`, matching the canonical case-sensitive GitHub owner used for Registry OIDC namespace ownership. The package exposes only stable stdio, HTTP, and setup executables; it does not publish a library export or repository JSON schemas. Builds omit declarations, declaration maps, and source maps. Build a reproducible container for self-hosted HTTP from immutable Dockerfile-frontend and base-image digests. Validate `server.json` against the Registry's 2025-12-11 schema and live validation API before immutable Registry publication.

## Rationale

npm is the native distribution path for the selected runtime and is supported by the official Registry verification flow. The Registry provides discovery metadata, not package hosting.

## Consequences

Package, server, changelog, image, and Registry versions remain synchronized for ordinary releases. Repository schemas remain generated validation inputs but are excluded from the npm payload. One workflow-built tarball is the npm payload and GitHub release asset, and public verification binds its bytes to npm integrity, provenance, and Registry metadata. The first npm version uses a short-lived granular access token with read/write access to **All Packages** and bypass-2FA because an unclaimed package cannot yet have a trusted publisher; that token is revoked after public verification, and later releases use the pinned npm 11 OIDC trusted-publishing path with the explicit `npm publish` allowed action. Release jobs do not restore package-manager caches. A one-time non-release GHCR push and interactive visibility change are required before the first release because new personal container packages are private by default.
