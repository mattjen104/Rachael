import { randomUUID, createHmac } from "crypto";

export interface BridgeJob {
  id: string;
  type: "fetch" | "dom";
  url: string;
  options?: {
    headers?: Record<string, string>;
    method?: string;
    selectors?: Record<string, string>;
    includeHtml?: boolean;
    maxHtml?: number;
    maxText?: number;
  };
  submittedBy: string;
  submittedAt: number;
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
}

const pendingJobs: BridgeJob[] = [];
const results = new Map<string, BridgeResult>();
const waiters = new Map<string, Array<(result: BridgeResult) => void>>();

const JOB_TTL_MS = 5 * 60 * 1000;
const RESULT_TTL_MS = 10 * 60 * 1000;

const VALID_TYPES = new Set(["fetch", "dom"]);
const VALID_SCHEMES = new Set(["http:", "https:"]);

let bridgeToken: string | null = null;

export function getBridgeToken(): string {
  if (!bridgeToken) {
    bridgeToken = randomUUID();
  }
  return bridgeToken;
}

export function setBridgeToken(token: string): void {
  bridgeToken = token;
}

export function validateBridgeToken(token: string | undefined | null): boolean {
  if (!bridgeToken) return true;
  return token === bridgeToken;
}

export function submitJob(
  type: "fetch" | "dom",
  url: string,
  submittedBy: string,
  options?: BridgeJob["options"]
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
  pendingJobs.push({ id, type, url, options, submittedBy, submittedAt: Date.now() });
  return id;
}

export function claimJobs(): BridgeJob[] {
  const now = Date.now();
  const expired = pendingJobs.filter(j => now - j.submittedAt > JOB_TTL_MS);
  for (const job of expired) {
    const idx = pendingJobs.indexOf(job);
    if (idx >= 0) pendingJobs.splice(idx, 1);
    resolveResult(job.id, { jobId: job.id, error: "Job expired — extension did not pick it up in time", completedAt: now });
  }

  const claimed = pendingJobs.splice(0, pendingJobs.length);
  return claimed;
}

export function resolveResult(jobId: string, result: BridgeResult): void {
  results.set(jobId, result);
  const callbacks = waiters.get(jobId);
  if (callbacks) {
    for (const cb of callbacks) cb(result);
    waiters.delete(jobId);
  }
  setTimeout(() => results.delete(jobId), RESULT_TTL_MS);
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
      resolve({ jobId, error: "Timed out waiting for extension response", completedAt: Date.now() });
    }, timeoutMs);

    if (!waiters.has(jobId)) waiters.set(jobId, []);
    waiters.get(jobId)!.push(cb);
  });
}

export function getQueueStatus(): { pending: number; completed: number; jobs: Array<{ id: string; url: string; submittedBy: string; age: number }> } {
  return {
    pending: pendingJobs.length,
    completed: results.size,
    jobs: pendingJobs.map(j => ({ id: j.id, url: j.url, submittedBy: j.submittedBy, age: Date.now() - j.submittedAt })),
  };
}
