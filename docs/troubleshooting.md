# Troubleshooting

## Configuration not found

Set `HOI4_AGENT_CONFIG` to an absolute path or add `--config PATH` to the server command. Run `hoi4-agent-tools-setup --diagnose --config PATH`.

## Workspace/path rejected

Use a registered workspace-relative path. Confirm the canonical root is beneath `registrationRoots`; runtime mods also require the separate `writableRegistrationRoots` capability. Check for junctions/symlinks, parent segments, device names, trailing dots/spaces, or alternate data streams. Game and dependencies are intentionally read-only.

## Apply reports stale

The source changed after planning. Do not reuse the transaction. Scan and produce a new dry run so review evidence matches current files.

## Transaction state rejected

Transaction mode requires an absolute, persistent `serverStateRoot` that does not overlap any
source or generated-storage capability. Run setup with `--enable-writes --server-state ROOT`, then
run `--diagnose`. Preserve the same private state root across restarts. A missing key, malformed or
replayed head, unauthenticated legacy manifest, or cache/head revision conflict fails closed; review
and archive the affected journal/state evidence instead of regenerating a public hash or tag.

## Runtime registration conflicts after restart

The artifact root already has a hash-only runtime owner claim. Register the exact canonical
workspace as the same principal, or stop the server and perform an explicit operator-reviewed data
reassignment. Do not delete the claim alone or expect a renamed workspace ID, path alias, or second
principal to inherit the existing evidence.

## Render has missing/unsupported fields

Read the fidelity resource. Register the correct game/dependency root and supply a scenario value or asset. Unsupported fields stay raw; do not treat an approximation as engine evidence.

## HTTP refuses to start

Authentication is mandatory. Static token secrets must be at least 32 characters and are loopback-only. Public binding requires HTTPS `publicUrl`, OAuth settings, allowed origins, and principal grants.

## HTTP returns 401/403/404

- 401: missing/invalid/expired token or wrong issuer/audience.
- 403: origin, scope, principal/workspace, or cross-principal session rejected.
- 404 with session ID: session is unknown or expired; initialize a new MCP session.

## Inspector

Build first, then run `npm run inspector`. The Inspector proxy is a local debugging surface; do not expose it unauthenticated.
