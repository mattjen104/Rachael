# `@rachael/cu-router`

Smart router for [`@rachael/cu-core`](../cu-core). Implements the
**cheapest-reliable loop**:

1. Inspect the next `Action` and the registered surface's
   `capabilities`.
2. Pick the cheapest `ObservationKind` likely to satisfy the action's
   verifier (AxTree → DomSnapshot → UiaTree → SomScreenshot →
   RawScreenshot → TextDump).
3. Pick the most precise `Locator` kind the surface supports
   (`selector` > `uia` > `hint` > `mark` > `coords`).
4. Run pre-verifier, act, run post-verifier.
5. On verifier mismatch, escalate one tier; on hard failure, run the
   recovery policy. Each step's tier choice and miss reason go into the
   `RouterTraceEvent` stream.

## Install

```bash
npm install @rachael/cu-core @rachael/cu-router zod
```

## Hello, router

```bash
npx tsx packages/cu-router/examples/hello-router.ts
```

```ts
import { ComputerUseBus, FakeSurface } from "@rachael/cu-core";
import { Router, Budget, InMemoryTraceSink } from "@rachael/cu-router";

const bus = new ComputerUseBus();
const surface = new FakeSurface();
bus.registerSurface(surface);

const sink = new InMemoryTraceSink();
const budget = new Budget({ maxModelSpendUsd: 0.05 });
const router = new Router({ runId: "demo-run", budget, emitter: sink.emit });

const result = await router.step(surface, {
  action: { verb: "Goto", url: "fake://form" },
});
console.log(`tier=${result.observationKind} ok=${result.ok}`);
console.log(`trace events: ${sink.events.length}`);
```

## What you get from a step

```ts
interface RouterStepResult {
  ok: boolean;
  observationKind: ObservationKind;
  attemptedLocator?: LocatorKind;
  fallbackChain: ObservationKind[];   // tiers we had to escalate through
  tierMiss?: TierMissInfo;            // populated when we escalated
  abortReason?: string;
  traceId: string;
  budgetUsedUsd: number;
}
```

## Budget

`Budget` is the only thing that can stop a step. Configure
`maxModelSpendUsd`, `maxObservationsPerTask`, `maxWallMs`, and observe
`budget.usage` in the trace stream. Going over budget short-circuits to
`abortReason: "budget"` rather than throwing.

## Strategy table

`DEFAULT_STRATEGIES` declares the per-`SurfaceKind` ordering of
observation tiers and locator kinds. Override with `setStrategy(kind,
strategy)` to plug in a custom router for a custom surface — the change
applies process-wide.

## Stable v0.x contract

- `Router.step` signature.
- `RouterStepResult` shape.
- `Budget` constructor options.
- `RouterTraceEvent` discriminated union (`decision | observe | act |
  verify | recovery | escalate | budget-deny | tier-miss | takeover |
  complete | abort`).
- `DEFAULT_STRATEGIES` shape; the actual orderings are tuned and may
  shift across patch releases.

## Non-goals

See [`NON_GOALS.md`](./NON_GOALS.md). Briefly: no model router for
*language* models (use `ModelRouterAdapter` to plug yours in), no recipe
matching (that's `@rachael/cu-skills`), no trajectory storage.
