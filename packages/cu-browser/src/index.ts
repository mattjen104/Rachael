// @rachael/cu-browser — public surface re-export for browser adapters.
//
// This package is the publish-ready façade over the browser adapters that
// physically live in @rachael/cu-core/src/adapters during the in-monorepo
// extraction phase. When the SDK splits to its own repo, these files move
// here and cu-core stops shipping adapter code.
//
// Public API contract (v0.x):
//   - BrowserPlaywrightAdapter — wraps any "BrowserBridgeApi" you provide.
//     We intentionally do not depend on `playwright` at runtime so the
//     package stays light; bring your own bridge.
//   - BrowserExtensionAdapter — wraps any "BridgeQueueApi". Designed for
//     a Chrome MV3 background-script + native-host queue.
//
// Non-goals: see NON_GOALS.md.

export {
  BrowserPlaywrightAdapter,
  BrowserExtensionAdapter,
} from "@rachael/cu-core";
export type {
  BrowserBridgeApi,
  BridgeQueueApi,
} from "@rachael/cu-core";
