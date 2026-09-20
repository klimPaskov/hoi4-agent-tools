# Cross-system impact and decisions

`hoi4.impact_inspect` and `hoi4.decision_inspect` analyze authorized HOI4 source without changing it or running the game.
Both tools return a compact result and a linked JSON report containing source locations, hashes, unresolved cases, and the full analysis.
They support ordinary calls and persistent MCP tasks through stdio and HTTP.

## Cross-system impact

Use a symbol when you know the definition you plan to change:

```json
{
  "workspaceId": "current",
  "symbols": [{ "kind": "idea", "id": "rationing" }],
  "maxDepth": 12
}
```

Use `changedFiles` with scanned display paths such as `mod:common/ideas/rationing.txt` to seed every active definition in a file.
Use `proposedSources` to add, replace, or remove files in memory under the authorized mod root; a `null` content removes a source from the proposed snapshot.
When `changedFiles` is omitted, each proposed file seeds all its active definitions alongside any selected symbols.
The report compares the original and proposed consumer graph, including added and removed consumers and affected files.
Moving a source location within one file does not count an unchanged reference as a new or removed consumer.
`expectedRevision` prevents analysis against a source revision different from the one the caller reviewed.
Pass up to 32 workspace-relative JSON paths in `scenarioSuites` to locate cases that declare an affected source selector or scanned display path.
The tool reads reference metadata only; it never runs a case or its assertions.

```json
{
  "schemaVersion": "1.0",
  "id": "policy_checks",
  "cases": [
    {
      "id": "rationing_decision",
      "sourceSelectors": [{ "kind": "decision", "id": "ration" }],
      "sourceFiles": ["mod:common/decisions/rationing.txt"]
    }
  ]
}
```

The suite can carry additional case fields for a later scenario executor; impact analysis reads only `sourceSelectors` and `sourceFiles`.
Malformed, missing, or oversized suite files produce explicit partial coverage.

The graph includes active and overridden definitions, direct and transitive consumers, source locations, state-key reads and writes, and coverage limits.
It connects source-backed event, focus, decision, idea, technology, scripted-helper, localisation, GUI, sprite, and texture references where a typed static edge can be established.
Unresolved dynamic names, missing definitions, skipped sources, cycles, and traversal limits remain explicit in the report.
An affected file is a source dependency lead, not a claim that the game executed that path.

## Decisions and missions

Inventory active decision categories and definitions:

```json
{ "workspaceId": "current", "mode": "inventory" }
```

Inspect one decision under declared actor and target state:

```json
{
  "workspaceId": "current",
  "mode": "inspect",
  "id": "fund_relief",
  "scenarios": [
    {
      "id": "actor_and_target",
      "actor": "AAA",
      "state": { "political_power": 30, "treasury": 20 },
      "flags": ["relief_open"],
      "scopes": {
        "FROM": {
          "id": "BBB",
          "type": "country",
          "actor": "BBB",
          "state": {}
        }
      }
    }
  ]
}
```

`ROOT` is the actor country and `FROM` is the declared target country or state.
The inventory lists active decisions, category fragments, overridden source definitions, and each decision's explicit targets, target arrays, state filters, and target trigger declarations.
Category and decision `allowed`, `visible`, and `available` results remain separate; mission visibility is reported as ignored where documented.
Target selection covers explicit lists and arrays plus supported state ownership, control, and continent filters.
When a target, flag, variable, or helper input is unknown, the corresponding gate remains unresolved.

Costs distinguish automatic engine political-power payment from a custom affordability trigger and its separate `complete_effect` payment.
The report identifies direct deductions, possible double payment, missing direct payment, conditional or helper-dependent paths, repeatability, cooldowns, removal, activation, cancellation, and mission timeout paths.
Removal and cancellation triggers are evaluated under each declared scenario; `cancel_if_not_visible` is evaluated against decision visibility, with unsupported mission visibility left unresolved.
It does not execute these effects or assert that a campaign reached an outcome.

Set `mode` to `compare` and supply `proposedSources` to compare the same scenarios against an in-memory source proposal.
Decision AI scores use the existing probability service's `decision_ai_will_do` and `mission_ai_will_do` adapters, with linked score traces and unresolved input evidence.
Those adapters return scores and eligibility; they do not invent selection probabilities.
When a proposal changes multiple files or adds or removes the weighted definition, the report marks proposed AI scoring unresolved and points to explicit probability comparison.

All paths and scenarios are bounded by the public input schema, and artifacts remain subject to workspace and principal authorization.
