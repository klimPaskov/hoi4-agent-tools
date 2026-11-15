# ADR 0087: Game-build manifests and a focus edit that answers before its check

Status: accepted (maintainer decision D-71, recorded on issue 137)

## Context

Issue 137 asks for a focus edit followed by a fresh inspect to take under a second on a small mod with the game installed. After #156, #166, #178 and the engine symbol index (#174), a warm inspect takes about 0.55 s, a changed `focus_rewrite` about 1.9 s and the first call in a new server about 2.9 s. Two costs are left that only a product decision could remove, and the maintainer took both (D-71):

1. **The game walk.** Since #178 a server keeps what one walk of the installed game found and reuses it while the game's version files stay the same, but only in memory. A new server or job worker, and every worker that released its caches after 30 s idle, walks the game again: it enumerates about 1,300 files with a glob, then resolves, opens and checks each of them.
2. **The after-edit check.** A rewrite answers only after its post-write check (rescan, index, import and lint of the changed tree) has passed. That check is about 0.5 to 0.7 s of the edit.

## Decision

### Game-build manifests

After a full walk of a game root that names its build (`hoi4_rev.txt` and the other version files, as in #178), the scanner records a manifest in the server state folder (`game-manifests/`, one file per scan key): each file's relative path, size, identity (device, file number, size and both change times) and SHA-256, and how many files the patterns matched. The manifest is keyed by the same scan key as the in-memory inventory (game root, patterns, ignores, and the paths mods replace) and carries the build fingerprint. It is authenticated with the server state's journal key, like the transaction journals.

A scan with no inventory in memory loads the manifest for its key and fingerprint and opens the named files directly, without the glob walk or the per-path resolution. Every opened file must still be the one the walk verified: its handle must report the recorded identity and its bytes the recorded hash. A link or junction swapped in after the walk opens a file with another identity, so the walk's containment check still holds.

Anything else falls back to the full walk, which records a new manifest: no server state, no manifest, a changed build, a manifest whose tag or shape does not verify or that names a path outside the root, one file missing, a changed identity or hash, or a scan limit the manifest would pass. `HOI4_AGENT_FULL_GAME_SCAN` still turns the shortcut off. Mods, dependencies and a game folder without version files are always walked. At most eight manifests are kept.

What it does not notice is the same as #178, a file added to the game below its top-level folders without a build change, but a server restart no longer clears it: deleting the `game-manifests` folder or setting `HOI4_AGENT_FULL_GAME_SCAN` does. A game file edited in place is noticed, because its identity changes.

### A focus edit that answers before its check

`hoi4.focus_rewrite` takes an optional `answerBeforeCheck: true`. Without it nothing changes. With it, the call answers as soon as the edit is durably written (journal, atomic replacement and fsync done), with `afterEditCheck: { status: "running", jobId }`. The check then runs exactly as before, in the same job and under the same workspace lock. If it fails, or the server stops before it ends, the edit is undone as today. Its outcome is the job's final result, read with `hoi4.job_inspect` and that `jobId`: the full rewrite result when the check passed, or `JOB_REWRITE_RESTORED` when the edit was undone. A rewrite sent while the check still holds the lock waits for it, up to a bound, instead of failing with `TRANSACTION_LOCKED`.

## Consequences

- A new server or idle worker skips the game walk; the per-file open and read remain.
- An editor that opts in shows the edit about half a second sooner, and it must read the job when it needs to know the edit stood. Callers that do not opt in see no change, so HOI4 Factory's existing calls keep their contract.
- The output schema gains the optional `afterEditCheck` field and the input the optional `answerBeforeCheck`, a backward-compatible minor version.
