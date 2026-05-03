// @rachael/cu-router — smart routing + verification + budget over cu-core.
//
// Picks the cheapest observation tier likely to satisfy the next action,
// chooses the most precise locator the surface supports, runs verifiers
// before/after, and either degrades or escalates on miss.
//
// All public symbols re-export from @rachael/cu-core for the in-monorepo
// extraction phase. The split from cu-core lands in v1.x.

export {
  Router,
  pickLocatorKind,
  applyLocatorChoice,
  Budget,
  DEFAULT_RECOVERY_POLICY,
  DEFAULT_STRATEGIES,
  getStrategy,
  setStrategy,
  clearStrategyOverrides,
  intersectPriority,
  evaluateVerifier,
  deriveProfile,
  NULL_MODEL_ROUTER,
  TaskProfileSchema,
  InMemoryTraceSink,
  newTraceId,
} from "@rachael/cu-core";
export type {
  RouterOptions,
  RouterStepInput,
  RouterStepResult,
  TierMissInfo,
  BudgetCheck,
  BudgetLimits,
  BudgetUsage,
  RecoveryContext,
  RecoveryPolicy,
  RecoveryStep,
  SurfaceStrategy,
  ModelChoice,
  ModelRouterAdapter,
  TaskProfile,
  RouterTraceEmitter,
  RouterTraceEvent,
  RouterTraceKind,
} from "@rachael/cu-core";
