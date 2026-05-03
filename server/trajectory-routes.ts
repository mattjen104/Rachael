import type { Express, Request, Response } from "express";
import { storage } from "./storage";
import {
  redactTraceEvents,
  mintRawUnlock,
  validateRawUnlock,
  revokeRawUnlock,
  redactString,
  loadRedactionPolicy,
  getRedactionRegions,
  renderRedactedSvg,
  getScreenshotProvider,
} from "./redaction";
import {
  createTakeoverPoint,
  recordAction,
  pauseExecution,
  removePausedExecution,
  resolveTakeoverPoint,
  getPausedExecutions,
  getControlState,
} from "./control-bus";
import { getRouterTraceBuffer } from "./cu-router";
import type {
  TrajectoryDiffEntry,
  TrajectoryDiffResponse,
  TrajectoryRunDetail,
  TrajectoryRunSummary,
} from "@shared/trajectory-types";

function authenticate(req: Request, res: Response): boolean {
  const API_KEY = process.env.OPENCLAW_API_KEY;
  if (!API_KEY) return true;
  const auth = req.headers.authorization;
  const headerKey = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const tokenKey = (req.query.token as string | undefined) ?? null;
  if (headerKey === API_KEY || tokenKey === API_KEY) return true;
  res.status(401).json({ message: "Unauthorized" });
  return false;
}

function unlockTokenFromReq(req: Request): string | undefined {
  const header = req.headers["x-unlock-token"];
  if (typeof header === "string" && header) return header;
  if (Array.isArray(header) && header[0]) return header[0];
  return undefined;
}

// Returns the bearer credential the request was authenticated with, so raw
// unlock tokens can be bound to that principal at mint time and verified on
// every use. Falls back to the query-param token (same auth scheme accepted
// by `authenticate`) and finally to an anonymous bucket when no API key is
// configured.
function principalFromReq(req: Request): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const tokenKey = (req.query.token as string | undefined) ?? null;
  if (tokenKey) return tokenKey;
  return "anonymous";
}

function newBranchId(): string {
  return `tb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newChildRunId(parent: string): string {
  return `${parent}#br-${Date.now().toString(36).slice(-6)}`;
}

function diffEventArrays(
  a: Array<Record<string, unknown>>,
  b: Array<Record<string, unknown>>,
): TrajectoryDiffEntry[] {
  const max = Math.max(a.length, b.length);
  const diffs: TrajectoryDiffEntry[] = [];
  for (let i = 0; i < max; i++) {
    const left = a[i];
    const right = b[i];
    if (!left && right) { diffs.push({ stepIndex: i, right: right as never, changed: ["__added__"] }); continue; }
    if (left && !right) { diffs.push({ stepIndex: i, left: left as never, changed: ["__removed__"] }); continue; }
    if (!left || !right) continue;
    const changed: string[] = [];
    const keys = new Set<string>([...Object.keys(left), ...Object.keys(right)]);
    for (const k of Array.from(keys)) {
      if (k === "id" || k === "ts") continue;
      if (JSON.stringify(left[k]) !== JSON.stringify(right[k])) changed.push(k);
    }
    if (changed.length) diffs.push({ stepIndex: i, left: left as never, right: right as never, changed });
  }
  return diffs;
}

export function registerTrajectoryRoutes(app: Express): void {
  app.get("/api/trajectory/policy", async (req, res) => {
    if (!authenticate(req, res)) return;
    const p = loadRedactionPolicy();
    res.json({
      patternCount: p.patterns.length,
      regionCount: p.regions.length,
      stripImageRefs: p.stripImageRefs,
    });
  });

  app.get("/api/trajectory/runs", async (req, res) => {
    if (!authenticate(req, res)) return;
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
    const traces = await storage.listRouterTraces(limit);
    const out: TrajectoryRunSummary[] = traces.map((t) => ({
      runId: t.runId,
      programName: t.programName,
      surfaceKind: t.surfaceKind,
      totalSteps: t.totalSteps,
      tierMisses: t.tierMisses,
      coordClicks: t.coordClicks,
      estimatedCostUsd: t.estimatedCostUsd,
      status: t.status,
      createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : String(t.createdAt),
    }));
    res.json(out);
  });

  app.get("/api/trajectory/runs/:runId", async (req, res) => {
    if (!authenticate(req, res)) return;
    const { runId } = req.params;
    const wantRaw = req.query.raw === "1";
    const unlockToken = unlockTokenFromReq(req);

    const trace = await storage.getRouterTrace(runId);
    if (!trace) {
      const buf = getRouterTraceBuffer(runId);
      if (!buf) return res.status(404).json({ message: "Run not found" });
      const liveEvents = buf as unknown as Array<Record<string, unknown>>;
      const liveRedacted = redactTraceEvents(liveEvents, { raw: false });
      const live: TrajectoryRunDetail = {
        runId,
        programName: null,
        surfaceKind: "",
        totalSteps: liveEvents.length,
        tierMisses: 0,
        coordClicks: 0,
        estimatedCostUsd: "0",
        status: "live",
        createdAt: new Date().toISOString(),
        events: liveRedacted.events as unknown as TrajectoryRunDetail["events"],
        branches: [],
        redactedFieldCount: liveRedacted.redactedFieldCount,
        rawAvailable: false,
        live: true,
      };
      return res.json(live);
    }

    let raw = false;
    if (wantRaw) {
      const entry = validateRawUnlock(unlockToken, runId, principalFromReq(req));
      if (entry) {
        raw = true;
        await storage.createAuditLog({
          actor: "human",
          action: `trajectory.view-raw by ${entry.actor}`,
          target: `run:${runId}`,
          permissionLevel: "approval",
          result: "success",
          details: entry.reason,
        });
      } else {
        return res.status(403).json({ message: "Missing/invalid unlock token (header X-Unlock-Token)" });
      }
    }

    const events = (trace.events ?? []) as Array<Record<string, unknown>>;
    const { events: outEvents, redactedFieldCount } = redactTraceEvents(events, { raw });
    const branches = await storage.listTrajectoryBranchesForRun(runId);

    const detail: TrajectoryRunDetail = {
      runId,
      programName: trace.programName,
      surfaceKind: trace.surfaceKind,
      totalSteps: trace.totalSteps,
      tierMisses: trace.tierMisses,
      coordClicks: trace.coordClicks,
      estimatedCostUsd: trace.estimatedCostUsd,
      status: trace.status,
      createdAt: trace.createdAt instanceof Date ? trace.createdAt.toISOString() : String(trace.createdAt),
      events: outEvents as unknown as TrajectoryRunDetail["events"],
      branches: branches.map((b) => ({
        branchId: b.branchId,
        parentRunId: b.parentRunId,
        parentStepIndex: b.parentStepIndex,
        childRunId: b.childRunId,
        reason: b.reason,
        notes: b.notes,
        createdBy: b.createdBy,
        status: b.status,
        createdAt: b.createdAt instanceof Date ? b.createdAt.toISOString() : String(b.createdAt),
        editedAction: (b.editedAction ?? null) as Record<string, unknown> | null,
      })),
      redactedFieldCount,
      rawAvailable: raw,
    };
    res.json(detail);
  });

  app.post("/api/trajectory/runs/:runId/unlock-raw", async (req, res) => {
    if (!authenticate(req, res)) return;
    const { runId } = req.params;
    const actor = String(req.body?.actor || "analyst");
    const reason = String(req.body?.reason || "manual");
    if (reason.length < 3) return res.status(400).json({ message: "reason must be at least 3 chars (audit-logged)" });
    const trace = await storage.getRouterTrace(runId);
    if (!trace) return res.status(404).json({ message: "Run not found" });

    const { token, expiresAt } = mintRawUnlock(runId, actor, reason, principalFromReq(req));
    await storage.createAuditLog({
      actor: "human",
      action: `trajectory.unlock-raw by ${actor}`,
      target: `run:${runId}`,
      permissionLevel: "approval",
      result: "success",
      details: reason,
    });
    recordAction("human", "trajectory.unlock-raw", `run:${runId}`, "approval", "success", reason);
    // Token returned in JSON body — clients must send it back via X-Unlock-Token
    // header (not as a query param) so it never lands in access logs.
    res.json({ token, expiresAt });
  });

  app.post("/api/trajectory/runs/:runId/lock-raw", async (req, res) => {
    if (!authenticate(req, res)) return;
    const { runId } = req.params;
    const token = unlockTokenFromReq(req);
    const ok = revokeRawUnlock(token);
    if (ok) {
      await storage.createAuditLog({
        actor: "human",
        action: `trajectory.lock-raw`,
        target: `run:${runId}`,
        permissionLevel: "approval",
        result: "success",
      });
    }
    res.json({ revoked: ok });
  });

  app.post("/api/trajectory/runs/:runId/takeover", async (req, res) => {
    if (!authenticate(req, res)) return;
    const { runId } = req.params;
    const { stepIndex, reason, editedAction, notes, actor } = req.body ?? {};
    if (typeof stepIndex !== "number" || stepIndex < 0) {
      return res.status(400).json({ message: "stepIndex (number, >= 0) required" });
    }
    const trace = await storage.getRouterTrace(runId);
    if (!trace && !getRouterTraceBuffer(runId)) return res.status(404).json({ message: "Run not found" });

    const branchId = newBranchId();
    const safeNotes = notes ? redactString(String(notes)).value : null;
    const branch = await storage.createTrajectoryBranch({
      branchId,
      parentRunId: runId,
      parentStepIndex: stepIndex,
      reason: editedAction ? "edit-resume" : "takeover",
      editedAction: (editedAction ?? null) as Record<string, unknown> | null,
      notes: safeNotes,
      createdBy: String(actor || "analyst"),
      status: "pending",
    });

    // True step-state pause: register a paused execution keyed by run/step so
    // the scheduler/runtime sees the pause and stops dispatching at this step.
    pauseExecution({
      type: "program",
      programName: trace?.programName ?? `run:${runId}`,
      stepIndex,
      context: { runId, branchId, editedAction: editedAction ?? null },
    });

    // Create a real cockpit takeover point and capture the control-bus ID
    // it was assigned (createTakeoverPoint pushes synchronously before
    // returning the promise). We persist that ID on the branch row's
    // notes so resume/abort can resolve the exact point later.
    const tpTarget = `run:${runId}#step:${stepIndex}`;
    void createTakeoverPoint(`trajectory-takeover branch=${branchId}`, tpTarget, "approval");
    const created = getControlState().takeoverPoints
      .filter((p) => p.target === tpTarget && p.status === "pending")
      .pop();
    const takeoverPointId = created?.id ?? null;
    if (takeoverPointId) {
      const tag = `[tpid:${takeoverPointId}]`;
      const newNotes = safeNotes ? `${safeNotes} ${tag}` : tag;
      await storage.updateTrajectoryBranchNotes(branchId, newNotes).catch(() => {});
    }

    await storage.createAuditLog({
      actor: "human",
      action: `trajectory.takeover by ${actor || "analyst"}`,
      target: `run:${runId}#step:${stepIndex}`,
      permissionLevel: "approval",
      result: "success",
      details: `branch=${branchId} reason=${reason || "analyst-takeover"}`,
    });

    res.json({ branch });
  });

  // Resume a branch: materialize a real child router trace by copying the
  // parent's events 0..parentStepIndex and appending a synthetic `takeover`
  // event that captures the analyst-edited action. This persists a queryable
  // child run that participates in /diff and /runs the same way any other
  // run does, so the lifecycle is observable end-to-end. We then clear the
  // paused execution and update the branch row with the child runId.
  app.post("/api/trajectory/branches/:branchId/resume", async (req, res) => {
    if (!authenticate(req, res)) return;
    const { branchId } = req.params;
    const branch = await storage.getTrajectoryBranch(branchId);
    if (!branch) return res.status(404).json({ message: "Branch not found" });
    if (branch.status !== "pending") return res.status(409).json({ message: `Branch already ${branch.status}` });

    const parent = await storage.getRouterTrace(branch.parentRunId);
    if (!parent) return res.status(404).json({ message: "Parent run not found" });

    const childRunId = req.body?.childRunId ? String(req.body.childRunId) : newChildRunId(branch.parentRunId);
    const parentEvents = (parent.events ?? []) as Array<Record<string, unknown>>;
    const sliceEnd = Math.min(branch.parentStepIndex + 1, parentEvents.length);
    const carried = parentEvents.slice(0, sliceEnd).map((e, i) => ({ ...e, runId: childRunId, stepIndex: i }));
    const editedAction = (branch.editedAction ?? null) as Record<string, unknown> | null;
    const takeoverEvent: Record<string, unknown> = {
      id: `${childRunId}-takeover`,
      ts: Date.now(),
      runId: childRunId,
      stepIndex: carried.length,
      kind: "takeover",
      surfaceId: (parentEvents[branch.parentStepIndex] as { surfaceId?: string } | undefined)?.surfaceId ?? "",
      surfaceKind: parent.surfaceKind,
      reason: `analyst takeover from branch=${branchId}`,
      actionVerb: editedAction?.verb as string | undefined,
      attemptedLocator: editedAction?.locator as string | undefined,
      metadata: { branchId, editedAction },
    };
    const childEvents = [...carried, takeoverEvent];

    await storage.upsertRouterTrace({
      runId: childRunId,
      programName: parent.programName,
      surfaceKind: parent.surfaceKind,
      events: childEvents,
      totalSteps: childEvents.length,
      tierMisses: parent.tierMisses,
      coordClicks: parent.coordClicks,
      estimatedCostUsd: parent.estimatedCostUsd,
      status: "branch-completed",
    });

    const paused = getPausedExecutions().find((p) => {
      const ctx = (p.context ?? {}) as Record<string, unknown>;
      return ctx.branchId === branchId;
    });
    if (paused) removePausedExecution(paused.id);

    // Drive the actual paused execution lifecycle: resolve the takeover point
    // with the analyst-edited action so any runtime/cockpit listener that
    // awaits this approval continues from this exact state with the new
    // action payload. Best-effort — failures here don't block the branch
    // record from being persisted (the child run is already materialized).
    // Resolve the actual control-bus takeover point by its real ID
    // (captured at takeover time and tagged into branch.notes as
    // [tpid:...]). Falls back to a target-string lookup for branches
    // that pre-date the tagging.
    const tpidMatch = (branch.notes ?? "").match(/\[tpid:([^\]]+)\]/);
    let tpId = tpidMatch?.[1];
    if (!tpId) {
      const target = `run:${branch.parentRunId}#step:${branch.parentStepIndex}`;
      tpId = getControlState().takeoverPoints.find((p) => p.target === target && p.status === "pending")?.id;
    }
    if (tpId) {
      try { resolveTakeoverPoint(tpId, "takeover"); } catch { /* already resolved */ }
    }

    const updated = await storage.updateTrajectoryBranchStatus(branchId, "completed", childRunId);

    await storage.createAuditLog({
      actor: "human",
      action: `trajectory.resume branch=${branchId}`,
      target: `run:${branch.parentRunId}#step:${branch.parentStepIndex}`,
      permissionLevel: "approval",
      result: "success",
      details: `child=${childRunId} carried=${carried.length}`,
    });

    res.json({ branch: updated, childRunId, carriedSteps: carried.length });
  });

  app.post("/api/trajectory/branches/:branchId/abort", async (req, res) => {
    if (!authenticate(req, res)) return;
    const { branchId } = req.params;
    const branch = await storage.getTrajectoryBranch(branchId);
    if (!branch) return res.status(404).json({ message: "Branch not found" });
    if (branch.status !== "pending") return res.status(409).json({ message: `Branch already ${branch.status}` });

    const paused = getPausedExecutions().find((p) => {
      const ctx = (p.context ?? {}) as Record<string, unknown>;
      return ctx.branchId === branchId;
    });
    if (paused) removePausedExecution(paused.id);

    const updated = await storage.updateTrajectoryBranchStatus(branchId, "aborted");
    await storage.createAuditLog({
      actor: "human",
      action: `trajectory.abort branch=${branchId}`,
      target: `run:${branch.parentRunId}#step:${branch.parentStepIndex}`,
      permissionLevel: "approval",
      result: "success",
    });
    res.json({ branch: updated });
  });

  // Plain branch (what-if / replay) — does not pause execution.
  app.post("/api/trajectory/runs/:runId/branch", async (req, res) => {
    if (!authenticate(req, res)) return;
    const { runId } = req.params;
    const { stepIndex, editedAction, notes, actor, childRunId } = req.body ?? {};
    if (typeof stepIndex !== "number") return res.status(400).json({ message: "stepIndex required" });
    const trace = await storage.getRouterTrace(runId);
    if (!trace) return res.status(404).json({ message: "Run not found" });

    const branchId = newBranchId();
    const safeNotes = notes ? redactString(String(notes)).value : null;
    const branch = await storage.createTrajectoryBranch({
      branchId,
      parentRunId: runId,
      parentStepIndex: stepIndex,
      childRunId: childRunId ?? null,
      reason: "what-if",
      editedAction: (editedAction ?? null) as Record<string, unknown> | null,
      notes: safeNotes,
      createdBy: String(actor || "analyst"),
      status: childRunId ? "completed" : "pending",
    });
    res.json({ branch });
  });

  app.get("/api/trajectory/runs/:runId/diff", async (req, res) => {
    if (!authenticate(req, res)) return;
    const { runId } = req.params;
    const otherId = String(req.query.vs || "");
    if (!otherId) return res.status(400).json({ message: "vs query required" });
    const [a, b] = await Promise.all([storage.getRouterTrace(runId), storage.getRouterTrace(otherId)]);
    if (!a || !b) return res.status(404).json({ message: "One or both runs not found" });
    const left = redactTraceEvents((a.events ?? []) as Array<Record<string, unknown>>, { raw: false }).events;
    const right = redactTraceEvents((b.events ?? []) as Array<Record<string, unknown>>, { raw: false }).events;
    const out: TrajectoryDiffResponse = {
      left: { runId, totalSteps: a.totalSteps, status: a.status },
      right: { runId: otherId, totalSteps: b.totalSteps, status: b.status },
      diffs: diffEventArrays(left, right),
    };
    res.json(out);
  });

  // Screenshot pipeline: returns an SVG that composites the original image
  // (when bytes are available via a registered ScreenshotProvider) with the
  // configured RedactionRegion overlays. Without an unlock token the SVG
  // always applies the redaction overlays. The unlock token must be sent via
  // the X-Unlock-Token header (not query param) to keep it out of access logs.
  app.get("/api/trajectory/screenshot/:runId/:imageRef", async (req, res) => {
    if (!authenticate(req, res)) return;
    const { runId, imageRef } = req.params;
    const trace = await storage.getRouterTrace(runId);
    if (!trace && !getRouterTraceBuffer(runId)) return res.status(404).json({ message: "Run not found" });

    const unlockToken = unlockTokenFromReq(req);
    let raw = false;
    if (unlockToken) {
      const entry = validateRawUnlock(unlockToken, runId, principalFromReq(req));
      if (entry) {
        raw = true;
        await storage.createAuditLog({
          actor: "human",
          action: `trajectory.view-screenshot by ${entry.actor}`,
          target: `run:${runId}#img:${imageRef}`,
          permissionLevel: "approval",
          result: "success",
          details: entry.reason,
        });
      }
    }

    // Defense-in-depth: never fetch raw bytes from the provider unless
    // the caller already presented a valid unlock token. The renderer
    // also enforces the same rule (it will not embed bytes when raw=false
    // even if bytes are passed).
    const provider = getScreenshotProvider();
    const image = raw && provider ? await provider(runId, imageRef) : null;
    const meta = image
      ? { width: image.width, height: image.height, bytes: image.bytes, mime: image.mime }
      : { width: 800, height: 480 };
    const regions = getRedactionRegions({ surfaceKind: trace?.surfaceKind, imageRef });
    const svg = renderRedactedSvg(meta, regions, { raw });
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("X-Redacted", raw ? "false" : "true");
    res.setHeader("X-Region-Count", String(regions.length));
    res.setHeader("Cache-Control", "no-store");
    res.send(svg);
  });
}
