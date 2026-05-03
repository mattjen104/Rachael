# Computer-use surface adapters

Four adapters that adapt the existing surface subsystems to the
`@rachael/cu-core` `Surface` contract. Each adapter is a thin wrapper —
no new browser/UIA/Citrix logic lives here.

| Adapter | Wraps | Cost | Notes |
| --- | --- | --- | --- |
| `browser-playwright` | `server/browser-bridge.ts` (CDP) | low | AxTree-capable. |
| `browser-extension` | `server/bridge-queue.ts` | high | Requires user's own browser. Allowlist gated. |
| `windows-uia` | `tools/epic_agent.py` UIA client | low → med | Reports `details.method` (`uia` / `coords`) for cost attribution. |
| `citrix-vision` | `tools/epic_agent.py` Citrix path + `ocr_overlay.py` | high | Vision-only. SoM → vim-hint overlay → raw screenshot degradation chain. |

The capability shape (observation kinds, action verbs, latency, cost) is
declared in two coordinated places:

* `capabilities.ts` — typed constant consumed by adapters and the smart
  router at runtime.
* `manifest.json` — same data, machine-readable, intended for analytics
  and the post-merge replay gate.

Both files must stay in sync; the parity-replay tests will catch the
difference.

## Why dependency injection

Each adapter takes its underlying subsystem as a constructor argument
(`bridge`, `queue`, `client`, `io`). cu-core stays browser/Python free,
adapters stay testable with vitest, and the production wiring lives in
`server/` where the real bridges already exist.

## SoM detector

`citrix-vision` and `browser-playwright` accept a `SomDetectorClient`. The
default implementation in `services/som-detector/client.ts` talks HTTP to
the Python service in `services/som-detector/service.py`. A dead/slow
detector cleanly degrades — Citrix falls through to vim-hints and then to
a raw screenshot; browser-playwright simply emits the raw screenshot.
