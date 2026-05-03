/**
 * iOS computer-use adapters: ios-shortcuts and ios-wda.
 *
 * Both adapters expose a common Surface-like shape so the smart router (CU-03)
 * can pick whichever satisfies an instruction at the lowest cost. Until CU-02
 * lands, the agent runtime calls these directly via `dispatchToIos`.
 */
import { z } from "zod";
import { storage } from "./storage";
import { emitEvent } from "./event-bus";
import { recordAction, createTakeoverPoint } from "./control-bus";
import { readFile } from "fs/promises";
import { join } from "path";
import type { PairedDevice, DeviceAction } from "@shared/schema";
import type { PermissionLevel } from "@shared/schema";

export type IosAdapter = "ios-shortcuts" | "ios-wda";

interface IosCapability {
  name: string;
  schema: z.ZodTypeAny;
  expectedLatencyMs: number;
  costEstimate: "free" | "low" | "high";
  description: string;
}

export interface IosCapabilityManifest {
  adapter: IosAdapter;
  observations: string[];
  actions: IosCapability[];
}

const SHORTCUTS_ACTIONS: IosCapability[] = [
  { name: "send-imessage", schema: z.object({ recipient: z.string().min(1), body: z.string().min(1).max(2000) }), expectedLatencyMs: 1500, costEstimate: "free", description: "Send an iMessage via the Messages app." },
  { name: "open-url", schema: z.object({ url: z.string().url() }), expectedLatencyMs: 1000, costEstimate: "free", description: "Open a URL in Safari." },
  { name: "run-named-shortcut", schema: z.object({ name: z.string().min(1), input: z.string().optional() }), expectedLatencyMs: 2000, costEstimate: "free", description: "Run a user-authored Shortcut by name." },
  { name: "set-timer", schema: z.object({ seconds: z.number().int().positive().max(86400) }), expectedLatencyMs: 800, costEstimate: "free", description: "Start a Clock app timer." },
  { name: "append-note", schema: z.object({ folder: z.string().min(1), body: z.string().min(1) }), expectedLatencyMs: 1500, costEstimate: "free", description: "Append text to a Notes folder." },
  { name: "append-reminder", schema: z.object({ list: z.string().min(1), body: z.string().min(1) }), expectedLatencyMs: 1500, costEstimate: "free", description: "Add a Reminder to the named list." },
  { name: "query-health", schema: z.object({ metric: z.string().min(1) }), expectedLatencyMs: 2500, costEstimate: "free", description: "Read a HealthKit metric (e.g. steps, heartRate)." },
];

// WDA observations are first-class dispatchable actions: they don't mutate
// device state but the bridge handles them through the same WSS pipe, so the
// router needs to validate & queue them just like an action. Surfacing them
// here also keeps the published manifest honest with the bridge HANDLERS map.
const WDA_OBSERVATIONS: IosCapability[] = [
  { name: "AccessibilityTree", schema: z.object({}), expectedLatencyMs: 600, costEstimate: "low", description: "Dump the WDA accessibility tree (XML/JSON) for the foreground app." },
];

const WDA_ACTIONS: IosCapability[] = [
  // Unified tap: pass either {x,y} for coordinate tap or {elementId} for an
  // accessibility-element click. Bridge dispatches to the right WDA endpoint.
  { name: "Tap", schema: z.union([
      z.object({ x: z.number(), y: z.number(), bundleId: z.string().optional() }),
      z.object({ elementId: z.string().min(1), bundleId: z.string().optional() }),
    ]), expectedLatencyMs: 700, costEstimate: "high", description: "Tap at coordinates {x,y} or by accessibility {elementId}." },
  { name: "Type", schema: z.object({ text: z.string().max(4000), bundleId: z.string().optional() }), expectedLatencyMs: 1500, costEstimate: "high", description: "Type into the focused field." },
  { name: "Swipe", schema: z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), durationSec: z.number().positive().max(5).optional(), bundleId: z.string().optional() }), expectedLatencyMs: 700, costEstimate: "high", description: "Swipe between two points." },
  { name: "KeyHome", schema: z.object({}), expectedLatencyMs: 400, costEstimate: "high", description: "Press the iOS home button." },
  { name: "LaunchApp", schema: z.object({ bundleId: z.string().min(1) }), expectedLatencyMs: 1500, costEstimate: "high", description: "Launch an app by bundle id." },
  { name: "Screenshot", schema: z.object({}), expectedLatencyMs: 500, costEstimate: "high", description: "Capture a screenshot." },
];

export const SHORTCUTS_MANIFEST: IosCapabilityManifest = {
  adapter: "ios-shortcuts",
  observations: ["LastResult"],
  actions: SHORTCUTS_ACTIONS,
};

export const WDA_MANIFEST: IosCapabilityManifest = {
  adapter: "ios-wda",
  observations: ["AccessibilityTree", "Screenshot"],
  actions: WDA_ACTIONS,
};

// Public wire shape — strip the Zod object before serializing.
export interface PublicCapability {
  name: string;
  args: Record<string, string>;
  expectedLatencyMs: number;
  costEstimate: string;
  description: string;
}
export interface PublicManifest {
  adapter: IosAdapter;
  observations: string[];
  actions: PublicCapability[];
}

function describeObjectShape(schema: z.ZodObject<z.ZodRawShape>): Record<string, string> {
  const shape = schema.shape;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(shape)) {
    let typeName: string;
    if (v instanceof z.ZodOptional) {
      const inner = (v as z.ZodOptional<z.ZodTypeAny>)._def.innerType;
      typeName = `${inner._def.typeName.replace(/^Zod/, "").toLowerCase()}?`;
    } else {
      typeName = (v as z.ZodTypeAny)._def.typeName.replace(/^Zod/, "").toLowerCase();
    }
    out[k] = typeName;
  }
  return out;
}

function describeArgs(schema: z.ZodTypeAny): Record<string, string> {
  if (schema instanceof z.ZodObject) return describeObjectShape(schema);
  // For unions (e.g. Tap accepts {x,y} | {elementId}) merge the shapes and
  // mark fields that are not in every branch as optional, so callers see a
  // truthful picture of the accepted argument set.
  if (schema instanceof z.ZodUnion) {
    const branches = (schema as z.ZodUnion<readonly [z.ZodTypeAny, ...z.ZodTypeAny[]]>)._def.options;
    const branchShapes: Record<string, string>[] = [];
    for (const b of branches) {
      if (b instanceof z.ZodObject) branchShapes.push(describeObjectShape(b));
    }
    if (branchShapes.length === 0) return {};
    const merged: Record<string, string> = {};
    const allKeys = new Set<string>();
    branchShapes.forEach(s => Object.keys(s).forEach(k => allKeys.add(k)));
    for (const k of allKeys) {
      const inEvery = branchShapes.every(s => k in s);
      const sample = branchShapes.find(s => k in s)![k];
      const base = sample.endsWith("?") ? sample.slice(0, -1) : sample;
      merged[k] = inEvery && !sample.endsWith("?") ? base : `${base}?`;
    }
    return merged;
  }
  return {};
}

export function getIosCapabilities(adapter: IosAdapter): PublicManifest {
  const manifest = adapter === "ios-shortcuts" ? SHORTCUTS_MANIFEST : WDA_MANIFEST;
  return {
    adapter: manifest.adapter,
    observations: manifest.observations,
    actions: [...manifest.actions, ...(adapter === "ios-wda" ? WDA_OBSERVATIONS : [])].map(a => ({
      name: a.name,
      args: describeArgs(a.schema),
      expectedLatencyMs: a.expectedLatencyMs,
      costEstimate: a.costEstimate,
      description: a.description,
    })),
  };
}

function findCapability(adapter: IosAdapter, action: string): IosCapability | undefined {
  if (adapter === "ios-shortcuts") return SHORTCUTS_ACTIONS.find(a => a.name === action);
  return WDA_ACTIONS.find(a => a.name === action) || WDA_OBSERVATIONS.find(a => a.name === action);
}

// ── Per-app / per-action takeover policy ───────────────────────────────────

export type IosPolicyLevel = "autonomous" | "approval" | "takeover";

interface ShortcutsPolicy {
  default: IosPolicyLevel;
  actions: Record<string, IosPolicyLevel>;
}
interface WdaPolicy {
  default: IosPolicyLevel;
  sensitiveBundles: string[];
  sensitiveBundlePolicy: IosPolicyLevel;
  actions: Record<string, IosPolicyLevel>;
}
interface IosPolicy {
  "ios-shortcuts": ShortcutsPolicy;
  "ios-wda": WdaPolicy;
}

let cachedPolicy: IosPolicy | null = null;
let policyLoadedAt = 0;
const POLICY_TTL_MS = 30_000;

async function loadPolicy(): Promise<IosPolicy> {
  const now = Date.now();
  if (cachedPolicy && now - policyLoadedAt < POLICY_TTL_MS) return cachedPolicy;
  try {
    const path = join(process.cwd(), "config", "ios-takeover-policy.json");
    const raw = await readFile(path, "utf-8");
    cachedPolicy = JSON.parse(raw) as IosPolicy;
    policyLoadedAt = now;
  } catch {
    cachedPolicy = {
      "ios-shortcuts": { default: "approval", actions: {} },
      "ios-wda": { default: "takeover", sensitiveBundles: [], sensitiveBundlePolicy: "takeover", actions: {} },
    };
    policyLoadedAt = now;
  }
  return cachedPolicy;
}

interface ArgsBag { bundleId?: string; targetBundle?: string; [k: string]: unknown }

// WDA actions that mutate phone state inside whatever app is foregrounded.
// If the caller doesn't tell us which app, we cannot prove it is safe — so we
// fail safe to the sensitive-bundle policy (typically `takeover`).
const HIGH_IMPACT_WDA_ACTIONS = new Set(["Tap", "Type", "Swipe", "KeyHome"]);

export async function resolvePolicy(
  adapter: IosAdapter,
  action: string,
  args: ArgsBag
): Promise<IosPolicyLevel> {
  const policy = await loadPolicy();
  if (adapter === "ios-shortcuts") {
    return policy["ios-shortcuts"].actions[action] || policy["ios-shortcuts"].default;
  }
  const wda = policy["ios-wda"];
  const bundle = typeof args.bundleId === "string" ? args.bundleId : (typeof args.targetBundle === "string" ? args.targetBundle : undefined);

  // Per-action override (e.g. an explicit policy entry for "Screenshot")
  // takes precedence over bundle-level policy.
  const actionOverride = wda.actions[action];

  if (bundle) {
    if (wda.sensitiveBundles.includes(bundle)) return wda.sensitiveBundlePolicy;
    return actionOverride || wda.default;
  }

  // Unknown app context. For high-impact actions we cannot confirm we're not
  // in Messages/Mail/Health/banking, so apply the sensitive policy as a
  // fail-safe. Non-mutating actions (Screenshot, LaunchApp explicitly takes
  // bundleId, AccessibilityTree) fall through to their normal policy.
  if (HIGH_IMPACT_WDA_ACTIONS.has(action)) {
    return wda.sensitiveBundlePolicy;
  }
  return actionOverride || wda.default;
}

function policyToPermissionLevel(p: IosPolicyLevel): PermissionLevel {
  if (p === "takeover") return "blocked";
  if (p === "approval") return "approval";
  return "autonomous";
}

// ── Dispatch ───────────────────────────────────────────────────────────────

export interface DispatchOptions {
  source?: string;
  preferredAdapter?: IosAdapter;
  allowFallback?: boolean;
}

export interface DispatchResult {
  ok: boolean;
  adapter: IosAdapter;
  deviceId: number;
  actionId: number;
  status: string;
  result?: Record<string, unknown>;
  error?: string;
  echoOnly?: boolean;
  screenshotActionId?: number;
}

interface DeviceMetadata { transport?: "polling" | "apns"; apnsToken?: string; [k: string]: unknown }

function pickDevice(devices: PairedDevice[], adapter: IosAdapter): PairedDevice | undefined {
  return devices.find(d => d.kind === adapter && !d.revoked);
}
function getDeviceMetadata(d: PairedDevice): DeviceMetadata {
  return (d.metadata ?? {}) as DeviceMetadata;
}

/**
 * Dispatch an action to an iOS device. Picks Shortcuts first when the action
 * matches a known Shortcut, falls back to WDA otherwise. If a Shortcut
 * dispatch fails (no device, queue/transport error), automatically escalates
 * to WDA once.
 */
export async function dispatchToIos(
  action: string,
  args: ArgsBag,
  opts: DispatchOptions = {}
): Promise<DispatchResult> {
  const allDevices = await storage.getPairedDevices({});
  const iosDevices = allDevices.filter(d => d.kind === "ios-shortcuts" || d.kind === "ios-wda");

  if (iosDevices.length === 0) {
    return { ok: false, adapter: "ios-shortcuts", deviceId: 0, actionId: 0, status: "no-device", error: "No iOS device paired" };
  }

  const shortcutsActionNames = new Set(SHORTCUTS_ACTIONS.map(a => a.name));
  let preferred: IosAdapter;
  if (opts.preferredAdapter) preferred = opts.preferredAdapter;
  else if (shortcutsActionNames.has(action)) preferred = "ios-shortcuts";
  else preferred = "ios-wda";

  const tryDispatch = async (adapter: IosAdapter): Promise<DispatchResult> => {
    const cap = findCapability(adapter, action);
    if (!cap) {
      return { ok: false, adapter, deviceId: 0, actionId: 0, status: "unknown-action", error: `Unknown action ${action} for ${adapter}` };
    }
    const parsed = cap.schema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, adapter, deviceId: 0, actionId: 0, status: "bad-args", error: `Invalid args: ${parsed.error.message}` };
    }
    const cleanArgs = parsed.data as Record<string, unknown>;

    const device = pickDevice(iosDevices, adapter);
    if (!device) {
      return { ok: false, adapter, deviceId: 0, actionId: 0, status: "no-device", error: `No ${adapter} device paired` };
    }

    const policy = await resolvePolicy(adapter, action, cleanArgs as ArgsBag);
    const permissionLevel = policyToPermissionLevel(policy);
    const echoOnly = !device.armed;

    emitEvent(`ios:${adapter}`, `${action}${echoOnly ? " (echo-only)" : ""}`, "action", {
      metadata: { deviceId: device.id, args: cleanArgs, policy },
    });

    if (policy === "takeover" || (policy === "approval" && !device.armed)) {
      const decision = await createTakeoverPoint(`ios/${adapter}: ${action}`, JSON.stringify(cleanArgs).slice(0, 200), permissionLevel);
      if (decision !== "confirm") {
        recordAction("agent", `ios/${adapter}/${action}`, device.name, permissionLevel, "blocked", `policy=${policy}`);
        return { ok: false, adapter, deviceId: device.id, actionId: 0, status: "blocked", error: `Blocked by policy=${policy}` };
      }
    }

    const meta = getDeviceMetadata(device);
    const transport = adapter === "ios-wda" ? "wda" : meta.transport === "polling" ? "polling" : "apns";

    const queued = await storage.enqueueDeviceAction({
      deviceId: device.id,
      action,
      args: cleanArgs,
      source: opts.source || "agent",
      transport,
    });

    if (echoOnly) {
      await storage.completeDeviceAction(queued.id, { echoOnly: true, would: { action, args: cleanArgs } }, "echo-only");
      recordAction("agent", `ios/${adapter}/${action}`, device.name, permissionLevel, "echo-only");
      return { ok: true, adapter, deviceId: device.id, actionId: queued.id, status: "echo-only", echoOnly: true };
    }

    // For WDA, every armed action gets an automatic screenshot follow-up so
    // the audit trail captures visual evidence (Task 102 requirement).
    let screenshotActionId: number | undefined;
    if (adapter === "ios-wda" && action !== "Screenshot") {
      const shot = await storage.enqueueDeviceAction({
        deviceId: device.id,
        action: "Screenshot",
        args: { auditFor: queued.id },
        source: "audit",
        transport: "wda",
      });
      screenshotActionId = shot.id;
    }

    try {
      await maybePushApns(device, queued);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emitEvent(`ios:${adapter}`, `APNs push failed: ${msg}`, "warn", { metadata: { deviceId: device.id, actionId: queued.id } });
    }

    recordAction("agent", `ios/${adapter}/${action}`, device.name, permissionLevel, "queued", `actionId=${queued.id}${screenshotActionId ? ` screenshotId=${screenshotActionId}` : ""}`);
    return { ok: true, adapter, deviceId: device.id, actionId: queued.id, status: "queued", screenshotActionId };
  };

  const first = await tryDispatch(preferred);
  if (first.ok || preferred === "ios-wda" || opts.allowFallback === false) return first;

  // Only escalate Shortcuts→WDA on transport/device errors, not on bad-args.
  if (first.status === "bad-args" || first.status === "unknown-action" || first.status === "blocked") return first;

  emitEvent("ios:router", `Shortcuts dispatch failed (${first.error || first.status}); escalating to WDA`, "warn");
  const second = await tryDispatch("ios-wda");
  return second;
}

// ── APNs hook (optional) ───────────────────────────────────────────────────

let apnsSender: ((device: PairedDevice, action: DeviceAction) => Promise<void>) | null = null;

export function registerApnsSender(fn: (device: PairedDevice, action: DeviceAction) => Promise<void>): void {
  apnsSender = fn;
}

async function maybePushApns(device: PairedDevice, action: DeviceAction): Promise<void> {
  if (!apnsSender) return;
  if (getDeviceMetadata(device).transport === "polling") return;
  await apnsSender(device, action);
}

// ── Wait helper for callers that want a synchronous-style result ──────────

export async function waitForActionResult(
  actionId: number,
  timeoutMs: number = 30_000
): Promise<DeviceAction | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const a = await storage.getDeviceAction(actionId);
    if (a && (a.status === "completed" || a.status === "failed" || a.status === "echo-only")) return a;
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}
