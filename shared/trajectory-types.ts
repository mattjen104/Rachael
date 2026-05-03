// Shared types for the Trajectory Inspector. Re-uses RouterTraceEvent shape
// from packages/cu-core but kept here as a structural mirror so the client
// doesn't need to depend on the cu-core package directly.

export type TrajectoryKind =
  | "decision" | "observe" | "act" | "verify" | "recovery"
  | "escalate" | "budget-deny" | "tier-miss" | "takeover" | "complete" | "abort";

export interface TrajectoryObservation {
  kind: string;
  digest: string;
  imageRef?: string;
}

export interface TrajectoryVerifier {
  kind: string;
  result?: { ok?: boolean; reason?: string };
}

export interface TrajectoryCandidate {
  index: number;
  label?: string;
  score?: number;
  source?: string;
  bbox?: [number, number, number, number];
}

export interface TrajectoryEvent {
  id: string;
  ts: number;
  runId: string;
  stepIndex: number;
  kind: TrajectoryKind;
  surfaceId: string;
  surfaceKind: string;
  observation?: TrajectoryObservation;
  attemptedObservation?: string;
  attemptedLocator?: string;
  actionVerb?: string;
  modelId?: string;
  estimatedCost?: number;
  verifier?: TrajectoryVerifier;
  fallbackChain?: string[];
  reason: string;
  metadata?: TrajectoryEventMetadata;
}

export interface TrajectoryEventMetadata {
  text?: string;
  tree?: string;
  candidates?: TrajectoryCandidate[];
  pickedCandidateIndex?: number;
  imageWidth?: number;
  imageHeight?: number;
  // open-ended; preserve unknown keys
  [k: string]: unknown;
}

export interface TrajectoryRunSummary {
  runId: string;
  programName: string | null;
  surfaceKind: string;
  totalSteps: number;
  tierMisses: number;
  coordClicks: number;
  estimatedCostUsd: string;
  status: string;
  createdAt: string;
}

export interface TrajectoryBranchView {
  branchId: string;
  parentRunId: string;
  parentStepIndex: number;
  childRunId: string | null;
  reason: string;
  notes: string | null;
  createdBy: string;
  status: string;
  createdAt: string;
  editedAction: Record<string, unknown> | null;
}

export interface TrajectoryRunDetail {
  runId: string;
  programName: string | null;
  surfaceKind: string;
  totalSteps: number;
  tierMisses: number;
  coordClicks: number;
  estimatedCostUsd: string;
  status: string;
  createdAt: string;
  events: TrajectoryEvent[];
  branches: TrajectoryBranchView[];
  redactedFieldCount: number;
  rawAvailable: boolean;
  live?: boolean;
}

export interface TrajectoryDiffEntry {
  stepIndex: number;
  left?: TrajectoryEvent;
  right?: TrajectoryEvent;
  changed: string[];
}

export interface TrajectoryDiffResponse {
  left: { runId: string; totalSteps: number; status: string };
  right: { runId: string; totalSteps: number; status: string };
  diffs: TrajectoryDiffEntry[];
}

export interface TrajectoryUnlockResponse {
  token: string;
  expiresAt: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Redaction policy — used by server/redaction.ts. Configurable so a deployment
// can extend patterns or carve out fixed redaction regions per surfaceKind.
// ────────────────────────────────────────────────────────────────────────────

export interface RedactionRegion {
  surfaceKind?: string;          // optional filter
  imageRef?: string;             // optional specific image
  x: number; y: number;          // top-left in image coords (pixels)
  w: number; h: number;
  reason: string;
}

export interface RedactionPolicy {
  patterns: Array<{ name: string; pattern: string; flags?: string; mask: string }>;
  regions: RedactionRegion[];
  stripImageRefs: boolean;
}
