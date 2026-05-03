// Surface adapters for the four real surfaces Rachael drives today.
//
// Each adapter implements the `Surface` contract from `@rachael/cu-core` and
// wraps an existing subsystem — it does not reimplement behavior. The point
// of these adapters is to make every surface speak the same vocabulary so the
// upcoming smart router can choose between them generically.
//
// All adapters are constructible with explicit dependencies so they can be
// tested without their underlying subsystems being live (e.g. the Playwright
// adapter accepts a `browserBridge` argument so tests can stub it).

export { BrowserPlaywrightAdapter } from "./browser-playwright/index";
export type { BrowserBridgeApi } from "./browser-playwright/index";

export { BrowserExtensionAdapter } from "./browser-extension/index";
export type { BridgeQueueApi } from "./browser-extension/index";

export { WindowsUiaAdapter } from "./windows-uia/index";
export type { UiaClientApi } from "./windows-uia/index";

export { CitrixVisionAdapter } from "./citrix-vision/index";
export type { SomDetectorClient, CitrixIoApi } from "./citrix-vision/index";

export { ADAPTER_CAPABILITIES } from "./capabilities";
