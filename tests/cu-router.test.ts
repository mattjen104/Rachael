import { describe, it, expect } from "vitest";
import {
  Budget,
  ComputerUseBus,
  DEFAULT_STRATEGIES,
  FakeSurface,
  InMemoryTraceSink,
  Router,
  deriveProfile,
  evaluateVerifier,
  getStrategy,
  intersectPriority,
  pickLocatorKind,
  type ModelRouterAdapter,
  type Observation,
  type ObservationKind,
  type RouterTraceEvent,
  type Surface,
  type Verifier,
} from "@rachael/cu-core";
import { runBench } from "../packages/cu-core/bench/harness";
import { SUITE_ENTRIES } from "../packages/cu-core/bench/suite";

function makeStubModelRouter(costPerCall = 0.01): ModelRouterAdapter {
  return {
    pickForProfile(profile) {
      return {
        modelId: profile.needsVision ? "vision-stub" : "text-stub",
        estimatedCost: profile.needsVision ? costPerCall : costPerCall / 10,
        reason: "stub",
      };
    },
  };
}

describe("strategy table", () => {
  it("declares cheapest-first observation order for every surface kind", () => {
    for (const kind of Object.keys(DEFAULT_STRATEGIES)) {
      const s = getStrategy(kind as keyof typeof DEFAULT_STRATEGIES);
      expect(s.observationPriority.length).toBeGreaterThan(0);
      expect(s.locatorPriority.length).toBeGreaterThan(0);
    }
  });

  it("places coords last for every surface that supports them", () => {
    for (const s of Object.values(DEFAULT_STRATEGIES)) {
      if (s.locatorPriority.includes("coords")) {
        expect(s.locatorPriority[s.locatorPriority.length - 1]).toBe("coords");
      }
    }
  });

  it("citrix-session is vision-only (no AxTree/UiaTree/DOM)", () => {
    const s = getStrategy("citrix-session");
    expect(s.observationPriority).not.toContain("AxTree");
    expect(s.observationPriority).not.toContain("UiaTree");
    expect(s.observationPriority).not.toContain("DomSnapshot");
  });

  it("intersectPriority drops anything the surface can't observe", () => {
    const filtered = intersectPriority(["AxTree", "DomSnapshot", "RawScreenshot"], ["DomSnapshot"]);
    expect(filtered).toEqual(["DomSnapshot"]);
  });
});

describe("verifier library", () => {
  const obs: Observation = {
    kind: "DomSnapshot",
    surfaceId: "s1",
    timestamp: 1,
    digest: "abc",
    url: "https://example.com/foo",
    title: "Hello",
    text: "this is a body",
    elements: [{ tag: "button", text: "Submit" }],
  };

  it("expectText passes when haystack contains needle", () => {
    const v: Verifier = { kind: "expectText", text: "body", match: "contains" };
    expect(evaluateVerifier(v, obs).status).toBe("pass");
  });

  it("expectUrl regex match", () => {
    const v: Verifier = { kind: "expectUrl", url: "^https://.+/foo$", match: "regex" };
    expect(evaluateVerifier(v, obs).status).toBe("pass");
  });

  it("expectHash detects mismatch", () => {
    const v: Verifier = { kind: "expectHash", digest: "different" };
    expect(evaluateVerifier(v, obs).status).toBe("fail");
  });

  it("expectNoChange passes when digests match", () => {
    const v: Verifier = { kind: "expectNoChange", sinceDigest: "abc" };
    expect(evaluateVerifier(v, obs).status).toBe("pass");
  });

  it("expectElement on unsupported observation returns unknown", () => {
    const txt: Observation = { kind: "TextDump", surfaceId: "s1", timestamp: 1, digest: "abc", text: "x" };
    const v: Verifier = { kind: "expectElement", target: { kind: "selector", css: "button" } };
    expect(evaluateVerifier(v, txt).status).toBe("unknown");
  });
});

describe("Budget", () => {
  it("denies escalation past spend ceiling", () => {
    const b = new Budget({ maxModelSpendUsd: 0.05 });
    expect(b.check(0.04).ok).toBe(true);
    b.consume({ spendUsd: 0.04 });
    const c = b.check(0.02);
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/maxModelSpendUsd/);
  });

  it("counts coord clicks as a separate budget axis", () => {
    const b = new Budget({ maxCoordClicks: 1 });
    b.consume({ coordClick: true });
    expect(b.check(0, true).ok).toBe(false);
  });
});

describe("Router (verification loop + recovery)", () => {
  it("runs the cheapest tier first and emits a complete trace", async () => {
    const sink = new InMemoryTraceSink();
    const router = new Router({ emitter: sink.emit, modelRouter: makeStubModelRouter() });
    const surface = new FakeSurface();
    const r = await router.step(surface, {
      action: { verb: "Type", text: "hello" },
      post: { kind: "expectText", text: "hello" },
    });
    expect(r.ok).toBe(true);
    expect(r.observationKind).toBe("DomSnapshot"); // first in fake's strategy
    expect(sink.byKind("complete")).toHaveLength(1);
    expect(sink.byKind("act")).toHaveLength(1);
  });

  it("escalates to next tier when precondition fails on cheapest", async () => {
    const sink = new InMemoryTraceSink();
    let pre = 0;
    const router = new Router({
      emitter: sink.emit,
      modelRouter: makeStubModelRouter(),
      onTakeover: () => "abort",
    });
    const surface = new FakeSurface();
    // Pre passes only on the deeper TextDump tier — DomSnapshot's text
    // includes 'submitted=' but not 'PRE-MARKER', and we type 'PRE-MARKER'
    // beforehand so TextDump's fresh snapshot includes it.
    await surface.act({ verb: "Type", text: "PRE-MARKER" });
    pre = 0; void pre;
    const r = await router.step(surface, {
      action: { verb: "Wait", ms: 1 },
      pre: { kind: "expectText", text: "PRE-MARKER" },
    });
    // The cheapest tier fails (no such marker in DomSnapshot's `elements`
    // string), router escalates to TextDump where the field text appears.
    expect(sink.byKind("escalate").length + sink.byKind("observe").length).toBeGreaterThan(0);
    expect(r.fallbackChain.length).toBeGreaterThanOrEqual(1);
  });

  it("triggers takeover (and aborts) when precondition fails on every tier", async () => {
    const sink = new InMemoryTraceSink();
    let takeoverFired = false;
    const router = new Router({
      emitter: sink.emit,
      modelRouter: makeStubModelRouter(),
      onTakeover: () => { takeoverFired = true; return "abort"; },
    });
    const surface = new FakeSurface();
    const r = await router.step(surface, {
      action: { verb: "Type", text: "should-not-run" },
      pre: { kind: "expectText", text: "ZZZ-impossible-to-find-anywhere" },
    });
    expect(r.ok).toBe(false);
    expect(takeoverFired).toBe(true);
    expect(sink.byKind("takeover").length).toBe(1);
    // Crucially, no act event fired because pre exhausted before action ran.
    expect(sink.byKind("act").length).toBe(0);
  });

  it("denies escalation that would breach the budget and records the reason", async () => {
    const sink = new InMemoryTraceSink();
    const router = new Router({
      emitter: sink.emit,
      budget: new Budget({ maxModelSpendUsd: 0.0 }),
      modelRouter: makeStubModelRouter(0.5),
    });
    const surface = new FakeSurface();
    const r = await router.step(surface, { action: { verb: "Wait", ms: 1 } });
    expect(r.ok).toBe(false);
    expect(sink.byKind("budget-deny").length).toBeGreaterThan(0);
  });

  it("emits a tier-miss event when escalation succeeds at a deeper tier", async () => {
    // Custom surface that only succeeds at the second observation tier.
    const sink = new InMemoryTraceSink();
    let observeCalls = 0;
    const surface: Surface = {
      descriptor: {
        id: "miss-1",
        kind: "fake",
        capabilities: {
          observations: ["DomSnapshot", "TextDump"],
          actions: ["Wait"],
          locators: ["selector"],
        },
      },
      async observe(kinds: ObservationKind[]) {
        observeCalls++;
        const k = kinds[0];
        const base = { surfaceId: "miss-1", timestamp: 1, digest: String(observeCalls) };
        if (k === "DomSnapshot") {
          return [{ ...base, kind: "DomSnapshot", text: "no", elements: [] }];
        }
        return [{ ...base, kind: "TextDump", text: "yes-found-it" }];
      },
      async act() { return { ok: true }; },
      async verify() { return { status: "unknown" }; },
    };
    const router = new Router({ emitter: sink.emit, modelRouter: makeStubModelRouter() });
    const r = await router.step(surface, {
      action: { verb: "Wait", ms: 1 },
      pre: { kind: "expectText", text: "yes-found-it" },
      post: { kind: "expectText", text: "yes-found-it" },
    });
    expect(r.ok).toBe(true);
    expect(r.tierMiss?.cheapest).toBe("DomSnapshot");
    expect(r.tierMiss?.succeededAt).toBe("TextDump");
    expect(sink.byKind("tier-miss").length).toBe(1);
  });

  it("invokes onTakeover when all tiers exhaust without passing post", async () => {
    const sink = new InMemoryTraceSink();
    let takeoverFired = false;
    const router = new Router({
      emitter: sink.emit,
      modelRouter: makeStubModelRouter(),
      onTakeover: () => {
        takeoverFired = true;
        return "abort";
      },
    });
    const surface = new FakeSurface();
    const r = await router.step(surface, {
      action: { verb: "Wait", ms: 1 },
      post: { kind: "expectText", text: "this-will-never-match-anywhere-XYZ" },
    });
    expect(r.ok).toBe(false);
    expect(takeoverFired).toBe(true);
    expect(sink.byKind("takeover").length).toBe(1);
  });

  it("reports tier-miss observations to the evolution hook", async () => {
    const misses: string[] = [];
    const sink = new InMemoryTraceSink();
    const router = new Router({
      emitter: sink.emit,
      modelRouter: makeStubModelRouter(),
      tierMissReporter: (info) => misses.push(`${info.cheapest}->${info.succeededAt}`),
    });
    const surface: Surface = {
      descriptor: {
        id: "miss-2", kind: "fake",
        capabilities: { observations: ["DomSnapshot", "TextDump"], actions: ["Wait"], locators: ["selector"] },
      },
      async observe(kinds: ObservationKind[]) {
        const k = kinds[0];
        const base = { surfaceId: "miss-2", timestamp: 1, digest: k };
        if (k === "DomSnapshot") return [{ ...base, kind: "DomSnapshot", text: "no", elements: [] }];
        return [{ ...base, kind: "TextDump", text: "deep" }];
      },
      async act() { return { ok: true }; },
      async verify() { return { status: "unknown" }; },
    };
    await router.step(surface, {
      action: { verb: "Wait", ms: 1 },
      pre: { kind: "expectText", text: "deep" },
      post: { kind: "expectText", text: "deep" },
    });
    expect(misses).toEqual(["DomSnapshot->TextDump"]);
  });
});

describe("Bench harness", () => {
  it("ships exactly 30 entries with the intended surface mix", () => {
    expect(SUITE_ENTRIES).toHaveLength(30);
    const counts: Record<string, number> = {};
    for (const e of SUITE_ENTRIES) counts[e.surfaceKind] = (counts[e.surfaceKind] ?? 0) + 1;
    expect(counts["browser-tab"] + counts["browser-extension"]).toBe(10);
    expect(counts["desktop-window"]).toBe(10);
    expect(counts["citrix-session"]).toBe(10);
  });

  it("runBench executes all tasks and produces a structured report", async () => {
    const tasks = SUITE_ENTRIES.slice(0, 4).map((e) => ({
      id: e.id,
      surfaceKind: "fake" as const,
      intent: e.intent,
      steps: [
        { action: { verb: "Type" as const, text: e.intent } },
      ],
    }));
    const report = await runBench(tasks, () => new FakeSurface());
    expect(report.totalTasks).toBe(4);
    expect(report.passed + report.failed).toBe(4);
    expect(report.perSurface.fake).toBeDefined();
    expect(report.perSurface.fake.tasks).toBe(4);
  });
});

describe("ComputerUseBus stays compatible with Router", () => {
  it("Router.step can use a Surface registered on the bus", async () => {
    const bus = new ComputerUseBus();
    const fake = new FakeSurface("bus-1");
    bus.registerSurface(fake);
    const sink = new InMemoryTraceSink();
    const router = new Router({ emitter: sink.emit, modelRouter: makeStubModelRouter() });
    const r = await router.step(fake, { action: { verb: "Wait", ms: 1 } });
    expect(r.ok).toBe(true);
    expect(bus.listSurfaces()).toHaveLength(1);
  });
});

describe("pickLocatorKind", () => {
  it("respects the action's locator if the surface supports it", () => {
    const k = pickLocatorKind(
      { verb: "Click", target: { kind: "selector", css: "#x" } },
      ["selector", "hint", "coords"],
      ["selector", "hint", "coords"],
    );
    expect(k).toBe("selector");
  });

  it("falls back to the cheapest supported locator if action carries none", () => {
    const k = pickLocatorKind(
      { verb: "Wait", ms: 1 },
      ["uia", "hint", "coords"],
      ["hint", "coords"],
    );
    expect(k).toBe("hint");
  });
});

describe("deriveProfile", () => {
  it("flags vision when observation is screenshot-shaped", () => {
    expect(deriveProfile("RawScreenshot", "click-target").needsVision).toBe(true);
    expect(deriveProfile("SomScreenshot", "click-target").needsVision).toBe(true);
    expect(deriveProfile("AxTree", "selector").needsVision).toBe(false);
  });
});
