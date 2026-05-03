import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer, IncomingMessage } from "http";
import crypto from "crypto";
import { storage } from "./storage";
import { executeChain } from "./cli-engine";
import { emitEvent, subscribe, type CockpitEvent } from "./event-bus";
import {
  getPendingTakeoverPoints,
  resolveTakeoverPoint,
  recordAction,
  enqueueCommand,
  completeCommand,
  runWithSourceDevice,
} from "./control-bus";
import type { KeyboardDevice } from "@shared/schema";

const OLED_LINE_WIDTH = 32;
const PAIRING_TTL_MS = 5 * 60 * 1000;

export interface KeyboardEnvelope {
  kind: "status" | "echo" | "result" | "prompt" | "pair-code" | "error" | "page";
  text: string;
  ts: number;
  meta?: Record<string, unknown>;
}

interface ClientState {
  ws: WebSocket;
  device?: KeyboardDevice;
  pairingCode?: string;
  unsubscribe?: () => void;
  watchTakeover?: ReturnType<typeof setInterval>;
  busy: boolean;
}

const clients = new Set<ClientState>();

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

function generatePairingCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function clip(text: string, max = OLED_LINE_WIDTH * 8): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function send(state: ClientState, env: Omit<KeyboardEnvelope, "ts">): void {
  if (state.ws.readyState !== WebSocket.OPEN) return;
  const payload: KeyboardEnvelope = { ...env, text: clip(env.text), ts: Date.now() };
  try {
    state.ws.send(JSON.stringify(payload));
  } catch (err) {
    console.error("[keyboard-bridge] send failed:", err);
  }
}

export async function createPairingFlow(): Promise<{ code: string; pendingToken: string; expiresAt: Date }> {
  await storage.cleanExpiredKeyboardPairings().catch(() => {});
  const pendingToken = generateToken();
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
  await storage.createKeyboardPairing({
    code,
    pendingTokenHash: hashToken(pendingToken),
    status: "pending",
    expiresAt,
  });
  return { code, pendingToken, expiresAt };
}

export async function confirmPairing(code: string, name: string): Promise<{ ok: true; deviceId: number } | { ok: false; error: string }> {
  const pairing = await storage.getKeyboardPairingByCode(code);
  if (!pairing) return { ok: false, error: "Pairing code not found" };
  if (pairing.status !== "pending") return { ok: false, error: `Pairing is ${pairing.status}` };
  if (pairing.expiresAt.getTime() < Date.now()) {
    await storage.updateKeyboardPairing(pairing.id, { status: "expired" });
    return { ok: false, error: "Pairing code expired" };
  }
  const device = await storage.createKeyboardDevice({
    name: name.slice(0, 64) || "LilyGo Keyboard",
    tokenHash: pairing.pendingTokenHash,
    armed: false,
  });
  await storage.updateKeyboardPairing(pairing.id, { status: "confirmed", deviceId: device.id });
  recordAction("human", `keyboard-paired: ${device.name}`, `device:${device.id}`, "autonomous", "success");
  return { ok: true, deviceId: device.id };
}

export async function getPairingStatusByPendingToken(pendingToken: string): Promise<{ status: "pending" | "confirmed" | "expired"; deviceId?: number }> {
  const tokenHash = hashToken(pendingToken);
  await storage.cleanExpiredKeyboardPairings().catch(() => {});
  const pairing = await storage.getKeyboardPairingByPendingHash(tokenHash);
  if (pairing) {
    const s = pairing.status;
    const status: "pending" | "confirmed" | "expired" =
      s === "confirmed" || s === "expired" ? s : "pending";
    return { status, deviceId: pairing.deviceId ?? undefined };
  }
  const dev = await storage.getKeyboardDeviceByTokenHash(tokenHash);
  if (dev) return { status: "confirmed", deviceId: dev.id };
  return { status: "pending" };
}

function extractToken(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  const url = new URL(req.url || "/", "http://localhost");
  return url.searchParams.get("token");
}

async function authenticateConnection(req: IncomingMessage): Promise<KeyboardDevice | null> {
  const token = extractToken(req);
  if (!token) return null;
  const dev = await storage.getKeyboardDeviceByTokenHash(hashToken(token));
  return dev || null;
}

function readSourceDevice(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const v = (metadata as Record<string, unknown>).sourceDevice;
  return typeof v === "string" ? v : undefined;
}

function watchEventsForDevice(state: ClientState): void {
  if (!state.device) return;
  const tag = `lilygo:${state.device.id}`;
  state.unsubscribe = subscribe((event: CockpitEvent) => {
    if (readSourceDevice(event.metadata) === tag) {
      send(state, {
        kind: event.eventType === "error" ? "error" : "status",
        text: `${event.source}: ${event.description}`,
      });
    }
  });
}

function watchTakeover(state: ClientState): void {
  if (!state.device) return;
  const tag = `lilygo:${state.device.id}`;
  let lastSeenIds = new Set<string>();
  state.watchTakeover = setInterval(() => {
    // Only forward takeover-points that were created inside an instruction
    // dispatched from *this* device. Other devices and non-keyboard surfaces
    // are completely invisible here.
    const points = getPendingTakeoverPoints().filter(tp => tp.sourceDevice === tag);
    for (const tp of points) {
      if (lastSeenIds.has(tp.id)) continue;
      lastSeenIds.add(tp.id);
      send(state, {
        kind: "prompt",
        text: `WAIT: ${tp.action}`,
        meta: { takeoverPointId: tp.id, target: tp.target, level: tp.permissionLevel },
      });
    }
    lastSeenIds = new Set(points.map(p => p.id));
  }, 1500);
}

async function handleLine(state: ClientState, text: string): Promise<void> {
  if (!state.device) return;
  const trimmed = text.trim();
  if (!trimmed) return;

  if (state.busy) {
    send(state, { kind: "status", text: "busy — try later" });
    return;
  }

  const sourceTag = `lilygo:${state.device.id}`;
  emitEvent("keyboard", `[${state.device.name}] ${trimmed.slice(0, 120)}`, "info", {
    metadata: { sourceDevice: sourceTag, instruction: trimmed },
  });

  // Queue the instruction the same way the cockpit minibuffer would, tagged by source.
  // This matches the agent-runtime queue pattern (enqueueCommand → execute → completeCommand)
  // so smart-routing/queue inspection treats keyboard input as a first-class instruction.
  const cmd = enqueueCommand("human", `keyboard:${trimmed.slice(0, 80)}`, sourceTag);
  recordAction("human", `keyboard-instruction: ${trimmed.slice(0, 80)}`, sourceTag, "autonomous", "queued", trimmed);

  if (!state.device.armed) {
    send(state, { kind: "echo", text: `would dispatch: ${trimmed}` });
    if (cmd) completeCommand(cmd.id, "echo-only");
    return;
  }

  state.busy = true;
  send(state, { kind: "status", text: "executing…" });
  try {
    // Same dispatch path as POST /api/cli/run (the cockpit minibuffer route in
    // server/routes.ts:3030): both call executeChain(command). We wrap the call
    // in runWithSourceDevice so any takeover-point raised during the dispatch
    // inherits the originating device tag and is only visible/answerable to
    // this same device.
    const result = await runWithSourceDevice(sourceTag, () => executeChain(trimmed));
    const summary = result.output.split("\n").slice(0, 8).join("\n");
    send(state, {
      kind: "result",
      text: summary,
      meta: { exitCode: result.exitCode, durationMs: result.durationMs, truncated: result.truncated },
    });
    emitEvent("keyboard", `[${state.device.name}] done (${result.durationMs}ms exit=${result.exitCode})`, "info", {
      metadata: { sourceDevice: sourceTag },
    });
    if (cmd) completeCommand(cmd.id, result.exitCode === 0 ? "success" : "error");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(state, { kind: "error", text: `error: ${msg.slice(0, 200)}` });
    emitEvent("keyboard", `[${state.device.name}] error: ${msg.slice(0, 120)}`, "error", {
      metadata: { sourceDevice: sourceTag },
    });
    if (cmd) completeCommand(cmd.id, "error");
  } finally {
    state.busy = false;
  }
}

function handleAnswer(state: ClientState, value: string, takeoverPointId?: string): void {
  if (!state.device) return;
  // Echo-only devices may never resolve takeover-points: a stolen/lost keyboard
  // must not be able to confirm a destructive action even by guessing an id.
  if (!state.device.armed) {
    send(state, { kind: "error", text: "echo-only device cannot answer takeovers" });
    return;
  }
  if (!takeoverPointId) {
    send(state, { kind: "status", text: "no pending prompt" });
    return;
  }
  // Verify this takeover-point belongs to an instruction dispatched from this
  // same device. Without this check a connected keyboard could resolve any
  // pending takeover (e.g. one originated by the desktop or another device).
  const tag = `lilygo:${state.device.id}`;
  const tp = getPendingTakeoverPoints().find(p => p.id === takeoverPointId);
  if (!tp || tp.sourceDevice !== tag) {
    send(state, { kind: "error", text: "not your prompt" });
    return;
  }
  const decision: "confirm" | "reject" = value.toUpperCase().startsWith("Y") ? "confirm" : "reject";
  const ok = resolveTakeoverPoint(takeoverPointId, decision);
  send(state, { kind: "status", text: ok ? `${decision}ed` : "expired" });
}

function teardown(state: ClientState): void {
  state.unsubscribe?.();
  if (state.watchTakeover) clearInterval(state.watchTakeover);
  clients.delete(state);
}

export function attachKeyboardBridge(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/ws/keyboard") return;

    let device: KeyboardDevice | null = null;
    try {
      device = await authenticateConnection(req);
    } catch (err) {
      console.error("[keyboard-bridge] auth error:", err);
    }
    if (!device) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const state: ClientState = { ws, device: device!, busy: false };
      clients.add(state);
      storage.touchKeyboardDeviceLastSeen(device!.id).catch(() => {});

      send(state, {
        kind: "status",
        text: `linked: ${device!.name}${device!.armed ? "" : " (echo-only)"}`,
      });

      watchEventsForDevice(state);
      watchTakeover(state);

      ws.on("message", async (data) => {
        let msg: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(data.toString());
          if (!parsed || typeof parsed !== "object") throw new Error("not an object");
          msg = parsed as Record<string, unknown>;
        } catch {
          send(state, { kind: "error", text: "bad json" });
          return;
        }
        try {
          const kind = typeof msg.kind === "string" ? msg.kind : "";
          if (kind === "line" && typeof msg.text === "string") {
            await handleLine(state, msg.text);
          } else if (kind === "answer" && typeof msg.value === "string") {
            const tpId = typeof msg.takeoverPointId === "string" ? msg.takeoverPointId : undefined;
            handleAnswer(state, msg.value, tpId);
          } else if (kind === "ping") {
            send(state, { kind: "status", text: "pong" });
            if (state.device) storage.touchKeyboardDeviceLastSeen(state.device.id).catch(() => {});
          } else {
            send(state, { kind: "error", text: `unknown kind: ${kind}` });
          }
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          send(state, { kind: "error", text: `handler error: ${m.slice(0, 120)}` });
        }
      });

      ws.on("close", () => teardown(state));
      ws.on("error", (err) => {
        console.error("[keyboard-bridge] ws error:", err);
        teardown(state);
      });
    });
  });

  return wss;
}
