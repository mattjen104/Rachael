// @rachael/cu-skills — recipe library + matcher + executor + promotion.
//
// Re-exports the skill primitives from @rachael/cu-core. The split lands
// in v1.x.

export {
  InMemorySkillLibrary,
  matchRecipe,
  scoreMatch,
  runRecipe,
  withSourceTag,
  withFreePlanSource,
  buildProposedRecipe,
  extractStepsFromTrace,
  heuristicSummarizer,
  SEED_RECIPES,
} from "@rachael/cu-core";
export type {
  MatchInput,
  MatchResult,
  RecipeExecutionResult,
  RunRecipeOptions,
  RecipeSummarizer,
  TrajectorySummary,
  BuildProposedOptions,
} from "@rachael/cu-core";
