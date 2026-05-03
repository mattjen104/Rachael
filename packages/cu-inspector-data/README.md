# `@rachael/cu-inspector-data`

The **data contract** for the cu-core trajectory inspector: every shape an
analyst tool needs to display a run, plus a default-on PHI/PII redaction
pipeline.

The React inspector itself stays internal to Rachael. This package is
what an external adopter (analyst tool, training-data pipeline, evals
dashboard) builds on.

## What's in here

- **Frame types**: `TrajectoryEvent`, `TrajectoryRunSummary`,
  `TrajectoryRunDetail`, `TrajectoryDiffEntry`,
  `TrajectoryUnlockResponse`, with Zod schemas (`TrajectoryEventSchema`).
- **Redaction**: `RedactionPolicy`, `DEFAULT_REDACTION_POLICY`,
  `redactText`, `redactFrame`, `redactedScreenshotSvg`.

## Install

```bash
npm install @rachael/cu-inspector-data zod
```

## Hello, redaction

```bash
npx tsx packages/cu-inspector-data/examples/redact-frame.ts
```

```ts
import {
  redactFrame,
  DEFAULT_REDACTION_POLICY,
  type TrajectoryEvent,
} from "@rachael/cu-inspector-data";

const event: TrajectoryEvent = {
  id: "ev-1", ts: Date.now(), runId: "run-1", stepIndex: 0,
  kind: "act", surfaceId: "epic-1", surfaceKind: "citrix-session",
  reason: "patient lookup",
  metadata: { text: "Patient MRN 123456789 phone 555-867-5309" },
};

const { event: safe, hits } = redactFrame(event);
console.log(safe.metadata?.text); // "Patient [MRN] phone [PHONE]"
console.log(hits);                 // ["metadata.text:mrn", ...]
```

## Why "data contract only"?

External tools don't need our React; they need our **shape**. By
publishing the schemas and the redactor — and *not* the UI — we
guarantee a stable seam without coupling adopters to our component
choices, theme, or React version.

## Stable v0.x contract

- All exported types and Zod schemas.
- `DEFAULT_REDACTION_POLICY` regex set: additions allowed, removals are
  breaking.
- `redactText`, `redactFrame`, `redactedScreenshotSvg` signatures.
- The fact that `redactedScreenshotSvg` **never embeds raw pixels** —
  raw screenshot delivery is gated by the host application's
  `X-Unlock-Token` flow (see `SECURITY.md`).

## Non-goals

See [`NON_GOALS.md`](./NON_GOALS.md). Briefly: no UI components, no
storage, no audit-log persistence, no token issuance — those are
host-app concerns.
