# Model router & token budget

Source: [`server/model-router.ts`](../../server/model-router.ts) (~466 lines)
+ [`server/llm-client.ts`](../../server/llm-client.ts) (~279 lines)

## Roster

The router tracks a list of `{id, tier, inputCostPer1M, outputCostPer1M, quality}`
entries. Built-in defaults:

| Tier      | Model                                |
|-----------|--------------------------------------|
| cheap     | DeepSeek V3 (default), Qwen 2.5 72B  |
| standard  | DeepSeek R1, Claude 3.5 Sonnet       |
| premium   | Claude Sonnet 4 (default)            |

There are **no free-tier models** in the roster — all real work is paid.

## Live pricing

- `openrouter-model-scout` (a seeded program) hits OpenRouter
  `/api/v1/models` and updates `inputCostPer1M`/`outputCostPer1M` in the
  in-memory roster.
- The roster is persisted overrides via `agent_config` key
  `model_roster_overrides` (JSON array merged at startup).

## Quality tracker

`qualityTracker` keeps a per-model success/fail ratio. Models with low
quality are deprioritized in the cascade (cheap → standard → premium).

## Budget

- Stored in `agent_config` key `daily_token_budget` (default 500_000).
- `getBudgetStatus()` returns `{used, remaining, models, programs}`.
- The agent runtime skips LLM-required programs when exhausted; code-only
  programs (`LLM_REQUIRED=false`) keep running.
- `budget` CLI: `budget status | models | set <tokens>`.

## Two-stage pipeline

Programs with `config.TWO_STAGE = "true"` first try the cheap model and
escalate to the premium model only when the cheap output fails validation
(detected via `RECIPE:` parser failures, JSON parse failures, etc.).

## API

- `GET /api/budget` — current `BudgetStatus`.
- `GET /api/models` — roster + quality scores.

## `TaskProfile` from the CU smart router (planned)

Once the [CU smart router](./cu-router.md) lands, every CU step calls
through with a richer `TaskProfile` object:

```ts
{
  observationKind: "AxTree" | "DomSnapshot" | "UiaTree" |
                   "SomScreenshot" | "RawScreenshot" | "TextDump",
  expectedOutputShape: "selector" | "click_target" | "extracted_json" | …,
  latencyBudgetMs: number,
  costCeilingUsd: number,
}
```

The router already ranks by cost tier; `TaskProfile` narrows further
— `SomScreenshot` + `click_target` requires a vision-capable model;
`AxTree` + `selector` opens up cheap text-only models that would be
unsuitable for a raw screenshot. See [cu-router](./cu-router.md) for
the strategy tables this populates.

## Strategist

`budget-strategist` is a daily 2 AM program that produces a budget-efficiency
report (cost per useful output per program).
