# `@rachael/cu-skills`

Skill library, recipe matcher, executor, and promotion pipeline for
[`@rachael/cu-core`](../cu-core).

## What's a skill?

A skill is a **`Recipe`** — a named, replayable sequence of
`(pre?, action, post?)` triples — packaged with a matcher that decides
*when* to use it and provenance that records *where it came from*.

```ts
type Recipe = {
  name: string;
  surfaces: SurfaceKind[];
  parameters: ParamSpec[];
  steps: Array<{ pre?: Verifier; action: Action; post?: Verifier }>;
  successCriterion: Verifier;
  provenance: { source: "human" | "trajectory" | "free-plan"; trajectoryId?: string };
};
```

## The promotion pipeline

```
trajectory ──summarizer──▶ ProposedRecipe ──gate──▶ Library
                                              │
                                              └──verifier checks + de-dup
```

- **`InMemorySkillLibrary`** — in-memory store; bring your own persistent
  store by implementing the same interface.
- **`matchRecipe` / `scoreMatch`** — deterministic match score over
  surface kind, parameter shape, and verifier compatibility.
- **`runRecipe`** — executes a recipe step-by-step against a surface,
  with parameter binding and per-step verifier checks.
- **`buildProposedRecipe` / `extractStepsFromTrace` /
  `heuristicSummarizer`** — promote a successful router trace into a
  proposed recipe, ready for human review.
- **`SEED_RECIPES`** — a tiny library of built-in recipes (login,
  search, table-row-action) you can use as templates.

## Install

```bash
npm install @rachael/cu-core @rachael/cu-skills zod
```

## Hello, skill

```bash
npx tsx packages/cu-skills/examples/hello-skill.ts
```

```ts
import { ComputerUseBus, FakeSurface } from "@rachael/cu-core";
import { InMemorySkillLibrary, runRecipe, SEED_RECIPES } from "@rachael/cu-skills";

const bus = new ComputerUseBus();
const surface = new FakeSurface();
bus.registerSurface(surface);

const library = new InMemorySkillLibrary();
for (const r of SEED_RECIPES) library.add(r);

const recipe = library.findByName("noop-smoke")!;
const result = await runRecipe(recipe, surface, { params: {} });
console.log(`recipe ok=${result.ok}`);
```

## Stable v0.x contract

- `Recipe`, `ProposedRecipe`, `MatchResult`, `RecipeExecutionResult`
  shapes.
- `runRecipe` semantics: every step's pre/post verifier is checked, and
  any non-pass aborts the recipe.
- `InMemorySkillLibrary` interface — implementable for SQLite, Postgres,
  Qdrant, etc.
- `withSourceTag`, `withFreePlanSource` provenance helpers.

## Non-goals

See [`NON_GOALS.md`](./NON_GOALS.md). Briefly: no automatic skill
ranking by reward signal, no cross-org skill registry, no LLM-required
matcher, no UI.
