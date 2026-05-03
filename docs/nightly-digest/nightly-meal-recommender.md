# nightly-meal-recommender

[← Back to index](./README.md)

- **Type:** monitor
- **Schedule:** daily (`0 21 * * *`)
- **Enabled:** yes
- **Cost tier:** standard
- **Tags:** program, meals
- **Last successful run:** 2026-04-01 21:00Z

## Description

Nightly meal recommendation program. Generates one new dinner recipe for the household (appliance-tagged, scored by Open Food Facts for ingredients) and one new lunch item for Willa based on her bridge food strategy and acceptance history. Avoids repeating previous recommendations; factors in pantry stock and expiring items.

## Health (last 35 days)

- ✅ Successful runs: **3**
- ❌ Errored runs: **18**
- Total runs in window: 21

Top error patterns:
- `Error: column "subject" does not exist` × 18

## Successful runs (newest first)

<a id="run-308"></a>
### 2026-04-01 21:00Z — run #308

model: `inline-code` · tokens: 0 · metric: 1

**Summary:**

```
Nightly Meal Rec (2026-04-01): Recipe: Instant Pot Chicken and Rice Bowl ¦ Kiddo: Mini chicken and rice bites with Goldfish crackers
```

<details><summary>Raw output</summary>

```
Nightly Meal Rec (2026-04-01): Recipe: Instant Pot Chicken and Rice Bowl | Kiddo: Mini chicken and rice bites with Goldfish crackers
```

</details>

<a id="run-290"></a>
### 2026-03-31 21:00Z — run #290

model: `inline-code` · tokens: 0 · metric: 1

**Summary:**

```
Nightly Meal Rec (2026-03-31): Recipe: Instant Pot Chicken and Rice Bowl ¦ Kiddo: Mini chicken meatballs with rice
```

<details><summary>Raw output</summary>

```
Nightly Meal Rec (2026-03-31): Recipe: Instant Pot Chicken and Rice Bowl | Kiddo: Mini chicken meatballs with rice
```

</details>

<a id="run-268"></a>
### 2026-03-31 01:58Z — run #268

model: `inline-code` · tokens: 0 · metric: 1

**Summary:**

```
Nightly Meal Rec (2026-03-31): Recipe: Instant Pot Chicken and Rice Bowl ¦ Kiddo: Mini chicken meatballs with cheese cubes
```

<details><summary>Raw output</summary>

```
Nightly Meal Rec (2026-03-31): Recipe: Instant Pot Chicken and Rice Bowl | Kiddo: Mini chicken meatballs with cheese cubes
```

</details>
