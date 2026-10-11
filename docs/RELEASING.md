# Releasing

A release is a version tag on a commit that is already on `main`.
Pushing the tag starts the `Release` workflow, which validates, packs and publishes everything; nothing is published from a developer machine.
This page is the checklist for the person who tags.

## Publish the 4.0.0 cut-over

The local cut-over installs a packed 4.0.0 build and pins its tarball integrity in the Agentic package and setup app. That integrity is temporary evidence, not a claim that 4.0.0 is already on npm. Nothing in the local cut-over pushes or publishes.

1. Push `feat/v4`, open its pull request into `main`, and merge it after CI passes. Keep the breaking-tool migration and all known-mistake/map updates in the 4.0.0 changelog section.
2. In a clean MCP checkout, run the following against the merged commit:

   ```powershell
   git switch main
   git pull --ff-only
   npm ci
   npm run check
   ```

   Complete the additional release checks and opt-in smoke below. To test the installed tarball itself, set `HOI4_SMOKE_STDIO_ENTRY` to its absolute `dist/bin/stdio.js` path; writes on the real mod remain invalid-input checks, while successful rewrites run on synthetic fixtures.

3. Confirm `git status --porcelain` is empty and the version files all say `4.0.0`. Tag exactly that tested commit and push only the tag:

   ```powershell
   git tag -a v4.0.0 -m "HOI4 Agent Tools 4.0.0"
   git push origin v4.0.0
   ```

4. Wait for every job of the `Release` workflow below to succeed. Do not run `npm publish` locally or move/reuse the tag.
5. Fetch the published identity and install into a new empty prefix:

   ```powershell
   $publishedIntegrity = npm view hoi4-agent-tools@4.0.0 dist.integrity --registry=https://registry.npmjs.org
   $publishedPrefix = Join-Path $env:TEMP ("hoi4-agent-tools-v4-published-" + [guid]::NewGuid())
   npm install --global --prefix $publishedPrefix --ignore-scripts --no-audit --no-fund hoi4-agent-tools@4.0.0
   ```

   In the Agentic package, replace the local tarball pin and recapture the complete installed tree and runtime entry:

   ```powershell
   Set-Location C:/Users/klimp/Documents/Projects/agentic-wiki-fix
   python scripts/refresh_mcp_package_pin.py --prefix $publishedPrefix --integrity $publishedIntegrity
   python -m unittest scripts/test_mcp_bootstrap_contract.py
   ```

   Follow the package's publication TODO and commit only the re-pin source paths. Regenerate file evidence from that exact source commit, then commit the manifest:

   ```powershell
   $sourceRevision = git rev-parse HEAD
   python scripts/generate_manifest_evidence.py --source-root . --revision $sourceRevision --manifest hoi4-mod-setup.manifest.json
   python -m unittest scripts/test_generate_manifest_evidence.py
   ```

   Copy the committed manifest's exact Git blob bytes into the setup app and refresh its source-audit revision/digests. Run both repositories' targeted bootstrap, manifest and MCP health tests, then commit their re-pins. Remove the temporary local-pin TODO only after these published-package checks pass.

6. Point local clients at the verified published installation or install `hoi4-agent-tools@4.0.0` globally and update their registrations with backups. Reconnect clients to replace processes already running the earlier build.

## Before the tag

1. Merge the release branch into `main` through a pull request and wait for the `CI` workflow to pass on the merge commit.
   The release workflow refuses a tag whose commit is not an ancestor of `origin/main`.
2. Keep the version identical in `package.json`, `npm-shrinkwrap.json`, `server.json` and `PACKAGE_VERSION` in `src/hoi4_agent_tools/version.ts`.
   `CHANGELOG.md` needs a `## <version> - <date>` section, because the workflow turns it into the GitHub release page, and `docs/releases/v<version>.md` holds the longer introduction.
3. Run the project check on a clean checkout of that commit:

   ```bash
   npm ci
   npm run check
   npm run test:coverage
   npm run inspector
   npm audit --omit=dev
   npm audit signatures
   ```

4. Run the opt-in suites that need the installed game and a real mod.
   They only read the game and the mod; the report is a per-tool coverage table to keep with the release notes.

   ```bash
   HOI4_GAME_ROOT="C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV" \
   HOI4_EXTERNAL_MOD_ROOT="C:/Users/me/Documents/Paradox Interactive/Hearts of Iron IV/mod/my_mod" \
   HOI4_SMOKE_REPORT="smoke-report.md" \
   npm run test:local
   ```

   The stdio smoke suite in that run calls every exposed tool once against the installed game and once against the mod, then repeats one deliberately wrong call per tool.
   Run `npx vitest run tests/integration/mcp-stdio-smoke.test.ts` for the same check against the project's own fixtures and a generated world.

5. Review `docs/tools.md` against `tools/list`: every tool needs its purpose, an example call and its result-size note.
   `tests/integration/mcp-discovery.test.ts` enforces the size budgets of the listing.

## The tag

```bash
git switch main
git pull --ff-only
git tag -a v<version> -m "HOI4 Agent Tools <version>"
git push origin v<version>
```

The workflow runs these jobs in order, each needing the one before it:

| Job                | What it does                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate_pack`    | Checks the tag, the version files, the authored release notes and the monotonic npm state, runs `npm run check` and the coverage run, packs one tarball. |
| `publish_npm`      | Publishes that tarball with npm trusted publishing and provenance.                                                                                       |
| `verify_npm`       | Reads the published package back and compares it with the tarball.                                                                                       |
| `publish_image`    | Builds and publishes the self-hosted HTTP container to GHCR for `linux/amd64` and `linux/arm64`.                                                         |
| `github_release`   | Creates the GitHub release from `CHANGELOG.md` with the tarball and attestations.                                                                        |
| `publish_registry` | Publishes `server.json` to the MCP Registry.                                                                                                             |
| `verify_public`    | Installs the public package and image anonymously and checks them against the release artifact.                                                          |

## After the release

- Run `npm run publication:verify` and `npm run publication:install` to repeat the public checks from your own machine.
- Install the published package once (`npm install --global hoi4-agent-tools@<version>`), start `hoi4-agent-tools-setup --print-client-config` and open a mod with it.

## If a job fails

- A tag is never reused or moved. A failure before `publish_npm` is fixed on `main` and released under the next patch version.
- npm versions are immutable. A failure after `publish_npm` is repaired by rerunning the failed job from the Actions page, not by retagging.
- Never publish by hand with a long-lived token: the workflow refuses to run while any npm bearer-token secret exists.
