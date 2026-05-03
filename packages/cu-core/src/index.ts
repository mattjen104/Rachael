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
  ReplayDrift,
  TrajectoryReport,
} from "./adapters/parity-replay";
export type { FakeSurfaceState } from "./fake-surface";
