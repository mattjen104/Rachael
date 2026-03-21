export type TaskType = "research" | "code" | "extraction" | "reasoning" | "general";
export type CostTier = "free" | "cheap" | "standard" | "premium";

export interface ModelEntry {
  id: string;
  tier: CostTier;
  strengths: TaskType[];
  label: string;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  qualityScore?: number;
}

const DEFAULT_ROSTER: ModelEntry[] = [
  { id: "google/gemma-3-4b-it:free", tier: "free", strengths: ["general", "reasoning"], label: "Gemma 3 4B", inputCostPer1M: 0, outputCostPer1M: 0 },
  { id: "mistralai/mistral-small-3.1-24b-instruct:free", tier: "free", strengths: ["general", "extraction", "research"], label: "Mistral Small 3.1", inputCostPer1M: 0, outputCostPer1M: 0 },
  { id: "qwen/qwen3-4b:free", tier: "free", strengths: ["general", "reasoning"], label: "Qwen3 4B", inputCostPer1M: 0, outputCostPer1M: 0 },
  { id: "meta-llama/llama-3.2-3b-instruct:free", tier: "free", strengths: ["general", "extraction"], label: "Llama 3.2 3B", inputCostPer1M: 0, outputCostPer1M: 0 },
  { id: "google/gemma-3-12b-it:free", tier: "free", strengths: ["reasoning", "research", "general"], label: "Gemma 3 12B", inputCostPer1M: 0, outputCostPer1M: 0 },

  { id: "deepseek/deepseek-chat", tier: "cheap", strengths: ["code", "reasoning", "research", "general"], label: "DeepSeek V3", inputCostPer1M: 0.27, outputCostPer1M: 1.10 },
  { id: "meta-llama/llama-3.1-70b-instruct", tier: "cheap", strengths: ["research", "reasoning", "general"], label: "Llama 3.1 70B", inputCostPer1M: 0.39, outputCostPer1M: 0.39 },
  { id: "mistralai/mixtral-8x7b-instruct", tier: "cheap", strengths: ["code", "reasoning", "general"], label: "Mixtral 8x7B", inputCostPer1M: 0.24, outputCostPer1M: 0.24 },
  { id: "qwen/qwen-2.5-72b-instruct", tier: "cheap", strengths: ["code", "reasoning", "research"], label: "Qwen 2.5 72B", inputCostPer1M: 0.36, outputCostPer1M: 0.36 },

  { id: "deepseek/deepseek-reasoner", tier: "standard", strengths: ["reasoning", "code", "research"], label: "DeepSeek R1", inputCostPer1M: 0.55, outputCostPer1M: 2.19 },
  { id: "anthropic/claude-3.5-sonnet", tier: "standard", strengths: ["code", "reasoning", "research"], label: "Claude 3.5 Sonnet", inputCostPer1M: 3.0, outputCostPer1M: 15.0 },
  { id: "openai/gpt-4o-mini", tier: "standard", strengths: ["general", "extraction", "code"], label: "GPT-4o Mini", inputCostPer1M: 0.15, outputCostPer1M: 0.60 },
  { id: "google/gemini-pro-1.5", tier: "standard", strengths: ["research", "reasoning", "extraction"], label: "Gemini Pro 1.5", inputCostPer1M: 1.25, outputCostPer1M: 5.0 },

  { id: "anthropic/claude-sonnet-4-6", tier: "premium", strengths: ["code", "reasoning", "research"], label: "Claude Sonnet", inputCostPer1M: 3.0, outputCostPer1M: 15.0 },
  { id: "openai/gpt-4o", tier: "premium", strengths: ["code", "reasoning", "research", "general"], label: "GPT-4o", inputCostPer1M: 2.50, outputCostPer1M: 10.0 },
];

let activeRoster: ModelEntry[] = [...DEFAULT_ROSTER];

export function getModelRoster(): ModelEntry[] {
  return activeRoster;
}

export function setModelRoster(roster: ModelEntry[]): void {
  activeRoster = roster;
}

function recomputeTier(cost: number): CostTier {
  if (cost === 0) return "free";
  if (cost < 1.0) return "cheap";
  if (cost < 5.0) return "standard";
  return "premium";
}

export function mergeRosterUpdates(updates: Partial<ModelEntry & { _remove?: boolean }>[]): number {
  let merged = 0;
  for (const upd of updates) {
    if (!upd.id) continue;
    if (upd._remove) {
      removeFromRoster(upd.id);
      merged++;
      continue;
    }
    const existing = activeRoster.find(m => m.id === upd.id);
    if (existing) {
      if (upd.inputCostPer1M !== undefined) existing.inputCostPer1M = upd.inputCostPer1M;
      if (upd.outputCostPer1M !== undefined) existing.outputCostPer1M = upd.outputCostPer1M;
      if (upd.qualityScore !== undefined) existing.qualityScore = upd.qualityScore;
      if (upd.label) existing.label = upd.label;
      if (upd.inputCostPer1M !== undefined) {
        existing.tier = recomputeTier(upd.inputCostPer1M);
      }
      merged++;
    } else if (upd.tier && upd.label && upd.strengths) {
      if (upd.inputCostPer1M !== undefined) {
        upd.tier = recomputeTier(upd.inputCostPer1M);
      }
      activeRoster.push(upd as ModelEntry);
      merged++;
    }
  }
  return merged;
}

export function removeFromRoster(modelId: string): boolean {
  const idx = activeRoster.findIndex(m => m.id === modelId);
  if (idx === -1) return false;
  activeRoster.splice(idx, 1);
  return true;
}

export function persistQualityScores(storage: { setAgentConfig(key: string, value: string, category: string): Promise<any> }): void {
  const data: Record<string, { successes: number; failures: number }> = {};
  for (const [id, entry] of qualityTracker) {
    data[id] = entry;
  }
  storage.setAgentConfig("model_quality_scores", JSON.stringify(data), "budget").catch(() => {});
}

export async function loadQualityScores(storage: { getAgentConfig(key: string): Promise<{ value: string } | undefined> }): Promise<void> {
  try {
    const cfg = await storage.getAgentConfig("model_quality_scores");
    if (!cfg?.value) return;
    const data = JSON.parse(cfg.value) as Record<string, { successes: number; failures: number }>;
    for (const [id, entry] of Object.entries(data)) {
      qualityTracker.set(id, entry);
      const total = entry.successes + entry.failures;
      if (total >= 3) {
        const score = Math.round((entry.successes / total) * 100);
        const model = activeRoster.find(m => m.id === id);
        if (model) model.qualityScore = score;
      }
    }
  } catch {}
}

export async function loadRosterFromConfig(storage: { getAgentConfig(key: string): Promise<{ value: string } | undefined> }): Promise<void> {
  try {
    const cfg = await storage.getAgentConfig("model_roster_overrides");
    if (!cfg?.value) return;
    const overrides = JSON.parse(cfg.value) as Partial<ModelEntry>[];
    mergeRosterUpdates(overrides);
  } catch {}
}

const qualityTracker = new Map<string, { successes: number; failures: number }>();

export function trackModelQuality(modelId: string, success: boolean): void {
  const normalized = modelId.replace(/^openrouter\//, "");
  const entry = qualityTracker.get(normalized) || { successes: 0, failures: 0 };
  if (success) entry.successes++;
  else entry.failures++;
  qualityTracker.set(normalized, entry);

  const total = entry.successes + entry.failures;
  if (total >= 3) {
    const score = Math.round((entry.successes / total) * 100);
    const model = activeRoster.find(m => m.id === normalized);
    if (model) model.qualityScore = score;
  }
}

export function getModelQuality(): Map<string, { successes: number; failures: number; score: number }> {
  const result = new Map<string, { successes: number; failures: number; score: number }>();
  for (const [id, data] of qualityTracker) {
    const total = data.successes + data.failures;
    result.set(id, { ...data, score: total > 0 ? Math.round((data.successes / total) * 100) : 100 });
  }
  return result;
}

const TIER_ORDER: CostTier[] = ["free", "cheap", "standard", "premium"];

const TASK_KEYWORDS: Record<TaskType, string[]> = {
  research: ["research", "analyze", "investigate", "study", "explore", "find", "discover", "scrape", "survey"],
  code: ["build", "implement", "code", "script", "function", "typescript", "program", "develop", "refactor"],
  extraction: ["extract", "parse", "scrape", "filter", "detect", "identify", "collect", "fetch", "crawl"],
  reasoning: ["reason", "evaluate", "compare", "judge", "decide", "plan", "strategy", "improve", "review", "optimize"],
  general: [],
};

export function detectTaskType(instructions: string, explicitType?: string): TaskType {
  if (explicitType) {
    const normalized = explicitType.toLowerCase().trim() as TaskType;
    if (TASK_KEYWORDS[normalized] !== undefined) return normalized;
  }

  const lower = instructions.toLowerCase();
  let bestType: TaskType = "general";
  let bestScore = 0;

  for (const [type, keywords] of Object.entries(TASK_KEYWORDS)) {
    if (type === "general") continue;
    const score = keywords.filter(kw => lower.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestType = type as TaskType;
    }
  }

  return bestType;
}

export function pickModel(
  taskType: TaskType,
  maxTier: CostTier = "free",
  excludeModels: string[] = []
): ModelEntry | null {
  const maxTierIdx = TIER_ORDER.indexOf(maxTier);

  const candidates = activeRoster.filter(m => {
    if (excludeModels.includes(m.id)) return false;
    const tierIdx = TIER_ORDER.indexOf(m.tier);
    if (tierIdx > maxTierIdx) return false;
    return true;
  });

  candidates.sort((a, b) => {
    const aMatch = a.strengths.includes(taskType) ? 1 : 0;
    const bMatch = b.strengths.includes(taskType) ? 1 : 0;
    if (bMatch !== aMatch) return bMatch - aMatch;
    const aQ = a.qualityScore ?? 100;
    const bQ = b.qualityScore ?? 100;
    if (bQ !== aQ) return bQ - aQ;
    return TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
  });

  return candidates[0] || null;
}

export function pickCascadeModels(
  taskType: TaskType,
  maxTier: CostTier = "free"
): ModelEntry[] {
  const maxTierIdx = TIER_ORDER.indexOf(maxTier);
  const result: ModelEntry[] = [];
  const used = new Set<string>();

  for (let tierIdx = maxTierIdx; tierIdx >= 0; tierIdx--) {
    const tier = TIER_ORDER[tierIdx];
    const tierModels = activeRoster.filter(
      m => m.tier === tier && !used.has(m.id)
    );

    tierModels.sort((a, b) => {
      const aMatch = a.strengths.includes(taskType) ? 1 : 0;
      const bMatch = b.strengths.includes(taskType) ? 1 : 0;
      if (bMatch !== aMatch) return bMatch - aMatch;
      const aQ = a.qualityScore ?? 100;
      const bQ = b.qualityScore ?? 100;
      return bQ - aQ;
    });

    for (const model of tierModels) {
      result.push(model);
      used.add(model.id);
    }
  }

  return result;
}

export function pickCheapThenPremium(
  taskType: TaskType,
  maxTier: CostTier = "premium"
): { cheap: ModelEntry | null; premium: ModelEntry | null } {
  const cheap = pickModel(taskType, "cheap") || pickModel(taskType, "free");
  const maxTierIdx = TIER_ORDER.indexOf(maxTier);
  const premiumTier = maxTierIdx >= 3 ? "premium" : maxTierIdx >= 2 ? "standard" : "cheap";
  const premiumCandidates = activeRoster.filter(m => m.tier === premiumTier && m.strengths.includes(taskType));
  premiumCandidates.sort((a, b) => (b.qualityScore ?? 100) - (a.qualityScore ?? 100));
  return { cheap, premium: premiumCandidates[0] || pickModel(taskType, premiumTier) };
}

export function pickComparisonModels(
  taskType: TaskType,
  maxTier: CostTier = "free"
): [ModelEntry, ModelEntry] | null {
  const maxTierIdx = TIER_ORDER.indexOf(maxTier);
  const candidates = activeRoster.filter(
    m => TIER_ORDER.indexOf(m.tier) <= maxTierIdx
  );

  candidates.sort((a, b) => {
    const aMatch = a.strengths.includes(taskType) ? 1 : 0;
    const bMatch = b.strengths.includes(taskType) ? 1 : 0;
    if (bMatch !== aMatch) return bMatch - aMatch;
    return TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
  });

  if (candidates.length < 2) return null;

  const modelA = candidates[0];
  const modelB = candidates.find(c => c.id !== modelA.id);
  if (!modelB) return null;

  return [modelA, modelB];
}

interface TokenUsageEntry {
  model: string;
  tokens: number;
  timestamp: number;
  programName?: string;
  estimatedCost?: number;
}

const dailyUsage: TokenUsageEntry[] = [];
let lastResetDay = new Date().toDateString();

function resetIfNewDay(): void {
  const today = new Date().toDateString();
  if (today !== lastResetDay) {
    dailyUsage.length = 0;
    lastResetDay = today;
  }
}

export function trackTokenUsage(model: string, tokens: number, programName?: string): void {
  resetIfNewDay();
  const normalized = model.replace(/^openrouter\//, "");
  const entry = activeRoster.find(m => m.id === normalized);
  const costPer1M = entry ? ((entry.inputCostPer1M || 0) + (entry.outputCostPer1M || 0)) / 2 : 0;
  const estimatedCost = (tokens / 1_000_000) * costPer1M;
  dailyUsage.push({ model, tokens, timestamp: Date.now(), programName, estimatedCost });
}

export interface DailyTokenReport {
  total: number;
  totalCost: number;
  byModel: Record<string, number>;
  byProgram: Record<string, { tokens: number; cost: number; calls: number }>;
  entries: number;
}

export function getDailyTokenUsage(): DailyTokenReport {
  resetIfNewDay();
  const byModel: Record<string, number> = {};
  const byProgram: Record<string, { tokens: number; cost: number; calls: number }> = {};
  let total = 0;
  let totalCost = 0;
  for (const entry of dailyUsage) {
    byModel[entry.model] = (byModel[entry.model] || 0) + entry.tokens;
    total += entry.tokens;
    totalCost += entry.estimatedCost || 0;
    if (entry.programName) {
      const prog = byProgram[entry.programName] || { tokens: 0, cost: 0, calls: 0 };
      prog.tokens += entry.tokens;
      prog.cost += entry.estimatedCost || 0;
      prog.calls++;
      byProgram[entry.programName] = prog;
    }
  }
  return { total, totalCost, byModel, byProgram, entries: dailyUsage.length };
}

export function getProgramTokenUsage(programRuns: Array<{ model: string; tokens: number }>): number {
  return programRuns.reduce((sum, r) => sum + r.tokens, 0);
}

const DEFAULT_DAILY_BUDGET = 500_000;

let cachedBudget: number | null = null;
let budgetCacheTime = 0;

export async function getDailyBudget(storage: { getAgentConfig(key: string): Promise<{ value: string } | undefined> }): Promise<number> {
  const now = Date.now();
  if (cachedBudget !== null && now - budgetCacheTime < 300_000) return cachedBudget;
  try {
    const cfg = await storage.getAgentConfig("daily_token_budget");
    if (cfg?.value) {
      const parsed = parseInt(cfg.value, 10);
      if (!isNaN(parsed) && parsed > 0) {
        cachedBudget = parsed;
        budgetCacheTime = now;
        return parsed;
      }
    }
  } catch {}
  cachedBudget = DEFAULT_DAILY_BUDGET;
  budgetCacheTime = now;
  return DEFAULT_DAILY_BUDGET;
}

export function isBudgetExhausted(budget: number): boolean {
  const usage = getDailyTokenUsage();
  return usage.total >= budget;
}

export interface BudgetStatus {
  budget: number;
  used: number;
  remaining: number;
  percentUsed: number;
  exhausted: boolean;
  estimatedCostToday: number;
  report: DailyTokenReport;
}

export async function getBudgetStatus(storage: { getAgentConfig(key: string): Promise<{ value: string } | undefined> }): Promise<BudgetStatus> {
  const budget = await getDailyBudget(storage);
  const report = getDailyTokenUsage();
  const remaining = Math.max(0, budget - report.total);
  return {
    budget,
    used: report.total,
    remaining,
    percentUsed: budget > 0 ? Math.round((report.total / budget) * 100) : 0,
    exhausted: report.total >= budget,
    estimatedCostToday: report.totalCost,
    report,
  };
}

export function parseCostTier(tier: string | undefined): CostTier {
  if (!tier) return "free";
  const normalized = tier.toLowerCase().trim() as CostTier;
  if (TIER_ORDER.includes(normalized)) return normalized;
  return "free";
}

export function estimateTokenCost(model: string, tokens: number): number {
  const normalized = model.replace(/^openrouter\//, "");
  const entry = activeRoster.find(m => m.id === normalized);
  if (!entry) return 0;
  const avgCostPer1M = ((entry.inputCostPer1M || 0) + (entry.outputCostPer1M || 0)) / 2;
  return (tokens / 1_000_000) * avgCostPer1M;
}
