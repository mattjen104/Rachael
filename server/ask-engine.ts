import { storage } from "./storage";
import { executeLLM, hasLLMKeys, type LLMMessage, type LLMConfig } from "./llm-client";
import { emitEvent } from "./event-bus";
import { searchMemoriesHybrid } from "./memory-consolidation";
import {
  getModelRoster, pickModel, pickCheapThenPremium, trackTokenUsage,
  estimateTokenCost,
  type ModelEntry, type CostTier,
} from "./model-router";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const LOCAL_GEN_MODEL = process.env.LOCAL_GEN_MODEL || "qwen2.5:0.5b";

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface AskResult {
  answer: string;
  model: string;
  tokensUsed: number;
  cost: number;
  routingReason: string;
  fromKb?: boolean;
  compressed?: boolean;
  tokensSaved?: number;
  preprocessModel?: string;
  preprocessCost?: number;
}

interface CompareResult {
  results: Array<{
    model: string;
    label: string;
    tier: CostTier;
    answer: string;
    tokensUsed: number;
    cost: number;
    durationMs: number;
  }>;
}

type QueryComplexity = "simple" | "moderate" | "complex";

interface ClassificationResult {
  complexity: QueryComplexity;
  intent: "question" | "command" | "followup";
  source: "cheap-llm" | "local" | "heuristic";
}

const conversationHistory: ConversationTurn[] = [];
const MAX_HISTORY = 3;
const HISTORY_TTL_MS = 10 * 60 * 1000;

let localFallbackEnabled = false;
let localModelLoaded = false;

let preprocessStats = {
  queriesProcessed: 0,
  tokensSaved: 0,
  preprocessTokensUsed: 0,
  preprocessCost: 0,
  kbDirectHits: 0,
  qualityGateCatches: 0,
};

let preferredModel: string | null = null;

const CONTEXT_COMPRESS_THRESHOLD = 3000;

function pruneStaleHistory(): void {
  const cutoff = Date.now() - HISTORY_TTL_MS;
  while (conversationHistory.length > 0 && conversationHistory[0].timestamp < cutoff) {
    conversationHistory.shift();
  }
  while (conversationHistory.length > MAX_HISTORY * 2) {
    conversationHistory.shift();
  }
}

function addToHistory(role: "user" | "assistant", content: string): void {
  conversationHistory.push({ role, content, timestamp: Date.now() });
}

export function resetConversation(): void {
  conversationHistory.length = 0;
}

export function isLocalFallbackEnabled(): boolean {
  return localFallbackEnabled;
}

export async function setLocalFallback(enabled: boolean): Promise<void> {
  localFallbackEnabled = enabled;
  await storage.setAgentConfig("ask_local_fallback", enabled ? "on" : "off", "ask");
  if (!enabled) {
    localModelLoaded = false;
  }
}

export async function getPreprocessStatus(): Promise<{
  localFallback: boolean;
  localModelLoaded: boolean;
  localModelName: string;
  ramUsage: string;
  queriesProcessed: number;
  tokensSavedEstimate: number;
  preprocessTokensUsed: number;
  preprocessCost: number;
  kbDirectHits: number;
  qualityGateCatches: number;
}> {
  await loadConfig();
  const ramUsage = await getOllamaRamUsage();
  return {
    localFallback: localFallbackEnabled,
    localModelLoaded: localModelLoaded,
    localModelName: LOCAL_GEN_MODEL,
    ramUsage,
    queriesProcessed: preprocessStats.queriesProcessed,
    tokensSavedEstimate: preprocessStats.tokensSaved,
    preprocessTokensUsed: preprocessStats.preprocessTokensUsed,
    preprocessCost: preprocessStats.preprocessCost,
    kbDirectHits: preprocessStats.kbDirectHits,
    qualityGateCatches: preprocessStats.qualityGateCatches,
  };
}

export async function setPreferredModel(modelRef: string): Promise<void> {
  const cleared = ["auto", "none", "clear", "reset", ""].includes(modelRef.toLowerCase().trim());
  preferredModel = cleared ? null : modelRef;
  await storage.setAgentConfig("ask_preferred_model", preferredModel || "", "ask");
}

export function getPreferredModel(): string | null {
  return preferredModel;
}

async function loadConfig(): Promise<void> {
  try {
    const cfg = await storage.getAgentConfig("ask_local_fallback");
    localFallbackEnabled = cfg?.value === "on";
    const prefCfg = await storage.getAgentConfig("ask_preferred_model");
    if (prefCfg?.value) {
      preferredModel = prefCfg.value;
    } else {
      preferredModel = null;
    }
  } catch {}
}

async function getOllamaRamUsage(): Promise<string> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/ps`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return "unavailable";
    const data = await resp.json() as { models?: Array<{ name: string; size: number }> };
    if (!data.models || data.models.length === 0) return "no models loaded";
    const genModel = data.models.find(m => m.name.includes(LOCAL_GEN_MODEL.split(":")[0]));
    if (genModel) {
      const mb = Math.round(genModel.size / 1024 / 1024);
      return `${mb} MB (${genModel.name})`;
    }
    const totalMb = data.models.reduce((s, m) => s + m.size, 0) / 1024 / 1024;
    return `${Math.round(totalMb)} MB total (${data.models.length} models)`;
  } catch {
    return "unavailable";
  }
}

function getCheapModel(): ModelEntry | null {
  return pickModel("general", "cheap");
}

async function getLLMConfig(): Promise<LLMConfig> {
  const configs = await storage.getAgentConfigs();
  const configMap: Record<string, string> = {};
  for (const c of configs) {
    configMap[c.key] = c.value;
  }
  return {
    defaultModel: configMap["default_model"] || "openrouter/anthropic/claude-sonnet-4",
    aliases: {},
    routing: {},
  };
}

async function cheapLLMCall(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number = 100,
  llmConfig?: LLMConfig
): Promise<{ content: string; tokensUsed: number; cost: number; model: string } | null> {
  const cheap = getCheapModel();
  if (!cheap) return null;
  const config = llmConfig || await getLLMConfig();

  try {
    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const result = await executeLLM(messages, cheap.id, config, {}, { maxTokens });
    const tokens = result.tokensUsed || 0;
    const cost = result.cost || estimateTokenCost(result.model || cheap.id, tokens);

    preprocessStats.preprocessTokensUsed += tokens;
    preprocessStats.preprocessCost += cost;
    trackTokenUsage(result.model || cheap.id, tokens, "ask-preprocess");

    return { content: result.content, tokensUsed: tokens, cost, model: result.model || cheap.id };
  } catch (err: any) {
    emitEvent("ask", `Cheap pre-process call failed: ${err.message}`, "warn");
    return null;
  }
}


async function classifyWithCheapLLM(query: string, llmConfig: LLMConfig): Promise<ClassificationResult | null> {
  const result = await cheapLLMCall(
    "You are a query classifier. Respond with ONLY a JSON object, no other text.",
    `Classify this query:
"${query}"

Respond: {"complexity":"simple|moderate|complex","intent":"question|command|followup"}

Rules:
- simple: factual lookup, definition, yes/no, single fact
- moderate: explanation, comparison, how-to, summarization
- complex: reasoning, analysis, multi-step, opinion, strategy, trade-offs
- command: looks like a CLI command (e.g. "run program X", "show status")
- followup: references previous conversation ("tell me more", "what about", "and", "also")
- question: new standalone question

JSON:`,
    60,
    llmConfig
  );

  if (!result) return null;

  try {
    const cleaned = result.content.replace(/```json\s*/g, "").replace(/```/g, "").trim();
    const match = cleaned.match(/\{[^}]+\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (parsed.complexity && parsed.intent) {
      return { complexity: parsed.complexity, intent: parsed.intent, source: "cheap-llm" };
    }
    return null;
  } catch {
    return null;
  }
}

async function filterMemoriesWithCheapLLM(
  query: string,
  memories: Array<{ id: number; content: string }>,
  llmConfig: LLMConfig
): Promise<Array<{ id: number; content: string }>> {
  if (memories.length <= 8) return memories;

  const numbered = memories.map((m, i) => `${i + 1}. ${m.content.slice(0, 200)}`).join("\n");

  const result = await cheapLLMCall(
    "You filter memory snippets for relevance. Given a question and numbered memory items, return ONLY the numbers of items that are relevant to answering the question. Respond with comma-separated numbers, nothing else.",
    `Question: "${query}"

Memories:
${numbered}

Return the numbers of the 5-8 most relevant items (comma-separated):`,
    40,
    llmConfig
  );

  if (!result) return memories.slice(0, 8);

  const nums = result.content.match(/\d+/g)?.map(n => parseInt(n, 10)).filter(n => n >= 1 && n <= memories.length) || [];
  if (nums.length === 0) return memories.slice(0, 8);

  const filtered = nums.slice(0, 8).map(n => memories[n - 1]).filter(Boolean);
  return filtered.length > 0 ? filtered : memories.slice(0, 8);
}

async function verifyKbAnswer(
  query: string,
  kbTitle: string,
  kbSummary: string,
  llmConfig: LLMConfig
): Promise<"yes" | "no" | "partial"> {
  const result = await cheapLLMCall(
    "You verify whether a knowledge base article answers a user's question. Respond with ONLY one word: YES, NO, or PARTIAL.",
    `Question: "${query}"
KB article: "${kbTitle}"
Summary: "${kbSummary.slice(0, 600)}"

Does this KB article directly and fully answer the question? Reply YES, NO, or PARTIAL:`,
    5,
    llmConfig
  );

  if (!result) return "partial";
  const answer = result.content.trim().toUpperCase();
  if (answer.startsWith("YES")) return "yes";
  if (answer.startsWith("NO")) return "no";
  return "partial";
}

async function qualityGateKbAnswer(
  query: string,
  kbAnswer: string,
  llmConfig: LLMConfig
): Promise<{ pass: boolean; improved?: string }> {
  const result = await cheapLLMCall(
    "You are a quality checker. Given a question and a proposed answer from a knowledge base, decide if the answer is good enough to return directly. If it's good, respond with 'PASS'. If it's not good enough (wrong, incomplete, or only tangentially related), respond with 'FAIL' followed by a brief corrected/improved answer on the next line.",
    `Question: "${query}"

Proposed KB answer:
${kbAnswer.slice(0, 1500)}

Is this a good, complete answer to the question? Reply PASS or FAIL:`,
    300,
    llmConfig
  );

  if (!result) return { pass: true };

  const lines = result.content.trim().split("\n");
  const verdict = lines[0].trim().toUpperCase();

  if (verdict.startsWith("PASS")) {
    return { pass: true };
  }

  const improved = lines.slice(1).join("\n").trim();
  preprocessStats.qualityGateCatches++;
  return { pass: false, improved: improved || undefined };
}

async function compressContextWithCheapModel(
  query: string,
  contextText: string,
  llmConfig: LLMConfig
): Promise<{ compressed: string; tokensSaved: number } | null> {
  const charCount = contextText.length;
  if (charCount < CONTEXT_COMPRESS_THRESHOLD) return null;

  const result = await cheapLLMCall(
    "You are a context compression assistant. Given a user's question and a block of memory/context snippets, extract ONLY the parts directly relevant to answering the question. Output a concise, compressed version. Remove irrelevant memories entirely. Keep key facts, dates, names, and relationships. Be brief.",
    `Question: ${query}\n\n--- Context to compress ---\n${contextText}\n\n--- End context ---\n\nExtract only what's relevant to the question above. Be concise.`,
    800,
    llmConfig
  );

  if (!result) return null;

  const originalTokens = Math.ceil(charCount / 4);
  const compressedTokens = Math.ceil(result.content.length / 4);
  const saved = Math.max(0, originalTokens - compressedTokens);

  emitEvent("ask", `Context compressed: ${originalTokens} -> ${compressedTokens} tokens (~${saved} saved) via cheap LLM`, "info");

  return { compressed: result.content, tokensSaved: saved };
}


async function ensureLocalModel(): Promise<boolean> {
  if (localModelLoaded) return true;
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LOCAL_GEN_MODEL,
        prompt: "Hi",
        stream: false,
        options: { num_predict: 1 },
        keep_alive: "5m",
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (resp.ok) {
      localModelLoaded = true;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function ollamaGenerate(prompt: string, maxTokens: number = 200): Promise<string | null> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LOCAL_GEN_MODEL,
        prompt,
        stream: false,
        options: { num_predict: maxTokens, temperature: 0.1 },
        keep_alive: "5m",
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { response?: string };
    return data.response || null;
  } catch {
    return null;
  }
}

async function classifyWithLocalModel(query: string): Promise<ClassificationResult | null> {
  const loaded = await ensureLocalModel();
  if (!loaded) return null;

  const prompt = `Classify this query. Respond with ONLY a JSON object, no other text.

Query: "${query}"

Respond with: {"complexity":"simple|moderate|complex","intent":"question|command|followup"}

JSON:`;

  const result = await ollamaGenerate(prompt, 60);
  if (!result) return null;

  try {
    const cleaned = result.replace(/```json\s*/g, "").replace(/```/g, "").trim();
    const match = cleaned.match(/\{[^}]+\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (parsed.complexity && parsed.intent) {
      return { complexity: parsed.complexity, intent: parsed.intent, source: "local" };
    }
    return null;
  } catch {
    return null;
  }
}


function classifyWithHeuristics(query: string): ClassificationResult {
  const lower = query.toLowerCase();
  const complexPatterns = [
    /\bwhy\b.*\bbetter\b/, /\bcompare\b/, /\banalyz/,
    /\bexplain.*difference/, /\bshould\s+i\b/, /\bpros\s+and\s+cons\b/,
    /\btrade.?off/, /\bstrateg/, /\boptimiz/,
    /\bwhat\s+if\b/, /\bhow\s+would\b/, /\bevaluat/,
  ];
  if (complexPatterns.some(p => p.test(lower))) {
    return { complexity: "complex", intent: "question", source: "heuristic" };
  }

  const moderatePatterns = [
    /\bhow\b/, /\bexplain\b/, /\bdescribe\b/,
    /\bwhat\s+is\s+the\s+best\b/, /\bstep/,
  ];
  if (moderatePatterns.some(p => p.test(lower))) {
    return { complexity: "moderate", intent: "question", source: "heuristic" };
  }

  return { complexity: "simple", intent: "question", source: "heuristic" };
}

function routeModelForComplexity(
  complexity: QueryComplexity,
  explicitModel?: string,
  explicitTier?: CostTier
): { modelId: string; routingReason: string } {
  if (explicitModel) {
    return { modelId: explicitModel, routingReason: `User override: ${explicitModel}` };
  }

  if (explicitTier) {
    const model = pickModel("general", explicitTier);
    if (model) return { modelId: model.id, routingReason: `User tier: ${explicitTier} -> ${model.label}` };
  }

  if (preferredModel) {
    return { modelId: preferredModel, routingReason: `User preference: ${preferredModel}` };
  }

  switch (complexity) {
    case "simple": {
      const model = pickModel("general", "cheap");
      return {
        modelId: model?.id || "deepseek/deepseek-chat",
        routingReason: `Simple query -> cheap tier (${model?.label || "DeepSeek"})`,
      };
    }
    case "moderate": {
      const model = pickModel("reasoning", "standard") || pickModel("general", "cheap");
      return {
        modelId: model?.id || "deepseek/deepseek-chat",
        routingReason: `Moderate query -> standard tier (${model?.label || "DeepSeek"})`,
      };
    }
    case "complex": {
      const model = pickModel("reasoning", "premium") || pickModel("reasoning", "standard");
      return {
        modelId: model?.id || "anthropic/claude-sonnet-4",
        routingReason: `Complex query -> premium tier (${model?.label || "Claude"})`,
      };
    }
  }
}

async function getSoulPrompt(): Promise<string> {
  const soul = await storage.getAgentConfig("soul");
  return soul?.value || "You are a helpful autonomous agent.";
}

async function findKbAnswer(query: string): Promise<{
  answer: string;
  title: string;
  verified: boolean;
} | null> {
  try {
    const kbResults = await storage.searchGalaxyKb(query, 5);
    if (kbResults.length === 0) return null;

    const topMatch = kbResults[0];
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const titleLower = (topMatch.title || "").toLowerCase();
    const summaryLower = (topMatch.summary || "").toLowerCase();

    const matchScore = queryWords.filter(w => titleLower.includes(w) || summaryLower.includes(w)).length;
    if (matchScore < Math.min(2, queryWords.length)) return null;

    const answer = topMatch.summary || topMatch.fullText?.slice(0, 1500) || topMatch.title;
    return {
      answer: `From Galaxy KB: ${topMatch.title}${topMatch.verified ? " (verified)" : ""}\n\n${answer}`,
      title: topMatch.title,
      verified: topMatch.verified,
    };
  } catch {
    return null;
  }
}

export async function ask(
  question: string,
  options: {
    model?: string;
    tier?: CostTier;
  } = {}
): Promise<AskResult> {
  await loadConfig();
  pruneStaleHistory();

  const llmConfig = await getLLMConfig();
  const canUseCloudPreprocess = hasLLMKeys();

  let classification: ClassificationResult;

  if (canUseCloudPreprocess) {
    const cheapResult = await classifyWithCheapLLM(question, llmConfig);
    if (cheapResult) {
      classification = cheapResult;
      preprocessStats.queriesProcessed++;
      emitEvent("ask", `Classification (${cheapResult.source}): complexity=${cheapResult.complexity}, intent=${cheapResult.intent}`, "info");
    } else {
      classification = classifyWithHeuristics(question);
      emitEvent("ask", `Classification (heuristic fallback — cheap LLM unavailable): complexity=${classification.complexity}`, "info");
    }
  } else if (localFallbackEnabled) {
    const localResult = await classifyWithLocalModel(question);
    classification = localResult || classifyWithHeuristics(question);
    emitEvent("ask", `Classification (${classification.source}): complexity=${classification.complexity}`, "info");
  } else {
    classification = classifyWithHeuristics(question);
    emitEvent("ask", `Classification (heuristic — no cloud keys): complexity=${classification.complexity}`, "info");
  }

  const kbMatch = await findKbAnswer(question);
  if (kbMatch && classification.complexity === "simple") {
    if (canUseCloudPreprocess) {
      const verification = await verifyKbAnswer(question, kbMatch.title, kbMatch.answer, llmConfig);

      if (verification === "yes") {
        const gateResult = await qualityGateKbAnswer(question, kbMatch.answer, llmConfig);
        if (gateResult.pass) {
          addToHistory("user", question);
          addToHistory("assistant", kbMatch.answer);
          preprocessStats.kbDirectHits++;
          const saved = Math.ceil(question.length / 4) + 200;
          preprocessStats.tokensSaved += saved;
          emitEvent("ask", `KB direct answer (quality-verified, ~${saved} cloud tokens saved)`, "info");
          return {
            answer: kbMatch.answer,
            model: "galaxy-kb",
            tokensUsed: 0,
            cost: 0,
            routingReason: "Direct KB match — verified by cheap LLM, zero main-model tokens",
            fromKb: true,
            preprocessModel: getCheapModel()?.label,
            preprocessCost: preprocessStats.preprocessCost,
          };
        } else {
          emitEvent("ask", `KB answer failed quality gate — escalating to full LLM`, "info");
        }
      } else if (verification === "no") {
        emitEvent("ask", `KB match rejected by cheap LLM verification — not a direct answer`, "info");
      }
    } else {
      addToHistory("user", question);
      addToHistory("assistant", kbMatch.answer);
      preprocessStats.kbDirectHits++;
      return {
        answer: kbMatch.answer,
        model: "galaxy-kb",
        tokensUsed: 0,
        cost: 0,
        routingReason: "Direct KB match — no cloud keys for verification",
        fromKb: true,
      };
    }
  }

  if (!canUseCloudPreprocess) {
    return {
      answer: "No LLM API keys configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY.",
      model: "none",
      tokensUsed: 0,
      cost: 0,
      routingReason: "No API keys",
    };
  }

  const { modelId, routingReason } = routeModelForComplexity(classification.complexity, options.model, options.tier);
  emitEvent("ask", `Routing: ${routingReason}`, "info");

  const memories = await searchMemoriesHybrid(question, 20);
  let memoryItems = memories.map(m => ({ id: m.id, content: m.content }));

  if (memoryItems.length > 8) {
    const beforeCount = memoryItems.length;
    memoryItems = await filterMemoriesWithCheapLLM(question, memoryItems, llmConfig);
    const pruned = beforeCount - memoryItems.length;
    if (pruned > 0) {
      const saved = pruned * 50;
      preprocessStats.tokensSaved += saved;
      emitEvent("ask", `Cheap LLM pruned ${pruned} irrelevant memories (~${saved} tokens saved)`, "info");
    }
  }

  let memoryContext = memoryItems.map(m => m.content).join("\n---\n");
  let compressed = false;
  let tokensSaved = 0;

  const targetModel = getModelRoster().find(m => m.id === modelId.replace(/^openrouter\//, ""));
  const targetTier = targetModel?.tier || "standard";
  const isExpensiveModel = targetTier === "premium" || targetTier === "standard";

  if (isExpensiveModel && memoryContext.length > CONTEXT_COMPRESS_THRESHOLD) {
    const compressionResult = await compressContextWithCheapModel(question, memoryContext, llmConfig);
    if (compressionResult) {
      memoryContext = compressionResult.compressed;
      tokensSaved = compressionResult.tokensSaved;
      compressed = true;
    }
  }

  let kbContext = "";
  if (kbMatch) {
    kbContext = `\n\nRelevant Galaxy KB entry:\n${kbMatch.answer}`;
  } else {
    try {
      const kbResults = await storage.searchGalaxyKb(question, 3);
      if (kbResults.length > 0) {
        kbContext = "\n\nRelevant Galaxy KB entries:\n" +
          kbResults.map(e => `- ${e.title}: ${(e.summary || "").slice(0, 200)}`).join("\n");
      }
    } catch {}
  }

  const soul = await getSoulPrompt();
  const messages: LLMMessage[] = [];
  let systemContent = soul;
  systemContent += "\n\nYou are answering a direct question from the user. Be helpful, accurate, and concise.";
  if (memoryContext) {
    systemContent += `\n\n## Relevant Memories\n${memoryContext}`;
  }
  if (kbContext) {
    systemContent += kbContext;
  }
  messages.push({ role: "system", content: systemContent });

  for (const turn of conversationHistory) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: "user", content: question });

  const start = Date.now();
  const response = await executeLLM(messages, modelId, llmConfig, {});
  const durationMs = Date.now() - start;

  const tokens = response.tokensUsed || 0;
  const cost = response.cost || estimateTokenCost(response.model || modelId, tokens);
  trackTokenUsage(response.model || modelId, tokens, "ask");

  addToHistory("user", question);
  addToHistory("assistant", response.content);

  emitEvent("ask", `Answer from ${response.model || modelId} (${tokens} tokens, $${cost.toFixed(4)}, ${durationMs}ms)`, "info");

  return {
    answer: response.content,
    model: response.model || modelId,
    tokensUsed: tokens,
    cost,
    routingReason,
    compressed,
    tokensSaved,
    preprocessModel: getCheapModel()?.label,
    preprocessCost: preprocessStats.preprocessCost,
  };
}

export async function askCompare(question: string): Promise<CompareResult> {
  await loadConfig();

  if (!hasLLMKeys()) {
    return { results: [] };
  }

  pruneStaleHistory();

  const llmConfig = await getLLMConfig();

  const memories = await searchMemoriesHybrid(question, 15);
  let memoryItems = memories.map(m => ({ id: m.id, content: m.content }));

  if (memoryItems.length > 8) {
    memoryItems = await filterMemoriesWithCheapLLM(question, memoryItems, llmConfig);
  }

  const memoryContext = memoryItems.map(m => m.content).join("\n---\n");

  let kbContext = "";
  try {
    const kbResults = await storage.searchGalaxyKb(question, 3);
    if (kbResults.length > 0) {
      kbContext = "\n\nRelevant Galaxy KB entries:\n" +
        kbResults.map(e => `- ${e.title}: ${(e.summary || "").slice(0, 200)}`).join("\n");
    }
  } catch {}

  const soul = await getSoulPrompt();

  const buildMessages = (): LLMMessage[] => {
    const msgs: LLMMessage[] = [];
    let sys = soul + "\n\nYou are answering a direct question. Be helpful, accurate, and concise.";
    if (memoryContext) sys += `\n\n## Relevant Memories\n${memoryContext}`;
    if (kbContext) sys += kbContext;
    msgs.push({ role: "system", content: sys });
    for (const turn of conversationHistory) {
      msgs.push({ role: turn.role, content: turn.content });
    }
    msgs.push({ role: "user", content: question });
    return msgs;
  };

  const { cheap, premium } = pickCheapThenPremium("general", "premium");
  const modelsToCompare: ModelEntry[] = [];
  if (cheap) modelsToCompare.push(cheap);
  if (premium && premium.id !== cheap?.id) modelsToCompare.push(premium);

  if (modelsToCompare.length === 0) {
    return { results: [] };
  }

  const promises = modelsToCompare.map(async (model) => {
    const start = Date.now();
    try {
      const response = await executeLLM(buildMessages(), model.id, llmConfig, {});
      const durationMs = Date.now() - start;
      const tokens = response.tokensUsed || 0;
      const cost = response.cost || estimateTokenCost(response.model || model.id, tokens);
      trackTokenUsage(response.model || model.id, tokens, "ask-compare");
      return {
        model: response.model || model.id,
        label: model.label,
        tier: model.tier,
        answer: response.content,
        tokensUsed: tokens,
        cost,
        durationMs,
      };
    } catch (err: any) {
      return {
        model: model.id,
        label: model.label,
        tier: model.tier,
        answer: `[Error: ${err.message}]`,
        tokensUsed: 0,
        cost: 0,
        durationMs: Date.now() - start,
      };
    }
  });

  const results = await Promise.all(promises);

  addToHistory("user", question);
  if (results[0]) addToHistory("assistant", results[0].answer);

  for (const r of results) {
    emitEvent("ask", `Compare: ${r.label} (${r.tier}) — ${r.tokensUsed} tokens, $${r.cost.toFixed(4)}, ${r.durationMs}ms`, "info");
  }

  return { results };
}

export async function initAskEngine(): Promise<void> {
  await loadConfig();
}
