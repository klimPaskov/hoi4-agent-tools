# Domain-bounded scans

Status: accepted

Public domain tools scan the sources required by their own source model instead of invoking the shared engine's all-domain default inventory. Focus tools include focus sources, linked gameplay identifiers, sprite declarations, and English localisation. Probability tools include supported weighted surfaces and their shared evaluation definitions. Map tools use the map service's connected map inventory directly. Rewrite validation scans the owning domain or the exact changed files.

The shared resolver, scanner, parser, symbol index, diagnostics, artifacts, and transactions remain common infrastructure. Domain selection changes only which relevant sources enter one operation. Unrelated GUI, map, event, technology, or localisation corpora cannot consume another tool's aggregate scan budget.

The scanner's hard byte and file ceilings remain available for malformed single files, deployment limits, and direct engine consumers. Public MCP handlers avoid reaching the aggregate ceiling through unrelated data, while preserving explicit errors when the requested domain itself exceeds a configured deployment policy.
