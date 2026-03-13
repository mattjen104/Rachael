import { storage } from "./storage";
import type { PermissionLevel } from "@shared/schema";

export type ControlMode = "human" | "agent";

export interface TakeoverPoint {
  id: string;
  timestamp: Date;
  action: string;
  target?: string;
  permissionLevel: PermissionLevel;
  status: "pending" | "confirmed" | "rejected" | "taken-over";
  resolve?: (decision: "confirm" | "reject" | "takeover") => void;
}

export interface QueuedCommand {
  id: string;
  source: ControlMode;
  action: string;
  target?: string;
  timestamp: Date;
  status: "pending" | "executing" | "completed" | "rejected";
}

export interface PausedExecution {
  id: string;
  type: "program" | "navigation";
  programName?: string;
  profileId?: number;
  navPathId?: number;
  stepIndex: number;
  pausedAt: Date;
  context?: Record<string, unknown>;
}

export interface ControlBusState {
  mode: ControlMode;
  agentPaused: boolean;
  takeoverPoints: TakeoverPoint[];
  activityStream: ActivityEvent[];
  commandQueue: QueuedCommand[];
  pausedExecutions: PausedExecution[];
}

export interface ActivityEvent {
  id: string;
  timestamp: Date;
  actor: ControlMode;
  type: "action" | "takeover-point" | "mode-switch" | "info" | "error" | "command";
  action: string;
  target?: string;
  permissionLevel?: PermissionLevel;
  result?: string;
  details?: string;
}

let idCounter = 0;
function genId(): string {
  return `evt-${Date.now()}-${++idCounter}`;
}

const state: ControlBusState = {
  mode: "human",
  agentPaused: false,
  takeoverPoints: [],
  activityStream: [],
  commandQueue: [],
  pausedExecutions: [],
};

let pauseSignal = false;

const MAX_STREAM_SIZE = 200;
const MAX_QUEUE_SIZE = 50;

function pushActivity(event: Omit<ActivityEvent, "id" | "timestamp">): ActivityEvent {
  const full: ActivityEvent = { id: genId(), timestamp: new Date(), ...event };
  state.activityStream.push(full);
  if (state.activityStream.length > MAX_STREAM_SIZE) {
    state.activityStream = state.activityStream.slice(-MAX_STREAM_SIZE);
  }
  return full;
}

export function getControlState(): ControlBusState {
  return {
    ...state,
    takeoverPoints: [...state.takeoverPoints],
    activityStream: [...state.activityStream],
    commandQueue: [...state.commandQueue],
    pausedExecutions: [...state.pausedExecutions],
  };
}

export function pauseExecution(exec: Omit<PausedExecution, "id" | "pausedAt">): PausedExecution {
  const paused: PausedExecution = { id: genId(), pausedAt: new Date(), ...exec };
  state.pausedExecutions.push(paused);
  pushActivity({ actor: "agent", type: "info", action: `Execution paused: ${exec.type} ${exec.programName || ""} at step ${exec.stepIndex}`, result: "paused" });
  return paused;
}

export function getPausedExecutions(type?: "program" | "navigation"): PausedExecution[] {
  return type ? state.pausedExecutions.filter(e => e.type === type) : [...state.pausedExecutions];
}

export function removePausedExecution(id: string): PausedExecution | null {
  const idx = state.pausedExecutions.findIndex(e => e.id === id);
  if (idx === -1) return null;
  const [removed] = state.pausedExecutions.splice(idx, 1);
  return removed;
}

export function clearPausedExecutions(): void {
  state.pausedExecutions = [];
}

export function getControlMode(): ControlMode {
  return state.mode;
}

export function toggleControlMode(): ControlMode {
  const prev = state.mode;
  if (state.mode === "human") {
    state.mode = "agent";
    state.agentPaused = false;
    pauseSignal = false;
  } else {
    state.mode = "human";
    state.agentPaused = true;
    pauseSignal = true;
    rejectPendingAgentCommands();
  }
  pushActivity({ actor: state.mode, type: "mode-switch", action: `Control switched from ${prev} to ${state.mode}` });
  logAudit(state.mode, `mode-switch`, `${prev} → ${state.mode}`, undefined, "success");
  if (state.mode === "agent") {
    firePausedResumes();
  }
  return state.mode;
}

export function setControlMode(mode: ControlMode): ControlMode {
  if (state.mode === mode) return mode;
  const prev = state.mode;
  state.mode = mode;
  state.agentPaused = mode === "human";
  if (mode === "human") {
    pauseSignal = true;
    rejectPendingAgentCommands();
  } else {
    pauseSignal = false;
  }
  pushActivity({ actor: mode, type: "mode-switch", action: `Control switched from ${prev} to ${mode}` });
  logAudit(mode, "mode-switch", `${prev} → ${mode}`, undefined, "success");
  if (mode === "agent") {
    firePausedResumes();
  }
  return mode;
}

export function isAgentPaused(): boolean {
  return state.agentPaused || state.mode === "human";
}

export function shouldYield(): boolean {
  return pauseSignal;
}

type ResumeCallback = (paused: PausedExecution) => void;
const resumeCallbacks: ResumeCallback[] = [];

export function onResume(cb: ResumeCallback): () => void {
  resumeCallbacks.push(cb);
  return () => {
    const idx = resumeCallbacks.indexOf(cb);
    if (idx !== -1) resumeCallbacks.splice(idx, 1);
  };
}

function firePausedResumes(): void {
  const toResume = [...state.pausedExecutions];
  if (toResume.length > 0) {
    pushActivity({ actor: "agent", type: "info", action: `Resuming ${toResume.length} paused execution(s)` });
  }
  for (const paused of toResume) {
    for (const cb of resumeCallbacks) {
      cb(paused);
    }
  }
}

export function resumeAgent(): void {
  state.agentPaused = false;
  pauseSignal = false;
  if (state.mode !== "agent") {
    state.mode = "agent";
  }
  pushActivity({ actor: "agent", type: "info", action: "Agent resumed" });
  firePausedResumes();
}

export function pauseAgent(): void {
  state.agentPaused = true;
  pauseSignal = true;
  pushActivity({ actor: "human", type: "info", action: "Agent paused" });
}

export function enqueueCommand(
  source: ControlMode,
  action: string,
  target?: string
): QueuedCommand | null {
  if (source === "agent" && isAgentPaused()) {
    pushActivity({ actor: source, type: "command", action, target, result: "rejected-paused" });
    return null;
  }

  if (source === "agent" && state.mode === "human") {
    pushActivity({ actor: source, type: "command", action, target, result: "rejected-human-control" });
    return null;
  }

  const cmd: QueuedCommand = {
    id: genId(),
    source,
    action,
    target,
    timestamp: new Date(),
    status: "pending",
  };
  state.commandQueue.push(cmd);
  if (state.commandQueue.length > MAX_QUEUE_SIZE) {
    state.commandQueue = state.commandQueue.slice(-MAX_QUEUE_SIZE);
  }
  pushActivity({ actor: source, type: "command", action, target, result: "queued" });
  return cmd;
}

export function dequeueCommand(source: ControlMode): QueuedCommand | null {
  if (source === "agent" && state.mode === "human") return null;
  if (source === "agent" && isAgentPaused()) return null;

  const executing = state.commandQueue.find(c => c.status === "executing");
  if (executing && executing.source !== source) {
    return null;
  }

  const idx = state.commandQueue.findIndex(c => c.source === source && c.status === "pending");
  if (idx === -1) return null;
  const cmd = state.commandQueue[idx];
  cmd.status = "executing";
  pushActivity({ actor: source, type: "command", action: `dequeued: ${cmd.action}`, target: cmd.target, result: "executing" });
  return cmd;
}

export function drainQueue(source: ControlMode): QueuedCommand[] {
  const drained: QueuedCommand[] = [];
  let cmd = dequeueCommand(source);
  while (cmd) {
    drained.push(cmd);
    cmd = dequeueCommand(source);
  }
  return drained;
}

export function getQueueDepth(source?: ControlMode): number {
  return state.commandQueue.filter(c => c.status === "pending" && (!source || c.source === source)).length;
}

export function completeCommand(commandId: string, result: string = "success"): void {
  const cmd = state.commandQueue.find(c => c.id === commandId);
  if (cmd) {
    cmd.status = "completed";
    pushActivity({ actor: cmd.source, type: "command", action: cmd.action, target: cmd.target, result });
  }
}

function rejectPendingAgentCommands(): void {
  for (const cmd of state.commandQueue) {
    if (cmd.source === "agent" && cmd.status === "pending") {
      cmd.status = "rejected";
      pushActivity({ actor: "agent", type: "command", action: cmd.action, result: "rejected-takeover" });
    }
  }
}

export async function checkPermission(
  profileId: number | null,
  navPathId: number | null,
  actionDescription: string,
  actionName?: string
): Promise<{ allowed: boolean; level: PermissionLevel; needsApproval: boolean }> {
  let level: PermissionLevel = "autonomous";

  if (navPathId) {
    const navPath = await storage.getNavigationPath(navPathId);
    if (navPath) {
      const actionLevel = actionName ? await getActionPermission(navPath.id, actionName) : null;
      level = actionLevel || (navPath.permissionLevel as PermissionLevel) || "autonomous";
    }
  }

  if (level === "autonomous" && profileId) {
    const profile = await storage.getSiteProfile(profileId);
    if (profile) {
      level = (profile.defaultPermission as PermissionLevel) || "autonomous";
    }
  }

  if (level === "blocked") {
    pushActivity({ actor: "agent", type: "error", action: actionDescription, permissionLevel: "blocked", result: "blocked" });
    logAudit("agent", actionDescription, null, "blocked", "blocked");
    return { allowed: false, level: "blocked", needsApproval: false };
  }

  if (level === "approval") {
    return { allowed: false, level: "approval", needsApproval: true };
  }

  return { allowed: true, level: "autonomous", needsApproval: false };
}

export async function setActionPermission(navPathId: number, actionName: string, level: PermissionLevel): Promise<void> {
  await storage.setActionPermission(navPathId, actionName, level);
  pushActivity({ actor: "human", type: "action", action: `Set action permission: ${actionName} → ${level}`, permissionLevel: level });
  logAudit("human", `set-action-permission: ${actionName}`, String(navPathId), level, "success");
}

export async function getActionPermission(navPathId: number, actionName: string): Promise<PermissionLevel | null> {
  const perm = await storage.getActionPermission(navPathId, actionName);
  return perm ? (perm.permissionLevel as PermissionLevel) : null;
}

export async function getActionPermissions(): Promise<Array<{ navPathId: number; actionName: string; level: string }>> {
  const perms = await storage.getActionPermissions();
  return perms.map(p => ({ navPathId: p.navPathId, actionName: p.actionName, level: p.permissionLevel }));
}

const TAKEOVER_TIMEOUT_MS = 5 * 60 * 1000;

export function createTakeoverPoint(
  action: string,
  target: string | undefined,
  permissionLevel: PermissionLevel
): Promise<"confirm" | "reject" | "takeover"> {
  return new Promise((resolve) => {
    const tp: TakeoverPoint = {
      id: genId(),
      timestamp: new Date(),
      action,
      target,
      permissionLevel,
      status: "pending",
      resolve,
    };
    state.takeoverPoints.push(tp);
    pushActivity({ actor: "agent", type: "takeover-point", action, target, permissionLevel, result: "awaiting" });
    logAudit("agent", `takeover-point: ${action}`, target || null, permissionLevel, "pending");

    setTimeout(() => {
      const idx = state.takeoverPoints.findIndex(p => p.id === tp.id);
      if (idx !== -1 && state.takeoverPoints[idx].status === "pending") {
        state.takeoverPoints[idx].status = "rejected";
        state.takeoverPoints.splice(idx, 1);
        pushActivity({ actor: "agent", type: "info", action: `Takeover point timed out: ${action}`, permissionLevel, result: "timeout" });
        logAudit("agent", `takeover-timeout: ${action}`, target || null, permissionLevel, "timeout");
        resolve("reject");
      }
    }, TAKEOVER_TIMEOUT_MS);
  });
}

export function resolveTakeoverPoint(pointId: string, decision: "confirm" | "reject" | "takeover"): boolean {
  const idx = state.takeoverPoints.findIndex(tp => tp.id === pointId);
  if (idx === -1) return false;
  const tp = state.takeoverPoints[idx];
  if (tp.status !== "pending") return false;

  tp.status = decision === "confirm" ? "confirmed" : decision === "reject" ? "rejected" : "taken-over";
  if (tp.resolve) tp.resolve(decision);

  pushActivity({
    actor: "human",
    type: "action",
    action: `Takeover point ${decision}: ${tp.action}`,
    permissionLevel: tp.permissionLevel,
    result: decision,
  });
  logAudit("human", `resolve-takeover: ${tp.action}`, tp.target || null, tp.permissionLevel, decision);

  if (decision === "takeover") {
    setControlMode("human");
  }

  state.takeoverPoints.splice(idx, 1);
  return true;
}

export function recordAction(
  actor: ControlMode,
  action: string,
  target?: string,
  permissionLevel?: PermissionLevel,
  result: string = "success",
  details?: string
): void {
  pushActivity({ actor, type: "action", action, target, permissionLevel, result, details });
  logAudit(actor, action, target || null, permissionLevel || null, result, details);
}

export function getActivityStream(limit = 50): ActivityEvent[] {
  return state.activityStream.slice(-limit);
}

export function getPendingTakeoverPoints(): TakeoverPoint[] {
  return state.takeoverPoints.filter(tp => tp.status === "pending").map(tp => ({
    ...tp,
    resolve: undefined,
  }));
}

function logAudit(
  actor: ControlMode,
  action: string,
  target: string | null | undefined,
  permissionLevel: PermissionLevel | null | undefined,
  result: string,
  details?: string
): void {
  storage.createAuditLog({
    actor,
    action,
    target: target || null,
    permissionLevel: permissionLevel || null,
    result,
    details: details || null,
  }).catch(err => {
    console.error("[control-bus] Failed to write audit log:", err);
  });
}
