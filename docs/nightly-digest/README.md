# Nightly Jobs Wiki Digest

_Generated: 2026-05-03 05:33Z_  
_Data window: 2026-03-29 → 2026-05-03 (35 days)_

A browsable journal of what every nightly program has been producing. Regenerate with `npm run digest:nightly`.

## Special pages

- 🍳 [Recipes & meal suggestions](./recipes.md) — dinners + kiddo lunches, with a most-suggested roll-up
- 🚨 [Recurring errors](./errors.md) — error patterns grouped by message

## Programs

| Program | Schedule | Last success | ✅ ok | ❌ err |
| --- | --- | --- | ---: | ---: |
| [budget-strategist](./budget-strategist.md) | every 8h `0 2,10,18 * * *` | 2026-04-01 18:00Z | 6 | 42 |
| [citrix-launcher](./citrix-launcher.md) | — | — | 0 | 0 |
| [estate-car-finder](./estate-car-finder.md) | daily `0 22 * * *` | 2026-04-01 16:17Z | 2 | 19 |
| [fed-rates](./fed-rates.md) | daily `0 6 * * *` | 2026-04-01 16:16Z | 3 | 17 |
| [foreclosure-monitor](./foreclosure-monitor.md) | daily `0 8 * * *` | 2026-04-01 16:16Z | 3 | 17 |
| [free-stuff-radar](./free-stuff-radar.md) | every 4h `0 */4 * * *` | — | 0 | 0 |
| [github-trending](./github-trending.md) | every 8h `0 6,14,22 * * *` | 2026-04-01 16:16Z | 3 | 38 |
| [hn-deep-digest](./hn-deep-digest.md) | daily `0 23 * * *` | 2026-04-01 16:17Z | 2 | 20 |
| [hn-pulse](./hn-pulse.md) | every 12h `0 7,19 * * *` | — | 0 | 0 |
| [mandela-berenstain](./mandela-berenstain.md) | daily `0 22 * * *` | 2026-04-01 16:16Z | 2 | 19 |
| [meeting-prep](./meeting-prep.md) | every 15 min `*/15 * * * *` | 2026-04-01 16:17Z | 2 | 20 |
| [nightly-meal-recommender](./nightly-meal-recommender.md) | daily `0 21 * * *` | 2026-04-01 21:00Z | 3 | 18 |
| [openrouter-model-scout](./openrouter-model-scout.md) | every 12h `0 6,18 * * *` | 2026-04-01 18:01Z | 5 | 31 |
| [overnight-digest](./overnight-digest.md) | daily `0 13 * * *` | 2026-04-01 16:16Z | 3 | 17 |
| [price-watch](./price-watch.md) | daily `0 7 * * *` | 2026-04-01 16:17Z | 3 | 17 |
| [research-radar](./research-radar.md) | daily `30 23 * * *` | 2026-04-01 16:17Z | 2 | 20 |
| [sec-filings](./sec-filings.md) | daily `0 9 * * *` | 2026-04-01 16:16Z | 3 | 17 |
| [snow-shift-brief](./snow-shift-brief.md) | weekdays `30 13 * * 1-5` | 2026-04-01 16:16Z | 3 | 17 |
| [weekly-strategy](./weekly-strategy.md) | weekly `0 2 * * 0` | 2026-04-01 16:17Z | 3 | 19 |

## How this is built

Generator: `scripts/build-nightly-digest.ts`. Reads from `programs`, `agent_results`, and `recipes` via the existing Drizzle setup in `server/db.ts`. Wipes and rewrites this directory on each run.
