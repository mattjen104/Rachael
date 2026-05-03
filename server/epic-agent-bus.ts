// Process-wide command queue for the desktop epic-agent (`tools/epic_agent.py`).
//
// This used to live as a closure inside `registerRoutes` in `server/routes.ts`.
// It was lifted into its own module so other server-side subsystems — chiefly
// the surface adapters wired up in `server/cu-bus.ts` — can submit typed
// commands and await results without going through HTTP back to ourselves.
//
// The wire shape is unchanged: the agent polls `/api/epic/agent/commands`,
// posts `/api/epic/agent/results`, and keeps `epicAgentStatus` fresh via
// `/api/epic/agent/heartbeat`.

export type EpicAgentCommand = {
  id: string;
  type: string;
  env?: string;
} & Record<string, unknown>;

export interface EpicAgentResult {
  commandId: string;
  status: "queued" | "running" | "complete" | "error" | string;
  stage?: string | null;
  screenshot?: string | null;
  data?: any;
  error?: string | null;
  receivedAt?: number;
}

export interface EpicAgentStatus {
  connected: boolean;
  lastSeen: number;
  windows: Array<Record<string, unknown>>;
  capture?: any;
}

const commandQueue: EpicAgentCommand[] = [];
const results = new Map<string, EpicAgentResult>();
const waiters = new Map<string, Array<(r: EpicAgentResult) => void>>();
let status: EpicAgentStatus = { connected: false, lastSeen: 0, windows: [] };

const RESULT_CAP = 50;

let idCounter = 0;
export function genCommandId(prefix = "epic"): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}-${Date.now()}-${idCounter.toString(36)}`;
}

export function enqueueCommand(cmd: EpicAgentCommand): EpicAgentCommand {
  if (!cmd.id) cmd.id = genCommandId();
  commandQueue.push(cmd);
  return cmd;
}

export function drainCommands(): EpicAgentCommand[] {
  return commandQueue.splice(0);
}

export function setResult(result: EpicAgentResult): void {
  result.receivedAt = result.receivedAt ?? Date.now();
  results.set(result.commandId, result);
  if (results.size > RESULT_CAP) {
    const oldest = Array.from(results.keys()).slice(0, results.size - RESULT_CAP);
    for (const k of oldest) results.delete(k);
  }
  // Wake anyone waiting on a terminal status. "running"/"queued" are interim.
  if (result.status === "complete" || result.status === "error") {
    const cbs = waiters.get(result.commandId);
    if (cbs) {
      for (const cb of cbs) cb(result);
      waiters.delete(result.commandId);
    }
  }
}

export function getResult(id: string): EpicAgentResult | undefined {
  return results.get(id);
}

export function listResults(): EpicAgentResult[] {
  return Array.from(results.values());
}

export function awaitResult(id: string, timeoutMs = 30_000): Promise<EpicAgentResult> {
  const existing = results.get(id);
  if (existing && (existing.status === "complete" || existing.status === "error")) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve) => {
    let done = false;
    const cb = (r: EpicAgentResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const cbs = waiters.get(id);
      if (cbs) {
        const idx = cbs.indexOf(cb);
        if (idx >= 0) cbs.splice(idx, 1);
        if (cbs.length === 0) waiters.delete(id);
      }
      resolve({
        commandId: id,
        status: "error",
        error: `Timed out waiting for epic-agent result after ${timeoutMs}ms`,
        receivedAt: Date.now(),
      });
    }, timeoutMs);
    if (!waiters.has(id)) waiters.set(id, []);
    waiters.get(id)!.push(cb);
  });
}

export function setStatus(s: EpicAgentStatus): void {
  status = s;
}

export function getStatus(): EpicAgentStatus {
  return status;
}
