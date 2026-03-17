import { randomUUID } from "crypto";
import { emitEvent } from "./event-bus";

const BRIDGE_ONLY_DOMAINS = ["galaxy.epic.com", ".ucsd.edu", ".reddit.com", "reddit.com", ".live.com", "outlook.live.com", ".office.com", "outlook.office.com", "teams.microsoft.com", ".service-now.com"];
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
    autoOpenDownload?: boolean;
    pollTimeoutMs?: number;
  };
  submittedBy: string;
  submittedAt: number;
  retryCount: number;
  maxRetries: number;
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
}

const pendingJobs: BridgeJob[] = [];
const results = new Map<string, BridgeResult>();
const waiters = new Map<string, Array<(result: BridgeResult) => void>>();

const JOB_TTL_MS = 5 * 60 * 1000;
const RESULT_TTL_MS = 10 * 60 * 1000;
const HEARTBEAT_STALE_MS = 90_000;

const VALID_TYPES = new Set(["fetch", "dom"]);
const VALID_SCHEMES = new Set(["http:", "https:"]);

let bridgeToken: string | null = process.env.BRIDGE_TOKEN || null;
let extensionLastHeartbeat: number | null = null;
let extensionJobsCompleted = 0;
let extensionVersion: string | null = null;
let extensionLastError: string | null = null;

export function getBridgeToken(): string {
  if (!bridgeToken) {
    bridgeToken = process.env.BRIDGE_TOKEN || randomUUID();
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

export function submitJob(
  type: "fetch" | "dom",
  url: string,
  submittedBy: string,
  options?: BridgeJob["options"],
  maxRetries: number = 2
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
  pendingJobs.push({ id, type, url, options, submittedBy, submittedAt: Date.now(), retryCount: 0, maxRetries });
  emitEvent("bridge", `Job queued: ${type} ${url}`, "info", { metadata: { jobId: id, submittedBy } });
  return id;
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

export async function smartFetch(
  url: string,
  type: "fetch" | "dom",
  submittedBy: string,
  options?: BridgeJob["options"],
  timeoutMs: number = 45000
): Promise<BridgeResult> {
  const bridgeOnly = isBridgeOnlyDomain(url);

  if (isExtensionConnected()) {
    const jobId = submitJob(type, url, submittedBy, options);
    const result = await waitForResult(jobId, timeoutMs);
    if (!result.error) return result;
    if (bridgeOnly) {
      emitEvent("bridge", `Bridge-only domain ${url} failed: ${result.error} (no direct fallback allowed)`, "warn");
      return result;
    }
    emitEvent("bridge", `Extension bridge failed for ${url}: ${result.error}, trying direct fetch`, "warn");
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
