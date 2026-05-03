import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Budget,
  FakeSurface,
  InMemorySkillLibrary,
  Router,
  matchRecipe,
  recipeSource,
  runRecipe,
  withSourceTag,
  type RouterTraceEvent,
  type StoredRecipe,
} from "@rachael/cu-core";

// ---------------------------------------------------------------------------
// Task-96 integration tests — exercise the matcher → executor → fallback
// → promotion pipeline against `FakeSurface` end-to-end. These tests do not
// require a database; they use `InMemorySkillLibrary` to verify that the
// pipeline is shaped correctly. The DB-backed `DbSkillLibrary` is a thin
// adapter over `IStorage` and is exercised by the running server.
// ---------------------------------------------------------------------------

function approvedRecipe(overrides: Partial<StoredRecipe> = {}): StoredRecipe {
  const now = Date.now();
  return {
    id: "rcp-typehello",
    version: 1,
    status: "approved",
    origin: "hand",
    recipe: {
      name: "type-and-submit",
      description: "Type hello then submit on the fake form",
      surfaceKind: "fake",
      parameters: { value: { type: "string", required: true } },
      steps: [
        { action: { verb: "Type", text: "{{value}}" }, post: { kind: "expectText", text: "{{value}}" } },
        { action: { verb: "Click", target: { kind: "hint", key: "submit" } }, post: { kind: "expectText", text: "submitted=true" } },
      ],
    },
    successCount: 0,
    runCount: 0,
    successRate: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("Task-96 SkillLibrary integration", () => {
  let lib: InMemorySkillLibrary;
  let events: RouterTraceEvent[];

  beforeEach(async () => {
    lib = new InMemorySkillLibrary();
    events = [];
  });

  it("matcher rejects a recipe whose precondition fails against the current observation", async () => {
    const guarded = approvedRecipe({
      id: "guarded",
      recipe: {
        ...approvedRecipe().recipe,
        name: "guarded",
        steps: [
          { action: { verb: "Type", text: "x" }, pre: { kind: "expectText", text: "ZZZ-not-on-surface" }, post: { kind: "expectText", text: "x" } },
        ],
      },
    });
    await lib.put(guarded);
    const surface = new FakeSurface();
    const [obs] = await surface.observe(["DomSnapshot"]);

    // Without observation → matcher has no way to gate; should still match.
    const ungated = await matchRecipe(lib, { surfaceKind: "fake", intent: "guarded", parameters: { value: "x" } });
    expect(ungated?.recipe.id).toBe("guarded");
    expect(ungated?.preconditionStatus).toBe("skipped");

    // With observation → precondition fails → matcher must reject.
    const gated = await matchRecipe(lib, { surfaceKind: "fake", intent: "guarded", parameters: { value: "x" }, observation: obs });
    expect(gated).toBeUndefined();
  });

  it("matcher selects an approved recipe over a proposed one", async () => {
    await lib.put(approvedRecipe({ id: "approved-typer", recipe: { ...approvedRecipe().recipe, name: "approved-typer" } }));
    await lib.put(approvedRecipe({
      id: "proposed-typer",
      status: "proposed",
      recipe: { ...approvedRecipe().recipe, name: "proposed-typer" },
    }));

    const match = await matchRecipe(lib, {
      surfaceKind: "fake",
      intent: "type and submit on the form",
      parameters: { value: "hello" },
    });

    expect(match).toBeDefined();
    expect(match!.recipe.id).toBe("approved-typer");
    expect(match!.missingParameters).toHaveLength(0);
  });

  it("matcher refuses recipes whose required parameters aren't bound", async () => {
    await lib.put(approvedRecipe());
    const match = await matchRecipe(lib, {
      surfaceKind: "fake",
      intent: "type and submit",
      parameters: {},
    });
    expect(match).toBeUndefined();
  });

  it("matcher refuses recipes whose bindings don't match the declared parameter types", async () => {
    await lib.put(approvedRecipe());
    const match = await matchRecipe(lib, {
      surfaceKind: "fake",
      intent: "type and submit",
      // value is declared as string but we supply a number → type mismatch
      parameters: { value: 42 },
    });
    expect(match).toBeUndefined();
  });

  it("runs an approved recipe end-to-end and tags every event with recipe:<id>@<v>", async () => {
    const stored = await lib.put(approvedRecipe());
    const source = recipeSource(stored.id, stored.version);
    const router = new Router({
      runId: "run-recipe-ok",
      budget: new Budget(),
      modelRouter: { pickForProfile: () => ({ modelId: "m", estimatedCost: 0, reason: "test" }) },
      emitter: withSourceTag((e) => events.push(e), source),
    });

    const result = await runRecipe(router, new FakeSurface(), stored, {
      parameters: { value: "world" },
      library: lib,
    });

    expect(result.outcome).toBe("ok");
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.metadata?.source).toBe(source);
    }

    const updated = await lib.get(stored.id);
    expect(updated?.runCount).toBe(1);
    expect(updated?.successCount).toBe(1);
    expect(updated?.successRate).toBe(1);
  });

  it("evaluates recipe successCriteria after all steps pass; failed criteria → fallback", async () => {
    const r = approvedRecipe({
      id: "rcp-success-criteria",
      recipe: {
        ...approvedRecipe().recipe,
        name: "rcp-success-criteria",
        successCriteria: [{ kind: "expectText", text: "ZZZ-impossible-banner" }],
      },
    });
    await lib.put(r);
    const router = new Router({
      runId: "run-criteria",
      budget: new Budget(),
      modelRouter: { pickForProfile: () => ({ modelId: "m", estimatedCost: 0, reason: "test" }) },
      emitter: withSourceTag((e) => events.push(e), recipeSource(r.id, r.version)),
    });
    const result = await runRecipe(router, new FakeSurface(), r, {
      parameters: { value: "world" },
      library: lib,
    });
    expect(result.outcome).toBe("fallback");
    expect(result.reason).toMatch(/successCriteria/);
    const updated = await lib.get(r.id);
    expect(updated?.successCount).toBe(0);
    expect(updated?.runCount).toBe(1);
  });

  it("returns outcome=fallback (with failed step index) when a verifier fails mid-recipe", async () => {
    const broken = approvedRecipe({
      id: "rcp-broken",
      recipe: {
        name: "broken-recipe",
        surfaceKind: "fake",
        parameters: { value: { type: "string", required: true } },
        steps: [
          { action: { verb: "Type", text: "{{value}}" }, post: { kind: "expectText", text: "{{value}}" } },
          // Step 1's post-verifier requires text the surface will never have.
          { action: { verb: "Wait", ms: 1 }, post: { kind: "expectText", text: "ZZZ-impossible-marker" } },
        ],
      },
    });
    await lib.put(broken);

    const router = new Router({
      runId: "run-recipe-fallback",
      budget: new Budget(),
      modelRouter: { pickForProfile: () => ({ modelId: "m", estimatedCost: 0, reason: "test" }) },
      emitter: withSourceTag((e) => events.push(e), recipeSource(broken.id, broken.version)),
    });

    const result = await runRecipe(router, new FakeSurface(), broken, {
      parameters: { value: "hi" },
      library: lib,
    });

    expect(result.outcome).toBe("fallback");
    expect(result.failedAtStepIndex).toBe(1);
    expect(result.stepResults).toHaveLength(2);
    expect(result.stepResults[0].ok).toBe(true);
    expect(result.stepResults[1].ok).toBe(false);

    const updated = await lib.get(broken.id);
    expect(updated?.runCount).toBe(1);
    expect(updated?.successCount).toBe(0);
    expect(updated?.successRate).toBe(0);
  });

  it("act traces carry the full action payload so promotion can recover replayable steps", async () => {
    const { extractStepsFromTrace } = await import("@rachael/cu-core");
    const router = new Router({
      runId: "run-promo",
      budget: new Budget(),
      modelRouter: { pickForProfile: () => ({ modelId: "m", estimatedCost: 0, reason: "test" }) },
      emitter: (e) => events.push(e),
    });
    const surface = new FakeSurface();
    await router.step(surface, {
      action: { verb: "Type", text: "promote-me" },
      post: { kind: "expectText", text: "promote-me" },
    });
    await router.step(surface, {
      action: { verb: "Click", target: { kind: "hint", key: "submit" } },
      post: { kind: "expectText", text: "submitted=true" },
    });

    const steps = extractStepsFromTrace(events);
    expect(steps.length).toBe(2);
    expect(steps[0].action.verb).toBe("Type");
    expect((steps[0].action as { text: string }).text).toBe("promote-me");
    expect(steps[1].action.verb).toBe("Click");
  });
});
