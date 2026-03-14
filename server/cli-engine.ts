import { storage } from "./storage";
import { manualTrigger, getRuntimeState } from "./agent-runtime";
import { emitEvent } from "./event-bus";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface PresentedResult {
  output: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
  originalLines: number;
}

type CommandHandler = (args: string[], stdin: string) => Promise<CommandResult>;

interface RegisteredCommand {
  name: string;
  summary: string;
  usage: string;
  handler: CommandHandler;
}

const commands = new Map<string, RegisteredCommand>();

const MAX_PRESENT_LINES = 200;
const MAX_PRESENT_BYTES = 50_000;

export function registerCommand(name: string, summary: string, usage: string, handler: CommandHandler): void {
  commands.set(name, { name, summary, usage, handler });
}

function getCommandList(): string {
  const lines: string[] = ["Available commands:"];
  const sorted = Array.from(commands.values()).sort((a, b) => a.name.localeCompare(b.name));
  const maxLen = Math.max(...sorted.map(c => c.name.length));
  for (const cmd of sorted) {
    lines.push(`  ${cmd.name.padEnd(maxLen + 2)}-- ${cmd.summary}`);
  }
  return lines.join("\n");
}

function ok(stdout: string, durationMs: number = 0): CommandResult {
  return { stdout, stderr: "", exitCode: 0, durationMs };
}

function fail(stderr: string, durationMs: number = 0, exitCode: number = 1): CommandResult {
  return { stdout: "", stderr, exitCode, durationMs };
}

function parseArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuote) {
      if (ch === inQuote) { inQuote = ""; continue; }
      current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) { args.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

interface ChainSegment {
  command: string;
  operator: "pipe" | "and" | "or" | "seq" | "start";
}

export function parseChain(input: string): ChainSegment[] {
  const segments: ChainSegment[] = [];
  let current = "";
  let inQuote = "";
  let i = 0;
  let nextOp: ChainSegment["operator"] = "start";

  function pushSegment() {
    const trimmed = current.trim();
    if (trimmed) {
      segments.push({ command: trimmed, operator: nextOp });
    }
    current = "";
  }

  while (i < input.length) {
    const ch = input[i];

    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = "";
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      current += ch;
      inQuote = ch;
      i++;
      continue;
    }

    if (ch === "|" && input[i + 1] !== "|") {
      pushSegment();
      nextOp = "pipe";
      i++;
      continue;
    }

    if (ch === "&" && input[i + 1] === "&") {
      pushSegment();
      nextOp = "and";
      i += 2;
      continue;
    }

    if (ch === "|" && input[i + 1] === "|") {
      pushSegment();
      nextOp = "or";
      i += 2;
      continue;
    }

    if (ch === ";") {
      pushSegment();
      nextOp = "seq";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  pushSegment();

  return segments;
}

async function executeOneCommand(rawCommand: string, stdin: string): Promise<CommandResult> {
  const parts = rawCommand.trim().split(/\s+/);
  const cmdName = parts[0]?.toLowerCase();

  if (!cmdName) {
    return fail("[error] empty command");
  }

  const registered = commands.get(cmdName);
  if (!registered) {
    return fail(`[error] unknown command: ${cmdName}\n${getCommandList()}`);
  }

  const argStr = rawCommand.trim().slice(cmdName.length).trim();
  const args = parseArgs(argStr);

  const needsArgs = !["help", "programs", "results", "tasks", "notes", "captures",
    "search", "skills", "runtime", "profiles", "proposals", "agenda", "recipe", "config"].includes(cmdName);
  if (args.length === 0 && !stdin && needsArgs) {
    return fail(`[error] ${cmdName}: usage: ${registered.usage}`);
  }

  if (args.includes("--help") || args.includes("-h")) {
    return ok(`${cmdName} -- ${registered.summary}\n\nUsage: ${registered.usage}`);
  }

  const start = Date.now();
  try {
    const result = await registered.handler(args, stdin);
    result.durationMs = Date.now() - start;
    return result;
  } catch (err: any) {
    return fail(`[error] ${cmdName}: ${err.message}`, Date.now() - start);
  }
}

export async function executeChainRaw(input: string): Promise<CommandResult> {
  const totalStart = Date.now();
  const segments = parseChain(input);

  if (segments.length === 0) {
    return fail("[error] empty command");
  }

  let lastResult: CommandResult = { stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
  let skipping = false;

  for (const seg of segments) {
    if (seg.operator === "pipe") {
      if (skipping) continue;
      lastResult = await executeOneCommand(seg.command, lastResult.stdout);
      continue;
    }

    skipping = false;

    if (seg.operator === "and" && lastResult.exitCode !== 0) {
      skipping = true;
      continue;
    }
    if (seg.operator === "or" && lastResult.exitCode === 0) {
      skipping = true;
      continue;
    }

    lastResult = await executeOneCommand(seg.command, "");
  }

  lastResult.durationMs = Date.now() - totalStart;
  return lastResult;
}

export async function executeChain(input: string): Promise<PresentedResult> {
  const totalStart = Date.now();
  const raw = await executeChainRaw(input);
  return present(raw, totalStart);
}

function present(result: CommandResult, totalStart: number): PresentedResult {
  const totalMs = Date.now() - totalStart;
  let output = result.stdout;
  let truncated = false;
  let originalLines = output.split("\n").length;

  if (result.stderr) {
    output = output ? `${output}\n[stderr] ${result.stderr}` : `[stderr] ${result.stderr}`;
  }

  if (output.length > MAX_PRESENT_BYTES || originalLines > MAX_PRESENT_LINES) {
    const lines = output.split("\n");
    originalLines = lines.length;
    output = lines.slice(0, MAX_PRESENT_LINES).join("\n");
    output += `\n\n--- output truncated (${originalLines} lines) ---`;
    truncated = true;
  }

  output += `\n[exit:${result.exitCode} | ${totalMs}ms]`;

  return {
    output,
    exitCode: result.exitCode,
    durationMs: totalMs,
    truncated,
    originalLines,
  };
}

function registerBuiltinCommands(): void {

  registerCommand("help", "List all available commands", "help", async () => {
    return ok(getCommandList());
  });

  registerCommand("programs", "List or run programs", "programs [list|run <name>|status|info <name>]", async (args, _stdin) => {
    const sub = args[0] || "list";

    if (sub === "list") {
      const progs = await storage.getPrograms();
      if (progs.length === 0) return ok("No programs registered.");
      const lines = progs.map(p => {
        const status = p.enabled ? "ON " : "OFF";
        const sched = p.schedule || p.cronExpression || "manual";
        return `[${status}] ${p.name.padEnd(25)} ${sched.padEnd(15)} ${p.type}`;
      });
      return ok(lines.join("\n"));
    }

    if (sub === "run") {
      const name = args.slice(1).join(" ");
      if (!name) return fail("[error] programs: usage: programs run <name>");
      try {
        const state = await manualTrigger(name);
        return ok(`Triggered: ${state.name} (iteration ${state.iteration})`);
      } catch (e: any) {
        return fail(`[error] programs run: ${e.message}`);
      }
    }

    if (sub === "status") {
      const rtState = getRuntimeState();
      if (rtState.programs.length === 0) return ok("No programs in runtime. Toggle runtime on first.");
      const lines = rtState.programs.map(p => {
        const runAt = p.lastRun ? p.lastRun.toISOString().slice(0, 19) : "never";
        return `${p.name.padEnd(25)} ${p.status.padEnd(10)} last=${runAt}  iter=${p.iteration}`;
      });
      return ok(`Runtime: ${rtState.active ? "ACTIVE" : "STOPPED"}\n${lines.join("\n")}`);
    }

    if (sub === "info") {
      const name = args.slice(1).join(" ");
      if (!name) return fail("[error] programs: usage: programs info <name>");
      const prog = await storage.getProgramByName(name);
      if (!prog) return fail(`[error] program "${name}" not found. Use 'programs list' to see available.`);
      const lines = [
        `Name: ${prog.name}`,
        `Type: ${prog.type}`,
        `Enabled: ${prog.enabled}`,
        `Schedule: ${prog.schedule || prog.cronExpression || "manual"}`,
        `Cost tier: ${prog.costTier}`,
        `Tags: ${prog.tags.join(", ") || "none"}`,
        `Instructions: ${prog.instructions.slice(0, 200) || "(none)"}`,
        `Has code: ${prog.code ? "yes (" + prog.code.length + " chars)" : "no"}`,
      ];
      return ok(lines.join("\n"));
    }

    return fail(`[error] programs: unknown subcommand "${sub}"\nUsage: programs [list|run <name>|status|info <name>]`);
  });

  registerCommand("results", "View agent results", "results [<program-name>] [--limit N]", async (args, _stdin) => {
    let programName: string | undefined;
    let limit = 10;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--limit" && args[i + 1]) {
        limit = parseInt(args[i + 1], 10) || 10;
        i++;
      } else {
        programName = args[i];
      }
    }
    const results = await storage.getAgentResults(programName, limit);
    if (results.length === 0) return ok(programName ? `No results for "${programName}".` : "No results yet.");
    const lines = results.map(r => {
      const ts = r.createdAt.toISOString().slice(0, 16);
      return `[${ts}] ${r.programName.padEnd(22)} ${r.status.padEnd(5)} ${r.summary.slice(0, 80)}`;
    });
    return ok(lines.join("\n"));
  });

  registerCommand("tasks", "List tasks", "tasks [--status TODO|DONE] [--limit N]", async (args) => {
    let status: string | undefined;
    let limit = 20;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--status" && args[i + 1]) { status = args[i + 1]; i++; }
      else if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
    }
    const allTasks = await storage.getTasks(status);
    const tasks = allTasks.slice(0, limit);
    if (tasks.length === 0) return ok("No tasks found.");
    const lines = tasks.map(t => {
      const pri = t.priority ? `[${t.priority}]` : "     ";
      return `${pri} ${t.status.padEnd(5)} ${t.title}`;
    });
    return ok(lines.join("\n"));
  });

  registerCommand("notes", "List or search notes", "notes [search <query>] [--limit N]", async (args) => {
    const allNotes = await storage.getNotes();
    if (args[0] === "search" && args[1]) {
      const q = args.slice(1).join(" ").toLowerCase();
      const matched = allNotes.filter(n => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q));
      if (matched.length === 0) return ok(`No notes matching "${q}".`);
      return ok(matched.map(n => `[${n.id}] ${n.title}`).join("\n"));
    }
    if (allNotes.length === 0) return ok("No notes.");
    return ok(allNotes.map(n => `[${n.id}] ${n.title}`).join("\n"));
  });

  registerCommand("captures", "List unprocessed captures", "captures [--all]", async (args) => {
    const showAll = args.includes("--all");
    const caps = await storage.getCaptures(showAll ? undefined : false);
    if (caps.length === 0) return ok("No captures.");
    const lines = caps.map(c => {
      const ts = c.createdAt.toISOString().slice(0, 16);
      return `[${ts}] ${c.type.padEnd(6)} ${c.content.slice(0, 80)}`;
    });
    return ok(lines.join("\n"));
  });

  registerCommand("search", "Search across all data", "search <query>", async (args) => {
    const query = args.join(" ");
    if (!query) return fail("[error] search: usage: search <query>");
    const results = await storage.searchAll(query);
    if (results.length === 0) return ok(`No results for "${query}".`);
    const lines = results.map(r => `[${r.type.padEnd(12)}] ${r.title.slice(0, 60)}  -- ${r.snippet.slice(0, 60)}`);
    return ok(lines.join("\n"));
  });

  registerCommand("grep", "Filter lines matching a pattern", "grep [-i] [-v] [-c] <pattern>", async (args, stdin) => {
    if (!stdin && args.length === 0) return fail("[error] grep: requires piped input. Usage: <command> | grep <pattern>");
    let ignoreCase = false;
    let invert = false;
    let countOnly = false;
    const patterns: string[] = [];

    for (const a of args) {
      if (a === "-i") ignoreCase = true;
      else if (a === "-v") invert = true;
      else if (a === "-c") countOnly = true;
      else patterns.push(a);
    }

    const pattern = patterns.join(" ");
    if (!pattern) return fail("[error] grep: no pattern specified. Usage: grep <pattern>");

    const flags = ignoreCase ? "i" : "";
    let re: RegExp;
    try {
      re = new RegExp(pattern, flags);
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    }

    const lines = stdin.split("\n");
    const matched = lines.filter(line => {
      const m = re.test(line);
      return invert ? !m : m;
    });

    if (countOnly) return ok(String(matched.length));
    if (matched.length === 0) return ok("");
    return ok(matched.join("\n"));
  });

  registerCommand("head", "Show first N lines", "head [N]", async (args, stdin) => {
    if (!stdin) return fail("[error] head: requires piped input. Usage: <command> | head [N]");
    const n = parseInt(args[0] || "10", 10);
    const lines = stdin.split("\n").slice(0, n);
    return ok(lines.join("\n"));
  });

  registerCommand("tail", "Show last N lines", "tail [N]", async (args, stdin) => {
    if (!stdin) return fail("[error] tail: requires piped input. Usage: <command> | tail [N]");
    const n = parseInt(args[0] || "10", 10);
    const lines = stdin.split("\n");
    return ok(lines.slice(-n).join("\n"));
  });

  registerCommand("wc", "Count lines, words, or chars", "wc [-l] [-w] [-c]", async (args, stdin) => {
    if (!stdin) return fail("[error] wc: requires piped input. Usage: <command> | wc [-l]");
    const mode = args[0] || "-l";
    if (mode === "-l") return ok(String(stdin.split("\n").length));
    if (mode === "-w") return ok(String(stdin.split(/\s+/).filter(Boolean).length));
    if (mode === "-c") return ok(String(stdin.length));
    return ok(`${stdin.split("\n").length} lines, ${stdin.split(/\s+/).filter(Boolean).length} words, ${stdin.length} chars`);
  });

  registerCommand("sort", "Sort lines", "sort [-r] [-n] [-u]", async (args, stdin) => {
    if (!stdin) return fail("[error] sort: requires piped input");
    let lines = stdin.split("\n");
    const reverse = args.includes("-r");
    const numeric = args.includes("-n");
    const unique = args.includes("-u");
    if (unique) lines = [...new Set(lines)];
    lines.sort((a, b) => {
      if (numeric) return (parseFloat(a) || 0) - (parseFloat(b) || 0);
      return a.localeCompare(b);
    });
    if (reverse) lines.reverse();
    return ok(lines.join("\n"));
  });

  registerCommand("uniq", "Remove duplicate adjacent lines", "uniq [-c]", async (args, stdin) => {
    if (!stdin) return fail("[error] uniq: requires piped input");
    const count = args.includes("-c");
    const lines = stdin.split("\n");
    const result: string[] = [];
    let prev = "";
    let cnt = 0;
    for (const line of lines) {
      if (line === prev) {
        cnt++;
      } else {
        if (prev !== "" || cnt > 0) {
          result.push(count ? `${String(cnt).padStart(4)} ${prev}` : prev);
        }
        prev = line;
        cnt = 1;
      }
    }
    if (prev !== "" || cnt > 0) {
      result.push(count ? `${String(cnt).padStart(4)} ${prev}` : prev);
    }
    return ok(result.join("\n"));
  });

  registerCommand("echo", "Print text", "echo <text>", async (args) => {
    return ok(args.join(" "));
  });

  registerCommand("cat", "Read a result or stdin", "cat [result <id>] [note <id>]", async (args, stdin) => {
    if (stdin && args.length === 0) return ok(stdin);
    const sub = args[0];
    const id = parseInt(args[1], 10);

    if (sub === "result") {
      if (isNaN(id)) return fail("[error] cat: usage: cat result <id>");
      const r = await storage.getAgentResult(id);
      if (!r) return fail(`[error] result #${id} not found`);
      return ok(r.rawOutput || r.summary);
    }

    if (sub === "note") {
      if (isNaN(id)) return fail("[error] cat: usage: cat note <id>");
      const n = await storage.getNote(id);
      if (!n) return fail(`[error] note #${id} not found`);
      return ok(`# ${n.title}\n\n${n.body}`);
    }

    if (sub === "task") {
      if (isNaN(id)) return fail("[error] cat: usage: cat task <id>");
      const t = await storage.getTask(id);
      if (!t) return fail(`[error] task #${id} not found`);
      return ok(`[${t.status}] ${t.title}\n${t.body}`);
    }

    return fail(`[error] cat: unknown target "${sub}". Use: cat result <id>, cat note <id>, cat task <id>`);
  });

  registerCommand("recipe", "Manage saved command recipes", "recipe [list|save|run|info|delete] ...", async (args) => {
    const sub = args[0] || "list";

    if (sub === "list") {
      const all = await storage.getRecipes();
      if (all.length === 0) return ok("No saved recipes. Use: recipe save <name> <command>");
      const lines = all.map(r => {
        const status = r.enabled ? "ON " : "OFF";
        const sched = r.schedule || r.cronExpression || "manual";
        const runs = `runs=${r.runCount}`;
        return `[${status}] ${r.name.padEnd(25)} ${sched.padEnd(15)} ${runs}  ${r.description || r.command.slice(0, 40)}`;
      });
      return ok(lines.join("\n"));
    }

    if (sub === "save") {
      const name = args[1];
      if (!name) return fail('[error] recipe save: usage: recipe save <name> "<command>" [--schedule <schedule>] [--desc <description>]');
      let command = "";
      let schedule: string | undefined;
      let description = "";
      let i = 2;
      while (i < args.length) {
        if (args[i] === "--schedule" && args[i + 1]) { schedule = args[i + 1]; i += 2; }
        else if (args[i] === "--desc" && args[i + 1]) { description = args.slice(i + 1).join(" "); break; }
        else { command += (command ? " " : "") + args[i]; i++; }
      }
      if (!command) return fail("[error] recipe save: command is required");

      const existing = await storage.getRecipeByName(name);
      if (existing) {
        await storage.updateRecipe(existing.id, { command, schedule, description: description || existing.description });
        return ok(`Updated recipe "${name}": ${command}`);
      }

      await storage.createRecipe({ name, command, schedule, description });
      return ok(`Saved recipe "${name}": ${command}${schedule ? ` (schedule: ${schedule})` : ""}`);
    }

    if (sub === "run") {
      const name = args.slice(1).join(" ");
      if (!name) return fail("[error] recipe run: usage: recipe run <name>");
      const r = await storage.getRecipeByName(name);
      if (!r) return fail(`[error] recipe "${name}" not found. Use 'recipe list' to see available.`);
      const raw = await executeChainRaw(r.command);
      const now = new Date();
      await storage.updateRecipeLastRun(r.id, now, null, raw.stdout.slice(0, 10000));
      return raw;
    }

    if (sub === "info") {
      const name = args.slice(1).join(" ");
      if (!name) return fail("[error] recipe info: usage: recipe info <name>");
      const r = await storage.getRecipeByName(name);
      if (!r) return fail(`[error] recipe "${name}" not found`);
      const lines = [
        `Name: ${r.name}`,
        `Description: ${r.description || "(none)"}`,
        `Command: ${r.command}`,
        `Schedule: ${r.schedule || r.cronExpression || "manual"}`,
        `Enabled: ${r.enabled}`,
        `Run count: ${r.runCount}`,
        `Last run: ${r.lastRun?.toISOString() || "never"}`,
        `Last output: ${r.lastOutput?.slice(0, 200) || "(none)"}`,
      ];
      return ok(lines.join("\n"));
    }

    if (sub === "delete") {
      const name = args.slice(1).join(" ");
      if (!name) return fail("[error] recipe delete: usage: recipe delete <name>");
      const r = await storage.getRecipeByName(name);
      if (!r) return fail(`[error] recipe "${name}" not found`);
      await storage.deleteRecipe(r.id);
      return ok(`Deleted recipe "${name}".`);
    }

    if (sub === "enable" || sub === "disable") {
      const name = args.slice(1).join(" ");
      if (!name) return fail(`[error] recipe ${sub}: usage: recipe ${sub} <name>`);
      const r = await storage.getRecipeByName(name);
      if (!r) return fail(`[error] recipe "${name}" not found`);
      await storage.updateRecipe(r.id, { enabled: sub === "enable" });
      return ok(`Recipe "${name}" ${sub}d.`);
    }

    return fail(`[error] recipe: unknown subcommand "${sub}"\nUsage: recipe [list|save|run|info|delete|enable|disable]`);
  });

  registerCommand("config", "View or set agent config", "config [list|get <key>|set <key> <value>]", async (args) => {
    const sub = args[0] || "list";

    if (sub === "list") {
      const configs = await storage.getAgentConfigs();
      if (configs.length === 0) return ok("No config entries.");
      return ok(configs.map(c => `${c.key.padEnd(25)} = ${c.value.slice(0, 60)} [${c.category}]`).join("\n"));
    }

    if (sub === "get") {
      const key = args[1];
      if (!key) return fail("[error] config get: usage: config get <key>");
      const c = await storage.getAgentConfig(key);
      if (!c) return fail(`[error] config key "${key}" not found`);
      return ok(c.value);
    }

    if (sub === "set") {
      const key = args[1];
      const value = args.slice(2).join(" ");
      if (!key || !value) return fail("[error] config set: usage: config set <key> <value>");
      await storage.setAgentConfig(key, value);
      return ok(`Set ${key} = ${value}`);
    }

    return fail(`[error] config: unknown subcommand "${sub}"\nUsage: config [list|get <key>|set <key> <value>]`);
  });

  registerCommand("skills", "List available skills", "skills [list|info <name>]", async (args) => {
    const sub = args[0] || "list";
    if (sub === "list") {
      const allSkills = await storage.getSkills();
      if (allSkills.length === 0) return ok("No skills registered.");
      return ok(allSkills.map(s => `${s.name.padEnd(25)} ${s.description.slice(0, 60)}`).join("\n"));
    }
    if (sub === "info") {
      const name = args.slice(1).join(" ");
      if (!name) return fail("[error] skills info: usage: skills info <name>");
      const allSkills = await storage.getSkills();
      const skill = allSkills.find(s => s.name.toLowerCase() === name.toLowerCase());
      if (!skill) return fail(`[error] skill "${name}" not found`);
      return ok(`Name: ${skill.name}\nType: ${skill.type}\nPath: ${skill.scriptPath || "(inline)"}\n\n${skill.description}\n\n${skill.content.slice(0, 500)}`);
    }
    return fail(`[error] skills: unknown subcommand "${sub}"\nUsage: skills [list|info <name>]`);
  });

  registerCommand("runtime", "Control the agent runtime", "runtime [status|start|stop]", async (args) => {
    const sub = args[0] || "status";
    if (sub === "status") {
      const state = getRuntimeState();
      const lines = [`Runtime: ${state.active ? "ACTIVE" : "STOPPED"}`, `Last tick: ${state.lastTick?.toISOString() || "never"}`];
      if (state.programs.length > 0) {
        lines.push(`Programs: ${state.programs.length}`);
        for (const p of state.programs) {
          lines.push(`  ${p.name.padEnd(25)} ${p.status.padEnd(10)} iter=${p.iteration}`);
        }
      }
      return ok(lines.join("\n"));
    }
    return fail(`[error] runtime: unknown subcommand "${sub}"\nUsage: runtime [status|start|stop]`);
  });

  registerCommand("profiles", "List site profiles", "profiles [list|info <name>]", async (args) => {
    const sub = args[0] || "list";
    if (sub === "list") {
      const all = await storage.getSiteProfiles();
      if (all.length === 0) return ok("No site profiles.");
      return ok(all.map(p => `[${p.enabled ? "ON " : "OFF"}] ${p.name.padEnd(20)} ${p.baseUrl}`).join("\n"));
    }
    if (sub === "info") {
      const name = args.slice(1).join(" ");
      if (!name) return fail("[error] profiles info: usage: profiles info <name>");
      const p = await storage.getSiteProfileByName(name);
      if (!p) return fail(`[error] profile "${name}" not found`);
      return ok(`Name: ${p.name}\nURL: ${p.baseUrl}\nPatterns: ${p.urlPatterns.join(", ")}\nDescription: ${p.description}`);
    }
    return fail(`[error] profiles: unknown subcommand "${sub}"\nUsage: profiles [list|info <name>]`);
  });

  registerCommand("proposals", "List proposals", "proposals [--status pending|accepted|rejected]", async (args) => {
    let status: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--status" && args[i + 1]) { status = args[i + 1]; i++; }
    }
    const all = await storage.getProposals(status);
    if (all.length === 0) return ok("No proposals.");
    const lines = all.map(p => {
      const ts = p.createdAt.toISOString().slice(0, 16);
      return `[${ts}] ${p.status.padEnd(10)} ${p.section.padEnd(12)} ${p.reason.slice(0, 60)}`;
    });
    return ok(lines.join("\n"));
  });

  registerCommand("agenda", "Show today's agenda", "agenda", async () => {
    const today = new Date().toISOString().split("T")[0];
    const [overdue, todayTasks, upcoming, briefings] = await Promise.all([
      storage.getOverdueTasks(today),
      storage.getTasksByDate(today),
      storage.getUpcomingTasks(today),
      storage.getLatestResults(5),
    ]);
    const lines: string[] = [];
    if (overdue.length > 0) {
      lines.push("=== OVERDUE ===");
      for (const t of overdue) lines.push(`  [!] ${t.title}`);
    }
    if (todayTasks.length > 0) {
      lines.push("=== TODAY ===");
      for (const t of todayTasks) lines.push(`  [ ] ${t.title}`);
    }
    if (upcoming.length > 0) {
      lines.push("=== UPCOMING ===");
      for (const t of upcoming) lines.push(`  ${t.scheduledDate || ""} ${t.title}`);
    }
    if (briefings.length > 0) {
      lines.push("=== LATEST BRIEFINGS ===");
      for (const r of briefings) lines.push(`  [${r.programName}] ${r.summary.slice(0, 70)}`);
    }
    return ok(lines.length > 0 ? lines.join("\n") : "Nothing on the agenda today.");
  });
}

registerBuiltinCommands();

export function getRegisteredCommands(): string[] {
  return Array.from(commands.keys());
}

export function getCommandHelp(): string {
  return getCommandList();
}
