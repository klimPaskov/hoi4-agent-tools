# ADR 0036: Local reference retrieval

Status: accepted

## Context

Modding workflows need installed game documentation, the user's offline wiki snapshot, and exact script precedents. Loading eleven whole wiki pages before routine work consumed more than 1 MB of source text in the measured Chaos Redux workspace. Existing domain inspectors answer structural questions but do not provide bounded documentation sections. Running another MCP server would split workspace identity, source authority, and access control.

## Decision

Expose `hoi4.reference_context`, `hoi4.reference_search`, `hoi4.reference_read`, and `hoi4.source_lookup` from the canonical server. The reference service reads known local documentation roots associated with an authorized workspace. Optional absolute `wikiRoot` and `scriptDocsRoot` registrations are operator-owned; neither is writable through these tools. The installed game documentation is identified separately from the offline wiki and optional generated logs. Results retain source paths, exact line ranges, authority labels, and content hashes. Section reads require the returned revision and use bounded line continuation.

Markdown headings and recognized generated-log names form the documentation sections. The service hashes source bytes and reuses section parsing for unchanged content. Natural-language queries score matched terms in the title, heading, and section body; no model or remote search service is needed. Exact Clausewitz definitions and usages come from the existing shared `SymbolIndex`, including override and scan-completeness evidence. Domain inspect, render, compare, and scenario tools remain the implementation evidence route.

The public package contains no copied wiki pages, game documentation, third-party source, or game artwork. Source roots, file sizes, section counts, result counts, and read windows are bounded. An absent root, skipped source, unknown section, or stale revision is visible to the caller. The service never launches Hearts of Iron IV.

## Consequences

Agents can retain compact citations and reopen the exact section they need. Context bundles select only the wiki and installed documentation relevant to the requested surface. A citation is not a substitute for reading the pertinent section or checking installed documentation when sources conflict. The measured nine-query set found its answer-bearing section within the top five for all nine queries, but this does not prove universal retrieval quality. The public tools add approximately 6.5 KB to MCP discovery; task context bundles are a small fraction of the 1.17 MB eleven-page read. See `docs/research/reference-benchmark.md` for methods and limitations.
