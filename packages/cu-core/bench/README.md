# cu-core bench

Curated 30-task harness for the Cheapest-Reliable Loop. Three surfaces × ten
tasks: browser, Windows-UIA, Citrix-vision. The shape (task spec → run → score
→ report) is what the OSWorld/WebArena-scale runner from the OSS-extraction
task will plug into; the small in-house suite here is what we re-run on every
strategy-table change to detect tier-mix regressions.

## Run

```bash
tsx packages/cu-core/bench/run.ts
```

The script reuses `FakeSurface` so it executes deterministically without real
adapters. To run against real adapters, supply your own `SurfaceFactory` to
`runBench`.

## Files

- `harness.ts` — `runBench(tasks, factory)` → structured `BenchReport`.
- `suite.ts` — the 30 task specs with the cheapest observation tier each one
  hit in production traces.
- `baseline.json` — locked-in numbers per surface (tier hit rate, mean cost,
  median wall time, coord-click rate). Update deliberately.
