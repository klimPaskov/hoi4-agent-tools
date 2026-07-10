# ADR 0009: npm package, container, and MCP Registry

- Status: accepted
- Date: 2026-07-10

## Decision

Publish the unscoped npm package `hoi4-agent-tools`, with `mcpName` set to `io.github.klimpaskov/hoi4-agent-tools`. The package exposes stable stdio, HTTP, and setup entry points. Build a reproducible container for self-hosted HTTP. Validate `server.json` against the Registry's 2025-12-11 schema and live validation API before immutable Registry publication.

## Rationale

npm is the native distribution path for the selected runtime and is supported by the official Registry verification flow. The Registry provides discovery metadata, not package hosting.

## Consequences

Package, server, schema, changelog, image, and Registry versions remain synchronized for ordinary releases. Publication requires npm and Registry credentials and is never simulated by a local tarball. Release workflows use trusted publishing/provenance when the hosting accounts support it.
