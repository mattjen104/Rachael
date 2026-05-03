# Non-goals — `@rachael/cu-inspector-data` v0.x

- **No React, no DOM, no UI components.** This is a data contract.
- **No persistence.** Frames are values; storing them is the host
  app's job.
- **No audit log.** Mint and consume of unlock tokens, plus any access
  logging, lives in the host app (Rachael ships a reference
  implementation in `server/redaction.ts` and `server/trajectory-routes.ts`).
- **No token issuance.** Same reason: token signing keys are host-app
  secrets.
- **No screenshot decoding.** We do not pull in a PNG/JPEG decoder.
  `redactedScreenshotSvg` deliberately renders a wireframe.
- **No PHI/PII *detection* model.** The default policy is regex-based
  and intentionally conservative; pluggable detectors are a v1.x
  candidate.
- **No anonymization beyond masking.** k-anonymity, differential
  privacy, etc. are out of scope.
