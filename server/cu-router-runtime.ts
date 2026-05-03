import {
  Budget,
  Router,
  type RouterOptions,
  type RouterStepInput,
  type RouterStepResult,
  type RouterTraceEvent,
  type Surface,
  type TierMissInfo,
} from "@rachael/cu-core";
import {
  serverModelRouter,
  routerTraceEmitter,
  tierMissReporter as defaultTierMissReporter,
} from "./cu-router";
import { createTakeoverPoint } from "./control-bus";
import { recordRouterTierMiss } from "./evolution-engine";

// ---------------------------------------------------------------------------
// `cu-router-runtime` — the production wiring of cu-core's Router into the
// server. This is the single module callers (agent-runtime, replay-engine)
// import to get a Router instance with:
//   - the live model roster bridged in via `serverModelRouter`
//   - traces persisted to `router_traces` via `routerTraceEmitter`
//   - takeover decisions delegated to the control-bus
//   - tier-miss observations forwarded to the evolution engine
//
// Usage:
//   const router = makeServerRouter({ programName: "epic-orders", runId });
//   await router.step(surface, { action, pre, post });
// ---------------------------------------------------------------------------

export interface MakeServerRouterOptions {
  programName?: string;
  runId?: string;
  budget?: Budget;
  // Override the takeover bridge for tests.
  onTakeover?: RouterOptions["onTakeover"];
  // Override the tier-miss path for tests; defaults to evolution-engine hook.
  tierMissReporter?: (info: TierMissInfo) => void;
  // Override the trace emitter for tests; defaults to event-bus + DB persistence.
  emitter?: (event: RouterTraceEvent) => void;
}

export function makeServerRouter(opts: MakeServerRouterOptions = {}): Router {
  return new Router({
    runId: opts.runId,
    budget: opts.budget,
    modelRouter: serverModelRouter,
    emitter: opts.emitter ?? ((event) => routerTraceEmitter(event, { programName: opts.programName })),
    onTakeover: opts.onTakeover ?? defaultControlBusTakeover,
    tierMissReporter: opts.tierMissReporter ?? ((info) => {
      recordRouterTierMiss(info);
      defaultTierMissReporter(info);
    }),
  });
}

/** Default takeover bridge — opens a control-bus takeover point and resolves. */
async function defaultControlBusTakeover(event: RouterTraceEvent): Promise<"resume" | "abort"> {
  const action = `cu-router/${event.surfaceKind}/${event.actionVerb ?? "step"}`;
  const target = event.observation?.kind ? `obs=${event.observation.kind}` : event.attemptedObservation;
  const decision = await createTakeoverPoint(action, target, "approval");
  if (decision === "confirm" || decision === "takeover") return "resume";
  return "abort";
}

/** Convenience for hosts that just want to run one step with default wiring. */
export async function routedStep(
  surface: Surface,
  input: RouterStepInput,
  opts: MakeServerRouterOptions = {},
): Promise<RouterStepResult> {
  const router = makeServerRouter(opts);
  return router.step(surface, input);
}
