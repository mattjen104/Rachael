# fed-rates

[← Back to index](./README.md)

- **Type:** monitor
- **Schedule:** daily (`0 6 * * *`)
- **Enabled:** yes
- **Cost tier:** cheap
- **Tags:** program
- **Last successful run:** 2026-04-01 16:16Z

## Description

Fetch current US Treasury yield curve rates (2Y, 5Y, 10Y, 30Y) from Yahoo Finance.

## Health (last 35 days)

- ✅ Successful runs: **3**
- ❌ Errored runs: **17**
- Total runs in window: 20

Top error patterns:
- `Error: column "subject" does not exist` × 17

## Successful runs (newest first)

<a id="run-294"></a>
### 2026-04-01 16:16Z — run #294

model: `inline-code` · tokens: 0 · metric: 4

**Summary:**

```
Treasury Yields (4/4):
```

<details><summary>Raw output</summary>

```
Treasury Yields (4/4):
  10Y Treasury: 4.303%
  2Y Treasury: 3.605%
  5Y Treasury: 3.9380002%
  30Y Treasury: 4.886%
```

</details>

<a id="run-280"></a>
### 2026-03-31 17:42Z — run #280

model: `inline-code` · tokens: 0 · metric: 4

**Summary:**

```
Treasury Yields (4/4):
```

<details><summary>Raw output</summary>

```
Treasury Yields (4/4):
  10Y Treasury: 4.309%
  2Y Treasury: 3.598%
  5Y Treasury: 3.932%
  30Y Treasury: 4.8919997%
```

</details>

<a id="run-264"></a>
### 2026-03-31 01:58Z — run #264

model: `inline-code` · tokens: 0 · metric: 4

**Summary:**

```
Treasury Yields (4/4):
```

<details><summary>Raw output</summary>

```
Treasury Yields (4/4):
  10Y Treasury: 4.342%
  2Y Treasury: 3.598%
  5Y Treasury: 3.979%
  30Y Treasury: 4.905%
```

</details>
