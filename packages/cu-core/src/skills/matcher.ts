import type { Observation, SurfaceKind, Verifier } from "../types";
import { evaluateVerifier } from "../router/verifiers";
import type { SkillLibrary, StoredRecipe } from "./types";

// ---------------------------------------------------------------------------
// Matcher — given the current goal (intent + surface), pick the best
// approved recipe to try. Selection is deliberately simple:
//   1. status == "approved"
//   2. surfaceKind matches (or recipe has no specific surfaceKind)
//   3. all required parameters are satisfied by the supplied bindings
//   4. score = successRate biased by intent token overlap
// We never fall back to "proposed" recipes here — proposals require human
// approval via the Evolution panel before they can be selected.
// ---------------------------------------------------------------------------

export interface MatchInput {
  surfaceKind?: SurfaceKind;
  intent?: string;
  parameters?: Record<string, unknown>;
  /**
   * Current surface observation. When supplied, `matchRecipe` evaluates the
   * recipe's preconditions (top-level `recipe.preconditions[]` and
   * `steps[0].pre` if present) against this observation and rejects any
   * recipe whose preconditions fail. This implements the task requirement
   * that a recipe must be verifier-eligible for the current state — not just
   * a token/parameter match.
   */
  observation?: Observation;
}

export interface MatchResult {
  recipe: StoredRecipe;
  score: number;
  missingParameters: string[];
  /** Whether preconditions were evaluated; "skipped" if no observation. */
  preconditionStatus: "pass" | "skipped";
}

const STOPWORDS = new Set([
  "a", "an", "the", "to", "for", "of", "in", "on", "and", "or",
  "with", "by", "from", "into", "as", "is", "are", "was",
]);

function tokens(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t));
}

export function scoreMatch(
  recipe: StoredRecipe,
  input: MatchInput,
): { score: number; missingParameters: string[] } | undefined {
  if (input.surfaceKind && recipe.recipe.surfaceKind && recipe.recipe.surfaceKind !== input.surfaceKind) {
    return undefined;
  }

  const bindings = input.parameters ?? {};
  const { missing, typeMismatches } = checkParameters(recipe, bindings);
  // Type mismatches disqualify the recipe outright — a `value=42` binding
  // for a `value: string` parameter cannot be safely substituted into the
  // recipe's templated action payloads.
  if (typeMismatches.length > 0) return undefined;

  const intentToks = new Set(tokens(input.intent));
  const recipeToks = tokens(`${recipe.recipe.name} ${recipe.recipe.description ?? ""}`);
  let overlap = 0;
  for (const t of recipeToks) if (intentToks.has(t)) overlap += 1;
  const overlapScore = recipeToks.length > 0 ? overlap / recipeToks.length : 0;

  // Recipes never run get a small "pity boost" so they're tried; once they
  // accumulate runs the success rate dominates.
  const evidence = recipe.runCount === 0 ? 0.5 : recipe.successRate;
  const score = evidence * 0.7 + overlapScore * 0.3 - (missing.length * 0.5);

  return { score, missingParameters: missing };
}

/**
 * Return the list of preconditions a recipe must satisfy before it can be
 * selected. Sources, in order:
 *   1. `recipe.preconditions[]` (recipe-level guard, optional)
 *   2. `recipe.steps[0].pre` (the first step's precondition is implicitly
 *      a recipe-level guard — if the first step can't pre-verify, the
 *      recipe doesn't fit the current state).
 */
export function preconditionVerifiers(stored: StoredRecipe): Verifier[] {
  const fromRecipe = stored.recipe.preconditions ?? [];
  const fromFirstStep = stored.recipe.steps[0]?.pre ? [stored.recipe.steps[0].pre] : [];
  return [...fromRecipe, ...fromFirstStep];
}

/**
 * Type-aware parameter compatibility check. A recipe is compatible if every
 * required parameter is bound AND every supplied binding matches the
 * declared type. Returns the missing-required list and a list of type
 * mismatches; either being non-empty disqualifies the recipe.
 */
export function checkParameters(
  recipe: StoredRecipe,
  bindings: Record<string, unknown>,
): { missing: string[]; typeMismatches: string[] } {
  const params = recipe.recipe.parameters ?? {};
  const missing: string[] = [];
  const typeMismatches: string[] = [];
  for (const [name, spec] of Object.entries(params)) {
    const v = bindings[name];
    if (v === undefined) {
      if (spec.required) missing.push(name);
      continue;
    }
    const declared = spec.type;
    const actual = typeof v;
    if (declared === "string" && actual !== "string") typeMismatches.push(`${name}: expected string, got ${actual}`);
    else if (declared === "number" && (actual !== "number" || Number.isNaN(v as number))) typeMismatches.push(`${name}: expected number, got ${actual}`);
    else if (declared === "boolean" && actual !== "boolean") typeMismatches.push(`${name}: expected boolean, got ${actual}`);
  }
  return { missing, typeMismatches };
}

export async function matchRecipe(
  library: SkillLibrary,
  input: MatchInput,
): Promise<MatchResult | undefined> {
  const candidates = await library.list({ status: "approved", surfaceKind: input.surfaceKind });
  let best: MatchResult | undefined;
  for (const r of candidates) {
    const s = scoreMatch(r, input);
    if (!s) continue;
    if (s.missingParameters.length > 0) continue;

    // Precondition gate — required by Task-96 ("matcher must evaluate recipe
    // preconditions against current observation"). When no observation is
    // supplied, we conservatively skip the gate; callers driving the
    // production seam (`routedRecipeOrPlan`) always supply one.
    let preStatus: "pass" | "skipped" = "skipped";
    if (input.observation) {
      const verifiers = preconditionVerifiers(r);
      let allPass = true;
      for (const v of verifiers) {
        const res = evaluateVerifier(v, input.observation);
        if (res.status === "fail") { allPass = false; break; }
        // `unknown` is treated as "do not block" — the executor will
        // re-evaluate post-action with a richer observation.
      }
      if (!allPass) continue;
      preStatus = "pass";
    }

    if (!best || s.score > best.score) {
      best = { recipe: r, score: s.score, missingParameters: s.missingParameters, preconditionStatus: preStatus };
    }
  }
  // Threshold: don't bother with very weak matches — let free-planning run.
  if (best && best.score < 0.2) return undefined;
  return best;
}
