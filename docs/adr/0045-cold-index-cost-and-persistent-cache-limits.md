# ADR 0045: Where a cold index spends its time, and what the persistent cache can and cannot save

## Context

The first call on a large mod is slow: `hoi4.mod_index`, an event lint and a decision inventory each begin with a scan of every source file, and a new server process repeats it.
The persistent analysis cache exists to avoid that, and a note in ADR 0039 says it stores at most 16 new entries and 1 MiB per scan, so a warm-up of the cache looked like the cheap fix.
This decision records what profiling the real Chaos Redux mod (2,758 indexed files, 262,000 symbols, 140 MB of cached facts) showed, on a machine shared with a running game and other tools, so wall-clock times are inflated and CPU times are the figures to compare.

## Findings

- A cold in-process scan of the mod layer costs 18 to 22 seconds of CPU. About 60% of the profile is index building, a third is the parser and a fifth the lexer; roughly 15% is canonical JSON, and the scanner's per-file `realpath`, `stat`, `open`, `fstat`, `read` and `close` calls add the rest of the wall-clock time on Windows.
- A fully populated persistent cache did not shorten that: a scan with every cached entry present cost 18 to 21 seconds of CPU. Reading, authenticating and deserializing 140 MB of parsed documents cost about as much as parsing them again.
- The cache cannot hold most of the mod in any case. Entries are exported from the in-process document and index-segment caches, which keep 64 MiB each, so only about 550 entries for the 2,758 files ever reach the disk, however many scans write them.
- A background warm-up that kept writing batches after a scan was built and measured. It reached the same ceiling (everything the memory caches held) and, because a document larger than the batch budget could never be written, it looped without progress until that was fixed. It was removed: it adds work on a shared machine and cannot lift the ceiling.

## Measured timings

`npm run benchmark:cold` on the real Chaos Redux mod (2,758 indexed files) and the installed game, on 11 October 2026, with a HOI4 campaign and several other agents running, wall-clock seconds:

| Call                                               | First process, empty state | Second process, same state |
| -------------------------------------------------- | -------------------------- | -------------------------- |
| `hoi4.mod_index` overview                          | 14.8                       | 13.3                       |
| `hoi4.event_inspect` lint of the largest namespace | 11.8                       | 13.2                       |
| `hoi4.decision_inspect` inventory                  | 32.9                       | 41.8                       |

The second process is not faster, as the findings above explain; the spread between the columns is load, not caching.
The decision inventory is the slowest of the three; it was not profiled separately from the index build it triggers.

## Decision

Keep the bounded per-scan persistence and make each stored entry cheaper to load, which is measurable per entry and does not change what is cached:

- Entries are authenticated over their metadata and payload hash instead of the whole payload, so a parsed document is hashed once on load instead of passing through canonical JSON and the HMAC as well. The entry format version becomes 2; older entries are rejected as invalid and rewritten.
- Parsed documents are decoded when first read, not for every file at load. A stored document that cannot be decoded counts as a miss and the file is parsed again.
- A scan no longer copies the payload of an entry that is already stored before deciding not to write it.
- The canonical copy used for hashing and for the encoded index segments fills its objects directly instead of building an entry array per member, about 40% faster on large segments with byte-identical output.

`npm run benchmark:cold` times the three slow first calls (`hoi4.mod_index`, `hoi4.event_inspect` lint and `hoi4.decision_inspect` inventory) through the stdio entry point in a first process and in a second process on the same state folder.

## Consequences

A cold index of a large mod stays dominated by lexing, parsing and indexing, so the first call remains slow; the next call in the same process, and any call inside a warm job worker, reuses the loaded index.
Making a later process faster needs the index facts of every file to survive on disk, which means persisting index segments as they are built instead of exporting what the memory caches kept, and a larger or configurable memory budget; that is a separate piece of work and is not done here.
The scanner re-reads and re-hashes every source file on every scan by design (ADR 0039); trusting file metadata for the read-only game folder would remove most of the syscalls, at the cost of that guarantee.
