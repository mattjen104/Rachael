// ---------------------------------------------------------------------------
// Budget — travels with each program run. The router refuses any escalation
// that would breach the budget and returns a structured reason. Cheap, mutable
// object on purpose; this is not where we persist state.
// ---------------------------------------------------------------------------

export interface BudgetLimits {
  maxModelSpendUsd: number;
  maxWallTimeMs: number;
  maxActions: number;
  maxCoordClicks: number;
}

export interface BudgetUsage {
  modelSpendUsd: number;
  startedAt: number;
  actions: number;
  coordClicks: number;
}

export interface BudgetCheck {
  ok: boolean;
  reason?: string;
  remaining: {
    spendUsd: number;
    timeMs: number;
    actions: number;
    coordClicks: number;
  };
}

export class Budget {
  readonly limits: BudgetLimits;
  readonly usage: BudgetUsage;

  constructor(limits: Partial<BudgetLimits> = {}, startedAt: number = Date.now()) {
    this.limits = {
      maxModelSpendUsd: limits.maxModelSpendUsd ?? 1.0,
      maxWallTimeMs: limits.maxWallTimeMs ?? 5 * 60_000,
      maxActions: limits.maxActions ?? 200,
      maxCoordClicks: limits.maxCoordClicks ?? 5,
    };
    this.usage = { modelSpendUsd: 0, startedAt, actions: 0, coordClicks: 0 };
  }

  check(addSpendUsd: number = 0, addCoordClick: boolean = false): BudgetCheck {
    const remaining = {
      spendUsd: this.limits.maxModelSpendUsd - this.usage.modelSpendUsd - addSpendUsd,
      timeMs: this.limits.maxWallTimeMs - (Date.now() - this.usage.startedAt),
      actions: this.limits.maxActions - this.usage.actions,
      coordClicks: this.limits.maxCoordClicks - this.usage.coordClicks - (addCoordClick ? 1 : 0),
    };
    if (remaining.spendUsd < 0) return { ok: false, reason: "would exceed maxModelSpendUsd", remaining };
    if (remaining.timeMs < 0) return { ok: false, reason: "would exceed maxWallTimeMs", remaining };
    if (remaining.actions < 0) return { ok: false, reason: "would exceed maxActions", remaining };
    if (remaining.coordClicks < 0) return { ok: false, reason: "would exceed maxCoordClicks", remaining };
    return { ok: true, remaining };
  }

  consume(opts: { spendUsd?: number; action?: boolean; coordClick?: boolean } = {}): void {
    if (opts.spendUsd) this.usage.modelSpendUsd += opts.spendUsd;
    if (opts.action) this.usage.actions += 1;
    if (opts.coordClick) this.usage.coordClicks += 1;
  }

  exhausted(): boolean {
    return !this.check().ok;
  }
}
