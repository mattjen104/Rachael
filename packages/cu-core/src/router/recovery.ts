import type { ObservationKind } from "../types";

// ---------------------------------------------------------------------------
// Recovery policy — what to do when a postcondition fails. Default:
//   1. Re-observe with the next cheaper-tier observation
//   2. Retry the action once
//   3. Escalate to takeover (the host wires this to control-bus)
//
// Programs may swap in their own policy by passing a different RecoveryPolicy.
// ---------------------------------------------------------------------------

export type RecoveryStep =
  | { kind: "reobserve"; observation: ObservationKind }
  | { kind: "retry" }
  | { kind: "takeover"; reason: string }
  | { kind: "abort"; reason: string };

export interface RecoveryContext {
  failedObservation: ObservationKind;
  remainingObservations: ObservationKind[];
  retriesUsed: number;
  budgetExhausted: boolean;
}

export interface RecoveryPolicy {
  next(ctx: RecoveryContext): RecoveryStep;
}

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
  next(ctx) {
    if (ctx.budgetExhausted) return { kind: "abort", reason: "budget-exhausted" };
    if (ctx.remainingObservations.length > 0) {
      return { kind: "reobserve", observation: ctx.remainingObservations[0] };
    }
    if (ctx.retriesUsed === 0) return { kind: "retry" };
    return { kind: "takeover", reason: "all-tiers-exhausted" };
  },
};
