// Hello, Windows surface — uses an in-memory fake UIA client so the example
// runs anywhere (CI, macOS, Linux) without the real sidecar.
//
//   npx tsx packages/cu-windows/examples/hello-windows.ts

import { ComputerUseBus } from "@rachael/cu-core";
import { WindowsUiaAdapter } from "@rachael/cu-windows";

const client = {
  async tree() {
    return {
      elements: [
        { name: "Save", controlType: "Button", automationId: "btn-save" },
        { name: "Cancel", controlType: "Button", automationId: "btn-cancel" },
      ],
    };
  },
  async invoke(target: { name?: string }) {
    console.log(`[uia] invoke name=${target.name}`);
    return { ok: true, method: "uia" as const };
  },
  async setValue(_t: unknown, _v: string) { return { ok: true, method: "uia" as const }; },
  async sendKeys(chord: string) { console.log(`[uia] keys ${chord}`); return { ok: true, method: "uia" as const }; },
};

const adapter = new WindowsUiaAdapter({ client, surfaceId: "notepad" });
const bus = new ComputerUseBus();
bus.registerSurface(adapter);

const [obs] = await bus.observe("notepad", ["UiaTree"]);
console.log("elements:", (obs as { elements: unknown[] }).elements.length);

await bus.act("notepad", {
  verb: "Click",
  target: { kind: "uia", name: "Save" },
});
