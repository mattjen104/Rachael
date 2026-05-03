import {
  Budget,
  Router,
  recipeSource,
  runRecipe,
  withFreePlanSource,
  withSourceTag,
  type ActionSource,
  type RecipeExecutionResult,
  type RouterOptions,
  type RouterStepInput,
  type RouterStepResult,
  type RouterTraceEmitter,
  type RouterTraceEvent,
  type Surface,
  type TierMissInfo,
} from "@rachael/cu-core";
import {
  serverModelRouter,
  routerTraceEmitter,
  tierMissReporter as defaultTierMissReporter,
  finalizeRouterTraceRun,
} from "./cu-router";
import { createTakeoverPoint } from "./control-bus";
import { recordRouterTierMiss } from "./evolution-engine";
import { findApprovedRecipe, getSkillLibrary } from "./skill-library";

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
  emitter?: RouterTraceEmitter;
  // Provenance — every trace event emitted by this router is tagged with
  // `metadata.source = <ActionSource>`. Defaults to "free-plan"; the recipe
  // executor passes `recipe:<id>@<v>` via `routedRecipeOrPlan`.
  source?: ActionSource;
}

export function makeServerRouter(opts: MakeServerRouterOptions = {}): Router {
  const baseEmitter: RouterTraceEmitter =
    opts.emitter ?? ((event) => routerTraceEmitter(event, { programName: opts.programName }));
  const taggedEmitter: RouterTraceEmitter = opts.source
    ? withSourceTag(baseEmitter, opts.source)
    : withFreePlanSource(baseEmitter);
  return new Router({
    runId: opts.runId,
    budget: opts.budget,
    modelRouter: serverModelRouter,
    emitter: taggedEmitter,
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

/**
 * Convenience for hosts that just want to run one step with default wiring.
 *
 * When `input.intent` is supplied, this routes through `routedRecipeOrPlan`
 * so the SkillLibrary matcher can substitute an approved recipe for free
 * planning — making the matcher live on the production seam rather than
 * an opt-in path. Hosts that don't want recipe matching can pass
 * `skipRecipeMatch: true`.
 */
export async function routedStep(
  surface: Surface,
  input: RouterStepInput,
  opts: MakeServerRouterOptions & {
    skipRecipeMatch?: boolean;
    /** Parameter bindings forwarded to the matcher / recipe executor. */
    parameters?: Record<string, unknown>;
  } = {},
): Promise<RouterStepResult> {
  if (input.intent && !opts.skipRecipeMatch) {
    const result = await routedRecipeOrPlan(
      surface,
      { intent: input.intent, parameters: opts.parameters },
      { ...opts, freePlan: input },
    );
    if (result.recipeResult?.outcome === "ok") {
      // Recipe ran end-to-end; surface the last step's result so callers
      // get a RouterStepResult-shaped value.
      const last = result.recipeResult.stepResults[result.recipeResult.stepResults.length - 1];
      if (last) return last;
    }
    if (result.fallbackResults && result.fallbackResults.length > 0) {
      return result.fallbackResults[result.fallbackResults.length - 1];
    }
    if (result.freePlanResult) return result.freePlanResult;
  }
  const router = makeServerRouter(opts);
  let result: RouterStepResult | undefined;
  try {
    result = await router.step(surface, input);
    return result;
  } finally {
    // Single-step convenience — the run is "done" once the step returns.
    // Reflect the actual outcome so failed steps aren't logged as ok and so
    // the promotion pipeline doesn't try to learn from a broken trajectory.
    const status: "ok" | "abort" = result && result.ok ? "ok" : "abort";
    await finalizeRouterTraceRun(router.getRunId(), status).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Task-96 — `routedRecipeOrPlan` is the production seam that wires the
// SkillLibrary into the cu-core Router. Hosts call this in place of
// `routedStep` whenever a high-level intent is available:
//
//   1. Match the intent against approved recipes for this surface.
//   2. On strong match: execute the recipe step-by-step under a router
//      emitter tagged `recipe:<id>@<v>`. If every step's verifier passes,
//      return `{ source: recipe, recipeResult }`.
//   3. If a step verifier or action fails midway, the executor returns
//      `outcome: "fallback"` and we continue with free-planning starting
//      from the failed step (`onFallback`); free-plan steps are tagged
//      `free-plan` so promotion only learns from un-templated trajectories.
//   4. No match → free-plan straight away with the same provenance tagging.
// ---------------------------------------------------------------------------

export interface RecipeOrPlanInput {
  intent?: string;
  parameters?: Record<string, unknown>;
}

export interface RecipeOrPlanResult {
  source: ActionSource;
  recipeResult?: RecipeExecutionResult;
  fallbackResults?: RouterStepResult[];
  freePlanResult?: RouterStepResult;
}

export interface RoutedRecipeOrPlanOptions extends MakeServerRouterOptions {
  /** Free-plan step input used when no recipe matched (or to fully resume after fallback). */
  freePlan?: RouterStepInput;
  /**
   * Custom fallback handler invoked on partial recipe failure. Receives the
   * recipe + the failed step index and is expected to drive the remaining
   * work via the supplied free-plan router. Defaults to running `freePlan`
   * once if provided.
   */
  onFallback?: (ctx: {
    recipeId: string;
    recipeVersion: number;
    failedAtStepIndex: number;
    reason?: string;
    router: Router;
    surface: Surface;
  }) => Promise<RouterStepResult[]>;
}

export async function routedRecipeOrPlan(
  surface: Surface,
  match: RecipeOrPlanInput,
  opts: RoutedRecipeOrPlanOptions = {},
): Promise<RecipeOrPlanResult> {
  // Take a cheap observation for the matcher's precondition gate. If the
  // surface can't oblige (cost, capability), we degrade gracefully — the
  // matcher will skip precondition evaluation.
  let observation: Awaited<ReturnType<Surface["observe"]>>[number] | undefined;
  try {
    const cheap = surface.descriptor.capabilities.observations[0];
    if (cheap) {
      const [obs] = await surface.observe([cheap]);
      observation = obs;
    }
  } catch { /* observation is best-effort */ }

  const matchResult = await findApprovedRecipe({
    surfaceKind: surface.descriptor.kind,
    intent: match.intent,
    parameters: match.parameters,
    observation,
  });

  let runIdForFinalize: string | undefined;
  let finalSource: ActionSource = "free-plan";
  let finalStatus: "ok" | "abort" = "ok";
  try {
    if (matchResult) {
      const source = recipeSource(matchResult.recipe.id, matchResult.recipe.version);
      finalSource = source;
      const recipeRouter = makeServerRouter({ ...opts, source });
      runIdForFinalize = recipeRouter.getRunId();
      const recipeResult = await runRecipe(recipeRouter, surface, matchResult.recipe, {
        parameters: match.parameters,
        library: getSkillLibrary(),
        programName: opts.programName,
      });
      if (recipeResult.outcome === "ok") {
        return { source, recipeResult };
      }
      // Partial recipe failure → free-plan the remainder under the SAME
      // runId, but re-tag the source as free-plan so the rest of the run
      // remains promotion-eligible the next time around.
      finalSource = "free-plan";
      const freeRouter = makeServerRouter({ ...opts, source: "free-plan", runId: recipeRouter.getRunId() });
      const fallbackResults = opts.onFallback
        ? await opts.onFallback({
            recipeId: matchResult.recipe.id,
            recipeVersion: matchResult.recipe.version,
            failedAtStepIndex: recipeResult.failedAtStepIndex ?? 0,
            reason: recipeResult.reason,
            router: freeRouter,
            surface,
          })
        : opts.freePlan
          ? [await freeRouter.step(surface, opts.freePlan)]
          : [];
      if (fallbackResults.some((r) => r.ok === false)) finalStatus = "abort";
      return { source, recipeResult, fallbackResults };
    }

    // No match → straight free-plan.
    const router = makeServerRouter({ ...opts, source: "free-plan" });
    runIdForFinalize = router.getRunId();
    const freePlanResult = opts.freePlan
      ? await router.step(surface, opts.freePlan)
      : undefined;
    if (freePlanResult && !freePlanResult.ok) finalStatus = "abort";
    return { source: "free-plan", freePlanResult };
  } finally {
    // Run-level finalization — this is what triggers persistence + the
    // promotion pipeline (per-step "complete" events do NOT). We pass the
    // resolved source so promotion can attribute the trajectory correctly.
    if (runIdForFinalize && !opts.emitter) {
      // Only finalize when the default (DB-persisting) emitter is in use;
      // tests that supply a custom emitter manage finalization themselves.
      await finalizeRouterTraceRun(runIdForFinalize, finalStatus, { source: finalSource })
        .catch((err) => console.error("[cu-router] finalize failed:", err));
    }
  }
}
