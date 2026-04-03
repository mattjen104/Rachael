import { storage } from "./storage";
import { executeLLM, buildProgramPrompt, hasLLMKeys, type LLMResponse, type LLMConfig } from "./llm-client";
import { runHardenedSkill } from "./skill-runner";
import {
  detectTaskType, pickCascadeModels, pickComparisonModels, pickCheapThenPremium,
  trackTokenUsage, trackExternalCost, trackModelQuality, parseCostTier,
  getDailyBudget, isBudgetExhausted, getBudgetStatus, getDailyTokenUsage, loadRosterFromConfig,
  persistQualityScores, loadQualityScores, removeFromRoster, refreshRosterPricing,
  type TaskType, type CostTier, type BudgetStatus,
} from "./model-router";
import { sanitizeResultRow } from "./output-sanitizer";
import { emitEvent } from "./event-bus";
import { isAgentPaused, shouldYield, recordAction, getControlMode, enqueueCommand, completeCommand, pauseExecution, onResume, removePausedExecution, getPausedExecutions, type PausedExecution } from "./control-bus";
import { isLocalComputeAvailable, executeLocalComputeTask } from "./local-compute";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { Program } from "@shared/schema";
import { initQdrant } from "./qdrant-client";
import { storeMemoryWithQdrant, searchMemoriesHybrid, getMemoryContextHybrid, runConsolidation } from "./memory-consolidation";
import { runEvolutionPipeline, checkAutoRollback, validateProposal, addToGoldenSuite, consolidateObservations } from "./evolution-engine";
import { runGalaxyContextCycle, extractTermsFromEpicResults, addToContextQueue, isGalaxyContextEnabled } from "./galaxy-scraper";

export type ProgramStatus = "idle" | "queued" | "running" | "completed" | "error";

export interface ProgramState {
  name: string;
  status: ProgramStatus;
  lastRun: Date | null;
  nextRun: Date | null;
  lastOutput: string | null;
  error: string | null;
  iteration: number;
}

export interface RuntimeState {
  active: boolean;
  programs: Map<string, ProgramState>;
  lastTick: Date | null;
}

const runtime: RuntimeState = {
  active: true,
  programs: new Map(),
  lastTick: null,
};

let tickInterval: ReturnType<typeof setInterval> | null = null;

const TICK_INTERVAL_MS = 60_000;
const programRuns = new Map<string, Array<{ model: string; tokens: number; timestamp: number }>>();
const proposalCounts = new Map<string, number>();
const MAX_PROPOSALS_PER_ITERATION = 50;
const pendingRecallResults = new Map<string, string>();

async function createGateValidatedProposal(
  proposal: {
    section: string;
    targetName: string;
    reason: string;
    currentContent: string;
    proposedContent: string;
    source: string;
    proposalType: string;
  },
  llmConfig: LLMConfig
): Promise<{ created: boolean; rejected: boolean; rejectionReasons?: string[] }> {
  const validation = await validateProposal(proposal.section, proposal.proposedContent, llmConfig);
  const latestActive = await storage.getLatestEvolutionVersion();
  const evolutionVersion = latestActive?.status === "active" ? latestActive.version : null;

  if (validation.valid) {
    await storage.createProposal({
      ...proposal,
      evolutionVersion,
    });
    return { created: true, rejected: false };
  }

  await storage.createProposal({
    ...proposal,
    reason: `REJECTED by evolution gates: ${validation.rejectionReasons.join("; ")}`,
    warnings: `Gate rejections: ${validation.rejectionReasons.join("; ")}`,
    evolutionVersion,
  });
  return { created: true, rejected: true, rejectionReasons: validation.rejectionReasons };
}

function shortModelName(model: string): string {
  const last = model.split("/").pop() || model;
  return last.replace(/:free$/, "").replace(/-instruct$/, "");
}

function resolveComputeTarget(prog: Program): "local" | "local-compute" {
  if (isLocalComputeAvailable()) {
    return "local-compute";
  }
  return "local";
}

function resolveProviderPrefix(modelId: string): string {
  if (process.env.OPENROUTER_API_KEY) return `openrouter/${modelId}`;
  if (modelId.startsWith("anthropic/") && process.env.ANTHROPIC_API_KEY) return modelId;
  if (modelId.startsWith("openai/") && process.env.OPENAI_API_KEY) return modelId;
  if (process.env.ANTHROPIC_API_KEY) return `anthropic/claude-sonnet-4-6`;
  if (process.env.OPENAI_API_KEY) return `openai/gpt-4o-mini`;
  return `openrouter/${modelId}`;
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

async function getSoulPrompt(): Promise<string> {
  const soul = await storage.getAgentConfig("soul");
  return soul?.value || "You are a helpful autonomous agent.";
}

let MEMORY_TOKEN_BUDGET = 2000;
const APPROX_CHARS_PER_TOKEN = 4;

async function loadMemoryBudget(): Promise<void> {
  try {
    const budgetConfig = await storage.getAgentConfig("memory_token_budget");
    if (budgetConfig?.value) {
      const parsed = parseInt(budgetConfig.value, 10);
      if (!isNaN(parsed) && parsed > 0) MEMORY_TOKEN_BUDGET = parsed;
    }
  } catch {}
}

function extractTags(content: string): string[] {
  const tags: string[] = [];
  const words = content.toLowerCase().split(/\s+/);
  const stopWords = new Set(["the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "will", "would", "could", "should", "may", "might", "shall", "can", "need", "dare", "ought", "used", "to", "of", "in", "for", "on", "with", "at", "by", "from", "as", "into", "through", "during", "before", "after", "above", "below", "between", "out", "off", "over", "under", "again", "further", "then", "once", "and", "but", "or", "nor", "not", "so", "yet", "both", "either", "neither", "each", "every", "all", "any", "few", "more", "most", "other", "some", "such", "no", "only", "own", "same", "than", "too", "very", "just", "because", "if", "when", "where", "how", "what", "which", "who", "whom", "this", "that", "these", "those", "i", "me", "my", "we", "our", "you", "your", "he", "him", "his", "she", "her", "it", "its", "they", "them", "their"]);
  const seen = new Set<string>();
  for (const w of words) {
    const clean = w.replace(/[^a-z0-9-]/g, "");
    if (clean.length > 2 && !stopWords.has(clean) && !seen.has(clean)) {
      seen.add(clean);
      tags.push(clean);
    }
    if (tags.length >= 5) break;
  }
  return tags;
}

function scoreMemory(m: { relevanceScore: number; accessCount: number; lastAccessed: Date; createdAt: Date; tags: string[] }, programName?: string): number {
  const now = Date.now();
  const ageMs = now - m.createdAt.getTime();
  const lastAccessMs = now - m.lastAccessed.getTime();
  const ageDays = ageMs / 86400000;
  const lastAccessDays = lastAccessMs / 86400000;

  const relevanceWeight = m.relevanceScore / 100;
  const recencyWeight = 1 / (1 + lastAccessDays * 0.1);
  const accessWeight = Math.min(1, 0.5 + (m.accessCount * 0.05));
  const tagOverlap = programName && m.tags.includes(programName) ? 1.2 : 1.0;

  return relevanceWeight * recencyWeight * accessWeight * tagOverlap;
}

async function getMemoryContext(programName?: string): Promise<{ persistentContext: string; memories: Array<{ id: number; content: string }> }> {
  await loadMemoryBudget();
  try {
    const memories = await storage.getMemoriesForProgram(programName || null, {
      limit: 50,
      minRelevance: 5,
    });

    if (memories.length === 0) {
      const mem = await storage.getAgentConfig("persistent_context");
      return { persistentContext: mem?.value || "", memories: [] };
    }

    const scored = memories.map(m => ({
      memory: m,
      score: scoreMemory(m, programName),
    })).sort((a, b) => b.score - a.score);

    const charBudget = MEMORY_TOKEN_BUDGET * APPROX_CHARS_PER_TOKEN;
    let totalChars = 0;
    const selected: Array<{ id: number; content: string }> = [];
    const lines: string[] = [];

    for (const { memory: m } of scored) {
      const line = `[${m.memoryType}] ${m.content}`;
      if (totalChars + line.length > charBudget) break;
      totalChars += line.length;
      lines.push(line);
      selected.push({ id: m.id, content: m.content });
      storage.updateMemoryAccess(m.id).catch(() => {});
    }

    return { persistentContext: lines.join("\n"), memories: selected };
  } catch {
    const mem = await storage.getAgentConfig("persistent_context");
    return { persistentContext: mem?.value || "", memories: [] };
  }
}

async function executeLLMWithCascade(
  messages: import("./llm-client").LLMMessage[],
  taskType: TaskType,
  costTier: CostTier,
  modelOverride: string | undefined,
  llmConfig: LLMConfig
): Promise<LLMResponse> {
  if (modelOverride) {
    return executeLLM(messages, modelOverride, llmConfig, {});
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return executeLLM(messages, undefined, llmConfig, {});
  }

  const cascade = pickCascadeModels(taskType, costTier);
  if (cascade.length === 0) {
    return executeLLM(messages, undefined, llmConfig, {});
  }

  let lastError: Error | null = null;
  let rateLimited = false;
  for (const model of cascade) {
    try {
      if (rateLimited) {
        await new Promise(r => setTimeout(r, 5000));
        rateLimited = false;
      }
      const result = await executeLLM(
        messages,
        resolveProviderPrefix(model.id),
        llmConfig,
        {}
      );
      if (result.content && result.content.length > 0) {
        trackModelQuality(model.id, true, taskType);
        return result;
      }
      trackModelQuality(model.id, false, taskType);
    } catch (err: any) {
      lastError = err;
      trackModelQuality(model.id, false, taskType);
      if (err.message?.includes("429") || err.message?.includes("rate")) {
        rateLimited = true;
      }
      continue;
    }
  }

  throw lastError || new Error("All models in cascade failed");
}

async function executeLLMTwoStage(
  messages: import("./llm-client").LLMMessage[],
  taskType: TaskType,
  costTier: CostTier,
  llmConfig: LLMConfig
): Promise<LLMResponse> {
  const { cheap, premium } = pickCheapThenPremium(taskType, costTier);
  if (!cheap) {
    return executeLLMWithCascade(messages, taskType, costTier, undefined, llmConfig);
  }

  const triageMessages: import("./llm-client").LLMMessage[] = [
    ...messages,
    { role: "user" as const, content: "TRIAGE: Analyze the above briefly. Respond with INTERESTING if this warrants deep analysis, or ROUTINE if this is routine/low-value. Include a 1-sentence reason. Format: INTERESTING|ROUTINE: <reason>" },
  ];

  let triageResult = "";
  try {
    const cheapResult = await executeLLM(
      triageMessages,
      resolveProviderPrefix(cheap.id),
      llmConfig,
      {}
    );
    trackModelQuality(cheap.id, !!cheapResult.content, taskType);
    triageResult = cheapResult.content || "";

    if (triageResult.toUpperCase().includes("ROUTINE")) {
      return { content: triageResult, model: cheapResult.model, tokensUsed: cheapResult.tokensUsed };
    }
  } catch {
    trackModelQuality(cheap.id, false, taskType);
  }

  if (premium && premium.id !== cheap.id) {
    try {
      const premiumResult = await executeLLM(
        messages,
        resolveProviderPrefix(premium.id),
        llmConfig,
        {}
      );
      trackModelQuality(premium.id, premiumResult.content?.length > 0, taskType);
      return premiumResult;
    } catch {
      trackModelQuality(premium.id, false, taskType);
    }
  }

  return executeLLMWithCascade(messages, taskType, costTier, undefined, llmConfig);
}

function makeProgramState(prog: Program): ProgramState {
  return {
    name: prog.name,
    status: "idle",
    lastRun: prog.lastRun,
    nextRun: prog.nextRun,
    lastOutput: null,
    error: null,
    iteration: 0,
  };
}

function parseCronNextRun(cronExpr: string, after: Date): Date | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minStr, hourStr, , , ] = parts;

  const minutes = minStr === "*" ? [0] : minStr.split(",").map(Number);
  const hours = hourStr === "*"
    ? Array.from({ length: 24 }, (_, i) => i)
    : hourStr.includes("*/")
      ? Array.from({ length: 24 }, (_, i) => i).filter(h => h % parseInt(hourStr.replace("*/", "")) === 0)
      : hourStr.split(",").map(Number);

  const candidate = new Date(after);
  candidate.setSeconds(0, 0);

  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    for (const hour of hours) {
      for (const minute of minutes) {
        const next = new Date(candidate);
        next.setDate(next.getDate() + dayOffset);
        next.setHours(hour, minute, 0, 0);
        if (next.getTime() > after.getTime()) return next;
      }
    }
  }
  const fallback = new Date(after);
  fallback.setDate(fallback.getDate() + 1);
  fallback.setHours(hours[0] || 0, minutes[0] || 0, 0, 0);
  return fallback;
}

function parseSchedule(schedule: string | null, lastRun: Date | null, cronExpression?: string | null): Date | null {
  const now = new Date();
  const base = lastRun || new Date(now.getTime() - 86400000);

  if (cronExpression) {
    return parseCronNextRun(cronExpression, base);
  }

  if (!schedule) return null;

  if (schedule.includes("every")) {
    const match = schedule.match(/every\s+(\d+)\s*h/i);
    if (match) {
      const hours = parseInt(match[1], 10);
      return new Date(base.getTime() + hours * 3600000);
    }
  }

  if (schedule === "daily") {
    return new Date(base.getTime() + 86400000);
  }

  return null;
}

const INLINE_SCRIPTS_DIR = join(process.cwd(), ".inline-scripts");

async function executeInlineCode(code: string, config: Record<string, string>): Promise<{ summary: string; metric?: string; proposals?: Array<{ section: string; diff: string; reason: string }> }> {
  await mkdir(INLINE_SCRIPTS_DIR, { recursive: true });

  const filename = `prog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.ts`;
  const filepath = join(INLINE_SCRIPTS_DIR, filename);
  const projectRoot = process.cwd();

  const bridgePort = process.env.PORT || "5000";
  const wrappedCode = `
const __ctx = JSON.parse(process.env.__INLINE_CTX || '{}');
const config = __ctx.properties || {};
const __projectRoot = process.env.__PROJECT_ROOT || process.cwd();
const __skillPath = (name: string) => __projectRoot + "/skills/" + name;
const __bridgePort = process.env.__BRIDGE_PORT || "5000";
const __bridgeToken = process.env.__BRIDGE_TOKEN || "";
const __apiKey = process.env.__API_KEY || "";

const __BRIDGE_ONLY_DOMAINS = ["galaxy.epic.com", ".ucsd.edu", "pulse.ucsd.edu", ".reddit.com", "reddit.com", ".live.com", "outlook.live.com", ".office.com", "teams.microsoft.com"];
function __isBridgeOnly(targetUrl: string): boolean {
  try {
    const host = new URL(targetUrl).hostname.toLowerCase();
    return __BRIDGE_ONLY_DOMAINS.some(d => d.startsWith(".") ? host.endsWith(d) || host === d.slice(1) : host === d);
  } catch { return false; }
}

async function bridgeFetch(url: string, options?: { type?: "fetch" | "dom"; selectors?: Record<string, string>; timeout?: number; headers?: Record<string, string> }): Promise<{ status?: number; body?: any; text?: string; extracted?: any; error?: string; source?: string }> {
  const type = options?.type || "fetch";
  const timeout = options?.timeout || 45000;
  const bridgeOnly = __isBridgeOnly(url);
  const directFallback = async (): Promise<{ status?: number; body?: any; text?: string; error?: string; source?: string }> => {
    if (bridgeOnly) return { error: "bridge-only domain — direct fetch blocked (requires browser bridge with real session)", source: "blocked" };
    try {
      const r = await fetch(url, { headers: options?.headers || { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" }, signal: AbortSignal.timeout(15000) });
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("json")) { const j = await r.json(); return { status: r.status, body: j, text: JSON.stringify(j), source: "direct" }; }
      const t = await r.text(); return { status: r.status, body: t, text: t, source: "direct" };
    } catch (e2: any) {
      return { error: e2.message || String(e2), source: "direct" };
    }
  };
  try {
    const r = await fetch("http://localhost:" + __bridgePort + "/api/bridge/ext/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Token": __bridgeToken },
      body: JSON.stringify({ type, url, submittedBy: "program", wait: timeout, options: { selectors: options?.selectors, headers: options?.headers, maxText: 15000 } }),
    });
    if (!r.ok) return await directFallback();
    const result = await r.json();
    if (result.error) {
      if (bridgeOnly) return { error: result.error + " (bridge-only domain, no fallback)", source: "bridge-only-failed" };
      const fallback = await directFallback();
      if (!fallback.error) return fallback;
      return { error: result.error + " (bridge); " + fallback.error + " (direct)", source: "both-failed" };
    }
    if (result.body && !result.text) result.text = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
    result.source = result.source || "bridge";
    return result;
  } catch (e: any) {
    return await directFallback();
  }
}

async function smartFetch(url: string, init?: RequestInit): Promise<Response> {
  const ANTI_BOT = [403, 429, 503];
  if (__isBridgeOnly(url)) {
    const bridgeResult = await bridgeFetch(url, { type: "fetch", headers: init?.headers as Record<string, string> | undefined });
    if (bridgeResult.error) throw new Error(bridgeResult.error);
    const body = bridgeResult.text || (typeof bridgeResult.body === "string" ? bridgeResult.body : JSON.stringify(bridgeResult.body));
    return new Response(body, { status: bridgeResult.status || 200, headers: { "content-type": "text/html" } });
  }
  try {
    const r = await fetch(url, init);
    if (ANTI_BOT.includes(r.status)) {
      const bridgeResult = await bridgeFetch(url, { type: "fetch", headers: init?.headers as Record<string, string> | undefined });
      if (!bridgeResult.error) {
        const body = bridgeResult.text || (typeof bridgeResult.body === "string" ? bridgeResult.body : JSON.stringify(bridgeResult.body));
        return new Response(body, { status: bridgeResult.status || 200, headers: { "content-type": r.headers.get("content-type") || "text/html" } });
      }
      return r;
    }
    return r;
  } catch (e: any) {
    const bridgeResult = await bridgeFetch(url, { type: "fetch", headers: init?.headers as Record<string, string> | undefined });
    if (bridgeResult.error) throw new Error(bridgeResult.error);
    const body = bridgeResult.text || (typeof bridgeResult.body === "string" ? bridgeResult.body : JSON.stringify(bridgeResult.body));
    return new Response(body, { status: bridgeResult.status || 200, headers: { "content-type": "text/html" } });
  }
}

${code}

async function __run() {
  if (typeof execute === 'function') return execute(__ctx);
  if (typeof run === 'function') return run(__ctx);
  return { summary: "No execute/run function found in code block" };
}

__run().then((r) => {
  process.stdout.write(JSON.stringify(r));
}).catch((e) => {
  process.stderr.write(e.message || String(e));
  process.exit(1);
});
`;

  try {
    await writeFile(filepath, wrappedCode, "utf-8");

    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const safeEnv: Record<string, string> = {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      NODE_ENV: process.env.NODE_ENV || "production",
      TMPDIR: process.env.TMPDIR || "/tmp",
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || `${process.env.HOME || "/tmp"}/.config`,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || `${process.env.HOME || "/tmp"}/.cache`,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME || `${process.env.HOME || "/tmp"}/.local/share`,
      npm_config_cache: process.env.npm_config_cache || "/tmp/.npm",
      __INLINE_CTX: JSON.stringify({ properties: config }),
      __PROJECT_ROOT: projectRoot,
    };

    if (process.env.OPENROUTER_API_KEY) {
      safeEnv.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    }

    try {
      const { getBridgeToken } = await import("./bridge-queue");
      safeEnv.__BRIDGE_TOKEN = getBridgeToken();
      safeEnv.__BRIDGE_PORT = bridgePort;
      if (process.env.OPENCLAW_API_KEY) safeEnv.__API_KEY = process.env.OPENCLAW_API_KEY;
    } catch {}

    const timeoutMs = config.TIMEOUT
      ? Math.min(Math.max(parseInt(config.TIMEOUT, 10) * 1000, 10000), 600000)
      : 300000;

    const { stdout, stderr } = await execFileAsync(
      "npx", ["tsx", filepath],
      { env: safeEnv, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }
    );

    if (stderr && !stdout) {
      return { summary: `Script error: ${stderr.slice(0, 500)}` };
    }

    try {
      const trimmed = stdout.trim();
      const parsed = JSON.parse(trimmed);
      return {
        summary: parsed.summary || String(parsed),
        metric: parsed.metric,
        proposals: parsed.proposals,
      };
    } catch {
      const trimmed = stdout.trim();
      const lastBrace = trimmed.lastIndexOf('}');
      if (lastBrace >= 0) {
        for (let i = lastBrace; i >= 0; i--) {
          if (trimmed[i] === '{') {
            try {
              const parsed = JSON.parse(trimmed.substring(i, lastBrace + 1));
              if (parsed && typeof parsed === 'object' && parsed.summary) {
                return { summary: parsed.summary, metric: parsed.metric, proposals: parsed.proposals };
              }
            } catch {}
          }
        }
      }
      return { summary: trimmed.slice(0, 2000) || "Script completed with no output" };
    }
  } finally {
    try { const { unlink } = await import("fs/promises"); await unlink(filepath); } catch {}
  }
}

interface ProgramResumeContext {
  phase: "post-llm";
  llmContent: string;
  llmModel: string;
  llmTokens: number;
  iteration: number;
}

async function executeProgram(programName: string, resumeCtx?: ProgramResumeContext): Promise<void> {
  const ps = runtime.programs.get(programName);
  if (!ps) return;

  if (isAgentPaused()) {
    ps.status = "idle";
    emitEvent("agent-runtime", `Program "${programName}" skipped: agent paused`, "info", { program: programName });
    recordAction(getControlMode(), `program-skipped: ${programName}`, programName, undefined, "paused");
    return;
  }

  const cmd = enqueueCommand("agent", `execute-program: ${programName}`, programName);
  if (!cmd) {
    ps.status = "idle";
    emitEvent("agent-runtime", `Program "${programName}" rejected by command bus`, "info", { program: programName });
    return;
  }

  ps.status = "running";
  ps.error = null;
  const isResume = !!resumeCtx;
  emitEvent("agent-runtime", `${isResume ? "Resuming" : "Starting"} program: ${programName}`, "info", { program: programName });
  recordAction(getControlMode(), `program-${isResume ? "resume" : "start"}: ${programName}`, programName, undefined, isResume ? "resumed" : "started");

  try {
    if (!isResume) ps.iteration += 1;

    const prog = await storage.getProgramByName(programName);
    if (!prog) throw new Error(`Program "${programName}" not found in DB`);

    const llmConfig = await getLLMConfig();
    const soul = await getSoulPrompt();
    const memory = await getMemoryContextHybrid(programName, MEMORY_TOKEN_BUDGET);

    const recentObservations = await storage.getMemoriesForProgram(programName, {
      limit: 3,
      type: "observation",
    });
    const recentOutcomes = await storage.getMemoriesForProgram(programName, {
      limit: 3,
      type: "outcome",
    });
    const recallContext = (recentObservations.length > 0 || recentOutcomes.length > 0)
      ? [...recentObservations, ...recentOutcomes].map(m => `[${m.memoryType}] ${m.content}`).join(" | ")
      : "";
    if (recallContext) {
      emitEvent("memory", `Recall for "${programName}": ${recallContext.slice(0, 120)}`, "info", { program: programName });
      memory.persistentContext = memory.persistentContext
        ? memory.persistentContext + "\n\n[Previous findings for " + programName + "]: " + recallContext
        : "[Previous findings for " + programName + "]: " + recallContext;
    }

    let output = "";
    let modelUsed = "inline";
    let tokensUsed = 0;
    let metric: string | undefined;

    if (isResume) {
      output = resumeCtx.llmContent;
      modelUsed = resumeCtx.llmModel;
      tokensUsed = resumeCtx.llmTokens;
      trackTokenUsage(modelUsed, tokensUsed, programName);
      emitEvent("agent-runtime", `Resumed with saved LLM result for "${programName}" (${tokensUsed} tokens, ${shortModelName(modelUsed)})`, "info", { program: programName });
    } else if (prog.code) {
      try {
        const result = await executeInlineCode(prog.code, prog.config as Record<string, string> || {});
        output = result.summary;
        metric = result.metric;
        modelUsed = "inline-code";

        if (result.proposals && Array.isArray(result.proposals)) {
          for (const p of result.proposals.slice(0, MAX_PROPOSALS_PER_ITERATION)) {
            try {
              const gateResult = await createGateValidatedProposal({
                section: p.section || "RESEARCH",
                targetName: programName,
                reason: p.reason || p.diff || output.slice(0, 200),
                currentContent: "",
                proposedContent: p.diff || p.reason,
                source: "agent",
                proposalType: "change",
              }, llmConfig);
              if (gateResult.rejected) {
                emitEvent("evolution", `Inline proposal from "${programName}" rejected by gates: ${gateResult.rejectionReasons?.[0]?.slice(0, 100)}`, "info", { program: programName });
              }
              const count = proposalCounts.get(programName) || 0;
              proposalCounts.set(programName, count + 1);
            } catch (e) {
              console.error("[agent-runtime] Failed to persist inline proposal:", e);
            }
          }
        }

        const inlineOutputType = (prog.config?.OUTPUT_TYPE as string || "").toLowerCase();
        if (inlineOutputType === "proposal" && output.trim()) {
          try {
            await createGateValidatedProposal({
              section: "PROGRAMS",
              targetName: programName,
              reason: `Produced by "${programName}" (iteration ${ps.iteration}, inline-code)`,
              currentContent: "",
              proposedContent: output.trim().slice(0, 50000),
              source: "agent",
              proposalType: "change",
            }, llmConfig);
          } catch (e) {
            console.error("[agent-runtime] Failed to create inline OUTPUT_TYPE=proposal:", e);
          }
        }
      } catch (err: any) {
        output = `[Inline code error] ${err.message}`;
        ps.status = "error";
        ps.error = err.message;
      }
    } else if (prog.config?.LLM_REQUIRED === "false" || prog.config?.llmRequired === "false") {
      output = `[Iteration ${ps.iteration}] Program "${programName}" requires code but has none. Skipping LLM (LLM_REQUIRED=false).`;
    } else if (!hasLLMKeys()) {
      output = `[Iteration ${ps.iteration}] No LLM API keys configured.`;
    } else {
      const resolvedComputeTarget = resolveComputeTarget(prog);

      if (resolvedComputeTarget === "local-compute") {
        if (shouldYield()) {
          ps.status = "idle";
          pauseExecution({ type: "program", programName, stepIndex: ps.iteration, context: { phase: "pre-local-compute" } });
          emitEvent("agent-runtime", `Program "${programName}" paused: human took control (will resume)`, "info", { program: programName });
          recordAction(getControlMode(), `program-paused: ${programName}`, programName, undefined, "paused");
          if (cmd) completeCommand(cmd.id, "error");
          return;
        }

        emitEvent("agent-runtime", `Routing "${programName}" to local compute (self-hosted)`, "action", { program: programName });
        recordAction(getControlMode(), `local-compute: ${programName}`, programName, undefined, "started");

        const localPrompt = [
          soul,
          memory.persistentContext ? `\n\nMemory context:\n${memory.persistentContext}` : "",
          `\n\nProgram: ${programName}\nIteration: ${ps.iteration}\n\nInstructions:\n${prog.instructions}`,
        ].join("");

        const localResult = await executeLocalComputeTask({
          prompt: localPrompt,
          programName,
          iteration: ps.iteration,
          capabilities: (prog.config?.LOCAL_CAPABILITIES as string || "bash,filesystem,network").split(",").map(s => s.trim()),
        });

        if (localResult.status === "success") {
          emitEvent("agent-runtime", `Local compute completed "${programName}" (${localResult.executionTime}ms)`, "info", { program: programName });
          output = localResult.content;
          modelUsed = "local-compute";
          tokensUsed = 0;
        } else {
          emitEvent("agent-runtime", `Local compute ${localResult.status} for "${programName}": ${localResult.error}, falling back to LLM`, "info", { program: programName });
          recordAction(getControlMode(), `local-compute-fallback: ${programName}`, programName, undefined, `local-${localResult.status}`);
        }
      }

      if (!output && hasLLMKeys()) {
        const allSkills = await storage.getSkills();
        const skillBodies = allSkills
          .filter(s => prog.instructions.toLowerCase().includes(s.name.toLowerCase()))
          .map(s => `### Skill: ${s.name}\n${s.content}`);

        const recallResults = pendingRecallResults.get(programName);
        if (recallResults) {
          pendingRecallResults.delete(programName);
        }

        const messages = buildProgramPrompt(
          soul,
          skillBodies,
          prog.instructions,
          ps.iteration,
          "",
          { userProfile: "", persistentContext: memory.persistentContext, sessionLog: "", recallResults: recallResults || undefined }
        );

        const taskType = detectTaskType(prog.instructions, prog.config?.TASK_TYPE as string);
        const costTier = parseCostTier(prog.costTier);
        const modelOverride = prog.config?.MODEL as string || undefined;

        if (shouldYield()) {
          ps.status = "idle";
          pauseExecution({ type: "program", programName, stepIndex: ps.iteration, context: { phase: "pre-llm" } });
          emitEvent("agent-runtime", `Program "${programName}" paused: human took control (will resume)`, "info", { program: programName });
          recordAction(getControlMode(), `program-paused: ${programName}`, programName, undefined, "paused");
          if (cmd) completeCommand(cmd.id, "error");
          return;
        }

        const cfgMap = prog.config as Record<string, string>;
        const useTwoStage = cfgMap?.TWO_STAGE === "true" || cfgMap?.twoStage === "true";
        emitEvent("agent-runtime", `Calling LLM for "${programName}" (${taskType}${useTwoStage ? ", two-stage" : ""})`, "action", { program: programName });
        const llmResult = modelOverride
          ? await executeLLM(messages, modelOverride, llmConfig, {})
          : useTwoStage
            ? await executeLLMTwoStage(messages, taskType, costTier, llmConfig)
            : await executeLLMWithCascade(messages, taskType, costTier, undefined, llmConfig);

        if (shouldYield()) {
          ps.status = "idle";
          pauseExecution({
            type: "program", programName, stepIndex: ps.iteration,
            context: {
              phase: "post-llm",
              llmContent: llmResult.content,
              llmModel: llmResult.model,
              llmTokens: llmResult.tokensUsed || 0,
              iteration: ps.iteration,
            },
          });
          emitEvent("agent-runtime", `Program "${programName}" paused after LLM: human took control (will resume with saved result)`, "info", { program: programName });
          recordAction(getControlMode(), `program-paused: ${programName}`, programName, undefined, "paused");
          if (cmd) completeCommand(cmd.id, "error");
          return;
        }

        output = llmResult.content;
        modelUsed = llmResult.model;
        tokensUsed = llmResult.tokensUsed || 0;
        trackTokenUsage(modelUsed, tokensUsed, programName);
        emitEvent("agent-runtime", `LLM response received for "${programName}" (${tokensUsed} tokens, ${shortModelName(modelUsed)})`, "info", { program: programName });
      } else if (!output) {
        output = `[Iteration ${ps.iteration}] No LLM API keys configured.`;
      }

      const outputType = (prog.config?.OUTPUT_TYPE as string || "").toLowerCase();
      if (outputType === "proposal") {
        try {
          await createGateValidatedProposal({
            section: "PROGRAMS",
            targetName: programName,
            reason: `Proposed by "${programName}" (iteration ${ps.iteration}, ${modelUsed})`,
            currentContent: "",
            proposedContent: output.trim(),
            source: "agent",
            proposalType: "change",
          }, llmConfig);
        } catch (e) {
          console.error("[agent-runtime] Failed to create auto-proposal:", e);
        }
      }

      if (output.includes("PROPOSE:")) {
        const proposeMatch = output.match(/PROPOSE:\s*([\s\S]*?)(?:\n\n|$)/);
        if (proposeMatch) {
          const count = proposalCounts.get(programName) || 0;
          if (count < MAX_PROPOSALS_PER_ITERATION) {
            try {
              const proposedContent = proposeMatch[1].trim();
              const gateResult = await createGateValidatedProposal({
                section: "PROGRAMS",
                targetName: programName,
                reason: `Auto-proposed by "${programName}" at iteration ${ps.iteration}`,
                currentContent: prog.instructions,
                proposedContent,
                source: "agent",
                proposalType: "change",
              }, llmConfig);
              if (gateResult.rejected) {
                emitEvent("evolution", `Proposal from "${programName}" rejected by gates: ${gateResult.rejectionReasons?.[0]?.slice(0, 100)}`, "info", { program: programName });
              }
              proposalCounts.set(programName, count + 1);
            } catch (e) {
              console.error("[agent-runtime] Failed to create proposal:", e);
            }
          }
        }
      }

      if (output.includes("REMEMBER:")) {
        const rememberMatch = output.match(/REMEMBER:\s*([\s\S]*?)(?:\n\n|$)/);
        if (rememberMatch) {
          const content = rememberMatch[1].trim();
          try {
            const subjectMatch = content.match(/^(?:\[([^\]]+)\]\s*)?(.+)/s);
            const subject = subjectMatch?.[1] || null;
            const memContent = subjectMatch?.[2] || content;
            const mem = await storeMemoryWithQdrant(
              memContent,
              "semantic",
              programName,
              extractTags(memContent),
              100,
              subject
            );
            emitEvent("memory", `Memory created from REMEMBER: "${memContent.slice(0, 80)}"`, "info", { program: programName, metadata: { memoryId: mem.id } });
          } catch (e) {
            console.error("[agent-runtime] Failed to create memory:", e);
          }
        }
      }

      if (output.includes("RECALL:")) {
        const recallMatch = output.match(/RECALL:\s*([\s\S]*?)(?:\n\n|$)/);
        if (recallMatch) {
          const topic = recallMatch[1].trim();
          try {
            const recalled = await searchMemoriesHybrid(topic, 5, programName);
            if (recalled.length > 0) {
              const recallBlock = recalled.map(m => `[${m.memoryType}] ${m.content}`).join("\n");
              emitEvent("memory", `Recalled ${recalled.length} memories for topic: "${topic.slice(0, 50)}"`, "info", { program: programName });
              for (const m of recalled) {
                storage.updateMemoryAccess(m.id).catch(() => {});
              }
              pendingRecallResults.set(programName, recallBlock);
            }
          } catch (e) {
            console.error("[agent-runtime] Failed to recall memories:", e);
          }
        }
      }
    }

    const pr = programRuns.get(programName) || [];
    pr.push({ model: modelUsed, tokens: tokensUsed, timestamp: Date.now() });
    programRuns.set(programName, pr);

    proposalCounts.delete(programName);

    ps.lastOutput = output;
    ps.status = "completed";
    ps.lastRun = new Date();
    emitEvent("agent-runtime", `Program completed: ${programName} — ${output.split("\n")[0].slice(0, 100)}`, "info", { program: programName });
    recordAction(getControlMode(), `program-complete: ${programName}`, programName, undefined, "success");
    if (cmd) completeCommand(cmd.id, "success");

    const rawSummary = output.split("\n")[0].slice(0, 200);
    const summaryLine = sanitizeResultRow(rawSummary);

    try {
      await storage.createAgentResult({
        programId: prog.id,
        programName: prog.name,
        summary: summaryLine,
        metric: metric || null,
        model: modelUsed,
        tokensUsed,
        iteration: ps.iteration,
        rawOutput: output.slice(0, 100000),
        status: "ok",
      });
    } catch (e) {
      console.error("[agent-runtime] Failed to store result:", e);
    }

    try {
      const metricNum = metric ? parseFloat(metric) : NaN;
      const hasNumericResults = !isNaN(metricNum) && metricNum > 0;
      const hasNonNumericMetric = metric !== undefined && metric !== null && metric !== "" && isNaN(metricNum);
      const hasResults = hasNumericResults || hasNonNumericMetric;
      const isError = output.startsWith("[Inline code error]") || output.startsWith("[Iteration");
      const summaryPrefix = summaryLine.slice(0, 60);
      const metricStr = metric || "";
      const isNovel = hasResults && !recentObservations.some(m =>
        m.content.includes(summaryPrefix) || (metricStr && m.content.includes("metric: " + metricStr))
      ) && !recentOutcomes.some(m =>
        m.content.includes(summaryPrefix)
      );

      if (hasResults && isNovel && !isError) {
        const distilled = `[${new Date().toISOString().slice(0, 10)}] ${programName}: ${summaryLine} (metric: ${metric})`;
        await storage.createMemory({
          programName,
          content: distilled,
          memoryType: "observation",
          tags: [programName, "evaluate", `iteration-${ps.iteration}`],
          relevanceScore: 90,
        });
        emitEvent("memory", `Novel finding filed for "${programName}": ${distilled.slice(0, 100)}`, "info", { program: programName });

        const hadRecentError = recentOutcomes.some(m =>
          m.tags?.includes("error") && m.tags?.includes(programName)
        );
        if (hadRecentError) {
          try {
            const inputSummary = `${programName} (iteration ${ps.iteration})`;
            await addToGoldenSuite(inputSummary, summaryLine.slice(0, 500), programName);
            emitEvent("evolution", `Golden suite: promoted correction for "${programName}"`, "info", { program: programName });
          } catch (e) {
            console.error("[agent-runtime] Failed to promote to golden suite:", e);
          }
        }
      } else if (isError) {
        const errorDistilled = `[${new Date().toISOString().slice(0, 10)}] ${programName} ERROR: ${summaryLine.slice(0, 150)}`;
        await storage.createMemory({
          programName,
          content: errorDistilled,
          memoryType: "outcome",
          tags: [programName, "error", `iteration-${ps.iteration}`],
          relevanceScore: 70,
        });
        emitEvent("memory", `Error outcome filed for "${programName}"`, "info", { program: programName });
      } else if (!hasResults) {
        emitEvent("memory", `Skipped memory for "${programName}": zero results (metric: ${metric || "none"})`, "info", { program: programName });
      } else {
        emitEvent("memory", `Skipped memory for "${programName}": output matches recent memory (not novel)`, "info", { program: programName });
      }
    } catch (e) {
      console.error("[agent-runtime] Failed evaluate phase:", e);
    }

    await extractRecipeDirectives(output, programName, llmConfig);

    try {
      const sessionData = `Program: ${programName}\nIteration: ${ps.iteration}\nModel: ${modelUsed}\nOutput:\n${output.slice(0, 8000)}`;
      const consolidationResult = await runConsolidation(sessionData, programName, llmConfig);
      if (consolidationResult.episodes + consolidationResult.facts + consolidationResult.procedures > 0) {
        emitEvent("memory", `Consolidation for "${programName}": ${consolidationResult.episodes}ep, ${consolidationResult.facts}facts, ${consolidationResult.procedures}proc`, "info", { program: programName });
      }
    } catch (e) {
      console.error("[agent-runtime] Memory consolidation failed:", e);
    }

    try {
      const evolutionResult = await runEvolutionPipeline(output, programName, llmConfig);
      if (evolutionResult) {
        if (evolutionResult.applied) {
          emitEvent("evolution", `Evolution v${evolutionResult.version} applied for "${programName}" (${evolutionResult.observations.length} observations, ${evolutionResult.deltas.length} deltas)`, "info", { program: programName });
        } else if (evolutionResult.rejectionReason) {
          emitEvent("evolution", `Evolution rejected for "${programName}": ${evolutionResult.rejectionReason.slice(0, 150)}`, "info", { program: programName });
        }
      }
    } catch (e) {
      console.error("[agent-runtime] Evolution pipeline failed:", e);
    }

    try {
      const rolledBack = await checkAutoRollback(llmConfig);
      if (rolledBack) {
        emitEvent("evolution", `Auto-rollback triggered for "${programName}" — success rate below threshold`, "info", { program: programName });
      }
    } catch (e) {
      console.error("[agent-runtime] Auto-rollback check failed:", e);
    }

    try {
      const isEpicRelated = programName.toLowerCase().includes("epic") ||
        output.toLowerCase().includes("hyperspace") ||
        output.toLowerCase().includes("galaxy.epic.com");
      if (isEpicRelated && await isGalaxyContextEnabled()) {
        const terms = await extractTermsFromEpicResults(output);
        if (terms.length > 0) {
          await addToContextQueue(terms);
          emitEvent("galaxy-context", `Queued ${terms.length} terms from "${programName}": ${terms.join(", ")}`, "info", { program: programName });
        }
      }
    } catch (e) {
      console.error("[agent-runtime] Galaxy term extraction failed:", e);
    }

    const nextRun = parseSchedule(prog.schedule, ps.lastRun, prog.cronExpression);
    ps.nextRun = nextRun;
    await storage.updateProgramLastRun(prog.id, ps.lastRun, nextRun);

  } catch (err: any) {
    ps.status = "error";
    ps.error = err.message || String(err);
    ps.lastRun = new Date();
    emitEvent("agent-runtime", `Program error: ${programName} — ${ps.error?.slice(0, 100)}`, "error", { program: programName });
    recordAction(getControlMode(), `program-error: ${programName}`, programName, undefined, "error", ps.error?.slice(0, 200));
    if (cmd) completeCommand(cmd.id, "error");

    const prog = await storage.getProgramByName(programName);
    if (prog) {
      try {
        await storage.createAgentResult({
          programId: prog.id,
          programName: prog.name,
          summary: `Error: ${ps.error?.slice(0, 150)}`,
          metric: null,
          model: null,
          tokensUsed: 0,
          iteration: ps.iteration,
          rawOutput: ps.error || "",
          status: "error",
        });
      } catch {}

      try {
        const errorSummary = `Program "${programName}" iteration ${ps.iteration} FAILED: ${ps.error?.slice(0, 150)}`;
        await storage.createMemory({
          programName,
          content: errorSummary,
          memoryType: "outcome",
          tags: [programName, "outcome", "error", `iteration-${ps.iteration}`],
          relevanceScore: 90,
        });
        emitEvent("memory", `Failure outcome memory created for "${programName}"`, "info", { program: programName });
      } catch {}

      const nextRun = parseSchedule(prog.schedule, ps.lastRun, prog.cronExpression);
      ps.nextRun = nextRun;
      await storage.updateProgramLastRun(prog.id, ps.lastRun, nextRun);
    }
  }
}

async function tick(): Promise<void> {
  if (!runtime.active) return;
  if (isAgentPaused()) return;
  runtime.lastTick = new Date();

  try {
    const allPrograms = await storage.getPrograms();
    const now = new Date();

    const budget = await getDailyBudget(storage);
    const budgetExhausted = isBudgetExhausted(budget);

    const knownNames = new Set(allPrograms.map(p => p.name));
    Array.from(runtime.programs.keys()).forEach(name => {
      if (!knownNames.has(name)) runtime.programs.delete(name);
    });

    for (const prog of allPrograms) {
      if (!prog.enabled) continue;

      let ps = runtime.programs.get(prog.name);
      if (!ps) {
        ps = makeProgramState(prog);
        runtime.programs.set(prog.name, ps);
      }

      if (ps.status === "running" || ps.status === "queued") continue;

      const nextRun = ps.nextRun || parseSchedule(prog.schedule, ps.lastRun, prog.cronExpression);
      if (nextRun) ps.nextRun = nextRun;

      const shouldRun =
        (nextRun && nextRun <= now) ||
        (!prog.schedule && ps.iteration === 0 && !ps.lastRun);

      if (shouldRun) {
        const progCfg = prog.config as Record<string, string>;
        const isNoLlm = progCfg?.LLM_REQUIRED === "false" || progCfg?.llmRequired === "false";
        const currentlyExhausted = isBudgetExhausted(await getDailyBudget(storage));
        if (currentlyExhausted && !isNoLlm) {
          emitEvent("agent-runtime", `Budget exhausted, skipping LLM program "${prog.name}"`, "info", { program: prog.name });
          continue;
        }
        ps.status = "queued";
        executeProgram(prog.name).catch(err => {
          console.error(`[agent-runtime] Error executing program "${prog.name}":`, err);
        });
      }
    }

    if (now.getMinutes() < 2) {
      persistQualityScores(storage);
      refreshRosterPricing().catch(() => {});
    }

    if (now.getHours() === 3 && now.getMinutes() < 2) {
      try {
        const result = await runMemoryConsolidation();
        if (result.decayed > 0 || result.merged > 0) {
          emitEvent("memory", `Scheduled consolidation: decayed ${result.decayed}, merged ${result.merged} groups (${result.deleted} removed)`, "info");
        }
      } catch (e) {
        console.error("[agent-runtime] Scheduled consolidation error:", e);
      }
    }
  } catch (err) {
    console.error("[agent-runtime] Tick error:", err);
  }

  try {
    await tickRecipes();
  } catch (err) {
    console.error("[agent-runtime] Recipe tick error:", err);
  }

  try {
    await tickCitrixKeepalive();
  } catch (err) {
    // silent
  }

  try {
    await tickObservationConsolidation();
  } catch (err) {
    console.error("[agent-runtime] Observation consolidation tick error:", err);
  }

  try {
    await tickGalaxyContext();
  } catch (err) {
    console.error("[agent-runtime] Galaxy context tick error:", err);
  }
}

let lastObservationConsolidation = 0;
const OBSERVATION_CONSOLIDATION_INTERVAL_MS = 30 * 60 * 1000;

async function tickObservationConsolidation(): Promise<void> {
  const now = Date.now();
  if (now - lastObservationConsolidation < OBSERVATION_CONSOLIDATION_INTERVAL_MS) return;
  lastObservationConsolidation = now;

  try {
    const unconsolidated = await storage.getUnconsolidatedObservations(1);
    if (unconsolidated.length === 0) return;

    const llmConfig = await getLLMConfig();
    const consolidated = await consolidateObservations(llmConfig);
    if (consolidated > 0) {
      emitEvent("evolution", `Periodic consolidation: ${consolidated} observations consolidated`, "info", {});
    }
  } catch (e) {
    console.error("[agent-runtime] Periodic observation consolidation failed:", e);
  }
}

let lastGalaxyContextTick = 0;
const GALAXY_CONTEXT_INTERVAL_MS = 15 * 60 * 1000;

async function tickGalaxyContext(): Promise<void> {
  const now = Date.now();
  if (now - lastGalaxyContextTick < GALAXY_CONTEXT_INTERVAL_MS) return;
  lastGalaxyContextTick = now;

  try {
    await runGalaxyContextCycle();
  } catch (e) {
    console.error("[agent-runtime] Galaxy context cycle failed:", e);
  }
}

let lastCitrixKeepalive = 0;
const CITRIX_KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000;

async function tickCitrixKeepalive(): Promise<void> {
  const now = Date.now();
  if (now - lastCitrixKeepalive < CITRIX_KEEPALIVE_INTERVAL_MS) return;

  const cfg = await storage.getAgentConfig("citrix_keepalive");
  if (cfg?.value !== "true") return;

  const { isExtensionConnected, smartFetch } = await import("./bridge-queue");
  if (!isExtensionConnected()) return;

  lastCitrixKeepalive = now;
  console.log("[citrix-keepalive] pinging StoreFront session...");

  try {
    await smartFetch("https://cwp.ucsd.edu", "dom", "citrix-keepalive", {
      maxText: 500,
      reuseTab: true,
      spaWaitMs: 1000,
    }, 30000);
    console.log("[citrix-keepalive] session refreshed");
  } catch (e: any) {
    console.log("[citrix-keepalive] ping failed:", e.message);
  }
}

const recipeLastChecked = new Map<number, Date>();

async function tickRecipes(): Promise<void> {
  const allRecipes = await storage.getRecipes();
  const now = new Date();

  for (const recipe of allRecipes) {
    if (!recipe.enabled || !recipe.schedule) continue;

    const cronExpr = recipe.cronExpression || recipe.schedule;
    const lastRun = recipe.lastRun || recipeLastChecked.get(recipe.id) || null;
    const nextRun = recipe.nextRun ? new Date(recipe.nextRun) : parseCronNextRun(cronExpr, lastRun || new Date(now.getTime() - 60000));

    if (!nextRun || nextRun > now) continue;

    recipeLastChecked.set(recipe.id, now);
    emitEvent("agent-runtime", `Running scheduled recipe: ${recipe.name} ("${recipe.command}")`, "action", { metadata: { recipe: recipe.name } });

    try {
      const { executeChainRaw } = await import("./cli-engine");
      const result = await executeChainRaw(recipe.command);
      const nextAfterRun = parseCronNextRun(cronExpr, now);
      if (!nextAfterRun) {
        console.error(`[agent-runtime] WARNING: parseCronNextRun returned null for "${cronExpr}" after ${now.toISOString()}, using 24h fallback`);
      }
      const safeNext = nextAfterRun || new Date(now.getTime() + 86400000);
      await storage.updateRecipeLastRun(recipe.id, now, safeNext, (result.stdout || "").slice(0, 10000));
      emitEvent("agent-runtime", `Recipe complete: ${recipe.name} (exit:${result.exitCode}), next: ${safeNext.toISOString()}`, result.exitCode === 0 ? "info" : "error", { metadata: { recipe: recipe.name, exitCode: result.exitCode } });
    } catch (e: any) {
      console.error(`[agent-runtime] Recipe "${recipe.name}" failed:`, e.message);
      const nextAfterErr = parseCronNextRun(cronExpr, now);
      const safeNext = nextAfterErr || new Date(now.getTime() + 86400000);
      await storage.updateRecipeLastRun(recipe.id, now, safeNext, "Error: " + (e.message || "").slice(0, 500));
    }
  }
}

export function getRuntimeState(): {
  active: boolean;
  lastTick: Date | null;
  programs: Array<ProgramState>;
} {
  return {
    active: runtime.active,
    lastTick: runtime.lastTick,
    programs: Array.from(runtime.programs.values()),
  };
}

export async function getRuntimeBudgetStatus(): Promise<BudgetStatus> {
  return getBudgetStatus(storage);
}

export function toggleRuntime(): boolean {
  runtime.active = !runtime.active;

  if (runtime.active && !tickInterval) {
    tickInterval = setInterval(tick, TICK_INTERVAL_MS);
    tick();
  } else if (!runtime.active && tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }

  return runtime.active;
}

export async function manualTrigger(programName: string): Promise<ProgramState> {
  let ps = runtime.programs.get(programName);
  if (!ps) {
    const prog = await storage.getProgramByName(programName);
    if (!prog) throw new Error(`Program "${programName}" not found`);
    ps = makeProgramState(prog);
    runtime.programs.set(programName, ps);
  }

  if (ps.status === "running" || ps.status === "queued") {
    throw new Error(`Program "${programName}" is already ${ps.status}`);
  }

  ps.status = "queued";
  executeProgram(programName).catch(err => {
    console.error(`[agent-runtime] Error executing program "${programName}":`, err);
  });

  return ps;
}

export async function runMemoryConsolidation(): Promise<{ decayed: number; merged: number; deleted: number }> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const decayed = await storage.consolidateOldMemories(sevenDaysAgo, 10);

  const allMemories = await storage.getAllMemories(500);
  const allOld = allMemories.filter(m => m.lastAccessed.getTime() < sevenDaysAgo.getTime());

  const groups = new Map<string, typeof allOld>();
  for (const m of allOld) {
    const primaryTag = m.tags.length > 0 ? m.tags[0] : "misc";
    const key = `${m.programName || "global"}::${m.memoryType}::${primaryTag}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }

  let merged = 0;
  let deleted = 0;
  for (const [key, mems] of Array.from(groups.entries())) {
    if (mems.length < 3) continue;
    const [prog, mType] = key.split("::");
    const allTags = new Set<string>();
    for (const m of mems) {
      for (const t of m.tags) allTags.add(t);
    }

    const combined = mems.map(m => m.content).join("\n- ");
    let summary: string;
    try {
      const { executeLLM: execLLM } = await import("./llm-client");
      const llmResult = await execLLM(
        [
          { role: "system", content: "You are a memory consolidator. Summarize the following memory entries into a single concise paragraph that preserves all key facts. Output ONLY the summary, no preamble." },
          { role: "user", content: `Consolidate these ${mems.length} memory entries:\n- ${combined}` },
        ],
        undefined,
        { defaultModel: "openrouter/anthropic/claude-sonnet-4", aliases: {}, routing: {} },
        {}
      );
      summary = llmResult.content.trim();
    } catch {
      summary = combined.length > 400 ? combined.slice(0, 397) + "..." : combined;
    }

    await storage.createMemory({
      programName: prog === "global" ? undefined : prog,
      content: `[consolidated] ${summary}`,
      memoryType: mType as "fact" | "outcome" | "observation",
      tags: Array.from(allTags).slice(0, 10),
      relevanceScore: 60,
    });
    merged++;

    for (const m of mems) {
      await storage.deleteMemory(m.id);
      deleted++;
    }
  }

  return { decayed, merged, deleted };
}

async function migratePersistentContextToMemories(): Promise<void> {
  try {
    const existing = await storage.getAgentConfig("persistent_context");
    if (!existing?.value?.trim()) return;

    const memories = await storage.getAllMemories(1);
    if (memories.length > 0) return;

    const lines = existing.value.split("\n").filter(l => l.trim());
    let migrated = 0;
    for (const line of lines) {
      const content = line.replace(/^\[\d{4}-\d{2}-\d{2}T?\d{2}:\d{2}\]\s*/, "").trim();
      if (!content) continue;
      await storage.createMemory({
        content,
        memoryType: "fact",
        tags: extractTags(content),
        relevanceScore: 80,
      });
      migrated++;
    }
    if (migrated > 0) {
      console.log(`[agent-runtime] Migrated ${migrated} persistent_context entries to episodic memory`);
      emitEvent("memory", `Migrated ${migrated} legacy memory entries to episodic memory`, "info");
      await storage.deleteAgentConfig("persistent_context");
      console.log(`[agent-runtime] Cleared legacy persistent_context`);
    }
  } catch (e) {
    console.error("[agent-runtime] Failed to migrate persistent_context:", e);
  }
}

export function initRuntime(): void {
  console.log("[agent-runtime] Initialized (DB-first mode, auto-starting scheduler)");
  runtime.active = true;
  if (!tickInterval) {
    tickInterval = setInterval(tick, TICK_INTERVAL_MS);
    setTimeout(tick, 5000);
  }

  loadRosterFromConfig(storage).then(() => {
    console.log("[agent-runtime] Model roster loaded from config");
    return refreshRosterPricing();
  }).then((updated) => {
    if (updated > 0) console.log(`[agent-runtime] Roster pricing refreshed (${updated} models updated)`);
  }).catch(() => {});

  loadQualityScores(storage).then(() => {
    console.log("[agent-runtime] Quality scores loaded from config");
  }).catch(() => {});

  migratePersistentContextToMemories().catch(e => console.error("[agent-runtime] migration error:", e));

  initQdrant().then(ok => {
    console.log(`[agent-runtime] Qdrant: ${ok ? "connected" : "unavailable (using Postgres fallback)"}`);
  }).catch(() => {
    console.log("[agent-runtime] Qdrant: unavailable (using Postgres fallback)");
  });

  onResume((paused: PausedExecution) => {
    if (paused.type === "program" && paused.programName) {
      const name = paused.programName;
      const ctx = paused.context as Record<string, unknown> | undefined;
      removePausedExecution(paused.id);
      emitEvent("agent-runtime", `Resuming paused program: ${name} (phase: ${ctx?.phase || "fresh"})`, "info", { program: name });

      if (ctx?.phase === "post-llm" && ctx.llmContent) {
        const resumeCtx: ProgramResumeContext = {
          phase: ctx.phase as "post-llm",
          llmContent: ctx.llmContent as string,
          llmModel: ctx.llmModel as string,
          llmTokens: ctx.llmTokens as number,
          iteration: ctx.iteration as number,
        };
        executeProgram(name, resumeCtx);
      } else {
        executeProgram(name);
      }
    }
  });
}

async function extractRecipeDirectives(output: string, programName: string, llmConfig: LLMConfig): Promise<void> {
  const recipePattern = /^RECIPE:\s+(\S+)\s+"([^"]+)"(?:\s+--schedule\s+(\S+))?(?:\s+--desc\s+(.+))?$/gm;
  let match: RegExpExecArray | null;

  while ((match = recipePattern.exec(output)) !== null) {
    const [, name, command, schedule, description] = match;

    try {
      const existing = await storage.getRecipeByName(name);
      if (existing) continue;

      await createGateValidatedProposal({
        section: "RECIPES",
        targetName: name,
        reason: `Auto-proposed by program "${programName}"\nCommand: ${command}${schedule ? `\nSchedule: ${schedule}` : ""}${description ? `\nDescription: ${description}` : ""}`,
        currentContent: "",
        proposedContent: JSON.stringify({ name, command, schedule: schedule || null, description: description || `Auto-generated from ${programName}` }),
        source: "agent",
        proposalType: "change",
      }, llmConfig);

      emitEvent("agent-runtime", `Recipe proposed by ${programName}: "${name}" = ${command}`, "take-over-point", { program: programName, metadata: { recipe: name, command } });
    } catch (e) {
      console.error(`[agent-runtime] Failed to create recipe proposal for "${name}":`, e);
    }
  }
}
