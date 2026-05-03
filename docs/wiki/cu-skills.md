# Computer-use skill library (recipes)

> **Status: Planned** (see task task #96 (trajectory memory & skills)).
>
> The CU recipe library does not exist yet. Two unrelated things are
> *also* called "recipe" in the codebase today and should not be
> confused with this one:
>
> - The `recipes` table ([data-model](./data-model.md)) — saved CLI
>   command chains. Different concept.
> - `nav_recipe_*` keys in `agent_config` produced by
>   [`server/replay-engine.ts`](../../server/replay-engine.ts) —
>   per-screen-edge navigation procedures. Closer cousin; the CU skill
>   library is the cross-surface evolution of this idea.

## Intent (2-3 sentences)

Successful CU trajectories should not be re-discovered every time. The
skill library captures `(verifier?, action, verifier?)` triples
parameterized by what the trajectory actually depended on, lets the
matcher re-use them on future tasks, and falls back gracefully when a
recipe's verifier fails. Promotions are gated by an analyst (so the
library doesn't fill up with one-off junk), and every recipe carries
enough provenance to audit "where did this come from".

## Planned schema

Lives in `recipes` (new table — distinct from today's CLI-chain
`recipes`; see the [data-model](./data-model.md) update for the
disambiguation plan, which is to rename the existing table to
`cli_recipes` or namespace the new one as `cu_recipes`):

```ts
{
  id, name, surfaceKind, taskKind,
  preconditions: Verifier[],
  steps: { action: Action, postcondition?: Verifier }[],
  successCriteria: Verifier[],
  provenance: {
    sourceTrajectoryId,
    promotedBy: "analyst" | "auto",
    seedRecipe?: boolean,
  },
  confidence: number,
  runCount: number,
  successRate: number,
  tags: string[],
  createdAt,
}
```

A `recipe_runs` row is written for every replay attempt with the bound
parameter values, the verdict, and a pointer back to the
`RouterTrace` for inspection.

## Planned promotion pipeline

```
successful trajectory
   → summarizer (LLM)        ← cheap tier; produces a draft Recipe
   → matcher dedupe          ← merges into existing recipe if near-duplicate
   → analyst approval queue  ← reviewed in the inspector (see cu-inspector)
   → committed Recipe row    ← becomes available to the matcher
```

The summarizer pass uses the [model-router](./model-router.md)'s cheap
tier and is gated by the same daily budget. The analyst-approval queue
appears in the [cu-inspector](./cu-inspector.md) as a "promote this
trajectory?" pane.

## Planned matcher

Before each CU step, the [smart router](./cu-router.md) asks the matcher
whether any recipe's preconditions match the current observation +
task. A match short-circuits the model call: the recipe's steps run
directly, with each `postcondition` enforced as it goes.

## Planned fallback-on-verifier-failure

If a recipe's `postcondition` fails mid-replay, the recipe is *not*
silently abandoned. Instead:

1. The router records a `recipe-miss` event (provenance is preserved).
2. Falls back to a fresh model-driven step at the failure point.
3. If that succeeds, the trajectory promoter proposes an alternative
   step / new recipe variant for analyst review.

## Planned provenance tagging

Every recipe carries:

- `sourceTrajectoryId` — the `RouterTrace` it was learned from.
- `promotedBy` — `analyst` or `auto` (auto only allowed for
  seed-shipped recipes).
- `seedRecipe` — true when the recipe shipped at launch (e.g. "open
  Outlook → click first unread → read body").

This is the seam that lets the [analyst inspector](./cu-inspector.md)'s
"why did it click here?" explainer always trace back to a concrete
trajectory.

## Planned seed recipes

A small set ships at launch so the matcher has something to match
against on day 1. Likely candidates (drawn from existing programs in
[`server/seed-data.ts`](../../server/seed-data.ts) and the Epic agent's
proven flows):

- `outlook.read_first_unread`
- `outlook.archive_current`
- `epic.open_chart_for_patient`
- `epic.activity_continue`
- `snow.open_ticket`
- `galaxy.search_then_open`

## Relationship to today's replay engine

The current [replay engine](./replay.md) writes `nav_recipe_*` keys per
screen-edge. Once the CU stack lands, those are migrated into the new
`recipes` table as seed recipes (one per edge), with `sourceTrajectoryId`
pointing at the synthesizing session. The replay engine's
fingerprint-based verifier becomes one verifier kind in the
[cu-core](./computer-use.md) abstraction.

## Related pages

- [cu-core](./computer-use.md) / [cu-router](./cu-router.md) /
  [cu-inspector](./cu-inspector.md)
- [replay](./replay.md) — today's per-edge recipes (predecessor)
- [evolution](./evolution.md) — the gated-mutation pattern this borrows
- [data-model](./data-model.md) — `recipes` and `recipe_runs` columns
