// @rachael/cu-windows — desktop surfaces (Windows UIA, Citrix vision).
//
// The TS side is a thin wrapper over an HTTP/IPC bridge; the heavy lifting
// (UIA tree extraction, SoM detection) lives in the Python sidecar under
// `python/`. See README.md for the full architecture.

export {
  WindowsUiaAdapter,
  CitrixVisionAdapter,
  SomDetectorHttpClient,
} from "@rachael/cu-core";
export type {
  UiaClientApi,
  SomDetectorClient,
  CitrixIoApi,
} from "@rachael/cu-core";
