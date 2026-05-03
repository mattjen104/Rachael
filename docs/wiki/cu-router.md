# Computer-use smart router & verification loop

> **Status: Planned** (see task task #95 (smart router)).
>
> The smart router does not exist in `server/` yet. The pieces it will
> stitch together exist independently: the [model router](./model-router.md)
> picks LLMs by cost tier, the [agent runtime](./agent-runtime.md) drives
> programs, and the [replay engine](./replay.md) does fingerprint-based
> verification on a per-screen basis. The CU smart router is the layer
> that decides — for one CU step — which observation kind, which locator
> kind, and which model to use, then verifies the result and recovers.

## Intent (2-3 sentences)

The CU smart router enforces the **cheapest-reliable** principle: pick
the lowest-cost observation and locator that have historically worked
for *this kind of task on this kind of surface*, verify, and only
escalate up the priority cascade on failure. The router emits a
`RouterTrace` event for every decision, which feeds back into both the
[evolution engine](./evolution.md) (as a mutation surface — strategy
tables get rewritten when their hit-rate decays) and the
[trajectory memory / skill library](./cu-skills.md) (so successful
trajectories promote into recipes).

## Planned strategy tables

The router consults a per-surface strategy table keyed by `(taskKind,
surfaceKind, observationKind)` → `{ preferredLocator, model,
maxLatencyMs, fallbackChain }`. Tables ship seeded from the in-house
benchmark and are evolved live based on observed success rates.

Examples (illustrative):

| taskKind        | surfaceKind        | observation | locator   | model              |
|-----------------|--------------------|-------------|-----------|--------------------|
| `click_label`   | `browser-playwright` | `AxTree`   | `Selector`| (no LLM — direct)  |
| `read_form`     | `windows-uia`      | `UiaTree`   | `UiaPath` | DeepSeek V3 (cheap)|
| `click_label`   | `citrix-vision`    | `SomScreenshot` | `ElementMark` | Sonnet (premium) |

## Planned `TaskProfile` ↔ `model-router` integration

The router passes a `TaskProfile` into [model-router](./model-router.md):

```ts
{
  observationKind: "AxTree" | "DomSnapshot" | …,
  expectedOutputShape: "selector" | "click_target" | "extracted_json" | …,
  latencyBudgetMs: number,
  costCeilingUsd: number,
}
```

`model-router` already has tiers (cheap / standard / premium) and a
`qualityTracker`; the new input narrows the choice further. For example,
`SomScreenshot` + `click_target` requires a vision-capable model;
`AxTree` + `selector` can use a cheap text-only model.

Cross-link: [model-router](./model-router.md), [evolution](./evolution.md).

## Planned budget object

Each step carries a `Budget` (latency ms, USD ceiling, max recovery
hops). Verifier failures consume hops; running out fails the step.

## Planned recovery policy

On verifier `fail`:

1. Re-observe with the *next* tier
   (`AxTree → UiaTree → DomSnapshot → SomScreenshot → RawScreenshot`).
2. If the locator was a `Selector` and the observation now has marks,
   re-bind to an `ElementMark` and retry.
3. After the cascade is exhausted, escalate the model tier
   (cheap → standard → premium) and try once more.
4. If still failing, emit a takeover point through the
   [control bus](./control-bus.md) so the human (or the
   [analyst inspector](./cu-inspector.md)) can step in.

## Planned `RouterTrace` event

Every step produces:

```ts
{
  stepId, surfaceId, taskKind, plan: TaskProfile,
  attempts: [{ observation, locator, model, durationMs, costUsd, verdict }],
  finalVerdict: "pass" | "fail" | "human-takeover",
  recipePromoted?: boolean,
}
```

Persisted in `trajectory_frames` (see [data-model](./data-model.md)) and
shown step-by-step in the [analyst inspector](./cu-inspector.md).

## Planned in-house benchmark

A small benchmark harness (`packages/cu-core/bench/` per
task #98 (OSS extraction)) replays a frozen set of trajectories against
each adapter to measure success rate, latency, and cost — the basis for
seeding the strategy tables and for the OSS release credibility.

## Hooks back into evolution

The router emits an `observation-tier miss` observation when a surface's
preferred tier under-delivers (e.g. `AxTree` returns empty for what
should be a real button). The [evolution engine](./evolution.md)'s
proposal pipeline picks these up and proposes strategy-table edits the
same way it edits other markdown configs today.

## Related tracks

- [cu-core abstraction](./computer-use.md) — the types this router
  routes over
- [cu-skills](./cu-skills.md) — recipes promoted from successful traces
- [cu-inspector](./cu-inspector.md) — the human surface for traces
- OSS extraction (task task #98 (OSS extraction)) — when the router and
  benchmark suite get carved out as `@rachael/cu`
