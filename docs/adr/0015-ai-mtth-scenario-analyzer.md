# ADR 0015: AI and MTTH Scenario Analyzer

- Status: accepted
- Date: 2026-07-22

## Decision

Add a sixth domain that evaluates HOI4 weighted logic through seven read-only MCP tools: inspect, evaluate, sweep, simulate, sequence, compare, and render. Use the shared workspace resolver, Clausewitz source documents, symbol index, diagnostics, artifacts, caching, cancellation, and resource transport. Register one optional `hoi4.probability_analysis` prompt.

Each weighted surface has its own versioned adapter. Exact categorical pools, independent chances, nested categorical paths, uniform score races, score-only systems, and the verified MTTH timing model remain distinct. Missing state, incomplete candidate pools, unsupported dynamic identifiers, and unverified external factors produce bounds, `external` support, or unresolved results instead of guessed probabilities. Configured installed-game roots must match the adapter's supported version and checksum before evaluation proceeds.

Scenario sets declare world state, alternatives, ranges, distributions, numeric correlations, prevalence, acceptance bands, diagnostic thresholds, and scheduled changes. Sweeps expose local and pairwise sensitivity around trigger breakpoints. Deterministic simulation defaults to constant-memory Latin hypercube sampling and records statistical and timing-quantile evidence. Stateful sequence analysis executes only transitions in a validated custom-pool manifest and reports candidate and category outcomes. Proposed source is parsed in memory. Large matrices, traces, simulations, and visuals are stored as content-addressed resources.

The public server exposes 23 tools, one prompt, and one artifact resource template. The measured tool-list payload must remain within 48 KiB, with per-tool schema and description budgets retained.

## Rationale

HOI4 uses materially different selection and timing rules across event options, random lists, focuses, technologies, decisions, missions, AI strategies, direct random checks, and MTTH. A shared but adapter-specific analyzer lets coding agents test those systems without confusing score ranking with normalized probability or hiding unknown campaign state.

## Consequences

The public package includes generated JSON Schemas, callable examples, adapter evidence, a 250-scenario synthetic fixture, deterministic analysis artifacts, and tests for exact identities, uncertainty, state transitions, comparisons, isolation, cancellation, performance, both transports, package installation, and MCP Inspector discovery.

Earlier ADRs remain historical records for the releases in which they were accepted. Their 16-tool, 32 KiB, and no-prompt limits are superseded by this decision.
