# Releasing

A release is a version tag on a commit that is already on `main`.
Pushing the tag starts the `Release` workflow, which validates, packs and publishes everything; nothing is published from a developer machine.
This page is the checklist for the person who tags.

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
