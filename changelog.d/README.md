# Changelog fragments

Do not edit the `## Unreleased` section of `CHANGELOG.md`. Several pull requests are open at once, and each edit there conflicts with every other one, which costs a full CI run to fix.

Instead, add one new file here for your change:

- Name it after your branch or pull request, for example `map-lookup-inline.md`. Names only need to be unique; the release assembles fragments in file-name order.
- Write one or more top-level bullets (`- ...`), each a complete changelog entry in the style of `CHANGELOG.md`. No headings.

`npm run changelog:check` (part of `npm run check`) fails when `## Unreleased` holds entries or a fragment breaks these rules. The release pull request runs `npm run changelog:release -- <version>`, which moves every fragment into the new version's section and deletes the fragment files. This README is never assembled.
