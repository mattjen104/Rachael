# `@rachael/cu-bench`

Public benchmark harness for [`@rachael/cu-core`](../cu-core). Runs three
suites against the same router + stub-surface fabric so the numbers are
reproducible without any real surface:

1. **In-house 30-task curated suite** (10 web + 10 Windows-UIA + 10
   Citrix-vision) derived from real Rachael trajectories. Same suite
   the strategy-table changes have to keep green.
2. **OSWorld desktop subset** (10 hand-picked tasks).
3. **WebArena web subset** (10 hand-picked tasks across the five
   canonical sites).

Every task carries the cheapest observation tier its production
trajectory used. Bench computes per-surface tier-hit rate, mean cost,
median wall time, and coord-click rate. See
[`REPORT.md`](./REPORT.md) for the latest run and the head-to-head
against published baselines.

## Run

```bash
tsx packages/cu-bench/run.ts
```

This writes:

- `raw/results.json` — full per-task results for all three suites.
- `raw/REPORT_NUMBERS.json` — the condensed numbers cited in REPORT.md.

## Reproducing against live OSWorld / WebArena

The default run targets a deterministic stub surface so anyone can
reproduce the numbers in CI. To run against the real upstream
benchmarks:

- **OSWorld** — pull the upstream Docker image
  (`xlangai/osworld`), wire the `WindowsUiaAdapter` (or a Linux
  AT-SPI adapter, out of scope for v0.x) to a UIA bridge running
  inside the VM, and supply your own `SurfaceFactory` to `runBench`.
- **WebArena** — bring up the upstream `webarena/*` containers,
  point a `BrowserPlaywrightAdapter` at the resulting Chromium, and
  again supply your own `SurfaceFactory`.

Both routes are documented in [`REPORT.md`](./REPORT.md) under
"Reproducing against live environments". The `tasks/*.json` files
preserve the upstream `task_id`s so the mapping stays explicit.
