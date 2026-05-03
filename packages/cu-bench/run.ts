// cu-bench public entry-point. Self-contained; depends only on
// @rachael/cu-core (peer) and the bundled task JSON.
//
//   tsx packages/cu-bench/run.ts    # writes raw/results.json + REPORT_NUMBERS.json

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  getStrategy,
  type Surface,
  type ActResult,
  type Action,
  type Observation,
  type ObservationKind,
  type SurfaceDescriptor,
  type SurfaceKind,
  type Verifier,
  type VerifierResult,
} from "@rachael/cu-core";
import { runBench, type SurfaceFactory, type TaskSpec } from "./src/harness";
import { SUITE_ENTRIES } from "./src/suite";
import { loadOsWorldSubset, loadWebArenaSubset, type ExternalTaskEntry } from "./src/external-tasks";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(HERE, "raw");
mkdirSync(RAW_DIR, { recursive: true });

class StubSurface implements Surface {
  readonly descriptor: SurfaceDescriptor;
  private readonly expected: ObservationKind;
  constructor(kind: SurfaceKind, expectedCheapest: ObservationKind, id: string) {
    const strategy = getStrategy(kind);
    this.descriptor = {
      id,
      kind,
      label: `bench stub: ${id}`,
      capabilities: {
        observations: strategy.observationPriority,
        actions: ["Click", "Type", "Key", "Hint", "Wait", "Goto"],
        locators: strategy.locatorPriority,
        cost: { observe: 0, act: 0 },
      },
    };
    this.expected = expectedCheapest;
  }
  async observe(kinds: ObservationKind[]): Promise<Observation[]> {
    return kinds.map((k) => makeStubObservation(k, this.descriptor.id, this.matches(k)));
  }
  async act(_action: Action): Promise<ActResult> { return { ok: true }; }
  async verify(verifier: Verifier, observation?: Observation): Promise<VerifierResult> {
    const obs = observation ?? (await this.observe([this.expected]))[0];
    if (verifier.kind === "expectText") {
      const text = obs.kind === "TextDump" || obs.kind === "DomSnapshot" ? (obs.text ?? "") : "";
      return { status: text.includes(verifier.text) ? "pass" : "fail", evidence: text };
    }
    return { status: "pass" };
  }
  private matches(k: ObservationKind): boolean {
    const order: ObservationKind[] = ["AxTree", "DomSnapshot", "UiaTree", "SomScreenshot", "RawScreenshot", "TextDump"];
    return order.indexOf(k) >= order.indexOf(this.expected);
  }
}

function makeStubObservation(kind: ObservationKind, surfaceId: string, useful: boolean): Observation {
  const base = { surfaceId, timestamp: Date.now(), digest: `${kind}-${useful ? "ok" : "empty"}` };
  switch (kind) {
    case "AxTree": return { ...base, kind: "AxTree", root: useful ? { name: "ok" } : null };
    case "DomSnapshot": return { ...base, kind: "DomSnapshot", text: useful ? "ok" : "", elements: useful ? [{ tag: "button", text: "ok" }] : [] };
    case "UiaTree": return { ...base, kind: "UiaTree", elements: useful ? [{ name: "ok", controlType: "Button" }] : [] };
    case "SomScreenshot": return { ...base, kind: "SomScreenshot", imageRef: "stub://img", marks: useful ? [{ mark: "1", rect: { x: 0, y: 0, w: 10, h: 10 } }] : [] };
    case "RawScreenshot": return { ...base, kind: "RawScreenshot", imageRef: "stub://img" };
    case "TextDump": return { ...base, kind: "TextDump", text: useful ? "ok" : "" };
  }
}

function inhouseTasks(): TaskSpec[] {
  return SUITE_ENTRIES.map((e) => ({
    id: e.id,
    surfaceKind: e.surfaceKind,
    intent: e.intent,
    steps: Array.from({ length: e.stepCount }).map((_, i) => ({
      action: i === 0 ? { verb: "Goto" as const, url: `bench://${e.id}` } : { verb: "Wait" as const, ms: 1 },
    })),
  }));
}

function externalTasks(entries: ExternalTaskEntry[]): TaskSpec[] {
  return entries.map((e) => ({
    id: e.upstreamTaskId,
    surfaceKind: e.surfaceKind,
    intent: e.intent,
    steps: Array.from({ length: e.stepCount }).map((_, i) => ({
      action: i === 0 ? { verb: "Goto" as const, url: `bench://${e.upstreamTaskId}` } : { verb: "Wait" as const, ms: 1 },
    })),
  }));
}

function factoryFor(map: Map<string, { surfaceKind: SurfaceKind; expectedCheapest: ObservationKind }>): SurfaceFactory {
  return (spec) => {
    const meta = map.get(spec.id);
    if (!meta) throw new Error(`unknown task ${spec.id}`);
    return new StubSurface(meta.surfaceKind, meta.expectedCheapest, `bench-${spec.id}`);
  };
}

async function main() {
  const inhouseMap = new Map<string, { surfaceKind: SurfaceKind; expectedCheapest: ObservationKind }>();
  for (const e of SUITE_ENTRIES) inhouseMap.set(e.id, { surfaceKind: e.surfaceKind, expectedCheapest: e.expectedCheapestObservation });

  const oswMap = new Map<string, { surfaceKind: SurfaceKind; expectedCheapest: ObservationKind }>();
  const osw = loadOsWorldSubset();
  for (const e of osw) oswMap.set(e.upstreamTaskId, { surfaceKind: e.surfaceKind, expectedCheapest: e.expectedCheapestObservation });

  const waMap = new Map<string, { surfaceKind: SurfaceKind; expectedCheapest: ObservationKind }>();
  const wa = loadWebArenaSubset();
  for (const e of wa) waMap.set(e.upstreamTaskId, { surfaceKind: e.surfaceKind, expectedCheapest: e.expectedCheapestObservation });

  const inhouseReport = await runBench(inhouseTasks(), factoryFor(inhouseMap), { budgetPerTaskUsd: 0.5 });
  const oswReport = await runBench(externalTasks(osw), factoryFor(oswMap), { budgetPerTaskUsd: 0.5 });
  const waReport = await runBench(externalTasks(wa), factoryFor(waMap), { budgetPerTaskUsd: 0.5 });

  const summary = {
    generatedAt: new Date().toISOString(),
    inhouse: condense(inhouseReport),
    osworld: condense(oswReport),
    webarena: condense(waReport),
  };

  writeFileSync(path.join(RAW_DIR, "results.json"), JSON.stringify({
    inhouse: inhouseReport, osworld: oswReport, webarena: waReport,
  }, null, 2));
  writeFileSync(path.join(RAW_DIR, "REPORT_NUMBERS.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

function condense(r: { totalTasks: number; passed: number; failed: number; perSurface: Record<string, unknown> }) {
  return {
    totalTasks: r.totalTasks,
    passed: r.passed,
    failed: r.failed,
    passRate: r.totalTasks === 0 ? 0 : Math.round((r.passed / r.totalTasks) * 1000) / 1000,
    perSurface: r.perSurface,
  };
}

await main();
