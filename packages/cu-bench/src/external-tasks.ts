// External benchmark task loaders for OSWorld and WebArena subsets.
//
// We ship a curated, hand-picked subset (10 each) so the harness can run
// deterministically without the upstream Docker images. Each entry
// preserves the upstream `task_id`, the upstream's official "ideal" step
// count, and the cheapest observation tier we expect Rachael's adapters
// to land on. Real-environment integration is documented in REPORT.md
// under "Reproducing against live OSWorld / WebArena".

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ObservationKind, SurfaceKind } from "@rachael/cu-core";

export interface ExternalTaskEntry {
  benchmark: "osworld" | "webarena";
  upstreamTaskId: string;
  surfaceKind: SurfaceKind;
  intent: string;
  expectedCheapestObservation: ObservationKind;
  stepCount: number;
  notes: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.resolve(HERE, "..", "tasks");

function loadJson(file: string): ExternalTaskEntry[] {
  const raw = readFileSync(path.join(TASKS_DIR, file), "utf8");
  const parsed = JSON.parse(raw) as { entries: ExternalTaskEntry[] };
  return parsed.entries;
}

export function loadOsWorldSubset(): ExternalTaskEntry[] {
  return loadJson("osworld-subset.json");
}

export function loadWebArenaSubset(): ExternalTaskEntry[] {
  return loadJson("webarena-subset.json");
}

export function loadAllExternalTasks(): ExternalTaskEntry[] {
  return [...loadOsWorldSubset(), ...loadWebArenaSubset()];
}
