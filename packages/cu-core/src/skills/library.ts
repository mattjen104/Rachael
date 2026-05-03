import type {
  RecipeRunRecord,
  RecipeStatus,
  SkillLibrary,
  SkillLibraryQuery,
  StoredRecipe,
} from "./types";

// ---------------------------------------------------------------------------
// In-memory SkillLibrary — used by tests, bench harness, and as the default
// fallback when no host-backed library is wired. The host (`server/skill-
// library.ts`) provides a Drizzle-backed implementation that mirrors the
// same interface against the `cu_recipes` / `cu_recipe_runs` tables.
// ---------------------------------------------------------------------------

export class InMemorySkillLibrary implements SkillLibrary {
  private recipes = new Map<string, StoredRecipe>();
  private runs: RecipeRunRecord[] = [];

  async list(query: SkillLibraryQuery = {}): Promise<StoredRecipe[]> {
    const want = query.status
      ? new Set(Array.isArray(query.status) ? query.status : [query.status])
      : undefined;
    const intentLower = query.intent?.toLowerCase();
    const out: StoredRecipe[] = [];
    for (const r of Array.from(this.recipes.values())) {
      if (want && !want.has(r.status)) continue;
      if (query.surfaceKind && r.recipe.surfaceKind !== query.surfaceKind) continue;
      if (intentLower) {
        const hay = `${r.recipe.name} ${r.recipe.description ?? ""}`.toLowerCase();
        if (!hay.includes(intentLower)) continue;
      }
      out.push(r);
    }
    return out.sort((a, b) => b.successRate - a.successRate || b.runCount - a.runCount);
  }

  async get(id: string): Promise<StoredRecipe | undefined> {
    return this.recipes.get(id);
  }

  async put(stored: StoredRecipe): Promise<StoredRecipe> {
    this.recipes.set(stored.id, stored);
    return stored;
  }

  async setStatus(id: string, status: RecipeStatus): Promise<StoredRecipe | undefined> {
    const cur = this.recipes.get(id);
    if (!cur) return undefined;
    const next = { ...cur, status, updatedAt: Date.now() };
    this.recipes.set(id, next);
    return next;
  }

  async recordRun(record: RecipeRunRecord): Promise<void> {
    this.runs.push(record);
    const cur = this.recipes.get(record.recipeId);
    if (!cur) return;
    const runCount = cur.runCount + 1;
    const successCount = cur.successCount + (record.outcome === "ok" ? 1 : 0);
    const successRate = successCount / runCount;
    this.recipes.set(record.recipeId, {
      ...cur,
      runCount,
      successCount,
      successRate,
      lastUsedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  /** Test-only — inspect collected run records. */
  getRuns(): RecipeRunRecord[] {
    return [...this.runs];
  }
}
