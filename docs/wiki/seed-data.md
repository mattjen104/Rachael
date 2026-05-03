# Seed data

Source: [`server/seed-data.ts`](../../server/seed-data.ts) (~2968 lines)

`seedDatabase()` is invoked once at server boot from `routes.ts`. It is
**idempotent** — every insert is `INSERT … ON CONFLICT DO NOTHING` (or
checks for existence first), so it's safe to run on every boot.

## What it provisions

### Programs (12 hardened, all with real inline code)

- `hn-pulse` — HN top stories via Firebase API.
- `openrouter-model-scout` — Tests free-model availability on OpenRouter and
  updates the live roster pricing.
- `research-radar` (id 3) — Self-improving meta-radar (see
  [agent runtime § Research Radar](./agent-runtime.md#research-radar-specifics)).
- `hn-deep-digest` — Deep comment-thread digest, Sonnet summary.
- `github-trending` — bridge-only.
- `estate-car-finder` — SoCal Craigslist scanner across 4 regions.
- `fed-rates` — Treasury yields via Yahoo Finance JSON.
- `free-stuff-radar` — Craigslist free-section keyword scanner.
- `sec-filings` — SEC EDGAR (10-K/10-Q/8-K).
- `price-watch` — Craigslist vehicles under max price with dedup.
- `foreclosure-monitor` — HUD HomeStore + Fannie Mae HomePath + CL REO.
- `mandela-berenstain` — Internet Archive + Open Library spelling-variant search.
- `citrix-launcher` — Discovers UCSD CWP apps. Bridge-only, manual trigger.
- `overnight-digest` (id 18) — Goal-oriented daily brief, generates HTML
  + voice script.
- `budget-strategist` — daily 2 AM efficiency report.

(Counts may drift over time; treat the list above as the seed baseline and
run `programs` from the CLI to see the current set.)

### Skills

The `skills` table is seeded with reusable toolkit references.
File-shipped skills live in `skills/*.ts`:
`resilient-fetch.ts`, `fuzzy-match.ts`, `reddit-toolkit.ts`,
`craigslist-toolkit.ts`, `archive-toolkit.ts`, `grocery-toolkit.ts`.

### Site profiles

Seeded profiles: `outlook`, `teams`, `any-website` (best-effort fallback).
Additional profiles can be added through the API or via further seed
inserts.

### Agent config

Default values for:

- `daily_token_budget` (500_000)
- `runtime_active` (true)
- `control_mode` (agent)
- `notify_channel` (rachael-standup)
- `user_goals` (5 example goals)
- Cron schedules for `morning-briefing` (6 AM PT)
- Various model preferences

### Recipes

- `morning-briefing = standup --days 1 | notify` on cron `0 13 * * *`
  (6 AM PT given the system runs in UTC).

## Editing safety

If you change a seed:

- Increment intent (e.g. add a new key to `agent_config`) — append, don't
  overwrite. The seed is idempotent.
- For program code changes: `scripts/fix-radar-code.ts` and
  `scripts/update-program-code.ts` show patterns for surgical updates of
  the inline code stored in DB rows.
