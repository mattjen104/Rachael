import { emitEvent } from "./event-bus";

export interface PhantomTaskRequest {
  prompt: string;
  programName: string;
  iteration: number;
  capabilities?: string[];
  timeout?: number;
}

export interface PhantomTaskResponse {
  content: string;
  status: "success" | "error" | "timeout";
  executionTime?: number;
  cost?: number;
  tokensUsed?: number;
  model?: string;
  error?: string;
}

export interface PhantomHealthStatus {
  available: boolean;
  lastChecked: Date;
  latencyMs?: number;
  version?: string;
  error?: string;
}

interface PhantomHealthPayload {
  version?: string;
}

interface PhantomTaskPayload {
  content?: string;
  result?: string;
  cost?: number;
  tokensUsed?: number;
  model?: string;
  usage?: {
    cost?: number;
    total_tokens?: number;
  };
}

const COMPUTE_KEYWORDS = [
  "install", "docker", "bash", "build", "deploy",
  "container", "infrastructure", "sudo", "apt-get",
  "npm install", "pip install", "compile", "make",
  "filesystem", "server", "ssh", "systemctl",
];

let healthStatus: PhantomHealthStatus = {
  available: false,
  lastChecked: new Date(0),
};

let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

const HEALTH_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_TASK_TIMEOUT_MS = 300_000;

function getPhantomUrl(): string | null {
  return process.env.PHANTOM_URL || null;
}

function getPhantomApiKey(): string | null {
  return process.env.PHANTOM_API_KEY || null;
}

export function isPhantomConfigured(): boolean {
  return !!(getPhantomUrl() && getPhantomApiKey());
}

export function detectComputeTarget(instructions: string): "local" | "phantom" {
  if (!isPhantomConfigured()) return "local";
  const lower = instructions.toLowerCase();
  for (const keyword of COMPUTE_KEYWORDS) {
    if (lower.includes(keyword)) return "phantom";
  }
  return "local";
}

export function getPhantomHealth(): PhantomHealthStatus {
  return { ...healthStatus };
}

function isError(err: unknown): err is Error {
  return err instanceof Error;
}

export async function checkPhantomHealth(): Promise<PhantomHealthStatus> {
  const url = getPhantomUrl();
  const apiKey = getPhantomApiKey();

  if (!url || !apiKey) {
    healthStatus = {
      available: false,
      lastChecked: new Date(),
      error: "PHANTOM_URL or PHANTOM_API_KEY not configured",
    };
    return { ...healthStatus };
  }

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(`${url}/health`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown error");
      healthStatus = {
        available: false,
        lastChecked: new Date(),
        latencyMs: Date.now() - start,
        error: `Health check returned ${res.status}: ${errText}`,
      };
    } else {
      const data: PhantomHealthPayload = await res.json().catch(() => ({}));
      healthStatus = {
        available: true,
        lastChecked: new Date(),
        latencyMs: Date.now() - start,
        version: data.version || undefined,
      };
    }
  } catch (err: unknown) {
    const message = isError(err) ? err.message : String(err);
    const isAbort = isError(err) && err.name === "AbortError";
    healthStatus = {
      available: false,
      lastChecked: new Date(),
      latencyMs: Date.now() - start,
      error: isAbort ? "Health check timed out" : message,
    };
  }

  return { ...healthStatus };
}

export async function executePhantomTask(request: PhantomTaskRequest): Promise<PhantomTaskResponse> {
  const url = getPhantomUrl();
  const apiKey = getPhantomApiKey();

  if (!url || !apiKey) {
    throw new Error("Phantom not configured: PHANTOM_URL or PHANTOM_API_KEY missing");
  }

  const timeoutMs = request.timeout || DEFAULT_TASK_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  emitEvent("phantom", `Sending task to Phantom for "${request.programName}" (iteration ${request.iteration})`, "action", { program: request.programName });

  const start = Date.now();

  try {
    const res = await fetch(`${url}/webhook/task`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: request.prompt,
        programName: request.programName,
        iteration: request.iteration,
        capabilities: request.capabilities || ["bash", "docker", "filesystem", "network"],
        source: "orgcloud",
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const executionTime = Date.now() - start;

    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown error");
      emitEvent("phantom", `Phantom returned error ${res.status} for "${request.programName}": ${errText}`, "error", { program: request.programName });
      return {
        content: "",
        status: "error",
        executionTime,
        error: `Phantom API error ${res.status}: ${errText}`,
      };
    }

    const data: PhantomTaskPayload = await res.json().catch(() => ({}));

    emitEvent("phantom", `Phantom completed task for "${request.programName}" in ${executionTime}ms`, "info", { program: request.programName });

    return {
      content: data.content || data.result || "",
      status: "success",
      executionTime,
      cost: data.cost ?? data.usage?.cost ?? undefined,
      tokensUsed: data.tokensUsed ?? data.usage?.total_tokens ?? undefined,
      model: data.model || "phantom",
    };
  } catch (err: unknown) {
    clearTimeout(timeout);
    const executionTime = Date.now() - start;
    const message = isError(err) ? err.message : String(err);
    const isAbort = isError(err) && err.name === "AbortError";

    if (isAbort) {
      emitEvent("phantom", `Phantom task timed out for "${request.programName}" after ${timeoutMs}ms`, "error", { program: request.programName });
      return {
        content: "",
        status: "timeout",
        executionTime,
        error: `Phantom task timed out after ${timeoutMs}ms`,
      };
    }

    emitEvent("phantom", `Phantom task failed for "${request.programName}": ${message}`, "error", { program: request.programName });
    return {
      content: "",
      status: "error",
      executionTime,
      error: message,
    };
  }
}

export function startPhantomHealthMonitor(): void {
  if (healthCheckInterval) return;

  if (!isPhantomConfigured()) {
    emitEvent("phantom", "Phantom not configured, health monitor not started", "info");
    return;
  }

  checkPhantomHealth().catch(() => {});

  healthCheckInterval = setInterval(() => {
    checkPhantomHealth().catch(err => {
      console.error("[phantom-client] Health check error:", err);
    });
  }, HEALTH_CHECK_INTERVAL_MS);

  emitEvent("phantom", "Phantom health monitor started", "info");
}

export function stopPhantomHealthMonitor(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}
