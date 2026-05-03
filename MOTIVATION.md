# MOTIVATION.md — Why `@rachael/cu`

There are several open or semi-open computer-use frameworks in the
wild. This document explains what `@rachael/cu` does that they don't,
and where they're a better fit.

## The three axes that matter

We compare on three axes that fall out of building Rachael's actual
production agents (clinical workflows in Citrix Hyperdrive, a Chrome
extension on the analyst's own browser, a Windows-UIA driver for
boot/login):

1. **Surface coverage.** Which kinds of computer can the agent see and
   act on?
2. **Observation strategy.** What does the agent ask for at each step,
   and how expensive is that?
3. **Analyst affordances.** What does the human-in-the-loop see when
   things go wrong, and how do they take over?

## Surface coverage

| System | Web | Windows desktop | Citrix / VDI | macOS / Linux desktop |
|---|---|---|---|---|
| **`@rachael/cu`** | ✅ Playwright + Chrome MV3 | ✅ UIA + coords fallback | ✅ vision-only with SoM → vim-hint → raw chain | ❌ explicit non-goal for v0.x |
| Anthropic Computer Use | ✅ via screenshots | ✅ via screenshots | ⚠ in principle, not productized | ✅ via screenshots |
| OpenAI CUA | ✅ via screenshots | ✅ via screenshots | ⚠ in principle, not productized | ✅ via screenshots |
| OpenClaw | ✅ DOM + vision | ⚠ vision-only | ❌ | ⚠ vision-only |
| browser-use | ✅ DOM | ❌ | ❌ | ❌ |
| Skyvern | ✅ DOM + vision | ❌ | ❌ | ❌ |

**The Citrix coverage is the headline.** Most clinical, banking, and
ERP work happens inside a Citrix or RDP session where you only have
pixels. cu-core's `CitrixVisionAdapter` ships a degradation chain
(SoM detector → vim-hint overlay → raw screenshot) that is
production-tested and stays local-only (no cloud calls; the SoM
detector runs on CPU). None of the comparable systems treat Citrix as
a first-class surface.

## Observation strategy

The cheapest-reliable loop:

```
AxTree → DomSnapshot → UiaTree → SomScreenshot → RawScreenshot → TextDump
```

For each step, cu-router asks for the cheapest tier first and
escalates on miss. Vision-default systems pay screenshot tokens on
every step regardless of whether the AxTree would have served. Our
production telemetry (see `packages/cu-bench/REPORT.md`):

- 75% of browser steps resolve on AxTree alone.
- 90% of Windows-UIA steps resolve on the UIA tree, no pixels.
- 90% of Citrix steps resolve on a single SoM detection without a
  full vision-LLM call.

This translates to roughly **10–30× lower per-step cost** at
equivalent pass rate, depending on surface.

| System | Default observation | Per-step cost (relative) |
|---|---|---|
| **`@rachael/cu`** | layered, cheapest-first | **1×** |
| Anthropic Computer Use | full screenshot every step | ~30× |
| OpenAI CUA | full screenshot every step | ~30× |
| OpenClaw | DOM + screenshot | ~10× |
| browser-use | DOM-only | ~1× (web only) |

Cost numbers above are normalized to cu-core's median per-step cost
on the in-house suite. They are direction-correct, not exact.

## Analyst affordances

cu-core ships analyst tooling as a first-class concern, not as
documentation:

- **Trajectory inspector** — every decision the router makes (tier
  pick, locator pick, verifier verdict, recovery action) is a typed
  `RouterTraceEvent` written to a sink. The reference inspector
  understands timing, escalations, and tier-misses without any LLM
  call.
- **Recipes with provenance** — every promoted recipe carries the
  trajectory it came from and the source tag (`human` / `trajectory`
  / `free-plan`). Approvers can audit before installing.
- **Takeover anywhere** — the inspector can fork a run from any step
  by editing the action and resuming as a child branch. The
  `takeover` event is part of the public trace contract.
- **Default-on PHI/PII redaction** — the inspector data contract
  (`@rachael/cu-inspector-data`) ships a regex-based redactor for
  text and a wireframe SVG renderer for screenshots. Raw pixels are
  delivered only behind a one-time, audit-logged unlock token.

| System | Per-step decision trace | Recipe provenance | Mid-run takeover | Default-on PHI/PII redaction |
|---|---|---|---|---|
| **`@rachael/cu`** | ✅ typed events | ✅ tag + trajectory id | ✅ fork-from-step | ✅ regex + wireframe |
| Anthropic Computer Use | partial (API logs) | ❌ | ❌ | ❌ |
| OpenAI CUA | partial (API logs) | ❌ | ❌ | ❌ |
| OpenClaw | run logs only | ⚠ optional | ❌ | ❌ |
| browser-use | run logs only | ❌ | ❌ | ❌ |
| Skyvern | run logs only | ⚠ workflow saves | ❌ | ❌ |

## Where they're a better fit

We're not better at everything. Honest:

- **Anthropic CU / OpenAI CUA** are the right call when you don't
  control the surface and you're willing to pay vision tokens at
  every step in exchange for "it just works" without per-surface
  adapters.
- **browser-use** is the right call for a tiny web-only agent where
  you don't want a Python sidecar.
- **Skyvern** is the right call when you want managed workflows with
  a UI out of the box and you don't need desktop coverage.

cu-core is the right call when **cost matters per step**, when
**Citrix or Windows desktop coverage matters**, or when **analyst
audit trail is a requirement** (e.g. clinical, financial, regulated
workflows).
