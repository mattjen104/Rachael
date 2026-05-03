# Evolution engine

Source: [`server/evolution-engine.ts`](../../server/evolution-engine.ts) (~680 lines)
+ [`server/llm-judges.ts`](../../server/llm-judges.ts) (~313 lines)
+ [`server/evolution-config/`](../../server/evolution-config/) (markdown rules)

Rachael continuously rewrites her own behavior config under judged
supervision. The pipeline is six steps:

```
observe → critique → deltas → 5-gate validation → apply → rollback
```

## Steps

1. **Observe** — `evolution_observations` rows are accumulated from agent
   runs (`agent-runtime.ts` writes them after each program). Heuristic +
   LLM extraction.
2. **Critique** — A judge model reads recent observations and proposes
   improvements.
3. **Deltas** — The critique is translated into edits against the markdown
   files in `server/evolution-config/`:
   - `constitution.md` — immutable rules (the gate refuses to change it).
   - `persona.md`
   - `user-profile.md`
   - `domain-knowledge.md`
   - `strategies/task-patterns.md`
   - `strategies/tool-preferences.md`
   - `strategies/error-recovery.md`
4. **5-gate validation** — Every delta must pass:
   - **Constitution** — triple-Sonnet judge, minority veto, fail-closed on
     errors.
   - **Regression** — golden suite check (Haiku first; Sonnet override on
     reject).
   - **Size** — line-count limit per file.
   - **Drift** — Jaccard similarity against the previous version
     (`DRIFT_THRESHOLD`, default 0.4).
   - **Safety** — dangerous-pattern scanner + triple-Sonnet.
5. **Apply** — Write a new `evolution_versions` row with `changes`,
   `gateResults`, `metricsSnapshot`. Files updated atomically.
6. **Rollback** — If 7-day success rate drops below
   `SUCCESS_RATE_ROLLBACK_THRESHOLD` (default 0.6), the prior version is
   automatically restored.

## Judges (`server/llm-judges.ts`)

- `tripleSonnetJudge(prompt)` — three independent Sonnet calls; minority veto.
- `cascadeJudge(prompt)` — Haiku first; Sonnet override on rejection.
- Cost tracked in `judge_cost_tracking`.
- `JUDGE_DAILY_COST_CAP` (default $5) prevents budget blowouts; if exceeded
  the gate fails closed (i.e. nothing applies).

## Proposals

- `PROPOSE: enhancement` directives in program output are routed through the
  same gates before being stored or applied.
- Rejected proposals are stored with explanations so the human can review
  why.

## Tunable env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `JUDGE_DAILY_COST_CAP` | 5.0 | Max USD/day for judges |
| `MAX_GOLDEN_SUITE_SIZE` | 100 | Cap on regression test cases |
| `DRIFT_THRESHOLD` | 0.4 | Jaccard similarity floor (lower = more change allowed) |
| `SUCCESS_RATE_ROLLBACK_THRESHOLD` | 0.6 | Auto-rollback trigger |

## UI

The Evolution view (`client/src/components/views/EvolutionPanel.tsx`)
surfaces:

- Version history with gate results and metrics snapshots.
- Judge cost tracking with breakdown by judge type.
- Observation viewer with manual consolidation trigger.
- Qdrant migration button.
- Rollback button per version.

## Strategy tables as a new mutation surface (planned)

The [CU smart router](./cu-router.md) keeps per-surface strategy
tables that map `(taskKind, surfaceKind, observationKind)` →
`{preferredLocator, model, fallbackChain}`. These tables become a
**new mutation surface** for the evolution engine alongside the
existing markdown configs: the router emits an
`observation-tier miss` observation whenever a preferred tier
under-delivers (e.g. `AxTree` returns empty for what should be a real
button), the engine batches these observations, and the standard
critique → deltas → 5-gate-validation pipeline proposes table edits.
The same gates apply (constitution, regression on the cu-router
benchmark suite, size, drift, safety), and bad changes auto-roll-back
on the same success-rate trigger.

## Safety considerations

- Constitution gate is fail-closed — if Anthropic is down, no evolution applies.
- The owner can always manually rollback a bad version.
- No mechanism currently exists to *whitelist* certain file paths or to
  sandbox the rendered config — see [audit § Agent safety](./audit.md#agent-safety).
