import { randomUUID } from "crypto";
import { emitEvent } from "./event-bus";
import type {
  Action as CuAction,
  Observation as CuObservation,
  ObservationKind,
} from "@rachael/cu-core";
import type { BridgeQueueApi } from "@rachael/cu-core";

const BRIDGE_ONLY_DOMAINS = ["galaxy.epic.com", ".ucsd.edu", "pulse.ucsd.edu", ".reddit.com", "reddit.com", ".live.com", "outlook.live.com", ".office.com", "outlook.office.com", "teams.microsoft.com", ".service-now.com"];
export function isBridgeOnlyDomain(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return BRIDGE_ONLY_DOMAINS.some(d => d.startsWith(".") ? host.endsWith(d) || host === d.slice(1) : host === d);
  } catch { return false; }
}

export interface BridgeJob {
  id: string;
  type: "fetch" | "dom" | "audio";
  url: string;
  options?: {
    headers?: Record<string, string>;
    method?: string;
    selectors?: Record<string, string>;
    includeHtml?: boolean;
    maxHtml?: number;
    maxText?: number;
    spaWaitMs?: number;
    clickSelector?: string;
    clickIndex?: number;
    clickMatchText?: string;
    postClickWaitMs?: number;
    postClickSelector?: string;
    reuseTab?: boolean;
    reuseTabId?: number;
    autoOpenDownload?: boolean;
    pollTimeoutMs?: number;
    fillFields?: Record<string, string>;
    submitSelector?: string;
    fillDelayMs?: number;
    waitAfterSubmitMs?: number;
  };
  submittedBy: string;
  submittedAt: number;
  retryCount: number;
  maxRetries: number;
  // Type-only seam to @rachael/cu-core. The next task will translate
  // BridgeJob into a typed `Action`/`Observation` request; in v1 this is
  // left optional so runtime behavior is unchanged.
  cuAction?: CuAction;
}

export interface BridgeResult {
  jobId: string;
  status?: number;
  contentType?: string;
  body?: any;
  url?: string;
  html?: string;
  text?: string;
  extracted?: Record<string, Array<{ text: string; href?: string; src?: string }>>;
  error?: string;
  completedAt: number;
  source?: "extension" | "playwright" | "direct";
  title?: string;
  clickDebug?: any;
  debug?: any;
  tabId?: number;
  // Type-only seam to @rachael/cu-core; populated by the future bus adapter.
  cuObservation?: CuObservation;
}

// ---------------------------------------------------------------------------
// Live wiring for `BrowserExtensionAdapter`. The adapter (in cu-core) only
// knows about the abstract `BridgeQueueApi`; this is the production binding
// that translates a typed `Action` into the existing job submission shape and
// converts a returned `BridgeResult` into a typed `Observation`.
//
// The translation is intentionally narrow — only the verbs / observation
// kinds the extension actually supports today are routed end-to-end. Anything
// unsupported throws so the router can pick a different surface.
// ---------------------------------------------------------------------------

function _digest(input: string): string {
  // Tiny non-crypto digest matching @rachael/cu-core/digest. We avoid the
  // dependency cycle by reimplementing the 4-byte FNV-1a hash inline.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function _latestResultWithDom(): BridgeResult | null {
  // Walk the in-memory results map for the most recently resolved entry
  // that originated from a real DOM/Goto job on the extension surface.
  // Restrict to `source === "extension"` so a concurrent Playwright
  // workload cannot bleed its DOM into the extension adapter's
  // standalone `observe(DomSnapshot)` reply. Synthetic `cu-wait-*`
  // results (Wait stubs that carry `text: "ok"`) are also filtered.
  let best: BridgeResult | null = null;
  let bestAt = 0;
  for (const r of results.values()) {
    if (typeof r.text !== "string") continue;
    if (r.source !== "extension") continue;
    if (!r.text || r.jobId.startsWith("cu-wait-")) continue;
    const at = r.completedAt ?? 0;
    if (at >= bestAt) {
      best = r;
      bestAt = at;
    }
  }
  return best;
}

function _resultToDom(result: BridgeResult, surfaceId: string): CuObservation {
  const text = result.text ?? "";
  const obs: CuObservation = {
    kind: "DomSnapshot",
    surfaceId,
    timestamp: result.completedAt,
    digest: _digest(`${result.url ?? ""}|${text.slice(0, 4096)}`),
    url: result.url,
    title: result.title,
    text,
    elements: [],
  };
  return obs;
}

export function makeExtensionBridgeQueueApi(
  opts: { surfaceId?: string; submittedBy?: string } = {},
): BridgeQueueApi {
  const surfaceId = opts.surfaceId ?? "browser-extension:default";
  const submittedBy = opts.submittedBy ?? "cu-bus";
  return {
    isAllowed: (url: string) => isBridgeOnlyDomain(url),
    async submit(action: CuAction): Promise<CuObservation | null> {
      // The typed dispatch path: `submitCuAction` stamps the job with the
      // CuAction so `resolveResult` derives a `cuObservation` automatically.
      // We just return that observation. Verbs the queue can't route throw,
      // letting the bus router pick a different surface.
      const id = submitCuAction(action, submittedBy, surfaceId);
      const result = await waitForResult(id);
      if (result.error) throw new Error(result.error);
      // The resolver attaches a DomSnapshot for Goto and a TextDump
      // ("ok") for Wait via `submitCuAction`, both already stamped with
      // the surfaceId we threaded through. Pass through unchanged.
      // We never return null on the typed path — a synthesized TextDump
      // is still a valid typed observation for callers who want a
      // uniform shape.
      if (!result.cuObservation) return null;
      return result.cuObservation;
    },
    async observe(kind: ObservationKind): Promise<CuObservation> {
      if (kind !== "DomSnapshot") {
        throw new Error(`Extension bridge live wiring only emits DomSnapshot today (asked: ${kind})`);
      }
      // The most recent extension result with a DomSnapshot derivation is
      // the honest "current page" answer the queue can give. The router is
      // expected to pair Goto+observe to make this deterministic, but a
      // standalone observe() should still return something useful when a
      // recent navigation exists.
      const recent = _latestResultWithDom();
      if (!recent) {
        throw new Error(
          "Extension bridge observe(DomSnapshot): no recent dom result available; submit a Goto first",
        );
      }
      return _resultToDom(recent, surfaceId);
    },
  };
}

const pendingJobs: BridgeJob[] = [];
const results = new Map<string, BridgeResult>();
const waiters = new Map<string, Array<(result: BridgeResult) => void>>();

const JOB_TTL_MS = 5 * 60 * 1000;
const RESULT_TTL_MS = 10 * 60 * 1000;
const HEARTBEAT_STALE_MS = 90_000;

const VALID_TYPES = new Set(["fetch", "dom"]);
const VALID_SCHEMES = new Set(["http:", "https:", "file:"]);

let bridgeToken: string | null = process.env.BRIDGE_TOKEN || null;
let extensionLastHeartbeat: number | null = null;
let extensionJobsCompleted = 0;
let extensionVersion: string | null = null;
let extensionLastError: string | null = null;

export function getBridgeToken(): string {
  if (!bridgeToken) {
    bridgeToken = process.env.BRIDGE_TOKEN || "46c6eeeb-8404-40cb-9b09-fb379ab4d3c6";
  }
  return bridgeToken;
}

export function setBridgeToken(token: string): void {
  bridgeToken = token;
}

export function validateBridgeToken(token: string | undefined | null): boolean {
  const expected = getBridgeToken();
  return token === expected;
}

export function recordHeartbeat(meta?: { version?: string; jobsCompleted?: number; error?: string | null }): void {
  const wasConnected = isExtensionConnected();
  extensionLastHeartbeat = Date.now();
  if (meta?.version) extensionVersion = meta.version;
  if (meta?.jobsCompleted !== undefined) extensionJobsCompleted = meta.jobsCompleted;
  if (meta?.error !== undefined) extensionLastError = meta.error;
  if (!wasConnected) {
    emitEvent("bridge", `Chrome extension bridge connected${meta?.version ? ` (v${meta.version})` : ""}`, "info");
  }
}

export function isExtensionConnected(): boolean {
  if (!extensionLastHeartbeat) return false;
  return (Date.now() - extensionLastHeartbeat) < HEARTBEAT_STALE_MS;
}

let epicAgentLastHeartbeat: number | null = null;
const EPIC_AGENT_STALE_MS = 60_000;

export function recordEpicAgentHeartbeat(meta?: { version?: string }): void {
  const wasConnected = isEpicAgentConnected();
  epicAgentLastHeartbeat = Date.now();
  if (!wasConnected) {
    emitEvent("bridge", `Epic agent bridge connected${meta?.version ? ` (v${meta.version})` : ""}`, "info");
  }
}

export function isEpicAgentConnected(): boolean {
  if (!epicAgentLastHeartbeat) return false;
  return (Date.now() - epicAgentLastHeartbeat) < EPIC_AGENT_STALE_MS;
}

export function getEpicAgentLastSeen(): number | null {
  return epicAgentLastHeartbeat;
}

// Canonical payload for the Epic agent bridge status. The
// `/api/epic/agent/status` route returns this (merged with route-local fields
// like `windows` and `capture`), so tests and the route both go through the
// same predicate and `connected` cannot drift apart from `isEpicAgentConnected()`.
export function getEpicAgentStatus(): { connected: boolean; lastSeen: number | null } {
  return { connected: isEpicAgentConnected(), lastSeen: epicAgentLastHeartbeat };
}

// Test-only: deterministically set bridge connected states. The "ON" branch
// stamps the heartbeat to "now"; "OFF" clears it so the staleness check fails.
// Kept here (not in a test util) so production gating code and the test agree
// on a single source of truth.
export function __setBridgeStatesForTest(states: { extension?: boolean; epicAgent?: boolean }): void {
  if (states.extension !== undefined) {
    extensionLastHeartbeat = states.extension ? Date.now() : null;
  }
  if (states.epicAgent !== undefined) {
    epicAgentLastHeartbeat = states.epicAgent ? Date.now() : null;
  }
}

export function submitJob(
  type: "fetch" | "dom",
  url: string,
  submittedBy: string,
  options?: BridgeJob["options"],
  maxRetries: number = 2,
  cuAction?: CuAction,
): string {
  if (!VALID_TYPES.has(type)) throw new Error(`Invalid job type: ${type}`);

  try {
    const parsed = new URL(url);
    if (!VALID_SCHEMES.has(parsed.protocol)) throw new Error(`Invalid URL scheme: ${parsed.protocol}`);
  } catch (e: any) {
    if (e.message?.includes("Invalid URL scheme")) throw e;
    throw new Error(`Invalid URL: ${url}`);
  }

  const id = randomUUID();
  pendingJobs.push({ id, type, url, options, submittedBy, submittedAt: Date.now(), retryCount: 0, maxRetries, cuAction });
  if (cuAction) cuActionByJob.set(id, cuAction);
  emitEvent("bridge", `Job queued: ${type} ${url}`, "info", { metadata: { jobId: id, submittedBy } });
  return id;
}

// Side-table mapping jobId → CuAction for jobs that originated from the
// `ComputerUseBus`. We can't read from the in-memory `pendingJobs` after
// `claimJobs` empties it, so we keep the action here until `resolveResult`
// builds the matching `cuObservation`.
const cuActionByJob = new Map<string, CuAction>();
// Side-table from the typed action object → its caller-supplied
// surfaceId; consulted in `resolveResult` when we synthesize
// `cuObservation.surfaceId` so attribution matches the originator.
const cuActionSurfaceById = new WeakMap<object, string>();

// Dispatch a typed `Action` through the bridge queue. Today only `Goto`
// has a natural mapping to the existing extension queue; other verbs throw
// so the router (or caller) can pick a different surface. The result has
// `cuObservation` populated by `resolveResult` when `cuAction` is known.
export function submitCuAction(
  action: CuAction,
  submittedBy: string = "cu-bus",
  surfaceId: string = "browser-extension:default",
): string {
  if (action.verb === "Goto") {
    cuActionSurfaceById.set(action, surfaceId);
    return submitJob("dom", action.url, submittedBy, undefined, 2, action);
  }
  if (action.verb === "Wait") {
    // `Wait.until` requires a verifier-driven polling loop on a specific
    // surface, which the bare bridge queue can't do (it has no surface
    // handle). Reject explicitly so callers route through `bus.act()` on a
    // surface that supports verifiers, rather than silently completing.
    if (action.ms === undefined) {
      throw new Error(
        "bridge-queue submitCuAction(Wait): only `ms` is supported here; " +
          "`until` requires a verifier and must be dispatched via bus.act() on a surface",
      );
    }
    // Wait has no underlying job; synthesize a completed result immediately
    // so callers get a uniform `waitForResult` shape.
    const id = `cu-wait-${randomUUID().slice(0, 8)}`;
    cuActionByJob.set(id, action);
    cuActionSurfaceById.set(action, surfaceId);
    setTimeout(() => {
      resolveResult(id, {
        jobId: id,
        text: "ok",
        completedAt: Date.now(),
        source: "direct",
      });
    }, action.ms);
    return id;
  }
  throw new Error(`bridge-queue submitCuAction does not yet route verb: ${action.verb}`);
}

export function claimJobs(): BridgeJob[] {
  const now = Date.now();
  const expired = pendingJobs.filter(j => now - j.submittedAt > JOB_TTL_MS);
  for (const job of expired) {
    const idx = pendingJobs.indexOf(job);
    if (idx >= 0) pendingJobs.splice(idx, 1);
    resolveResult(job.id, { jobId: job.id, error: "Job expired — extension did not pick it up in time", completedAt: now, source: "extension" });
  }

  const claimed = pendingJobs.splice(0, pendingJobs.length);
  claimed.sort((a, b) => {
    const aP = a.submittedBy?.includes("citrix") ? 0 : 1;
    const bP = b.submittedBy?.includes("citrix") ? 0 : 1;
    return aP - bP;
  });
  return claimed;
}

function requeueJob(job: BridgeJob): void {
  job.retryCount++;
  job.submittedAt = Date.now();
  pendingJobs.push(job);
  emitEvent("bridge", `Retrying job (attempt ${job.retryCount + 1}/${job.maxRetries + 1}): ${job.url}`, "info", { metadata: { jobId: job.id } });
}

export function resolveResult(jobId: string, result: BridgeResult): void {
  if (result.error) {
    const job = pendingJobs.find(j => j.id === jobId);
    if (!job) {
      const originalJob = claimedJobs.get(jobId);
      if (originalJob && originalJob.retryCount < originalJob.maxRetries) {
        claimedJobs.delete(jobId);
        requeueJob(originalJob);
        return;
      }
    }
  }
  claimedJobs.delete(jobId);

  // If the job was a typed cu-action submission, derive the matching
  // `cuObservation` from the result so consumers don't have to repeat the
  // translation. DomSnapshot for Goto, TextDump for Wait/etc.
  const cuAction = cuActionByJob.get(jobId);
  if (cuAction) {
    // Look up the surfaceId the caller stamped at submit time so the
    // synthesized observation is attributed to the originating adapter
    // (e.g. `browser-extension:default`) instead of a generic `cu-bus`.
    const surfaceId = cuActionSurfaceById.get(cuAction) ?? "browser-extension:default";
    if (!result.cuObservation) {
      if (cuAction.verb === "Goto") {
        result.cuObservation = _resultToDom(result, surfaceId);
      } else {
        const text = result.text ?? "ok";
        result.cuObservation = {
          kind: "TextDump",
          surfaceId,
          timestamp: result.completedAt,
          digest: _digest(text.slice(0, 4096)),
          text,
        };
      }
    }
    // Always evict — whether we filled in cuObservation or the producer
    // already supplied one — so the map cannot grow unbounded.
    cuActionByJob.delete(jobId);
    cuActionSurfaceById.delete(cuAction);
  }

  results.set(jobId, result);
  const callbacks = waiters.get(jobId);
  if (callbacks) {
    for (const cb of callbacks) cb(result);
    waiters.delete(jobId);
  }
  setTimeout(() => results.delete(jobId), RESULT_TTL_MS);
}

const claimedJobs = new Map<string, BridgeJob>();

const CLAIMED_TIMEOUT_MS = 60_000;

export function claimJobsTracked(): BridgeJob[] {
  const now = Date.now();
  for (const [id, job] of claimedJobs.entries()) {
    if (now - job.submittedAt > CLAIMED_TIMEOUT_MS) {
      claimedJobs.delete(id);
      if (job.retryCount < job.maxRetries) {
        requeueJob(job);
      } else {
        resolveResult(id, { jobId: id, error: "Extension claimed job but never returned result", completedAt: now, source: "extension" });
      }
    }
  }

  const claimed = claimJobs();
  for (const job of claimed) {
    claimedJobs.set(job.id, { ...job, submittedAt: Date.now() });
  }
  return claimed;
}

export function waitForResult(jobId: string, timeoutMs: number = 30000): Promise<BridgeResult> {
  const existing = results.get(jobId);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    let resolved = false;

    const cb = (result: BridgeResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      const cbs = waiters.get(jobId);
      if (cbs) {
        const idx = cbs.indexOf(cb);
        if (idx >= 0) cbs.splice(idx, 1);
        if (cbs.length === 0) waiters.delete(jobId);
      }
      resolve({ jobId, error: "Timed out waiting for bridge response", completedAt: Date.now() });
    }, timeoutMs);

    if (!waiters.has(jobId)) waiters.set(jobId, []);
    waiters.get(jobId)!.push(cb);
  });
}

export function getQueueStatus(): {
  pending: number;
  completed: number;
  extensionConnected: boolean;
  extensionLastSeen: number | null;
  extensionVersion: string | null;
  extensionJobsCompleted: number;
  extensionLastError: string | null;
  jobs: Array<{ id: string; url: string; submittedBy: string; age: number; retryCount: number }>;
} {
  return {
    pending: pendingJobs.length,
    completed: results.size,
    extensionConnected: isExtensionConnected(),
    extensionLastSeen: extensionLastHeartbeat,
    extensionVersion: extensionVersion,
    extensionJobsCompleted,
    extensionLastError,
    jobs: pendingJobs.map(j => ({
      id: j.id, url: j.url, submittedBy: j.submittedBy,
      age: Date.now() - j.submittedAt, retryCount: j.retryCount
    })),
  };
}

export const bridgeRateLimiter = {
  lastFetchTime: 0,
  inFlight: false,
  requestCount: 0,
  sessionStart: 0,
};

function randomDelay(minMs: number, maxMs: number): number {
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}

export async function waitForBridgeRateLimit(caller: string): Promise<void> {
  const MAX_WAIT_MS = 120000;
  const POLL_MS = 500;
  const startedWaiting = Date.now();

  while (bridgeRateLimiter.inFlight) {
    if (Date.now() - startedWaiting > MAX_WAIT_MS) {
      emitEvent("bridge", `Rate limit wait timeout for ${caller}, proceeding`, "warn");
      break;
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }

  const now = Date.now();
  const SESSION_WINDOW = 10 * 60 * 1000;
  if (now - bridgeRateLimiter.sessionStart > SESSION_WINDOW) {
    bridgeRateLimiter.requestCount = 0;
    bridgeRateLimiter.sessionStart = now;
  }

  if (bridgeRateLimiter.requestCount >= 10) {
    const cooldown = randomDelay(15000, 30000);
    const sinceLast = now - bridgeRateLimiter.lastFetchTime;
    if (sinceLast < cooldown) {
      const waitTime = cooldown - sinceLast;
      emitEvent("bridge", `Bridge cooldown: ${bridgeRateLimiter.requestCount} requests in window, waiting ${Math.round(waitTime / 1000)}s (${caller})`, "info");
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    bridgeRateLimiter.requestCount = 0;
    bridgeRateLimiter.sessionStart = Date.now();
  }

  const sinceLast = Date.now() - bridgeRateLimiter.lastFetchTime;
  const minWait = randomDelay(2000, 5000);
  if (sinceLast < minWait && bridgeRateLimiter.lastFetchTime > 0) {
    await new Promise(resolve => setTimeout(resolve, minWait - sinceLast));
  }

  bridgeRateLimiter.inFlight = true;
  bridgeRateLimiter.lastFetchTime = Date.now();
  bridgeRateLimiter.requestCount++;
}

export function bridgeRequestDone(): void {
  bridgeRateLimiter.inFlight = false;
}

export async function smartFetch(
  url: string,
  type: "fetch" | "dom",
  submittedBy: string,
  options?: BridgeJob["options"],
  timeoutMs: number = 45000
): Promise<BridgeResult> {
  const bridgeOnly = isBridgeOnlyDomain(url);

  if (isExtensionConnected()) {
    await waitForBridgeRateLimit(submittedBy);
    try {
      const jobId = submitJob(type, url, submittedBy, options);
      const result = await waitForResult(jobId, timeoutMs);
      if (!result.error) return result;
      if (bridgeOnly) {
        emitEvent("bridge", `Bridge-only domain ${url} failed: ${result.error} (no direct fallback allowed)`, "warn");
        return result;
      }
      emitEvent("bridge", `Extension bridge failed for ${url}: ${result.error}, trying direct fetch`, "warn");
    } finally {
      bridgeRequestDone();
    }
  }

  if (bridgeOnly) {
    return {
      jobId: "blocked-" + randomUUID().slice(0, 8),
      error: "bridge-only domain — direct fetch blocked (requires browser bridge with real session)",
      completedAt: Date.now(),
      source: "blocked" as any,
    };
  }

  try {
    const fetchOpts: any = { headers: options?.headers || {} };
    if (options?.method) fetchOpts.method = options.method;

    const res = await fetch(url, fetchOpts);
    const contentType = res.headers.get("content-type") || "";
    let body: any;
    if (contentType.includes("json")) {
      body = await res.json();
    } else {
      body = await res.text();
    }

    let text: string | undefined;
    if (typeof body === "string" && type === "dom") {
      text = body
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, options?.maxText || 15000);
    }

    return {
      jobId: "direct-" + randomUUID().slice(0, 8),
      status: res.status,
      contentType,
      body,
      text,
      url: res.url,
      completedAt: Date.now(),
      source: "direct",
    };
  } catch (err: any) {
    return {
      jobId: "direct-" + randomUUID().slice(0, 8),
      error: `Direct fetch failed: ${err.message}`,
      completedAt: Date.now(),
      source: "direct",
    };
  }
}
