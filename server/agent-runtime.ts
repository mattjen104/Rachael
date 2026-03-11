import { storage } from "./storage";
import { compileOpenClaw, appendResultToProgram, type Program } from "./openclaw-compiler";
import { executeLLM, buildProgramPrompt, hasLLMKeys, type LLMResponse } from "./llm-client";
import { runHardenedSkill, getHardenCandidatesFromRuntime } from "./skill-runner";

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

export function getRuntimeState(): {
  active: boolean;
  lastTick: string | null;
  programs: Record<string, Omit<ProgramState, "name">>;
} {
  const programs: Record<string, Omit<ProgramState, "name">> = {};
  Array.from(runtime.programs.entries()).forEach(([name, state]) => {
    const { name: _n, ...rest } = state;
    programs[name] = rest;
  });
  return {
    active: runtime.active,
    lastTick: runtime.lastTick?.toISOString() ?? null,
    programs,
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

async function executeProgram(programName: string): Promise<void> {
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

    let output: string;

    const isHardened = prog.tags.includes("hardened") && prog.properties.SCRIPT;
    if (isHardened) {
      const result = await runHardenedSkill(prog.properties.SCRIPT, {
        orgContent: file.content,
        programName,
        lastResults: prog.results,
        iteration: ps.iteration,
      });
      output = result.summary;
      if (result.metric) output += ` | metric: ${result.metric}`;
      if (result.proposal) {
        try {
          await storage.createProposal({
            section: "SKILLS",
            targetName: programName,
            reason: `Hardened skill "${programName}" proposed a change`,
            currentContent: prog.instructions,
            proposedContent: result.proposal,
            status: "pending",
          });
        } catch (e) {
          console.error("[agent-runtime] Failed to create proposal from hardened skill:", e);
        }
      }
    } else if (!hasLLMKeys()) {
      output = `[Iteration ${ps.iteration}] No LLM API keys configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable execution.`;
    } else {
      const skillBodies = compiled.skills
        .filter(s => prog.instructions.toLowerCase().includes(s.name.toLowerCase()))
        .map(s => `### Skill: ${s.name}\n${s.content}`);

      const messages = buildProgramPrompt(
        compiled.soul,
        skillBodies,
        prog.instructions,
        ps.iteration,
        prog.results
      );

      const modelOverride = prog.properties.MODEL || undefined;
      const llmResult: LLMResponse = await executeLLM(
        messages,
        modelOverride,
        compiled.config,
        compiled.routing as Record<string, string | undefined>
      );

      output = llmResult.content;

      if (output.includes("PROPOSE:")) {
        const proposeMatch = output.match(/PROPOSE:\s*([\s\S]*?)(?:\n\n|$)/);
        if (proposeMatch) {
          try {
            await storage.createProposal({
              section: "PROGRAMS",
              targetName: programName,
              reason: `Auto-proposed by program "${programName}" at iteration ${ps.iteration}`,
              currentContent: prog.instructions,
              proposedContent: proposeMatch[1].trim(),
              status: "pending",
            });
          } catch (e) {
            console.error("[agent-runtime] Failed to create proposal:", e);
          }
        }
      }
    }

    ps.lastOutput = output;
    ps.status = "completed";
    ps.lastRun = new Date();

    const summaryLine = output.split("\n")[0].slice(0, 200);
    const resultRow = `| ${ps.iteration} | ${summaryLine} | - | ok |`;

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
      if (scheduledDate && scheduledDate <= now) {
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
