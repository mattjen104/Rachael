# `@rachael/cu-browser`

Browser surface adapters for [`@rachael/cu-core`](../cu-core). Two adapters,
both transport-agnostic:

| Adapter | Wraps | Cost | When to use |
|---|---|---|---|
| `BrowserPlaywrightAdapter` | Any `BrowserBridgeApi` (typically Playwright over CDP) | low | Headless or attached Chromium you control. AxTree-capable. |
| `BrowserExtensionAdapter` | Any `BridgeQueueApi` (typically a Chrome MV3 background-script queue) | high | Driving the user's own logged-in browser. Allowlist-gated. |

Both adapters implement `Surface` from `@rachael/cu-core` and emit the same
typed observation/action vocabulary, so the cu-router can pick between them
without knowing which one is plugged in.

## Install

```bash
npm install @rachael/cu-core @rachael/cu-browser zod
```

You also need a real browser bridge. We recommend Playwright for the
Playwright adapter:

```bash
npm install playwright
```

## Hello, surface

A runnable, dependency-free example using a fake bridge so you can see the
shape end-to-end:

```bash
npx tsx examples/hello-browser.ts
```

```ts
// examples/hello-browser.ts
import { ComputerUseBus } from "@rachael/cu-core";
import { BrowserPlaywrightAdapter } from "@rachael/cu-browser";

// Bring your own bridge — anything that speaks the BrowserBridgeApi shape.
const bridge = {
  async navigate(url: string) { console.log("→", url); },
  async getPageContent() {
    return { text: "submitted=true", elements: [{ tag: "button", text: "OK" }] };
  },
  async click(_sel: string) {},
  async type(_sel: string, _text: string) {},
  async screenshot() { return Buffer.alloc(0); },
};

const adapter = new BrowserPlaywrightAdapter({ bridge, surfaceId: "demo" });
const bus = new ComputerUseBus();
bus.registerSurface(adapter);

await bus.act("demo", { verb: "Goto", url: "https://example.com" });
const result = await bus.verify("demo", { kind: "expectText", text: "submitted=true" });
console.log(result.status); // "pass"
```

## Real-world wiring

The Rachael monorepo wires `BrowserPlaywrightAdapter` to
[`server/browser-bridge.ts`](../../server/browser-bridge.ts) (a CDP client
with retries and frame management) and `BrowserExtensionAdapter` to
[`server/bridge-queue.ts`](../../server/bridge-queue.ts) (a Postgres-backed
job queue talked to by a Chrome MV3 extension). Both modules are kept out
of this package on purpose: they pull in `pg`, `playwright`, and a chunk of
Express. External users supply their own equivalents.

## Stable v0.x contract

- The `BrowserBridgeApi` and `BridgeQueueApi` interfaces are stable shape
  but not stable semantics across the v0.x line — methods may grow new
  optional parameters.
- The action vocabulary (`Click`, `Type`, `Goto`, `Key`, `Hint`, `Wait`,
  `Scroll`, `Composite`) is stable for v0.x.
- The observation kinds an adapter advertises are stable for v0.x.
- Error shapes are not yet stable; callers should not pattern-match on
  thrown messages.

## Non-goals

See [`NON_GOALS.md`](./NON_GOALS.md). Briefly: no built-in Playwright
runtime, no headless browser management, no built-in proxy pool, no
fingerprint randomization, no recipe execution (that's `@rachael/cu-skills`).
