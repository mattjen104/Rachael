import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import { initCuBus, getCuBus, isCuBusInitialized } from "../server/cu-bus";
import { submitCuAction, waitForResult } from "../server/bridge-queue";

// Most CU integration tests below run as same-process callers and
// expect the localhost bypass to apply. Opt into it explicitly so the
// production-default (token-required) auth posture stays the safe one.
beforeAll(() => {
  process.env.CU_TRUST_LOCALHOST = "1";
});

describe("cu-bus bootstrap", () => {
  it("registers all four real surface adapters on the process-wide bus", () => {
    const bus = initCuBus();
    expect(isCuBusInitialized()).toBe(true);
    const ids = bus.listSurfaces().map((d) => d.id).sort();
    expect(ids).toEqual([
      "browser-extension:default",
      "browser-playwright:default",
      "citrix-vision:default",
      "windows-uia:SUP",
    ]);
    expect(getCuBus()).toBe(bus);
  });

  it("describes each surface with its expected kind", () => {
    const bus = initCuBus();
    const byId = new Map(bus.listSurfaces().map((d) => [d.id, d] as const));
    expect(byId.get("browser-extension:default")?.kind).toBe("browser-extension");
    expect(byId.get("browser-playwright:default")?.kind).toBe("browser-tab");
    expect(byId.get("windows-uia:SUP")?.kind).toBe("desktop-window");
    expect(byId.get("citrix-vision:default")?.kind).toBe("citrix-session");
  });
});

describe("bridge-queue submitCuAction → cuObservation", () => {
  it("synthesizes a TextDump cuObservation for Wait actions", async () => {
    const id = submitCuAction({ verb: "Wait", ms: 5 }, "test");
    const result = await waitForResult(id, 1000);
    expect(result.error).toBeUndefined();
    expect(result.cuObservation).toBeDefined();
    expect(result.cuObservation?.kind).toBe("TextDump");
    expect(result.cuObservation?.kind === "TextDump" && result.cuObservation.text).toBe("ok");
  });

  it("rejects verbs not yet routed by the queue", () => {
    expect(() =>
      submitCuAction({ verb: "Click", target: { kind: "coords", x: 0, y: 0 } }, "test"),
    ).toThrow(/does not yet route verb/);
  });

  it("rejects Wait without ms (Wait.until requires a verifier on a surface)", () => {
    expect(() => submitCuAction({ verb: "Wait", until: { kind: "expectUrl", url: "x" } }, "test"))
      .toThrow(/Wait.*ms.*supported|until.*verifier/);
  });
});

// Integration test for the TS↔Python typed seam through epic-agent-bus.
// Simulates the wire shape: cu-bus enqueues a typed `cu_action` command,
// the (would-be) Python agent posts a TextDump cuObservation back via
// `setResult`, and the TS side receives a typed Observation through
// `awaitResult`. This exercises every hop except the actual Python
// process.
describe("cu_action round-trip through epic-agent-bus", () => {
  it("delivers a typed TextDump observation to the awaiter", async () => {
    const bus = await import("../server/epic-agent-bus");
    const cuCore = await import("@rachael/cu-core");

    const cmd = bus.enqueueCommand({
      id: bus.genCommandId("cu"),
      type: "cu_action",
      env: "SUP",
      action: { verb: "Wait", ms: 1 },
    });
    expect(cmd.type).toBe("cu_action");

    // Confirm the agent would have seen this command in its drain.
    const drained = bus.drainCommands();
    expect(drained.some((c) => c.id === cmd.id)).toBe(true);

    // Agent simulates posting back a typed observation (validated against
    // the cu-core schema before transmission).
    const observation = cuCore.ObservationSchema.parse({
      kind: "TextDump",
      surfaceId: "windows-uia:SUP",
      text: "ok",
      timestamp: Date.now(),
      digest: "deadbeef",
    });
    bus.setResult({
      commandId: cmd.id,
      status: "complete",
      data: { cuObservation: observation },
      receivedAt: Date.now(),
    });

    const result = await bus.awaitResult(cmd.id, 1000);
    expect(result.status).toBe("complete");
    const dataObs = (result.data as { cuObservation?: unknown }).cuObservation;
    // Re-validate on the receiving side to lock in the typed seam.
    const received = cuCore.ObservationSchema.parse(dataObs);
    expect(received.kind).toBe("TextDump");
    expect(received.kind === "TextDump" && received.text).toBe("ok");
  });
});

// End-to-end integration: HTTP request → /api/cu/* → ComputerUseBus → real
// adapter → typed observation. Wait through the BrowserExtensionAdapter is
// the cleanest happy path: it exercises the bus dispatch, the
// `submitCuAction` typed seam in `bridge-queue`, and the adapter's
// `act()` method without needing an actual extension or epic-agent.
describe("/api/cu/* → bus → adapter (end-to-end)", () => {
  it("dispatches a typed Wait through the extension adapter and returns ActResult", async () => {
    initCuBus();
    const { registerRoutes } = await import("../server/routes");
    const { createServer } = await import("http");
    const app = express();
    app.use(express.json());
    const httpServer = createServer(app);
    const server = await registerRoutes(httpServer, app);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;

    try {
      const surfRes = await fetch(`http://127.0.0.1:${port}/api/cu/surfaces`);
      const surfBody = (await surfRes.json()) as { surfaces: Array<{ id: string; kind: string }> };
      const ids = surfBody.surfaces.map((s) => s.id).sort();
      expect(ids).toContain("browser-extension:default");
      expect(ids).toContain("browser-playwright:default");
      expect(ids).toContain("windows-uia:SUP");
      expect(ids).toContain("citrix-vision:default");

      const actRes = await fetch(`http://127.0.0.1:${port}/api/cu/act`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          surfaceId: "browser-extension:default",
          action: { verb: "Wait", ms: 5 },
        }),
      });
      expect(actRes.status).toBe(200);
      const actBody = (await actRes.json()) as {
        ok: boolean;
        result: { ok: boolean; observations?: unknown[] };
      };
      expect(actBody.ok).toBe(true);
      expect(actBody.result.ok).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 15_000);

  it("dispatches a typed Type action through the windows-uia surface end-to-end", async () => {
    initCuBus();
    const { registerRoutes } = await import("../server/routes");
    const { createServer } = await import("http");
    const epicBus = await import("../server/epic-agent-bus");
    const cuCore = await import("@rachael/cu-core");
    const app = express();
    app.use(express.json());
    const httpServer = createServer(app);
    const server = await registerRoutes(httpServer, app);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;

    // Simulate the Python epic-agent: poll the bus, and as soon as a
    // `cu_action` command appears, post a typed TextDump observation
    // back. This proves the full /api/cu/act → bus → WindowsUiaAdapter
    // → epic-agent-bus → typed observation seam.
    const agent = (async () => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const drained = epicBus.drainCommands();
        const cuCmd = drained.find((c) => c.type === "cu_action");
        if (cuCmd) {
          const obs = cuCore.ObservationSchema.parse({
            kind: "TextDump",
            surfaceId: "windows-uia:SUP",
            timestamp: Date.now(),
            digest: "feedface",
            text: "ok",
          });
          epicBus.setResult({
            commandId: cuCmd.id,
            status: "complete",
            data: { cuObservation: obs },
            receivedAt: Date.now(),
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("agent simulator: no cu_action command observed");
    })();

    try {
      const actRes = await fetch(`http://127.0.0.1:${port}/api/cu/act`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          surfaceId: "windows-uia:SUP",
          action: { verb: "Type", text: "hello" },
        }),
      });
      await agent;
      expect(actRes.status).toBe(200);
      const body = (await actRes.json()) as { ok: boolean; result: { ok: boolean } };
      expect(body.ok).toBe(true);
      expect(body.result.ok).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 15_000);

  it("rejects unauthorized non-local CU requests with 401", async () => {
    initCuBus();
    const { registerRoutes } = await import("../server/routes");
    const { createServer } = await import("http");
    // Force express to treat the test client as non-local by setting
    // `trust proxy` and sending an `X-Forwarded-For` header — `req.ip`
    // then resolves to the forwarded value, exercising the auth path.
    // Also explicitly disable the localhost trust opt-in for this test
    // so the bypass cannot mask the 401 we expect.
    const prev = process.env.CU_TRUST_LOCALHOST;
    delete process.env.CU_TRUST_LOCALHOST;
    const app = express();
    app.set("trust proxy", true);
    app.use(express.json());
    const httpServer = createServer(app);
    const server = await registerRoutes(httpServer, app);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/cu/act`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "8.8.8.8" },
        body: JSON.stringify({
          surfaceId: "browser-extension:default",
          action: { verb: "Wait", ms: 1 },
        }),
      });
      expect(r.status).toBe(401);

      const obsRes = await fetch(`http://127.0.0.1:${port}/api/cu/observe`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "8.8.8.8" },
        body: JSON.stringify({ surfaceId: "browser-extension:default", kinds: ["DomSnapshot"] }),
      });
      expect(obsRes.status).toBe(401);
    } finally {
      if (prev !== undefined) process.env.CU_TRUST_LOCALHOST = prev;
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 15_000);

  it("accepts non-local CU requests when a valid bridge token is provided", async () => {
    initCuBus();
    const { registerRoutes } = await import("../server/routes");
    const { createServer } = await import("http");
    const { getBridgeToken } = await import("../server/bridge-queue");
    const app = express();
    app.set("trust proxy", true);
    app.use(express.json());
    const httpServer = createServer(app);
    const server = await registerRoutes(httpServer, app);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/cu/act`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "8.8.8.8",
          authorization: `Bearer ${getBridgeToken()}`,
        },
        body: JSON.stringify({
          surfaceId: "browser-extension:default",
          action: { verb: "Wait", ms: 1 },
        }),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 15_000);

  it("dispatches a typed Click(uia) through windows-uia using the `target` wire shape", async () => {
    initCuBus();
    const { registerRoutes } = await import("../server/routes");
    const { createServer } = await import("http");
    const epicBus = await import("../server/epic-agent-bus");
    const cuCore = await import("@rachael/cu-core");
    const app = express();
    app.use(express.json());
    const httpServer = createServer(app);
    const server = await registerRoutes(httpServer, app);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;

    // Agent simulator: drains commands and asserts that the click reaches
    // the Python wire as `{type:"click", target:"<label>"}` — the shape
    // `tools/epic_agent.py::execute_click` actually consumes — not as
    // `{hint: ...}`. Then posts back a typed observation.
    let observedClick: { type?: string; target?: unknown; hint?: unknown } | null = null;
    const agent = (async () => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const drained = epicBus.drainCommands();
        const click = drained.find((c) => c.type === "click");
        if (click) {
          observedClick = click as typeof observedClick;
          const obs = cuCore.ObservationSchema.parse({
            kind: "TextDump",
            surfaceId: "windows-uia:SUP",
            timestamp: Date.now(),
            digest: "cafef00d",
            text: "ok",
          });
          epicBus.setResult({
            commandId: click.id,
            status: "complete",
            data: { cuObservation: obs },
            receivedAt: Date.now(),
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("agent simulator: no click command observed");
    })();

    try {
      const actRes = await fetch(`http://127.0.0.1:${port}/api/cu/act`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          surfaceId: "windows-uia:SUP",
          action: {
            verb: "Click",
            target: { kind: "uia", name: "Save", automationId: "btnSave" },
          },
        }),
      });
      await agent;
      expect(actRes.status).toBe(200);
      const body = (await actRes.json()) as { ok: boolean; result: { ok: boolean } };
      expect(body.ok).toBe(true);
      expect(body.result.ok).toBe(true);
      expect(observedClick).not.toBeNull();
      // Contract: cu-bus must send `target` (the label string), not `hint`.
      expect(observedClick!.target).toBe("Save");
      expect(observedClick!.hint).toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 15_000);

  it("dispatches a typed Click(mark) through citrix-vision using the `target` wire shape", async () => {
    initCuBus();
    const { registerRoutes } = await import("../server/routes");
    const { createServer } = await import("http");
    const epicBus = await import("../server/epic-agent-bus");
    const cuCore = await import("@rachael/cu-core");
    const app = express();
    app.use(express.json());
    const httpServer = createServer(app);
    const server = await registerRoutes(httpServer, app);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;

    // Citrix mark click on the cu_action wire: the Python side
    // (`execute_cu_action`) decomposes Click(mark) into a child
    // `{type:"click", target:"<mark>"}` command. We assert the typed
    // cu_action arrives, simulate the agent posting back a
    // ScreenshotRef observation, and confirm the round-trip succeeds.
    let observedCu: { type?: string; action?: { verb?: string; target?: { kind?: string; mark?: string } } } | null = null;
    const agent = (async () => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const drained = epicBus.drainCommands();
        const cu = drained.find((c) => c.type === "cu_action");
        if (cu) {
          observedCu = cu as typeof observedCu;
          const obs = cuCore.ObservationSchema.parse({
            kind: "RawScreenshot",
            surfaceId: "citrix-vision:default",
            timestamp: Date.now(),
            digest: "abad1dea",
            imageRef: "img-1",
          });
          epicBus.setResult({
            commandId: cu.id,
            status: "complete",
            data: { cuObservation: obs },
            receivedAt: Date.now(),
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("agent simulator: no cu_action command observed");
    })();

    try {
      const actRes = await fetch(`http://127.0.0.1:${port}/api/cu/act`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          surfaceId: "citrix-vision:default",
          action: { verb: "Click", target: { kind: "mark", mark: "M7" } },
        }),
      });
      await agent;
      expect(actRes.status).toBe(200);
      const body = (await actRes.json()) as { ok: boolean; result: { ok: boolean } };
      expect(body.ok).toBe(true);
      expect(body.result.ok).toBe(true);
      expect(observedCu).not.toBeNull();
      expect(observedCu!.action?.verb).toBe("Click");
      expect(observedCu!.action?.target?.kind).toBe("mark");
      expect(observedCu!.action?.target?.mark).toBe("M7");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 15_000);

  it("rejects malformed action payloads with 400", async () => {
    initCuBus();
    const { registerRoutes } = await import("../server/routes");
    const { createServer } = await import("http");
    const app = express();
    app.use(express.json());
    const httpServer = createServer(app);
    const server = await registerRoutes(httpServer, app);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/cu/act`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ surfaceId: "browser-extension:default", action: { verb: "Bogus" } }),
      });
      expect(r.status).toBe(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 15_000);
});
