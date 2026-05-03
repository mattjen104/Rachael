import { describe, it, expect, vi } from "vitest";
import {
  ADAPTER_CAPABILITIES,
  BrowserExtensionAdapter,
  BrowserPlaywrightAdapter,
  CitrixVisionAdapter,
  ComputerUseBus,
  WindowsUiaAdapter,
  compareTrajectory,
  loadTrajectories,
  runParityGate,
  type Observation,
  type ObservationKind,
} from "@rachael/cu-core";

// ---------------------------------------------------------------------------
// Capability manifest sanity — Citrix MUST be vision-only (no AxTree/UiaTree).
// This codifies the locked-in design call from task #94.
// ---------------------------------------------------------------------------

describe("ADAPTER_CAPABILITIES", () => {
  it("declares Citrix as vision-only (no AxTree/UiaTree/DOM)", () => {
    const c = ADAPTER_CAPABILITIES["citrix-vision"];
    expect(c.capabilities.observations).toEqual(
      expect.arrayContaining(["SomScreenshot", "RawScreenshot"]),
    );
    expect(c.capabilities.observations).not.toContain("AxTree");
    expect(c.capabilities.observations).not.toContain("UiaTree");
    expect(c.capabilities.observations).not.toContain("DomSnapshot");
    expect(c.capabilities.actions).toEqual(
      expect.arrayContaining(["Hint", "Click", "Type", "Key"]),
    );
  });

  it("declares browser-playwright and browser-extension as AxTree-capable", () => {
    expect(ADAPTER_CAPABILITIES["browser-playwright"].capabilities.observations).toContain("AxTree");
    expect(ADAPTER_CAPABILITIES["browser-extension"].capabilities.observations).toContain("AxTree");
  });

  it("reports browser-extension as higher cost than playwright", () => {
    expect(
      ADAPTER_CAPABILITIES["browser-extension"].medianObserveMs,
    ).toBeGreaterThan(ADAPTER_CAPABILITIES["browser-playwright"].medianObserveMs);
  });
});

// ---------------------------------------------------------------------------
// BrowserPlaywrightAdapter — observe/act/verify against a stubbed bridge.
// ---------------------------------------------------------------------------

describe("BrowserPlaywrightAdapter", () => {
  function makeBridge(over: Record<string, any> = {}) {
    return {
      getPageContent: vi.fn(async () => ({
        title: "Hello",
        url: "https://example.com",
        text: "hello world",
        elements: [{ tag: "button", text: "OK" }],
      })),
      getAxTree: vi.fn(async () => ({ role: "WebArea", children: [] })),
      screenshot: vi.fn(async () => ({ imageRef: "img-1", width: 100, height: 50 })),
      click: vi.fn(async () => undefined),
      type: vi.fn(async () => undefined),
      key: vi.fn(async () => undefined),
      scroll: vi.fn(async () => undefined),
      goto: vi.fn(async () => undefined),
      wait: vi.fn(async () => undefined),
      ...over,
    };
  }

  it("emits AxTree, DomSnapshot, and degrades SomScreenshot to RawScreenshot when no detector", async () => {
    const bridge = makeBridge();
    const adapter = new BrowserPlaywrightAdapter({ pageId: "p1", bridge });
    const obs = await adapter.observe(["AxTree", "DomSnapshot", "SomScreenshot"]);
    expect(obs.map((o) => o.kind)).toEqual(["AxTree", "DomSnapshot", "RawScreenshot"]);
    expect(bridge.getAxTree).toHaveBeenCalledWith("p1");
  });

  it("translates Click(selector) to bridge.click", async () => {
    const bridge = makeBridge();
    const adapter = new BrowserPlaywrightAdapter({ pageId: "p1", bridge });
    const r = await adapter.act({ verb: "Click", target: { kind: "selector", css: "button" } });
    expect(r.ok).toBe(true);
    expect(bridge.click).toHaveBeenCalledWith("p1", { selector: "button" });
  });

  it("verifies expectUrl against DomSnapshot", async () => {
    const adapter = new BrowserPlaywrightAdapter({ pageId: "p1", bridge: makeBridge() });
    const r = await adapter.verify({ kind: "expectUrl", url: "example.com" });
    expect(r.status).toBe("pass");
  });

  it("composite actions short-circuit on first failure", async () => {
    const bridge = makeBridge({
      click: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const adapter = new BrowserPlaywrightAdapter({ pageId: "p1", bridge });
    const r = await adapter.act({
      verb: "Composite",
      steps: [
        { verb: "Click", target: { kind: "selector", css: "a" } },
        { verb: "Wait", ms: 1 },
      ],
    });
    expect(r.ok).toBe(false);
    expect(bridge.wait).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// BrowserExtensionAdapter — allowlist gating + queue submission.
// ---------------------------------------------------------------------------

describe("BrowserExtensionAdapter", () => {
  it("blocks Goto for URLs outside the allowlist", async () => {
    const queue = {
      submit: vi.fn(async () => null),
      observe: vi.fn(async () => ({
        kind: "DomSnapshot" as const,
        surfaceId: "x",
        timestamp: 0,
        digest: "d",
      })),
      isAllowed: (u: string) => u.includes("outlook.office.com"),
    };
    const adapter = new BrowserExtensionAdapter({ queue });
    const blocked = await adapter.act({ verb: "Goto", url: "https://example.com" });
    expect(blocked.ok).toBe(false);
    const allowed = await adapter.act({ verb: "Goto", url: "https://outlook.office.com/mail" });
    expect(allowed.ok).toBe(true);
  });

  it("declares requiresUserBrowser in metadata", () => {
    const adapter = new BrowserExtensionAdapter({
      queue: { submit: async () => null, observe: async () => ({ kind: "DomSnapshot" as const, surfaceId: "x", timestamp: 0, digest: "d" }) },
    });
    expect(adapter.descriptor.metadata?.requiresUserBrowser).toBe(true);
  });

  it("dispatches AxTree observation requests through the queue", async () => {
    const observe = vi.fn(async (kind: ObservationKind): Promise<Observation> => {
      if (kind !== "AxTree") throw new Error(`unexpected ${kind}`);
      return { kind, surfaceId: "x", timestamp: 0, digest: "ax", root: { role: "WebArea", children: [] } };
    });
    const adapter = new BrowserExtensionAdapter({
      queue: { submit: async () => null, observe },
    });
    const [obs] = await adapter.observe(["AxTree"]);
    expect(observe).toHaveBeenCalledWith("AxTree");
    expect(obs.kind).toBe("AxTree");
  });
});

// ---------------------------------------------------------------------------
// WindowsUiaAdapter — UIA hits report method, coords fallback also reports.
// ---------------------------------------------------------------------------

describe("WindowsUiaAdapter", () => {
  it("reports method=uia or method=coords on Click", async () => {
    const client = {
      getUiaTree: vi.fn(async () => ({ windowTitle: "Epic", elements: [{ name: "OK", controlType: "Button" }] })),
      screenshot: vi.fn(async () => ({ imageRef: "img" })),
      click: vi.fn(async (_env, t) => ({ method: t.uia ? ("uia" as const) : ("coords" as const) })),
      hint: vi.fn(async () => ({ method: "uia" as const })),
      type: vi.fn(async () => undefined),
      key: vi.fn(async () => undefined),
      scroll: vi.fn(async () => undefined),
    };
    const adapter = new WindowsUiaAdapter({ env: "SUP", client });
    const uiaHit = await adapter.act({ verb: "Click", target: { kind: "uia", name: "OK" } });
    expect(uiaHit.details?.method).toBe("uia");
    const coordsHit = await adapter.act({ verb: "Click", target: { kind: "coords", x: 1, y: 1 } });
    expect(coordsHit.details?.method).toBe("coords");
  });

  it("expectElement(uia) reads UiaTree elements", async () => {
    const client = {
      getUiaTree: vi.fn(async () => ({ elements: [{ name: "OK", controlType: "Button" }] })),
      screenshot: vi.fn(async () => ({ imageRef: "img" })),
      click: vi.fn(async () => ({ method: "uia" as const })),
      hint: vi.fn(async () => ({ method: "uia" as const })),
      type: vi.fn(async () => undefined),
      key: vi.fn(async () => undefined),
      scroll: vi.fn(async () => undefined),
    };
    const adapter = new WindowsUiaAdapter({ env: "SUP", client });
    const r = await adapter.verify({ kind: "expectElement", target: { kind: "uia", name: "OK" } });
    expect(r.status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// CitrixVisionAdapter — graceful degradation through SoM → hints → raw.
// ---------------------------------------------------------------------------

describe("CitrixVisionAdapter", () => {
  const io = () => ({
    screenshot: vi.fn(async () => ({ imageRef: "shot", width: 10, height: 10 })),
    click: vi.fn(async () => undefined),
    hint: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    key: vi.fn(async () => undefined),
  });

  it("uses SoM detector when available", async () => {
    const adapter = new CitrixVisionAdapter({
      io: io(),
      somDetector: { detect: async () => [{ mark: "1", rect: { x: 0, y: 0, w: 1, h: 1 } }] },
    });
    const [obs] = await adapter.observe(["SomScreenshot"]);
    expect(obs.kind).toBe("SomScreenshot");
  });

  it("falls back to hint provider when detector returns nothing", async () => {
    const adapter = new CitrixVisionAdapter({
      io: io(),
      somDetector: { detect: async () => [] },
      hintProvider: { overlay: async () => [{ mark: "a", rect: { x: 0, y: 0, w: 1, h: 1 } }] },
    });
    const [obs] = await adapter.observe(["SomScreenshot"]);
    expect(obs.kind).toBe("SomScreenshot");
    expect(obs.kind === "SomScreenshot" && obs.marks[0].mark).toBe("a");
  });

  it("degrades to RawScreenshot when both SoM and hints are unavailable", async () => {
    const adapter = new CitrixVisionAdapter({ io: io() });
    const [obs] = await adapter.observe(["SomScreenshot"]);
    expect(obs.kind).toBe("RawScreenshot");
  });

  it("degrades to RawScreenshot when SoM detector throws", async () => {
    const adapter = new CitrixVisionAdapter({
      io: io(),
      somDetector: {
        detect: async () => {
          throw new Error("service down");
        },
      },
    });
    const [obs] = await adapter.observe(["SomScreenshot"]);
    expect(obs.kind).toBe("RawScreenshot");
  });

  it("forceHintsOnly skips the SoM detector entirely (A/B toggle)", async () => {
    const detect = vi.fn(async () => [{ mark: "1", rect: { x: 0, y: 0, w: 1, h: 1 } }]);
    const adapter = new CitrixVisionAdapter({
      io: io(),
      somDetector: { detect },
      hintProvider: { overlay: async () => [{ mark: "a", rect: { x: 0, y: 0, w: 1, h: 1 } }] },
      forceHintsOnly: true,
    });
    const [obs] = await adapter.observe(["SomScreenshot"]);
    expect(detect).not.toHaveBeenCalled();
    expect(obs.kind).toBe("SomScreenshot");
  });
});

// ---------------------------------------------------------------------------
// Bus integration + parity replay scaffold.
// ---------------------------------------------------------------------------

describe("ComputerUseBus + adapters", () => {
  it("can register an adapter and route observe/act through the bus", async () => {
    const bus = new ComputerUseBus();
    const adapter = new BrowserPlaywrightAdapter({
      pageId: "p1",
      bridge: {
        getPageContent: async () => ({ title: "T", url: "u", text: "t", elements: [] }),
        click: async () => undefined,
        type: async () => undefined,
        key: async () => undefined,
        scroll: async () => undefined,
        goto: async () => undefined,
        wait: async () => undefined,
      },
    });
    bus.registerSurface(adapter);
    const ids = bus.listSurfaces().map((d) => d.id);
    expect(ids).toContain(adapter.descriptor.id);
    const [obs] = await bus.observe(adapter.descriptor.id, ["DomSnapshot"]);
    expect(obs.kind).toBe("DomSnapshot");
  });

  it("runParityGate replays fixture trajectories from disk", async () => {
    const trajectories = await loadTrajectories({ limit: 50 });
    expect(trajectories.length).toBeGreaterThan(0);
    const report = await runParityGate({
      limit: 50,
      adapterFor: () =>
        new BrowserPlaywrightAdapter({
          pageId: "p1",
          bridge: {
            getPageContent: async () => ({ title: "T", url: "u", text: "t", elements: [] }),
            click: async () => undefined,
            type: async () => undefined,
            key: async () => undefined,
            scroll: async () => undefined,
            goto: async () => undefined,
            wait: async () => undefined,
          },
        }),
    });
    expect(report.ok).toBe(true);
    expect(report.replayed).toBeGreaterThan(0);
  });

  it("compareTrajectory reports digest drift", async () => {
    const bridge = {
      getPageContent: async () => ({ title: "T", url: "u", text: "t", elements: [] }),
      click: async () => undefined,
      type: async () => undefined,
      key: async () => undefined,
      scroll: async () => undefined,
      goto: async () => undefined,
      wait: async () => undefined,
    };
    const adapter = new BrowserPlaywrightAdapter({ pageId: "p1", bridge });
    const result = await compareTrajectory(adapter, [
      {
        action: { verb: "Wait", ms: 0 },
        observationsAfter: [{ kind: "DomSnapshot", digest: "wrong-digest" }],
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.drift[0].reason).toContain("digest mismatch");
  });
});
