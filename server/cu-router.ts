import {
  pickModelForProfile,
  type CuModelChoice,
  type CuTaskProfile,
} from "./model-router";
import { emitEvent } from "./event-bus";
import { storage } from "./storage";
import type {
  ModelChoice,
  ModelRouterAdapter,
  RouterTraceEvent,
  SurfaceKind,
  TaskProfile,
  TierMissInfo,
} from "@rachael/cu-core";

// ---------------------------------------------------------------------------
// Server-side glue for the cu-core Router. Exposes:
//   - `serverModelRouter`: wraps `pickModelForProfile` so the cu-core router
//     can use the live roster.
//   - `routerTraceEmitter`: forwards every RouterTrace into the cockpit
//     event bus AND persists the per-run trace into the `router_traces`
//     table on `complete`/`abort` so the analyst inspector can replay it.
//   - `tierMissReporter`: feeds "observation-tier miss" observations into
//     the evolution engine via the existing observations table.
// ---------------------------------------------------------------------------

export const serverModelRouter: ModelRouterAdapter = {
  pickForProfile(profile: TaskProfile): ModelChoice {
    const choice: CuModelChoice = pickModelForProfile(profile as CuTaskProfile);
    return { modelId: choice.modelId, estimatedCost: choice.estimatedCost, reason: choice.reason };
  },
};

const MAX_TRACE_EVENTS_PER_RUN = 500;

interface RunBuffer {
  events: RouterTraceEvent[];
  totalSteps: number;
  tierMisses: number;
  coordClicks: number;
  estimatedCostUsd: number;
  surfaceKind: SurfaceKind;
  programName?: string;
}

interface BufferedRun { buf: RunBuffer; touchedAt: number; finalized: boolean }
const traceBuffers = new Map<string, BufferedRun>();
const RUN_BUFFER_TTL_MS = 10 * 60 * 1000; // evict 10 min after terminal event
const MAX_BUFFERED_RUNS = 256;

function sweepTraceBuffers(now = Date.now()): void {
  for (const [runId, entry] of Array.from(traceBuffers.entries())) {
    if (entry.finalized && now - entry.touchedAt > RUN_BUFFER_TTL_MS) {
      traceBuffers.delete(runId);
    }
  }
  if (traceBuffers.size > MAX_BUFFERED_RUNS) {
    // Evict oldest finalized entries first, then oldest entries overall.
    const sorted = Array.from(traceBuffers.entries()).sort(
      (a, b) => Number(b[1].finalized) - Number(a[1].finalized) || a[1].touchedAt - b[1].touchedAt,
    );
    while (traceBuffers.size > MAX_BUFFERED_RUNS && sorted.length) {
      const [evictId] = sorted.shift()!;
      traceBuffers.delete(evictId);
    }
  }
}

/**
 * Terminal hook for a router run. Callers (`routedRecipeOrPlan`,
 * `routedStep`, agent-runtime) MUST invoke this once a high-level run is
 * truly done — cu-core's Router emits `kind: "complete"` PER STEP, so we
 * cannot use that as a run-finalization signal. This function:
 *   1. flips the run buffer to `finalized`
 *   2. persists the full trace to `router_traces`
 *   3. on `status === "ok"` and `source === "free-plan"`, hands the
 *      trajectory to the SkillLibrary promotion pipeline
 *   4. evicts the buffer (subject to TTL/cap rules)
 *
 * `evict=true` (default) deletes the buffer immediately on terminal events
 * that are pure aborts where no further trace events are expected.
 */
export async function finalizeRouterTraceRun(
  runId: string,
  status: "ok" | "abort" = "ok",
  opts: { source?: string } = {},
): Promise<void> {
  const entry = traceBuffers.get(runId);
  if (!entry) return;
  entry.finalized = true;
  await persistRunTrace(runId, status);
  if (status === "ok") {
    const sourceMeta = opts.source ?? (entry.buf.events.find((e) => e.metadata?.source)?.metadata
      ?.source as string | undefined) ?? "free-plan";
    if (sourceMeta === "free-plan") {
      const eventsCopy = entry.buf.events.map((e) => ({ ...e }));
      const surfaceKind: SurfaceKind = entry.buf.surfaceKind;
      const programName = entry.buf.programName;
      try {
        const { promoteSuccessfulTrajectory } = await import("./skill-library");
        await promoteSuccessfulTrajectory({
          runId,
          programName,
          surfaceKind,
          events: eventsCopy,
        });
      } catch (err) {
        console.error("[cu-router] promotion failed:", err);
      }
    }
  }
  sweepTraceBuffers(Date.now());
}

export interface RouterTraceEmitterOptions {
  programName?: string;
}

export function makeRouterTraceEmitter(opts: RouterTraceEmitterOptions = {}) {
  return (event: RouterTraceEvent): void => routerTraceEmitter(event, opts);
}

export function routerTraceEmitter(
  event: RouterTraceEvent,
  opts: RouterTraceEmitterOptions = {},
): void {
  emitEvent("cu-router", event.reason, "router-trace", {
    metadata: {
      runId: event.runId,
      kind: event.kind,
      stepIndex: event.stepIndex,
      surfaceKind: event.surfaceKind,
      observationKind: event.observation?.kind,
      attemptedObservation: event.attemptedObservation,
      attemptedLocator: event.attemptedLocator,
      actionVerb: event.actionVerb,
      modelId: event.modelId,
      estimatedCost: event.estimatedCost,
      verifierResult: event.verifier?.result?.status,
      fallbackChain: event.fallbackChain,
    },
  });

  const entry = traceBuffers.get(event.runId) ?? {
    buf: {
      events: [],
      totalSteps: 0,
      tierMisses: 0,
      coordClicks: 0,
      estimatedCostUsd: 0,
      surfaceKind: event.surfaceKind,
      programName: opts.programName,
    },
    touchedAt: Date.now(),
    finalized: false,
  };
  const buf = entry.buf;
  buf.surfaceKind = event.surfaceKind;
  if (opts.programName) buf.programName = opts.programName;
  buf.events.push(event);
  if (buf.events.length > MAX_TRACE_EVENTS_PER_RUN) buf.events.shift();
  if (event.kind === "tier-miss") buf.tierMisses += 1;
  if (event.attemptedLocator === "coords" && event.kind === "act") buf.coordClicks += 1;
  if (event.kind === "complete" || event.kind === "act") buf.totalSteps = Math.max(buf.totalSteps, event.stepIndex + 1);
  if (typeof event.estimatedCost === "number") buf.estimatedCostUsd += event.estimatedCost;
  entry.touchedAt = Date.now();
  traceBuffers.set(event.runId, entry);

  // NOTE: cu-core's Router emits `kind: "complete"` PER STEP, not once per
  // run, and `kind: "abort"` when the recovery policy gives up on a step.
  // Run-level finalization (persistence + promotion) is therefore explicit:
  // callers invoke `finalizeRouterTraceRun(runId, status)` once the whole
  // high-level run is done. We keep the buffer alive in the meantime so a
  // multi-step trajectory accumulates correctly.
  if (event.kind === "abort") {
    void persistRunTrace(event.runId, "abort");
  }
  sweepTraceBuffers(entry.touchedAt);
}

async function persistRunTrace(runId: string, status: string): Promise<void> {
  const entry = traceBuffers.get(runId);
  if (!entry || entry.buf.events.length === 0) return;
  const buf = entry.buf;
  try {
    await storage.upsertRouterTrace({
      runId,
      programName: buf.programName ?? null,
      surfaceKind: buf.surfaceKind,
      events: buf.events.map((e) => ({ ...e })),
      totalSteps: buf.totalSteps,
      tierMisses: buf.tierMisses,
      coordClicks: buf.coordClicks,
      estimatedCostUsd: buf.estimatedCostUsd.toFixed(6),
      status,
    });
  } catch (err) {
    console.error("[cu-router] failed to persist trace", err);
  }
  // One ledger row per cu-router run captures the trajectory + cost so the
  // Ledger view can deep-link straight to the Trajectory Inspector. Awaited
  // so write failures surface loudly through the receipt-ledger event bus
  // rather than silently dropping the audit row.
  try {
    const { recordReceipt } = await import("./receipt-ledger");
    const lastEvent = buf.events[buf.events.length - 1];
    await recordReceipt({
      programName: buf.programName ?? null,
      surface: "cu-router",
      actionVerb: lastEvent?.actionVerb || "run",
      target: buf.surfaceKind,
      targetMeta: {
        runId,
        steps: buf.totalSteps,
        tierMisses: buf.tierMisses,
        coordClicks: buf.coordClicks,
        terminalReason: lastEvent?.reason,
      },
      trajectoryId: runId,
      category: "computer-use",
      costUsd: buf.estimatedCostUsd,
      status: status === "abort" ? "failed" : "executed",
    });
  } catch (err) {
    console.error("[cu-router] failed to record receipt", err);
  }
}

export function getRouterTraceBuffer(runId: string): RouterTraceEvent[] | undefined {
  return traceBuffers.get(runId)?.buf.events;
}

export function getRouterTraceBufferSize(): number {
  return traceBuffers.size;
}

export function tierMissReporter(info: TierMissInfo): void {
  storage.createEvolutionObservation({
    programName: `cu-router::${info.surfaceKind}`,
    observationType: "pattern",
    content: `observation-tier miss for surface=${info.surfaceKind}${info.intent ? `, intent="${info.intent}"` : ""}: cheapest=${info.cheapest} insufficient, succeeded at ${info.succeededAt} (chain: ${info.fallbackChain.join("→")})`,
    consolidated: false,
  }).catch((err) => console.error("[cu-router] failed to record tier-miss observation", err));
}
