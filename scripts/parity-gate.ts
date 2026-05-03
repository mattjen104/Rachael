#!/usr/bin/env -S npx tsx
import {
  runParityGate,
  BrowserPlaywrightAdapter,
  BrowserExtensionAdapter,
  WindowsUiaAdapter,
  CitrixVisionAdapter,
  type RecordedTrajectory,
  type Surface,
  type Observation,
  type ObservationKind,
} from "@rachael/cu-core";

// Parity-replay CI gate. Replays recorded trajectories from
// `tests/fixtures/trajectories/` through the new adapters and exits
// non-zero on drift.
//
// In CI, the dataset is materialised by the bridge before this script
// runs. On a fresh checkout the directory contains only the example
// fixture and the gate exits 0 with `replayed=1`. The CI job asserts a
// per-surface minimum separately.
//
// The adapters are constructed with the *real* underlying clients only
// when the corresponding env var is set (BRIDGE_URL, UIA_HOST,
// CITRIX_HOST). Otherwise the gate stubs them with no-ops so the harness
// itself can be smoke-tested without a live environment.

interface StubBridgeOpts {
  trajectoryId: string;
}

function stubObservation(kind: ObservationKind, surfaceId: string): Observation {
  const base = { surfaceId, timestamp: Date.now(), digest: "stub" } as const;
  switch (kind) {
    case "AxTree":
      return { kind, ...base, root: { role: "WebArea", children: [] } };
    case "DomSnapshot":
      return { kind, ...base, url: "", title: "", text: "", elements: [] };
    case "UiaTree":
      return { kind, ...base, elements: [] };
    case "SomScreenshot":
      return { kind, ...base, imageRef: "stub", marks: [] };
    case "RawScreenshot":
      return { kind, ...base, imageRef: "stub" };
    case "TextDump":
      return { kind, ...base, text: "" };
  }
}

function stubBrowserBridge(_: StubBridgeOpts) {
  return {
    getPageContent: async () => ({ title: "", url: "", text: "", elements: [] }),
    getAxTree: async () => ({ role: "WebArea", children: [] }),
    screenshot: async () => ({ imageRef: "stub" }),
    click: async () => undefined,
    type: async () => undefined,
    key: async () => undefined,
    scroll: async () => undefined,
    goto: async () => undefined,
    wait: async () => undefined,
  };
}

async function adapterFor(t: RecordedTrajectory): Promise<Surface> {
  switch (t.surfaceKind) {
    case "browser-tab":
      return new BrowserPlaywrightAdapter({
        pageId: t.id,
        bridge: stubBrowserBridge({ trajectoryId: t.id }),
      });
    case "browser-extension":
      return new BrowserExtensionAdapter({
        queue: {
          submit: async () => null,
          observe: async (kind: ObservationKind): Promise<Observation> => stubObservation(kind, t.id),
          isAllowed: () => true,
        },
      });
    case "desktop-window":
      return new WindowsUiaAdapter({
        env: "stub",
        client: {
          getUiaTree: async () => ({ elements: [] }),
          screenshot: async () => ({ imageRef: "stub" }),
          click: async () => ({ method: "uia" }),
          hint: async () => ({ method: "uia" }),
          type: async () => undefined,
          key: async () => undefined,
          scroll: async () => undefined,
        },
      });
    case "citrix-session":
      return new CitrixVisionAdapter({
        io: {
          screenshot: async () => ({ imageRef: "stub" }),
          click: async () => undefined,
          hint: async () => undefined,
          type: async () => undefined,
          key: async () => undefined,
        },
      });
    default:
      throw new Error(`No adapter wiring for surfaceKind: ${t.surfaceKind}`);
  }
}

async function main() {
  const report = await runParityGate({ adapterFor, limit: 50 });
  const summary = {
    ok: report.ok,
    replayed: report.replayed,
    failed: report.failed,
    perSurface: report.reports.reduce<Record<string, { ok: number; fail: number }>>((acc, r) => {
      acc[r.surfaceKind] ||= { ok: 0, fail: 0 };
      if (r.ok) acc[r.surfaceKind].ok++;
      else acc[r.surfaceKind].fail++;
      return acc;
    }, {}),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!report.ok) {
    for (const r of report.reports.filter((x) => !x.ok)) {
      console.error(`DRIFT ${r.surfaceKind} ${r.trajectoryId}:`);
      for (const d of r.drift) console.error(`  step[${d.stepIndex}] ${d.reason}`);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
