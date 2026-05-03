import type { Surface, ActResult } from "../src/bus";
import type {
  Action,
  LocatorKind,
  Observation,
  ObservationKind,
  SurfaceDescriptor,
  SurfaceKind,
  Verifier,
  VerifierResult,
} from "../src/types";
import { runBench, type SurfaceFactory, type TaskSpec } from "./harness";
import { SUITE_ENTRIES } from "./suite";
import { getStrategy } from "../src/router/strategy-table";
import baseline from "./baseline.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Bench entry-point. Builds one stub Surface per declared surface kind so the
// harness reports per-surface mix matching the 10/10/10 split, then runs the
// full 30-task suite.
// ---------------------------------------------------------------------------

class StubSurface implements Surface {
  readonly descriptor: SurfaceDescriptor;
  // The cheapest tier the production trajectory hit. Anything cheaper is
  // intentionally returned as "no useful content" so the router has to
  // escalate, mirroring the real-world miss for tasks like uia-10 / cv-10.
  constructor(kind: SurfaceKind, expectedCheapest: ObservationKind) {
    const strategy = getStrategy(kind);
    this.descriptor = {
      id: `bench-${kind}`,
      kind,
      label: `bench stub: ${kind}`,
      capabilities: {
        observations: strategy.observationPriority,
        actions: ["Click", "Type", "Key", "Hint", "Wait", "Goto"],
        locators: strategy.locatorPriority,
        cost: { observe: 0, act: 0 },
      },
    };
    this.expected = expectedCheapest;
  }
  private readonly expected: ObservationKind;

  async observe(kinds: ObservationKind[]): Promise<Observation[]> {
    return kinds.map((kind) => makeStubObservation(kind, this.descriptor.id, this.matchesExpected(kind)));
  }

  async act(_action: Action): Promise<ActResult> {
    return { ok: true };
  }

  async verify(verifier: Verifier, observation?: Observation): Promise<VerifierResult> {
    const obs = observation ?? (await this.observe([this.expected]))[0];
    if (verifier.kind === "expectText") {
      const text = obs.kind === "TextDump" || obs.kind === "DomSnapshot" ? (obs.text ?? "") : "";
      return { status: text.includes(verifier.text) ? "pass" : "fail", evidence: text };
    }
    return { status: "pass" };
  }

  // True when the observation kind being asked for is at-or-below the
  // production-traced cheapest tier (i.e., the observation is "useful").
  private matchesExpected(kind: ObservationKind): boolean {
    const order: ObservationKind[] = ["AxTree", "DomSnapshot", "UiaTree", "SomScreenshot", "RawScreenshot", "TextDump"];
    return order.indexOf(kind) >= order.indexOf(this.expected);
  }
}

function makeStubObservation(kind: ObservationKind, surfaceId: string, useful: boolean): Observation {
  const base = { surfaceId, timestamp: Date.now(), digest: `${kind}-${useful ? "ok" : "empty"}` };
  switch (kind) {
    case "AxTree":
      return { ...base, kind: "AxTree", root: useful ? { name: "ok" } : null };
    case "DomSnapshot":
      return {
        ...base, kind: "DomSnapshot",
        text: useful ? "ok" : "",
        elements: useful ? [{ tag: "button", text: "ok" }] : [],
      };
    case "UiaTree":
      return { ...base, kind: "UiaTree", elements: useful ? [{ name: "ok", controlType: "Button" }] : [] };
    case "SomScreenshot":
      return { ...base, kind: "SomScreenshot", imageRef: "stub://img", marks: useful ? [{ mark: "1", rect: { x: 0, y: 0, w: 10, h: 10 } }] : [] };
    case "RawScreenshot":
      return { ...base, kind: "RawScreenshot", imageRef: "stub://img" };
    case "TextDump":
      return { ...base, kind: "TextDump", text: useful ? "ok" : "" };
  }
}

const tasks: TaskSpec[] = SUITE_ENTRIES.map((e) => ({
  id: e.id,
  surfaceKind: e.surfaceKind,
  intent: e.intent,
  steps: Array.from({ length: e.stepCount }).map((_, i) => ({
    action: i === 0 ? { verb: "Goto" as const, url: `bench://${e.id}` } : { verb: "Wait" as const, ms: 1 },
  })),
}));

const factory: SurfaceFactory = (spec) => {
  const entry = SUITE_ENTRIES.find((e) => e.id === spec.id);
  if (!entry) throw new Error(`unknown suite entry: ${spec.id}`);
  return new StubSurface(entry.surfaceKind, entry.expectedCheapestObservation);
};

const report = await runBench(tasks, factory, { budgetPerTaskUsd: 0.5 });

const summary = {
  baseline: { passRate: (baseline as { globals?: { passRate?: number } }).globals?.passRate, totalTasks: (baseline as { totalTasks?: number }).totalTasks },
  observed: {
    totalTasks: report.totalTasks,
    passed: report.passed,
    failed: report.failed,
    perSurface: report.perSurface,
  },
};

console.log(JSON.stringify(summary, null, 2));
