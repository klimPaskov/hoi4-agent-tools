# Security Policy

## Supported versions

Security fixes are provided for the latest minor release. A supported-version table is maintained in each release note.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub private vulnerability reporting for this repository. Include the affected version, transport, configuration, reproduction steps, and expected impact. Reports are acknowledged within seven days; disclosure is coordinated after a fix is available.

## Security model

The server is read-only by default. In the recommended `"autonomous"` policy, the domain rewrite tools validate proposed bytes, persist an authenticated recovery journal, apply under a workspace lock, post-validate, and automatically restore the original bytes on failure in one call. The optional `"transactions"` compatibility policy retains a separate reviewed plan/diff/apply sequence. Both require an allowlisted canonical write-enabled mod workspace and an isolated operator state root. Remote operation additionally requires authentication, origin validation, request and concurrency limits, and principal-to-workspace authorization.

MCP tool annotations describe risk but do not mandate per-tool confirmation. Autonomous rewrite tools advertise `destructiveHint: true`; the server cannot suppress, require, or override prompts and filesystem restrictions imposed by the MCP host.

The server never executes commands supplied by a caller. It rejects path traversal, symlink escapes, stale source revisions, cross-workspace writes, and resource reads outside configured roots. Secrets and proprietary game assets are not exposed as resources. Git should retain project history, while the internal journal and recovery blobs protect an in-progress multi-file rewrite from partial failure.

See `docs/security.md` for deployment guidance and threat-model details.
