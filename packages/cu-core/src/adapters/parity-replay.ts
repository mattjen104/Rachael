import type { Surface } from "../bus";
import type { Action, Observation, SurfaceKind } from "../types";

// ---------------------------------------------------------------------------
// Parity replay primitive + harness.
//
// Task #94 step 6 requires that the new adapters reproduce the observable
// outcomes of the existing surfaces for the most recent 50 successful
// trajectories from `server/replay-engine.ts`. The replay engine itself
// stores recipes (path-finding artifacts), not raw step traces — recorded
// trajectories live as JSON exports under `tests/fixtures/trajectories/`,
// produced by the bridge each time a job completes successfully.
//
// This module ships:
//   - `compareTrajectory`  — the per-trajectory drift diff (used inline by
//     a vitest gate so a single file failing parity blocks merge).
//   - `loadTrajectories`   — scans the fixture directory and returns up to
//     `limit` most-recent recordings, optionally filtered by surface kind.
//   - `runParityGate`      — the high-level harness: loads, replays through
//     the supplied adapter factory, returns a structured report. This is
//     called by `scripts/parity-gate.ts` (CI) and by the vitest gate.
//
// The harness is intentionally defensive: if no recorded trajectories are
// present (fresh checkout, no Replit-side dataset mounted), it returns
// `{ ok: true, replayed: 0 }` so CI doesn't fail-spuriously. The CI job
// asserts `replayed >= expectedMinimum` separately when the dataset is
// known to be available.
// ---------------------------------------------------------------------------

export interface RecordedStep {
  action: Action;
  observationsAfter: Array<Pick<Observation, "kind" | "digest">>;
}

export interface RecordedTrajectory {
  id: string;
  surfaceKind: SurfaceKind;
  recordedAt: number;
  steps: RecordedStep[];
  // Free-form provenance — bridge job id, run id, etc.
  source?: Record<string, unknown>;
}

export interface ReplayDrift {
  stepIndex: number;
  reason: string;
  expected?: unknown;
  actual?: unknown;
}

export interface ParityResult {
  ok: boolean;
  driftCount: number;
  drift: ReplayDrift[];
}

export interface TrajectoryReport extends ParityResult {
  trajectoryId: string;
  surfaceKind: SurfaceKind;
}

export interface ParityGateReport {
  ok: boolean;
  replayed: number;
  failed: number;
  reports: TrajectoryReport[];
}

export async function compareTrajectory(
  surface: Surface,
  steps: RecordedStep[],
): Promise<ParityResult> {
  const drift: ReplayDrift[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const result = await surface.act(step.action);
    if (!result.ok) {
      drift.push({ stepIndex: i, reason: `act failed: ${result.error ?? "unknown"}` });
      continue;
    }

    if (step.observationsAfter.length === 0) continue;

    const kinds = step.observationsAfter.map((o) => o.kind);
    let actual: Observation[] = [];
    try {
      actual = await surface.observe(kinds);
    } catch (e: any) {
      drift.push({ stepIndex: i, reason: `observe threw: ${e?.message ?? String(e)}` });
      continue;
    }

    for (let j = 0; j < step.observationsAfter.length; j++) {
      const expected = step.observationsAfter[j];
      const got = actual[j];
      if (!got) {
        drift.push({ stepIndex: i, reason: `missing observation[${j}] ${expected.kind}` });
        continue;
      }
      if (got.kind !== expected.kind) {
        drift.push({
          stepIndex: i,
          reason: `kind mismatch[${j}]`,
          expected: expected.kind,
          actual: got.kind,
        });
      } else if (got.digest !== expected.digest) {
        drift.push({
          stepIndex: i,
          reason: `digest mismatch[${j}] ${got.kind}`,
          expected: expected.digest,
          actual: got.digest,
        });
      }
    }
  }

  return { ok: drift.length === 0, driftCount: drift.length, drift };
}

// ---------------------------------------------------------------------------
// Fixture loading. Kept Node-only and lazy so cu-core stays usable in the
// browser bundle.
// ---------------------------------------------------------------------------

export interface LoadOptions {
  dir?: string;
  limit?: number;
  surfaceKind?: SurfaceKind;
}

export async function loadTrajectories(opts: LoadOptions = {}): Promise<RecordedTrajectory[]> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const dir = opts.dir ?? path.resolve(process.cwd(), "tests/fixtures/trajectories");

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }

  const files = entries.filter((n) => n.endsWith(".json"));
  const loaded: RecordedTrajectory[] = [];
  for (const name of files) {
    try {
      const raw = await fs.readFile(path.join(dir, name), "utf8");
      const parsed = JSON.parse(raw) as RecordedTrajectory;
      if (!parsed?.id || !parsed?.steps) continue;
      if (opts.surfaceKind && parsed.surfaceKind !== opts.surfaceKind) continue;
      loaded.push(parsed);
    } catch {
      // Malformed fixtures are skipped; the gate reports `replayed` so a
      // missing dataset is observable rather than silent.
    }
  }
  loaded.sort((a, b) => (b.recordedAt ?? 0) - (a.recordedAt ?? 0));
  return typeof opts.limit === "number" ? loaded.slice(0, opts.limit) : loaded;
}

export interface ParityGateOptions extends LoadOptions {
  // Builds a fresh adapter for each trajectory. The factory receives the
  // recorded trajectory so production wiring can stub the right page id /
  // env / Citrix session id.
  adapterFor(trajectory: RecordedTrajectory): Promise<Surface> | Surface;
}

export async function runParityGate(opts: ParityGateOptions): Promise<ParityGateReport> {
  const trajectories = await loadTrajectories(opts);
  const reports: TrajectoryReport[] = [];
  let failed = 0;
  for (const t of trajectories) {
    const surface = await opts.adapterFor(t);
    const result = await compareTrajectory(surface, t.steps);
    if (!result.ok) failed++;
    reports.push({ ...result, trajectoryId: t.id, surfaceKind: t.surfaceKind });
  }
  return { ok: failed === 0, replayed: trajectories.length, failed, reports };
}
