# Recorded trajectories

JSON exports of successful bridge runs, used by the parity-replay gate
(`packages/cu-core/src/adapters/parity-replay.ts`) to verify that the new
adapters reproduce observable outcomes of the legacy surfaces.

Schema: `RecordedTrajectory` from `@rachael/cu-core`.

The bridge writes one file per successful job into this directory in
production. The most recent 50 (per `surfaceKind`) are replayed by
`scripts/parity-gate.ts` on CI. A fresh checkout has only the example
fixture below; CI mounts the live dataset.
