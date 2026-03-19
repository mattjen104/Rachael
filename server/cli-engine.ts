import { storage } from "./storage";
import { manualTrigger, getRuntimeState } from "./agent-runtime";
import { emitEvent } from "./event-bus";
import { bestEffortExtract, executeNavigationPath, matchProfileToUrl } from "./universal-scraper";
import { executeLLM, type LLMConfig, type LLMMessage, type LLMResponse } from "./llm-client";
import { synthesizeBriefing, htmlToSpokenScript } from "./voice-synth";

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
    "search", "skills", "runtime", "profiles", "proposals", "agenda", "recipe", "config",
    "standup", "memory", "bridge", "bridge-status", "bridge-token", "cwp", "outlook", "teams", "citrix", "snow", "epic", "pulse"].includes(cmdName);
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

interface CachedEmail {
  from: string;
  subject: string;
  date: string;
  preview: string;
  unread: boolean;
  fullBody?: string;
}

interface CachedCalEvent {
  title: string;
  date: string;
  time: string;
  location: string;
}

interface CachedChat {
  name: string;
  lastMessage: string;
  time: string;
  unread: boolean;
}

interface CachedChannel {
  name: string;
  team: string;
}

interface CachedSnowRecord {
  number: string;
  shortDescription: string;
  state: string;
  priority: string;
  assignedTo: string;
  assignmentGroup: string;
  updatedOn: string;
  type: "incident" | "change" | "request";
  source: "personal" | "team";
  slaBreached: boolean;
  url?: string;
}

let mailCache: { emails: CachedEmail[]; fetchedAt: number } | null = null;
let calendarCache: { events: CachedCalEvent[]; fetchedAt: number } | null = null;
let teamsCache: { chats: CachedChat[]; fetchedAt: number } | null = null;
let snowCache: { records: CachedSnowRecord[]; fetchedAt: number } | null = null;

export function getMailCache() { return mailCache; }
export function setMailCache(c: typeof mailCache) { mailCache = c; }
export function getCalendarCache() { return calendarCache; }
export function setCalendarCache(c: typeof calendarCache) { calendarCache = c; }
export function getTeamsCache() { return teamsCache; }
export function setTeamsCache(c: typeof teamsCache) { teamsCache = c; }
export function getSnowCache() { return snowCache; }
export function setSnowCache(c: typeof snowCache) { snowCache = c; }

function parseSnowListFromText(text: string, recordType: "incident" | "change" | "request", baseUrl: string, source: "personal" | "team" = "personal"): CachedSnowRecord[] {
  const records: CachedSnowRecord[] = [];
  const lines = text.split(/[\n\r]+/).map(l => l.trim()).filter(l => l.length > 0);
  const numberPattern = recordType === "incident" ? /\b(INC\d{7,})\b/gi
    : recordType === "change" ? /\b(CHG\d{7,})\b/gi
    : /\b(REQ|RITM)\d{7,}\b/gi;

  const fullPattern = recordType === "request" ? /\b((REQ|RITM)\d{7,})\b/gi : numberPattern;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matches = line.match(fullPattern);
    if (!matches) continue;
    for (const match of matches) {
      const num = match.toUpperCase();
      if (records.some(r => r.number === num)) continue;
      const contextLines = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 4)).join(" ");
      const stateMatch = contextLines.match(/\b(New|In Progress|On Hold|Resolved|Closed|Pending|Active|Implement|Review|Scheduled|Canceled|Open|Awaiting|Assess|Authorize|Work in Progress)\b/i);
      const priorityMatch = contextLines.match(/\b([1-5]\s*-\s*(Critical|High|Moderate|Low|Planning))\b/i) || contextLines.match(/\bP([1-5])\b/);
      const assignedToMatch = contextLines.match(/(?:assigned\s*to|assignee)[:\s]+([A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/i)
        || contextLines.match(/([A-Z][a-z]+ [A-Z][a-z]+)\s+(?:INC|CHG|REQ|RITM)/i);
      const groupMatch = contextLines.match(/(?:assignment\s*group|group)[:\s]+([^,\n|]+?)(?:\s+(?:INC|CHG|REQ|RITM|\d{4}-\d{2}|$))/i)
        || contextLines.match(/(?:Service Desk|IT Support|Network|Infrastructure|Application|Desktop|Help Desk|Operations|Security|Development)[A-Za-z\s]*/i);
      const dateMatch = contextLines.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
      const tableName = recordType === "incident" ? "incident" : recordType === "change" ? "change_request" : "sc_req_item";
      records.push({
        number: num,
        shortDescription: extractSnowDescription(contextLines, num),
        state: stateMatch ? stateMatch[0] : "Unknown",
        priority: priorityMatch ? priorityMatch[0] : "",
        assignedTo: assignedToMatch ? assignedToMatch[1].trim() : "",
        assignmentGroup: groupMatch ? groupMatch[0].trim() : "",
        updatedOn: dateMatch ? dateMatch[1] : "",
        type: recordType,
        source,
        slaBreached: /breach|overdue|exceeded|sla/i.test(contextLines),
        url: `${baseUrl}/nav_to.do?uri=${tableName}.do?sysparm_query=number=${num}`,
      });
    }
  }
  return records;
}

function extractSnowDescription(context: string, recordNumber: string): string {
  let desc = context.replace(new RegExp(recordNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), "gi"), "").trim();
  desc = desc.replace(/\b(New|In Progress|On Hold|Resolved|Closed|Pending|Active|Implement|Review|Scheduled|Canceled|Open|Awaiting|Assess|Authorize|Work in Progress)\b/gi, "").trim();
  desc = desc.replace(/\b[1-5]\s*-\s*(Critical|High|Moderate|Low|Planning)\b/gi, "").trim();
  desc = desc.replace(/^\s*[-|]\s*/, "").trim();
  return desc.slice(0, 120) || "(no description)";
}

function formatSnowList(title: string, records: CachedSnowRecord[], cacheAge?: number): string {
  const nl = String.fromCharCode(10);
  const header = cacheAge !== undefined
    ? `=== SNOW ${title} === (cached ${cacheAge}s ago, ${records.length} items)`
    : `=== SNOW ${title} === (${records.length} items)`;
  const lines = [header, ""];
  for (const r of records) {
    const sla = r.slaBreached ? " ⚠SLA" : "";
    const priority = r.priority ? ` [${r.priority}]` : "";
    lines.push(`  ${r.number.padEnd(15)} ${r.state.padEnd(12)} ${r.shortDescription.slice(0, 50)}${priority}${sla}`);
  }
  lines.push("", `Use: snow detail <number> | snow refresh`);
  return lines.join(nl);
}

function mergeSnowCache(records: CachedSnowRecord[], recordType: "incident" | "change" | "request", source: "personal" | "team" = "personal"): void {
  if (!snowCache) {
    snowCache = { records, fetchedAt: Date.now() };
  } else {
    const existing = snowCache.records.filter(r => !(r.type === recordType && r.source === source));
    const deduped = records.filter(nr => !existing.some(er => er.number === nr.number));
    snowCache = { records: [...existing, ...deduped], fetchedAt: Date.now() };
  }
}

function cleanUnicode(s: string): string {
  return s
    .replace(/[\u{FE00}-\u{FE0F}]/gu, "")
    .replace(/[\u{200B}-\u{200F}\u{FEFF}\u{00AD}\u{2028}\u{2029}]/gu, "")
    .replace(/[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}]/gu, "")
    .replace(/[\u{D800}-\u{DFFF}]/gu, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

const OUTLOOK_NAV_NOISE = new Set([
  "inbox", "sent items", "drafts", "deleted items", "junk email", "archive",
  "conversation history", "conversation histo", "notes", "outbox", "rss feeds",
  "clutter", "focused", "other", "all", "unread", "to me", "flagged",
  "mentions", "attachments", "groups", "favorites", "folders",
  "new mail", "new message", "search", "filter", "calendar", "people",
  "to-do", "settings", "help", "feedback", "sign out", "my account",
  "microsoft 365", "office 365", "outlook", "mail", "selected",
]);

function isNavNoise(s: string): boolean {
  const lower = s.toLowerCase().trim();
  if (OUTLOOK_NAV_NOISE.has(lower)) return true;
  if (lower.length < 3) return true;
  if (/^(new|reply|forward|delete|move|archive|flag|pin|snooze|categorize|mark as|undo|more)$/i.test(lower)) return true;
  if (/^(home|view|message|insert|format|help|file|edit|tools|actions)$/i.test(lower)) return true;
  return false;
}

function stripOutlookPageChrome(rawText: string, emailSubject?: string): string {
  const lines = rawText.split(/\n/);
  const filtered: string[] = [];
  let inNavSection = true;
  let foundContent = false;

  const navPatterns = [
    /^Outlook$/i,
    /^File$/i,
    /^Navigation pane$/i,
    /^Favorites$/i,
    /^Focused$/i,
    /^Other$/i,
    /^Pinned$/i,
    /^Today$/i,
    /^Yesterday$/i,
    /^Last week$/i,
    /^Last month$/i,
    /^Older$/i,
    /^\s*Inbox\s*$/i,
    /^\s*Drafts\s*$/i,
    /^\s*Sent Items?\s*$/i,
    /^\s*Deleted Items?\s*$/i,
    /^\s*Archive\s*$/i,
    /^\s*Junk Email\s*$/i,
    /^\s*Notes\s*$/i,
    /^\s*RSS Feeds?\s*$/i,
    /^\s*Conversation History\s*$/i,
    /^\s*selected\s*$/i,
    /^\d+\s*(unread|items?)\s*$/i,
    /^[a-zA-Z.]+@[a-zA-Z.]+\.(edu|com|org)\s*$/,
    /^Select an item to read$/i,
    /^Nothing is selected$/i,
    /^\s*(IT|HR|Admin)\s*$/i,
  ];

  const inboxItemPattern = /^[A-Z][a-z]+,\s+[A-Z][a-z]+/;
  const timePattern = /^\d{1,2}:\d{2}\s*(AM|PM)\s*$/i;
  const dateOnlyPattern = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}:\d{2}\s*(AM|PM)\s*$/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (navPatterns.some(p => p.test(line))) continue;
    if (timePattern.test(line)) continue;
    if (dateOnlyPattern.test(line)) continue;

    if (inNavSection) {
      if (emailSubject && line.includes(emailSubject.split(";")[0]?.trim() || "___NOMATCH___")) {
        inNavSection = false;
        foundContent = true;
      }
      if (/^(From|To|Cc|Sent|Date|Subject):/i.test(line)) {
        inNavSection = false;
        foundContent = true;
      }
      if (!foundContent) {
        const isInboxPreview = (
          line.length > 80 &&
          !line.startsWith("From:") &&
          !line.startsWith("To:") &&
          i + 1 < lines.length
        );
        const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : "";
        if (isInboxPreview && (timePattern.test(nextLine) || dateOnlyPattern.test(nextLine))) {
          continue;
        }
        if (inboxItemPattern.test(line) && line.length < 80) continue;
      }
    }

    if (foundContent || !inNavSection) {
      filtered.push(lines[i]);
    }
  }

  if (filtered.length < 3) {
    const simple: string[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (navPatterns.some(p => p.test(t))) continue;
      if (timePattern.test(t)) continue;
      if (/^\d+\s*(unread|items?)$/i.test(t)) continue;
      simple.push(line);
    }
    return simple.join(String.fromCharCode(10)).trim();
  }

  return filtered.join(String.fromCharCode(10)).trim();
}

export function parseOutlookInbox(html: string, text: string, extracted?: Record<string, Array<{ text: string; href?: string; ariaLabel?: string }>>): CachedEmail[] {
  const emails: CachedEmail[] = [];

  if (extracted?.rows && extracted.rows.length > 0) {
    for (const row of extracted.rows) {
      const label = (row.ariaLabel || "").trim();
      const t = (label || row.text || "").trim();
      if (!t || t.length < 10 || t.length > 800) continue;
      if (isNavNoise(t)) continue;

      const fromMatch = t.match(/(?:From|from|Sender|sender)\s*[:.]?\s*([^,\n]{2,50})/);
      const subjectMatch = t.match(/(?:Subject|subject)\s*[:.]?\s*([^,\n]{2,100})/);
      const unread = /\bunread\b/i.test(t);
      const dateMatch = t.match(/(?:Received|received|Date|date|Sent|sent)\s*[:.]?\s*([^,\n]{4,30})/) ||
                        t.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/) ||
                        t.match(/((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*[\s,]+\w+\s+\d{1,2})/i) ||
                        t.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);

      if (fromMatch || subjectMatch) {
        const from = cleanUnicode(fromMatch?.[1] || "Unknown");
        const subject = cleanUnicode(subjectMatch?.[1] || "");
        if (isNavNoise(from) || isNavNoise(subject)) continue;
        emails.push({
          from: from.slice(0, 40),
          subject: (subject || cleanUnicode(t).slice(0, 60)).trim(),
          date: cleanUnicode(dateMatch?.[1] || "").slice(0, 20),
          preview: cleanUnicode(t).slice(0, 200),
          unread,
        });
      } else {
        const parts = t.split(/[,\n]/).map(p => cleanUnicode(p)).filter(p => p.length > 2 && !isNavNoise(p));
        if (parts.length >= 2) {
          emails.push({
            from: parts[0].slice(0, 40),
            subject: parts[1].slice(0, 80),
            date: parts.length > 2 && /\d/.test(parts[parts.length - 1]) ? parts[parts.length - 1].slice(0, 20) : "",
            preview: parts.slice(2).join(" ").slice(0, 200),
            unread,
          });
        }
      }
    }
    if (emails.length > 0) {
      const seen = new Set<string>();
      return emails.filter(e => {
        const key = `${e.from}|${e.subject}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }

  const ariaRe = /aria-label="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = ariaRe.exec(html)) !== null) {
    const label = m[1];
    if (label.length < 20 || label.length > 800) continue;

    const hasEmailKeyword = /\b(from|sender|subject|received|unread|read|message|has attachment)/i.test(label);
    const hasCommaSections = (label.match(/,/g) || []).length >= 2;

    if (!hasEmailKeyword && !hasCommaSections) continue;
    if (isNavNoise(label)) continue;

    const fromMatch = label.match(/(?:From|from|Sender|sender)\s*[:.]?\s*([^,\n]{2,50})/);
    const subjectMatch = label.match(/(?:Subject|subject)\s*[:.]?\s*([^,\n]{2,100})/);
    const dateMatch = label.match(/(?:Received|received|Date|date|Sent|sent)\s*[:.]?\s*([^,\n]{4,30})/) ||
                      label.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/) ||
                      label.match(/((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*[\s,]+\w+\s+\d{1,2})/i) ||
                      label.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
    const unread = /\bunread\b/i.test(label);
    const hasAttach = /\b(?:has attachment|attachment)/i.test(label);

    if (fromMatch || subjectMatch) {
      const from = cleanUnicode(fromMatch?.[1] || "Unknown");
      const subject = cleanUnicode(subjectMatch?.[1] || "");
      if (isNavNoise(from) || isNavNoise(subject)) continue;
      emails.push({
        from: from.slice(0, 40),
        subject: (subject || cleanUnicode(label).slice(0, 60)).trim(),
        date: cleanUnicode(dateMatch?.[1] || "").slice(0, 20),
        preview: cleanUnicode(label).slice(0, 200),
        unread,
      });
    }
  }

  if (emails.length === 0) {
    const lines = text.split(/[\n\r]+/).map(l => cleanUnicode(l)).filter(l => l.length > 3);

    const senderRe = /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+|[^\s@]+@[^\s@]+\.[^\s@]+)$/;
    const timeRe = /^\d{1,2}:\d{2}\s*(?:AM|PM)?$|^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$|^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i;
    const filteredLines = lines.filter(l => !isNavNoise(l));

    for (let i = 0; i < filteredLines.length - 1; i++) {
      const line = filteredLines[i];
      const nextLine = filteredLines[i + 1];

      if (senderRe.test(line) && !isNavNoise(line) && nextLine.length > 5 && !isNavNoise(nextLine)) {
        let date = "";
        if (i + 2 < filteredLines.length && timeRe.test(filteredLines[i + 2])) {
          date = filteredLines[i + 2].slice(0, 20);
        }
        const previewLine = date ? (filteredLines[i + 3] || "") : (filteredLines[i + 2] || "");
        emails.push({
          from: line.slice(0, 40),
          subject: nextLine.slice(0, 80),
          date,
          preview: previewLine.slice(0, 200),
          unread: false,
        });
        i += (date ? 2 : 1);
      }
    }
  }

  const seen = new Set<string>();
  return emails.filter(e => {
    const key = `${e.from}|${e.subject}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseOutlookCalendar(html: string, text: string): CachedCalEvent[] {
  const events: CachedCalEvent[] = [];

  const ariaRe = /aria-label="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = ariaRe.exec(html)) !== null) {
    const label = m[1];
    if (label.length < 10 || label.length > 500) continue;

    const timeMatch = label.match(/(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)\s*(?:to|-|–)\s*(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)/);
    const dateMatch = label.match(/((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^,]*,?\s*(?:\w+\s+\d{1,2}|\d{1,2}[\/\-]\d{1,2}))/i);
    const locationMatch = label.match(/(?:Location|location)\s*[:.]?\s*([^,]+)/);

    if (timeMatch || dateMatch) {
      const titleCandidates = label.split(/[,.]/).filter(p => p.trim().length > 3 && !timeMatch?.[0]?.includes(p.trim()));
      events.push({
        title: (titleCandidates[0] || label.slice(0, 50)).trim(),
        date: (dateMatch?.[1] || "").trim(),
        time: timeMatch ? `${timeMatch[1]} - ${timeMatch[2]}` : "",
        location: (locationMatch?.[1] || "").trim(),
      });
    }
  }

  if (events.length === 0) {
    const lines = text.split(/[\n\r]+/).map(l => l.trim()).filter(l => l.length > 3);
    const timeRe = /(\d{1,2}:\d{2})\s*(?:AM|PM|am|pm)?/;
    for (let i = 0; i < lines.length; i++) {
      if (timeRe.test(lines[i]) && lines[i + 1]) {
        events.push({
          title: lines[i + 1].slice(0, 60),
          date: "",
          time: lines[i].slice(0, 20),
          location: "",
        });
        i++;
      }
    }
  }

  return events;
}

function parseTeamsChats(html: string, text: string): CachedChat[] {
  const chats: CachedChat[] = [];

  const ariaRe = /aria-label="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = ariaRe.exec(html)) !== null) {
    const label = m[1];
    if (label.length < 10 || label.length > 500) continue;
    if (!label.includes("chat") && !label.includes("Chat") &&
        !label.includes("conversation") && !label.includes("message") &&
        !label.includes("Message")) continue;

    const nameMatch = label.match(/(?:Chat with|chat with|Conversation with)\s+([^,.]+)/i);
    const unread = /unread/i.test(label) || /new message/i.test(label);

    if (nameMatch) {
      const msgParts = label.split(",").filter(p => !p.includes(nameMatch[1]) && p.trim().length > 3);
      chats.push({
        name: nameMatch[1].trim().slice(0, 40),
        lastMessage: (msgParts[0] || "").trim().slice(0, 80),
        time: "",
        unread,
      });
    }
  }

  if (chats.length === 0) {
    const lines = text.split(/[\n\r]+/).map(l => l.trim()).filter(l => l.length > 3 && l.length < 100);
    const nameRe = /^[A-Z][a-z]+ [A-Z][a-z]+$/;
    for (let i = 0; i < lines.length - 1; i++) {
      if (nameRe.test(lines[i])) {
        chats.push({
          name: lines[i].slice(0, 40),
          lastMessage: lines[i + 1].slice(0, 80),
          time: "",
          unread: false,
        });
        i++;
      }
    }
  }

  const seen = new Set<string>();
  return chats.filter(c => {
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });
}

function parseTeamsChannels(html: string, text: string): CachedChannel[] {
  const channels: CachedChannel[] = [];

  const ariaRe = /aria-label="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = ariaRe.exec(html)) !== null) {
    const label = m[1];
    if (label.includes("channel") || label.includes("Channel") || label.includes("Team")) {
      const teamMatch = label.match(/(?:Team|team)\s*[:.]?\s*([^,]+)/);
      const channelMatch = label.match(/(?:Channel|channel)\s*[:.]?\s*([^,]+)/);
      if (channelMatch || label.length < 60) {
        channels.push({
          name: (channelMatch?.[1] || label).trim().slice(0, 40),
          team: (teamMatch?.[1] || "").trim().slice(0, 30),
        });
      }
    }
  }

  return channels;
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

  registerCommand("capture", "Capture data to knowledge base as markdown note", "capture mail <n|n,n|all> [--tag TAG] | capture calendar [--tag TAG] | capture text <content>", async (args) => {
    const sub = args[0];
    if (!sub) return fail("[capture] usage: capture mail <n|all> | capture calendar | capture text <content>");

    const tagIdx = args.indexOf("--tag");
    const tags: string[] = tagIdx >= 0 && args[tagIdx + 1] ? [args[tagIdx + 1]] : [];
    const cleanArgs = args.filter((_, i) => i !== tagIdx && (tagIdx < 0 || i !== tagIdx + 1));

    if (sub === "mail") {
      const cached = getMailCache();
      if (!cached || cached.emails.length === 0) return fail("[capture] No cached emails. Run: outlook first");

      const target = cleanArgs[1];
      if (!target) return fail("[capture] usage: capture mail <n|all> [--tag TAG]");

      let toCapture: { email: CachedEmail; idx: number }[] = [];
      if (target === "all") {
        toCapture = cached.emails.map((e, i) => ({ email: e, idx: i }));
      } else {
        const nums = target.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        for (const n of nums) {
          if (n >= 1 && n <= cached.emails.length) {
            toCapture.push({ email: cached.emails[n - 1], idx: n - 1 });
          }
        }
      }

      if (toCapture.length === 0) return fail(`[capture] No valid emails to capture. Specify 1-${cached.emails.length} or "all"`);

      const results: string[] = [];
      const baseTags = ["email", "outlook", ...tags];
      for (const { email, idx } of toCapture) {
        const contentSection = email.fullBody
          ? ["## Body", "", email.fullBody]
          : ["## Preview", "", email.preview || "(no preview)"];
        const body = [
          `# ${email.subject || "(no subject)"}`,
          "",
          `- **From:** ${email.from}`,
          `- **Date:** ${email.date || "unknown"}`,
          `- **Status:** ${email.unread ? "unread" : "read"}`,
          "",
          ...contentSection,
        ].join(String.fromCharCode(10));

        await storage.createNote({
          title: `[Email] ${email.subject || "(no subject)"} - ${email.from}`,
          body,
          tags: baseTags,
        });
        results.push(`  #${idx + 1} ${email.from}: ${email.subject?.slice(0, 50)}`);
      }
      return ok(`Captured ${results.length} email(s) to knowledge base:${String.fromCharCode(10)}${results.join(String.fromCharCode(10))}`);
    }

    if (sub === "text") {
      const content = cleanArgs.slice(1).join(" ");
      if (!content) return fail("[capture] usage: capture text <content>");
      await storage.createNote({
        title: content.slice(0, 80),
        body: content,
        tags: ["capture", ...tags],
      });
      return ok(`Captured to knowledge base: "${content.slice(0, 60)}"`);
    }

    if (sub === "calendar") {
      const calCache = getCalendarCache();
      if (!calCache || calCache.events.length === 0) return fail("[capture] No cached calendar. Run: outlook calendar first");
      const body = [
        "# Calendar Events",
        "",
        `Captured: ${new Date().toISOString().slice(0, 16)}`,
        "",
        ...calCache.events.map(ev => `- **${ev.date} ${ev.time}** ${ev.title}${ev.location ? ` @ ${ev.location}` : ""}`),
      ].join(String.fromCharCode(10));
      await storage.createNote({
        title: `[Calendar] ${new Date().toISOString().slice(0, 10)} - ${calCache.events.length} events`,
        body,
        tags: ["calendar", "outlook", ...tags],
      });
      return ok(`Captured ${calCache.events.length} calendar events to knowledge base.`);
    }

    return fail(`[capture] unknown source "${sub}". Use: mail, text, or calendar`);
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
        emitEvent("cli", `Recipe updated: ${name} = "${command}"`, "info", { metadata: { command: "recipe save", recipe: name } });
        return ok(`Updated recipe "${name}": ${command}`);
      }

      await storage.createRecipe({ name, command, schedule, description });
      emitEvent("cli", `Recipe saved: ${name} = "${command}"${schedule ? ` (schedule: ${schedule})` : ""}`, "action", { metadata: { command: "recipe save", recipe: name } });
      return ok(`Saved recipe "${name}": ${command}${schedule ? ` (schedule: ${schedule})` : ""}`);
    }

    if (sub === "run") {
      const name = args.slice(1).join(" ");
      if (!name) return fail("[error] recipe run: usage: recipe run <name>");
      const r = await storage.getRecipeByName(name);
      if (!r) return fail(`[error] recipe "${name}" not found. Use 'recipe list' to see available.`);
      emitEvent("cli", `Recipe executing: ${name}`, "action", { metadata: { command: "recipe run", recipe: name } });
      const raw = await executeChainRaw(r.command);
      const now = new Date();
      await storage.updateRecipeLastRun(r.id, now, null, raw.stdout.slice(0, 10000));
      emitEvent("cli", `Recipe complete: ${name} (exit:${raw.exitCode}, ${raw.durationMs}ms)`, raw.exitCode === 0 ? "info" : "error", { metadata: { command: "recipe run", recipe: name, exitCode: raw.exitCode } });
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

  registerCommand("proposals", "List or manage proposals", "proposals [list|approve <id>|reject <id>] [--status pending|accepted|rejected]", async (args) => {
    const sub = args[0] || "list";

    if (sub === "approve" || sub === "reject") {
      const id = parseInt(args[1], 10);
      if (isNaN(id)) return fail(`[error] proposals ${sub}: usage: proposals ${sub} <id>`);
      const proposal = (await storage.getProposals()).find(p => p.id === id);
      if (!proposal) return fail(`[error] proposal #${id} not found`);
      if (proposal.status !== "pending") return fail(`[error] proposal #${id} is already ${proposal.status}`);

      if (sub === "approve") {
        await storage.updateProposalStatus(id, "accepted", new Date());

        if (proposal.section === "RECIPES" && proposal.proposedContent) {
          try {
            const data = JSON.parse(proposal.proposedContent);
            const existing = await storage.getRecipeByName(data.name);
            if (!existing) {
              await storage.createRecipe({
                name: data.name,
                command: data.command,
                schedule: data.schedule || undefined,
                description: data.description || "",
              });
              emitEvent("cli", `Recipe approved and created: ${data.name}`, "action", { metadata: { command: "proposals approve", recipe: data.name } });
              return ok(`Approved proposal #${id} and created recipe "${data.name}": ${data.command}`);
            }
          } catch {}
        }
        emitEvent("cli", `Proposal #${id} approved`, "action", { metadata: { command: "proposals approve" } });
        return ok(`Approved proposal #${id}`);
      }

      await storage.updateProposalStatus(id, "rejected", new Date());
      emitEvent("cli", `Proposal #${id} rejected`, "info", { metadata: { command: "proposals reject" } });
      return ok(`Rejected proposal #${id}`);
    }

    let status: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--status" && args[i + 1]) { status = args[i + 1]; i++; }
    }
    if (sub === "list") { /* use status filter from flags */ }
    else { status = undefined; }
    const all = await storage.getProposals(status);
    if (all.length === 0) return ok("No proposals.");
    const lines = all.map(p => {
      const ts = p.createdAt.toISOString().slice(0, 16);
      return `#${String(p.id).padEnd(4)} [${ts}] ${p.status.padEnd(10)} ${p.section.padEnd(12)} ${p.reason.split("\n")[0].slice(0, 60)}`;
    });
    return ok(lines.join("\n"));
  });

  registerCommand("memory", "Search, store, or recall agent memory", "memory [search <query>|store <text>|recent|forget <pattern>|show]", async (args) => {
    const sub = args[0] || "show";

    if (sub === "show") {
      const mem = await storage.getAgentConfig("persistent_context");
      const text = mem?.value || "";
      if (!text.trim()) return ok("Memory is empty.");
      return ok(text);
    }

    if (sub === "search") {
      const query = args.slice(1).join(" ");
      if (!query) return fail("[error] memory search: usage: memory search <query>");
      const mem = await storage.getAgentConfig("persistent_context");
      const lines = (mem?.value || "").split("\n").filter(l => l.toLowerCase().includes(query.toLowerCase()));

      const resultHits = await storage.getAgentResults(undefined, 50);
      const matchedResults = resultHits
        .filter(r => r.summary.toLowerCase().includes(query.toLowerCase()) || (r.rawOutput || "").toLowerCase().includes(query.toLowerCase()))
        .slice(0, 10);

      const output: string[] = [];
      if (lines.length > 0) {
        output.push("=== PERSISTENT MEMORY ===");
        for (const l of lines) output.push(`  ${l}`);
      }
      if (matchedResults.length > 0) {
        output.push("=== AGENT RESULTS ===");
        for (const r of matchedResults) {
          output.push(`  [${r.createdAt.toISOString().slice(0, 16)}] ${r.programName}: ${r.summary.slice(0, 80)}`);
        }
      }
      if (output.length === 0) return ok(`No memory matching "${query}".`);
      return ok(output.join("\n"));
    }

    if (sub === "store") {
      const text = args.slice(1).join(" ");
      if (!text) return fail("[error] memory store: usage: memory store <text to remember>");
      const existing = await storage.getAgentConfig("persistent_context");
      const timestamp = new Date().toISOString().slice(0, 16);
      const entry = `[${timestamp}] ${text}`;
      const newValue = (existing?.value || "") + "\n" + entry;
      await storage.setAgentConfig("persistent_context", newValue.trim(), "memory");
      emitEvent("cli", `Memory stored: ${text.slice(0, 60)}`, "info", { metadata: { command: "memory store" } });
      return ok(`Stored: ${entry}`);
    }

    if (sub === "recent") {
      const n = parseInt(args[1] || "10", 10);
      const mem = await storage.getAgentConfig("persistent_context");
      const lines = (mem?.value || "").split("\n").filter(Boolean);
      if (lines.length === 0) return ok("No memory entries.");
      return ok(lines.slice(-n).join("\n"));
    }

    if (sub === "forget") {
      const pattern = args.slice(1).join(" ");
      if (!pattern) return fail("[error] memory forget: usage: memory forget <pattern>");
      const mem = await storage.getAgentConfig("persistent_context");
      if (!mem?.value) return ok("Memory is already empty.");
      const lines = mem.value.split("\n");
      const kept = lines.filter(l => !l.toLowerCase().includes(pattern.toLowerCase()));
      const removed = lines.length - kept.length;
      await storage.setAgentConfig("persistent_context", kept.join("\n"), "memory");
      emitEvent("cli", `Memory: forgot ${removed} entries matching "${pattern}"`, "info", { metadata: { command: "memory forget" } });
      return ok(`Removed ${removed} entries matching "${pattern}". ${kept.length} entries remaining.`);
    }

    return fail(`[error] memory: unknown subcommand "${sub}"\nUsage: memory [search <query>|store <text>|recent|forget <pattern>|show]`);
  });

  registerCommand("scrape", "Scrape a URL or run a site profile", "scrape <url> | scrape profile <name> | scrape path <id>", async (args) => {
    const sub = args[0];
    if (!sub) return fail("[error] scrape: usage: scrape <url> | scrape profile <name> | scrape path <id>");

    if (sub === "profile") {
      const name = args.slice(1).join(" ");
      if (!name) return fail("[error] scrape profile: usage: scrape profile <name>. Use 'profiles list' to see available.");
      const profile = await storage.getSiteProfileByName(name);
      if (!profile) return fail(`[error] scrape: profile "${name}" not found. Use 'profiles list' to see available.`);
      const paths = await storage.getNavigationPaths(profile.id);
      if (paths.length === 0) return fail(`[error] scrape: profile "${name}" has no navigation paths configured.`);
      const navPath = paths[0];
      emitEvent("cli", `Scraping via profile: ${name}/${navPath.name}`, "action", { metadata: { command: "scrape profile" } });
      try {
        const result = await executeNavigationPath(profile, navPath);
        if (!result.success) return fail(`[error] scrape: ${result.error || "scraping failed"}`);
        const lines: string[] = [`# ${result.profileName} / ${result.pathName}`];
        if (result.content?.title) lines.push(`Title: ${result.content.title}`);
        if (Object.keys(result.extractedData).length > 0) {
          for (const [k, v] of Object.entries(result.extractedData)) {
            lines.push(`${k}: ${v.slice(0, 500)}`);
          }
        }
        if (result.content?.text) lines.push("", result.content.text.slice(0, 10000));
        emitEvent("cli", `Scrape complete: ${name} (${result.durationMs}ms)`, "info", { metadata: { command: "scrape profile" } });
        return ok(lines.join("\n"));
      } catch (e: any) {
        return fail(`[error] scrape profile: ${e.message}`);
      }
    }

    if (sub === "path") {
      const pathId = parseInt(args[1], 10);
      if (isNaN(pathId)) return fail("[error] scrape path: usage: scrape path <id>");
      const navPath = await storage.getNavigationPath(pathId);
      if (!navPath) return fail(`[error] scrape: navigation path #${pathId} not found`);
      const profile = await storage.getSiteProfile(navPath.siteProfileId);
      if (!profile) return fail("[error] scrape: site profile not found for this path");
      emitEvent("cli", `Scraping path #${pathId}: ${profile.name}/${navPath.name}`, "action", { metadata: { command: "scrape path" } });
      try {
        const result = await executeNavigationPath(profile, navPath);
        if (!result.success) return fail(`[error] scrape: ${result.error || "scraping failed"}`);
        const lines: string[] = [`# ${result.profileName} / ${result.pathName}`];
        if (result.content?.title) lines.push(`Title: ${result.content.title}`);
        if (Object.keys(result.extractedData).length > 0) {
          for (const [k, v] of Object.entries(result.extractedData)) {
            lines.push(`${k}: ${v.slice(0, 500)}`);
          }
        }
        if (result.content?.text) lines.push("", result.content.text.slice(0, 10000));
        emitEvent("cli", `Scrape complete: path #${pathId} (${result.durationMs}ms)`, "info", { metadata: { command: "scrape path" } });
        return ok(lines.join("\n"));
      } catch (e: any) {
        return fail(`[error] scrape path: ${e.message}`);
      }
    }

    if (sub.startsWith("http://") || sub.startsWith("https://")) {
      const url = sub;
      emitEvent("cli", `Scraping URL: ${url}`, "action", { metadata: { command: "scrape" } });
      try {
        const profiles = await storage.getSiteProfiles();
        const matched = matchProfileToUrl(profiles, url);
        if (matched) {
          const paths = await storage.getNavigationPaths(matched.id);
          if (paths.length > 0) {
            const result = await executeNavigationPath(matched, paths[0], undefined, url);
            if (result.success) {
              const lines: string[] = [`# ${result.profileName} / ${result.pathName}`, `URL: ${url}`];
              if (result.content?.title) lines.push(`Title: ${result.content.title}`);
              if (result.content?.text) lines.push("", result.content.text.slice(0, 10000));
              emitEvent("cli", `Scrape complete: ${url} via ${matched.name} (${result.durationMs}ms)`, "info", { metadata: { command: "scrape" } });
              return ok(lines.join("\n"));
            }
          }
        }
        const result = await bestEffortExtract(url);
        const lines: string[] = [`# Best-effort scrape`, `URL: ${url}`];
        if (result.content?.title) lines.push(`Title: ${result.content.title}`);
        if (result.content?.text) lines.push("", result.content.text.slice(0, 10000));
        emitEvent("cli", `Scrape complete: ${url} (best-effort, ${result.durationMs}ms)`, "info", { metadata: { command: "scrape" } });
        return ok(lines.join("\n"));
      } catch (e: any) {
        return fail(`[error] scrape: ${e.message}`);
      }
    }

    return fail(`[error] scrape: "${sub}" is not a valid URL or subcommand.\nUsage: scrape <url> | scrape profile <name> | scrape path <id>`);
  });

  registerCommand("propose-recipe", "Propose a new recipe for approval", "propose-recipe <name> <command> [--schedule <schedule>] [--desc <description>]", async (args) => {
    const name = args[0];
    if (!name) return fail("[error] propose-recipe: usage: propose-recipe <name> <command> [--schedule <schedule>]");
    let command = "";
    let schedule = "";
    let description = "";
    let i = 1;
    while (i < args.length) {
      if (args[i] === "--schedule" && args[i + 1]) { schedule = args[i + 1]; i += 2; }
      else if (args[i] === "--desc" && args[i + 1]) { description = args.slice(i + 1).join(" "); break; }
      else { command += (command ? " " : "") + args[i]; i++; }
    }
    if (!command) return fail("[error] propose-recipe: command is required");

    await storage.createProposal({
      section: "RECIPES",
      targetName: name,
      reason: `Proposed recipe: ${name}\nCommand: ${command}${schedule ? `\nSchedule: ${schedule}` : ""}${description ? `\nDescription: ${description}` : ""}`,
      currentContent: "",
      proposedContent: JSON.stringify({ name, command, schedule: schedule || null, description }),
      source: "agent",
      proposalType: "change",
    });

    emitEvent("cli", `Recipe proposed: ${name} = "${command}"`, "take-over-point", { metadata: { command: "propose-recipe", recipe: name } });
    return ok(`Proposed recipe "${name}": ${command}${schedule ? ` (schedule: ${schedule})` : ""}\nAwaiting human approval in proposals.`);
  });

  function buildHardenedBriefing(
    today: string,
    grouped: Map<string, any[]>,
    programs: any[],
    errorResults: any[],
    recipesRun: any[],
    taskSection: string
  ): string {
    const urlRegex = /https?:\/\/[^\s"'<>\])+,]+/g;
    const lines: string[] = [`MORNING BRIEFING — ${today}\n`];

    lines.push(`${grouped.size} agents reported, ${errorResults.length} errors, ${recipesRun.length} recipes fired.\n`);

    lines.push("DETAILED REPORTS\n");
    for (const [name, runs] of grouped) {
      const prog = programs.find((p: any) => p.name === name);
      const latest = runs[0];
      const output = latest.rawOutput || latest.summary || "";
      const summary = latest.summary || "";

      lines.push(`${name}`);
      lines.push(`  Runs: ${runs.length} | Latest: ${summary.slice(0, 200)}`);

      const urls = [...new Set((output.match(urlRegex) || []).map((u: string) => u.replace(/[.)]+$/, "")))];
      if (urls.length > 0) {
        lines.push(`  Links:`);
        for (const url of urls.slice(0, 20)) {
          lines.push(`    ${url}`);
        }
      }
      lines.push("");
    }

    if (errorResults.length > 0) {
      lines.push("ERRORS\n");
      for (const r of errorResults) {
        lines.push(`  ${r.programName}: ${r.summary.slice(0, 200)}`);
      }
      lines.push("");
    }

    if (recipesRun.length > 0) {
      lines.push("RECIPES FIRED\n");
      for (const r of recipesRun) {
        lines.push(`  ${r.recipeName || r.programName}: ${r.summary.slice(0, 120)}`);
      }
      lines.push("");
    }

    lines.push(`TASKS\n${taskSection}`);

    return lines.join("\n");
  }

  registerCommand("standup", "Morning standup briefing of yesterday's work", "standup [--days N] [--raw]", async (args) => {
    let days = 1;
    let raw = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--days" && args[i + 1]) { days = parseInt(args[i + 1], 10); i++; }
      if (args[i] === "--raw") raw = true;
    }

    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().slice(0, 10);
    const today = new Date().toISOString().split("T")[0];

    const [allResults, allRecipes, overdue, todayTasks, programs] = await Promise.all([
      storage.getAgentResults(undefined, 100),
      storage.getRecipes(),
      storage.getOverdueTasks(today),
      storage.getTasksByDate(today),
      storage.getPrograms(),
    ]);

    const recentResults = allResults.filter(r => r.createdAt >= since);
    const successResults = recentResults.filter(r => r.status === "ok");
    const errorResults = recentResults.filter(r => r.status === "error");
    const recipesRun = allRecipes.filter(r => r.lastRun && r.lastRun >= since);

    const agentReports: string[] = [];
    let radarStructuredData: any = null;
    const grouped = new Map<string, typeof successResults>();
    for (const r of successResults) {
      if (!grouped.has(r.programName)) grouped.set(r.programName, []);
      grouped.get(r.programName)!.push(r);
    }
    for (const [name, runs] of grouped) {
      const prog = programs.find(p => p.name === name);
      const latest = runs[0];
      let fullOutput = latest.rawOutput || latest.summary || "";
      if (name === "research-radar") {
        const sdMatch = fullOutput.match(/<!--STRUCTURED_DATA_START-->\n([\s\S]*?)\n<!--STRUCTURED_DATA_END-->/);
        if (sdMatch) {
          try { radarStructuredData = JSON.parse(sdMatch[1]); } catch {}
          fullOutput = fullOutput.replace(/\n<!--STRUCTURED_DATA_START-->[\s\S]*<!--STRUCTURED_DATA_END-->/, "").trim();
        }
      }
      const output = fullOutput.slice(0, 8000);
      agentReports.push(`AGENT: ${name}\nRUNS: ${runs.length}\nOUTPUT:\n${output}\n`);
    }

    const errorReports: string[] = [];
    const seenErrors = new Set<string>();
    for (const r of errorResults) {
      if (seenErrors.has(r.programName)) continue;
      seenErrors.add(r.programName);
      const prog = programs.find(p => p.name === r.programName);
      errorReports.push(`AGENT: ${r.programName}\nERROR: ${r.summary}\n${(r.rawOutput || "").slice(0, 500)}\n`);
    }

    const taskSection = [
      ...overdue.map(t => `OVERDUE: ${t.title}`),
      ...todayTasks.map(t => `TODAY: ${t.title}`),
    ].join("\n") || "No tasks due.";

    const recipeSection = recipesRun.map(r => `${r.name} (ran ${r.runCount}x, last: ${r.lastRun?.toISOString().slice(0, 16)})`).join("\n") || "None.";

    if (raw) {
      const lines: string[] = [`=== STANDUP (${sinceStr} → ${today}) ===`, ""];
      for (const r of agentReports) lines.push(r);
      if (errorReports.length) { lines.push("ERRORS:"); for (const e of errorReports) lines.push(e); }
      lines.push(`TASKS:\n${taskSection}`);
      lines.push(`RECIPES:\n${recipeSection}`);
      return ok(lines.join("\n"));
    }

    const briefingPrompt = `You are Matt's personal assistant writing his morning briefing. You know him well — be warm but succinct. He set up all these agents himself, so DO NOT explain what each one does or what its purpose is. Just tell him what they found.

Things Matt cares about especially:
- Good deals on cars (any interesting listings, price drops, or market moves)
- Free hot tubs on Craigslist/marketplace (flag immediately if found)
- Anything that needs his attention or action

Write HTML email format. Use this EXACT structure — return ONLY the HTML inside <body>, no <html>/<head> tags:

<h2 style="margin:0 0 8px">TLDR</h2>
<p>One sentence: the single most interesting or actionable finding overnight.</p>

<h2 style="margin:16px 0 8px">INDEX</h2>
<ul>
<li><a href="#highlights">Highlights</a></li>
<li><a href="#agent-name-1">agent-name-1</a> — what it found</li>
<li><a href="#agent-name-2">agent-name-2</a> — what it found</li>
<li><a href="#attention">Needs Attention</a></li>
</ul>

<h2 id="highlights" style="margin:16px 0 8px">HIGHLIGHTS</h2>
<ul>
<li>What was found — <a href="https://actual-url-here.com">source</a></li>
</ul>

<h2 id="agent-name" style="margin:16px 0 8px">agent-name</h2>
<p>2-4 sentences of actual findings — specific data, prices, titles, numbers. No preamble about what the agent is.</p>
<ul>
<li><a href="https://url1">Link title 1</a></li>
</ul>

<h2 id="attention" style="margin:16px 0 8px">NEEDS ATTENTION</h2>
<p>Anything broken or needing a decision. If nothing, say "All clear."</p>

RULES:
- Return ONLY HTML body content (no <html>, <head>, <body> tags, no markdown, no backtick fences)
- DO NOT explain what agents do — Matt already knows. Just report findings.
- The INDEX must link to every agent section using <a href="#agent-name">
- Each agent <h2> must have a matching id="agent-name" attribute
- Every URL must be a REAL URL from the agent output — never invent URLs
- Links should use descriptive anchor text, not bare URLs
- Keep it tight: short paragraphs, bullet lists, no filler
- Date range: ${sinceStr} to ${today}

Agent data:

${agentReports.join("\n---\n")}

${errorReports.length > 0 ? `AGENT ERRORS:\n${errorReports.join("\n---\n")}` : ""}

TASKS:\n${taskSection}

RECIPES FIRED:\n${recipeSection}

Write the HTML briefing now.`;

    try {
      const configs = await storage.getAgentConfigs();
      const configMap: Record<string, string> = {};
      for (const c of configs) configMap[c.key] = c.value;
      const llmConfig: LLMConfig = {
        defaultModel: configMap["default_model"] || "openrouter/anthropic/claude-sonnet-4",
        aliases: {},
        routing: {},
      };

      const messages: LLMMessage[] = [{ role: "user", content: briefingPrompt }];
      const standupModel = configMap["standup_model"] || "openrouter/anthropic/claude-sonnet-4";
      const result = await executeLLM(messages, standupModel, llmConfig, {});

      emitEvent("cli", `Standup briefing generated (${result.tokensUsed} tokens, model: ${standupModel})`, "info", { metadata: { command: "standup" } });
      let html = result.content.trim();
      html = html.replace(/^```html?\s*/i, "").replace(/```\s*$/, "").trim();

      let sourceSectionsHtml = "";
      if (radarStructuredData) {
        const esc = (s: string) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
        const safeUrl = (u: string) => { const s = (u || "").trim(); return /^https?:\/\//i.test(s) ? esc(s) : "#"; };
        const sd = radarStructuredData;
        const sectionStyle = `style="margin:24px 0 8px;font-size:15px;color:#00ff41;border-top:1px solid #333;padding-top:12px"`;
        const subStyle = `style="margin:12px 0 4px;font-size:13px;color:#4fc3f7"`;
        const itemStyle = `style="margin:2px 0;font-size:12px;color:#ccc;line-height:1.5"`;
        const linkStyle = `style="color:#4fc3f7;text-decoration:none"`;
        const scoreStyle = `style="color:#888;font-size:11px"`;
        const commentStyle = `style="color:#999;font-size:11px;margin-left:16px;font-style:italic"`;
        const dividerHtml = `<div style="margin:32px 0 16px;border-top:2px solid #00ff41;padding-top:8px"><h2 style="margin:0;font-size:16px;color:#00ff41">FULL SOURCE FEED</h2><p style="margin:4px 0 0;font-size:11px;color:#888">Everything collected, in native ranking order. Click through to explore.</p></div>`;
        sourceSectionsHtml += dividerHtml;

        if (sd.reddit?.bySub && Object.keys(sd.reddit.bySub).length > 0) {
          const mode = sd.reddit.mode || "rss";
          sourceSectionsHtml += `<h3 ${sectionStyle}>REDDIT <span ${scoreStyle}>(via ${esc(mode)}, ${Object.keys(sd.reddit.bySub).length} subs)</span></h3>`;
          for (const [sub, items] of Object.entries(sd.reddit.bySub) as [string, any[]][]) {
            sourceSectionsHtml += `<h4 ${subStyle}><a href="https://www.reddit.com/r/${esc(sub)}/hot/" ${linkStyle}>r/${esc(sub)}</a></h4><ul style="margin:0;padding-left:16px">`;
            for (const item of (items || []).slice(0, 10)) {
              const scoreStr = item.score > 0 ? ` <span ${scoreStyle}>(${item.score} pts)</span>` : "";
              sourceSectionsHtml += `<li ${itemStyle}><a href="${safeUrl(item.url)}" ${linkStyle}>${esc(item.title || "")}</a>${scoreStr}</li>`;
              if (item.topComment) {
                sourceSectionsHtml += `<div ${commentStyle}>"${esc((item.topComment || "").slice(0, 200))}"</div>`;
              }
            }
            sourceSectionsHtml += `</ul>`;
          }
        }

        if (sd.hn?.length) {
          sourceSectionsHtml += `<h3 ${sectionStyle}>HACKER NEWS <span ${scoreStyle}>(${sd.hn.length} stories)</span></h3><ul style="margin:0;padding-left:16px">`;
          for (const item of sd.hn.slice(0, 12)) {
            const desc = (item.description || "").trim();
            const commentsUrl = desc.startsWith("http") ? desc : desc.replace(/^Comments:\s*/i, "").trim();
            sourceSectionsHtml += `<li ${itemStyle}><a href="${safeUrl(item.url)}" ${linkStyle}>${esc(item.title || "")}</a> <span ${scoreStyle}>(${item.score || 0} pts)</span>`;
            if (/^https?:\/\//i.test(commentsUrl)) sourceSectionsHtml += ` <a href="${safeUrl(commentsUrl)}" ${linkStyle}>[comments]</a>`;
            sourceSectionsHtml += `</li>`;
          }
          sourceSectionsHtml += `</ul>`;
        }

        if (sd.github?.length) {
          sourceSectionsHtml += `<h3 ${sectionStyle}>GITHUB TRENDING</h3><ul style="margin:0;padding-left:16px">`;
          for (const item of sd.github.slice(0, 10)) {
            const langTag = item.lang ? `[${esc(item.lang)}] ` : "";
            sourceSectionsHtml += `<li ${itemStyle}>${langTag}<a href="${safeUrl(item.url)}" ${linkStyle}>${esc(item.title || "")}</a></li>`;
          }
          sourceSectionsHtml += `</ul>`;
        }

        if (sd.arxiv?.length) {
          sourceSectionsHtml += `<h3 ${sectionStyle}>ARXIV CS.AI</h3><ul style="margin:0;padding-left:16px">`;
          for (const item of sd.arxiv.slice(0, 10)) {
            sourceSectionsHtml += `<li ${itemStyle}><a href="${safeUrl(item.url)}" ${linkStyle}>${esc(item.title || "")}</a></li>`;
          }
          sourceSectionsHtml += `</ul>`;
        }

        if (sd.lobsters?.length) {
          sourceSectionsHtml += `<h3 ${sectionStyle}>LOBSTERS <span ${scoreStyle}>(${sd.lobsters.length} items)</span></h3><ul style="margin:0;padding-left:16px">`;
          for (const item of sd.lobsters.slice(0, 10)) {
            const tagsStr = (item.tags || []).length ? ` <span ${scoreStyle}>[${esc((item.tags || []).join(", "))}]</span>` : "";
            sourceSectionsHtml += `<li ${itemStyle}><a href="${safeUrl(item.url)}" ${linkStyle}>${esc(item.title || "")}</a> <span ${scoreStyle}>(${item.score || 0} pts)</span>${tagsStr}</li>`;
          }
          sourceSectionsHtml += `</ul>`;
        }

        const lemmyItems = [...(sd.lemmy?.machinelearning || []), ...(sd.lemmy?.artificial_intelligence || [])];
        if (lemmyItems.length) {
          sourceSectionsHtml += `<h3 ${sectionStyle}>LEMMY</h3><ul style="margin:0;padding-left:16px">`;
          for (const item of lemmyItems.slice(0, 8)) {
            sourceSectionsHtml += `<li ${itemStyle}><a href="${safeUrl(item.url)}" ${linkStyle}>${esc(item.title || "")}</a> <span ${scoreStyle}>(${item.score || 0} pts, c/${esc(item.sub || "")})</span></li>`;
          }
          sourceSectionsHtml += `</ul>`;
        }
      }

      const header = `<div style="font-family:'IBM Plex Mono',monospace;max-width:680px;margin:0 auto;color:#e0e0e0;background:#0a0a0a;padding:24px;border:1px solid #333">` +
        `<h1 style="margin:0 0 4px;font-size:18px;color:#00ff41">MORNING BRIEFING</h1>` +
        `<p style="margin:0 0 16px;font-size:12px;color:#888">${today}</p>`;
      const footer = `</div>`;
      const fullHtml = header + html + sourceSectionsHtml + footer;

      let voiceScript = "";
      try {
        const voicePrompt = `You are Matt's personal assistant. Convert this briefing into a spoken script that you'd read to him over coffee. You know him well — you're warm, personable, and efficient. You don't waste his time.

Rules:
- Open casually: "Good morning, Matt." then the date and straight into what matters
- You know his interests — if there's anything about car deals or free hot tubs, lead with that
- Be conversational and natural — like a real person who likes Matt, not a news anchor
- Don't explain what agents are or what they do — he built them, he knows
- Just tell him the interesting findings, anything that needs his attention, and anything fun or notable
- Use natural transitions, not broadcast cliches
- Skip URLs, HTML tags, and technical formatting
- Keep it under 90 seconds when read aloud (roughly 200-250 words)
- End warmly but briefly — "Have a good one" or similar
- Write ONLY the spoken script, no stage directions, no [brackets], no markdown

HTML briefing:
${fullHtml}`;

        const voiceMessages: LLMMessage[] = [{ role: "user", content: voicePrompt }];
        const voiceModel = "openrouter/anthropic/claude-opus-4";
        const voiceResult = await executeLLM(voiceMessages, voiceModel, llmConfig, {});
        voiceScript = voiceResult.content.trim();
        voiceScript = voiceScript.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
        emitEvent("cli", `Voice script generated (${voiceResult.tokensUsed} tokens)`, "info", { metadata: { command: "standup" } });
      } catch (voiceErr: any) {
        console.error("[standup] Voice script generation failed:", voiceErr?.message);
        voiceScript = htmlToSpokenScript(fullHtml);
      }

      return ok(fullHtml + "\n<!--VOICE_SCRIPT_START-->\n" + voiceScript + "\n<!--VOICE_SCRIPT_END-->");
    } catch (e: any) {
      console.error("[standup] LLM error, using hardened fallback:", e?.message || e);
      return ok(buildHardenedBriefing(today, grouped, programs, errorResults, recipesRun, taskSection));
    }
  });

  registerCommand("bridge-token", "Get or set the bridge token for Chrome extension auth", "bridge-token", async () => {
    const { getBridgeToken } = await import("./bridge-queue");
    const token = getBridgeToken();
    return ok(`Bridge token: ${token}\n\nPaste this into the Chrome extension options page.`);
  });

  registerCommand("bridge-status", "Show unified bridge status (extension + playwright + queue)", "bridge-status", async () => {
    const { getQueueStatus, isExtensionConnected } = await import("./bridge-queue");
    const status = getQueueStatus();
    const lines: string[] = [];
    lines.push("=== Bridge Status ===");
    lines.push("");
    lines.push(`Chrome Extension: ${status.extensionConnected ? "CONNECTED" : "OFFLINE"}`);
    if (status.extensionLastSeen) {
      const ago = Math.round((Date.now() - status.extensionLastSeen) / 1000);
      lines.push(`  Last seen: ${ago}s ago`);
    }
    if (status.extensionVersion) lines.push(`  Version: ${status.extensionVersion}`);
    lines.push(`  Jobs completed: ${status.extensionJobsCompleted}`);
    if (status.extensionLastError) lines.push(`  Last error: ${status.extensionLastError}`);
    lines.push("");
    lines.push(`Queue: ${status.pending} pending, ${status.completed} completed`);
    if (status.jobs.length > 0) {
      for (const j of status.jobs) {
        const ageSec = Math.round(j.age / 1000);
        lines.push(`  [${j.id.slice(0, 8)}] ${j.url} (${ageSec}s ago, retry ${j.retryCount})`);
      }
    }
    return ok(lines.join("\n"));
  });

  registerCommand("cwp", "Browse UCSD Citrix Workspace (cwp.ucsd.edu) via bridge", "cwp [--list] [--raw]", async (args) => {
    const { smartFetch, isExtensionConnected } = await import("./bridge-queue");
    if (!isExtensionConnected()) {
      return fail("[cwp] Chrome extension bridge not connected. CWP requires your real browser session.\nRun: bridge-status");
    }
    const showRaw = args.includes("--raw");
    const result = await smartFetch("https://cwp.ucsd.edu", "dom", "cli-cwp", { maxText: 30000 }, 60000);
    if (result.error) return fail(`[cwp] ${result.error}`);

    const text = result.text || "";
    const html = typeof result.body === "string" ? result.body : "";

    if (showRaw) {
      return ok("=== CWP Raw Content ===\n\n" + text.slice(0, 8000));
    }

    const apps: {name: string; url: string}[] = [];

    const launchRe = /href="([^"]*(?:launch|Launch|store|Store|citrix|Citrix)[^"]*)"\s*[^>]*>([^<]*)</g;
    let m: RegExpExecArray | null;
    const source = html || text;
    while ((m = launchRe.exec(source)) !== null) {
      const url = m[1].trim();
      const name = m[2].trim();
      if (name.length > 1 && name.length < 120) apps.push({ name, url });
    }

    if (apps.length === 0) {
      const appRe = /class="[^"]*(?:app-name|resource-name|storeapp-name)[^"]*"[^>]*>([^<]+)/gi;
      while ((m = appRe.exec(source)) !== null) {
        apps.push({ name: m[1].trim(), url: "" });
      }
    }

    if (apps.length === 0) {
      const lines = text.split(/[\n\r]+/).map(l => l.trim()).filter(l => l.length > 3 && l.length < 80);
      const uniqueLines = [...new Set(lines)];
      return ok("=== CWP Citrix Workspace ===\n\nPage loaded (" + text.length + " chars) but no app links parsed.\nPage content preview:\n\n" + uniqueLines.slice(0, 30).join("\n") + "\n\nTry: cwp --raw  for full content\nOr:  bridge https://cwp.ucsd.edu --dom  for detailed extraction");
    }

    const unique = new Map<string, string>();
    for (const app of apps) {
      if (!unique.has(app.name)) unique.set(app.name, app.url);
    }

    const appLines = Array.from(unique.entries()).map(([name, url], i) => {
      return `  ${i + 1}. ${name}${url ? "\n     " + url : ""}`;
    });

    return ok(`=== CWP Citrix Workspace ===\n${unique.size} applications found\n\n${appLines.join("\n")}`);
  });

  registerCommand("bridge", "Smart fetch: tries Chrome extension first, falls back to direct fetch", "bridge <url> [--dom] [--wait <ms>] [--selector key=sel] [--direct]", async (args) => {
    const { smartFetch, getQueueStatus, isExtensionConnected } = await import("./bridge-queue");
    if (args.length === 0) {
      const status = getQueueStatus();
      const ext = isExtensionConnected() ? "CONNECTED" : "OFFLINE";
      return ok(`Bridge: ext=${ext}, queue=${status.pending} pending, ${status.completed} completed`);
    }

    const url = args.find(a => a.startsWith("http"));
    if (!url) return fail("[error] bridge: provide a URL starting with http");

    const isDom = args.includes("--dom");
    const waitIdx = args.indexOf("--wait");
    const timeoutMs = waitIdx >= 0 && args[waitIdx + 1] ? parseInt(args[waitIdx + 1], 10) : 45000;

    const selectors: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--selector" && args[i + 1]) {
        const [key, ...selParts] = args[i + 1].split("=");
        if (key && selParts.length) selectors[key] = selParts.join("=");
        i++;
      }
    }

    const type = isDom || Object.keys(selectors).length > 0 ? "dom" : "fetch";
    const options: any = {};
    if (Object.keys(selectors).length > 0) options.selectors = selectors;
    if (isDom) options.maxText = 15000;

    const { isBridgeOnlyDomain } = await import("./bridge-queue");
    const forceDirect = args.includes("--direct");
    const bridgeOnlyUrl = isBridgeOnlyDomain(url);
    emitEvent("cli", `Bridge: ${type} ${url} (ext=${isExtensionConnected() ? "on" : "off"}, direct=${forceDirect}, bridgeOnly=${bridgeOnlyUrl})`, "info", { metadata: { command: "bridge" } });

    if (forceDirect && bridgeOnlyUrl) {
      return fail(`[error] ${new URL(url).hostname} is a bridge-only domain — direct fetch is blocked to avoid automated detection. Remove --direct flag.`);
    }

    let result;
    if (forceDirect) {
      const res = await fetch(url, { headers: options?.headers || {} });
      const ct = res.headers.get("content-type") || "";
      let body: any;
      if (ct.includes("json")) body = await res.json();
      else body = await res.text();
      let text: string | undefined;
      if (typeof body === "string" && type === "dom") {
        text = body.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, options?.maxText || 15000);
      }
      result = { jobId: "direct", status: res.status, contentType: ct, body, text, url: res.url, completedAt: Date.now(), source: "direct" as const };
    } else {
      result = await smartFetch(url, type as any, "cli", options, timeoutMs);
    }

    const sourceTag = result.source ? ` [via ${result.source}]` : "";
    if (result.error) return fail(`[bridge error${sourceTag}] ${result.error}`);

    if (result.text) return ok(result.text);
    if (result.body && typeof result.body === "string") return ok(result.body);
    if (result.body) return ok(JSON.stringify(result.body, null, 2));
    return ok(`Bridge response: status ${result.status}${sourceTag}`);
  });

  registerCommand("notify", "Send a notification via ntfy.sh or webhook", "notify <message> | echo <text> | notify\nConfig: config set notify_channel <channel> | config set notify_webhook <url>", async (args, stdin) => {
    const message = args.length > 0 ? args.join(" ") : stdin;
    if (!message.trim()) return fail("[error] notify: no message. Pipe input or provide text.\nUsage: standup | notify  OR  notify Hello world");

    const channelConfig = await storage.getAgentConfig("notify_channel");
    const webhookConfig = await storage.getAgentConfig("notify_webhook");
    const emailConfig = await storage.getAgentConfig("notify_email");
    const channel = channelConfig?.value;
    const webhook = webhookConfig?.value;
    const email = emailConfig?.value;

    if (!channel && !webhook) {
      return fail("[error] notify: no notification target configured.\nSet up ntfy.sh:  config set notify_channel orgcloud-briefing\nOr a webhook:    config set notify_webhook https://your-webhook-url\nFor email:       config set notify_email you@example.com\n\nFor ntfy.sh: install the ntfy app on your phone, subscribe to the same channel name.");
    }

    const results: string[] = [];
    const fs = await import("fs");
    const pathMod = await import("path");

    const isHtml = message.includes("<h1") || message.includes("<h2") || message.includes("<div");

    let voiceScript = "";
    let htmlBody = message;
    const voiceMatch = message.match(/<!--VOICE_SCRIPT_START-->\n([\s\S]*?)\n<!--VOICE_SCRIPT_END-->/);
    if (voiceMatch) {
      voiceScript = voiceMatch[1].trim();
      htmlBody = message.replace(/\n<!--VOICE_SCRIPT_START-->[\s\S]*<!--VOICE_SCRIPT_END-->/, "").trim();
    }

    let audioFilePath: string | null = null;
    if (voiceScript) {
      try {
        emitEvent("cli", "Synthesizing voice briefing...", "info", { metadata: { command: "notify" } });
        const voiceResult = await synthesizeBriefing(voiceScript, "assistant");
        audioFilePath = voiceResult.filePath;
        emitEvent("cli", `Voice synthesized: ${voiceResult.sizeBytes} bytes, ~${voiceResult.durationEstSec}s`, "info", { metadata: { command: "notify" } });
      } catch (voiceErr: any) {
        console.error("[notify] Voice synthesis failed:", voiceErr?.message);
        results.push(`Voice synthesis failed: ${voiceErr?.message || "unknown error"}`);
      }
    }

    const domain = (process.env.REPLIT_DOMAINS || "").split(",")[0].trim();
    const baseUrl = domain ? `https://${domain}` : "http://localhost:5000";
    const briefingsDir = pathMod.join(process.cwd(), ".briefings");
    if (!fs.existsSync(briefingsDir)) fs.mkdirSync(briefingsDir, { recursive: true });

    const now = new Date();
    const dateStamp = now.toISOString().slice(0, 10);
    let htmlUrl = "";
    let audioUrl = "";

    if (isHtml) {
      const htmlFilename = `briefing-${dateStamp}.html`;

      let audioPlayerHtml = "";
      if (audioFilePath && fs.existsSync(audioFilePath)) {
        const audioFilename = `briefing-${dateStamp}.mp3`;
        const audioDest = pathMod.join(briefingsDir, audioFilename);
        fs.copyFileSync(audioFilePath, audioDest);
        audioUrl = `${baseUrl}/briefings/${audioFilename}`;
        audioPlayerHtml = [
          '<div style="background:#1a1a2e;border:1px solid #00ff41;border-radius:8px;padding:16px;margin:20px 0;">',
          '<p style="color:#00ff41;margin:0 0 10px 0;font-size:14px;">&#127911; VOICE BRIEFING</p>',
          `<audio controls preload="auto" style="width:100%;max-width:500px;display:block;">`,
          `<source src="${audioUrl}" type="audio/mpeg">`,
          '</audio>',
          `<p style="margin:8px 0 0 0;font-size:12px;"><a href="${audioUrl}" style="color:#4fc3f7;" download="morning-briefing.mp3">Download MP3</a></p>`,
          '</div>',
        ].join("");
      }

      const closingDiv = htmlBody.lastIndexOf("</div>");
      const withPlayer = closingDiv >= 0
        ? htmlBody.slice(0, closingDiv) + audioPlayerHtml + htmlBody.slice(closingDiv)
        : htmlBody + audioPlayerHtml;
      const fullHtml = withPlayer
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/\bon\w+\s*=\s*"[^"]*"/gi, "")
        .replace(/\bon\w+\s*=\s*'[^']*'/gi, "");
      const htmlDest = pathMod.join(briefingsDir, htmlFilename);
      fs.writeFileSync(htmlDest, fullHtml);
      htmlUrl = `${baseUrl}/briefings/${htmlFilename}`;
    }

    if (channel) {
      try {
        const ntfyLines: string[] = [];
        if (htmlUrl) {
          const plainText = htmlBody
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<h[1-3][^>]*>/gi, "\n\n## ")
            .replace(/<\/h[1-3]>/gi, " ##\n")
            .replace(/<li[^>]*>/gi, "\n- ")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<p[^>]*>/gi, "\n")
            .replace(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, "$2 ($1)")
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
            .replace(/\n{3,}/g, "\n\n")
            .trim();
          ntfyLines.push(plainText.slice(0, 4000));
        } else {
          ntfyLines.push(message.slice(0, 4000));
        }
        const headers: Record<string, string> = {
          "Title": "OrgCloud Morning Briefing",
          "Priority": "default",
          "Tags": "briefcase,radio",
        };
        if (htmlUrl) {
          headers["Click"] = htmlUrl;
          const actions: string[] = [];
          actions.push(`view, Read Briefing, ${htmlUrl}`);
          if (audioUrl) {
            actions.push(`view, Listen to Audio, ${audioUrl}`);
          }
          headers["Actions"] = actions.join("; ");
        }
        if (email) {
          headers["Email"] = email;
        }
        let resp: Response | null = null;
        const maxRetries = 3;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          resp = await fetch(`https://ntfy.sh/${channel}`, {
            method: "POST",
            headers,
            body: ntfyLines.join("\n"),
          });
          if (resp.ok) break;
          if (resp.status === 429 && attempt < maxRetries - 1) {
            const waitSec = Math.pow(2, attempt + 1) * 15;
            emitEvent("cli", `ntfy.sh rate limited (429), retrying in ${waitSec}s (attempt ${attempt + 2}/${maxRetries})`, "warn", { metadata: { command: "notify" } });
            await new Promise(r => setTimeout(r, waitSec * 1000));
          } else {
            break;
          }
        }
        if (resp && resp.ok) {
          results.push(`Sent to ntfy.sh/${channel}${email ? ` + email to ${email}` : ""}`);
          if (htmlUrl) results.push(`Briefing: ${htmlUrl}`);
          if (audioUrl) results.push(`Audio: ${audioUrl}`);
          emitEvent("cli", `Notification sent to ntfy.sh/${channel}${email ? ` + ${email}` : ""}`, "info", { metadata: { command: "notify" } });
        } else {
          results.push(`ntfy.sh error: ${resp?.status} ${resp?.statusText} (after ${maxRetries} attempts)`);
        }
      } catch (e: any) {
        results.push(`ntfy.sh error: ${e.message}`);
      }
    }

    if (webhook) {
      try {
        const resp = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: message.slice(0, 16000), title: "OrgCloud Morning Standup", timestamp: new Date().toISOString() }),
        });
        if (resp.ok) {
          results.push(`Sent to webhook`);
          emitEvent("cli", `Notification sent to webhook`, "info", { metadata: { command: "notify" } });
        } else {
          results.push(`Webhook error: ${resp.status} ${resp.statusText}`);
        }
      } catch (e: any) {
        results.push(`Webhook error: ${e.message}`);
      }
    }

    return ok(results.join("\n"));
  });

  registerCommand("outlook", "Browse Outlook inbox/calendar via bridge", "outlook [inbox|calendar|read <n>] [--limit N] [--refresh]", async (args) => {
    const { smartFetch, isExtensionConnected } = await import("./bridge-queue");
    if (!isExtensionConnected()) {
      return fail("[outlook] Chrome extension bridge not connected. Outlook requires your real browser session.\nRun: bridge-status");
    }
    const sub = args[0] || "inbox";
    const refresh = args.includes("--refresh");
    const limitIdx = args.indexOf("--limit");
    const limit = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : 20;

    if (sub === "inbox") {
      const cached = getMailCache();
      if (cached && !refresh) {
        const age = Math.round((Date.now() - cached.fetchedAt) / 1000);
        const emails = cached.emails.slice(0, limit);
        const lines = [`=== OUTLOOK INBOX === (cached ${age}s ago, ${cached.emails.length} messages)`, ""];
        emails.forEach((e, i) => {
          const unread = e.unread ? "*" : " ";
          const from = e.from.padEnd(25).slice(0, 25);
          const date = e.date.padEnd(12).slice(0, 12);
          lines.push(`${unread}${String(i + 1).padStart(3)}  ${date}  ${from}  ${e.subject.slice(0, 60)}`);
        });
        lines.push("", `Use: outlook read <n> | outlook --refresh | outlook calendar`);
        return ok(lines.join("\n"));
      }

      emitEvent("cli", "Fetching Outlook inbox via bridge DOM extraction...", "info", { metadata: { command: "outlook" } });
      const result = await smartFetch("https://outlook.office.com/mail/inbox", "dom", "cli-outlook", {
        maxText: 60000,
        selectors: {
          rows: '[role="option"][aria-label], [role="listbox"] [role="option"], div[data-convid], tr[aria-label]',
        },
      }, 60000);
      if (result.error) return fail(`[outlook] ${result.error}`);
      const text = result.text || "";
      const html = typeof result.body === "string" ? result.body : "";
      const source = html || text;
      const extracted = (result as any).extracted || {};

      const showRaw = args.includes("--raw");
      if (showRaw) {
        const rowCount = extracted?.rows?.length || 0;
        const debug = (result as any).debug || {};
        const sampleRows = (extracted?.rows || []).slice(0, 8).map((r: any, i: number) => {
          const aria = r.ariaLabel ? `[aria] ${r.ariaLabel.trim().slice(0, 120)}` : `[text] ${(r.text || "").trim().slice(0, 120)}`;
          return `  [${i}] ${aria}`;
        }).join(String.fromCharCode(10));
        const rawLines = [
          `=== OUTLOOK RAW EXTRACTION ===`,
          `Final URL: ${(result as any).url || "?"}`,
          `Page title: ${(result as any).title || "?"}`,
          `Text length: ${text.length} chars`,
          `HTML length: ${html.length} chars`,
          `Extracted rows: ${rowCount}`,
          `Debug: iframes=${debug.iframeCount ?? "?"}, bodyChildren=${debug.bodyChildCount ?? "?"}, textLen=${debug.textLen ?? "?"}`,
          "",
          "--- First 8 extracted rows ---",
          sampleRows || "(none)",
          "",
          "--- First 2000 chars of text ---",
          text.slice(0, 2000),
        ];
        return ok(rawLines.join(String.fromCharCode(10)));
      }

      const emails = parseOutlookInbox(source, text, extracted);
      setMailCache({ emails, fetchedAt: Date.now() });

      if (emails.length === 0) {
        const sampleText = text.slice(0, 500).split(/[\n\r]+/).filter(l => l.trim().length > 0).slice(0, 10).join(String.fromCharCode(10));
        return ok(`=== OUTLOOK INBOX ===\n\nPage loaded (${text.length} chars) but could not parse emails.\nExtracted rows: ${extracted?.rows?.length || 0}\n\nSample text:\n${sampleText}\n\nTry: outlook --raw   for full debug output\nOr:  outlook --refresh`);
      }

      const display = emails.slice(0, limit);
      const lines = [`=== OUTLOOK INBOX === (${emails.length} messages)`, ""];
      display.forEach((e, i) => {
        const unread = e.unread ? "*" : " ";
        const from = e.from.padEnd(25).slice(0, 25);
        const date = e.date.padEnd(12).slice(0, 12);
        lines.push(`${unread}${String(i + 1).padStart(3)}  ${date}  ${from}  ${e.subject.slice(0, 60)}`);
      });
      lines.push("", `Use: outlook read <n> | outlook --refresh | outlook calendar`);
      return ok(lines.join("\n"));
    }

    if (sub === "calendar") {
      emitEvent("cli", "Fetching Outlook calendar via bridge DOM extraction...", "info", { metadata: { command: "outlook" } });
      const result = await smartFetch("https://outlook.office.com/calendar/view/week", "dom", "cli-outlook-cal", {
        maxText: 30000,
      }, 60000);
      if (result.error) return fail(`[outlook] calendar: ${result.error}`);
      const text = result.text || "";
      const html = typeof result.body === "string" ? result.body : "";
      const events = parseOutlookCalendar(html || text, text);
      setCalendarCache({ events, fetchedAt: Date.now() });

      if (events.length === 0) {
        return ok(`=== OUTLOOK CALENDAR ===\n\nPage loaded (${text.length} chars) but could not parse events.\nTry: bridge https://outlook.office.com/calendar/view/week --dom`);
      }

      const lines = [`=== OUTLOOK CALENDAR === (${events.length} events)`, ""];
      for (const ev of events) {
        lines.push(`  ${ev.date.padEnd(12)} ${ev.time.padEnd(14)} ${ev.title.slice(0, 50)}`);
        if (ev.location) lines.push(`${"".padEnd(28)} @ ${ev.location}`);
      }
      return ok(lines.join("\n"));
    }

    if (sub === "read") {
      const n = parseInt(args[1], 10);
      const cached = getMailCache();
      if (!cached || cached.emails.length === 0) return fail("[outlook] No cached emails. Run: outlook inbox");
      if (isNaN(n) || n < 1 || n > cached.emails.length) return fail(`[outlook] read: specify a number 1-${cached.emails.length}`);
      const email = cached.emails[n - 1];
      const fetchBody = args.includes("--body") || !args.includes("--preview");
      const nl = String.fromCharCode(10);

      if (fetchBody && isExtensionConnected()) {
        emitEvent("cli", `Opening email #${n}: ${email.subject?.slice(0, 40)}...`, "info", { metadata: { command: "outlook read" } });
        const readResult = await smartFetch("https://outlook.office.com/mail/inbox", "dom", "cli-outlook-read", {
          maxText: 40000,
          spaWaitMs: 15000,
          clickSelector: '[role="option"][aria-label], [role="listbox"] [role="option"], div[data-convid], tr[aria-label]',
          clickIndex: n - 1,
          postClickWaitMs: 5000,
          postClickSelector: '[role="document"], [data-app-section="ReadingPaneContainerV2"], [class*="ReadingPane"], [aria-label*="Message body"]',
          selectors: {
            readingPane: '[data-app-section="ReadingPaneContainerV2"], [class*="ReadingPaneContainer"], [id*="ReadingPane"]',
            messageBody: '[role="document"], div[aria-label*="Message body"], [class*="uniqueBody"], [class*="ItemBody"]',
            conversationItems: '[role="document"] [role="separator"] ~ *, [data-app-section*="ConversationReadingPane"] > div',
          },
        }, 60000);

        if (!readResult.error) {
          const extracted = (readResult as any).extracted || {};
          let bodyText = "";

          const readingPaneEls = extracted.readingPane || [];
          for (const el of readingPaneEls) {
            const t = cleanUnicode((el.text || "").trim());
            if (t.length > bodyText.length) bodyText = t;
          }

          if (!bodyText || bodyText.length < 50) {
            const bodyEls = extracted.messageBody || [];
            for (const el of bodyEls) {
              const t = cleanUnicode((el.text || "").trim());
              if (t.length > bodyText.length) bodyText = t;
            }
          }

          if (!bodyText || bodyText.length < 50) {
            bodyText = cleanUnicode((readResult.text || "").trim());
          }

          bodyText = stripOutlookPageChrome(bodyText, email.subject);

          if (bodyText.length > 50) {
            const bodySnippet = bodyText.length > 5000 ? bodyText.slice(0, 5000) + nl + "... (truncated)" : bodyText;

            email.fullBody = bodyText;
            email.preview = bodyText.slice(0, 500);

            const lines = [
              `=== EMAIL #${n} ===`,
              "",
              `From:    ${email.from}`,
              `Subject: ${email.subject}`,
              `Date:    ${email.date}`,
              `Status:  ${email.unread ? "UNREAD" : "read"}`,
              "",
              "--- Body ---",
              "",
              bodySnippet,
              "",
              `--- Actions ---`,
              `capture mail ${n}          Save to knowledge base`,
              `capture mail ${n} --tag work  Save with tag`,
            ];
            return ok(lines.join(nl));
          }
        }
      }

      const lines = [
        `=== EMAIL #${n} ===`,
        "",
        `From:    ${email.from}`,
        `Subject: ${email.subject}`,
        `Date:    ${email.date}`,
        `Status:  ${email.unread ? "UNREAD" : "read"}`,
        "",
        "--- Preview ---",
        "",
        email.preview || "(no preview available)",
        "",
        `--- Actions ---`,
        `capture mail ${n}          Save to knowledge base`,
        `capture mail ${n} --tag work  Save with tag`,
      ];
      if (isExtensionConnected()) {
        lines.push(`outlook read ${n} --body    Fetch full body via bridge`);
      }
      return ok(lines.join(nl));
    }

    return fail(`[outlook] unknown subcommand "${sub}"\nUsage: outlook [inbox|calendar|read <n>] [--limit N] [--refresh]`);
  });

  registerCommand("teams", "Browse Microsoft Teams chats via bridge", "teams [chats|channels] [--refresh]", async (args) => {
    const { smartFetch, isExtensionConnected } = await import("./bridge-queue");
    if (!isExtensionConnected()) {
      return fail("[teams] Chrome extension bridge not connected. Teams requires your real browser session.\nRun: bridge-status");
    }
    const sub = args[0] || "chats";
    const refresh = args.includes("--refresh");

    if (sub === "chats") {
      const cached = getTeamsCache();
      if (cached && !refresh) {
        const age = Math.round((Date.now() - cached.fetchedAt) / 1000);
        const lines = [`=== TEAMS CHATS === (cached ${age}s ago, ${cached.chats.length} conversations)`, ""];
        cached.chats.forEach((c, i) => {
          const unread = c.unread ? "*" : " ";
          const name = c.name.padEnd(30).slice(0, 30);
          lines.push(`${unread}${String(i + 1).padStart(3)}  ${name}  ${c.lastMessage.slice(0, 50)}`);
          if (c.time) lines.push(`${"".padEnd(6)} ${c.time}`);
        });
        lines.push("", `Use: teams --refresh | teams channels`);
        return ok(lines.join("\n"));
      }

      emitEvent("cli", "Fetching Teams chats via bridge DOM extraction...", "info", { metadata: { command: "teams" } });
      const result = await smartFetch("https://teams.microsoft.com/v2/", "dom", "cli-teams", {
        maxText: 40000,
      }, 90000);
      if (result.error) return fail(`[teams] ${result.error}`);
      const text = result.text || "";
      const html = typeof result.body === "string" ? result.body : "";
      const chats = parseTeamsChats(html || text, text);
      setTeamsCache({ chats, fetchedAt: Date.now() });

      if (chats.length === 0) {
        return ok(`=== TEAMS CHATS ===\n\nPage loaded (${text.length} chars) but could not parse chats.\nThis can happen if:\n- You're not logged into Teams in your browser\n- The page hasn't fully loaded (Teams is slow)\n\nTry: teams --refresh\nOr:  bridge https://teams.microsoft.com/v2/ --dom --wait 15000`);
      }

      const lines = [`=== TEAMS CHATS === (${chats.length} conversations)`, ""];
      chats.forEach((c, i) => {
        const unread = c.unread ? "*" : " ";
        const name = c.name.padEnd(30).slice(0, 30);
        lines.push(`${unread}${String(i + 1).padStart(3)}  ${name}  ${c.lastMessage.slice(0, 50)}`);
        if (c.time) lines.push(`${"".padEnd(6)} ${c.time}`);
      });
      lines.push("", `Use: teams --refresh | teams channels`);
      return ok(lines.join("\n"));
    }

    if (sub === "channels") {
      emitEvent("cli", "Fetching Teams channels via bridge...", "info", { metadata: { command: "teams" } });
      const result = await smartFetch("https://teams.microsoft.com/v2/", "dom", "cli-teams-ch", {
        maxText: 30000,
      }, 90000);
      if (result.error) return fail(`[teams] channels: ${result.error}`);
      const text = result.text || "";
      const html = typeof result.body === "string" ? result.body : "";
      const channels = parseTeamsChannels(html || text, text);

      if (channels.length === 0) {
        return ok(`=== TEAMS CHANNELS ===\n\nPage loaded (${text.length} chars) but could not parse channels.\nTry: bridge https://teams.microsoft.com/v2/ --dom --wait 15000`);
      }

      const lines = [`=== TEAMS CHANNELS === (${channels.length} channels)`, ""];
      channels.forEach((ch, i) => {
        const team = ch.team ? `[${ch.team}]` : "";
        lines.push(`  ${String(i + 1).padStart(3)}  ${ch.name.padEnd(25).slice(0, 25)} ${team}`);
      });
      return ok(lines.join("\n"));
    }

    return fail(`[teams] unknown subcommand "${sub}"\nUsage: teams [chats|channels] [--refresh]`);
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

  registerCommand("snow", "ServiceNow command center", "snow [incidents|changes|requests|detail <number>|queue|refresh]", async (args) => {
    const { isExtensionConnected } = await import("./bridge-queue");
    if (!isExtensionConnected()) {
      return fail("[snow] Chrome extension bridge not connected. ServiceNow requires your real browser session.\nRun: bridge-status");
    }

    const instanceConfig = await storage.getAgentConfig("snow_instance");
    const instanceUrl = instanceConfig?.value || "";
    if (!instanceUrl) {
      return fail("[snow] No ServiceNow instance configured.\nUsage: config set snow_instance https://yourinstance.service-now.com");
    }
    const baseUrl = instanceUrl.replace(/\/+$/, "");

    const sub = args[0] || "incidents";
    const refresh = args.includes("--refresh");
    const nl = String.fromCharCode(10);

    const snowProfile = await storage.getSiteProfileByName("servicenow");
    if (!snowProfile) {
      return fail("[snow] ServiceNow site profile not found. Run seed or restart server.");
    }

    const updatedProfile = { ...snowProfile, baseUrl };
    const allNavPaths = await storage.getNavigationPaths(snowProfile.id);

    const navPathMap: Record<string, typeof allNavPaths[0] | undefined> = {};
    for (const np of allNavPaths) {
      navPathMap[np.name] = np;
    }

    async function scrapeSnowNavPath(pathName: string, recordType: "incident" | "change" | "request", source: "personal" | "team" = "personal"): Promise<CachedSnowRecord[]> {
      const navPath = navPathMap[pathName];
      if (!navPath) {
        emitEvent("cli", `[snow] Navigation path "${pathName}" not found`, "warn", { metadata: { command: "snow" } });
        return [];
      }
      emitEvent("cli", `Scraping ServiceNow ${recordType}s via nav path: ${pathName}`, "info", { metadata: { command: "snow" } });
      try {
        const scrapeResult = await executeNavigationPath(updatedProfile, navPath);
        const text = scrapeResult.content?.text || "";
        const extractedText = Object.values(scrapeResult.extractedData).join("\n");
        const allText = `${text}\n${extractedText}`;
        return parseSnowListFromText(allText, recordType, baseUrl, source);
      } catch (e: any) {
        emitEvent("cli", `[snow] Nav path scrape failed: ${e.message}`, "warn", { metadata: { command: "snow" } });
        return [];
      }
    }

    async function persistSnowResults(records: CachedSnowRecord[], label: string): Promise<void> {
      try {
        const summary = `SNOW ${label}: ${records.length} records scraped`;
        const rawOutput = JSON.stringify(records);
        await storage.createAgentResult({
          programName: "snow-scraper",
          summary,
          rawOutput,
          status: "ok",
        });
      } catch (e: any) {
        console.error(`[snow] Failed to persist results: ${e.message}`);
      }
    }

    if (sub === "incidents" || sub === "inc") {
      const cached = snowCache;
      if (cached && !refresh) {
        const incidents = cached.records.filter(r => r.type === "incident");
        if (incidents.length > 0) {
          const age = Math.round((Date.now() - cached.fetchedAt) / 1000);
          return ok(formatSnowList("INCIDENTS", incidents, age));
        }
      }
      const records = await scrapeSnowNavPath("list-my-incidents", "incident");
      mergeSnowCache(records, "incident");
      if (records.length > 0) await persistSnowResults(records, "incidents");
      if (records.length === 0) return ok(`=== SNOW INCIDENTS ===${nl}${nl}No incidents found or could not parse. Try: snow refresh`);
      return ok(formatSnowList("INCIDENTS", records));
    }

    if (sub === "changes" || sub === "chg") {
      const cached = snowCache;
      if (cached && !refresh) {
        const changes = cached.records.filter(r => r.type === "change");
        if (changes.length > 0) {
          const age = Math.round((Date.now() - cached.fetchedAt) / 1000);
          return ok(formatSnowList("CHANGE REQUESTS", changes, age));
        }
      }
      const records = await scrapeSnowNavPath("list-my-changes", "change");
      mergeSnowCache(records, "change");
      if (records.length > 0) await persistSnowResults(records, "changes");
      if (records.length === 0) return ok(`=== SNOW CHANGES ===${nl}${nl}No change requests found or could not parse. Try: snow refresh`);
      return ok(formatSnowList("CHANGE REQUESTS", records));
    }

    if (sub === "requests" || sub === "req") {
      const cached = snowCache;
      if (cached && !refresh) {
        const requests = cached.records.filter(r => r.type === "request");
        if (requests.length > 0) {
          const age = Math.round((Date.now() - cached.fetchedAt) / 1000);
          return ok(formatSnowList("SERVICE REQUESTS", requests, age));
        }
      }
      const records = await scrapeSnowNavPath("list-my-requests", "request");
      mergeSnowCache(records, "request");
      if (records.length > 0) await persistSnowResults(records, "requests");
      if (records.length === 0) return ok(`=== SNOW REQUESTS ===${nl}${nl}No requests found or could not parse. Try: snow refresh`);
      return ok(formatSnowList("SERVICE REQUESTS", records));
    }

    if (sub === "detail") {
      const recordNumber = args[1];
      if (!recordNumber) return fail("[snow] Usage: snow detail INC0012345");
      const cached = snowCache;
      const cachedRecord = cached?.records.find(r => r.number.toLowerCase() === recordNumber.toLowerCase());
      let tableName = "incident";
      if (/^CHG/i.test(recordNumber)) tableName = "change_request";
      else if (/^REQ|^RITM/i.test(recordNumber)) tableName = "sc_req_item";
      const detailUrl = `${baseUrl}/nav_to.do?uri=${tableName}.do?sysparm_query=number=${recordNumber}`;

      const detailNavPath = navPathMap["view-record-detail"];
      emitEvent("cli", `Opening ServiceNow record: ${recordNumber}`, "info", { metadata: { command: "snow detail" } });

      let detailText = "";
      if (detailNavPath) {
        try {
          const scrapeResult = await executeNavigationPath(updatedProfile, detailNavPath, undefined, detailUrl);
          detailText = scrapeResult.content?.text || "";
          const extractedVals = Object.values(scrapeResult.extractedData).filter(v => v);
          if (extractedVals.length > 0 && !detailText) detailText = extractedVals.join("\n");
        } catch (e: any) {
          emitEvent("cli", `[snow] detail nav path failed: ${e.message}`, "warn");
        }
      }

      if (!detailText) {
        const { smartFetch } = await import("./bridge-queue");
        const result = await smartFetch(detailUrl, "dom", "cli-snow-detail", {
          maxText: 40000,
          selectors: { fields: '.form-group, .label_spacing, td.label' },
        }, 60000);
        if (result.error) return fail(`[snow] detail: ${result.error}`);
        detailText = result.text || "";
      }

      const lines = [`=== ${recordNumber} ===`, ""];
      if (cachedRecord) {
        lines.push(`Short Description: ${cachedRecord.shortDescription}`);
        lines.push(`State: ${cachedRecord.state}`);
        lines.push(`Priority: ${cachedRecord.priority}`);
        lines.push(`Assigned To: ${cachedRecord.assignedTo}`);
        lines.push(`Group: ${cachedRecord.assignmentGroup}`);
        lines.push(`Updated: ${cachedRecord.updatedOn}`);
        lines.push("");
      }
      lines.push("--- Page Content ---", "");
      lines.push(detailText.slice(0, 5000));
      lines.push("", `Open in browser: ${detailUrl}`);
      return ok(lines.join(nl));
    }

    if (sub === "queue") {
      const cached = snowCache;
      if (cached && !refresh) {
        const groupItems = cached.records.filter(r => r.assignmentGroup);
        if (groupItems.length > 0) {
          const age = Math.round((Date.now() - cached.fetchedAt) / 1000);
          const groups = new Map<string, CachedSnowRecord[]>();
          for (const r of groupItems) {
            const g = r.assignmentGroup || "Unassigned";
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g)!.push(r);
          }
          const lines = [`=== SNOW GROUP QUEUE === (cached ${age}s ago)`, ""];
          Array.from(groups.entries()).forEach(([group, items]) => {
            lines.push(`  ${group} (${items.length})`);
            items.slice(0, 5).forEach(item => {
              lines.push(`    ${item.number.padEnd(15)} ${item.assignedTo.padEnd(20).slice(0, 20)} ${item.shortDescription.slice(0, 40)} [${item.state}]`);
            });
          });
          return ok(lines.join(nl));
        }
      }
      const records = await scrapeSnowNavPath("list-group-queue", "incident", "team");
      mergeSnowCache(records, "incident", "team");
      if (records.length > 0) await persistSnowResults(records, "group-queue");
      if (records.length === 0) return ok(`=== SNOW QUEUE ===${nl}${nl}No group queue items found.`);
      const groups = new Map<string, CachedSnowRecord[]>();
      for (const r of records) {
        const g = r.assignmentGroup || "Unassigned";
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g)!.push(r);
      }
      const lines = [`=== SNOW GROUP QUEUE === (${records.length} items)`, ""];
      Array.from(groups.entries()).forEach(([group, items]) => {
        lines.push(`  ${group} (${items.length})`);
        items.slice(0, 5).forEach(item => {
          lines.push(`    ${item.number.padEnd(15)} ${item.assignedTo.padEnd(20).slice(0, 20)} ${item.shortDescription.slice(0, 40)} [${item.state}]`);
        });
      });
      return ok(lines.join(nl));
    }

    if (sub === "refresh") {
      emitEvent("cli", "Refreshing all ServiceNow data...", "info", { metadata: { command: "snow refresh" } });
      const [incidents, changes, requests, queueItems] = await Promise.all([
        scrapeSnowNavPath("list-my-incidents", "incident", "personal"),
        scrapeSnowNavPath("list-my-changes", "change", "personal"),
        scrapeSnowNavPath("list-my-requests", "request", "personal"),
        scrapeSnowNavPath("list-group-queue", "incident", "team"),
      ]);
      const personalRecords = [...incidents, ...changes, ...requests];
      const teamDeduped = queueItems.filter(qr => !personalRecords.some(pr => pr.number === qr.number));
      const allRecords = [...personalRecords, ...teamDeduped];
      snowCache = { records: allRecords, fetchedAt: Date.now() };
      await persistSnowResults(allRecords, "refresh");
      const lines = [
        `=== SNOW REFRESH COMPLETE ===`, "",
        `  My Incidents: ${incidents.length}`,
        `  My Changes:   ${changes.length}`,
        `  My Requests:  ${requests.length}`,
        `  Team Queue:   ${teamDeduped.length}`,
        `  Total:        ${allRecords.length}`,
        "",
        "Use: snow incidents | snow changes | snow requests | snow queue",
      ];
      return ok(lines.join(nl));
    }

    return fail(`[snow] unknown subcommand "${sub}"${nl}Usage: snow [incidents|changes|requests|detail <number>|queue|refresh]`);
  });

  registerCommand("citrix", "Scrape Citrix workspace portal apps", "citrix [--save] | citrix clean", async (args) => {
    const CITRIX_JUNK_SET = new Set(["open", "restart", "request", "cancel request", "add to favorites", "remove from favorites", "install", "more", "less", "cancel", "save", "refresh"]);
    const CITRIX_CAT_HEADER_RE = /^\[App\]\s*(Epic Non-Production|Epic Production|Epic Training|Epic Utilities|MyChart|Troubleshooting|Uncategorized)\s*\(\d+\)$/i;

    if (args[0] === "launch") {
      const appName = args.slice(1).join(" ").trim();
      if (!appName) return fail("[citrix] Usage: citrix launch <app name>");
      const { smartFetch, isExtensionConnected } = await import("./bridge-queue");
      if (!isExtensionConnected()) {
        return fail("[citrix] Bridge not connected. Cannot launch Citrix apps without browser session.");
      }
      emitEvent("cli", `Launching Citrix app: ${appName}`, "info", { metadata: { command: "citrix" } });
      const launchResult = await smartFetch("https://cwp.ucsd.edu", "dom", "cli-citrix-launch", {
        maxText: 2000,
        reuseTab: true,
        spaWaitMs: 2000,
        citrixApiLaunch: appName,
        autoOpenDownload: true,
        pollTimeoutMs: 15000,
      }, 60000);
      if (launchResult.error) return fail(`[citrix launch] ${launchResult.error}`);
      const cd = (launchResult as any).clickDebug;
      if (cd) {
        emitEvent("cli", `Citrix launch debug: ${JSON.stringify(cd).substring(0, 500)}`, "info", { metadata: { command: "citrix" } });
      }
      if (cd?.error) return fail(`[citrix launch] ${cd.error}`);
      const method = cd?.method || "unknown";
      const matched = cd?.matchedApp || appName;
      return ok(`Launched "${matched}" via Citrix [${method}]`);
    }

    if (args[0] === "workspace") {
      const nl = String.fromCharCode(10);
      const configKey = "citrix_workspace_apps";
      const DESKTOP_PATH = "C:/Users/mjensen/OneDrive - University of California, San Diego Health/Desktop";
      const DEFAULT_WORKSPACE_APPS = ["SUP Hyperdrive", "POC Hyperdrive", "TST Hyperdrive", "SUP Text Access", "POC Text Access", "TST Text Access"];
      let raw: string | null = null;
      try {
        const cfg = await storage.getAgentConfig(configKey);
        raw = cfg?.value || null;
      } catch {}
      if (!raw) {
        raw = JSON.stringify(DEFAULT_WORKSPACE_APPS);
      }
      if (args[1] === "set") {
        const appList = args.slice(2).join(" ").split(",").map(s => s.trim()).filter(Boolean);
        if (!appList.length) return fail("[citrix] Usage: citrix workspace set App1, App2, App3");
        await storage.setAgentConfig(configKey, JSON.stringify(appList), "citrix");
        return ok(`Workspace apps set: ${appList.join(", ")}`);
      }
      if (args[1] === "list") {
        const apps = raw ? JSON.parse(raw) : [];
        if (!apps.length) return ok(`No workspace apps configured.${nl}Use: citrix workspace set App1, App2, App3`);
        return ok(`Workspace apps:${nl}${apps.map((a: string, i: number) => `  ${i + 1}. ${a}`).join(nl)}`);
      }
      const apps: string[] = raw ? JSON.parse(raw) : [];
      if (!apps.length) {
        return fail(`[citrix] No workspace apps configured.${nl}Use: citrix workspace set SUP Text Access, PRD Hyperspace${nl}Then: citrix workspace`);
      }
      const { isExtensionConnected, submitJob } = await import("./bridge-queue");
      if (!isExtensionConnected()) {
        return fail("[citrix] Bridge not connected.");
      }
      const results: string[] = [];
      for (const appName of apps) {
        try {
          submitJob("dom", "https://cwp.ucsd.edu", "cli-citrix-workspace", {
            maxText: 2000,
            reuseTab: true,
            spaWaitMs: 2000,
            citrixApiLaunch: appName,
            autoOpenDownload: true,
            pollTimeoutMs: 15000,
          });
          results.push(`  [+] ${appName}: queued`);
        } catch (e: any) {
          results.push(`  [-] ${appName}: ${e.message}`);
        }
      }
      return ok(`Workspace: ${apps.length} apps queued${nl}${results.join(nl)}`);
    }

    if (args[0] === "keepalive") {
      const nl = String.fromCharCode(10);
      if (args[1] === "on") {
        await storage.setAgentConfig("citrix_keepalive", "true", "citrix");
        return ok(`Citrix keepalive enabled. Portal pinged every 10 minutes to prevent idle timeout.`);
      }
      if (args[1] === "off") {
        await storage.setAgentConfig("citrix_keepalive", "false", "citrix");
        return ok("Citrix keepalive disabled.");
      }
      const cfg = await storage.getAgentConfig("citrix_keepalive");
      return ok(`Citrix keepalive is ${cfg?.value === "true" ? "ON" : "OFF"}.${nl}Usage: citrix keepalive on|off`);
    }

    if (args[0] === "clean") {
      const allNotes = await storage.getNotes();
      const toDelete = allNotes.filter(n => {
        if (!n.tags?.includes("apps")) return false;
        const name = n.title.replace(/^\[App\]\s*/i, "").trim().toLowerCase();
        if (CITRIX_JUNK_SET.has(name)) return true;
        if (CITRIX_CAT_HEADER_RE.test(n.title)) return true;
        return false;
      });
      for (const n of toDelete) {
        await storage.deleteNote(n.id);
      }
      return ok(`Cleaned ${toDelete.length} junk/category items from APPS`);
    }

    const { smartFetch, isExtensionConnected } = await import("./bridge-queue");
    if (!isExtensionConnected()) {
      return fail("[citrix] Chrome extension bridge not connected. Citrix requires your real browser session.");
    }
    const save = args.includes("--save");
    emitEvent("cli", "Scraping Citrix workspace portal via bridge...", "info", { metadata: { command: "citrix" } });

    const result = await smartFetch("https://cwp.ucsd.edu", "dom", "cli-citrix", {
      maxText: 60000,
      selectors: {
        apps: '[class*="app"] a, [class*="App"] a, [data-testid*="app"] a, .storeapp-icon a, .store-app a, a[href*="launch"], a[href*="app"], [class*="resource"] a, [role="listitem"] a, .citrix-resource a, button[class*="app"], [class*="appCard"] a, [class*="tile"] a, a[class*="launch"], [class*="StoreApp"] a',
        allLinks: 'a[href]',
        headings: 'h1, h2, h3, h4, [class*="title"], [class*="Title"], [class*="name"], [class*="Name"]',
      },
    }, 60000);

    if (result.error) return fail(`[citrix] ${result.error}`);
    const text = result.text || "";
    const extracted = (result as any).extracted || {};
    const debug = (result as any).debug || {};
    const finalUrl = (result as any).url || "?";
    const title = (result as any).title || "?";

    interface AppLink { name: string; href: string }
    const apps: AppLink[] = [];
    const seen = new Set<string>();

    const CITRIX_JUNK = new Set(["open", "restart", "request", "cancel request", "add to favorites", "remove from favorites", "install", "more", "less", "cancel", "save", "refresh"]);
    const CITRIX_CAT_RE = /^(Epic Non-Production|Epic Production|Epic Training|Epic Utilities|MyChart|Troubleshooting|Uncategorized)\s*\(\d+\)$/i;

    const addApp = (name: string, href: string) => {
      const clean = cleanUnicode(name).trim();
      if (!clean || clean.length < 2 || clean.length > 100) return;
      if (CITRIX_JUNK.has(clean.toLowerCase())) return;
      if (CITRIX_CAT_RE.test(clean)) return;
      if (seen.has(clean.toLowerCase())) return;
      seen.add(clean.toLowerCase());
      apps.push({ name: clean, href: href || "" });
    };

    if (extracted.apps && extracted.apps.length > 0) {
      for (const a of extracted.apps) {
        addApp(a.text || "", a.href || "");
      }
    }

    if (apps.length === 0 && extracted.allLinks) {
      for (const link of extracted.allLinks) {
        const t = (link.text || "").trim();
        const h = link.href || "";
        if (t.length >= 2 && t.length <= 80 && !isNavNoise(t)) {
          if (h.includes("launch") || h.includes("app") || h.includes("resource") || h.includes("citrix")) {
            addApp(t, h);
          }
        }
      }
    }

    if (apps.length === 0 && extracted.allLinks) {
      for (const link of extracted.allLinks) {
        const t = (link.text || "").trim();
        if (t.length >= 3 && t.length <= 80 && !isNavNoise(t) && !/^(sign|log|home|back|help|privacy|terms|copyright|cookie)/i.test(t)) {
          addApp(t, link.href || "");
        }
      }
    }

    const nl = String.fromCharCode(10);
    if (apps.length === 0) {
      const sampleText = text.slice(0, 1500).split(/[\n\r]+/).filter(l => l.trim().length > 0).slice(0, 15).join(nl);
      const linkCount = extracted.allLinks?.length || 0;
      const headingsSample = (extracted.headings || []).slice(0, 10).map((h: any) => `  ${(h.text || "").trim().slice(0, 80)}`).join(nl);
      return ok([
        `=== CITRIX PORTAL ===`,
        `Final URL: ${finalUrl}`,
        `Page title: ${title}`,
        `Text: ${text.length} chars, Links: ${linkCount}, iframes: ${debug.iframeCount ?? "?"}`,
        "",
        "--- Headings ---",
        headingsSample || "(none)",
        "",
        "--- Sample text ---",
        sampleText || "(empty page)",
        "",
        "Could not auto-detect apps. Try: citrix --save  to save raw links to KB",
      ].join(nl));
    }

    const lines = [`=== CITRIX APPS === (${apps.length} applications)`, ""];
    apps.forEach((a, i) => {
      const link = a.href ? ` -> ${a.href}` : "";
      lines.push(`  ${String(i + 1).padStart(3)}  ${a.name}${link}`);
    });

    if (save) {
      const existingNotes = await storage.getNotes();
      const existingAppTitles = new Set(
        existingNotes.filter(n => n.tags?.includes("apps")).map(n => n.title)
      );

      let created = 0;
      for (const a of apps) {
        const title = `[App] ${a.name}`;
        if (existingAppTitles.has(title)) continue;
        const body = a.href
          ? `[${a.name}](${a.href})`
          : a.name;
        await storage.createNote({
          title,
          body,
          tags: ["apps", "citrix", "ucsd"],
        });
        created++;
      }
      lines.push("", `Saved ${created} new app(s) to APPS section (${apps.length - created} already existed)`);
    } else {
      lines.push("", "Use: citrix --save  to save to APPS section in TreeView");
    }

    return ok(lines.join(nl));
  });

  registerCommand("epic", "Epic Hyperspace activity tools", "epic [activities|navigate|screenshot|click|status|setup|scan|clear] <env> [target]", async (args) => {
    const nl = String.fromCharCode(10);
    if (args[0] === "activities") {
      const env = (args[1] || "SUP").toUpperCase();
      const key = `epic_activities_${env.toLowerCase()}`;
      const cfg = await storage.getAgentConfig(key);
      let acts: any[] = [];
      if (cfg?.value) {
        try { acts = JSON.parse(cfg.value); } catch {}
      }
      if (!acts.length) return ok(`No activities cataloged for ${env}.${nl}Run: python tools/epic_scan.py ${env}  on your desktop`);
      const cats = new Map<string, string[]>();
      for (const a of acts) {
        const cat = a.parent || a.category || "General";
        if (!cats.has(cat)) cats.set(cat, []);
        cats.get(cat)!.push(a.name);
      }
      const lines = [`=== EPIC ${env} ACTIVITIES === (${acts.length} total)`, ""];
      for (const [cat, items] of cats) {
        lines.push(`  ${cat} (${items.length})`);
        for (const name of items.slice(0, 10)) {
          lines.push(`    - ${name}`);
        }
        if (items.length > 10) lines.push(`    ... and ${items.length - 10} more`);
      }
      return ok(lines.join(nl));
    }
    if (args[0] === "clear") {
      const env = (args[1] || "SUP").toUpperCase();
      const key = `epic_activities_${env.toLowerCase()}`;
      await storage.setAgentConfig(key, "[]", "epic");
      return ok(`Cleared activities for ${env}`);
    }
    if (args[0] === "scan") {
      return ok([
        "Epic Hyperspace Activity Scanner",
        "================================",
        "Run on your Windows desktop:",
        "",
        "  1. pip install pyautogui pillow requests pygetwindow",
        "  2. set OPENROUTER_API_KEY=your-key",
        "  3. python epic_scan.py SUP",
        "",
        "The script will:",
        "  - Find your Hyperspace window",
        "  - Screenshot menus and buttons",
        "  - Use Claude vision to identify activities",
        "  - Post results to OrgCloud TreeView",
        "",
        "Environments: SUP, POC, TST",
      ].join(nl));
    }
    if (args[0] === "navigate") {
      const env = (args[1] || "SUP").toUpperCase();
      const target = args.slice(2).join(" ");
      if (!target) return fail("[epic] Usage: epic navigate SUP Patient Lookup");
      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "navigate", env, target }),
        });
        const data = await resp.json() as any;
        if (data.ok) {
          return ok(`Navigation command sent: ${env} -> ${target}${nl}Command ID: ${data.commandId}${nl}Desktop agent will execute when ready.`);
        }
        return fail(`[epic] Failed to send command`);
      } catch (e: any) {
        return fail(`[epic] ${e.message}`);
      }
    }
    if (args[0] === "screenshot") {
      const env = (args[1] || "SUP").toUpperCase();
      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "screenshot", env }),
        });
        const data = await resp.json() as any;
        if (data.ok) return ok(`Screenshot requested for ${env}. ID: ${data.commandId}`);
        return fail(`[epic] Failed to send command`);
      } catch (e: any) {
        return fail(`[epic] ${e.message}`);
      }
    }
    if (args[0] === "click") {
      const env = (args[1] || "SUP").toUpperCase();
      const target = args.slice(2).join(" ");
      if (!target) return fail("[epic] Usage: epic click SUP Orders");
      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "click", env, target }),
        });
        const data = await resp.json() as any;
        if (data.ok) return ok(`Click command sent: ${target} in ${env}. ID: ${data.commandId}`);
        return fail(`[epic] Failed to send command`);
      } catch (e: any) {
        return fail(`[epic] ${e.message}`);
      }
    }
    if (args[0] === "status") {
      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/status`);
        const data = await resp.json() as any;
        if (data.connected) {
          return ok(`Epic Desktop Agent: CONNECTED${nl}Windows: ${(data.windows || []).join(", ") || "none"}${nl}Last seen: ${new Date(data.lastSeen).toLocaleTimeString()}`);
        }
        return ok(`Epic Desktop Agent: DISCONNECTED${nl}Run epic_agent.py on your desktop to connect.`);
      } catch (e: any) {
        return fail(`[epic] ${e.message}`);
      }
    }
    if (args[0] === "setup") {
      return ok([
        "Epic Desktop Agent Setup",
        "========================",
        "Download: /api/epic/agent-script",
        "",
        "  1. pip install pyautogui pillow requests pygetwindow",
        "  2. set OPENROUTER_API_KEY=your-key",
        "  3. set BRIDGE_TOKEN=your-bridge-token",
        "  4. python epic_agent.py",
        "",
        "The agent runs in background and:",
        "  - Polls OrgCloud for commands every 3s",
        "  - Takes screenshots on demand",
        "  - Navigates Hyperspace via Claude vision",
        "  - Clicks buttons/menus by name",
        "",
        "Commands:",
        "  epic navigate SUP Patient Lookup",
        "  epic screenshot SUP",
        "  epic click SUP Orders",
        "  epic status",
      ].join(nl));
    }
    if (args[0] === "tree") {
      const nl2 = nl;
      if (args[1] === "--refresh") {
        const env = (args[2] || "SUP").toUpperCase();
        try {
          const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "tree-scan", env }),
          });
          const data = await resp.json() as any;
          if (data.ok) return ok(`Tree re-scan requested for ${env}. Command ID: ${data.commandId}${nl2}Desktop agent will perform pywinauto scan.`);
          return fail(`[epic] Failed to send scan command`);
        } catch (e: any) {
          return fail(`[epic] ${e.message}`);
        }
      }
      const env = (args[1] || "SUP").toUpperCase();
      const trees: Record<string, any> = {};
      for (const client of ["hyperspace", "text"]) {
        const key = `epic_tree_${env.toLowerCase()}_${client}`;
        const cfg = await storage.getAgentConfig(key);
        if (cfg?.value) {
          try { trees[client] = JSON.parse(cfg.value); } catch {}
        }
      }
      if (Object.keys(trees).length === 0) {
        return ok(`No navigation tree stored for ${env}.${nl2}Run: python epic_tree.py hyperspace ${env}  on desktop`);
      }
      function printTree(node: any, indent: string, lines: string[]): void {
        for (const child of (node.children || [])) {
          const kids = (child.children || []).length;
          const suffix = kids > 0 ? ` (${kids})` : "";
          lines.push(`${indent}${child.name}${suffix}`);
          if (kids > 0) printTree(child, indent + "  ", lines);
        }
      }
      const lines: string[] = [`=== EPIC ${env} NAVIGATION TREE ===`, ""];
      for (const [client, tree] of Object.entries(trees)) {
        const label = client === "hyperspace" ? "Hyperspace" : "Text";
        lines.push(`[${label}] scanned ${(tree as any).scannedAt || "unknown"}`);
        printTree(tree, "  ", lines);
        lines.push("");
      }
      return ok(lines.join(nl2));
    }

    if (args[0] === "go") {
      const env = (args[1] || "SUP").toUpperCase();
      const target = args.slice(2).join(" ");
      if (!target) return fail("[epic] Usage: epic go SUP Patient Lookup");

      function fMatch(text: string, q: string): boolean {
        const lower = text.toLowerCase();
        const words = q.toLowerCase().split(/\s+/);
        return words.every(w => lower.includes(w));
      }

      function findInTree(node: any, query: string, client: string): { path: string; client: string; name: string } | null {
        for (const child of (node.children || [])) {
          if (fMatch(child.name || "", query)) {
            return { path: child.path || child.name, client, name: child.name };
          }
          const found = findInTree(child, query, client);
          if (found) return found;
        }
        return null;
      }

      let resolved: { path: string; client: string; name: string } | null = null;

      if (target.includes(">")) {
        const isTextPath = /^\d+\s/.test(target.split(">")[0].trim());
        resolved = { path: target, client: isTextPath ? "text" : "hyperspace", name: target };
      } else {
        for (const client of ["hyperspace", "text"]) {
          const key = `epic_tree_${env.toLowerCase()}_${client}`;
          const cfg = await storage.getAgentConfig(key);
          if (cfg?.value) {
            try {
              const tree = JSON.parse(cfg.value);
              const found = findInTree(tree, target, client);
              if (found) { resolved = found; break; }
            } catch {}
          }
        }
        if (!resolved) {
          const actKey = `epic_activities_${env.toLowerCase()}`;
          const actCfg = await storage.getAgentConfig(actKey);
          if (actCfg?.value) {
            try {
              const acts = JSON.parse(actCfg.value);
              const match = acts.find((a: any) => fMatch(a.name || "", target));
              if (match) resolved = { path: match.name, client: "hyperspace", name: match.name };
            } catch {}
          }
        }
      }

      if (!resolved) return fail(`[epic] No activity matching "${target}" found in ${env} tree. Run epic search ${target} to find it.`);

      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "navigate_path", env, path: resolved.path, client: resolved.client }),
        });
        const data = await resp.json() as any;
        if (data.ok) {
          const mode = resolved.client === "text" ? "keystrokes" : "UIA clicks";
          return ok(`Path navigation sent: ${env} (${resolved.client})${nl}Activity: ${resolved.name}${nl}Path: ${resolved.path}${nl}Mode: ${mode}${nl}Command ID: ${data.commandId}`);
        }
        return fail(`[epic] Failed to send command`);
      } catch (e: any) {
        return fail(`[epic] ${e.message}`);
      }
    }

    if (args[0] === "search") {
      const query = args.slice(1).join(" ");
      if (!query) return fail("[epic] Usage: epic search Patient Lookup");

      function fuzzyMatch(text: string, q: string): boolean {
        const lower = text.toLowerCase();
        const words = q.toLowerCase().split(/\s+/);
        return words.every(w => lower.includes(w));
      }

      function searchTree(node: any, results: any[], env: string, client: string): void {
        for (const child of (node.children || [])) {
          if (fuzzyMatch(child.name || "", query) || fuzzyMatch(child.path || "", query)) {
            results.push({
              name: child.name,
              path: child.path || child.name,
              env,
              client,
              controlType: child.controlType || "",
            });
          }
          searchTree(child, results, env, client);
        }
      }

      const allResults: any[] = [];
      for (const env of ["SUP", "POC", "TST"]) {
        for (const client of ["hyperspace", "text"]) {
          const key = `epic_tree_${env.toLowerCase()}_${client}`;
          const cfg = await storage.getAgentConfig(key);
          if (cfg?.value) {
            try {
              const tree = JSON.parse(cfg.value);
              searchTree(tree, allResults, env, client);
            } catch {}
          }
        }
        const actKey = `epic_activities_${env.toLowerCase()}`;
        const actCfg = await storage.getAgentConfig(actKey);
        if (actCfg?.value) {
          try {
            const acts = JSON.parse(actCfg.value);
            for (const a of acts) {
              if (fuzzyMatch(a.name || "", query)) {
                allResults.push({ name: a.name, path: a.name, env, client: "activity", controlType: a.type || "" });
              }
            }
          } catch {}
        }
      }

      if (allResults.length === 0) return ok(`No Epic items matching "${query}"`);

      const lines = [`=== EPIC SEARCH: "${query}" === (${allResults.length} results)`, ""];
      for (let i = 0; i < Math.min(allResults.length, 30); i++) {
        const r = allResults[i];
        const clientLabel = r.client === "hyperspace" ? "HS" : r.client === "text" ? "TXT" : "ACT";
        lines.push(`  ${String(i + 1).padStart(3)}. [${r.env}/${clientLabel}] ${r.name}`);
        if (r.path !== r.name) lines.push(`       Path: ${r.path}`);
      }
      if (allResults.length > 30) lines.push(`  ... and ${allResults.length - 30} more`);
      lines.push("", "Use: epic go <env> <path> to navigate");
      return ok(lines.join(nl));
    }

    if (args[0] === "mf") {
      const masterfile = args[1];
      const item = args.slice(2).join(" ");
      if (!masterfile) return fail("[epic] Usage: epic mf EMP John Smith");
      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "masterfile", masterfile: masterfile.toUpperCase(), item: item || "" }),
        });
        const data = await resp.json() as any;
        if (data.ok) {
          const detail = item ? ` -> ${item}` : "";
          return ok(`Masterfile lookup sent: ${masterfile.toUpperCase()}${detail}${nl}Command ID: ${data.commandId}${nl}Desktop agent will send keystrokes to Epic Text.`);
        }
        return fail(`[epic] Failed to send command`);
      } catch (e: any) {
        return fail(`[epic] ${e.message}`);
      }
    }

    return ok([
      "Epic commands:",
      "  epic activities <env>     - Show cataloged activities",
      "  epic tree <env>           - Show full navigation tree",
      "  epic tree --refresh <env> - Re-scan tree via desktop agent",
      "  epic go <env> <path>      - Navigate using stored path",
      "  epic search <query>       - Search across all activities",
      "  epic mf <masterfile> [item] - Text masterfile lookup",
      "  epic navigate <env> <target> - Navigate Hyperspace (vision)",
      "  epic screenshot <env>     - Capture current screen",
      "  epic click <env> <el>     - Click an element by name",
      "  epic status               - Desktop agent status",
      "  epic clear <env>          - Clear activities",
      "  epic scan                 - One-time activity scan guide",
      "  epic setup                - Desktop agent setup guide",
    ].join(nl));
  });

  registerCommand("pulse", "Pulse intranet link directory", "pulse [scan|search <query>|list [category]|open <name or #>|categories]", async (args) => {
    const nl = String.fromCharCode(10);

    interface PulseLink {
      name: string;
      url: string;
      category: string;
      subcategory: string;
      description: string;
    }

    async function getPulseLinks(): Promise<PulseLink[]> {
      const cfg = await storage.getAgentConfig("pulse_links");
      if (!cfg?.value) return [];
      try { return JSON.parse(cfg.value); } catch { return []; }
    }

    async function savePulseLinks(links: PulseLink[]): Promise<void> {
      await storage.setAgentConfig("pulse_links", JSON.stringify(links), "pulse");
    }

    async function getLastPulseResults(): Promise<PulseLink[]> {
      const cfg = await storage.getAgentConfig("pulse_last_results");
      if (!cfg?.value) return [];
      try { return JSON.parse(cfg.value); } catch { return []; }
    }

    async function saveLastPulseResults(links: PulseLink[]): Promise<void> {
      await storage.setAgentConfig("pulse_last_results", JSON.stringify(links), "pulse");
    }

    function fuzzyMatch(text: string, query: string): boolean {
      const lower = text.toLowerCase();
      const q = query.toLowerCase();
      const words = q.split(/\s+/);
      return words.every(w => lower.includes(w));
    }

    if (!args[0] || args[0] === "help") {
      return ok([
        "Pulse Intranet Directory",
        "========================",
        "  pulse scan              - Scrape Pulse homepage + nav links",
        "  pulse search <query>    - Fuzzy search links by name/category/URL",
        "  pulse list [category]   - List all links or filter by category",
        "  pulse open <name or #>  - Open a link (by name or search result #)",
        "  pulse categories        - List all categories",
        "  pulse clear             - Clear stored links",
      ].join(nl));
    }

    if (args[0] === "scan") {
      const { smartFetch, isExtensionConnected } = await import("./bridge-queue");
      if (!isExtensionConnected()) {
        return fail("[pulse] Chrome extension bridge not connected. Connect extension first.");
      }

      const seenUrls = new Set<string>();
      const allLinks: PulseLink[] = [];
      const pagesToScan: { url: string; depth: number }[] = [{ url: "https://pulse.ucsd.edu", depth: 0 }];
      const scannedPages = new Set<string>();
      const maxDepth = 1;
      const maxPages = 20;
      let pagesScanned = 0;

      while (pagesToScan.length > 0 && pagesScanned < maxPages) {
        const page = pagesToScan.shift()!;
        if (scannedPages.has(page.url)) continue;
        scannedPages.add(page.url);
        pagesScanned++;

        try {
          const result = await smartFetch(page.url, "dom", "cli-pulse-scan", {
            maxText: 50000,
            includeHtml: true,
            maxHtml: 100000,
          }, 30000);

          const html = result.html || result.body || "";
          const text = result.text || "";
          const htmlStr = typeof html === "string" ? html : JSON.stringify(html);

          let currentCategory = page.depth === 0 ? "General" : "General";
          const urlObj = new URL(page.url);

          const pathParts = urlObj.pathname.split("/").filter(Boolean);
          if (pathParts.length > 0) {
            currentCategory = decodeURIComponent(pathParts[0])
              .replace(/[-_]/g, " ")
              .replace(/\b\w/g, c => c.toUpperCase());
          }

          const headingPattern = /<h[1-4][^>]*>(.*?)<\/h[1-4]>/gi;
          const headings: { text: string; pos: number }[] = [];
          let hMatch;
          while ((hMatch = headingPattern.exec(htmlStr)) !== null) {
            const hText = hMatch[1].replace(/<[^>]+>/g, "").trim();
            if (hText.length > 1 && hText.length < 100) {
              headings.push({ text: hText, pos: hMatch.index });
            }
          }

          const linkPattern = /<a\s[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
          let lMatch;
          while ((lMatch = linkPattern.exec(htmlStr)) !== null) {
            let href = lMatch[1].trim();
            const linkText = lMatch[2].replace(/<[^>]+>/g, "").trim();

            if (!linkText || linkText.length < 2 || linkText.length > 200) continue;
            if (/^(skip|back to top|close|cancel|sign out|log out|#)$/i.test(linkText)) continue;
            if (href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) continue;

            if (href.startsWith("/")) {
              href = `${urlObj.protocol}//${urlObj.host}${href}`;
            } else if (!href.startsWith("http")) {
              continue;
            }

            if (seenUrls.has(href)) continue;
            seenUrls.add(href);

            let linkCategory = currentCategory;
            if (page.depth === 0) {
              for (let h = headings.length - 1; h >= 0; h--) {
                if (headings[h].pos < lMatch.index) {
                  linkCategory = headings[h].text;
                  break;
                }
              }
            }

            const descMatch = htmlStr.substring(lMatch.index, lMatch.index + 500).match(/title=["']([^"']+)["']/i);
            const description = descMatch ? descMatch[1].trim() : "";

            let subcategory = "";
            const listItemMatch = htmlStr.substring(Math.max(0, lMatch.index - 200), lMatch.index).match(/<li[^>]*class=["']([^"']+)["']/i);
            if (listItemMatch) {
              subcategory = listItemMatch[1].replace(/[-_]/g, " ").trim();
            }

            try {
              const linkHost = new URL(href).hostname.toLowerCase();
              const isInternal = linkHost.includes("ucsd.edu") || linkHost.includes("uchealth") || linkHost.includes("ucsd");
              if (!isInternal && !linkHost.includes("sharepoint") && !linkHost.includes("microsoft")) continue;
            } catch { continue; }

            allLinks.push({
              name: linkText,
              url: href,
              category: linkCategory.slice(0, 60),
              subcategory: subcategory.slice(0, 60),
              description: description.slice(0, 200),
            });

            if (page.depth < maxDepth) {
              try {
                const linkHost = new URL(href).hostname.toLowerCase();
                if (linkHost === "pulse.ucsd.edu" && !scannedPages.has(href)) {
                  pagesToScan.push({ url: href, depth: page.depth + 1 });
                }
              } catch {}
            }
          }

          if (page.depth < maxDepth && pagesScanned < maxPages) {
            const navLinkPattern = /<nav[^>]*>([\s\S]*?)<\/nav>/gi;
            let navMatch;
            while ((navMatch = navLinkPattern.exec(htmlStr)) !== null) {
              const navHtml = navMatch[1];
              const navLinks = navHtml.matchAll(/<a\s[^>]*href=["']([^"']+)["']/gi);
              for (const nl2 of navLinks) {
                let navHref = nl2[1].trim();
                if (navHref.startsWith("/")) navHref = `${urlObj.protocol}//${urlObj.host}${navHref}`;
                if (navHref.startsWith("http") && !scannedPages.has(navHref)) {
                  try {
                    const navHost = new URL(navHref).hostname.toLowerCase();
                    if (navHost === "pulse.ucsd.edu") {
                      pagesToScan.push({ url: navHref, depth: page.depth + 1 });
                    }
                  } catch {}
                }
              }
            }
          }

        } catch (e: any) {
          // fall through to delay
        }

        if (pagesScanned < maxPages && pagesToScan.length > 0) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      const existing = await getPulseLinks();
      const mergedMap = new Map<string, PulseLink>();
      for (const l of existing) mergedMap.set(l.url, l);
      for (const l of allLinks) mergedMap.set(l.url, l);
      const merged = Array.from(mergedMap.values());
      await savePulseLinks(merged);

      const cats = new Map<string, number>();
      for (const l of merged) {
        cats.set(l.category, (cats.get(l.category) || 0) + 1);
      }

      const lines = [
        `Pulse scan complete: ${allLinks.length} new links found, ${merged.length} total`,
        `Pages scanned: ${pagesScanned}`,
        "",
        "Categories:",
      ];
      for (const [cat, count] of Array.from(cats.entries()).sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${cat} (${count})`);
      }
      lines.push("", "Use: pulse list | pulse search <query>");
      return ok(lines.join(nl));
    }

    if (args[0] === "search") {
      const query = args.slice(1).join(" ");
      if (!query) return fail("[pulse] Usage: pulse search <query>");
      const links = await getPulseLinks();
      const matches = links.filter(l =>
        fuzzyMatch(l.name, query) || fuzzyMatch(l.category, query) || fuzzyMatch(l.url, query) || fuzzyMatch(l.description, query)
      );
      if (matches.length === 0) return ok(`No Pulse links matching "${query}"`);

      await saveLastPulseResults(matches.slice(0, 30));

      const lines = [`=== PULSE SEARCH: "${query}" === (${matches.length} results)`, ""];
      for (let i = 0; i < Math.min(matches.length, 30); i++) {
        const m = matches[i];
        lines.push(`  ${String(i + 1).padStart(3)}. ${m.name}`);
        lines.push(`       [${m.category}] ${m.url.slice(0, 60)}`);
      }
      lines.push("", "Use: pulse open <# or name>");
      return ok(lines.join(nl));
    }

    if (args[0] === "list") {
      const catFilter = args.slice(1).join(" ");
      const links = await getPulseLinks();
      if (links.length === 0) return ok("No Pulse links stored. Run: pulse scan");

      let filtered = links;
      if (catFilter) {
        filtered = links.filter(l => fuzzyMatch(l.category, catFilter));
        if (filtered.length === 0) return ok(`No links in category matching "${catFilter}"`);
      }

      const grouped = new Map<string, PulseLink[]>();
      for (const l of filtered) {
        if (!grouped.has(l.category)) grouped.set(l.category, []);
        grouped.get(l.category)!.push(l);
      }

      const lines = [`=== PULSE LINKS === (${filtered.length} links)`, ""];
      for (const [cat, items] of Array.from(grouped.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`  ${cat} (${items.length})`);
        for (const item of items.slice(0, 20)) {
          lines.push(`    - ${item.name}`);
        }
        if (items.length > 20) lines.push(`    ... and ${items.length - 20} more`);
        lines.push("");
      }
      return ok(lines.join(nl));
    }

    if (args[0] === "open") {
      const target = args.slice(1).join(" ");
      if (!target) return fail("[pulse] Usage: pulse open <name or #>");

      const num = parseInt(target, 10);
      if (!isNaN(num) && num >= 1) {
        const lastResults = await getLastPulseResults();
        if (lastResults.length > 0 && num <= lastResults.length) {
          const link = lastResults[num - 1];
          return ok(`Opening: ${link.name}${nl}URL: ${link.url}${nl}__OPEN_URL:${link.url}__`);
        }
        const links = await getPulseLinks();
        if (num <= links.length) {
          const link = links[num - 1];
          return ok(`Opening: ${link.name}${nl}URL: ${link.url}${nl}__OPEN_URL:${link.url}__`);
        }
        return fail(`[pulse] Link #${num} not found. Run pulse search or pulse list first.`);
      }

      const links = await getPulseLinks();
      const matches = links.filter(l => fuzzyMatch(l.name, target));
      if (matches.length === 0) return ok(`No Pulse link matching "${target}"`);
      if (matches.length === 1) {
        return ok(`Opening: ${matches[0].name}${nl}URL: ${matches[0].url}${nl}__OPEN_URL:${matches[0].url}__`);
      }

      await saveLastPulseResults(matches.slice(0, 10));
      const lines = [`Multiple matches for "${target}":`, ""];
      for (let i = 0; i < Math.min(matches.length, 10); i++) {
        lines.push(`  ${i + 1}. ${matches[i].name} [${matches[i].category}]`);
      }
      lines.push("", "Use: pulse open <#> to select");
      return ok(lines.join(nl));
    }

    if (args[0] === "categories") {
      const links = await getPulseLinks();
      if (links.length === 0) return ok("No Pulse links stored. Run: pulse scan");
      const cats = new Map<string, number>();
      for (const l of links) cats.set(l.category, (cats.get(l.category) || 0) + 1);
      const lines = [`=== PULSE CATEGORIES === (${cats.size} categories, ${links.length} total links)`, ""];
      for (const [cat, count] of Array.from(cats.entries()).sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${cat.padEnd(40)} ${count} links`);
      }
      return ok(lines.join(nl));
    }

    if (args[0] === "clear") {
      await savePulseLinks([]);
      return ok("Pulse link directory cleared.");
    }

    return ok([
      "Pulse Intranet Directory",
      "========================",
      "  pulse scan              - Scrape Pulse homepage + nav links",
      "  pulse search <query>    - Fuzzy search links by name/category/URL",
      "  pulse list [category]   - List all links or filter by category",
      "  pulse open <name or #>  - Open a link (by name or search result #)",
      "  pulse categories        - List all categories",
      "  pulse clear             - Clear stored links",
    ].join(nl));
  });

  const galaxyState = {
    lastFetchTime: 0,
    readCount: 0,
    readSessionStart: 0,
    inFlight: false,
  };

  function galaxyRandomDelay(): number {
    return 3000 + Math.floor(Math.random() * 5000);
  }

  function galaxyCooldownDelay(): number {
    return 30000 + Math.floor(Math.random() * 30000);
  }

  async function galaxyWaitAndRecord(isRead: boolean): Promise<string | null> {
    if (galaxyState.inFlight) {
      return "A Galaxy request is already in progress. Please wait for it to complete.";
    }

    const now = Date.now();

    if (isRead) {
      const SESSION_WINDOW = 10 * 60 * 1000;
      if (now - galaxyState.readSessionStart > SESSION_WINDOW) {
        galaxyState.readCount = 0;
        galaxyState.readSessionStart = now;
      }
      if (galaxyState.readCount >= 5) {
        const cooldown = galaxyCooldownDelay();
        const sinceLast = now - galaxyState.lastFetchTime;
        if (sinceLast < cooldown) {
          const waitSec = Math.ceil((cooldown - sinceLast) / 1000);
          return `Cooldown active (${galaxyState.readCount} guides fetched). Waiting ${waitSec}s before next fetch.`;
        }
        galaxyState.readCount = 0;
        galaxyState.readSessionStart = now;
      }
    }

    const sinceLast = now - galaxyState.lastFetchTime;
    const minDelay = galaxyRandomDelay();
    if (sinceLast < minDelay && galaxyState.lastFetchTime > 0) {
      const waitMs = minDelay - sinceLast;
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    galaxyState.inFlight = true;
    galaxyState.lastFetchTime = Date.now();
    if (isRead) galaxyState.readCount++;
    return null;
  }

  function galaxyDone(): void {
    galaxyState.inFlight = false;
  }

  let galaxyRobotsParsed: { disallowed: string[] } | null = null;

  async function galaxyCheckRobots(urlPath: string): Promise<boolean> {
    if (!galaxyRobotsParsed) {
      try {
        const { submitJob, waitForResult, isExtensionConnected } = await import("./bridge-queue");
        if (isExtensionConnected()) {
          const jobId = submitJob("fetch", "https://galaxy.epic.com/robots.txt", "galaxy-robots", {}, 0);
          const result = await waitForResult(jobId, 10000);
          const body = typeof result.body === "string" ? result.body : "";
          const disallowed: string[] = [];
          let isUserAgent = false;
          for (const line of body.split(/\n/)) {
            const trimmed = line.trim();
            if (trimmed.toLowerCase().startsWith("user-agent:")) {
              isUserAgent = trimmed.includes("*");
            }
            if (isUserAgent && trimmed.toLowerCase().startsWith("disallow:")) {
              const path = trimmed.substring(9).trim();
              if (path) disallowed.push(path);
            }
          }
          galaxyRobotsParsed = { disallowed };
        } else {
          galaxyRobotsParsed = { disallowed: [] };
        }
      } catch {
        galaxyRobotsParsed = { disallowed: [] };
      }
    }

    try {
      const path = new URL(urlPath).pathname;
      for (const d of galaxyRobotsParsed.disallowed) {
        if (path.startsWith(d)) return false;
      }
    } catch {}
    return true;
  }

  async function galaxyFetch(
    url: string,
    submittedBy: string,
    options?: any
  ): Promise<any> {
    const { submitJob, waitForResult, isExtensionConnected } = await import("./bridge-queue");
    if (!isExtensionConnected()) {
      throw new Error("Chrome extension bridge not connected.");
    }
    const jobId = submitJob("dom", url, submittedBy, options, 0);
    return waitForResult(jobId, 45000);
  }

  registerCommand("galaxy", "Galaxy knowledge base search & retrieval", "galaxy [search <query>|read <url or #>|recent]", async (args) => {
    const nl = String.fromCharCode(10);

    if (!args[0] || args[0] === "help") {
      return ok([
        "Galaxy Knowledge Base (galaxy.epic.com)",
        "========================================",
        "  galaxy search <query>    - Search Galaxy for articles/guides",
        "  galaxy read <url or #>   - Fetch & save a guide to Reader",
        "  galaxy recent            - Show recently saved Galaxy guides",
        "",
        "Galaxy is behind Epic SSO. Requires Chrome extension bridge.",
        "Rate limited: 3-8s between requests, max 5 per session.",
      ].join(nl));
    }

    if (args[0] === "search") {
      const query = args.slice(1).join(" ");
      if (!query) return fail("[galaxy] Usage: galaxy search <query>");

      const searchUrl = `https://galaxy.epic.com/Search/GetResults?query=${encodeURIComponent(query)}&page=1&pageSize=10`;

      const robotsOk = await galaxyCheckRobots(searchUrl);
      if (!robotsOk) return fail(`[galaxy] Search URL blocked by robots.txt`);

      const rateMsg = await galaxyWaitAndRecord(false);
      if (rateMsg) return fail(`[galaxy] ${rateMsg}`);

      try {
        emitEvent("bridge", `Galaxy search: "${query}"`, "info");

        const result = await galaxyFetch(searchUrl, "galaxy-search", {
          maxText: 30000,
          includeHtml: true,
          maxHtml: 50000,
          spaWaitMs: 3000,
        });

        if (result.error) {
          return fail(`[galaxy] Search failed: ${result.error}${nl}No automatic retry. Try again manually if needed.`);
        }

        const html = (typeof result.body === "string" ? result.body : "") || "";
        const textContent = result.text || "";
        const results: { title: string; url: string; snippet: string }[] = [];

        const resultBlockPattern = /<a[^>]*href=["']([^"']*?)["'][^>]*>([^<]{3,})<\/a>[^<]*(?:<[^>]+>[^<]*){0,5}/gi;
        let match;
        while ((match = resultBlockPattern.exec(html)) !== null && results.length < 10) {
          let href = match[1];
          const title = match[2].trim();
          if (title.length < 4) continue;
          if (href.includes("/Search/") || href.includes("/Account/") || href.includes("javascript:")) continue;
          if (!href.startsWith("http")) href = `https://galaxy.epic.com${href}`;

          let snippet = "";
          const afterMatch = html.substring(match.index + match[0].length, match.index + match[0].length + 300);
          const snippetClean = afterMatch
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          if (snippetClean.length > 10) {
            snippet = snippetClean.substring(0, 120);
          }

          const isDupe = results.some(r => r.url === href || r.title === title);
          if (!isDupe) results.push({ title, url: href, snippet });
        }

        if (results.length === 0 && textContent.length > 20) {
          const lines = textContent.split(/\n/).map((l: string) => l.trim()).filter((l: string) => l.length > 10);
          for (let i = 0; i < Math.min(lines.length, 10); i++) {
            results.push({ title: lines[i].substring(0, 100), url: "", snippet: "" });
          }
        }

        await storage.setAgentConfig("galaxy_last_results", JSON.stringify(results), "galaxy");
        await storage.setAgentConfig("galaxy_last_query", query, "galaxy");

        if (results.length === 0) {
          return ok(`Galaxy search: "${query}" -- No results found.${nl}The page may have a different structure or require specific auth.`);
        }

        const outLines = [`=== GALAXY SEARCH: "${query}" === (${results.length} results)`, ""];
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          outLines.push(`  ${String(i + 1).padStart(3)}. ${r.title}`);
          if (r.url) outLines.push(`       ${r.url.slice(0, 70)}`);
          if (r.snippet) outLines.push(`       ${r.snippet}`);
        }
        outLines.push("", "Use: galaxy read <#> to fetch & save a guide");
        return ok(outLines.join(nl));
      } finally {
        galaxyDone();
      }
    }

    if (args[0] === "read") {
      const target = args.slice(1).join(" ");
      if (!target) return fail("[galaxy] Usage: galaxy read <url or result #>");

      let url = target;
      let fromSearch = false;
      const num = parseInt(target, 10);
      if (!isNaN(num) && num >= 1) {
        const cfg = await storage.getAgentConfig("galaxy_last_results");
        if (!cfg?.value) return fail("[galaxy] No search results stored. Run galaxy search first.");
        try {
          const results = JSON.parse(cfg.value);
          if (num > results.length) return fail(`[galaxy] Result #${num} not found. Only ${results.length} results.`);
          url = results[num - 1].url;
          if (!url) return fail(`[galaxy] Result #${num} has no URL.`);
          fromSearch = true;
        } catch {
          return fail("[galaxy] Failed to parse stored results.");
        }
      }

      if (!url.startsWith("http")) {
        url = `https://galaxy.epic.com${url.startsWith("/") ? "" : "/"}${url}`;
      }

      const robotsOk = await galaxyCheckRobots(url);
      if (!robotsOk) return fail(`[galaxy] URL blocked by robots.txt: ${url}`);

      const rateMsg = await galaxyWaitAndRecord(true);
      if (rateMsg) return fail(`[galaxy] ${rateMsg}`);

      try {
        emitEvent("bridge", `Galaxy read: navigating naturally to ${url}`, "info");

        if (fromSearch) {
          const lastQuery = (await storage.getAgentConfig("galaxy_last_query"))?.value || "guide";
          const refererUrl = `https://galaxy.epic.com/Search/GetResults?query=${encodeURIComponent(lastQuery)}&page=1&pageSize=10`;
          await galaxyFetch(refererUrl, "galaxy-browse-search", {
            maxText: 1000,
            spaWaitMs: 1500,
          });
        } else {
          await galaxyFetch("https://galaxy.epic.com", "galaxy-browse-home", {
            maxText: 1000,
            spaWaitMs: 1500,
          });
        }
        const browseDelay = 2000 + Math.floor(Math.random() * 3000);
        await new Promise(resolve => setTimeout(resolve, browseDelay));

        emitEvent("bridge", `Galaxy read: fetching article`, "info");

        const result = await galaxyFetch(url, "galaxy-read", {
          maxText: 50000,
          includeHtml: true,
          maxHtml: 100000,
          spaWaitMs: 3000,
        });

        if (result.error) {
          return fail(`[galaxy] Fetch failed: ${result.error}${nl}No automatic retry. Try again manually if needed.`);
        }

        const html = (typeof result.body === "string" ? result.body : "") || "";
        const text = result.text || "";

        let title = "";
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch) title = titleMatch[1].trim();
        const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
        if (h1Match) title = h1Match[1].trim();

        if (!title) {
          title = text.split(/\n/)[0]?.trim().substring(0, 100) || "Galaxy Article";
        }

        let category = "";
        const breadcrumbMatch = html.match(/<[^>]*class=["'][^"']*breadcrumb[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
        if (breadcrumbMatch) {
          const crumbLinks = breadcrumbMatch[1].match(/>([^<]{2,})</g);
          if (crumbLinks && crumbLinks.length > 1) {
            category = crumbLinks[crumbLinks.length - 2].replace(/^>/, "").trim();
          }
        }
        if (!category) {
          const pathParts = new URL(url).pathname.split("/").filter(Boolean);
          if (pathParts.length > 1) {
            category = decodeURIComponent(pathParts[0]).replace(/[-_]/g, " ");
            category = category.charAt(0).toUpperCase() + category.slice(1);
          }
        }
        if (!category) category = "General";

        const extractedText = text.length > 100 ? text : html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
          .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
          .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        const saved = await storage.createReaderPage({
          url,
          title,
          extractedText: extractedText.substring(0, 50000),
          domain: "galaxy.epic.com",
        });

        await storage.setAgentConfig(
          `galaxy_category_${saved.id}`,
          category,
          "galaxy"
        );

        return ok([
          `Galaxy guide saved to Reader:`,
          `  Title:    ${title}`,
          `  Category: ${category}`,
          `  URL:      ${url}`,
          `  ID:       ${saved.id}`,
          `  Size:     ${extractedText.length} chars`,
          "",
          "View in Reader (C-c r) or TreeView GALAXY section.",
        ].join(nl));
      } finally {
        galaxyDone();
      }
    }

    if (args[0] === "recent") {
      const pages = await storage.getReaderPages();
      const galaxyPages = pages.filter(p => p.domain === "galaxy.epic.com");
      const recent = galaxyPages.slice(0, 10);

      if (recent.length === 0) {
        return ok("No Galaxy guides saved yet. Use: galaxy search <query> then galaxy read <#>");
      }

      const outLines = [`=== GALAXY GUIDES (${galaxyPages.length} total, showing latest 10) ===`, ""];
      for (let i = 0; i < recent.length; i++) {
        const p = recent[i];
        const date = p.scrapedAt ? new Date(p.scrapedAt).toLocaleDateString() : "unknown";
        outLines.push(`  ${String(i + 1).padStart(3)}. ${p.title}`);
        outLines.push(`       ${p.url.slice(0, 60)}  (${date})`);
      }
      return ok(outLines.join(nl));
    }

    return ok([
      "Galaxy Knowledge Base (galaxy.epic.com)",
      "========================================",
      "  galaxy search <query>    - Search Galaxy for articles/guides",
      "  galaxy read <url or #>   - Fetch & save a guide to Reader",
      "  galaxy recent            - Show recently saved Galaxy guides",
      "",
      "Galaxy is behind Epic SSO. Requires Chrome extension bridge.",
      "Rate limited: 3-8s between requests, max 5 per session.",
    ].join(nl));
  });
}

registerBuiltinCommands();

export function getRegisteredCommands(): string[] {
  return Array.from(commands.keys());
}

export function getCommandHelp(): string {
  return getCommandList();
}
