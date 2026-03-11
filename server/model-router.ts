export type TaskType = "research" | "code" | "extraction" | "reasoning" | "general";
export type CostTier = "free" | "cheap" | "standard" | "premium";

export interface ModelEntry {
  id: string;
  tier: CostTier;
  strengths: TaskType[];
  label: string;
}

export const MODEL_ROSTER: ModelEntry[] = [
  { id: "meta-llama/llama-3.1-8b-instruct:free", tier: "free", strengths: ["general", "extraction"], label: "Llama 3.1 8B" },
  { id: "google/gemma-3-4b-it:free", tier: "free", strengths: ["general", "reasoning"], label: "Gemma 3 4B" },
  { id: "mistralai/mistral-small-3.1-24b-instruct:free", tier: "free", strengths: ["general", "extraction", "research"], label: "Mistral Small 3.1" },
  { id: "qwen/qwen-2.5-coder-7b-instruct:free", tier: "free", strengths: ["code", "extraction"], label: "Qwen 2.5 Coder" },
  { id: "qwen/qwen3-4b:free", tier: "free", strengths: ["general", "reasoning"], label: "Qwen3 4B" },
  { id: "deepseek/deepseek-r1-0528:free", tier: "free", strengths: ["reasoning", "code", "research"], label: "DeepSeek R1" },

  { id: "meta-llama/llama-3.1-70b-instruct", tier: "cheap", strengths: ["research", "reasoning", "general"], label: "Llama 3.1 70B" },
  { id: "mistralai/mixtral-8x7b-instruct", tier: "cheap", strengths: ["code", "reasoning", "general"], label: "Mixtral 8x7B" },
  { id: "qwen/qwen-2.5-72b-instruct", tier: "cheap", strengths: ["code", "reasoning", "research"], label: "Qwen 2.5 72B" },

  { id: "anthropic/claude-3.5-sonnet", tier: "standard", strengths: ["code", "reasoning", "research"], label: "Claude 3.5 Sonnet" },
  { id: "openai/gpt-4o-mini", tier: "standard", strengths: ["general", "extraction", "code"], label: "GPT-4o Mini" },
  { id: "google/gemini-pro-1.5", tier: "standard", strengths: ["research", "reasoning", "extraction"], label: "Gemini Pro 1.5" },

  { id: "anthropic/claude-sonnet-4-6", tier: "premium", strengths: ["code", "reasoning", "research"], label: "Claude Sonnet" },
  { id: "openai/gpt-4o", tier: "premium", strengths: ["code", "reasoning", "research", "general"], label: "GPT-4o" },
];

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

  const candidates = MODEL_ROSTER.filter(m => {
    if (excludeModels.includes(m.id)) return false;
    const tierIdx = TIER_ORDER.indexOf(m.tier);
    if (tierIdx > maxTierIdx) return false;
    return true;
  });

  candidates.sort((a, b) => {
    const aMatch = a.strengths.includes(taskType) ? 1 : 0;
    const bMatch = b.strengths.includes(taskType) ? 1 : 0;
    if (bMatch !== aMatch) return bMatch - aMatch;
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

  for (let tierIdx = 0; tierIdx <= maxTierIdx; tierIdx++) {
    const tier = TIER_ORDER[tierIdx];
    const tierModels = MODEL_ROSTER.filter(
      m => m.tier === tier && !used.has(m.id)
    );

    tierModels.sort((a, b) => {
      const aMatch = a.strengths.includes(taskType) ? 1 : 0;
      const bMatch = b.strengths.includes(taskType) ? 1 : 0;
      return bMatch - aMatch;
    });

    if (tierModels.length > 0) {
      result.push(tierModels[0]);
      used.add(tierModels[0].id);
    }
  }

  return result;
}

export function pickComparisonModels(
  taskType: TaskType,
  maxTier: CostTier = "free"
): [ModelEntry, ModelEntry] | null {
  const maxTierIdx = TIER_ORDER.indexOf(maxTier);
  const candidates = MODEL_ROSTER.filter(
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

export function trackTokenUsage(model: string, tokens: number): void {
  resetIfNewDay();
  dailyUsage.push({ model, tokens, timestamp: Date.now() });
}

export function getDailyTokenUsage(): { total: number; byModel: Record<string, number> } {
  resetIfNewDay();
  const byModel: Record<string, number> = {};
  let total = 0;
  for (const entry of dailyUsage) {
    byModel[entry.model] = (byModel[entry.model] || 0) + entry.tokens;
    total += entry.tokens;
  }
  return { total, byModel };
}

export function getProgramTokenUsage(programRuns: Array<{ model: string; tokens: number }>): number {
  return programRuns.reduce((sum, r) => sum + r.tokens, 0);
}

export function getModelRoster(): ModelEntry[] {
  return MODEL_ROSTER;
}

export function parseCostTier(tier: string | undefined): CostTier {
  if (!tier) return "free";
  const normalized = tier.toLowerCase().trim() as CostTier;
  if (TIER_ORDER.includes(normalized)) return normalized;
  return "free";
}
