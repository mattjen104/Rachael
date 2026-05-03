/**
 * REST + WebSocket routes for the iOS adapter family.
 *
 * - `/api/ios/devices` — list / get / update (arm) / revoke paired iOS devices
 * - `/api/ios/devices/:id/queue` — phone polls (GET) and reports results (POST)
 * - `/api/ios/pair/start` — Rachael UI requests a pairing code
 * - `/api/ios/pair/confirm` — phone (or Mac WDA bridge) submits the code, gets a token
 * - `/api/ios/dispatch` — internal: kick an action through the smart router
 * - `/api/ios/capabilities/:adapter` — capability manifest
 * - `/ws/ios-wda` — long-lived socket from the Mac WDA bridge
 */
import type { Express } from "express";
import type { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import crypto from "crypto";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { storage } from "./storage";
import { dispatchToIos, getIosCapabilities, waitForActionResult, type IosAdapter } from "./ios-adapters";
import { emitEvent } from "./event-bus";

const SCREENSHOT_DIR = join(process.cwd(), "attached_assets", "ios-screenshots");
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

// ── Pair-confirm rate limiting ────────────────────────────────────────────
// 6-digit pairing codes are issued for at most 10 minutes, but during that
// window an unauthenticated attacker who can reach /api/ios/pair/confirm
// could try ~1M codes. Cap each remote IP to 10 attempts per rolling 60s
// and lock the IP out for 5 minutes after 50 total bad attempts.
const PAIR_ATTEMPT_WINDOW_MS = 60_000;
const PAIR_ATTEMPT_LIMIT = 10;
const PAIR_LOCKOUT_AFTER = 50;
const PAIR_LOCKOUT_MS = 5 * 60_000;
const pairAttempts = new Map<string, { stamps: number[]; bad: number; lockedUntil: number }>();

function pairThrottle(ip: string): { allowed: boolean; retryAfterSec?: number; reason?: string } {
  const now = Date.now();
  const rec = pairAttempts.get(ip) || { stamps: [], bad: 0, lockedUntil: 0 };
  if (rec.lockedUntil > now) {
    return { allowed: false, retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000), reason: "ip locked out" };
  }
  rec.stamps = rec.stamps.filter(t => now - t < PAIR_ATTEMPT_WINDOW_MS);
  if (rec.stamps.length >= PAIR_ATTEMPT_LIMIT) {
    pairAttempts.set(ip, rec);
    return { allowed: false, retryAfterSec: Math.ceil(PAIR_ATTEMPT_WINDOW_MS / 1000), reason: "rate limited" };
  }
  rec.stamps.push(now);
  pairAttempts.set(ip, rec);
  return { allowed: true };
}

function recordPairFailure(ip: string): void {
  const rec = pairAttempts.get(ip) || { stamps: [], bad: 0, lockedUntil: 0 };
  rec.bad += 1;
  if (rec.bad >= PAIR_LOCKOUT_AFTER) rec.lockedUntil = Date.now() + PAIR_LOCKOUT_MS;
  pairAttempts.set(ip, rec);
}

function recordPairSuccess(ip: string): void {
  pairAttempts.delete(ip);
}

/**
 * Persist a base64-encoded screenshot from the WDA bridge to disk and return
 * a redaction-aware result payload. The b64 bytes themselves are NEVER stored
 * in the audit row (only the path, size, and a sha256), so the audit log
 * stays small and cheap to redact later if a sensitive screen leaks through.
 */
async function persistScreenshot(actionId: number, deviceId: number, payload: unknown): Promise<Record<string, unknown>> {
  if (!payload || typeof payload !== "object") return { value: payload };
  const p = payload as Record<string, unknown>;
  const b64 = typeof p.imageBase64 === "string" ? p.imageBase64 : null;
  if (!b64) return { value: payload };
  try {
    const bytes = Buffer.from(b64, "base64");
    if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
      return { value: { ...p, imageBase64: undefined, error: `screenshot too large (${bytes.byteLength} bytes)` } };
    }
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    const sha = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const fname = `dev${deviceId}_act${actionId}_${Date.now()}_${sha}.png`;
    const fpath = join(SCREENSHOT_DIR, fname);
    await writeFile(fpath, bytes);
    const stripped: Record<string, unknown> = { ...p };
    delete stripped.imageBase64;
    return {
      value: stripped,
      screenshotPath: `attached_assets/ios-screenshots/${fname}`,
      screenshotSha256: sha,
      screenshotBytes: bytes.byteLength,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { value: { ...p, imageBase64: undefined }, screenshotError: msg };
  }
}

const dispatchSchema = z.object({
  action: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).default({}),
  preferredAdapter: z.enum(["ios-shortcuts", "ios-wda"]).optional(),
  allowFallback: z.boolean().optional(),
  source: z.string().max(64).optional(),
  waitMs: z.number().int().min(0).max(120_000).optional(),
});

const pairStartSchema = z.object({
  kind: z.enum(["ios-shortcuts", "ios-wda"]),
  deviceName: z.string().max(120).optional(),
});
const pairConfirmSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  kind: z.enum(["ios-shortcuts", "ios-wda"]).optional(),
  deviceName: z.string().max(120).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const resultSchema = z.object({
  status: z.enum(["completed", "failed", "skipped"]).optional(),
  result: z.unknown().optional(),
  error: z.string().max(2000).nullable().optional(),
});
const patchDeviceSchema = z.object({
  armed: z.boolean().optional(),
  name: z.string().min(1).max(120).optional(),
});

function hashToken(t: string): string {
  return crypto.createHash("sha256").update(t).digest("hex");
}
function genToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}
function genPairingCode(): string {
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, "0");
}

async function authDevice(req: any): Promise<{ ok: boolean; device?: any }> {
  const token = (req.headers["x-device-token"] as string | undefined) || "";
  if (!token) return { ok: false };
  const device = await storage.getPairedDeviceByTokenHash(hashToken(token));
  if (!device || device.revoked) return { ok: false };
  await storage.touchPairedDevice(device.id);
  return { ok: true, device };
}

export function registerIosRoutes(app: Express, httpServer: Server): void {
  // Capabilities
  app.get("/api/ios/capabilities/:adapter", (req, res) => {
    const adapter = req.params.adapter as IosAdapter;
    if (adapter !== "ios-shortcuts" && adapter !== "ios-wda") {
      return res.status(400).json({ error: "unknown adapter" });
    }
    res.json(getIosCapabilities(adapter));
  });

  // Pairing
  app.post("/api/ios/pair/start", async (req, res) => {
    const parsed = pairStartSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const { kind, deviceName } = parsed.data;
    const code = genPairingCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await storage.createPairingCode({ code, kind, proposedName: deviceName || `iPhone (${kind})`, metadata: {}, expiresAt });
    // NB: do not log the code into the event stream — only that a code exists.
    emitEvent("ios:pair", `Pairing code issued for ${kind}`, "info", { metadata: { kind, expiresAt: expiresAt.toISOString() } });
    res.json({ code, expiresAt: expiresAt.toISOString() });
  });

  app.post("/api/ios/pair/confirm", async (req, res) => {
    // Use only the trusted Express-resolved socket IP. We deliberately do NOT
    // honour X-Forwarded-For here because /api/ios/pair/confirm is unauthed
    // and a spoofable header would let an attacker rotate "IPs" per request
    // and bypass throttling. Operators behind a real reverse proxy must set
    // `app.set("trust proxy", ...)` to make req.ip reflect the client.
    const ip = req.socket?.remoteAddress || req.ip || "unknown";
    const gate = pairThrottle(ip);
    if (!gate.allowed) {
      if (gate.retryAfterSec) res.setHeader("Retry-After", String(gate.retryAfterSec));
      emitEvent("ios:pair", `Pair-confirm throttled (${gate.reason})`, "warn", { metadata: { ip } });
      return res.status(429).json({ error: gate.reason || "rate limited", retryAfterSec: gate.retryAfterSec });
    }
    const parsed = pairConfirmSchema.safeParse(req.body);
    if (!parsed.success) { recordPairFailure(ip); return res.status(400).json({ error: parsed.error.message }); }
    const { code, kind, deviceName, metadata } = parsed.data;
    // Atomically reserve the code first to prevent TOCTOU races where two
    // concurrent confirms both pass validity check and both mint device tokens.
    const pc = await storage.claimPairingCode(code);
    if (!pc) {
      recordPairFailure(ip);
      // Either non-existent, expired, or already consumed/claimed.
      const existing = await storage.getPairingCode(code);
      if (!existing) return res.status(404).json({ error: "code not found" });
      if (existing.expiresAt < new Date()) return res.status(410).json({ error: "code expired" });
      return res.status(409).json({ error: "code already consumed" });
    }
    const targetKind = (kind || pc.kind) as IosAdapter;
    if (targetKind !== pc.kind) {
      recordPairFailure(ip);
      await storage.releasePairingCode(code);
      return res.status(400).json({ error: "kind mismatch" });
    }

    let device;
    try {
      const token = genToken();
      device = await storage.createPairedDevice({
        kind: targetKind,
        name: deviceName || pc.proposedName || `iPhone (${targetKind})`,
        tokenHash: hashToken(token),
        armed: false,
        capabilities: getIosCapabilities(targetKind) as unknown as Record<string, unknown>,
        metadata: metadata || {},
      });
      await storage.consumePairingCode(code, device.id);
      recordPairSuccess(ip);
      emitEvent("ios:pair", `Device paired: ${device.name} (${device.kind})`, "info", { metadata: { deviceId: device.id } });
      return res.json({ token, deviceId: device.id, name: device.name, armed: device.armed });
    } catch (e) {
      await storage.releasePairingCode(code).catch(() => {});
      throw e;
    }
  });

  // Device manager (admin / UI)
  app.get("/api/ios/devices", async (req, res) => {
    const kind = req.query.kind as string | undefined;
    const devices = await storage.getPairedDevices({
      kind: (kind === "ios-shortcuts" || kind === "ios-wda") ? kind : undefined,
    });
    const ios = devices.filter(d => d.kind === "ios-shortcuts" || d.kind === "ios-wda");
    res.json(ios);
  });

  app.patch("/api/ios/devices/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
    const parsed = patchDeviceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const { armed, name } = parsed.data;
    const updated = await storage.updatePairedDevice(id, {
      ...(typeof armed === "boolean" ? { armed } : {}),
      ...(typeof name === "string" ? { name } : {}),
    });
    if (!updated) return res.status(404).json({ error: "device not found" });
    emitEvent("ios:device", `Device updated: ${updated.name} armed=${updated.armed}`, "info", { metadata: { deviceId: id } });
    res.json(updated);
  });

  app.delete("/api/ios/devices/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await storage.revokePairedDevice(id);
    emitEvent("ios:device", `Device revoked id=${id}`, "info");
    res.json({ ok: true });
  });

  // Phone polling endpoint
  app.get("/api/ios/devices/:id/queue", async (req, res) => {
    const auth = await authDevice(req);
    if (!auth.ok) return res.status(401).json({ error: "unauthorized" });
    const id = parseInt(req.params.id, 10);
    if (auth.device!.id !== id) return res.status(403).json({ error: "device id mismatch" });
    const claimed = await storage.claimDeviceActions(id, 25);
    res.json(claimed.map(a => ({
      id: a.id,
      action: a.action,
      args: a.args,
      createdAt: a.createdAt,
      ttlSeconds: 300,
    })));
  });

  app.post("/api/ios/devices/:id/queue/:actionId/result", async (req, res) => {
    const auth = await authDevice(req);
    if (!auth.ok || !auth.device) return res.status(401).json({ error: "unauthorized" });
    const id = parseInt(req.params.id, 10);
    const actionId = parseInt(req.params.actionId, 10);
    if (auth.device.id !== id) return res.status(403).json({ error: "device id mismatch" });
    const action = await storage.getDeviceAction(actionId);
    if (!action || action.deviceId !== id) return res.status(404).json({ error: "action not found" });
    const parsed = resultSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const { status, result, error } = parsed.data;
    const final = status === "failed" ? "failed" : "completed";
    const persisted = await persistScreenshot(actionId, id, result);
    await storage.completeDeviceAction(actionId, { ...persisted, error: error || null }, final);
    emitEvent(`ios:${auth.device.kind}`, `Action ${actionId} ${final}${persisted.screenshotPath ? " +screenshot" : ""}`, final === "failed" ? "warn" : "info", { metadata: { deviceId: id, actionId, screenshotPath: persisted.screenshotPath } });

    // ── Auto-escalate Shortcuts execution failures to WDA, exactly once ──
    // Loop prevention: the retry carries args.__escalatedFrom so a second
    // failure won't re-fire. We only escalate adapter-meaningful actions
    // (router maps Shortcuts names to nothing on WDA, so the agent runtime
    // is responsible for translating the high-level intent — here we just
    // re-queue with the same name on WDA and let the bridge no-op if it
    // doesn't recognize it; that surfaces a clear "unknown action" instead
    // of silent loss).
    let escalated: { actionId: number } | undefined;
    if (final === "failed" && auth.device.kind === "ios-shortcuts") {
      const argsBag = (action.args || {}) as Record<string, unknown>;
      if (!argsBag.__escalatedFrom) {
        try {
          const retry = await dispatchToIos(action.action, { ...argsBag, __escalatedFrom: actionId }, {
            preferredAdapter: "ios-wda",
            allowFallback: false,
            source: `escalation:${actionId}`,
          });
          if (retry.ok) {
            escalated = { actionId: retry.actionId };
            emitEvent("ios:router", `Shortcuts action ${actionId} failed; auto-escalated to WDA action ${retry.actionId}`, "warn", { metadata: { fromActionId: actionId, toActionId: retry.actionId } });
          } else {
            emitEvent("ios:router", `Shortcuts action ${actionId} failed; WDA escalation also failed (${retry.status})`, "error", { metadata: { fromActionId: actionId, status: retry.status, error: retry.error } });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          emitEvent("ios:router", `Escalation crash for action ${actionId}: ${msg}`, "error", { metadata: { fromActionId: actionId } });
        }
      }
    }

    res.json({ ok: true, screenshotPath: persisted.screenshotPath, escalation: escalated });
  });

  app.get("/api/ios/devices/:id/actions", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
    const limit = Math.min(500, Math.max(1, parseInt((req.query.limit as string) || "100", 10)));
    const actions = await storage.listDeviceActions(id, limit);
    res.json(actions);
  });

  // Internal dispatch (smart-router style; UI / agent runtime hits this)
  app.post("/api/ios/dispatch", async (req, res) => {
    const parsed = dispatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const { action, args, preferredAdapter, allowFallback, source, waitMs } = parsed.data;
    const result = await dispatchToIos(action, args, {
      preferredAdapter,
      allowFallback: allowFallback !== false,
      source: source || "api",
    });
    if (result.ok && waitMs) {
      const finished = await waitForActionResult(result.actionId, waitMs);
      return res.json({ dispatch: result, action: finished });
    }
    res.json({ dispatch: result });
  });

  // Takeover policy file (read-only over the API; edit on disk per task spec)
  app.get("/api/ios/policy", async (_req, res) => {
    try {
      const { readFile } = await import("fs/promises");
      const { join } = await import("path");
      const raw = await readFile(join(process.cwd(), "config", "ios-takeover-policy.json"), "utf-8");
      res.type("application/json").send(raw);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── WSS for the Mac WDA bridge ──
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/ios-wda" });
  const liveBridges = new Map<number, WebSocket>();

  wss.on("connection", async (ws, req) => {
    const token = (req.headers["x-device-token"] as string | undefined) || "";
    if (!token) { ws.close(1008, "no token"); return; }
    const device = await storage.getPairedDeviceByTokenHash(hashToken(token));
    if (!device || device.revoked || device.kind !== "ios-wda") { ws.close(1008, "unauthorized"); return; }
    await storage.touchPairedDevice(device.id);
    liveBridges.set(device.id, ws);
    emitEvent("ios:ios-wda", `Bridge connected (${device.name})`, "info", { metadata: { deviceId: device.id } });

    const pumpInterval = setInterval(async () => {
      const claimed = await storage.claimDeviceActions(device.id, 5);
      for (const a of claimed) {
        ws.send(JSON.stringify({ kind: "action", id: a.id, action: a.action, args: a.args }));
      }
    }, 750);

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.kind === "heartbeat") {
          await storage.touchPairedDevice(device.id);
          return;
        }
        if (msg.kind === "result") {
          // Verify the action actually belongs to THIS device before mutating
          // it: otherwise a compromised token for device A could complete or
          // fail an action queued for device B by guessing/observing IDs.
          const owned = await storage.getDeviceAction(msg.id);
          if (!owned || owned.deviceId !== device.id) {
            emitEvent("ios:ios-wda", `Rejected cross-device result attempt for action ${msg.id}`, "warn", { metadata: { deviceId: device.id, actionId: msg.id, ownerDeviceId: owned?.deviceId } });
            return;
          }
          const ok = msg.ok !== false && !msg.error;
          const persisted = ok ? await persistScreenshot(msg.id, device.id, msg.value) : { error: msg.error };
          await storage.completeDeviceAction(
            msg.id,
            persisted,
            ok ? "completed" : "failed",
          );
          const shotPath = (persisted as { screenshotPath?: string }).screenshotPath;
          emitEvent("ios:ios-wda", `Action ${msg.id} ${ok ? "completed" : "failed"}${shotPath ? " +screenshot" : ""}`, ok ? "info" : "warn", { metadata: { deviceId: device.id, actionId: msg.id, screenshotPath: shotPath } });
        }
      } catch (e: any) {
        console.error("[ios-wda] bad message:", e);
      }
    });

    ws.on("close", () => {
      clearInterval(pumpInterval);
      liveBridges.delete(device.id);
      emitEvent("ios:ios-wda", `Bridge disconnected (${device.name})`, "warn", { metadata: { deviceId: device.id } });
    });
  });
}
