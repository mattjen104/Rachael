// Runnable example — uses an in-memory fake bridge so it has no system deps.
//
//   npx tsx packages/cu-browser/examples/hello-browser.ts
//
// Replace `bridge` with a real Playwright/CDP bridge in production.

import { ComputerUseBus } from "@rachael/cu-core";
import { BrowserPlaywrightAdapter } from "@rachael/cu-browser";

const bridge = {
  url: "about:blank",
  text: "",
  async navigate(url: string) { this.url = url; this.text = "submitted=true"; },
  async getPageContent() {
    return { text: this.text, elements: [{ tag: "button", text: "OK" }] };
  },
  async click(_sel: string) {},
  async type(_sel: string, value: string) { this.text += ` ${value}`; },
  async screenshot() { return Buffer.alloc(0); },
};

const adapter = new BrowserPlaywrightAdapter({ bridge, surfaceId: "demo" });
const bus = new ComputerUseBus();
bus.registerSurface(adapter);

await bus.act("demo", { verb: "Goto", url: "https://example.com" });
const verdict = await bus.verify("demo", { kind: "expectText", text: "submitted=true" });
console.log(`verify status=${verdict.status}`);
