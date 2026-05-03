# Agent runtime

Source: [`server/agent-runtime.ts`](../../server/agent-runtime.ts) (~1486 lines)

The runtime is the long-running tick loop that schedules and executes user
programs and recipes. It is started from `server/index.ts` via `initRuntime()`
and runs while the server is up.

## Lifecycle

| Stage           | What happens                                                            |
|-----------------|-------------------------------------------------------------------------|
| `initRuntime()` | Loads the model roster, restores `runtime_active` from `agent_config` (defaults to `true`), sets the control mode to `agent`, schedules the first tick. |
| Each tick       | `tickPrograms()` finds due programs (by `schedule` or `cronExpression`), filters disabled ones, applies token budget, runs them sequentially. `tickRecipes()` runs the recipe scheduler. |
| Per program run | Materializes inline TS code → wraps with `bridgeFetch`/`smartFetch` helpers + env vars (`__BRIDGE_TOKEN`, `__BRIDGE_PORT`, `__apiKey`) → spawns `npx tsx` subprocess → captures stdout. |
| After run       | LLM consolidation (see [memory](./memory.md)), parses `RECIPE:` and `PROPOSE:` directives → writes `openclaw_proposals` rows, writes an `agent_results` row, marks `lastRun`/`nextRun` on the program. |

## Manual triggers

`POST /api/programs/:id/trigger` calls `manualTrigger(programName)`. This
bypasses the schedule but still respects the budget and code execution
sandboxing.

## Token budget

- `daily_token_budget` agent_config (default 500K). Reset at midnight.
- Programs with `config.LLM_REQUIRED = "false"` always run (code-only).
- Programs with `config.TWO_STAGE = "true"` try cheap first, escalate to
  premium only if cheap fails.
- See [model router](./model-router.md).

## Inline-code wrapper

The wrapper around each program's `code` injects:

- `bridgeFetch(url, opts)` — routes through the Chrome extension.
- `smartFetch(url, init)` — drop-in `fetch()` replacement that auto-bridges
  on 403/429/503 and for known bridge-only domains.
- An authenticated API client using `__apiKey`.
- A `console.log` shim that pipes back to the parent.

⚠ **Bridge-only enforcement** is duplicated in three places (server
`smartFetch` in `bridge-queue.ts`, the inline wrapper here, and the CLI
`bridge --direct` guard). Keep them in sync. See [bridge](./bridge.md).

## Safety rules for inline code

From `replit.md`:

- Never use `\n` literally in stored program code — the wrapper turns those
  into real newlines. Use `String.fromCharCode(10)` instead.
- OpenRouter model id is `anthropic/claude-sonnet-4`, not the dated alias.
- Restart the workflow after PATCHing programs (runtime caches in memory).

## Plan-execute-evaluate loop

For programs that are agentic (LLM-driven), the runtime:

1. Calls the model with the system prompt + program instructions.
2. Parses any `RECIPE:` / `PROPOSE:` directives.
3. Stores observations for the [evolution engine](./evolution.md).
4. Runs memory consolidation.

There is **no hard "max steps" or "max wall clock" guard per program** beyond
`MAX_PROPOSALS_PER_ITERATION` (~52). Long-running or runaway agents drain
budget. See [audit § Agent safety](./audit.md#agent-safety).

## Research Radar specifics

- Program id 3, named `research-radar`. Self-improving:
  dedup via `radar_seen_items` (7-day window),
  engagement tracking via `radar_engagement`,
  source quality scoring persisted to program config,
  structured proposals (`add-source`, `drop-source`, `add-interest`, `adjust-threshold`).
- Two-stage Sonnet pipeline; emits structured JSON wrapped in
  `<!--STRUCTURED_DATA_START/END-->` markers consumed by `standup` and
  `overnight-digest`.

## Auto-start

- `runtime_active` defaults to `true` in `agent_config`.
- `control_mode` defaults to `agent`.
- No manual activation needed after restart.
