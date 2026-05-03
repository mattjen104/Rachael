# `@rachael/cu-windows`

Desktop and Citrix surface adapters for [`@rachael/cu-core`](../cu-core),
plus a Python sidecar that ships the **Set-of-Marks (SoM) detector** and a
**UIA bridge**.

| Adapter | Wraps | Cost | When to use |
|---|---|---|---|
| `WindowsUiaAdapter` | Any `UiaClientApi` (typically the `rachael-cu-windows` Python sidecar) | low → med | Native Win32 / WPF / UWP / WinForms apps with usable accessibility trees. |
| `CitrixVisionAdapter` | A `CitrixIoApi` + a `SomDetectorClient` | high | Citrix / RDP / VDI sessions where only pixels are available. SoM → vim-hint overlay → raw screenshot fallback chain. |

`SomDetectorHttpClient` is the default HTTP client for the Python sidecar.
Bring your own client if you want to talk to a different SoM model (e.g.
hosted OmniParser).

## Install

```bash
npm install @rachael/cu-core @rachael/cu-windows zod
pip install rachael-cu-windows   # Python sidecar; see ./python/README.md
```

## Hello, surface

```bash
npx tsx packages/cu-windows/examples/hello-windows.ts
```

```ts
// examples/hello-windows.ts
import { ComputerUseBus } from "@rachael/cu-core";
import { WindowsUiaAdapter } from "@rachael/cu-windows";

// In production, point this at the rachael-cu-windows Python bridge over HTTP.
const client = {
  async tree() {
    return { elements: [{ name: "Save", controlType: "Button" }] };
  },
  async invoke(target: { name?: string }) {
    console.log("invoke", target);
    return { ok: true };
  },
  async setValue(_t: unknown, _v: string) { return { ok: true }; },
  async sendKeys(_chord: string) { return { ok: true }; },
};

const adapter = new WindowsUiaAdapter({ client, surfaceId: "notepad" });
const bus = new ComputerUseBus();
bus.registerSurface(adapter);

await bus.act("notepad", {
  verb: "Click",
  target: { kind: "uia", name: "Save" },
});
```

## Architecture

```
┌─────────────────────────┐         ┌────────────────────────────┐
│ @rachael/cu-windows     │         │ rachael-cu-windows (py)    │
│  ├ WindowsUiaAdapter────┼─HTTP───▶│  ├ uia_bridge (uiautomation)│
│  └ CitrixVisionAdapter──┼─HTTP───▶│  └ som_detector (OmniParser │
│         │               │         │       → OpenCV fallback)   │
│         └─SomDetectorHttpClient   └────────────────────────────┘
└─────────────────────────┘
```

- **TS adapters** are platform-agnostic and have no Windows-only deps.
- **Python sidecar** runs on the Windows host (or a Citrix endpoint) and
  exposes `/uia/tree`, `/uia/act`, `/detect`, `/health`. Local-only by
  design (HIPAA): no cloud calls, no telemetry.
- **SoM detector** picks the best detector available at startup:
  ONNX OmniParser if `models/icon_detect.onnx` is present, else an OpenCV
  edge + MSER heuristic. Both backends emit the same mark shape.
- **Citrix vision degradation chain:** SoM marks → vim-hint overlay →
  raw screenshot + coords. The router records each tier-miss; the
  adapter never crashes the host on a missing detector.

See [`python/README.md`](./python/README.md) for sidecar setup.

## Stable v0.x contract

- `UiaClientApi`, `CitrixIoApi`, `SomDetectorClient` interface shapes.
- The on-the-wire JSON for `/detect` (`{ image: <base64>, marks: [...] }`)
  and `/health`.
- Mark shape: `{ mark: string, rect: { x, y, w, h }, label?: string }`.
- The `details.method` cost-attribution field on UIA acts (`uia` vs `coords`).

## Non-goals

See [`NON_GOALS.md`](./NON_GOALS.md). Briefly: no macOS, no Linux desktop,
no AT-SPI, no shipping ONNX checkpoints inside the package, no GPU-required
detector path, no remote-host control beyond HTTP-localhost.
