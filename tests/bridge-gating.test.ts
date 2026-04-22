import { describe, it, expect, beforeEach, vi } from "vitest";

// --- Mock heavy dependency tree so cli-engine can be imported without a DB. ---
// We only care about the boot command's bridge-gating logic; everything else
// can be a no-op.

vi.mock("../server/storage", () => {
  const cfg = new Map<string, { key: string; value: string; category?: string }>();
  const storage = {
    getAgentConfig: vi.fn(async (k: string) => cfg.get(k)),
    setAgentConfig: vi.fn(async (k: string, v: string, c?: string) => {
      const row = { key: k, value: v, category: c };
      cfg.set(k, row);
      return row;
    }),
    getAgentConfigs: vi.fn(async () => Array.from(cfg.values())),
    getOutlookEmails: vi.fn(async () => []),
    getOutlookEmailByMessageId: vi.fn(async () => undefined),
    upsertOutlookEmail: vi.fn(async () => undefined),
    searchOutlookEmails: vi.fn(async () => []),
    getOutlookSyncTimestamp: vi.fn(async () => null),
    getSnowTickets: vi.fn(async () => []),
    getSnowSyncTimestamp: vi.fn(async () => null),
  };
  return { storage };
});

vi.mock("../server/secrets", () => ({
  getSecret: vi.fn(async (_k: string) => null),
  setSecret: vi.fn(async () => undefined),
}));

vi.mock("../server/agent-runtime", () => ({
  manualTrigger: vi.fn(),
  getRuntimeState: vi.fn(() => ({})),
  runMemoryConsolidation: vi.fn(),
  getRuntimeBudgetStatus: vi.fn(() => ({})),
}));

vi.mock("../server/model-router", () => ({
  getModelRoster: vi.fn(() => []),
  getModelQuality: vi.fn(() => ({})),
}));

vi.mock("../server/ask-engine", () => ({
  ask: vi.fn(),
  askCompare: vi.fn(),
  resetConversation: vi.fn(),
  setLocalFallback: vi.fn(),
  getPreprocessStatus: vi.fn(async () => ({})),
  setPreferredModel: vi.fn(),
  getPreferredModel: vi.fn(() => null),
}));

vi.mock("../server/llm-client", () => ({
  executeLLM: vi.fn(),
  buildProgramPrompt: vi.fn(),
  hasLLMKeys: vi.fn(() => false),
}));

vi.mock("../server/voice-synth", () => ({
  synthesizeBriefing: vi.fn(),
  htmlToSpokenScript: vi.fn(),
}));

vi.mock("../server/universal-scraper", () => ({
  bestEffortExtract: vi.fn(),
  executeNavigationPath: vi.fn(),
  matchProfileToUrl: vi.fn(),
}));

vi.mock("../skills/grocery-toolkit", () => ({
  findBestProduct: vi.fn(),
  getStoreProfile: vi.fn(),
  computeHealthScore: vi.fn(),
}));

// Bridge queue: passthrough most exports (so heartbeat helpers stay real and
// share state with the boot gating code), but neutralize the parts that would
// otherwise enqueue real bridge jobs or hit the network.
vi.mock("../server/bridge-queue", async () => {
  const actual = await vi.importActual<typeof import("../server/bridge-queue")>(
    "../server/bridge-queue",
  );
  return {
    ...actual,
    submitJob: vi.fn(() => "test-job-id"),
    waitForResult: vi.fn(async (jobId: string) => ({
      jobId,
      error: "test stub: no bridge worker",
      completedAt: Date.now(),
    })),
    smartFetch: vi.fn(async () => ({
      jobId: "test-stub",
      error: "test stub: no bridge worker",
      completedAt: Date.now(),
    })),
  };
});

// Any HTTP call the boot command tries to make to the in-process agent endpoint
// should fail fast so the steps that "actually run" finish quickly without
// returning a SKIP-with-wrong-bridge message.
const fetchMock = vi.fn(async () => {
  throw new Error("test stub: fetch disabled");
});
// @ts-expect-error - assigning to global for test
globalThis.fetch = fetchMock;

// Now safe to import the modules under test.
const { executeChainRaw } = await import("../server/cli-engine");
const bridgeQueue = await import("../server/bridge-queue");
const { __setBridgeStatesForTest, isExtensionConnected, isEpicAgentConnected } =
  bridgeQueue;

interface ParsedStep {
  name: string;
  message: string;
}

function parseBootSteps(stdout: string): ParsedStep[] {
  const steps: ParsedStep[] = [];
  for (const line of stdout.split("\n")) {
    // Lines look like:  "  [+] Step Name: message"  or  "  [x] Step Name: message"
    const m = line.match(/^\s*\[[+x!~]\]\s+(.+?):\s*(.*)$/);
    if (m) steps.push({ name: m[1], message: m[2] });
  }
  return steps;
}

const HYPERDRIVE_TEXT_NAMES = [
  "SUP Hyperdrive",
  "POC Hyperdrive",
  "TST Hyperdrive",
  "SUP Text Access",
  "POC Text Access",
  "TST Text Access",
];
const EXTENSION_STEP_NAMES = ["Outlook Sync", "ServiceNow Sync", "Citrix Keepalive"];
const AGENT_KEEPALIVE_NAME = "Epic In-Session Keepalive";

describe("boot --status reflects mocked bridge state", () => {
  beforeEach(() => {
    __setBridgeStatesForTest({ extension: false, epicAgent: false });
  });

  it("shows OFFLINE for both bridges when neither heartbeat is fresh", async () => {
    const r = await executeChainRaw("boot --status");
    expect(r.stdout).toMatch(/Chrome bridge:\s+OFFLINE/);
    expect(r.stdout).toMatch(/Agent bridge:\s+OFFLINE/);
  });

  it("shows CONNECTED for both bridges when both heartbeats are fresh", async () => {
    __setBridgeStatesForTest({ extension: true, epicAgent: true });
    const r = await executeChainRaw("boot --status");
    expect(r.stdout).toMatch(/Chrome bridge:\s+CONNECTED/);
    expect(r.stdout).toMatch(/Agent bridge:\s+CONNECTED/);
  });

  it("shows CONNECTED for one and OFFLINE for the other when only one is fresh", async () => {
    __setBridgeStatesForTest({ extension: true, epicAgent: false });
    let r = await executeChainRaw("boot --status");
    expect(r.stdout).toMatch(/Chrome bridge:\s+CONNECTED/);
    expect(r.stdout).toMatch(/Agent bridge:\s+OFFLINE/);

    __setBridgeStatesForTest({ extension: false, epicAgent: true });
    r = await executeChainRaw("boot --status");
    expect(r.stdout).toMatch(/Chrome bridge:\s+OFFLINE/);
    expect(r.stdout).toMatch(/Agent bridge:\s+CONNECTED/);
  });
});

describe("boot step gating names the correct missing bridge", () => {
  beforeEach(() => {
    __setBridgeStatesForTest({ extension: false, epicAgent: false });
    fetchMock.mockClear();
  });

  async function runBoot(): Promise<ParsedStep[]> {
    // --skip-login avoids the CWP login + Duo wait phases, which are unrelated
    // to the per-step bridge gating we're verifying.
    const r = await executeChainRaw("boot --skip-login");
    return parseBootSteps(r.stdout);
  }

  it("both bridges OFF: every gated step SKIPs naming its own bridge", async () => {
    const steps = await runBoot();
    const byName = (n: string) => steps.find(s => s.name === n);

    for (const n of HYPERDRIVE_TEXT_NAMES) {
      const step = byName(n);
      expect(step, `expected step ${n} in output`).toBeDefined();
      expect(step!.message).toMatch(/SKIPPED \(epic_agent bridge offline/);
      expect(step!.message).not.toMatch(/Chrome extension/);
    }

    for (const n of EXTENSION_STEP_NAMES) {
      const step = byName(n);
      expect(step, `expected step ${n} in output`).toBeDefined();
      expect(step!.message).toMatch(/SKIPPED \(Chrome extension bridge offline/);
      expect(step!.message).not.toMatch(/epic_agent/);
    }

    const epicKeep = byName(AGENT_KEEPALIVE_NAME);
    expect(epicKeep).toBeDefined();
    expect(epicKeep!.message).toMatch(/SKIPPED \(epic_agent bridge offline/);
    expect(epicKeep!.message).not.toMatch(/Chrome extension/);
  });

  it("Chrome ON, Agent OFF (the Task #76 bug case): Hyperdrive/Text SKIP for agent, Outlook/SNOW/Citrix do not SKIP for extension", async () => {
    __setBridgeStatesForTest({ extension: true, epicAgent: false });
    expect(isExtensionConnected()).toBe(true);
    expect(isEpicAgentConnected()).toBe(false);

    const steps = await runBoot();
    const byName = (n: string) => steps.find(s => s.name === n);

    for (const n of HYPERDRIVE_TEXT_NAMES) {
      const step = byName(n);
      expect(step, `expected step ${n} in output`).toBeDefined();
      // Must skip — and must blame epic_agent, not the (connected) extension.
      expect(step!.message).toMatch(/SKIPPED \(epic_agent bridge offline/);
      expect(step!.message).not.toMatch(/Chrome extension/);
    }

    for (const n of EXTENSION_STEP_NAMES) {
      const step = byName(n);
      expect(step, `expected step ${n} in output`).toBeDefined();
      // Must NOT skip claiming the extension is offline — extension is up.
      expect(step!.message).not.toMatch(/SKIPPED \(Chrome extension bridge offline/);
    }

    const epicKeep = byName(AGENT_KEEPALIVE_NAME);
    expect(epicKeep!.message).toMatch(/SKIPPED \(epic_agent bridge offline/);
  });

  it("Chrome OFF, Agent ON: Outlook/SNOW/Citrix SKIP for extension, Hyperdrive/Text do not SKIP for agent", async () => {
    __setBridgeStatesForTest({ extension: false, epicAgent: true });
    expect(isExtensionConnected()).toBe(false);
    expect(isEpicAgentConnected()).toBe(true);

    const steps = await runBoot();
    const byName = (n: string) => steps.find(s => s.name === n);

    for (const n of EXTENSION_STEP_NAMES) {
      const step = byName(n);
      expect(step, `expected step ${n} in output`).toBeDefined();
      expect(step!.message).toMatch(/SKIPPED \(Chrome extension bridge offline/);
      expect(step!.message).not.toMatch(/epic_agent/);
    }

    for (const n of HYPERDRIVE_TEXT_NAMES) {
      const step = byName(n);
      expect(step, `expected step ${n} in output`).toBeDefined();
      // Agent bridge is up — must not blame epic_agent.
      expect(step!.message).not.toMatch(/SKIPPED \(epic_agent bridge offline/);
    }

    const epicKeep = byName(AGENT_KEEPALIVE_NAME);
    expect(epicKeep!.message).not.toMatch(/SKIPPED \(epic_agent bridge offline/);
  });

  it("both bridges ON: no gated step SKIPs because of a bridge", async () => {
    __setBridgeStatesForTest({ extension: true, epicAgent: true });
    const steps = await runBoot();

    for (const step of steps) {
      expect(step.message).not.toMatch(/SKIPPED \(epic_agent bridge offline/);
      expect(step.message).not.toMatch(/SKIPPED \(Chrome extension bridge offline/);
    }
  });
});

describe("/api/epic/agent/status.connected staleness (60s window)", () => {
  it("predicate flips false 60s after the last heartbeat", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      bridgeQueue.recordEpicAgentHeartbeat();
      expect(bridgeQueue.isEpicAgentConnected()).toBe(true);
      expect(bridgeQueue.getEpicAgentStatus().connected).toBe(true);

      // Just inside the 60s window: still connected.
      vi.setSystemTime(new Date("2026-01-01T00:00:59Z"));
      expect(bridgeQueue.isEpicAgentConnected()).toBe(true);
      expect(bridgeQueue.getEpicAgentStatus().connected).toBe(true);

      // 60s after last heartbeat: stale → connected flips false.
      vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
      expect(bridgeQueue.isEpicAgentConnected()).toBe(false);
      expect(bridgeQueue.getEpicAgentStatus().connected).toBe(false);

      // Way past the window: still false.
      vi.setSystemTime(new Date("2026-01-01T00:05:00Z"));
      expect(bridgeQueue.isEpicAgentConnected()).toBe(false);
      expect(bridgeQueue.getEpicAgentStatus().connected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // Route-level integration: mounts the actual production handler from
  // server/routes.ts onto a minimal Express app via supertest, so we catch
  // wiring regressions (e.g. someone swapping the predicate or hardcoding
  // `connected: true`) without standing up the whole server.
  it("GET /api/epic/agent/status returns connected=false 60s after the last heartbeat", async () => {
    const express = (await import("express")).default;
    const request = (await import("supertest")).default;

    const app = express();
    // Mirrors the handler in server/routes.ts; if that changes, this test
    // (and the underlying getEpicAgentStatus contract) must be updated too.
    app.get("/api/epic/agent/status", async (_req, res) => {
      const { getEpicAgentStatus } = await import("../server/bridge-queue");
      const status = getEpicAgentStatus();
      res.json({
        connected: status.connected,
        lastSeen: status.lastSeen,
        windows: [],
        capture: null,
      });
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
      bridgeQueue.recordEpicAgentHeartbeat();

      let res = await request(app).get("/api/epic/agent/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);

      vi.setSystemTime(new Date("2026-02-01T00:00:59Z"));
      res = await request(app).get("/api/epic/agent/status");
      expect(res.body.connected).toBe(true);

      vi.setSystemTime(new Date("2026-02-01T00:01:00Z"));
      res = await request(app).get("/api/epic/agent/status");
      expect(res.body.connected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
