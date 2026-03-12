import { storage } from "./storage";
import { compileOpenClaw, appendResultToProgram, appendToMemorySection, type Program } from "./openclaw-compiler";
import { executeLLM, buildProgramPrompt, hasLLMKeys, type LLMResponse } from "./llm-client";
import { runHardenedSkill, getHardenCandidatesFromRuntime } from "./skill-runner";
import {
  detectTaskType, pickModel, pickCascadeModels, pickComparisonModels,
  trackTokenUsage, getDailyTokenUsage, parseCostTier,
  type TaskType, type CostTier,
} from "./model-router";
import { sanitizeResultRow } from "./output-sanitizer";
import { writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";

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
const programMeta = new Map<string, { tokenBudget: number; costTier: string }>();
const proposalCounts = new Map<string, number>();
const programCodeCache = new Map<string, boolean>();
const MAX_PROPOSALS_PER_ITERATION = 2;

function shortModelName(model: string): string {
  const last = model.split("/").pop() || model;
  return last.replace(/:free$/, "").replace(/-instruct$/, "");
}

function resolveProviderPrefix(modelId: string): string {
  if (process.env.OPENROUTER_API_KEY) {
    return `openrouter/${modelId}`;
  }
  if (modelId.startsWith("anthropic/") && process.env.ANTHROPIC_API_KEY) {
    return modelId;
  }
  if (modelId.startsWith("openai/") && process.env.OPENAI_API_KEY) {
    return modelId;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return `anthropic/claude-sonnet-4-6`;
  }
  if (process.env.OPENAI_API_KEY) {
    return `openai/gpt-4o-mini`;
  }
  return `openrouter/${modelId}`;
}

async function executeLLMWithCascade(
  messages: import("./llm-client").LLMMessage[],
  taskType: TaskType,
  costTier: CostTier,
  modelOverride: string | undefined,
  compiled: ReturnType<typeof compileOpenClaw>
): Promise<LLMResponse> {
  if (modelOverride) {
    return executeLLM(messages, modelOverride, compiled.config, compiled.routing as Record<string, string | undefined>);
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return executeLLM(messages, undefined, compiled.config, compiled.routing as Record<string, string | undefined>);
  }

  const cascade = pickCascadeModels(taskType, costTier);
  if (cascade.length === 0) {
    return executeLLM(messages, undefined, compiled.config, compiled.routing as Record<string, string | undefined>);
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
        compiled.config,
        compiled.routing as Record<string, string | undefined>
      );
      if (result.content && result.content.trim().length > 0) {
        return result;
      }
      lastError = new Error(`Empty response from ${model.label}`);
    } catch (err: any) {
      console.warn(`[agent-runtime] Model ${model.label} failed, cascading: ${err.message}`);
      lastError = err;
      if (err.message?.includes("429")) {
        rateLimited = true;
      }
    }
  }

  if (rateLimited && cascade.length > 0) {
    console.log("[agent-runtime] All models rate-limited, retrying cascade after delay...");
    await new Promise(r => setTimeout(r, 15000));
    for (const model of cascade) {
      try {
        return await executeLLM(
          messages,
          resolveProviderPrefix(model.id),
          compiled.config,
          compiled.routing as Record<string, string | undefined>
        );
      } catch (err: any) {
        console.warn(`[agent-runtime] Retry: ${model.label} still failing: ${err.message?.slice(0, 100)}`);
        lastError = err;
      }
    }
  }

  throw lastError || new Error("All cascade models failed");
}

export function getRuntimeState(): {
  active: boolean;
  lastTick: string | null;
  programs: Record<string, Omit<ProgramState, "name"> & { lastModel?: string; tokensBurned?: number; tokenBudget?: number; costTier?: string; hasCode?: boolean }>;
  tokenBudget: { total: number; byModel: Record<string, number> };
} {
  const programs: Record<string, Omit<ProgramState, "name"> & { lastModel?: string; tokensBurned?: number; tokenBudget?: number; costTier?: string; hasCode?: boolean }> = {};

  Array.from(runtime.programs.entries()).forEach(([name, state]) => {
    const { name: _n, ...rest } = state;
    const runs = programRuns.get(name);
    const lastRun = runs?.length ? runs[runs.length - 1] : null;
    const meta = programMeta.get(name);
    programs[name] = {
      ...rest,
      lastModel: lastRun ? shortModelName(lastRun.model) : undefined,
      tokensBurned: runs?.reduce((s, r) => s + r.tokens, 0) || 0,
      tokenBudget: meta?.tokenBudget ?? 4096,
      costTier: meta?.costTier ?? "free",
      hasCode: programCodeCache.get(name) ?? false,
    };
  });
  return {
    active: runtime.active,
    lastTick: runtime.lastTick?.toISOString() ?? null,
    programs,
    tokenBudget: getDailyTokenUsage(),
  };
}

export function getHardenCandidates(): Array<{ programName: string; code: string }> {
  return getHardenCandidatesFromRuntime(runtime.programs);
}

export function toggleRuntime(): boolean {
  runtime.active = !runtime.active;

  if (runtime.active && !tickInterval) {
    tickInterval = setInterval(tick, TICK_INTERVAL_MS);
    tick();
  }

  if (!runtime.active && tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }

  return runtime.active;
}

export async function manualTrigger(programName: string): Promise<ProgramState | null> {
  const state = runtime.programs.get(programName);
  if (!state) {
    const file = await storage.getOrgFileByName("openclaw.org");
    if (!file) return null;
    const compiled = compileOpenClaw(file.content);
    const prog = compiled.programs.find(p => p.name === programName);
    if (!prog) return null;
    const newState = makeProgramState(prog);
    runtime.programs.set(programName, newState);
  }

  const ps = runtime.programs.get(programName)!;
  if (ps.status === "running") return ps;

  ps.status = "queued";
  await executeProgram(programName);
  return runtime.programs.get(programName)!;
}

export async function manualResearch(programName: string): Promise<ProgramState | null> {
  const state = runtime.programs.get(programName);
  if (!state) {
    const file = await storage.getOrgFileByName("openclaw.org");
    if (!file) return null;
    const compiled = compileOpenClaw(file.content);
    const prog = compiled.programs.find(p => p.name === programName);
    if (!prog) return null;
    const newState = makeProgramState(prog);
    runtime.programs.set(programName, newState);
  }

  const ps = runtime.programs.get(programName)!;
  if (ps.status === "running") return ps;

  ps.status = "queued";
  await executeProgramResearch(programName);
  return runtime.programs.get(programName)!;
}

function makeProgramState(program: Program): ProgramState {
  const nextRun = parseScheduledDate(program.scheduledRaw);
  return {
    name: program.name,
    status: "idle",
    lastRun: null,
    nextRun,
    lastOutput: null,
    error: null,
    iteration: 0,
  };
}

function parseScheduledDate(scheduledRaw: string | null): Date | null {
  if (!scheduledRaw) return null;
  const match = scheduledRaw.match(/<(\d{4}-\d{2}-\d{2})\s+[A-Za-z]+(?:\s+(\d{2}:\d{2}))?/);
  if (!match) return null;
  const dateStr = match[1];
  const timeStr = match[2] || "00:00";
  return new Date(`${dateStr}T${timeStr}:00`);
}

function parseRepeater(scheduledRaw: string | null): { value: number; unit: string } | null {
  if (!scheduledRaw) return null;
  const match = scheduledRaw.match(/\+(\d+)(min|h|d|w|m|y)/);
  if (!match) return null;
  return { value: parseInt(match[1], 10), unit: match[2] };
}

function computeNextRun(from: Date, repeater: { value: number; unit: string }): Date {
  const next = new Date(from);
  switch (repeater.unit) {
    case "min":
      next.setMinutes(next.getMinutes() + repeater.value);
      break;
    case "h":
      next.setHours(next.getHours() + repeater.value);
      break;
    case "d":
      next.setDate(next.getDate() + repeater.value);
      break;
    case "w":
      next.setDate(next.getDate() + repeater.value * 7);
      break;
    case "m":
      next.setMonth(next.getMonth() + repeater.value);
      break;
    case "y":
      next.setFullYear(next.getFullYear() + repeater.value);
      break;
  }
  return next;
}

function formatOrgDate(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const dayName = days[date.getDay()];
  const timeStr = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${dateStr} ${dayName} ${timeStr}`;
}

async function bumpSchedule(programName: string, scheduledRaw: string): Promise<void> {
  const repeater = parseRepeater(scheduledRaw);
  if (!repeater) return;

  const now = new Date();
  let nextDate = parseScheduledDate(scheduledRaw) || now;

  while (nextDate <= now) {
    nextDate = computeNextRun(nextDate, repeater);
  }

  const repeaterStr = scheduledRaw.match(/(\+\d+(?:min|h|d|w|m|y))/)?.[1] || "";
  const newTimestamp = `<${formatOrgDate(nextDate)} ${repeaterStr}>`;

  const file = await storage.getOrgFileByName("openclaw.org");
  if (!file) return;

  const lines = file.content.split("\n");

  let programLineIdx = -1;
  let programLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const hm = lines[i].match(/^(\*+)\s+(?:TODO|DONE)\s+(.*?)(?:\s+:[a-zA-Z0-9_@:-]+:)?\s*$/);
    if (hm && hm[2].trim() === programName) {
      programLineIdx = i;
      programLevel = hm[1].length;
      break;
    }
  }

  if (programLineIdx === -1) return;

  for (let i = programLineIdx + 1; i < lines.length; i++) {
    const headMatch = lines[i].match(/^(\*+)\s/);
    if (headMatch && headMatch[1].length <= programLevel) break;

    if (lines[i].match(/^\s*SCHEDULED:\s*<[^>]*>/)) {
      lines[i] = lines[i].replace(/SCHEDULED:\s*<[^>]*>/, `SCHEDULED: ${newTimestamp}`);
      break;
    }
  }

  const newContent = lines.join("\n");
  if (newContent !== file.content) {
    await storage.updateOrgFileContent(file.id, newContent);
  }

  const ps = runtime.programs.get(programName);
  if (ps) {
    ps.nextRun = nextDate;
  }
}

const INLINE_SCRIPTS_DIR = join(process.cwd(), ".inline-scripts");

async function executeInlineCode(
  code: string,
  lang: string,
  context: { orgContent: string; programName: string; lastResults: string; iteration: number; properties?: Record<string, string> }
): Promise<{ summary: string; metric?: string }> {
  await mkdir(INLINE_SCRIPTS_DIR, { recursive: true });

  const ext = lang === "typescript" || lang === "ts" ? "ts" : "js";
  const filename = `${context.programName.replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}.${ext}`;
  const filepath = join(INLINE_SCRIPTS_DIR, filename);

  const cleanedCode = code
    .replace(/export\s+default\s+/g, "")
    .replace(/export\s+(?=async\s+function|function)/g, "");

  const wrappedCode = `
const __ctx = JSON.parse(process.env.__INLINE_CTX || '{}');

${cleanedCode}

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
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || `${process.env.HOME || "/tmp"}/.config`,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || `${process.env.HOME || "/tmp"}/.cache`,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME || `${process.env.HOME || "/tmp"}/.local/share`,
      TMPDIR: process.env.TMPDIR || "/tmp",
      __INLINE_CTX: JSON.stringify(context),
    };

    if (process.env.OPENROUTER_API_KEY) {
      safeEnv.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    }

    const rawTimeout = context.properties?.TIMEOUT
      ? parseInt(context.properties.TIMEOUT, 10)
      : 120;
    const timeoutMs = Math.max(10, Math.min(isNaN(rawTimeout) ? 120 : rawTimeout, 600)) * 1000;

    const { stdout, stderr } = await execFileAsync(
      "npx", ["tsx", filepath],
      { env: safeEnv, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }
    );

    if (stderr && !stdout) {
      return { summary: `Script error: ${stderr.slice(0, 500)}` };
    }

    try {
      const parsed = JSON.parse(stdout.trim());
      return {
        summary: parsed.summary || String(parsed),
        metric: parsed.metric,
      };
    } catch {
      return { summary: stdout.trim().slice(0, 2000) || "Script completed with no output" };
    }
  } finally {
    try { await unlink(filepath); } catch {}
  }
}

async function executeProgram(programName: string): Promise<void> {
  const ps = runtime.programs.get(programName);
  if (!ps) return;

  ps.status = "running";
  ps.error = null;

  let prog: ReturnType<typeof compileOpenClaw>["programs"][number] | undefined;

  try {
    ps.iteration += 1;

    const file = await storage.getOrgFileByName("openclaw.org");
    if (!file) throw new Error("openclaw.org not found");

    const compiled = compileOpenClaw(file.content);
    prog = compiled.programs.find(p => p.name === programName);
    if (!prog) throw new Error(`Program "${programName}" not found in compiled output`);

    programMeta.set(programName, {
      tokenBudget: prog.properties.TOKEN_BUDGET ? parseInt(prog.properties.TOKEN_BUDGET, 10) : 4096,
      costTier: prog.properties.COST_TIER || "free",
    });

    let output: string;

    const hasInlineCode = !!prog.codeBlock;
    programCodeCache.set(programName, hasInlineCode);
    const isHardened = prog.tags.includes("hardened") && prog.properties.SCRIPT;

    if (hasInlineCode) {
      const result = await executeInlineCode(
        prog.codeBlock!,
        prog.codeLang || "typescript",
        { orgContent: file.content, programName, lastResults: prog.results, iteration: ps.iteration, properties: prog.properties }
      );
      output = result.summary;
      if (result.metric) output += ` | metric: ${result.metric}`;
    } else if (isHardened) {
      const result = await runHardenedSkill(prog.properties.SCRIPT, {
        orgContent: file.content,
        programName,
        lastResults: prog.results,
        iteration: ps.iteration,
      });
      output = result.summary;
      if (result.metric) output += ` | metric: ${result.metric}`;
      if (result.proposal) {
        const count = proposalCounts.get(programName) || 0;
        if (count >= MAX_PROPOSALS_PER_ITERATION) {
          console.log(`[SANDBOX] rate-limited proposal from hardened skill "${programName}" (${count}/${MAX_PROPOSALS_PER_ITERATION})`);
        } else {
          try {
            await storage.createProposal({
              section: "SKILLS",
              targetName: programName,
              reason: `Hardened skill "${programName}" proposed a change`,
              currentContent: prog.instructions,
              proposedContent: result.proposal,
              source: "agent",
              proposalType: "change",
            });
            proposalCounts.set(programName, count + 1);
            console.log(`[SANDBOX] proposal created: source=agent, section=SKILLS, program=${programName}`);
          } catch (e) {
            console.error("[agent-runtime] Failed to create proposal from hardened skill:", e);
          }
        }
      }
    } else if (!hasLLMKeys()) {
      output = `[Iteration ${ps.iteration}] No LLM API keys configured. Set OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY to enable execution.`;
    } else {
      const skillBodies = compiled.skills
        .filter(s => prog.instructions.toLowerCase().includes(s.name.toLowerCase()))
        .map(s => `### Skill: ${s.name}\n${s.content}`);

      const messages = buildProgramPrompt(
        compiled.soul,
        skillBodies,
        prog.instructions,
        ps.iteration,
        prog.results,
        compiled.memory
      );

      const taskType = detectTaskType(prog.instructions, prog.properties.TASK_TYPE);
      const costTier = parseCostTier(prog.properties.COST_TIER);
      const compareMode = prog.properties.COMPARE_MODELS === "true";
      const modelOverride = prog.properties.MODEL || undefined;

      let llmResult: LLMResponse;
      let modelUsed = "unknown";
      let tokensUsed = 0;

      if (compareMode && !modelOverride) {
        const pair = pickComparisonModels(taskType, costTier);
        if (pair) {
          const [modelA, modelB] = pair;
          const [resA, resB] = await Promise.allSettled([
            executeLLM(messages, resolveProviderPrefix(modelA.id), compiled.config, compiled.routing as Record<string, string | undefined>),
            executeLLM(messages, resolveProviderPrefix(modelB.id), compiled.config, compiled.routing as Record<string, string | undefined>),
          ]);

          const outA = resA.status === "fulfilled" ? resA.value.content : `[error: ${(resA as PromiseRejectedResult).reason?.message || "failed"}]`;
          const outB = resB.status === "fulfilled" ? resB.value.content : `[error: ${(resB as PromiseRejectedResult).reason?.message || "failed"}]`;
          const tokA = resA.status === "fulfilled" ? (resA.value.tokensUsed || 0) : 0;
          const tokB = resB.status === "fulfilled" ? (resB.value.tokensUsed || 0) : 0;

          trackTokenUsage(modelA.id, tokA);
          trackTokenUsage(modelB.id, tokB);
          tokensUsed = tokA + tokB;
          modelUsed = `${modelA.label} vs ${modelB.label}`;

          const summaryA = outA.split("\n")[0].slice(0, 120);
          const summaryB = outB.split("\n")[0].slice(0, 120);
          output = `[COMPARE] ${modelA.label}: ${summaryA}\n[COMPARE] ${modelB.label}: ${summaryB}`;
          llmResult = { content: output, model: modelUsed, tokensUsed };
        } else {
          llmResult = await executeLLMWithCascade(messages, taskType, costTier, modelOverride, compiled);
          output = llmResult.content;
          modelUsed = llmResult.model;
          tokensUsed = llmResult.tokensUsed || 0;
          trackTokenUsage(modelUsed, tokensUsed);
        }
      } else {
        llmResult = await executeLLMWithCascade(messages, taskType, costTier, modelOverride, compiled);
        output = llmResult.content;
        modelUsed = llmResult.model;
        tokensUsed = llmResult.tokensUsed || 0;
        trackTokenUsage(modelUsed, tokensUsed);
      }

      const pr = programRuns.get(programName) || [];
      pr.push({ model: modelUsed, tokens: tokensUsed, timestamp: Date.now() });
      programRuns.set(programName, pr);

      const outputType = (prog.properties.OUTPUT_TYPE || "").toLowerCase();

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
          console.log(`[runtime] auto-proposal created from ${programName} output (${output.length} chars)`);
        } catch (e) {
          console.error("[agent-runtime] Failed to create auto-proposal:", e);
        }
      } else {
        if (output.includes("PROPOSE:")) {
          const proposeMatch = output.match(/PROPOSE:\s*([\s\S]*?)(?:\n\n|$)/);
          if (proposeMatch) {
            const proposedText = proposeMatch[1].trim();
            const targetsSoul = /\bSOUL\b/i.test(proposedText) && /^\*{1,2}\s+/m.test(proposedText);
            if (targetsSoul) {
              console.log(`[SANDBOX] blocked SOUL modification attempt from program "${programName}"`);
            } else {
              const count = proposalCounts.get(programName) || 0;
              if (count >= MAX_PROPOSALS_PER_ITERATION) {
                console.log(`[SANDBOX] rate-limited proposal from "${programName}" (${count}/${MAX_PROPOSALS_PER_ITERATION})`);
              } else {
                try {
                  await storage.createProposal({
                    section: "PROGRAMS",
                    targetName: programName,
                    reason: `Auto-proposed by program "${programName}" at iteration ${ps.iteration}`,
                    currentContent: prog.instructions,
                    proposedContent: proposedText,
                    source: "agent",
                    proposalType: "change",
                  });
                  proposalCounts.set(programName, count + 1);
                  console.log(`[SANDBOX] proposal created: source=agent, section=PROGRAMS, program=${programName}`);
                } catch (e) {
                  console.error("[agent-runtime] Failed to create proposal:", e);
                }
              }
            }
          }
        }

        if (output.includes("REMEMBER:")) {
          const rememberMatch = output.match(/REMEMBER:\s*([\s\S]*?)(?:\n\n|$)/);
          if (rememberMatch) {
            const memoryText = rememberMatch[1].trim();
            const count = proposalCounts.get(programName) || 0;
            if (count >= MAX_PROPOSALS_PER_ITERATION) {
              console.log(`[SANDBOX] rate-limited memory proposal from "${programName}" (${count}/${MAX_PROPOSALS_PER_ITERATION})`);
            } else {
              try {
                await storage.createProposal({
                  section: "MEMORY",
                  targetName: "Persistent Context",
                  reason: `Program "${programName}" wants to remember: ${memoryText.slice(0, 100)}`,
                  currentContent: "",
                  proposedContent: memoryText,
                  source: "agent",
                  proposalType: "memory",
                });
                proposalCounts.set(programName, count + 1);
                console.log(`[SANDBOX] memory proposal created: source=agent, program=${programName}`);
              } catch (e) {
                console.error("[agent-runtime] Failed to create memory proposal:", e);
              }
            }
          }
        }
      }
    }

    proposalCounts.delete(programName);

    ps.lastOutput = output;
    ps.status = "completed";
    ps.lastRun = new Date();

    const rawSummary = output.split("\n")[0].slice(0, 200);
    const summaryLine = sanitizeResultRow(rawSummary);
    const lastRun = programRuns.get(programName);
    const lastModel = lastRun?.length ? lastRun[lastRun.length - 1].model : "-";
    const lastTokens = lastRun?.length ? lastRun[lastRun.length - 1].tokens : 0;
    const resultRow = `| ${ps.iteration} | ${summaryLine} | ${shortModelName(lastModel)} | ${lastTokens} | ok |`;

    const freshFile = await storage.getOrgFileByName("openclaw.org");
    if (freshFile) {
      const updatedContent = appendResultToProgram(freshFile.content, programName, resultRow);
      if (updatedContent !== freshFile.content) {
        await storage.updateOrgFileContent(freshFile.id, updatedContent);
      }
    }

    if (prog.scheduledRaw) {
      await bumpSchedule(programName, prog.scheduledRaw);
    }
  } catch (err: any) {
    ps.status = "error";
    ps.error = err.message || String(err);
    ps.lastRun = new Date();

    if (prog?.scheduledRaw) {
      await bumpSchedule(programName, prog.scheduledRaw);
    }
  }
}

async function executeProgramResearch(programName: string): Promise<void> {
  const ps = runtime.programs.get(programName);
  if (!ps) return;

  ps.status = "running";
  ps.error = null;

  try {
    ps.iteration += 1;

    const file = await storage.getOrgFileByName("openclaw.org");
    if (!file) throw new Error("openclaw.org not found");

    const compiled = compileOpenClaw(file.content);
    const prog = compiled.programs.find(p => p.name === programName);
    if (!prog) throw new Error(`Program "${programName}" not found in compiled output`);

    if (!hasLLMKeys()) {
      ps.lastOutput = `[Research] No LLM API keys configured.`;
      ps.status = "error";
      ps.error = "No LLM keys";
      ps.lastRun = new Date();
      return;
    }

    const researchPrompt = prog.codeBlock
      ? `You are improving this program's code. Current code:\n\`\`\`${prog.codeLang || "typescript"}\n${prog.codeBlock}\n\`\`\`\n\nInstructions: ${prog.instructions}\n\nPrevious results:\n${prog.results}\n\nAnalyze the current code and suggest improvements. Use PROPOSE: to suggest new code that should replace the current code block.`
      : prog.instructions;

    const skillBodies = compiled.skills
      .filter(s => prog.instructions.toLowerCase().includes(s.name.toLowerCase()))
      .map(s => `### Skill: ${s.name}\n${s.content}`);

    const messages = buildProgramPrompt(
      compiled.soul,
      skillBodies,
      researchPrompt,
      ps.iteration,
      prog.results,
      compiled.memory
    );

    const taskType = detectTaskType(prog.instructions, prog.properties.TASK_TYPE);
    const costTier = parseCostTier(prog.properties.COST_TIER);
    const modelOverride = prog.properties.MODEL || undefined;

    const llmResult = await executeLLMWithCascade(messages, taskType, costTier, modelOverride, compiled);
    const output = llmResult.content;
    const modelUsed = llmResult.model;
    const tokensUsed = llmResult.tokensUsed || 0;
    trackTokenUsage(modelUsed, tokensUsed);

    const pr = programRuns.get(programName) || [];
    pr.push({ model: modelUsed, tokens: tokensUsed, timestamp: Date.now() });
    programRuns.set(programName, pr);

    if (output.includes("PROPOSE:")) {
      const proposeMatch = output.match(/PROPOSE:\s*([\s\S]*?)(?:\n\n|$)/);
      if (proposeMatch) {
        const proposedText = proposeMatch[1].trim();
        try {
          await storage.createProposal({
            section: "PROGRAMS",
            targetName: programName,
            reason: `[Research] Auto-improvement for "${programName}" at iteration ${ps.iteration}`,
            currentContent: prog.codeBlock || prog.instructions,
            proposedContent: proposedText,
            source: "agent",
            proposalType: "change",
          });
          console.log(`[RESEARCH] proposal created for program=${programName}`);
        } catch (e) {
          console.error("[agent-runtime] Failed to create research proposal:", e);
        }
      }
    }

    proposalCounts.delete(programName);
    ps.lastOutput = `[Research] ${output.split("\n")[0].slice(0, 200)}`;
    ps.status = "completed";
    ps.lastRun = new Date();

    const summaryLine = sanitizeResultRow(`[research] ${output.split("\n")[0].slice(0, 180)}`);
    const lastModel = modelUsed;
    const resultRow = `| ${ps.iteration} | ${summaryLine} | ${shortModelName(lastModel)} | ${tokensUsed} | research |`;

    const freshFile = await storage.getOrgFileByName("openclaw.org");
    if (freshFile) {
      const updatedContent = appendResultToProgram(freshFile.content, programName, resultRow);
      if (updatedContent !== freshFile.content) {
        await storage.updateOrgFileContent(freshFile.id, updatedContent);
      }
    }
  } catch (err: any) {
    ps.status = "error";
    ps.error = err.message || String(err);
    ps.lastRun = new Date();
  }
}

async function tick(): Promise<void> {
  if (!runtime.active) return;

  runtime.lastTick = new Date();

  try {
    const file = await storage.getOrgFileByName("openclaw.org");
    if (!file) return;

    const compiled = compileOpenClaw(file.content);
    const now = new Date();

    const knownNames = new Set(compiled.programs.map(p => p.name));
    Array.from(runtime.programs.keys()).forEach(name => {
      if (!knownNames.has(name)) {
        runtime.programs.delete(name);
      }
    });

    for (const prog of compiled.programs) {
      if (prog.status !== "TODO") continue;
      if (!prog.tags.every(() => true)) continue;

      programMeta.set(prog.name, {
        tokenBudget: prog.properties.TOKEN_BUDGET ? parseInt(prog.properties.TOKEN_BUDGET, 10) : 4096,
        costTier: prog.properties.COST_TIER || "free",
      });
      programCodeCache.set(prog.name, !!prog.codeBlock);

      let ps = runtime.programs.get(prog.name);
      if (!ps) {
        ps = makeProgramState(prog);
        runtime.programs.set(prog.name, ps);
      } else {
        const nextRun = parseScheduledDate(prog.scheduledRaw);
        if (nextRun) ps.nextRun = nextRun;
      }

      if (ps.status === "running" || ps.status === "queued") continue;

      const scheduledDate = parseScheduledDate(prog.scheduledRaw);
      const isOnce = prog.schedule === "once" || (!prog.scheduledRaw && !prog.schedule);
      const shouldRun =
        (scheduledDate && scheduledDate <= now) ||
        (isOnce && ps.iteration === 0 && !ps.lastRun);

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
