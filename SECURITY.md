# Security Policy

## Supported versions

Security fixes are provided for the latest release.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub private vulnerability reporting for this repository. Include the affected version, transport, configuration, reproduction steps, and expected impact. Reports are acknowledged within seven days; disclosure is coordinated after a fix is available.

## Security boundary

HOI4 Agent Tools can read only configured mod, game, and dependency roots. Only configured mod roots can be changed; game and dependency data remain read-only. The server rejects paths outside those roots, unsafe links, stale edits, cross-mod access, and arbitrary command execution.

Offline renders may contain information derived from the configured workspace but do not expose raw installed-game assets as downloads. The server does not launch or control Hearts of Iron IV.

Local stdio is the recommended transport. Shared or remote HTTP deployments require authentication, exact origin checks, explicit mod access, HTTPS, and narrow filesystem mounts. See [HTTP setup](docs/http.md).
