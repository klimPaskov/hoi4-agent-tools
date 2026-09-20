# Mechanic tests, package checks, and scenario suites

`hoi4.mechanic_test`, `hoi4.package_check`, and `hoi4.scenario_test` read authorized HOI4 source and return linked, revision-bound evidence.
They do not launch the game or change source files.
Supply `expectedRevision` when continuing analysis against a reviewed scan.

## Test an effect

`hoi4.mechanic_test` copies a versioned scenario, selects each active source effect, applies explicit steps, and evaluates typed assertions.
Source selectors support `scripted_effect`, `event_option`, `decision`, and `focus_reward`; event options also need `option`.
An `advance_days` step only expires modeled timed flags; it never runs on actions.

```json
{
  "workspaceId": "current",
  "test": {
    "id": "treasury_transfer",
    "scenario": {
      "schemaVersion": "1.0",
      "id": "treasury_transfer",
      "state": { "treasury": 10, "savings": 2 },
      "closedFlags": true
    },
    "steps": [{ "kind": "effect", "source": { "kind": "scripted_effect", "id": "transfer" } }],
    "assertions": [
      {
        "id": "total_conserved",
        "kind": "conservation",
        "paths": [{ "key": "treasury" }, { "key": "savings" }]
      },
      {
        "id": "single_charge",
        "kind": "single_payment",
        "balance": { "key": "treasury" },
        "cost": 3
      }
    ]
  }
}
```

The linked trace records applied, skipped, and unresolved source operations with before and after values.
The `single_payment` assertion checks the named balance's final change and the number and size of its traced deductions, so a compensating grant cannot hide a second charge.
Supported operations include documented variable arithmetic, flags, event targets, arrays, conditionals, finite declared scope iteration, scripted helpers, safe meta substitutions, and selected balance effects.
Decision engine political-power costs are applied once before `complete_effect`; custom cost triggers check affordability and their payment remains in `complete_effect`.
Unresolved eligibility, unsupported effects, dynamic names that cannot be resolved, missing finite scope catalogs, and bounded-work limits remain unresolved rather than guessed.
An effect with an unknown write set conservatively makes state assertions unresolved.
This is source interpretation of declared steps, not campaign simulation.

## Check a package

`hoi4.package_check` accepts a declarative manifest with `schemaVersion: "1.0"` and an `id`.
Add expected `definitions` and `calls` as `{ "kind": "scripted_effect", "id": "transfer" }` selectors, `registrations` as workspace-relative path and token pairs, `localisation` keys, `assets` as workspace-relative paths, and `requiredCases` as suite path and case id pairs.
The report separates present, absent, shadowed, and unresolved links and includes source hashes and locations.
Required cases are checked for declaration; run `hoi4.scenario_test` to evaluate them.
The manifest accepts no source patches or executable commands.

## Run a suite

`hoi4.scenario_test` accepts either an inline `suite` or an authorized workspace-relative `suitePath`.
The suite has `schemaVersion: "1.0"`, an `id`, and named `cases` in the `mechanic`, `package`, or fixed read-only `tool` domain.
A mechanic case supplies the same `test` as `hoi4.mechanic_test`; a package case supplies a `manifest`.
A tool case names one allowed inspect, render, or evaluate operation and supplies its typed `arguments`.
Cases may declare `sourceSelectors`, output path assertions, and `views` (`summary`, `artifacts`, `diagnostics`).

Set `maxCases` to bound a batch.
Each case receives a content-addressed result artifact; the batch returns its counts and, while cases remain, a `continuation`.
Pass that continuation with the same suite to resume.
The token is authenticated and bound to the workspace, caller, suite content, and source revision; changed inputs or source require a fresh run.
Every requested case is reported as completed, failed, unresolved, or pending.
