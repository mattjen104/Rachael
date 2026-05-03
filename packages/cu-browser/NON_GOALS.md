# Non-goals — `@rachael/cu-browser` v0.x

This package is **adapters**, not a browser runtime. The following are
explicit non-goals for the v0.x line:

- **No bundled Playwright / Puppeteer.** You supply a `BrowserBridgeApi`.
  We do not pin a browser-driver version.
- **No headless browser lifecycle management.** Spawn, attach, kill, and
  user-data-dir handling are your responsibility.
- **No proxy/fingerprint/CAPTCHA evasion.** Out of scope.
- **No recipe runtime.** Recipes belong to [`@rachael/cu-skills`](../cu-skills);
  this package only knows about Surfaces and Actions.
- **No smart routing between adapters.** Belongs to
  [`@rachael/cu-router`](../cu-router).
- **No Chrome extension code.** This package consumes a queue, it does
  not implement the MV3 background script.
- **No persistent storage.** Trajectory storage and inspection live in
  [`@rachael/cu-inspector-data`](../cu-inspector-data) and the consuming
  application.
- **No mobile browser support** (Android WebView, iOS Safari). Pinned to
  Chromium-class desktop browsers.
