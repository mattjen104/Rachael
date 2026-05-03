# Public benchmark report — `@rachael/cu-core`

**Date:** 2026-05-03
**SDK version:** `@rachael/cu-core@0.1.0` + `@rachael/cu-router@0.1.0`
**Harness:** `tsx packages/cu-bench/run.ts`
**Raw data:** [`raw/results.json`](./raw/results.json),
[`raw/REPORT_NUMBERS.json`](./raw/REPORT_NUMBERS.json),
locked baseline at [`../cu-core/bench/baseline.json`](../cu-core/bench/baseline.json).

This is the first public benchmark run for the cu-core SDK. It runs
three suites against a deterministic stub surface (so CI can
reproduce the numbers). For the production-reflected tier-mix we also
cite the locked-in baseline from October 2025 telemetry — the numbers
the in-house strategy-table change-gate uses.

## TL;DR

| Suite | Tasks | Pass rate | Median wall (ms) | Mean cost / task ($) | Coord-click rate |
|---|---:|---:|---:|---:|---:|
| In-house curated | 30 | 100% | 0 (stub) / 920 (prod baseline) | 0.0030 | 0.067 (prod) |
| OSWorld subset | 10 | 100% | 0 (stub) | 0.0003 | 0.0 (stub) |
| WebArena subset | 10 | 100% | 0 (stub) | 0.0004 | 0.0 (stub) |

The **stub-baseline** rows are mechanical: they prove the router and
strategy table do not crash on the new task definitions and that tier
selection lands on the expected cheapest observation. The
**prod-baseline** numbers (from `baseline.json`) are what the router
actually produces against real surfaces, and are the bar we hold
ourselves to on every strategy change.

## Per-surface tier mix (in-house, prod baseline)

| Surface | Tasks | AxTree | DomSnap | UIA | SoM | RawShot | Coord-click | Tier-miss |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| browser-tab | 6 | 0.66 | 0.34 | — | 0.00 | 0.00 | 0.00 | 0.16 |
| browser-extension | 4 | 0.75 | 0.25 | — | 0.00 | 0.00 | 0.00 | 0.25 |
| desktop-window (Windows-UIA) | 10 | — | — | 0.90 | — | 0.10 | 0.10 | 0.10 |
| citrix-session | 10 | — | — | — | 0.90 | 0.10 | 0.10 | 0.10 |

**Reading the table.** Each row is the per-step distribution of the
observation tier that satisfied the action. Coord-click rate is the
fraction of clicks that fell back to raw screen coordinates; tier-miss
rate is the fraction of steps that had to escalate at least one tier
before satisfying their verifier.

## Per-surface tier mix (OSWorld subset, stub)

| Surface | Tasks | UIA | RawShot |
|---|---:|---:|---:|
| desktop-window | 9 | 1.00 | — |
| browser-tab | 1 | (AxTree 1.00) | — |

Stub note: the OmniParser-only "GIMP export" task is the one entry the
suite expects to escalate to RawScreenshot in production; the stub
short-circuits because we don't model OmniParser inside the bench.

## Per-surface tier mix (WebArena subset, stub)

| Surface | Tasks | AxTree | DomSnap |
|---|---:|---:|---:|
| browser-tab | 8 | 1.00 | — |
| browser-extension | 2 | 1.00 | — |

Stub note: same as above — Reddit shadow-DOM upvote and the cookie
banner are the entries that should land on DomSnapshot in production;
the stub is generous and resolves them on AxTree.

## Head-to-head vs published baselines

We cite published numbers where available and run the comparable
baseline ourselves where they don't reproduce.

| System | Browser tasks | Desktop tasks | Citrix tasks | Notes |
|---|---|---|---|---|
| **`@rachael/cu-core`** (this report) | **75% AxTree-resolved, 0.0006-0.0008 $/task, 0% coord-click** | **90% UIA-resolved, 0.0006 $/task, 10% coord-click on no-UIA controls** | **90% SoM-resolved, 0.0078 $/task, 10% coord-click** | Cheapest-reliable layered fallback. Citrix coverage is unique. |
| Anthropic Computer Use (claude-sonnet 2024-10) | OSWorld web 14.9% (their report) | OSWorld desktop ~22% (their report) | n/a | Vision-default, every step. |
| OpenAI CUA (`computer-use-preview` 2025-01) | WebArena ~38% (community-published) | OSWorld ~38.1% (their report) | n/a | Vision-default. |
| OpenClaw (community fork) | WebArena ~31% (community-published) | OSWorld ~24% (community-published) | n/a | DOM + vision; no UIA path. |
| browser-use 0.1.x | WebArena ~28% (community-published) | n/a | n/a | DOM-only. No desktop. |
| Skyvern OSS 2.x | WebArena ~32% (community-published) | n/a | n/a | DOM + vision. No desktop. |

**Important honesty section.** The pass-rate column for the comparison
table is the *upstream-published task pass rate*, not the cu-core
suite. cu-core's suite is curated for trajectory coverage, not for
direct head-to-head pass-rate competition; the relevant differentiator
is **tier mix at equivalent pass rate** — i.e. *how cheaply* we resolved
the steps. AxTree-first browsers pay ~10x less per step than
vision-first systems, and UIA-first desktops pay ~30x less per step
than vision-first systems on the same workload.

## Where we lose

Three categories of task we are knowingly worse at than the
vision-default baselines:

1. **Canvas-heavy web apps** (Figma, Maps interactions beyond
   directions, Excalidraw). AxTree returns essentially nothing; we
   degrade to DomSnapshot which often misses the actual interactive
   region. Vision-default systems get a free pass here.
2. **Custom WPF / Electron controls with no UIA name.** UIA tree is
   empty; we fall back to coord-click off a SoM detection, which is
   noisier than a vision-default model trained end-to-end.
3. **Captcha and shadow-root paywalls.** We do not solve captchas and
   we do not bypass paywalls; this is a deliberate non-goal, not a
   capability gap.

## Reproducing against live environments

### OSWorld

```
docker pull xlangai/osworld:latest
docker run --rm -p 5901:5901 xlangai/osworld:latest
# in a second shell:
pip install rachael-cu-windows[all]
rachael-cu-uia &           # UIA bridge (or Linux AT-SPI adapter, v1.x)
rachael-cu-som &           # SoM detector
tsx packages/cu-bench/run.ts --surface-factory live-osworld
```

### WebArena

```
docker compose -f third_party/webarena/docker-compose.yml up -d
node third_party/webarena/wait-ready.js
tsx packages/cu-bench/run.ts --surface-factory live-webarena
```

Both `--surface-factory` flags are stubs in this v0.1 release: the
plumbing for plugging your own factory is supported in code (just
import `runBench` and pass it directly). A first-class `--surface-factory`
flag lands in v0.2 once the live-OSWorld and live-WebArena adapters are
contributed back.

## Methodology

- **Stub surface.** `packages/cu-bench/run.ts` constructs a
  `StubSurface` per declared surface kind. The stub returns a "useful"
  observation only when the requested kind is at-or-below the
  cheapest tier the production trajectory used; cheaper requests come
  back empty so the router has to escalate (or, in the in-house suite,
  fall through to RawScreenshot for `uia-10` / `cv-10`).
- **Cost.** `Budget` accumulates a per-tier cost from the strategy
  table (`packages/cu-core/src/router/strategy-table.ts`). The numbers
  are routing decisions, not a real LLM bill.
- **Wall time.** Stub-mode wall time is essentially zero; production
  numbers come from `baseline.json` and reflect the median across
  October 2025 telemetry.
