import { createHash } from "crypto";
import { storage } from "./storage";
import { emitEvent } from "./event-bus";
import type { InsertReceipt, Receipt, ReceiptFeedback } from "@shared/schema";

let cachedLastHash: string | null = null;
let chainInitPromise: Promise<void> | null = null;
let appendChain: Promise<unknown> = Promise.resolve();

const dailyCostByProgram = new Map<string, { date: string; usd: number }>();

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function ensureChainInit(): Promise<void> {
  if (cachedLastHash !== null) return;
  if (chainInitPromise) return chainInitPromise;
  chainInitPromise = (async () => {
    try {
      const last = await storage.getLastReceipt();
      cachedLastHash = last?.hash || "";
    } catch {
      cachedLastHash = "";
    }
  })();
  return chainInitPromise;
}

const PAYLOAD_KEYS = [
  "occurredAt", "programName", "surface", "actionVerb", "target", "targetMeta",
  "trajectoryId", "category", "isObservation", "costTokens", "costUsd",
  "wallClockMs", "verifierScore", "status",
] as const;

function sortDeep(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sortDeep);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    out[k] = sortDeep((v as Record<string, unknown>)[k]);
  }
  return out;
}

function canonicalize(row: Record<string, unknown>): string {
  const ordered: Array<[string, unknown]> = PAYLOAD_KEYS.map((k) => [k, sortDeep(row[k] ?? null)]);
  return JSON.stringify(ordered);
}

function computeHash(prevHash: string, payload: Record<string, unknown>): string {
  return createHash("sha256").update(prevHash + "|" + canonicalize(payload)).digest("hex");
}

export interface RecordReceiptInput {
  programName?: string | null;
  programId?: number | null;
  surface: string;
  actionVerb: string;
  target?: string | null;
  targetMeta?: Record<string, unknown>;
  trajectoryId?: string | null;
  category?: string | null;
  isObservation?: boolean;
  costTokens?: Record<string, number>;
  costUsd?: number | string;
  wallClockMs?: number;
  verifierScore?: number | null;
  /**
   * When omitted (default true), the helper enforces the per-program daily $
   * budget if the program declares one. Set false only for observations and
   * non-action surfaces (eg. ntfy mirroring) where blocking is meaningless.
   */
  enforceBudget?: boolean;
  /** Pre-set status. Defaults to "executed". Use "failed"/"permission-blocked" when caller already knows the outcome. */
  status?: "executed" | "budget-blocked" | "permission-blocked" | "failed";
}

export interface RecordReceiptResult {
  receipt: Receipt;
  blocked: boolean;
}

async function programBudgetUsd(programName: string | null | undefined): Promise<number | null> {
  if (!programName) return null;
  try {
    const prog = await storage.getProgramByName(programName);
    if (!prog?.dailyBudgetUsd) return null;
    const n = parseFloat(prog.dailyBudgetUsd);
    return isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function spentTodayUsd(programName: string): Promise<number> {
  const today = todayKey();
  const cached = dailyCostByProgram.get(programName);
  if (cached && cached.date === today) return cached.usd;
  let total = 0;
  try {
    total = await storage.getReceiptDailyCostUsd(programName, today);
  } catch {
    total = 0;
  }
  dailyCostByProgram.set(programName, { date: today, usd: total });
  return total;
}

function bumpSpend(programName: string, addUsd: number): void {
  const today = todayKey();
  const cached = dailyCostByProgram.get(programName);
  if (cached && cached.date === today) cached.usd += addUsd;
  else dailyCostByProgram.set(programName, { date: today, usd: addUsd });
}

/**
 * Single write helper for the receipts ledger. Serialized through an in-process
 * mutex (`appendChain`) so concurrent callers cannot race on `cachedLastHash`
 * and produce a broken chain. Throws (loudly) on DB failure — callers that
 * want fire-and-forget semantics must use `recordReceiptSafe`.
 */
/**
 * Pre-action gate: returns whether a planned action would exceed the program's
 * daily $ cap. Call this BEFORE performing the side effect; if `blocked` is
 * true, the caller must NOT execute the action and should call
 * `recordReceipt({ status: "budget-blocked", ...})` to log the refusal.
 *
 * Returns { blocked:false } when no budget is configured (nothing to enforce)
 * or when projected spend stays within the cap.
 */
export async function checkBudget(
  programName: string | null | undefined,
  projectedCostUsd: number = 0,
): Promise<{ blocked: boolean; reason?: string; budget?: number; spent?: number }> {
  if (!programName) return { blocked: false };
  const budget = await programBudgetUsd(programName);
  if (budget === null) return { blocked: false };
  const spent = await spentTodayUsd(programName);
  if (spent + projectedCostUsd > budget) {
    return {
      blocked: true,
      budget,
      spent,
      reason: `daily budget $${budget.toFixed(2)} exceeded ($${spent.toFixed(4)} already spent + projected $${projectedCostUsd.toFixed(4)})`,
    };
  }
  return { blocked: false, budget, spent };
}

export async function recordReceipt(input: RecordReceiptInput): Promise<RecordReceiptResult> {
  await ensureChainInit();
  // Serialize all writes — the chain is single-writer by construction.
  const next = appendChain.then(() => doAppend(input));
  appendChain = next.catch(() => undefined);
  return next;
}

async function doAppend(input: RecordReceiptInput): Promise<RecordReceiptResult> {
  const incomingUsd = typeof input.costUsd === "string" ? parseFloat(input.costUsd) || 0 : (input.costUsd || 0);
  let status: NonNullable<RecordReceiptInput["status"]> = input.status || "executed";

  const enforceBudget = input.enforceBudget !== false;
  if (enforceBudget && input.programName && status === "executed") {
    const budget = await programBudgetUsd(input.programName);
    if (budget !== null) {
      const spent = await spentTodayUsd(input.programName);
      if (spent + incomingUsd > budget) {
        status = "budget-blocked";
        emitEvent(
          "receipts",
          `Budget cap hit for "${input.programName}" ($${spent.toFixed(4)} of $${budget.toFixed(2)}); blocking ${input.surface}/${input.actionVerb}`,
          "warn",
          { program: input.programName },
        );
      }
    }
  }

  const occurredAt = new Date();
  const payload: Record<string, unknown> = {
    occurredAt: occurredAt.toISOString(),
    programName: input.programName ?? null,
    surface: input.surface,
    actionVerb: input.actionVerb,
    target: input.target ?? null,
    targetMeta: input.targetMeta || {},
    trajectoryId: input.trajectoryId ?? null,
    category: input.category ?? null,
    isObservation: !!input.isObservation,
    costTokens: input.costTokens || {},
    costUsd: incomingUsd.toFixed(6),
    wallClockMs: Math.max(0, Math.floor(input.wallClockMs || 0)),
    verifierScore: input.verifierScore ?? null,
    status,
  };

  const prevHash = cachedLastHash || "";
  const hash = computeHash(prevHash, payload);

  const insert: InsertReceipt & { occurredAt: Date; prevHash: string; hash: string } = {
    occurredAt,
    programId: input.programId ?? null,
    programName: input.programName ?? null,
    surface: input.surface,
    actionVerb: input.actionVerb,
    target: input.target ?? null,
    targetMeta: input.targetMeta || {},
    trajectoryId: input.trajectoryId ?? null,
    category: input.category ?? null,
    isObservation: !!input.isObservation,
    costTokens: input.costTokens || {},
    costUsd: incomingUsd.toFixed(6),
    wallClockMs: Math.max(0, Math.floor(input.wallClockMs || 0)),
    verifierScore: input.verifierScore ?? null,
    status,
    prevHash,
    hash,
  };

  let receipt: Receipt;
  try {
    receipt = await storage.appendReceipt(insert);
  } catch (err) {
    // Failure is loud — the caller is about to perform (or just performed)
    // an autonomous action without a ledger row. Surface that as a hard error.
    emitEvent(
      "receipts",
      `BLIND ACTION: ledger write failed for ${input.surface}/${input.actionVerb} (${input.programName || "—"}): ${(err as Error)?.message || String(err)}`,
      "error",
      { surface: input.surface, actionVerb: input.actionVerb, program: input.programName ?? null },
    );
    throw err;
  }
  cachedLastHash = hash;

  if (status === "executed" && input.programName && incomingUsd > 0) {
    bumpSpend(input.programName, incomingUsd);
  }

  return { receipt, blocked: status === "budget-blocked" || status === "permission-blocked" };
}

/**
 * Fire-and-forget convenience for non-critical mirror sinks (eg. control-bus
 * passthrough, ntfy notifications). Failures are still **loud** — they emit a
 * blind-action warning to the event bus so the operator sees the gap, even
 * though the calling sink is not awaiting the promise.
 */
export function recordReceiptSafe(input: RecordReceiptInput): void {
  recordReceipt(input).catch((err) => {
    console.error("[receipt-ledger] write failed:", (err as Error)?.message || err);
    // emitEvent already fired from inside doAppend; nothing more to do.
  });
}

/**
 * Strict tamper-evidence walk: re-derive each row's hash from its persisted
 * payload + the prior row's hash, and fail on the first mismatch — either
 * `prevHash` linkage or recomputed-payload hash. This is the authoritative
 * audit signal called by `/api/receipts/verify-chain`.
 */
export async function verifyChain(): Promise<{
  ok: boolean;
  total: number;
  brokenAt: number | null;
  reason?: string;
}> {
  const all = await storage.listReceiptsAsc();
  let prev = "";
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    if (r.prevHash !== prev) {
      return { ok: false, total: all.length, brokenAt: r.id, reason: `prevHash mismatch at id=${r.id} (expected ${prev || "<genesis>"}, got ${r.prevHash || "<empty>"})` };
    }
    const payload = {
      occurredAt: r.occurredAt.toISOString(),
      programName: r.programName ?? null,
      surface: r.surface,
      actionVerb: r.actionVerb,
      target: r.target ?? null,
      targetMeta: r.targetMeta || {},
      trajectoryId: r.trajectoryId ?? null,
      category: r.category ?? null,
      isObservation: !!r.isObservation,
      costTokens: r.costTokens || {},
      costUsd: parseFloat(r.costUsd).toFixed(6),
      wallClockMs: r.wallClockMs,
      verifierScore: r.verifierScore ?? null,
      status: r.status,
    };
    const expected = computeHash(prev, payload);
    if (expected !== r.hash) {
      return { ok: false, total: all.length, brokenAt: r.id, reason: `payload hash mismatch at id=${r.id} (recomputed ${expected.slice(0, 12)}…, stored ${r.hash.slice(0, 12)}…) — row contents have been altered` };
    }
    prev = r.hash;
  }
  return { ok: true, total: all.length, brokenAt: null };
}

/**
 * Apply a 👍/👎 rating to a receipt and propagate the signal:
 *   - the receipt row records `feedback`/`feedbackAt`
 *   - on 👍/👎 we write an `outcome` memory tagged with the trajectoryId so the
 *     trajectory memory + skill library see the operator's verdict on the
 *     next planning pass.
 * Returns the updated receipt (or undefined when the id is unknown).
 */
export async function applyReceiptFeedback(
  id: number,
  feedback: ReceiptFeedback | null,
): Promise<Receipt | undefined> {
  const updated = await storage.setReceiptFeedback(id, feedback);
  if (!updated || !feedback) return updated;

  // Best-effort propagation: an outcome memory row keyed to the program
  // (and trajectoryId in tags) so the next planning loop can weight it.
  try {
    const tags = ["receipt-feedback", `feedback:${feedback}`, `surface:${updated.surface}`];
    if (updated.trajectoryId) tags.push(`trajectory:${updated.trajectoryId}`);
    if (updated.category) tags.push(`category:${updated.category}`);
    await storage.createMemory({
      programName: updated.programName ?? null,
      content: `User rated ${feedback === "up" ? "👍" : "👎"} on ${updated.surface}/${updated.actionVerb}` +
        (updated.target ? ` against ${updated.target}` : "") +
        ` (cost $${parseFloat(updated.costUsd).toFixed(4)}, status=${updated.status}).`,
      memoryType: "outcome",
      tags,
      relevanceScore: feedback === "down" ? 200 : 150,
    });
    emitEvent("receipts", `Feedback ${feedback === "up" ? "👍" : "👎"} → trajectory memory updated for ${updated.programName || updated.surface}`, "info", {
      receiptId: updated.id,
      trajectoryId: updated.trajectoryId,
    });
  } catch (err) {
    console.error("[receipt-ledger] feedback propagation failed:", (err as Error)?.message || err);
  }
  return updated;
}

/**
 * Weekly self-review: scan receipts from the last 7 days, find programs with
 * high spend and low/negative feedback, and emit OpenClaw proposals.
 * Idempotent within the day.
 */
export async function runWeeklySelfReview(): Promise<{ proposalsCreated: number; programsScanned: number }> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const summary = await storage.getReceiptProgramRollup(since);
  let created = 0;
  for (const row of summary) {
    if (!row.programName) continue;
    const totalCost = row.totalCostUsd;
    const downRatio = row.totalCount > 0 ? row.downCount / row.totalCount : 0;
    const upRatio = row.totalCount > 0 ? row.upCount / row.totalCount : 0;
    const failureRatio = row.totalCount > 0 ? row.failedCount / row.totalCount : 0;

    const reasons: string[] = [];
    if (totalCost >= 1.0 && upRatio < 0.05) reasons.push(`spent $${totalCost.toFixed(2)} this week with no positive feedback`);
    if (downRatio >= 0.25) reasons.push(`${(downRatio * 100).toFixed(0)}% of receipts marked 👎`);
    if (failureRatio >= 0.4) reasons.push(`${(failureRatio * 100).toFixed(0)}% of attempts failed/blocked`);
    if (reasons.length === 0) continue;

    const existing = await storage.findPendingProposalForTarget(row.programName, "weekly-self-review");
    if (existing) continue;

    await storage.createProposal({
      section: "programs",
      targetName: row.programName,
      reason: `Weekly self-review: ${reasons.join("; ")}.`,
      currentContent: `program=${row.programName} (week ending ${new Date().toISOString().slice(0, 10)})`,
      proposedContent: `Pause or reduce schedule for program "${row.programName}" pending review. Receipts: ${row.totalCount} actions, $${totalCost.toFixed(4)}, 👍${row.upCount}/👎${row.downCount}, failed=${row.failedCount}.`,
      source: "weekly-self-review",
      proposalType: "change",
    });
    created++;
  }
  emitEvent("receipts", `Weekly self-review complete — scanned ${summary.length} programs, created ${created} proposals`, "info");
  return { proposalsCreated: created, programsScanned: summary.length };
}
