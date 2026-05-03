import type { Surface } from "../bus";
import type {
  Action,
  ActionVerb,
  Locator,
  LocatorKind,
  Observation,
  ObservationKind,
  SurfaceKind,
  Verifier,
  VerifierResult,
} from "../types";
import { Budget } from "./budget";
import { DEFAULT_RECOVERY_POLICY, type RecoveryPolicy, type RecoveryStep } from "./recovery";
import { getStrategy, intersectPriority } from "./strategy-table";
import {
  deriveProfile,
  NULL_MODEL_ROUTER,
  type ModelChoice,
  type ModelRouterAdapter,
  type TaskProfile,
} from "./task-profile";
import { newTraceId, type RouterTraceEmitter, type RouterTraceEvent } from "./trace";
import { evaluateVerifier } from "./verifiers";

// ---------------------------------------------------------------------------
// Router — the Cheapest-Reliable Loop. For each step it:
//   1. Picks the cheapest sufficient observation tier the surface supports
//   2. Runs precondition (if any), escalating tiers when it fails
//   3. Picks the cheapest viable locator, REWRITES the action's target to
//      that locator kind, and dispatches the action through the surface
//   4. Treats `act` failure as a step failure (recovery loop runs)
//   5. Runs postcondition; on failure, escalates per RecoveryPolicy. Each
//      reobserve runs a fresh model-routing + budget check at the new tier.
//   6. Emits RouterTrace events at every decision boundary
//
// The router never imports the host server; persistence and takeover are
// pluggable hooks (`emitter`, `onTakeover`, `modelRouter`, `tierMissReporter`).
// ---------------------------------------------------------------------------

export interface RouterStepInput {
  action: Action;
  pre?: Verifier;
  post?: Verifier;
  expectedOutput?: TaskProfile["expectedOutput"];
  intent?: string;
}

export interface RouterStepResult {
  ok: boolean;
  observation: Observation;
  observationKind: ObservationKind;
  attemptedLocator: LocatorKind;
  actedAction: Action;
  modelChoice?: ModelChoice;
  preResult?: VerifierResult;
  postResult?: VerifierResult;
  fallbackChain: ObservationKind[];
  takeoverRequested?: { reason: string };
  abortReason?: string;
  // True when the step succeeded only after escalating past the cheapest tier.
  tierMiss?: { cheapest: ObservationKind; succeededAt: ObservationKind };
}

export interface RouterOptions {
  runId?: string;
  budget?: Budget;
  recovery?: RecoveryPolicy;
  modelRouter?: ModelRouterAdapter;
  emitter?: RouterTraceEmitter;
  onTakeover?: (event: RouterTraceEvent) => Promise<"resume" | "abort"> | "resume" | "abort";
  // Receives "observation-tier miss" notifications. The host wires this to
  // server/evolution-engine.ts so the engine can propose strategy mutations.
  tierMissReporter?: (info: TierMissInfo) => void;
  // Maximum number of retry attempts before giving up (per step). The
  // recovery policy gates which kind of recovery to run; this is a hard cap.
  maxRetries?: number;
}

export interface TierMissInfo {
  surfaceKind: SurfaceKind;
  surfaceId: string;
  intent?: string;
  cheapest: ObservationKind;
  succeededAt: ObservationKind;
  fallbackChain: ObservationKind[];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Router {
  private readonly runId: string;
  private readonly budget: Budget;
  private readonly recovery: RecoveryPolicy;
  private readonly modelRouter: ModelRouterAdapter;
  private readonly emit: RouterTraceEmitter;
  private readonly onTakeover?: RouterOptions["onTakeover"];
  private readonly tierMissReporter?: RouterOptions["tierMissReporter"];
  private readonly maxRetries: number;
  private stepCounter = 0;

  constructor(opts: RouterOptions = {}) {
    this.runId = opts.runId ?? newTraceId("run");
    this.budget = opts.budget ?? new Budget();
    this.recovery = opts.recovery ?? DEFAULT_RECOVERY_POLICY;
    this.modelRouter = opts.modelRouter ?? NULL_MODEL_ROUTER;
    this.emit = opts.emitter ?? (() => {});
    this.onTakeover = opts.onTakeover;
    this.tierMissReporter = opts.tierMissReporter;
    this.maxRetries = opts.maxRetries ?? 4;
  }

  getBudget(): Budget {
    return this.budget;
  }

  getRunId(): string {
    return this.runId;
  }

  /**
   * Run a single Cheapest-Reliable step against the supplied surface.
   */
  async step(surface: Surface, input: RouterStepInput): Promise<RouterStepResult> {
    const stepIndex = this.stepCounter++;
    const surfaceKind = surface.descriptor.kind;
    const strategy = getStrategy(surfaceKind);
    const supported = surface.descriptor.capabilities.observations;
    const tiers = intersectPriority(strategy.observationPriority, supported);

    if (tiers.length === 0) {
      const reason = `no observation tier available for surface ${surfaceKind}`;
      this.trace({ stepIndex, surface, kind: "abort", reason });
      return this.failResult(reason, surface, "coords", input.action);
    }

    const cheapest = tiers[0];
    const fallbackChain: ObservationKind[] = [];
    let observation: Observation | undefined;
    let observationKind: ObservationKind = cheapest;
    let modelChoice: ModelChoice | undefined;
    let preResult: VerifierResult | undefined;

    // ---------- Observe (with tier descent on verifier failure) ----------
    let tierIdx = 0;
    while (tierIdx < tiers.length) {
      const candidate = tiers[tierIdx];
      const obsResult = await this.observeAtTier(surface, candidate, input, stepIndex);
      if (!obsResult.ok) {
        if (obsResult.budgetDenied) {
          return this.failResult(`budget-denied: ${obsResult.reason}`, surface, "coords", input.action, {
            observation, observationKind, fallbackChain, modelChoice: obsResult.choice,
          });
        }
        tierIdx++;
        continue;
      }
      observation = obsResult.observation;
      observationKind = candidate;
      modelChoice = obsResult.choice;
      fallbackChain.push(candidate);

      if (input.pre) {
        const r = evaluateVerifier(input.pre, obsResult.observation);
        this.trace({
          stepIndex, surface, kind: "verify",
          observation: { kind: obsResult.observation.kind, digest: obsResult.observation.digest },
          verifier: { kind: input.pre.kind, result: r },
          reason: `pre ${r.status}`,
        });
        if (r.status === "fail") {
          tierIdx++;
          this.trace({
            stepIndex, surface, kind: "escalate",
            attemptedObservation: candidate,
            fallbackChain: [...fallbackChain],
            reason: "precondition failed; trying next observation tier",
          });
          continue;
        }
        preResult = r;
      }
      break;
    }

    if (!observation) {
      const reason = "all observation tiers failed";
      this.trace({ stepIndex, surface, kind: "abort", reason });
      return this.failResult(reason, surface, "coords", input.action, { fallbackChain });
    }

    // If a precondition was supplied but never passed (because every tier
    // failed it), DO NOT proceed to act. Retrying or reobserving won't help
    // when there are no more tiers, so jump straight to takeover (so the
    // host's takeover bridge gets a chance) and abort if the human declines.
    if (input.pre && !preResult) {
      const reason = "precondition failed on every observation tier";
      const stop = await this.handleRecovery(
        { kind: "takeover", reason },
        surface, stepIndex, input, fallbackChain,
      );
      if (stop.kind === "stop") {
        return {
          ok: false,
          observation,
          observationKind,
          attemptedLocator: "coords",
          actedAction: input.action,
          modelChoice,
          fallbackChain,
          takeoverRequested: stop.takeover,
          abortReason: stop.abortReason ?? reason,
        };
      }
      // If takeover resolved as "resume", fall through to act with the
      // last observation; the human has accepted the risk explicitly.
    }

    // ---------- Locator selection + action rewrite ----------
    let attemptedLocator = pickLocatorKind(input.action, strategy.locatorPriority, surface.descriptor.capabilities.locators);
    let isCoordClick = attemptedLocator === "coords";
    const budgetCoord = this.budget.check(0, isCoordClick);
    if (!budgetCoord.ok) {
      this.trace({
        stepIndex, surface, kind: "budget-deny",
        attemptedLocator, reason: budgetCoord.reason ?? "coord-click denied by budget",
      });
      return this.failResult(`budget-denied: ${budgetCoord.reason}`, surface, attemptedLocator, input.action, {
        observation, observationKind, fallbackChain, modelChoice,
      });
    }

    let actedAction = applyLocatorChoice(input.action, attemptedLocator, observation);

    this.trace({
      stepIndex, surface, kind: "decision",
      observation: { kind: observation.kind, digest: observation.digest },
      attemptedObservation: observationKind,
      attemptedLocator,
      actionVerb: input.action.verb as ActionVerb,
      modelId: modelChoice?.modelId,
      estimatedCost: modelChoice?.estimatedCost,
      reason: `chose ${observationKind} + ${attemptedLocator} for ${input.action.verb}`,
    });

    // ---------- Act + recovery loop ----------
    let retriesUsed = 0;
    let postResult: VerifierResult | undefined;
    let succeededAt: ObservationKind | undefined;
    let lastActOk = false;
    let lastActError: string | undefined;

    while (true) {
      let actError: string | undefined;
      let actOk = false;
      try {
        const actResult = await surface.act(actedAction);
        actOk = actResult.ok;
        actError = actResult.error;
      } catch (err) {
        actOk = false;
        actError = errMsg(err);
      }
      this.budget.consume({ action: true, coordClick: isCoordClick });
      this.trace({
        stepIndex, surface, kind: "act",
        actionVerb: actedAction.verb as ActionVerb,
        attemptedLocator,
        reason: actOk ? "act ok" : `act failed: ${actError ?? "unknown"}`,
        // Persist the full action payload so downstream promotion can recover
        // a replayable RecipeStep[] (verb + target + text/url/cmd, etc).
        metadata: { actedAction, ok: actOk, intent: input.intent },
      });
      lastActOk = actOk;
      lastActError = actError;

      // If act failed AND there's no postcondition to drive recovery, force
      // recovery to run by treating the failure as a fail-status verdict.
      let r: VerifierResult;
      if (input.post) {
        const postObs = await this.observeSafely(surface, observationKind);
        r = postObs ? evaluateVerifier(input.post, postObs) : { status: "unknown", evidence: "no observation" };
        if (postObs) observation = postObs;
        this.trace({
          stepIndex, surface, kind: "verify",
          observation: postObs ? { kind: postObs.kind, digest: postObs.digest } : undefined,
          verifier: { kind: input.post.kind, result: r },
          reason: `post ${r.status}`,
        });
        postResult = r;
      } else if (!actOk) {
        r = { status: "fail", evidence: actError ?? "act failed" };
      } else {
        succeededAt = observationKind;
        break;
      }

      if (r.status === "pass") {
        succeededAt = observationKind;
        break;
      }

      // Recovery — pick the next step from the policy.
      const remaining = tiers.slice(tiers.indexOf(observationKind) + 1);
      const next = this.recovery.next({
        failedObservation: observationKind,
        remainingObservations: remaining,
        retriesUsed,
        budgetExhausted: this.budget.exhausted(),
      });

      const stop = await this.handleRecovery(next, surface, stepIndex, input, fallbackChain);
      if (stop.kind === "stop") {
        return {
          ok: false,
          observation,
          observationKind,
          attemptedLocator,
          actedAction,
          modelChoice,
          preResult,
          postResult,
          fallbackChain,
          takeoverRequested: stop.takeover,
          abortReason: stop.abortReason ?? lastActError,
        };
      }
      if (next.kind === "retry") retriesUsed += 1;
      if (next.kind === "reobserve") {
        // Re-run model routing + budget check at the new tier.
        const escalated = await this.observeAtTier(surface, next.observation, input, stepIndex);
        if (!escalated.ok) {
          return this.failResult(
            escalated.budgetDenied ? `budget-denied: ${escalated.reason}` : `escalation failed: ${escalated.reason}`,
            surface, attemptedLocator, actedAction,
            { observation, observationKind, fallbackChain, modelChoice: escalated.choice ?? modelChoice },
          );
        }
        observationKind = next.observation;
        observation = escalated.observation;
        modelChoice = escalated.choice;
        fallbackChain.push(observationKind);
        // Recompute locator + action from the new observation. A deeper tier
        // may unlock a better locator (e.g. AxTree → DomSnapshot enables
        // selectors), and the synthesized target should reflect the fresh
        // observation. We re-check the budget for the (possibly new) coord-
        // click status so we don't silently exceed coord-click caps.
        attemptedLocator = pickLocatorKind(input.action, strategy.locatorPriority, surface.descriptor.capabilities.locators);
        isCoordClick = attemptedLocator === "coords";
        const reBudget = this.budget.check(0, isCoordClick);
        if (!reBudget.ok) {
          this.trace({
            stepIndex, surface, kind: "budget-deny",
            attemptedLocator, reason: reBudget.reason ?? "coord-click denied by budget after reobserve",
          });
          return this.failResult(`budget-denied: ${reBudget.reason}`, surface, attemptedLocator, actedAction, {
            observation, observationKind, fallbackChain, modelChoice,
          });
        }
        actedAction = applyLocatorChoice(input.action, attemptedLocator, observation);
        this.trace({
          stepIndex, surface, kind: "observe",
          observation: { kind: observation.kind, digest: observation.digest },
          attemptedObservation: observationKind,
          attemptedLocator,
          actionVerb: actedAction.verb as ActionVerb,
          modelId: escalated.choice.modelId,
          estimatedCost: escalated.choice.estimatedCost,
          reason: `recovery reobserved at ${observationKind}; re-picked locator=${attemptedLocator}`,
        });
      }
      if (retriesUsed > this.maxRetries) {
        return this.failResult("max-retries-exceeded", surface, attemptedLocator, actedAction, {
          observation, observationKind, fallbackChain, modelChoice,
        });
      }
    }

    // Tier miss reporting — anything beyond `cheapest` is a miss for that tier.
    let tierMiss: RouterStepResult["tierMiss"];
    if (succeededAt && succeededAt !== cheapest) {
      tierMiss = { cheapest, succeededAt };
      this.trace({
        stepIndex, surface, kind: "tier-miss",
        observation: { kind: observation.kind, digest: observation.digest },
        attemptedObservation: cheapest,
        fallbackChain: [...fallbackChain],
        reason: `cheapest tier ${cheapest} insufficient; succeeded at ${succeededAt}`,
        metadata: { intent: input.intent },
      });
      this.tierMissReporter?.({
        surfaceKind, surfaceId: surface.descriptor.id,
        intent: input.intent, cheapest, succeededAt, fallbackChain: [...fallbackChain],
      });
    }

    this.trace({
      stepIndex, surface, kind: "complete",
      observation: { kind: observation.kind, digest: observation.digest },
      attemptedObservation: observationKind,
      attemptedLocator,
      actionVerb: actedAction.verb as ActionVerb,
      reason: lastActOk ? "step complete" : "step complete after recovery",
    });

    return {
      ok: true,
      observation,
      observationKind,
      attemptedLocator,
      actedAction,
      modelChoice,
      preResult,
      postResult,
      fallbackChain,
      tierMiss,
    };
  }

  /**
   * Observe at a specific tier, running model routing + budget check first.
   * Returns a discriminated result so the caller can distinguish "transient
   * failure, try the next tier" from "budget denied, abort the step".
   */
  private async observeAtTier(
    surface: Surface,
    candidate: ObservationKind,
    input: RouterStepInput,
    stepIndex: number,
  ): Promise<
    | { ok: true; observation: Observation; choice: ModelChoice }
    | { ok: false; budgetDenied: boolean; reason: string; choice?: ModelChoice }
  > {
    const profile = deriveProfile(candidate, input.expectedOutput ?? "decision", input.intent);
    const choice = await this.modelRouter.pickForProfile(profile);
    const budgetCheck = this.budget.check(choice.estimatedCost);
    if (!budgetCheck.ok) {
      this.trace({
        stepIndex, surface, kind: "budget-deny",
        attemptedObservation: candidate,
        modelId: choice.modelId,
        estimatedCost: choice.estimatedCost,
        reason: budgetCheck.reason ?? "budget-denied",
      });
      return { ok: false, budgetDenied: true, reason: budgetCheck.reason ?? "budget-denied", choice };
    }
    try {
      const obs = (await surface.observe([candidate]))[0];
      this.budget.consume({ spendUsd: choice.estimatedCost });
      this.trace({
        stepIndex, surface, kind: "observe",
        observation: { kind: obs.kind, digest: obs.digest },
        attemptedObservation: candidate,
        modelId: choice.modelId,
        estimatedCost: choice.estimatedCost,
        reason: `observed ${candidate}`,
      });
      return { ok: true, observation: obs, choice };
    } catch (err) {
      const reason = `observe threw: ${errMsg(err)}`;
      this.trace({
        stepIndex, surface, kind: "escalate",
        attemptedObservation: candidate,
        reason,
      });
      return { ok: false, budgetDenied: false, reason, choice };
    }
  }

  private async handleRecovery(
    next: RecoveryStep,
    surface: Surface,
    stepIndex: number,
    input: RouterStepInput,
    fallbackChain: ObservationKind[],
  ): Promise<{ kind: "continue" } | { kind: "stop"; takeover?: { reason: string }; abortReason?: string }> {
    this.trace({
      stepIndex, surface, kind: "recovery",
      fallbackChain: [...fallbackChain],
      actionVerb: input.action.verb as ActionVerb,
      reason: `recovery step: ${next.kind}${"reason" in next ? ` (${next.reason})` : ""}`,
    });

    if (next.kind === "abort") {
      this.trace({ stepIndex, surface, kind: "abort", reason: next.reason });
      return { kind: "stop", abortReason: next.reason };
    }
    if (next.kind === "takeover") {
      const event = this.buildTrace({
        stepIndex, surface, kind: "takeover", reason: next.reason,
      });
      this.emit(event);
      const decision = this.onTakeover ? await this.onTakeover(event) : "abort";
      if (decision === "abort") return { kind: "stop", takeover: { reason: next.reason } };
      return { kind: "continue" };
    }
    return { kind: "continue" };
  }

  private async observeSafely(surface: Surface, kind: ObservationKind): Promise<Observation | undefined> {
    try { return (await surface.observe([kind]))[0]; } catch { return undefined; }
  }

  private failResult(
    reason: string,
    surface: Surface,
    locator: LocatorKind,
    actedAction: Action,
    extra: Partial<RouterStepResult> = {},
  ): RouterStepResult {
    const fakeObs: Observation = { kind: "TextDump", surfaceId: surface.descriptor.id, timestamp: Date.now(), digest: "0", text: reason };
    return {
      ok: false,
      observation: extra.observation ?? fakeObs,
      observationKind: extra.observationKind ?? "TextDump",
      attemptedLocator: locator,
      actedAction,
      modelChoice: extra.modelChoice,
      fallbackChain: extra.fallbackChain ?? [],
      abortReason: reason,
    };
  }

  private trace(args: {
    stepIndex: number;
    surface: Surface;
    kind: RouterTraceEvent["kind"];
    reason: string;
    observation?: RouterTraceEvent["observation"];
    attemptedObservation?: ObservationKind;
    attemptedLocator?: LocatorKind;
    actionVerb?: ActionVerb;
    modelId?: string;
    estimatedCost?: number;
    verifier?: RouterTraceEvent["verifier"];
    fallbackChain?: ObservationKind[];
    metadata?: Record<string, unknown>;
  }): void {
    this.emit(this.buildTrace(args));
  }

  private buildTrace(args: {
    stepIndex: number;
    surface: Surface;
    kind: RouterTraceEvent["kind"];
    reason: string;
    observation?: RouterTraceEvent["observation"];
    attemptedObservation?: ObservationKind;
    attemptedLocator?: LocatorKind;
    actionVerb?: ActionVerb;
    modelId?: string;
    estimatedCost?: number;
    verifier?: RouterTraceEvent["verifier"];
    fallbackChain?: ObservationKind[];
    metadata?: Record<string, unknown>;
  }): RouterTraceEvent {
    return {
      id: newTraceId("rt"),
      ts: Date.now(),
      runId: this.runId,
      stepIndex: args.stepIndex,
      kind: args.kind,
      surfaceId: args.surface.descriptor.id,
      surfaceKind: args.surface.descriptor.kind,
      observation: args.observation,
      attemptedObservation: args.attemptedObservation,
      attemptedLocator: args.attemptedLocator,
      actionVerb: args.actionVerb,
      modelId: args.modelId,
      estimatedCost: args.estimatedCost,
      verifier: args.verifier,
      fallbackChain: args.fallbackChain,
      reason: args.reason,
      metadata: args.metadata,
    };
  }
}

// Pick the locator kind that matches both the action's actual locator (if it
// has one and the surface supports it) and the strategy/capability ladder.
// Falls through to the first supported locator if the action carries none.
export function pickLocatorKind(
  action: Action,
  priority: LocatorKind[],
  supported: LocatorKind[],
): LocatorKind {
  const supSet = new Set(supported);
  const target = (action as { target?: { kind: LocatorKind } }).target;
  if (target && supSet.has(target.kind)) {
    return target.kind;
  }
  for (const k of priority) {
    if (supSet.has(k)) return k;
  }
  return supported[0] ?? "coords";
}

// Rewrite the action so its `target` matches the picked locator kind. If the
// caller already supplied a matching locator, return as-is. Otherwise, build
// a locator from the observation (selector text, hint key, mark, or coords).
// For verbs without a target (Wait, Key, Goto, Shell, Composite), the action
// is returned unchanged.
export function applyLocatorChoice(action: Action, kind: LocatorKind, obs: Observation): Action {
  if (!("target" in action)) return action;
  const existing = (action as { target?: Locator }).target;
  if (existing && existing.kind === kind) return action;

  const newTarget = synthesizeLocator(kind, obs, existing);
  if (!newTarget) return action;
  return { ...(action as object), target: newTarget } as Action;
}

function synthesizeLocator(kind: LocatorKind, obs: Observation, hint?: Locator): Locator | undefined {
  switch (kind) {
    case "selector": {
      const css = hint && hint.kind === "selector" ? hint.css : firstSelectorFromObservation(obs);
      if (!css) return undefined;
      return { kind: "selector", css };
    }
    case "uia": {
      if (hint && hint.kind === "uia") return hint;
      return { kind: "uia", name: firstElementText(obs) };
    }
    case "hint": {
      if (hint && hint.kind === "hint") return hint;
      return { kind: "hint", key: "a" };
    }
    case "mark": {
      if (hint && hint.kind === "mark") return hint;
      return { kind: "mark", mark: "1" };
    }
    case "coords": {
      if (hint && hint.kind === "coords") return hint;
      return { kind: "coords", x: 0, y: 0, rationale: "router-fallback (no stable handle in observation)" };
    }
  }
}

function firstSelectorFromObservation(obs: Observation): string | undefined {
  if (obs.kind === "DomSnapshot") {
    const el = obs.elements?.[0];
    return el ? el.tag : undefined;
  }
  return undefined;
}

function firstElementText(obs: Observation): string | undefined {
  if (obs.kind === "DomSnapshot") return obs.elements?.[0]?.text;
  if (obs.kind === "UiaTree") return obs.elements[0]?.name ?? obs.elements[0]?.automationId;
  return undefined;
}
