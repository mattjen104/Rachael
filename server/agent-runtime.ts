import { storage } from "./storage";
import { executeLLM, buildProgramPrompt, hasLLMKeys, type LLMResponse, type LLMConfig } from "./llm-client";
import { runHardenedSkill } from "./skill-runner";
import {
  detectTaskType, pickCascadeModels, pickComparisonModels,
  trackTokenUsage, parseCostTier,
  type TaskType, type CostTier,
} from "./model-router";
import { sanitizeResultRow } from "./output-sanitizer";
import { emitEvent } from "./event-bus";
import { isAgentPaused, shouldYield, recordAction, getControlMode, enqueueCommand, completeCommand, pauseExecution, onResume, removePausedExecution, getPausedExecutions, type PausedExecution } from "./control-bus";
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

const INLINE_SCRIPTS_DIR = join(process.cwd(), ".inline-scripts");

async function executeInlineCode(code: string, config: Record<string, string>): Promise<{ summary: string; metric?: string; proposals?: Array<{ section: string; diff: string; reason: string }> }> {
  await mkdir(INLINE_SCRIPTS_DIR, { recursive: true });

  const filename = `prog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.ts`;
  const filepath = join(INLINE_SCRIPTS_DIR, filename);
  const projectRoot = process.cwd();

  const wrappedCode = `
const __ctx = JSON.parse(process.env.__INLINE_CTX || '{}');
const __projectRoot = process.env.__PROJECT_ROOT || process.cwd();
const __skillPath = (name: string) => __projectRoot + "/skills/" + name;

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
    const memory = await getMemoryContext();

    let output = "";
    let modelUsed = "inline";
    let tokensUsed = 0;
    let metric: string | undefined;

    if (isResume) {
      output = resumeCtx.llmContent;
      modelUsed = resumeCtx.llmModel;
      tokensUsed = resumeCtx.llmTokens;
      trackTokenUsage(modelUsed, tokensUsed);
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

      if (shouldYield()) {
        ps.status = "idle";
        pauseExecution({ type: "program", programName, stepIndex: ps.iteration, context: { phase: "pre-llm" } });
        emitEvent("agent-runtime", `Program "${programName}" paused: human took control (will resume)`, "info", { program: programName });
        recordAction(getControlMode(), `program-paused: ${programName}`, programName, undefined, "paused");
        if (cmd) completeCommand(cmd.id, "error");
        return;
      }

      emitEvent("agent-runtime", `Calling LLM for "${programName}" (${taskType})`, "action", { program: programName });
      const llmResult = await executeLLMWithCascade(messages, taskType, costTier, modelOverride, llmConfig);

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
      trackTokenUsage(modelUsed, tokensUsed);
      emitEvent("agent-runtime", `LLM response received for "${programName}" (${tokensUsed} tokens, ${shortModelName(modelUsed)})`, "info", { program: programName });

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

  onResume((paused: PausedExecution) => {
    if (paused.type === "program" && paused.programName) {
      const name = paused.programName;
      const ctx = paused.context as Record<string, unknown> | undefined;
      removePausedExecution(paused.id);
      emitEvent("agent-runtime", `Resuming paused program: ${name} (phase: ${ctx?.phase || "fresh"})`, "info", { program: name });

      if (ctx?.phase === "post-llm" && ctx.llmContent) {
        const resumeCtx: ProgramResumeContext = {
          phase: "post-llm",
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
