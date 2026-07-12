# Troubleshooting

## Configuration not found

Set `HOI4_AGENT_CONFIG` to an absolute path or add `--config PATH` to the server command. Run `hoi4-agent-tools-setup --diagnose --config PATH`.

## Workspace/path rejected

Use a registered workspace-relative path. Confirm the canonical root is beneath `registrationRoots`; runtime mods also require the separate `writableRegistrationRoots` capability. Check for junctions/symlinks, parent segments, device names, trailing dots/spaces, or alternate data streams. Game and dependencies are intentionally read-only.

## Rewrite reports stale

The source changed after planning or before the workspace lock completed its recheck. Scan again and submit a new rewrite so evidence matches current files. In reviewed compatibility mode, do not reuse the stale transaction.

## Rewrite or transaction tools are missing

Check `writePolicy` in `hoi4.project_status`. `"read-only"` authorizes no source mutation, even if compatibility-named planning or transaction tools are listed by the client. `"autonomous"` exposes `hoi4.focus_rewrite`, `hoi4.gui_rewrite`, and `hoi4.map_rewrite` and intentionally hides all transaction tools. `"transactions"` enables the older plan/diff/apply/status/rollback surface instead. Restart the server and initialize a new MCP session after changing configuration.

## Transaction state rejected

Each write-enabled policy requires an absolute, persistent `serverStateRoot` that does not overlap any
source or generated-storage capability. Run setup with `--autonomous-writes --server-state ROOT` for autonomous rewrites, or `--reviewed-writes --server-state ROOT` for compatibility mode, then
run `--diagnose`. Preserve the same private state root across restarts. A missing key, malformed or
replayed head, unauthenticated legacy manifest, or cache/head revision conflict fails closed; review
and archive the affected journal/state evidence instead of regenerating a public hash or tag.

## The MCP host still asks for approval

The autonomous rewrite tools advertise `destructiveHint: true`. MCP does not require or forbid a prompt; the coding-agent host controls its own approval and filesystem policy, and the server cannot override it. Change the host policy only if that matches your local security requirements.

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
