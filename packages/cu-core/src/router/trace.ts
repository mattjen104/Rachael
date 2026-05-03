import type { ActionVerb, LocatorKind, ObservationKind, SurfaceKind, VerifierResult } from "../types";

// ---------------------------------------------------------------------------
// RouterTrace — every router decision is recorded as a structured event for
// downstream rendering (analyst inspector, evolution engine). The shape is
// the public contract; persistence is the host's problem.
// ---------------------------------------------------------------------------

export type RouterTraceKind =
  | "decision"
  | "observe"
  | "act"
  | "verify"
  | "recovery"
  | "escalate"
  | "budget-deny"
  | "tier-miss"
  | "takeover"
  | "complete"
  | "abort";

export interface RouterTraceEvent {
  id: string;
  ts: number;
  runId: string;
  stepIndex: number;
  kind: RouterTraceKind;
  surfaceId: string;
  surfaceKind: SurfaceKind;
  observation?: { kind: ObservationKind; digest: string };
  attemptedObservation?: ObservationKind;
  attemptedLocator?: LocatorKind;
  actionVerb?: ActionVerb;
  modelId?: string;
  estimatedCost?: number;
  verifier?: { kind: string; result?: VerifierResult };
  fallbackChain?: ObservationKind[];
  reason: string;
  metadata?: Record<string, unknown>;
}

export type RouterTraceEmitter = (event: RouterTraceEvent) => void;

let counter = 0;
export function newTraceId(prefix = "rt"): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export class InMemoryTraceSink {
  readonly events: RouterTraceEvent[] = [];
  readonly emit: RouterTraceEmitter = (e) => {
    this.events.push(e);
  };
  byKind(kind: RouterTraceKind): RouterTraceEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }
  clear(): void {
    this.events.length = 0;
  }
}
