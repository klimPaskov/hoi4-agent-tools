# Artifact resources

Tools return compact summaries and links. Content is stored by SHA-256 under the workspace's configured artifact root and exposed through an authorization-checked URI:

```text
hoi4-agent://workspace/{workspaceId}/artifact/{sha256}/{provenanceHash}/{name}
```

Each version-2 manifest records name, MIME type, byte size, content hash, artifact kind,
tool/schema version, SHA-256 source hashes, render profile, domain metadata, and hash-only bindings
for the resolved workspace and its configured or runtime owner. Filesystem paths and raw principals
are not exposed. Missing/create/delete states belong in provenance metadata, never sentinel values
inside the source-hash map.

Very broad domain inventories retain a deterministic path/hash sample capped at 256 entries and
128 KiB in the manifest, plus a count and a SHA-256 commitment over every length-prefixed sorted
path/hash pair. This policy applies uniformly to project, focus, GUI, and map evidence. Complete
inventories remain in the structured artifact content: project diagnostics use their exact `files`
inventory, while focus, GUI, and map JSON evidence records exact source hashes. Binary and HTML
review artifacts carry the same bounded, digest-backed provenance and are paired with the exact
structured evidence for their bundle. Bounding a manifest therefore does not drop source evidence.
The inventory commitment uses the versioned `sha256-length-prefixed-path-digest-v1` algorithm
recorded in metadata.

The manifest is immutable for a given content hash, provenance hash, and artifact name. Repeating the same bytes, name, and provenance is idempotent. Identical content produced from a different source revision receives a distinct provenance hash and URI while reusing the same content-addressed bytes, so earlier evidence is never rewritten or ambiguously relabelled.

Artifact names ending in `.manifest.json`, under an ASCII case-insensitive comparison, are reserved
for store metadata and rejected. This rule is identical on case-sensitive and case-insensitive
filesystems, so content can never be mistaken for an inventory manifest.

The workspace and owner bindings participate in the provenance hash and are checked by list,
describe, and resource reads. A store reused by another workspace ID, canonical root topology, or
runtime principal cannot enumerate or read the older manifests. Statically configured workspaces
derive one shared operator identity, so all explicitly granted principals retain their intended
access. Legacy unbound manifests and malformed/conflicting manifests fail closed; the server does
not delete or relabel them automatically.

Resource reads are limited to 1 MiB per request and support `offset` and `length` query parameters for large artifacts. Integrity verification streams the complete artifact through a fixed-size hash buffer while retaining only the requested range, so chunking also bounds payload memory. Only a complete payload that round-trips as strict UTF-8 may return MCP `text`. Every partial range, invalid UTF-8 payload, image, and other binary returns an MCP base64 `blob`, preserving exact bytes even when a range splits a code point. Clients advance `offset` by the decoded byte count and continue until a chunk is shorter than the requested length; the same rule applies to provenance-manifest resources.

Some complete logical evidence, notably an installed workspace's GUI source graph, can legitimately
be larger than `artifactMaxSingleBytes`. Callers that opt into byte-exact logical storage receive a
normal artifact when the payload fits. An oversized payload instead returns one small canonical
JSON index named `*.chunks.json`. The index records `type = hoi4-agent.chunked-artifact`, the
original name, MIME type, size, SHA-256 and description, followed by ordered chunk resource links
with indexes, byte offsets, lengths and SHA-256 hashes. Chunks use
`application/octet-stream`; concatenating their decoded bytes in index order must reproduce the
recorded original size and SHA-256 exactly. The index itself is limited to 1 MiB so an MCP client
can read it in one request.

The chunks and index are one atomic artifact batch. Every physical object and provenance manifest
counts against the same aggregate-byte and entry quotas, every chunk remains at or below the
configured per-object ceiling, and any admission, write, cancellation or owning-commit failure
removes all files newly created by the bundle. This representation is lossless storage, not graph
truncation or a quota bypass. `hoi4.gui_scan` and GUI render source-graph evidence return only the
logical index link; agents follow its resource links when they need the full graph.

Logical chunk preparation has a separate fixed 536,870,912-byte in-memory batch ceiling, and a
lower configured `artifactMaxBytes` always wins. Before any payload is copied or hashed, admission
validates every logical write's name, provenance and byte length, checks safe aggregate arithmetic,
and projects the complete physical entry count after chunking. Preflight yields after each 256
logical writes so cancellation can stop a broad batch before preparation. Preparation is then
sequential, verifies that each admitted byte length is unchanged, and yields during hashing every
16 MiB. Chunks share the one owned logical buffer during preparation instead of duplicating it.
Crossing the fixed preparation ceiling fails with `ARTIFACT_LOGICAL_BATCH_LIMIT` before allocation.

Artifact listing is paged at no more than 100 links. The store walks the complete sorted manifest
inventory to verify bindings and compute an exact SHA-256 inventory revision, but retains only the
requested page in memory. Cursors name the last public URI and are accepted only when that exact URI
still occurs under the same revision. Listing and content verification honor request cancellation
between directories, manifests, and hash chunks.

Manifest reads stat the file and enforce the fixed 1 MiB ceiling before signal-aware JSON loading.
Artifact writes, existing-content verification, quota walks, and queue waits also honor
cancellation. A cancelled batch completes non-cancellable cleanup of every partial file. Once the
caller's commit callback begins, that callback owns its critical-phase completion rules.

## Storage placement

A mod workspace defaults to `<mod>/.hoi4-agent/artifacts`; any in-mod override must remain beneath
that exact generated subtree. An operator may instead place it beneath a configured `storageRoots`
parent. A primary `game` or `dependency` workspace must always use an explicit operator-owned
artifact root beneath `storageRoots`, separate from its explicit cache root. Artifact and cache
roots cannot overlap each other or a source root.

Generated artifact writes never make the game, dependency, or fixture source writable. Source
changes are a separate transaction surface and are confined to the mod root.

## Retention quotas

The default per-workspace limits are:

- `artifactMaxBytes`: 536,870,912 bytes across content and manifests;
- `artifactMaxEntries`: 5,000 provenance manifests;
- `artifactMaxSingleBytes`: 134,217,728 bytes for one content object;
- serialized provenance manifests have a separate fixed 1 MiB ceiling and bounded fields.
- one logical chunk-preparation batch has a fixed 536,870,912-byte ceiling.

Content deduplication means a reused content hash adds no duplicate content bytes, while a new
provenance manifest still counts as an entry and consumes its serialized bytes. Within one server
process, the store measures current usage under an in-process per-root write queue before adding
immutable files. Multi-artifact operations preflight all logical writes and their projected
normal/chunk/index entries as one batch before payload copying or hashing, then retain newly created
content and manifests only if their owning operation commits. A failed transaction-journal
admission removes the diff files created by that batch without deleting pre-existing shared
content or provenance. If the complete content and manifest would exceed a count, aggregate-byte,
or per-object ceiling, the store refuses the write with `ARTIFACT_STORAGE_LIMIT`,
`ARTIFACT_LOGICAL_BATCH_LIMIT`, `ARTIFACT_SINGLE_LIMIT`, `ARTIFACT_CHUNK_INDEX_LIMIT`, or
`ARTIFACT_MANIFEST_LIMIT`; it does not write a truncated artifact or evict older evidence. Listing
also refuses when an externally modified store is already over its configured retention budget.

Artifact retention has no automatic garbage collector. Operator deletion is explicit and should
be coordinated with active requests; deleting an artifact invalidates its URI. In contrast,
transaction-journal cleanup follows the separate rules in [transactions](transactions.md). Do not
share one writable artifact root between uncoordinated server processes; an operating-system
storage service or operator must provide that coordination.

Typical artifacts:

- shared diagnostics and capability reports;
- focus HTML/SVG/PNG/JSON, generated-source maps, and hash-bound planning sidecars;
- GUI renders, galleries, hierarchy/click maps, comparisons, and fidelity reports;
- map layers, changed-pixel reports, and before/after previews;
- transaction manifests, source diffs, binary diffs, and validation reports.

Structured JSON evidence records source paths, hashes, frame numbers, dimensions, formats, and
fidelity metadata, but strips embedded `data:` payloads and glyph bitmap bytes. Composite SVG and
PNG review renders may contain processed, source-derived icon, sprite-frame, or font-glyph pixels
needed to inspect the requested interface; they are principal-bound generated evidence, not raw
asset-file resources. The server never registers an installed-game, dependency, or mod raster/font
file itself as an artifact.

Artifacts are evidence. External HOI4 source remains authoritative. Deleting the configured
artifact root invalidates only generated evidence, not mod content.
