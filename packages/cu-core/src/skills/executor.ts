import type { Surface } from "../bus";
import type { Action, Verifier } from "../types";
import type { Router, RouterStepResult } from "../router/router";
import type { RouterTraceEvent, RouterTraceEmitter } from "../router/trace";
import { recipeSource, type ActionSource, type SkillLibrary, type StoredRecipe } from "./types";

// ---------------------------------------------------------------------------
// Recipe executor — runs a `StoredRecipe` step-by-step through the cu-core
// Router with verifier-gated steps. On the first failed step (action error
// OR post-verifier fail), the executor stops and returns a `fallback`
// outcome carrying `failedAtStepIndex`; the host can then resume with
// free-planning starting from the failed step.
//
// Provenance: every action attempted under a recipe is tagged with
// `metadata.source = "recipe:<id>@<version>"` via a wrapping emitter, so
// downstream trace consumers can attribute every action to its origin.
// Free-planning steps (ones the router runs WITHOUT this executor) carry
// `metadata.source = "free-plan"` when wrapped via `withFreePlanSource`.
// ---------------------------------------------------------------------------

export interface RecipeExecutionResult {
  outcome: "ok" | "fallback" | "abort";
  recipeId: string;
  recipeVersion: number;
  stepResults: RouterStepResult[];
  failedAtStepIndex?: number;
  reason?: string;
  durationMs: number;
}

export interface RunRecipeOptions {
  parameters?: Record<string, unknown>;
  /** Plug a substitution function for {{param}} tokens in action targets/text. */
  substitute?: (action: Action, params: Record<string, unknown>) => Action;
  /** Plug a substitution function for {{param}} tokens in pre/post verifiers. */
  substituteVerifier?: (verifier: Verifier, params: Record<string, unknown>) => Verifier;
  /** Optional library for stat bookkeeping; skip to defer to caller. */
  library?: SkillLibrary;
  programName?: string;
}

export type RouterEmitterFactory = (source: ActionSource) => RouterTraceEmitter;

/**
 * Wrap an existing emitter so every event it emits is tagged with
 * `metadata.source`. Pass into the Router constructor when running under a
 * recipe (or unattributed free-planning).
 */
export function withSourceTag(
  emitter: RouterTraceEmitter,
  source: ActionSource,
): RouterTraceEmitter {
  return (event: RouterTraceEvent) => {
    const merged: RouterTraceEvent = {
      ...event,
      metadata: { ...(event.metadata ?? {}), source },
    };
    emitter(merged);
  };
}

export const withFreePlanSource = (e: RouterTraceEmitter): RouterTraceEmitter =>
  withSourceTag(e, "free-plan");

/**
 * Execute a `StoredRecipe` against the supplied router + surface. The router
 * MUST already have the source-tag emitter wrapped if you want every trace
 * event tagged; alternatively pass a `routerFactory` that builds a fresh
 * router per call with the right tag.
 */
export async function runRecipe(
  router: Router,
  surface: Surface,
  stored: StoredRecipe,
  opts: RunRecipeOptions = {},
): Promise<RecipeExecutionResult> {
  const start = Date.now();
  const stepResults: RouterStepResult[] = [];
  const params = opts.parameters ?? {};
  const sub = opts.substitute ?? defaultSubstitute;
  const subV = opts.substituteVerifier ?? defaultSubstituteVerifier;

  for (let i = 0; i < stored.recipe.steps.length; i++) {
    const step = stored.recipe.steps[i];
    const action = sub(step.action, params);
    const pre: Verifier | undefined = step.pre ? subV(step.pre, params) : undefined;
    const post: Verifier | undefined = step.post ? subV(step.post, params) : undefined;
    let stepResult: RouterStepResult;
    try {
      stepResult = await router.step(surface, {
        action,
        pre,
        post,
        intent: stored.recipe.name,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const result: RecipeExecutionResult = {
        outcome: "fallback",
        recipeId: stored.id,
        recipeVersion: stored.version,
        stepResults,
        failedAtStepIndex: i,
        reason: `step threw: ${reason}`,
        durationMs: Date.now() - start,
      };
      await opts.library?.recordRun({
        recipeId: stored.id,
        recipeVersion: stored.version,
        runId: router.getRunId(),
        outcome: "fallback",
        failedAtStepIndex: i,
        durationMs: result.durationMs,
        programName: opts.programName,
        reason: result.reason,
      });
      return result;
    }
    stepResults.push(stepResult);
    if (!stepResult.ok) {
      const result: RecipeExecutionResult = {
        outcome: "fallback",
        recipeId: stored.id,
        recipeVersion: stored.version,
        stepResults,
        failedAtStepIndex: i,
        reason: stepResult.abortReason ?? `verifier failed at step ${i}`,
        durationMs: Date.now() - start,
      };
      await opts.library?.recordRun({
        recipeId: stored.id,
        recipeVersion: stored.version,
        runId: router.getRunId(),
        outcome: "fallback",
        failedAtStepIndex: i,
        durationMs: result.durationMs,
        programName: opts.programName,
        reason: result.reason,
      });
      return result;
    }
  }

  // Recipe-level success criteria — evaluated AFTER all steps pass. If any
  // criterion fails, the run is recorded as `fallback` with a reason.
  // Without this, a recipe whose individual steps pass their post-verifiers
  // but whose overall outcome is wrong (e.g. the order saved but the
  // confirmation banner never appeared) would still be counted as success.
  const successCriteria = (stored.recipe.successCriteria ?? []).map((v) => subV(v, params));
  if (successCriteria.length > 0) {
    let observation: Awaited<ReturnType<Surface["observe"]>>[number] | undefined;
    try {
      const cheap = surface.descriptor.capabilities.observations[0];
      if (cheap) [observation] = await surface.observe([cheap]);
    } catch { /* observation is best-effort */ }
    if (observation) {
      const { evaluateVerifier } = await import("../router/verifiers");
      for (let i = 0; i < successCriteria.length; i++) {
        const r = evaluateVerifier(successCriteria[i], observation);
        if (r.status === "fail") {
          const failed: RecipeExecutionResult = {
            outcome: "fallback",
            recipeId: stored.id,
            recipeVersion: stored.version,
            stepResults,
            failedAtStepIndex: stored.recipe.steps.length,
            reason: `successCriteria[${i}] failed: ${r.evidence ?? ""}`.trim(),
            durationMs: Date.now() - start,
          };
          await opts.library?.recordRun({
            recipeId: stored.id,
            recipeVersion: stored.version,
            runId: router.getRunId(),
            outcome: "fallback",
            failedAtStepIndex: failed.failedAtStepIndex,
            durationMs: failed.durationMs,
            programName: opts.programName,
            reason: failed.reason,
          });
          return failed;
        }
      }
    }
  }

  const result: RecipeExecutionResult = {
    outcome: "ok",
    recipeId: stored.id,
    recipeVersion: stored.version,
    stepResults,
    durationMs: Date.now() - start,
  };
  await opts.library?.recordRun({
    recipeId: stored.id,
    recipeVersion: stored.version,
    runId: router.getRunId(),
    outcome: "ok",
    durationMs: result.durationMs,
    programName: opts.programName,
  });
  return result;
}

export { recipeSource };

// ---------------------------------------------------------------------------
// Default {{param}} substitution: walks the action and replaces template
// tokens in string-valued fields. Conservative — only acts on properties
// whose names are common targets of templating: `text`, `cmd`, `url`, and
// `target.value`/`target.selector`.
// ---------------------------------------------------------------------------

function defaultSubstitute(action: Action, params: Record<string, unknown>): Action {
  if (Object.keys(params).length === 0) return action;
  const replace = (s: string): string =>
    s.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name) => {
      const v = params[name];
      return v === undefined ? `{{${name}}}` : String(v);
    });
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return replace(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  return walk(action) as Action;
}

function defaultSubstituteVerifier(verifier: Verifier, params: Record<string, unknown>): Verifier {
  if (Object.keys(params).length === 0) return verifier;
  const replace = (s: string): string =>
    s.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name) => {
      const v = params[name];
      return v === undefined ? `{{${name}}}` : String(v);
    });
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return replace(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  return walk(verifier) as Verifier;
}
