import { z } from "zod";
import { ObservationKindSchema, type ObservationKind } from "../types";

// ---------------------------------------------------------------------------
// TaskProfile — what the router tells server/model-router.ts about the
// current step so it can pick the right model. This is the bridge between
// observation-cost decisions (which tier did the surface yield?) and
// model-cost decisions (do we need vision, or can a cheap text model do it?).
//
// Kept transport-agnostic on purpose: the cu-core router never imports the
// server. The server's `pickModelForProfile` adapter consumes this shape.
// ---------------------------------------------------------------------------

export const TaskProfileSchema = z.object({
  observationKind: ObservationKindSchema,
  expectedOutput: z.enum(["selector", "click-target", "extraction", "summary", "decision"]),
  latencyBudgetMs: z.number().int().nonnegative().optional(),
  needsVision: z.boolean(),
  // Hint for the cascade — what we're trying to do, in plain words.
  intent: z.string().optional(),
});
export type TaskProfile = z.infer<typeof TaskProfileSchema>;

export interface ModelChoice {
  modelId: string;
  estimatedCost: number;
  reason: string;
}

// Pluggable resolver — server provides a real implementation that wraps
// `server/model-router.ts`. The cu-core router calls it through this
// interface so the package stays standalone.
export interface ModelRouterAdapter {
  pickForProfile(profile: TaskProfile): ModelChoice | Promise<ModelChoice>;
}

// Default no-op resolver used when nothing is wired up (tests, bench).
export const NULL_MODEL_ROUTER: ModelRouterAdapter = {
  pickForProfile(profile) {
    return {
      modelId: profile.needsVision ? "vision-stub" : "text-stub",
      estimatedCost: profile.needsVision ? 0.005 : 0.0001,
      reason: "null-model-router (no real model resolver wired)",
    };
  },
};

export function deriveProfile(
  observationKind: ObservationKind,
  expectedOutput: TaskProfile["expectedOutput"],
  intent?: string,
  latencyBudgetMs?: number,
): TaskProfile {
  const visionKinds: ObservationKind[] = ["RawScreenshot", "SomScreenshot"];
  return {
    observationKind,
    expectedOutput,
    latencyBudgetMs,
    needsVision: visionKinds.includes(observationKind),
    intent,
  };
}
