import {
  InMemorySkillLibrary,
  SEED_RECIPES,
  buildProposedRecipe,
  extractStepsFromTrace,
  matchRecipe,
  type MatchInput,
  type MatchResult,
  type RecipeRunRecord,
  type RecipeStatus,
  type RecipeSummarizer,
  type SkillLibrary,
  type SkillLibraryQuery,
  type StoredRecipe,
  type SurfaceKind,
} from "@rachael/cu-core";
import type { RouterTraceEvent } from "@rachael/cu-core";
import { storage } from "./storage";
import { executeLLM, type LLMConfig } from "./llm-client";
import { emitEvent } from "./event-bus";
import type { CuRecipe, InsertCuRecipe } from "@shared/schema";

// ---------------------------------------------------------------------------
// `DbSkillLibrary` — Drizzle-backed implementation of `cu-core/SkillLibrary`.
// All recipe state lives in `cu_recipes`; per-invocation outcomes live in
// `cu_recipe_runs`. Stat updates (runCount/successCount/successRate) are
// kept in the recipe row by `storage.recordCuRecipeRun`.
//
// Default for local/test use is `InMemorySkillLibrary` (cu-core); the host
// always uses `DbSkillLibrary` via the singleton below.
// ---------------------------------------------------------------------------

export class DbSkillLibrary implements SkillLibrary {
  async list(query: SkillLibraryQuery = {}): Promise<StoredRecipe[]> {
    const rows = await storage.listCuRecipes({
      status: query.status,
      surfaceKind: query.surfaceKind,
    });
    let items = rows.map(rowToStored);
    if (query.intent) {
      const needle = query.intent.toLowerCase();
      items = items.filter((r) => {
        const hay = `${r.recipe.name} ${r.recipe.description ?? ""}`.toLowerCase();
        return hay.includes(needle);
      });
    }
    return items;
  }

  async get(id: string): Promise<StoredRecipe | undefined> {
    const row = await storage.getCuRecipe(id);
    return row ? rowToStored(row) : undefined;
  }

  async put(stored: StoredRecipe): Promise<StoredRecipe> {
    const row = await storage.upsertCuRecipe(storedToInsert(stored));
    return rowToStored(row);
  }

  async setStatus(id: string, status: RecipeStatus): Promise<StoredRecipe | undefined> {
    const row = await storage.setCuRecipeStatus(id, status);
    return row ? rowToStored(row) : undefined;
  }

  async recordRun(record: RecipeRunRecord): Promise<void> {
    await storage.recordCuRecipeRun({
      recipeId: record.recipeId,
      recipeVersion: record.recipeVersion,
      runId: record.runId,
      programName: record.programName ?? null,
      outcome: record.outcome,
      failedAtStepIndex: record.failedAtStepIndex ?? null,
      durationMs: record.durationMs,
      reason: record.reason ?? null,
    });
  }
}

function rowToStored(row: CuRecipe): StoredRecipe {
  return {
    id: row.id,
    version: row.version,
    status: row.status as RecipeStatus,
    origin: row.origin as StoredRecipe["origin"],
    recipe: row.recipe as StoredRecipe["recipe"],
    successCount: row.successCount,
    runCount: row.runCount,
    successRate: Number(row.successRate) || 0,
    sourceTrajectoryRunId: row.sourceTrajectoryRunId ?? undefined,
    sourceProgramName: row.sourceProgramName ?? undefined,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : undefined,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function storedToInsert(s: StoredRecipe): InsertCuRecipe {
  return {
    id: s.id,
    version: s.version,
    name: s.recipe.name,
    description: s.recipe.description ?? null,
    surfaceKind: s.recipe.surfaceKind ?? null,
    status: s.status,
    origin: s.origin,
    recipe: s.recipe as Record<string, unknown>,
    successCount: s.successCount,
    runCount: s.runCount,
    successRate: s.successRate.toFixed(4),
    sourceTrajectoryRunId: s.sourceTrajectoryRunId ?? null,
    sourceProgramName: s.sourceProgramName ?? null,
    lastUsedAt: s.lastUsedAt ? new Date(s.lastUsedAt) : null,
  };
}

let _library: SkillLibrary | undefined;

export function getSkillLibrary(): SkillLibrary {
  if (!_library) _library = new DbSkillLibrary();
  return _library;
}

/** Test seam — replace the singleton (e.g. with `InMemorySkillLibrary`). */
export function setSkillLibrary(lib: SkillLibrary): void {
  _library = lib;
}

// ---------------------------------------------------------------------------
// Seed loader — idempotently inserts the hand-authored seed recipes on boot.
// Existing rows are left alone (so human edits survive a restart).
// ---------------------------------------------------------------------------

export async function seedSkillLibrary(): Promise<{ inserted: number; existing: number }> {
  const lib = getSkillLibrary();
  let inserted = 0;
  let existing = 0;
  for (const seed of SEED_RECIPES) {
    const have = await lib.get(seed.id);
    if (have) { existing += 1; continue; }
    await lib.put(seed);
    inserted += 1;
  }
  if (inserted > 0) {
    emitEvent("skill-library", `Seeded ${inserted} cu-core recipe(s) (${existing} already present)`, "info");
  }
  return { inserted, existing };
}

// ---------------------------------------------------------------------------
// Matcher facade — used by the router host before falling back to free-plan.
// ---------------------------------------------------------------------------

export async function findApprovedRecipe(input: MatchInput): Promise<MatchResult | undefined> {
  return matchRecipe(getSkillLibrary(), input);
}

// ---------------------------------------------------------------------------
// Promotion pipeline — when a router run completes successfully, queue a
// proposed recipe (cheap LLM summarizer). Idempotent per runId: we won't
// promote the same trajectory twice.
// ---------------------------------------------------------------------------

const promotedRunIds = new Set<string>();
const PROMOTED_CAP = 1024;

export interface PromotionInput {
  runId: string;
  programName?: string;
  surfaceKind?: SurfaceKind;
  events: RouterTraceEvent[];
  llmConfig?: LLMConfig;
  /** Skip LLM summarizer (test-only). */
  noLLM?: boolean;
}

export async function promoteSuccessfulTrajectory(input: PromotionInput): Promise<StoredRecipe | undefined> {
  // Dedupe is performed AFTER validation so an early non-promotable call
  // (e.g. arrived before all step events were buffered, or extracted only
  // failed acts) doesn't permanently block a later, full trajectory for
  // the same runId.
  if (promotedRunIds.has(input.runId)) return undefined;

  const steps = extractStepsFromTrace(input.events);
  if (steps.length === 0) return undefined;
  // Don't bother promoting trivial 1-step trajectories (already a single
  // free-plan action — cheaper to just re-plan).
  if (steps.length < 2) return undefined;

  // Validation passed — claim the runId now so concurrent callers don't
  // double-promote. Cap eviction is a naive "drop oldest half".
  promotedRunIds.add(input.runId);
  if (promotedRunIds.size > PROMOTED_CAP) {
    const arr = Array.from(promotedRunIds);
    promotedRunIds.clear();
    arr.slice(arr.length / 2).forEach((id) => promotedRunIds.add(id));
  }

  const summarizer = input.noLLM ? undefined : makeLLMSummarizer(input.llmConfig);
  const proposed = await buildProposedRecipe(
    {
      runId: input.runId,
      programName: input.programName,
      surfaceKind: input.surfaceKind,
      steps,
      events: input.events,
    },
    { summarizer, origin: "auto" },
  );
  await getSkillLibrary().put(proposed);
  emitEvent("skill-library", `Proposed recipe "${proposed.recipe.name}" from run ${input.runId} (awaiting approval)`, "info", {
    program: input.programName,
  });
  return proposed;
}

function makeLLMSummarizer(llmConfig?: LLMConfig): RecipeSummarizer {
  return {
    async summarize(input) {
      try {
        const stepLines = input.steps.slice(0, 30).map((s, i) => {
          const action = s.action as { verb: string; hint?: string; text?: string; cmd?: string; url?: string };
          return `${i + 1}. ${action.verb}${action.hint ? `(${action.hint})` : ""}`;
        }).join("\n");
        const prompt = [
          { role: "system" as const, content: "You name and describe automation recipes. Reply with JSON: {\"name\": string, \"description\": string, \"parameters\": {name: {type, required, description}}}. Use short slug-style names (kebab-case). Parameters should reflect any obvious user-supplied values (text inputs, URLs, IDs)." },
          { role: "user" as const, content: `Program: ${input.programName ?? "unknown"}\nSurface: ${input.surfaceKind ?? "unknown"}\nSteps:\n${stepLines}\n\nReply with JSON only.` },
        ];
        const res = await executeLLM(prompt, "openrouter/google/gemini-flash-1.5", llmConfig, {}, { maxTokens: 400 });
        const text = res.content.trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("no JSON in summarizer reply");
        const parsed = JSON.parse(jsonMatch[0]) as { name?: string; description?: string; parameters?: Record<string, { type: string; required?: boolean; description?: string }> };
        const params: Record<string, { type: "string" | "number" | "boolean"; required?: boolean; description?: string }> = {};
        for (const [k, v] of Object.entries(parsed.parameters ?? {})) {
          const type = v.type === "number" || v.type === "boolean" ? v.type : "string";
          params[k] = { type, required: v.required, description: v.description };
        }
        return {
          name: (parsed.name?.trim() || `recipe-${input.runId.slice(0, 8)}`).slice(0, 80),
          description: parsed.description?.trim().slice(0, 280),
          parameters: params,
        };
      } catch (err) {
        console.warn("[skill-library] LLM summarizer failed, using heuristic:", err);
        return {
          name: input.programName?.trim() || `recipe-${input.runId.slice(0, 8)}`,
          description: `Auto-promoted from successful run ${input.runId}`,
          parameters: {},
        };
      }
    },
  };
}
