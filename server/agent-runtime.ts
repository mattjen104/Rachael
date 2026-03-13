import { storage } from "./storage";
import { executeLLM, buildProgramPrompt, hasLLMKeys, type LLMResponse, type LLMConfig } from "./llm-client";
import { runHardenedSkill } from "./skill-runner";
import {
  detectTaskType, pickCascadeModels, pickComparisonModels,
  trackTokenUsage, parseCostTier,
  type TaskType, type CostTier,
} from "./model-router";
import { sanitizeResultRow } from "./output-sanitizer";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { Program } from "@shared/schema";

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
  active: false,
  programs: new Map(),
  lastTick: null,
};

let tickInterval: ReturnType<typeof setInterval> | null = null;

const TICK_INTERVAL_MS = 60_000;
const programRuns = new Map<string, Array<{ model: string; tokens: number; timestamp: number }>>();
const proposalCounts = new Map<string, number>();
const MAX_PROPOSALS_PER_ITERATION = 2;

function shortModelName(model: string): string {
  const last = model.split("/").pop() || model;
  return last.replace(/:free$/, "").replace(/-instruct$/, "");
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
    defaultModel: configMap["default_model"] || "openrouter/google/gemma-3-4b-it:free",
    aliases: {},
    routing: {},
  };
}

async function getSoulPrompt(): Promise<string> {
  const soul = await storage.getAgentConfig("soul");
  return soul?.value || "You are a helpful autonomous agent.";
}

async function getMemoryContext(): Promise<{ persistentContext: string }> {
  const mem = await storage.getAgentConfig("persistent_context");
  return { persistentContext: mem?.value || "" };
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
      if (result.content && result.content.length > 0) return result;
    } catch (err: any) {
      lastError = err;
      if (err.message?.includes("429") || err.message?.includes("rate")) {
        rateLimited = true;
      }
      continue;
    }
  }

  throw lastError || new Error("All models in cascade failed");
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

async function executeInlineCode(code: string, config: Record<string, string>): Promise<{ summary: string; metric?: string; proposals?: Array<{ section: string; diff: string; reason: string }> }> {
  const sandbox = `
    const __ctx = { properties: ${JSON.stringify(config)} };
    ${code}
    return execute();
  `;

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction(sandbox);
  const result = await Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Inline code timed out (300s)")), 300_000)
    ),
  ]);

  if (!result || typeof result.summary !== "string") {
    return { summary: String(result || "No output") };
  }
  return result;
}

async function executeProgram(programName: string): Promise<void> {
  const ps = runtime.programs.get(programName);
  if (!ps) return;

  ps.status = "running";
  ps.error = null;

  try {
    ps.iteration += 1;

    const prog = await storage.getProgramByName(programName);
    if (!prog) throw new Error(`Program "${programName}" not found in DB`);

    const llmConfig = await getLLMConfig();
    const soul = await getSoulPrompt();
    const memory = await getMemoryContext();

    let output = "";
    let modelUsed = "inline";
    let tokensUsed = 0;
    let metric: string | undefined;

    if (prog.code) {
      try {
        const result = await executeInlineCode(prog.code, prog.config as Record<string, string> || {});
        output = result.summary;
        metric = result.metric;
        modelUsed = "inline-code";

        if (result.proposals && Array.isArray(result.proposals)) {
          for (const p of result.proposals.slice(0, MAX_PROPOSALS_PER_ITERATION)) {
            try {
              await storage.createProposal({
                section: p.section || "RESEARCH",
                targetName: programName,
                reason: p.reason || p.diff || output.slice(0, 200),
                currentContent: "",
                proposedContent: p.diff || p.reason,
                source: "agent",
                proposalType: "change",
              });
              const count = proposalCounts.get(programName) || 0;
              proposalCounts.set(programName, count + 1);
            } catch (e) {
              console.error("[agent-runtime] Failed to persist inline proposal:", e);
            }
          }
        }
      } catch (err: any) {
        output = `[Inline code error] ${err.message}`;
        ps.status = "error";
        ps.error = err.message;
      }
    } else if (!hasLLMKeys()) {
      output = `[Iteration ${ps.iteration}] No LLM API keys configured.`;
    } else {
      const allSkills = await storage.getSkills();
      const skillBodies = allSkills
        .filter(s => prog.instructions.toLowerCase().includes(s.name.toLowerCase()))
        .map(s => `### Skill: ${s.name}\n${s.content}`);

      const messages = buildProgramPrompt(
        soul,
        skillBodies,
        prog.instructions,
        ps.iteration,
        "",
        { userProfile: "", persistentContext: memory.persistentContext, sessionLog: "" }
      );

      const taskType = detectTaskType(prog.instructions, prog.config?.TASK_TYPE as string);
      const costTier = parseCostTier(prog.costTier);
      const modelOverride = prog.config?.MODEL as string || undefined;

      const llmResult = await executeLLMWithCascade(messages, taskType, costTier, modelOverride, llmConfig);
      output = llmResult.content;
      modelUsed = llmResult.model;
      tokensUsed = llmResult.tokensUsed || 0;
      trackTokenUsage(modelUsed, tokensUsed);

      const outputType = (prog.config?.OUTPUT_TYPE as string || "").toLowerCase();
      if (outputType === "proposal") {
        try {
          await storage.createProposal({
            section: "PROGRAMS",
            targetName: programName,
            reason: `Proposed by "${programName}" (iteration ${ps.iteration}, ${modelUsed})`,
            currentContent: "",
            proposedContent: output.trim(),
            source: "agent",
            proposalType: "change",
          });
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
              await storage.createProposal({
                section: "PROGRAMS",
                targetName: programName,
                reason: `Auto-proposed by "${programName}" at iteration ${ps.iteration}`,
                currentContent: prog.instructions,
                proposedContent: proposeMatch[1].trim(),
                source: "agent",
                proposalType: "change",
              });
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
          const existing = await storage.getAgentConfig("persistent_context");
          const newContext = (existing?.value || "") + "\n" + rememberMatch[1].trim();
          await storage.setAgentConfig("persistent_context", newContext, "memory");
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
        rawOutput: output.slice(0, 50000),
        status: "ok",
      });
    } catch (e) {
      console.error("[agent-runtime] Failed to store result:", e);
    }

    const nextRun = parseSchedule(prog.schedule, ps.lastRun, prog.cronExpression);
    ps.nextRun = nextRun;
    await storage.updateProgramLastRun(prog.id, ps.lastRun, nextRun);

  } catch (err: any) {
    ps.status = "error";
    ps.error = err.message || String(err);
    ps.lastRun = new Date();

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

      const nextRun = parseSchedule(prog.schedule, ps.lastRun, prog.cronExpression);
      ps.nextRun = nextRun;
      await storage.updateProgramLastRun(prog.id, ps.lastRun, nextRun);
    }
  }
}

async function tick(): Promise<void> {
  if (!runtime.active) return;
  runtime.lastTick = new Date();

  try {
    const allPrograms = await storage.getPrograms();
    const now = new Date();

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
        ps.status = "queued";
        executeProgram(prog.name).catch(err => {
          console.error(`[agent-runtime] Error executing program "${prog.name}":`, err);
        });
      }
    }
  } catch (err) {
    console.error("[agent-runtime] Tick error:", err);
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

export function initRuntime(): void {
  console.log("[agent-runtime] Initialized (DB-first mode, auto-starting scheduler)");
  if (!runtime.active) {
    runtime.active = true;
    tickInterval = setInterval(tick, TICK_INTERVAL_MS);
    setTimeout(tick, 5000);
  }
}
