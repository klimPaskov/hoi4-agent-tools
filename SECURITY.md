# Security Policy

## Supported versions

Security fixes are provided for the latest minor release. A supported-version table is maintained in each release note.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub private vulnerability reporting for this repository. Include the affected version, transport, configuration, reproduction steps, and expected impact. Reports are acknowledged within seven days; disclosure is coordinated after a fix is available.

## Security model

The server is read-only by default. Writes require an allowlisted canonical workspace, an explicitly enabled write policy, a dry-run transaction, a transaction ID, the expected plan hash, and a separate apply request. Remote operation additionally requires authentication, origin validation, request and concurrency limits, and principal-to-workspace authorization.

The server never executes commands supplied by a caller. It rejects path traversal, symlink escapes, stale plans, cross-workspace transactions, and resource reads outside configured roots. Secrets and proprietary game assets are not exposed as resources.

See `docs/security.md` for deployment guidance and threat-model details.
