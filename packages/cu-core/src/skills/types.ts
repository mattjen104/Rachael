import { z } from "zod";
import { RecipeSchema, type Recipe, type SurfaceKind } from "../types";

// ---------------------------------------------------------------------------
// SkillLibrary types — a `StoredRecipe` is a cu-core `Recipe` plus the
// metadata the host needs to gate its use (status, success rate, version).
// Cross-org sharing, auto-pruning, generative synthesis, and an inspector UI
// are explicitly out of scope (see task-96).
// ---------------------------------------------------------------------------

export const RecipeStatusSchema = z.enum(["proposed", "approved", "rejected", "archived"]);
export type RecipeStatus = z.infer<typeof RecipeStatusSchema>;

export const RecipeOriginSchema = z.enum(["seed", "auto", "hand"]);
export type RecipeOrigin = z.infer<typeof RecipeOriginSchema>;

export const StoredRecipeSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  status: RecipeStatusSchema,
  origin: RecipeOriginSchema,
  recipe: RecipeSchema,
  successCount: z.number().int().nonnegative().default(0),
  runCount: z.number().int().nonnegative().default(0),
  successRate: z.number().min(0).max(1).default(0),
  sourceTrajectoryRunId: z.string().optional(),
  sourceProgramName: z.string().optional(),
  lastUsedAt: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type StoredRecipe = z.infer<typeof StoredRecipeSchema>;

export const RecipeRunOutcomeSchema = z.enum(["ok", "fallback", "abort"]);
export type RecipeRunOutcome = z.infer<typeof RecipeRunOutcomeSchema>;

export interface RecipeRunRecord {
  recipeId: string;
  recipeVersion: number;
  runId: string;
  outcome: RecipeRunOutcome;
  failedAtStepIndex?: number;
  durationMs: number;
  programName?: string;
  reason?: string;
}

export interface SkillLibraryQuery {
  status?: RecipeStatus | RecipeStatus[];
  surfaceKind?: SurfaceKind;
  intent?: string;
}

/**
 * SkillLibrary — durable store of `Recipe` records and their per-run stats.
 * The in-memory implementation is for tests/bench; the host wires a database-
 * backed implementation in `server/skill-library.ts`.
 */
export interface SkillLibrary {
  list(query?: SkillLibraryQuery): Promise<StoredRecipe[]>;
  get(id: string): Promise<StoredRecipe | undefined>;
  put(stored: StoredRecipe): Promise<StoredRecipe>;
  setStatus(id: string, status: RecipeStatus): Promise<StoredRecipe | undefined>;
  recordRun(record: RecipeRunRecord): Promise<void>;
}

/** Provenance string stamped on every router action. */
export type ActionSource = "free-plan" | `recipe:${string}@${number}`;

export function recipeSource(recipeId: string, version: number): ActionSource {
  return `recipe:${recipeId}@${version}` as ActionSource;
}

export function isRecipeSource(s: string | undefined): s is `recipe:${string}@${number}` {
  return typeof s === "string" && s.startsWith("recipe:");
}

export function parseRecipeSource(s: string): { id: string; version: number } | undefined {
  if (!s.startsWith("recipe:")) return undefined;
  const at = s.lastIndexOf("@");
  if (at < 0) return undefined;
  const id = s.slice("recipe:".length, at);
  const version = Number(s.slice(at + 1));
  if (!id || !Number.isFinite(version)) return undefined;
  return { id, version };
}

export type { Recipe };
