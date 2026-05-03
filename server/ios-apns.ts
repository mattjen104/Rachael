/**
 * APNs HTTP/2 JWT sender for the iOS Shortcuts bridge.
 *
 * Activates only when these env vars are set:
 *   APNS_KEY_PATH      — path to the .p8 key from Apple Developer
 *   APNS_KEY_ID        — 10-char key id
 *   APNS_TEAM_ID       — 10-char team id
 *   APNS_BUNDLE_ID     — bundle id of the companion iOS app that registered for push
 *   APNS_PRODUCTION    — "1" to use api.push.apple.com, otherwise sandbox
 *
 * The companion app stores its APNs device token in `pairedDevices.metadata.apnsToken`.
 * When `dispatchToIos` enqueues an action, this sender fires a silent push so the
 * Shortcut wakes immediately instead of waiting for the next polling tick.
 */
import http2 from "http2";
import jwt from "jsonwebtoken";
import { readFile } from "fs/promises";
import { registerApnsSender } from "./ios-adapters";
import { emitEvent } from "./event-bus";
import type { PairedDevice, DeviceAction } from "@shared/schema";

interface ApnsConfig {
  keyPath: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  host: string;
}

let cachedConfig: ApnsConfig | null = null;
let cachedKey: string | null = null;
let cachedJwt: { token: string; expiresAt: number } | null = null;

function loadConfig(): ApnsConfig | null {
  const keyPath = process.env.APNS_KEY_PATH;
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const bundleId = process.env.APNS_BUNDLE_ID;
  if (!keyPath || !keyId || !teamId || !bundleId) return null;
  const host = process.env.APNS_PRODUCTION === "1" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
  return { keyPath, keyId, teamId, bundleId, host };
}

async function getJwt(cfg: ApnsConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwt.expiresAt - 60 > now) return cachedJwt.token;
  if (!cachedKey) cachedKey = await readFile(cfg.keyPath, "utf-8");
  const token = jwt.sign({ iss: cfg.teamId, iat: now }, cachedKey, {
    algorithm: "ES256",
    header: { alg: "ES256", kid: cfg.keyId },
  });
  // Apple recommends rotating tokens at least every hour, max 60 min.
  cachedJwt = { token, expiresAt: now + 50 * 60 };
  return token;
}

interface DeviceMeta { apnsToken?: string; transport?: string; [k: string]: unknown }

async function send(device: PairedDevice, action: DeviceAction): Promise<void> {
  if (!cachedConfig) return;
  const meta = (device.metadata ?? {}) as DeviceMeta;
  const apnsToken = meta.apnsToken;
  if (!apnsToken) {
    emitEvent("ios:apns", `No APNs token registered for device ${device.id}; skipping push (will be polled)`, "info", {
      metadata: { deviceId: device.id, actionId: action.id },
    });
    return;
  }

  const token = await getJwt(cachedConfig);
  const client = http2.connect(`https://${cachedConfig.host}`);
  try {
    await new Promise<void>((resolve, reject) => {
      const req = client.request({
        ":method": "POST",
        ":path": `/3/device/${apnsToken}`,
        "authorization": `bearer ${token}`,
        "apns-topic": cachedConfig!.bundleId,
        "apns-push-type": "background",
        "apns-priority": "5",
        "content-type": "application/json",
      });
      req.setEncoding("utf-8");
      let status = 0;
      let body = "";
      req.on("response", (headers) => { status = (headers[":status"] as number) || 0; });
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (status >= 200 && status < 300) resolve();
        else reject(new Error(`APNs ${status}: ${body || "no body"}`));
      });
      req.on("error", reject);
      req.end(JSON.stringify({
        aps: { "content-available": 1 },
        rachael: { actionId: action.id, action: action.action },
      }));
    });
    emitEvent("ios:apns", `Pushed wake to device ${device.id} for action ${action.id}`, "info", {
      metadata: { deviceId: device.id, actionId: action.id },
    });
  } finally {
    client.close();
  }
}

/**
 * Wire the APNs sender into the iOS adapter at startup. Called from
 * `initRuntime`. No-op if APNs env vars are not configured.
 */
export function initApnsSender(): void {
  cachedConfig = loadConfig();
  if (!cachedConfig) {
    console.log("[ios-apns] APNs not configured (missing APNS_KEY_PATH/KEY_ID/TEAM_ID/BUNDLE_ID); iOS Shortcuts will use polling only");
    return;
  }
  registerApnsSender(send);
  console.log(`[ios-apns] APNs sender registered (host=${cachedConfig.host}, bundle=${cachedConfig.bundleId})`);
}
