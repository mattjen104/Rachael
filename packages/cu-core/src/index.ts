export * from "./types";
export * from "./bus";
export { digest } from "./digest";
export { FakeSurface } from "./fake-surface";
export {
  BrowserPlaywrightAdapter,
  BrowserExtensionAdapter,
  WindowsUiaAdapter,
  CitrixVisionAdapter,
  ADAPTER_CAPABILITIES,
} from "./adapters/index";
export type {
  BrowserBridgeApi,
  BridgeQueueApi,
  UiaClientApi,
  SomDetectorClient,
  CitrixIoApi,
} from "./adapters/index";
export { SomDetectorHttpClient } from "./services/som-detector/client";
export { compareTrajectory, loadTrajectories, runParityGate } from "./adapters/parity-replay";
export type {
  RecordedStep,
  RecordedTrajectory,
  ParityResult,
  ParityGateOptions,
  ParityGateReport,
  ParityVariant,
  ReplayDrift,
  TrajectoryReport,
  LoadOptions,
} from "./adapters/parity-replay";
export type { FakeSurfaceState } from "./fake-surface";
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
} from "./router/index";
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
} from "./router/index";
