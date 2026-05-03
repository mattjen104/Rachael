import type { Recipe, RecipeStep, SurfaceKind } from "../types";
import type { RouterTraceEvent } from "../router/trace";
import type { RecipeOrigin, StoredRecipe } from "./types";

// ---------------------------------------------------------------------------
// Promotion pipeline — turn a successful trajectory into a `proposed`
// recipe. The expensive part (LLM summarization to write a name +
// description + parameter schema) is delegated to a host-supplied summarizer
// so cu-core stays transport-agnostic. The cheap default is a heuristic
// summarizer that just slugifies the program name.
//
// Proposals always land with status="proposed" and require human approval
// via the Evolution panel before the matcher will select them.
// ---------------------------------------------------------------------------

export interface TrajectorySummary {
  runId: string;
  programName?: string;
  surfaceKind?: SurfaceKind;
  steps: RecipeStep[];
  events: RouterTraceEvent[];
}

export interface RecipeSummarizer {
  summarize(input: TrajectorySummary): Promise<{
    name: string;
    description?: string;
    parameters?: Recipe["parameters"];
  }>;
}

/** Heuristic fallback — no LLM call, used when no summarizer is wired. */
export const heuristicSummarizer: RecipeSummarizer = {
  async summarize(input) {
    const base = input.programName?.trim() || `recipe-${input.runId.slice(0, 8)}`;
    return {
      name: base,
      description: `Auto-promoted from successful run ${input.runId}`,
      parameters: {},
    };
  },
};

export interface BuildProposedOptions {
  origin?: RecipeOrigin;
  summarizer?: RecipeSummarizer;
  now?: number;
  idGenerator?: () => string;
}

let counter = 0;
function defaultId(): string {
  counter += 1;
  return `rcp_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export async function buildProposedRecipe(
  trajectory: TrajectorySummary,
  opts: BuildProposedOptions = {},
): Promise<StoredRecipe> {
  const now = opts.now ?? Date.now();
  const summarizer = opts.summarizer ?? heuristicSummarizer;
  const summary = await summarizer.summarize(trajectory);
  const recipe: Recipe = {
    name: summary.name,
    description: summary.description,
    parameters: summary.parameters,
    surfaceKind: trajectory.surfaceKind,
    steps: trajectory.steps,
    provenance: {
      learnedFromTrajectoryId: trajectory.runId,
      author: opts.origin === "hand" ? "human" : "rachael-agent",
      createdAt: now,
    },
  };
  return {
    id: (opts.idGenerator ?? defaultId)(),
    version: 1,
    status: "proposed",
    origin: opts.origin ?? "auto",
    recipe,
    successCount: 0,
    runCount: 0,
    successRate: 0,
    sourceTrajectoryRunId: trajectory.runId,
    sourceProgramName: trajectory.programName,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Trajectory extraction — given the raw RouterTraceEvent stream from a
// successful run, reconstruct an ordered RecipeStep[] that *could* be
// replayed. Best-effort: we can only recover what the events carry. Each
// "act" event becomes one step; pre/post verifiers are not recoverable from
// trace events alone, so the proposed recipe relies on free-planning's
// implicit verifiers and the human reviewer to add explicit ones.
// ---------------------------------------------------------------------------

export function extractStepsFromTrace(events: RouterTraceEvent[]): RecipeStep[] {
  const steps: RecipeStep[] = [];
  for (const e of events) {
    if (e.kind !== "act") continue;
    // The router stamps `metadata.actedAction` (full Action with target,
    // text, url, etc.) on every act event — prefer it so the proposed
    // recipe is actually replayable. Only successful acts are promoted; a
    // failed act inside a successful trajectory was recovered from and
    // would mislead a future replay.
    const ok = e.metadata?.ok;
    if (ok === false) continue;
    const acted = e.metadata?.actedAction as import("../types").Action | undefined;
    if (acted && typeof acted === "object" && "verb" in acted) {
      steps.push({ action: acted });
      continue;
    }
    if (!e.actionVerb) continue;
    // Last-resort fallback for traces emitted before this enhancement: a
    // Hint action that at least documents what happened. Promotion still
    // requires human approval before the matcher will pick it.
    const action: import("../types").Action = {
      verb: "Hint",
      hint: `${e.actionVerb} via ${e.attemptedLocator ?? "unknown"}`,
    };
    steps.push({ action });
  }
  return steps;
}
