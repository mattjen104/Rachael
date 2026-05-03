// @rachael/cu-bench — public benchmark harness.
//
// Self-contained: depends only on the @rachael/cu-core peer dependency.
// Ships the harness, the in-house 30-task curated suite, and the
// OSWorld + WebArena subset loaders. Bring your own SurfaceFactory to
// run against real surfaces; default StubSurface in run.ts reproduces
// the locked-in tier-mix without any external system.

export { runBench, makeAction } from "./harness";
export type {
  TaskSpec,
  TaskRunResult,
  BenchReport,
  SurfaceSummary,
  SurfaceFactory,
} from "./harness";
export { SUITE_ENTRIES, SUITE_NOTES } from "./suite";
export { loadOsWorldSubset, loadWebArenaSubset, loadAllExternalTasks } from "./external-tasks";
export type { ExternalTaskEntry } from "./external-tasks";
