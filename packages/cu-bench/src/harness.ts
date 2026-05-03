// Bench harness — task spec → run → score → report.
//
// Self-contained inside @rachael/cu-bench so the published tarball does
// not depend on cu-core source paths. Public types come from the
// @rachael/cu-core peer dependency.

import {
  Budget,
  InMemoryTraceSink,
  Router,
  type Surface,
  type Action,
  type ObservationKind,
  type SurfaceKind,
  type Verifier,
  type RouterStepInput,
} from "@rachael/cu-core";

export interface TaskSpec {
  id: string;
  surfaceKind: SurfaceKind;
  intent: string;
  steps: RouterStepInput[];
  successCriterion?: Verifier;
}

export interface TaskRunResult {
  taskId: string;
  surfaceKind: SurfaceKind;
  ok: boolean;
  wallMs: number;
  steps: number;
  observationsByTier: Partial<Record<ObservationKind, number>>;
  coordClicks: number;
  estimatedCostUsd: number;
  tierMisses: number;
  fallbackChain: ObservationKind[];
  error?: string;
}

export interface BenchReport {
  startedAt: number;
  finishedAt: number;
  totalTasks: number;
  passed: number;
  failed: number;
  perSurface: Record<string, SurfaceSummary>;
  results: TaskRunResult[];
}

export interface SurfaceSummary {
  surfaceKind: SurfaceKind;
  tasks: number;
  passed: number;
  meanWallMs: number;
  medianWallMs: number;
  meanCostUsd: number;
  observationHits: Partial<Record<ObservationKind, number>>;
  coordClicks: number;
  tierMissRate: number;
}

export type SurfaceFactory = (spec: TaskSpec) => Promise<Surface> | Surface;

export async function runBench(
  tasks: TaskSpec[],
  factory: SurfaceFactory,
  opts: { budgetPerTaskUsd?: number } = {},
): Promise<BenchReport> {
  const startedAt = Date.now();
  const results: TaskRunResult[] = [];

  for (const spec of tasks) {
    const surface = await factory(spec);
    const sink = new InMemoryTraceSink();
    const budget = new Budget({ maxModelSpendUsd: opts.budgetPerTaskUsd ?? 0.5 });
    const router = new Router({ runId: `bench-${spec.id}`, budget, emitter: sink.emit });

    const start = Date.now();
    let ok = true;
    let error: string | undefined;
    const observationsByTier: Partial<Record<ObservationKind, number>> = {};
    const fallbackChain: ObservationKind[] = [];
    let tierMisses = 0;
    let coordClicks = 0;

    for (const step of spec.steps) {
      const r = await router.step(surface, step);
      observationsByTier[r.observationKind] = (observationsByTier[r.observationKind] ?? 0) + 1;
      fallbackChain.push(...r.fallbackChain);
      if (r.attemptedLocator === "coords") coordClicks += 1;
      if (r.tierMiss) tierMisses += 1;
      if (!r.ok) {
        ok = false;
        error = r.abortReason ?? "step failed";
        break;
      }
    }

    if (ok && spec.successCriterion) {
      try {
        const obs = (await surface.observe([fallbackChain[fallbackChain.length - 1] ?? "TextDump"]))[0];
        const verdict = await surface.verify(spec.successCriterion, obs);
        if (verdict.status !== "pass") {
          ok = false;
          error = `success criterion: ${verdict.status} (${verdict.evidence ?? ""})`;
        }
      } catch (e) {
        ok = false;
        error = `success criterion threw: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    results.push({
      taskId: spec.id,
      surfaceKind: spec.surfaceKind,
      ok,
      wallMs: Date.now() - start,
      steps: spec.steps.length,
      observationsByTier,
      coordClicks,
      estimatedCostUsd: budget.usage.modelSpendUsd,
      tierMisses,
      fallbackChain,
      error,
    });

    if (surface.dispose) await surface.dispose();
  }

  return summarize(results, startedAt);
}

function summarize(results: TaskRunResult[], startedAt: number): BenchReport {
  const perSurface: Record<string, SurfaceSummary> = {};
  for (const r of results) {
    const key = r.surfaceKind;
    const s = (perSurface[key] ??= {
      surfaceKind: r.surfaceKind,
      tasks: 0,
      passed: 0,
      meanWallMs: 0,
      medianWallMs: 0,
      meanCostUsd: 0,
      observationHits: {},
      coordClicks: 0,
      tierMissRate: 0,
    });
    s.tasks += 1;
    if (r.ok) s.passed += 1;
    s.coordClicks += r.coordClicks;
    for (const [k, v] of Object.entries(r.observationsByTier)) {
      s.observationHits[k as ObservationKind] = (s.observationHits[k as ObservationKind] ?? 0) + (v ?? 0);
    }
  }
  for (const key of Object.keys(perSurface)) {
    const sub = results.filter((r) => r.surfaceKind === (key as SurfaceKind));
    const wall = sub.map((r) => r.wallMs).sort((a, b) => a - b);
    const cost = sub.map((r) => r.estimatedCostUsd);
    const misses = sub.filter((r) => r.tierMisses > 0).length;
    perSurface[key].meanWallMs = avg(wall);
    perSurface[key].medianWallMs = median(wall);
    perSurface[key].meanCostUsd = avg(cost);
    perSurface[key].tierMissRate = sub.length > 0 ? misses / sub.length : 0;
  }
  return {
    startedAt,
    finishedAt: Date.now(),
    totalTasks: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    perSurface,
    results,
  };
}

function avg(xs: number[]): number { return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length; }
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[m - 1] + xs[m]) / 2 : xs[m];
}

export function makeAction(verb: Action["verb"], extra: Record<string, unknown> = {}): Action {
  return { verb, ...extra } as Action;
}
