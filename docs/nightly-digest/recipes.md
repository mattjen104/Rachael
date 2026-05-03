# Recipes & Meal Suggestions

[← Back to index](./README.md)

Successful nightly meal recommender runs over the last 35 days.

## Dietary & pantry context

_Source: defaults from `nightly-meal-recommender` code (no `meals_dietary_prefs` config row found)._

- **Household size:** 3
- **Kiddo:** Willa
- **Appliances:** Instant Pot, sous vide, rice cooker, stove, toaster oven, crockpot
- **Cuisine preferences:** American, Italian, Mexican, Asian
- **Kiddo current favorites:** Go-Gurt, chicken nuggets, Goldfish crackers

Live pantry stock, expiring items, and Willa's accept/reject food log are pulled at run-time from the bridge endpoints `/api/pantry`, `/api/kiddo-food-log`, and `/api/nightly-recommendations`. Those tables are not present in this database, so they are not included in this static digest.

## Most-suggested dinners

| Dinner | Times suggested |
| --- | ---: |
| Instant Pot Chicken and Rice Bowl | 3 |

## Nightly suggestions (newest first)

| Date | Dinner | Willa's lunch | Run ID |
| --- | --- | --- | ---: |
| 2026-04-01 | Instant Pot Chicken and Rice Bowl | Mini chicken and rice bites with Goldfish crackers | [#308](./nightly-meal-recommender.md#run-308) |
| 2026-03-31 | Instant Pot Chicken and Rice Bowl | Mini chicken meatballs with rice | [#290](./nightly-meal-recommender.md#run-290) |
| 2026-03-31 | Instant Pot Chicken and Rice Bowl | Mini chicken meatballs with cheese cubes | [#268](./nightly-meal-recommender.md#run-268) |

## Full raw outputs

### 2026-04-01 — run #308

```
Nightly Meal Rec (2026-04-01): Recipe: Instant Pot Chicken and Rice Bowl | Kiddo: Mini chicken and rice bites with Goldfish crackers
```

### 2026-03-31 — run #290

```
Nightly Meal Rec (2026-03-31): Recipe: Instant Pot Chicken and Rice Bowl | Kiddo: Mini chicken meatballs with rice
```

### 2026-03-31 — run #268

```
Nightly Meal Rec (2026-03-31): Recipe: Instant Pot Chicken and Rice Bowl | Kiddo: Mini chicken meatballs with cheese cubes
```

## `recipes` table (command shortcuts, not food)

> The `recipes` DB table currently stores command shortcuts rather than food recipes. Listed verbatim for traceability.

| Name | Description | Command | Schedule |
| --- | --- | --- | --- |
| hn-ai-scan | HN programs overview | `programs list \| grep hn` | — |
| hn-rust-watch | Watches HN for Rust stories | `scrape https://news.ycombinator.com \| grep -i rust` | daily |
| morning-brief | Morning briefing: agenda + latest results | `agenda && results --limit 3` | daily |
| morning-standup | Daily morning standup briefing sent to your phone | `standup --days 1 \| notify` | daily |
| morning-briefing | Daily morning standup briefing sent via ntfy + email at 7am PT | `standup --days 1 \| notify` | 0 13 * * * |
