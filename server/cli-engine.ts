import { storage } from "./storage";
import { manualTrigger, getRuntimeState, runMemoryConsolidation, getRuntimeBudgetStatus } from "./agent-runtime";
import { getModelRoster, getModelQuality, type BudgetStatus } from "./model-router";
import { emitEvent } from "./event-bus";
import { bestEffortExtract, executeNavigationPath, matchProfileToUrl } from "./universal-scraper";
import { executeLLM, type LLMConfig, type LLMMessage, type LLMResponse } from "./llm-client";
import { synthesizeBriefing, htmlToSpokenScript } from "./voice-synth";
import { findBestProduct, getStoreProfile, computeHealthScore } from "../skills/grocery-toolkit";
import {
  ask as askEngine, askCompare, resetConversation,
  setLocalFallback, getPreprocessStatus,
  setPreferredModel, getPreferredModel,
} from "./ask-engine";

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
    "standup", "memory", "bridge", "bridge-status", "bridge-token", "cwp", "outlook", "teams", "citrix", "snow", "epic", "pulse", "meals", "budget", "ask", "boot"].includes(cmdName);
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

function buildSnowRecordUrl(baseUrl: string, tableName: string, num: string): string {
  return `${baseUrl}/nav_to.do?uri=${tableName}.do?sysparm_query=number=${num}`;
}

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
      const recordUrl = buildSnowRecordUrl(baseUrl, tableName, num);
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
        url: recordUrl,
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

  registerCommand("sh", "Execute a shell command (self-hosted only)", "sh <command>", async (args) => {
    const { isLocalComputeAvailable, executeLocalShell } = await import("./local-compute");
    if (!isLocalComputeAvailable()) {
      return fail("[error] sh: requires RACHAEL_SELF_HOSTED=true (only available on self-hosted instances)");
    }
    if (args.length === 0) return fail("[error] sh: no command provided");
    const command = args.join(" ");
    const result = await executeLocalShell(command, { timeout: 30000 });
    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout.trimEnd());
    if (result.stderr) parts.push(`[stderr] ${result.stderr.trimEnd()}`);
    if (result.exitCode !== 0) parts.push(`[exit ${result.exitCode}]`);
    return parts.length > 0 ? ok(parts.join(String.fromCharCode(10))) : ok("(no output)");
  });

  registerCommand("collect-secrets", "Request credentials via secure magic-link form", "collect-secrets <purpose> --field <name:label:type> [--field ...]", async (args) => {
    const secretsMod = await import("./secrets");
    const purpose = args.filter(a => a !== "--field" && !a.includes(":")).join(" ");
    if (!purpose) return fail("[error] collect-secrets: purpose text required");
    const fields: Array<{ name: string; label: string; type: "password" | "text"; required: boolean }> = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--field" && args[i + 1]) {
        const parts = args[i + 1].split(":");
        if (parts.length < 2) return fail("[error] collect-secrets: --field format is name:label[:type]. type is password|text (default: password)");
        fields.push({
          name: parts[0],
          label: parts[1],
          type: (parts[2] === "text" ? "text" : "password") as "password" | "text",
          required: true,
        });
        i++;
      }
    }
    if (fields.length === 0) return fail("[error] collect-secrets: at least one --field required");
    const { requestId, magicToken } = await secretsMod.createSecretRequest(fields, purpose);
    const base = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : process.env.RACHAEL_DOMAIN
        ? `https://${process.env.RACHAEL_DOMAIN}`
        : "http://localhost:5000";
    const formUrl = `${base}/api/secrets/form/${requestId}?token=${encodeURIComponent(magicToken)}`;
    const lines = [
      "Secret collection request created.",
      `Request ID: ${requestId}`,
      `Expires: 10 minutes`,
      "",
      "Share this link with the user:",
      formUrl,
    ];
    return ok(lines.join(String.fromCharCode(10)));
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

  registerCommand("goals", "Manage user goals/priorities for digest", "goals [list|add <name> --keywords k1,k2|remove <name>]", async (args) => {
    const sub = args[0] || "list";
    const goalsConfig = await storage.getAgentConfig("user_goals");
    let goals: Array<{ name: string; keywords: string[]; priority: number }> = [];
    if (goalsConfig?.value) {
      try { goals = JSON.parse(goalsConfig.value); } catch {}
    }

    if (sub === "list") {
      if (goals.length === 0) return ok("No goals configured. Use: goals add <name> --keywords k1,k2,k3");
      const lines = goals.map((g, i) => `${(i + 1 + ".").padEnd(4)} ${g.name.padEnd(35)} [P${g.priority}] keywords: ${g.keywords.join(", ")}`);
      return ok("=== USER GOALS ===\n" + lines.join("\n"));
    }

    if (sub === "add") {
      const kwIdx = args.indexOf("--keywords");
      const name = args.slice(1, kwIdx > 0 ? kwIdx : undefined).join(" ");
      if (!name) return fail("[error] goals add: usage: goals add <name> --keywords k1,k2,k3");
      const keywords = kwIdx > 0 ? args[kwIdx + 1]?.split(",").map(k => k.trim()).filter(Boolean) || [] : [];
      const prioIdx = args.indexOf("--priority");
      const priority = prioIdx > 0 ? parseInt(args[prioIdx + 1] || "3", 10) : 3;
      if (goals.find(g => g.name.toLowerCase() === name.toLowerCase())) {
        return fail("[error] goals add: goal '" + name + "' already exists");
      }
      goals.push({ name, keywords, priority });
      await storage.setAgentConfig("user_goals", JSON.stringify(goals), "goals");
      return ok("Added goal: " + name + " (P" + priority + ", keywords: " + keywords.join(", ") + ")");
    }

    if (sub === "remove") {
      const name = args.slice(1).join(" ");
      if (!name) return fail("[error] goals remove: usage: goals remove <name>");
      const idx = goals.findIndex(g => g.name.toLowerCase() === name.toLowerCase());
      if (idx === -1) return fail("[error] goals remove: goal '" + name + "' not found");
      goals.splice(idx, 1);
      await storage.setAgentConfig("user_goals", JSON.stringify(goals), "goals");
      return ok("Removed goal: " + name);
    }

    return fail("[error] goals: unknown subcommand '" + sub + "'\nUsage: goals [list|add <name> --keywords k1,k2|remove <name>]");
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

  registerCommand("budget", "Token budget dashboard", "budget [status|models|set <tokens>]", async (args) => {
    const sub = args[0] || "status";
    if (sub === "status") {
      const bs = await getRuntimeBudgetStatus();
      const bar = (pct: number) => {
        const clamped = Math.max(0, Math.min(100, pct));
        const filled = Math.round(clamped / 5);
        return "[" + "#".repeat(filled) + "-".repeat(20 - filled) + "]";
      };
      const lines = [
        `=== TOKEN BUDGET ===`,
        `${bar(bs.percentUsed)} ${bs.percentUsed}%`,
        `Used:      ${bs.used.toLocaleString()} / ${bs.budget.toLocaleString()} tokens`,
        `Remaining: ${bs.remaining.toLocaleString()} tokens`,
        `Est. cost: $${bs.estimatedCostToday.toFixed(4)}`,
        `Status:    ${bs.exhausted ? "!! EXHAUSTED !!" : "OK"}`,
      ];
      const byProg = bs.report.byProgram;
      const progNames = Object.keys(byProg);
      if (progNames.length > 0) {
        lines.push("", "--- By Program ---");
        const sorted = progNames.sort((a, b) => byProg[b].tokens - byProg[a].tokens);
        for (const name of sorted.slice(0, 15)) {
          const p = byProg[name];
          lines.push(`  ${name.padEnd(25)} ${p.tokens.toLocaleString().padStart(8)} tok  $${p.cost.toFixed(4)}  (${p.calls} calls)`);
        }
      }
      const modelNames = Object.keys(bs.report.byModel);
      if (modelNames.length > 0) {
        lines.push("", "--- By Model ---");
        for (const name of modelNames) {
          const short = name.replace(/^openrouter\//, "").split("/").pop() || name;
          lines.push(`  ${short.padEnd(25)} ${bs.report.byModel[name].toLocaleString().padStart(8)} tok`);
        }
      }
      const roster = getModelRoster();
      const tierTotals: Record<string, number> = {};
      for (const [name, tokens] of Object.entries(bs.report.byModel)) {
        const normalized = name.replace(/^openrouter\//, "");
        const model = roster.find(m => m.id === normalized || m.id === name);
        const tier = model?.tier || "unknown";
        tierTotals[tier] = (tierTotals[tier] || 0) + tokens;
      }
      if (Object.keys(tierTotals).length > 0) {
        lines.push("", "--- By Tier ---");
        for (const [tier, tokens] of Object.entries(tierTotals).sort((a, b) => b[1] - a[1])) {
          lines.push(`  ${tier.padEnd(10)} ${tokens.toLocaleString().padStart(8)} tok`);
        }
      }
      if (bs.budget > 0 && bs.used > 0) {
        const hoursElapsed = new Date().getHours() + new Date().getMinutes() / 60;
        const burnRate = hoursElapsed > 0 ? bs.used / hoursElapsed : 0;
        const projected = Math.round(burnRate * 24);
        lines.push("", `Projected 24h: ~${projected.toLocaleString()} tokens (${Math.round((projected / bs.budget) * 100)}% of budget)`);
      }
      return ok(lines.join("\n"));
    }
    if (sub === "models") {
      const roster = getModelRoster();
      const quality = getModelQuality();
      const lines = ["=== MODEL ROSTER ==="];
      for (const m of roster) {
        const q = quality.get(m.id);
        const qStr = q ? ` Q:${q.score}% (${q.successes}ok/${q.failures}fail)` : "";
        const cost = m.inputCostPer1M !== undefined ? ` $${m.inputCostPer1M}/$${m.outputCostPer1M} per 1M` : "";
        lines.push(`  [${m.tier.padEnd(8)}] ${m.label.padEnd(22)} ${m.id}${cost}${qStr}`);
      }
      return ok(lines.join("\n"));
    }
    if (sub === "set") {
      const val = parseInt(args[1], 10);
      if (isNaN(val) || val <= 0) return fail("[error] budget set: usage: budget set <tokens>\n  Example: budget set 1000000");
      await storage.setAgentConfig("daily_token_budget", String(val), "budget");
      return ok(`Daily token budget set to ${val.toLocaleString()} tokens`);
    }
    return fail(`[error] budget: unknown subcommand "${sub}"\nUsage: budget [status|models|set <tokens>]`);
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

  registerCommand("memory", "Manage agent episodic memory", "memory [list [program]|search <query>|add <content>|forget <id>|consolidate|show]", async (args) => {
    const sub = args[0] || "list";

    if (sub === "list") {
      const programFilter = args[1] || undefined;
      const memories = programFilter
        ? await storage.getMemoriesForProgram(programFilter, { limit: 50 })
        : await storage.getAllMemories(50);
      if (memories.length === 0) return ok("No memories found.");
      const lines = ["=== AGENT MEMORIES ===", ""];
      for (const m of memories) {
        const prog = m.programName || "global";
        const tags = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
        const age = Math.floor((Date.now() - m.createdAt.getTime()) / 86400000);
        lines.push(`  #${m.id} (${m.memoryType}, ${prog}, rel:${m.relevanceScore}, ${age}d ago)${tags}`);
        lines.push(`    ${m.content.slice(0, 120)}`);
      }
      lines.push("", `${memories.length} memories total`);
      return ok(lines.join("\n"));
    }

    if (sub === "show") {
      const memories = await storage.getAllMemories(100);
      if (memories.length === 0) {
        const mem = await storage.getAgentConfig("persistent_context");
        const text = mem?.value || "";
        if (!text.trim()) return ok("Memory is empty.");
        return ok(text);
      }
      const lines: string[] = [];
      const byType: Record<string, number> = {};
      for (const m of memories) {
        byType[m.memoryType] = (byType[m.memoryType] || 0) + 1;
      }
      lines.push(`=== MEMORY SUMMARY === (${memories.length} total)`);
      for (const [type, count] of Object.entries(byType)) {
        lines.push(`  ${type}: ${count}`);
      }
      lines.push("", "Recent memories:");
      for (const m of memories.slice(0, 10)) {
        lines.push(`  #${m.id} [${m.memoryType}] ${m.content.slice(0, 100)}`);
      }
      return ok(lines.join("\n"));
    }

    if (sub === "search") {
      const query = args.slice(1).join(" ");
      if (!query) return fail("[error] memory search: usage: memory search <query>");
      const memories = await storage.searchMemories(query, 20);
      if (memories.length === 0) return ok(`No memories matching "${query}".`);
      const lines = [`=== MEMORIES MATCHING "${query}" ===`, ""];
      for (const m of memories) {
        const prog = m.programName || "global";
        lines.push(`  #${m.id} (${m.memoryType}, ${prog}, rel:${m.relevanceScore})`);
        lines.push(`    ${m.content.slice(0, 120)}`);
      }
      return ok(lines.join("\n"));
    }

    if (sub === "add" || sub === "store") {
      const text = args.slice(1).join(" ");
      if (!text) return fail("[error] memory add: usage: memory add <content>");
      const tags: string[] = [];
      const words = text.toLowerCase().split(/\s+/);
      for (const w of words) {
        const clean = w.replace(/[^a-z0-9-]/g, "");
        if (clean.length > 2 && tags.length < 5) tags.push(clean);
      }
      const mem = await storage.createMemory({
        content: text,
        memoryType: "fact",
        tags,
        relevanceScore: 100,
      });
      emitEvent("memory", `Memory manually added: "${text.slice(0, 60)}"`, "info", { metadata: { memoryId: mem.id } });
      return ok(`Memory #${mem.id} created: ${text}`);
    }

    if (sub === "forget") {
      const idStr = args[1];
      if (!idStr) return fail("[error] memory forget: usage: memory forget <id>");
      const id = parseInt(idStr, 10);
      if (isNaN(id)) return fail("[error] memory forget: id must be a number");
      await storage.deleteMemory(id);
      emitEvent("memory", `Memory #${id} deleted`, "info", { metadata: { memoryId: id } });
      return ok(`Memory #${id} deleted.`);
    }

    if (sub === "consolidate") {
      const result = await runMemoryConsolidation();
      emitEvent("memory", `Memory consolidation: decayed ${result.decayed}, merged ${result.merged} groups (${result.deleted} old records removed)`, "info");
      return ok(`Consolidation complete. Decayed relevance for ${result.decayed} memories. Merged ${result.merged} groups (${result.deleted} old records removed).`);
    }

    return fail(`[error] memory: unknown subcommand "${sub}"\nUsage: memory [list [program]|search <query>|add <content>|forget <id>|consolidate|show]`);
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

    let budgetSection = "";
    try {
      const bs = await getRuntimeBudgetStatus();
      budgetSection = `BUDGET: ${bs.used.toLocaleString()} / ${bs.budget.toLocaleString()} tokens (${bs.percentUsed}%) | Est. $${bs.estimatedCostToday.toFixed(4)}${bs.exhausted ? " !! EXHAUSTED !!" : ""}`;
    } catch {}

    if (raw) {
      const lines: string[] = [`=== STANDUP (${sinceStr} → ${today}) ===`, ""];
      for (const r of agentReports) lines.push(r);
      if (errorReports.length) { lines.push("ERRORS:"); for (const e of errorReports) lines.push(e); }
      lines.push(`TASKS:\n${taskSection}`);
      lines.push(`RECIPES:\n${recipeSection}`);
      if (budgetSection) lines.push("", budgetSection);
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

${budgetSection ? budgetSection : ""}

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
      return fail("[error] notify: no notification target configured." + String.fromCharCode(10) + "Set up ntfy.sh:  config set notify_channel rachael-briefing" + String.fromCharCode(10) + "Or a webhook:    config set notify_webhook https://your-webhook-url" + String.fromCharCode(10) + "For email:       config set notify_email you@example.com" + String.fromCharCode(10) + String.fromCharCode(10) + "For ntfy.sh: install the ntfy app on your phone, subscribe to the same channel name.");
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
          "Title": "Rachael Morning Briefing",
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
          body: JSON.stringify({ text: message.slice(0, 16000), title: "Rachael Morning Standup", timestamp: new Date().toISOString() }),
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

  registerCommand("outlook", "Browse Outlook inbox/calendar via bridge", "outlook [inbox|calendar|read <n>|search <term>|sync] [--limit N] [--refresh]", async (args) => {
    const { smartFetch, isExtensionConnected } = await import("./bridge-queue");
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

      if (!refresh) {
        const lastSync = await storage.getOutlookSyncTimestamp();
        if (lastSync) {
          const ageMs = Date.now() - lastSync.getTime();
          const STALE_THRESHOLD = 30 * 60 * 1000;
          if (ageMs < STALE_THRESHOLD) {
            const persisted = await storage.getOutlookEmails({ limit });
            if (persisted.length > 0) {
              const ageMin = Math.round(ageMs / 60000);
              const lines = [`=== OUTLOOK INBOX === (from DB, synced ${ageMin}m ago, ${persisted.length} messages)`, ""];
              persisted.forEach((e, i) => {
                const unread = e.unread ? "*" : " ";
                const from = (e.from || "").padEnd(25).slice(0, 25);
                const date = (e.date || "").padEnd(12).slice(0, 12);
                lines.push(`${unread}${String(i + 1).padStart(3)}  ${date}  ${from}  ${(e.subject || "").slice(0, 60)}`);
              });
              lines.push("", `Synced ${ageMin}m ago. Use: outlook --refresh to re-scrape`);
              return ok(lines.join("\n"));
            }
          }
        }
      }

      if (!isExtensionConnected()) {
        const staleEmails = await storage.getOutlookEmails({ limit });
        if (staleEmails.length > 0) {
          const lastSync = await storage.getOutlookSyncTimestamp();
          const ageMin = lastSync ? Math.round((Date.now() - lastSync.getTime()) / 60000) : -1;
          const lines = [`=== OUTLOOK INBOX === (from DB, synced ${ageMin > 0 ? ageMin + "m" : "?"}  ago — bridge offline)`, ""];
          staleEmails.forEach((e, i) => {
            const unread = e.unread ? "*" : " ";
            const from = (e.from || "").padEnd(25).slice(0, 25);
            const date = (e.date || "").padEnd(12).slice(0, 12);
            lines.push(`${unread}${String(i + 1).padStart(3)}  ${date}  ${from}  ${(e.subject || "").slice(0, 60)}`);
          });
          lines.push("", "Bridge not connected — showing last synced data. Connect extension to refresh.");
          return ok(lines.join("\n"));
        }
        return fail("[outlook] Bridge not connected and no persisted data available.\nRun: bridge-status");
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

      let newCount = 0;
      let updatedCount = 0;
      for (const email of emails) {
        try {
          const msgId = `${email.from}-${email.date}-${email.subject}`.substring(0, 200);
          const isSnow = /servicenow|service-now|INC\d|CHG\d|REQ\d|RITM\d/i.test(email.subject);
          const existing = await storage.getOutlookEmailByMessageId(msgId);
          await storage.upsertOutlookEmail({
            messageId: msgId,
            from: email.from,
            subject: email.subject,
            date: email.date,
            preview: email.subject.substring(0, 200),
            unread: email.unread,
            isSnowNotification: isSnow,
          });
          if (!existing) newCount++;
          else if (existing.unread !== email.unread) updatedCount++;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          emitEvent("cli", `[outlook] Failed to persist email "${email.subject?.slice(0, 40)}": ${msg}`, "warn");
        }
      }
      await storage.setAgentConfig("outlook_last_sync", new Date().toISOString(), "boot");

      if (emails.length === 0) {
        const sampleText = text.slice(0, 500).split(/[\n\r]+/).filter(l => l.trim().length > 0).slice(0, 10).join(String.fromCharCode(10));
        return ok(`=== OUTLOOK INBOX ===\n\nPage loaded (${text.length} chars) but could not parse emails.\nExtracted rows: ${extracted?.rows?.length || 0}\n\nSample text:\n${sampleText}\n\nTry: outlook --raw   for full debug output\nOr:  outlook --refresh`);
      }

      const display = emails.slice(0, limit);
      const syncInfo = newCount > 0 || updatedCount > 0 ? ` | ${newCount} new, ${updatedCount} updated` : "";
      const lines = [`=== OUTLOOK INBOX === (${emails.length} messages${syncInfo})`, ""];
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
      if (!isExtensionConnected()) return fail("[outlook] Calendar requires bridge connection.\nRun: bridge-status");
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

    if (sub === "search") {
      const query = args.slice(1).join(" ").trim();
      if (!query) return fail("[outlook] Usage: outlook search <term>");
      const results = await storage.searchOutlookEmails(query, 30);
      if (results.length === 0) return ok(`No emails found matching "${query}".`);
      const lines = [`=== OUTLOOK SEARCH: "${query}" === (${results.length} results)`, ""];
      results.forEach((e, i) => {
        const unread = e.unread ? "*" : " ";
        const from = e.from.padEnd(25).slice(0, 25);
        const date = e.date.padEnd(12).slice(0, 12);
        lines.push(`${unread}${String(i + 1).padStart(3)}  ${date}  ${from}  ${e.subject.slice(0, 60)}`);
      });
      return ok(lines.join("\n"));
    }

    if (sub === "sync") {
      const persisted = await storage.getOutlookEmails({ unreadOnly: false, limit: 50 });
      if (persisted.length === 0) return ok("No persisted emails. Run: outlook inbox --refresh");
      const unread = persisted.filter(e => e.unread);
      const lines = [`=== OUTLOOK PERSISTED === (${persisted.length} total, ${unread.length} unread)`, ""];
      unread.forEach((e, i) => {
        const from = e.from.padEnd(25).slice(0, 25);
        const date = e.date.padEnd(12).slice(0, 12);
        lines.push(`* ${String(i + 1).padStart(3)}  ${date}  ${from}  ${e.subject.slice(0, 60)}`);
      });
      if (unread.length === 0) lines.push("  No unread emails.");
      return ok(lines.join("\n"));
    }

    return fail(`[outlook] unknown subcommand "${sub}"\nUsage: outlook [inbox|calendar|read <n>|search <term>|sync] [--limit N] [--refresh]`);
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

  registerCommand("snow", "ServiceNow command center", "snow [home|incidents|changes|requests|detail <number>|queue|refresh|search|persisted]", async (args) => {
    const { isExtensionConnected } = await import("./bridge-queue");
    const sub = args[0] || "incidents";
    const refresh = args.includes("--refresh");

    const persistedOnlyCmds = ["search", "persisted"];
    if (!isExtensionConnected() && !persistedOnlyCmds.includes(sub) && refresh) {
      return fail("[snow] Chrome extension bridge not connected. Scraping requires your real browser session.\nRun: bridge-status\nFor persisted data, omit --refresh.");
    }

    let instanceConfig = await storage.getAgentConfig("snow_instance");
    let instanceUrl = instanceConfig?.value || "";
    if (!instanceUrl) {
      instanceUrl = "https://uchealth.service-now.com";
      await storage.setAgentConfig("snow_instance", instanceUrl, "snow");
      emitEvent("cli", `Auto-configured snow_instance: ${instanceUrl}`, "info", { metadata: { command: "snow" } });
    }
    const baseUrl = instanceUrl.replace(/\/+$/, "");
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

    async function scrapeSowHomepage(profile: typeof updatedProfile, paths: typeof navPathMap, bUrl: string): Promise<string> {
      const sowPath = paths["scrape-sow-home"];
      if (sowPath) {
        emitEvent("cli", "Executing SOW homepage nav path (SPA wait + scroll)...", "info", { metadata: { command: "snow" } });
        try {
          const scrapeResult = await executeNavigationPath(profile, sowPath);
          const text = scrapeResult.content?.text || "";
          const extractedText = Object.values(scrapeResult.extractedData).filter(v => v).join(String.fromCharCode(10));
          const allText = text + String.fromCharCode(10) + extractedText;
          if (allText.length > 200) {
            emitEvent("cli", `SOW nav path extracted: ${allText.length} chars`, "info", { metadata: { command: "snow" } });
            return allText;
          }
          emitEvent("cli", `SOW nav path yielded sparse content (${allText.length} chars), trying smartFetch fallback...`, "warn", { metadata: { command: "snow" } });
        } catch (e: any) {
          emitEvent("cli", `SOW nav path failed: ${e.message}, trying smartFetch fallback...`, "warn", { metadata: { command: "snow" } });
        }
      }

      const { smartFetch } = await import("./bridge-queue");
      const sowUrl = `${bUrl}/now/sow/home`;
      const result = await smartFetch(sowUrl, "dom", "cli-snow-sow-fallback", {
        maxText: 80000,
      }, 30000);
      return result.text || "";
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

    async function persistSnowResults(records: CachedSnowRecord[], label: string): Promise<{ newCount: number; updatedCount: number }> {
      let newCount = 0;
      let updatedCount = 0;
      try {
        const summary = `SNOW ${label}: ${records.length} records scraped`;
        const rawOutput = JSON.stringify(records);
        await storage.createAgentResult({
          programName: "snow-scraper",
          summary,
          rawOutput,
          status: "ok",
        });
        for (const r of records) {
          try {
            const existing = await storage.getSnowTicketByNumber(r.number);
            await storage.upsertSnowTicket({
              number: r.number,
              type: r.type,
              shortDescription: r.shortDescription,
              state: r.state,
              priority: r.priority,
              assignedTo: r.assignedTo,
              assignmentGroup: r.assignmentGroup,
              updatedOn: r.updatedOn,
              source: r.source || "personal",
              slaBreached: r.slaBreached || false,
              url: r.url || null,
            });
            if (!existing) newCount++;
            else if (existing.state !== r.state || existing.priority !== r.priority) updatedCount++;
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[snow] Failed to persist ticket ${r.number}: ${msg}`);
          }
        }
        await storage.setAgentConfig("snow_last_sync", new Date().toISOString(), "boot");
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[snow] Failed to persist results: ${msg}`);
      }
      return { newCount, updatedCount };
    }

    interface SnowRecordProjection {
      number: string;
      shortDescription: string;
      state: string;
      priority: string;
      type: string;
      assignedTo: string;
      assignmentGroup: string;
      url: string;
      slaBreached: boolean;
    }

    function snowTicketsToRecords(tickets: Array<{ number: string; shortDescription: string | null; state: string | null; priority: string | null; type: string; assignedTo: string | null; assignmentGroup: string | null }>): SnowRecordProjection[] {
      return tickets.map(t => ({
        number: t.number, shortDescription: t.shortDescription || "", state: t.state || "",
        priority: t.priority || "", type: t.type, assignedTo: t.assignedTo || "",
        assignmentGroup: t.assignmentGroup || "", url: "", slaBreached: false,
      }));
    }

    async function snowPersistedFirst(typeFilter: string, label: string, navPathName: string): Promise<CommandResult> {
      const cached = snowCache;
      if (cached && !refresh) {
        const filtered = cached.records.filter(r => r.type === typeFilter);
        if (filtered.length > 0) {
          const age = Math.round((Date.now() - cached.fetchedAt) / 1000);
          return ok(formatSnowList(label, filtered, age));
        }
      }

      if (!refresh) {
        const lastSync = await storage.getSnowSyncTimestamp();
        const bridgeOnline = isExtensionConnected();
        if (lastSync) {
          const ageMs = Date.now() - lastSync.getTime();
          const STALE_THRESHOLD = 30 * 60 * 1000;
          if (ageMs < STALE_THRESHOLD || !bridgeOnline) {
            const persisted = await storage.getSnowTickets({ type: typeFilter, limit: 50 });
            if (persisted.length > 0) {
              const ageMin = Math.round(ageMs / 60000);
              const suffix = !bridgeOnline ? " (bridge offline)" : "";
              return ok(formatSnowList(label + " [db]", snowTicketsToRecords(persisted)) + `${nl}Synced ${ageMin}m ago${suffix}. Use: snow ${navPathName} --refresh to re-scrape`);
            }
          }
        }
        if (!bridgeOnline) {
          const anyPersisted = await storage.getSnowTickets({ type: typeFilter, limit: 50 });
          if (anyPersisted.length > 0) {
            return ok(formatSnowList(label + " [db]", snowTicketsToRecords(anyPersisted)) + `${nl}Bridge offline — showing last synced data.`);
          }
          return fail(`[snow] Bridge not connected and no persisted ${typeFilter}s available.\nRun: bridge-status`);
        }
      }

      if (!isExtensionConnected()) {
        return fail(`[snow] Bridge not connected. Cannot scrape with --refresh.\nRun: bridge-status`);
      }

      const pathName = navPathName === "incidents" ? "list-my-incidents" : navPathName === "changes" ? "list-my-changes" : "list-my-requests";
      const records = await scrapeSnowNavPath(pathName, typeFilter);
      mergeSnowCache(records, typeFilter);
      if (records.length > 0) await persistSnowResults(records, navPathName);
      if (records.length === 0) return ok(`=== SNOW ${label} ===${nl}${nl}No ${typeFilter}s found or could not parse. Try: snow refresh`);
      return ok(formatSnowList(label, records));
    }

    if (sub === "incidents" || sub === "inc") {
      return snowPersistedFirst("incident", "INCIDENTS", "incidents");
    }

    if (sub === "changes" || sub === "chg") {
      return snowPersistedFirst("change", "CHANGE REQUESTS", "changes");
    }

    if (sub === "requests" || sub === "req") {
      return snowPersistedFirst("request", "SERVICE REQUESTS", "requests");
    }

    if (sub === "detail") {
      const recordNumber = args[1];
      if (!recordNumber) return fail("[snow] Usage: snow detail INC0012345");
      const cached = snowCache;
      const cachedRecord = cached?.records.find(r => r.number.toLowerCase() === recordNumber.toLowerCase());
      const dbTicket = await storage.getSnowTicketByNumber(recordNumber);
      let tableName = "incident";
      if (/^CHG/i.test(recordNumber)) tableName = "change_request";
      else if (/^REQ|^RITM/i.test(recordNumber)) tableName = "sc_req_item";
      const detailUrl = buildSnowRecordUrl(baseUrl, tableName, recordNumber);

      const infoSource = cachedRecord || dbTicket;

      if (!isExtensionConnected() || !refresh) {
        if (infoSource) {
          const lines = [`=== ${recordNumber} ===`, ""];
          lines.push(`Short Description: ${infoSource.shortDescription || ""}`);
          lines.push(`State: ${infoSource.state || ""}`);
          lines.push(`Priority: ${infoSource.priority || ""}`);
          lines.push(`Assigned To: ${infoSource.assignedTo || ""}`);
          lines.push(`Group: ${infoSource.assignmentGroup || ""}`);
          const updatedOn = "updatedOn" in infoSource ? String((infoSource as Record<string, unknown>).updatedOn || "") : "";
          if (updatedOn) lines.push(`Updated: ${updatedOn}`);
          lines.push("", `Open in browser: ${detailUrl}`);
          if (!isExtensionConnected()) lines.push("", "Bridge offline — showing cached data only.");
          else lines.push("", "Use: snow detail " + recordNumber + " --refresh to re-scrape from browser");
          return ok(lines.join(nl));
        }
        if (!isExtensionConnected()) {
          return fail(`[snow] Bridge offline and no cached data for ${recordNumber}.\nRun: bridge-status`);
        }
      }

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
      if (infoSource) {
        lines.push(`Short Description: ${infoSource.shortDescription || ""}`);
        lines.push(`State: ${infoSource.state || ""}`);
        lines.push(`Priority: ${infoSource.priority || ""}`);
        lines.push(`Assigned To: ${infoSource.assignedTo || ""}`);
        lines.push(`Group: ${infoSource.assignmentGroup || ""}`);
        const updatedOn2 = "updatedOn" in infoSource ? String((infoSource as Record<string, unknown>).updatedOn || "") : "";
        if (updatedOn2) lines.push(`Updated: ${updatedOn2}`);
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

    if (sub === "home") {
      emitEvent("cli", "Scraping SOW homepage dashboard...", "info", { metadata: { command: "snow home" } });
      try {
        const sowText = await scrapeSowHomepage(updatedProfile, navPathMap, baseUrl);
        if (sowText.length < 100) {
          return fail(`[snow home] SOW homepage returned only ${sowText.length} chars. Dashboard may not have loaded. Check bridge-status.`);
        }
        const sowIncidents = parseSnowListFromText(sowText, "incident", baseUrl, "personal");
        const sowChanges = parseSnowListFromText(sowText, "change", baseUrl, "personal");
        const sowRequests = parseSnowListFromText(sowText, "request", baseUrl, "personal");
        const allRecords = [...sowIncidents, ...sowChanges, ...sowRequests];
        snowCache = { records: allRecords, fetchedAt: Date.now() };
        await persistSnowResults(allRecords, "sow-home");
        const lines = [
          `=== SOW HOMEPAGE SCRAPE ===`, "",
          `  URL: ${baseUrl}/now/sow/home`,
          `  Page text: ${sowText.length} chars`,
          `  Incidents: ${sowIncidents.length}`,
          `  Changes:   ${sowChanges.length}`,
          `  Requests:  ${sowRequests.length}`,
          `  Total:     ${allRecords.length}`,
          "",
        ];
        if (allRecords.length === 0) {
          lines.push("No tickets parsed. Dashboard text preview (first 2000 chars):", "");
          lines.push(sowText.slice(0, 2000));
        } else {
          for (const r of allRecords.slice(0, 20)) {
            const sla = r.slaBreached ? " !!SLA" : "";
            lines.push(`  ${r.number.padEnd(15)} ${r.state.padEnd(12)} ${r.shortDescription.slice(0, 50)}${sla}`);
          }
        }
        return ok(lines.join(nl));
      } catch (e: any) {
        return fail(`[snow home] ${e.message}`);
      }
    }

    if (sub === "refresh") {
      emitEvent("cli", "Refreshing all ServiceNow data...", "info", { metadata: { command: "snow refresh" } });

      let incidents: CachedSnowRecord[] = [];
      let changes: CachedSnowRecord[] = [];
      let requests: CachedSnowRecord[] = [];
      let queueItems: CachedSnowRecord[] = [];
      let source = "classic";

      emitEvent("cli", "Trying SOW homepage dashboard scrape...", "info", { metadata: { command: "snow refresh" } });
      try {
        const sowText = await scrapeSowHomepage(updatedProfile, navPathMap, baseUrl);
        const sowTextLen = sowText.length;
        emitEvent("cli", `SOW homepage extracted: ${sowTextLen} chars`, "info", { metadata: { command: "snow refresh" } });

        if (sowTextLen > 200) {
          incidents = parseSnowListFromText(sowText, "incident", baseUrl, "personal");
          changes = parseSnowListFromText(sowText, "change", baseUrl, "personal");
          requests = parseSnowListFromText(sowText, "request", baseUrl, "personal");
          source = "sow-home";
          emitEvent("cli", `SOW parse: ${incidents.length} incidents, ${changes.length} changes, ${requests.length} requests`, "info", { metadata: { command: "snow refresh" } });
        } else {
          emitEvent("cli", "SOW homepage returned sparse content, falling back to classic nav paths", "warn", { metadata: { command: "snow refresh" } });
        }
      } catch (e: any) {
        emitEvent("cli", `SOW homepage scrape failed: ${e.message}, falling back to classic nav paths`, "warn", { metadata: { command: "snow refresh" } });
      }

      if (incidents.length === 0 && changes.length === 0 && requests.length === 0) {
        source = "classic";
        [incidents, changes, requests, queueItems] = await Promise.all([
          scrapeSnowNavPath("list-my-incidents", "incident", "personal"),
          scrapeSnowNavPath("list-my-changes", "change", "personal"),
          scrapeSnowNavPath("list-my-requests", "request", "personal"),
          scrapeSnowNavPath("list-group-queue", "incident", "team"),
        ]);
      } else {
        try {
          queueItems = await scrapeSnowNavPath("list-group-queue", "incident", "team");
        } catch {}
      }

      const personalRecords = [...incidents, ...changes, ...requests];
      const teamDeduped = queueItems.filter(qr => !personalRecords.some(pr => pr.number === qr.number));
      const allRecords = [...personalRecords, ...teamDeduped];
      snowCache = { records: allRecords, fetchedAt: Date.now() };
      await persistSnowResults(allRecords, "refresh");
      const lines = [
        `=== SNOW REFRESH COMPLETE (${source}) ===`, "",
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

    if (sub === "search") {
      const query = args.slice(1).join(" ").trim();
      if (!query) return fail("[snow] Usage: snow search <term>");
      const results = await storage.searchSnowTickets(query, 30);
      if (results.length === 0) return ok(`No tickets found matching "${query}".`);
      const lines = [`=== SNOW SEARCH: "${query}" === (${results.length} results)`, ""];
      results.forEach((t) => {
        const sla = t.slaBreached ? " !!SLA" : "";
        lines.push(`  ${t.number.padEnd(15)} ${t.state.padEnd(12)} ${t.shortDescription.slice(0, 50)}${sla}`);
      });
      return ok(lines.join(nl));
    }

    if (sub === "persisted" || sub === "db") {
      const tickets = await storage.getSnowTickets({ limit: 50 });
      if (tickets.length === 0) return ok("No persisted tickets. Run: snow refresh");
      const byType = new Map<string, typeof tickets>();
      for (const t of tickets) {
        if (!byType.has(t.type)) byType.set(t.type, []);
        byType.get(t.type)!.push(t);
      }
      const lines = [`=== SNOW PERSISTED === (${tickets.length} tickets)`, ""];
      for (const [type, items] of byType) {
        lines.push(`  ${type.toUpperCase()} (${items.length})`);
        for (const t of items.slice(0, 10)) {
          lines.push(`    ${t.number.padEnd(15)} ${t.state.padEnd(12)} ${t.shortDescription.slice(0, 45)}`);
        }
        if (items.length > 10) lines.push(`    ... +${items.length - 10} more`);
      }
      return ok(lines.join(nl));
    }

    return fail(`[snow] unknown subcommand "${sub}"${nl}Usage: snow [home|incidents|changes|requests|detail <number>|queue|refresh|search <term>|persisted]`);
  });

  let citrixKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  const CITRIX_KEEPALIVE_INTERVAL = 10 * 60 * 1000;

  async function doCitrixPing(): Promise<void> {
    try {
      const cfg = await storage.getAgentConfig("citrix_keepalive");
      if (cfg?.value !== "true") { stopCitrixKeepalive(); return; }

      const { isExtensionConnected, smartFetch } = await import("./bridge-queue");
      if (!isExtensionConnected()) {
        emitEvent("citrix", "Keepalive skipped — bridge not connected", "warn");
        return;
      }

      const portals = await storage.getAgentConfig("citrix_portals");
      let portalUrl = "https://cwp.ucsd.edu";
      if (portals?.value) {
        try {
          const parsed = JSON.parse(portals.value);
          if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].url) portalUrl = parsed[0].url;
        } catch {}
      }

      const result = await smartFetch(portalUrl, "dom", "citrix-keepalive", { maxText: 1000 }, 30000);
      const status = result.error ? `error: ${result.error}` : "OK";
      await storage.setAgentConfig("citrix_last_ping", new Date().toISOString(), "citrix");
      emitEvent("citrix", `Keepalive ping: ${status}`, result.error ? "warn" : "info");
    } catch (e: any) {
      emitEvent("citrix", `Keepalive ping failed: ${e.message}`, "warn");
    }
  }

  function startCitrixKeepalive(): void {
    if (citrixKeepaliveTimer) return;
    citrixKeepaliveTimer = setInterval(doCitrixPing, CITRIX_KEEPALIVE_INTERVAL);
    doCitrixPing();
    emitEvent("citrix", "Keepalive timer started (10m interval)", "info");
  }

  function stopCitrixKeepalive(): void {
    if (citrixKeepaliveTimer) {
      clearInterval(citrixKeepaliveTimer);
      citrixKeepaliveTimer = null;
      emitEvent("citrix", "Keepalive timer stopped", "info");
    }
  }

  (async () => {
    try {
      const cfg = await storage.getAgentConfig("citrix_keepalive");
      if (cfg?.value === "true") startCitrixKeepalive();
    } catch {}
  })();

  registerCommand("citrix", "Scrape Citrix workspace portal apps", "citrix [--save] | citrix clean | citrix portal [add|list|remove|scan]", async (args) => {
    const CITRIX_JUNK_SET = new Set(["open", "restart", "request", "cancel request", "add to favorites", "remove from favorites", "install", "more", "less", "cancel", "save", "refresh"]);
    const CITRIX_CAT_HEADER_RE = /^\[App\]\s*(Epic Non-Production|Epic Production|Epic Training|Epic Utilities|MyChart|Troubleshooting|Uncategorized)\s*\(\d+\)$/i;

    interface PortalConfig {
      name: string;
      url: string;
      lastScanned: string | null;
      appCount: number;
    }

    const DEFAULT_PORTAL: PortalConfig = { name: "UCSD CWP", url: "https://cwp.ucsd.edu", lastScanned: null, appCount: 0 };

    async function getPortals(): Promise<PortalConfig[]> {
      const cfg = await storage.getAgentConfig("citrix_portals");
      if (!cfg?.value) return [DEFAULT_PORTAL];
      try {
        const parsed: PortalConfig[] = JSON.parse(cfg.value);
        if (!Array.isArray(parsed) || parsed.length === 0) return [DEFAULT_PORTAL];
        if (!parsed.some(p => p.name === "UCSD CWP")) parsed.unshift(DEFAULT_PORTAL);
        return parsed;
      } catch { return [DEFAULT_PORTAL]; }
    }

    async function savePortals(portals: PortalConfig[]): Promise<void> {
      await storage.setAgentConfig("citrix_portals", JSON.stringify(portals), "citrix");
    }

    async function getPortalApps(portalName: string): Promise<Array<{ name: string; href: string }>> {
      const key = `citrix_portal_apps_${portalName.toLowerCase().replace(/\s+/g, "_")}`;
      const cfg = await storage.getAgentConfig(key);
      if (!cfg?.value) return [];
      try { return JSON.parse(cfg.value); } catch { return []; }
    }

    async function savePortalApps(portalName: string, apps: Array<{ name: string; href: string }>): Promise<void> {
      const key = `citrix_portal_apps_${portalName.toLowerCase().replace(/\s+/g, "_")}`;
      await storage.setAgentConfig(key, JSON.stringify(apps), "citrix");
    }

    const nl = String.fromCharCode(10);

    if (args[0] === "portal") {
      if (!args[1] || args[1] === "help") {
        return ok([
          "Citrix Portal Management",
          "========================",
          "  citrix portal list               - List configured portals",
          "  citrix portal add <url> --name <label>  - Add a new portal",
          "  citrix portal remove <name>      - Remove a portal",
          "  citrix portal scan <name>        - Scan portal for apps",
        ].join(nl));
      }

      if (args[1] === "list") {
        const portals = await getPortals();
        const lines = [`=== CITRIX PORTALS === (${portals.length})`, ""];
        for (let i = 0; i < portals.length; i++) {
          const p = portals[i];
          const scanned = p.lastScanned || "never";
          lines.push(`  ${i + 1}. ${p.name}`);
          lines.push(`     URL: ${p.url}`);
          lines.push(`     Apps: ${p.appCount}  Last scanned: ${scanned}`);
        }
        return ok(lines.join(nl));
      }

      if (args[1] === "add") {
        const rest = args.slice(2).join(" ");
        const nameIdx = rest.indexOf("--name");
        let url = "";
        let name = "";
        if (nameIdx >= 0) {
          url = rest.substring(0, nameIdx).trim();
          name = rest.substring(nameIdx + 6).trim();
        } else {
          url = rest.trim();
          try {
            name = new URL(url).hostname.replace(/\./g, " ").replace(/\b\w/g, c => c.toUpperCase());
          } catch {
            return fail("[citrix] Invalid URL. Usage: citrix portal add <url> --name <label>");
          }
        }
        if (!url || !url.startsWith("http")) return fail("[citrix] Invalid URL. Must start with http:// or https://");
        if (!name) return fail("[citrix] Name required. Usage: citrix portal add <url> --name <label>");

        const portals = await getPortals();
        if (portals.some(p => p.name.toLowerCase() === name.toLowerCase())) {
          return fail(`[citrix] Portal "${name}" already exists. Remove it first.`);
        }
        portals.push({ name, url, lastScanned: null, appCount: 0 });
        await savePortals(portals);
        return ok(`Portal added: ${name} -> ${url}`);
      }

      if (args[1] === "remove") {
        const name = args.slice(2).join(" ").trim();
        if (!name) return fail("[citrix] Usage: citrix portal remove <name>");
        const portals = await getPortals();
        const idx = portals.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
        if (idx < 0) return fail(`[citrix] Portal "${name}" not found.`);
        if (portals[idx].name === "UCSD CWP") return fail("[citrix] Cannot remove the default UCSD CWP portal.");
        const removed = portals.splice(idx, 1)[0];
        await savePortals(portals);
        const appKey = `citrix_portal_apps_${removed.name.toLowerCase().replace(/\s+/g, "_")}`;
        try { await storage.setAgentConfig(appKey, "[]", "citrix"); } catch {}
        return ok(`Portal removed: ${removed.name}`);
      }

      if (args[1] === "scan") {
        const portalName = args.slice(2).join(" ").trim();
        if (!portalName) return fail("[citrix] Usage: citrix portal scan <portal name>");

        const portals = await getPortals();
        const portal = portals.find(p => p.name.toLowerCase() === portalName.toLowerCase());
        if (!portal) return fail(`[citrix] Portal "${portalName}" not found. Use: citrix portal list`);

        const { submitJob, waitForResult, isExtensionConnected } = await import("./bridge-queue");
        if (!isExtensionConnected()) {
          return fail("[citrix] Chrome extension bridge not connected.");
        }

        emitEvent("cli", `Scanning Citrix portal: ${portal.name} (${portal.url}) via StoreFront API`, "info");

        const jobId = submitJob("dom", portal.url, `cli-citrix-scan-${portal.name}`, {
          maxText: 60000,
          reuseTab: true,
          spaWaitMs: 5000,
          citrixApiEnumerate: true,
        });
        const result = await waitForResult(jobId, 60000);

        if (result.error) return fail(`[citrix] Scan failed: ${result.error}`);

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

        const body = (result as any).body;
        if (body && body.resources) {
          for (const r of body.resources) {
            const name = r.name || r.Name || r.title || "";
            const launchUrl = r.launchurl || r.LaunchUrl || "";
            addApp(name, launchUrl);
          }
        }

        if (apps.length === 0) {
          const text = (result as any).text || "";
          const extracted = (result as any).extracted || {};
          if (extracted.apps && extracted.apps.length > 0) {
            for (const a of extracted.apps) addApp(a.text || "", a.href || "");
          }
          if (apps.length === 0 && extracted.allLinks) {
            for (const link of extracted.allLinks) {
              const t = (link.text || "").trim();
              const h = link.href || "";
              if (t.length >= 2 && t.length <= 80) {
                if (h.includes("launch") || h.includes("app") || h.includes("resource") || h.includes("citrix")) {
                  addApp(t, h);
                }
              }
            }
          }
        }

        await savePortalApps(portal.name, apps);
        portal.lastScanned = new Date().toISOString().split("T")[0];
        portal.appCount = apps.length;
        await savePortals(portals);

        if (apps.length === 0) {
          return ok(`Scanned ${portal.name}: no apps found via StoreFront API. Portal may require authentication.`);
        }

        const lines = [`=== ${portal.name} APPS === (${apps.length})`, ""];
        for (let i = 0; i < apps.length; i++) {
          lines.push(`  ${String(i + 1).padStart(3)}  ${apps[i].name}`);
        }
        lines.push("", `Apps saved for portal "${portal.name}" (via StoreFront API).`);
        return ok(lines.join(nl));
      }

      return fail(`[citrix] Unknown portal command: ${args[1]}. Use: citrix portal help`);
    }

    if (args[0] === "launch") {
      const rawArgs = args.slice(1).join(" ").trim();
      const portalFlag = rawArgs.match(/--portal\s+(.+?)(?:\s*$)/i);
      const appName = portalFlag ? rawArgs.replace(portalFlag[0], "").trim() : rawArgs;
      if (!appName) return fail("[citrix] Usage: citrix launch <app name> [--portal <name>]");

      const portals = await getPortals();
      let portalUrl = "https://cwp.ucsd.edu";
      let portalLabel = "UCSD CWP";

      if (portalFlag) {
        const pName = portalFlag[1].trim();
        const portal = portals.find(p => p.name.toLowerCase() === pName.toLowerCase());
        if (!portal) return fail(`[citrix] Portal "${pName}" not found. Use: citrix portal list`);
        portalUrl = portal.url;
        portalLabel = portal.name;
      }

      const { submitJob, waitForResult, isExtensionConnected } = await import("./bridge-queue");
      if (!isExtensionConnected()) {
        return fail("[citrix] Bridge not connected. Cannot launch Citrix apps without browser session.");
      }
      emitEvent("cli", `Launching Citrix app: ${appName} from ${portalLabel}`, "info", { metadata: { command: "citrix" } });
      const launchJobId = submitJob("dom", portalUrl, "cli-citrix-launch", {
        maxText: 2000,
        reuseTab: true,
        spaWaitMs: 2000,
        citrixApiLaunch: appName,
        autoOpenDownload: true,
        pollTimeoutMs: 15000,
      });
      const launchResult = await waitForResult(launchJobId, 60000);
      if (launchResult.error) return fail(`[citrix launch] ${launchResult.error}`);
      const cd = (launchResult as any).clickDebug;
      if (cd) {
        emitEvent("cli", `Citrix launch debug: ${JSON.stringify(cd).substring(0, 500)}`, "info", { metadata: { command: "citrix" } });
      }
      if (cd?.error) return fail(`[citrix launch] ${cd.error}`);
      const method = cd?.method || "unknown";
      const matched = cd?.matchedApp || appName;
      return ok(`Launched "${matched}" via ${portalLabel} [${method}]`);
    }

    if (args[0] === "workspace") {
      const configKey = "citrix_workspace_apps";
      const DESKTOP_PATH = "C:/Users/mjensen/OneDrive - University of California, San Diego Health/Desktop";
      const DEFAULT_WORKSPACE_APPS = [
        { app: "SUP Hyperdrive", portal: "UCSD CWP" },
        { app: "POC Hyperdrive", portal: "UCSD CWP" },
        { app: "TST Hyperdrive", portal: "UCSD CWP" },
        { app: "SUP Text Access", portal: "UCSD CWP" },
        { app: "POC Text Access", portal: "UCSD CWP" },
        { app: "TST Text Access", portal: "UCSD CWP" },
      ];

      interface WorkspaceEntry { app: string; portal: string }

      function parseWorkspaceConfig(raw: string | null): WorkspaceEntry[] {
        if (!raw) return DEFAULT_WORKSPACE_APPS;
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            if (typeof parsed[0] === "string") {
              return parsed.map((a: string) => {
                const atIdx = a.lastIndexOf("@");
                if (atIdx > 0) return { app: a.substring(0, atIdx).trim(), portal: a.substring(atIdx + 1).trim() };
                return { app: a, portal: "UCSD CWP" };
              });
            }
            return parsed as WorkspaceEntry[];
          }
        } catch {}
        return DEFAULT_WORKSPACE_APPS;
      }

      let raw: string | null = null;
      try {
        const cfg = await storage.getAgentConfig(configKey);
        raw = cfg?.value || null;
      } catch {}
      const wsApps = parseWorkspaceConfig(raw);

      if (args[1] === "set") {
        const appList = args.slice(2).join(" ").split(",").map(s => s.trim()).filter(Boolean);
        if (!appList.length) return fail("[citrix] Usage: citrix workspace set App1, App2@Portal, App3");
        const entries: WorkspaceEntry[] = appList.map(a => {
          const atIdx = a.lastIndexOf("@");
          if (atIdx > 0) return { app: a.substring(0, atIdx).trim(), portal: a.substring(atIdx + 1).trim() };
          return { app: a, portal: "UCSD CWP" };
        });
        await storage.setAgentConfig(configKey, JSON.stringify(entries), "citrix");
        return ok(`Workspace apps set: ${entries.map(e => e.portal !== "UCSD CWP" ? `${e.app}@${e.portal}` : e.app).join(", ")}`);
      }
      if (args[1] === "list") {
        if (!wsApps.length) return ok(`No workspace apps configured.${nl}Use: citrix workspace set App1, App2@PortalName, App3`);
        return ok(`Workspace apps:${nl}${wsApps.map((e: WorkspaceEntry, i: number) => `  ${i + 1}. ${e.app}${e.portal !== "UCSD CWP" ? ` [${e.portal}]` : ""}`).join(nl)}`);
      }
      if (!wsApps.length) {
        return fail(`[citrix] No workspace apps configured.${nl}Use: citrix workspace set SUP Text Access, PRD Hyperspace@MyPortal${nl}Then: citrix workspace`);
      }
      const { isExtensionConnected, submitJob } = await import("./bridge-queue");
      if (!isExtensionConnected()) {
        return fail("[citrix] Bridge not connected.");
      }

      const portals = await getPortals();
      const results: string[] = [];
      for (const entry of wsApps) {
        try {
          const portal = portals.find(p => p.name.toLowerCase() === entry.portal.toLowerCase());
          const portalUrl = portal?.url || "https://cwp.ucsd.edu";
          submitJob("dom", portalUrl, "cli-citrix-workspace", {
            maxText: 2000,
            reuseTab: true,
            spaWaitMs: 2000,
            citrixApiLaunch: entry.app,
            autoOpenDownload: true,
            pollTimeoutMs: 15000,
          });
          const suffix = entry.portal !== "UCSD CWP" ? ` [${entry.portal}]` : "";
          results.push(`  [+] ${entry.app}${suffix}: queued`);
        } catch (e: any) {
          results.push(`  [-] ${entry.app}: ${e.message}`);
        }
      }
      return ok(`Workspace: ${wsApps.length} apps queued${nl}${results.join(nl)}`);
    }

    if (args[0] === "keepalive") {
      const nl = String.fromCharCode(10);
      if (args[1] === "on") {
        await storage.setAgentConfig("citrix_keepalive", "true", "citrix");
        startCitrixKeepalive();
        return ok(`Citrix keepalive enabled. Portal pinged every 10 minutes to prevent idle timeout.`);
      }
      if (args[1] === "off") {
        await storage.setAgentConfig("citrix_keepalive", "false", "citrix");
        stopCitrixKeepalive();
        return ok("Citrix keepalive disabled.");
      }
      const cfg = await storage.getAgentConfig("citrix_keepalive");
      const lastPing = await storage.getAgentConfig("citrix_last_ping");
      const pingInfo = lastPing?.value ? ` Last ping: ${lastPing.value}` : "";
      return ok(`Citrix keepalive is ${cfg?.value === "true" ? "ON" : "OFF"}.${pingInfo}${nl}Usage: citrix keepalive on|off`);
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

  registerCommand("epic", "Epic Hyperspace activity tools", "epic [view|do|screen|fields|menu|search|go|activities|navigate|screenshot|click|status|setup] <env> [target]", async (args) => {
    const nl = String.fromCharCode(10);
    const EPIC_ENVS = new Set(["SUP", "POC", "TST", "PRD", "BLD", "REL", "DEM", "MST"]);

    function renderElementLines(elements: any[]): string[] {
      const lines: string[] = [];
      const groups = new Map<string, any[]>();
      for (const el of elements) {
        const group = el.parent || "Window";
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group)!.push(el);
      }
      for (const [group, items] of groups) {
        lines.push(`--- ${group} ---`);
        for (const el of items) {
          const hintLabel = el.hint ? `[${el.hint}]` : "    ";
          const ct = (el.controlType || "").padEnd(12);
          const name = el.name || "";
          const enabled = el.enabled === false ? " (disabled)" : "";
          let suffix = "";
          if (el.value) suffix = ` = "${el.value}"`;
          if (el.checked === true) suffix = " [x]";
          if (el.checked === false) suffix = " [ ]";
          if (el.static) {
            lines.push(`     ${ct} ${name}${suffix}`);
          } else {
            lines.push(`  ${hintLabel.padEnd(5)} ${ct} ${name}${enabled}${suffix}`);
          }
        }
        lines.push("");
      }
      return lines;
    }

    function slugify(name: string): string {
      return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    }

    function formatAge(ms: number): string {
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return `${sec}s ago`;
      const min = Math.floor(sec / 60);
      if (min < 60) return `${min}m ago`;
      const hr = Math.floor(min / 60);
      if (hr < 24) return `${hr}h ago`;
      return `${Math.floor(hr / 24)}d ago`;
    }

    async function cacheFieldLayout(env: string, activity: string, elements: any[], windowTitle: string): Promise<void> {
      if (!activity) return;
      const slug = slugify(activity);
      const key = `epic_fields_${env.toLowerCase()}_${slug}`;
      const cache = {
        activity,
        elements,
        window: windowTitle,
        timestamp: Date.now(),
        fieldCount: elements.filter((e: any) => !e.static).length,
      };
      await storage.setAgentConfig(key, JSON.stringify(cache), "epic");
      await storage.setAgentConfig(`epic_current_activity_${env.toLowerCase()}`, activity, "epic");
    }

    if (args[0] === "activities") {
      const env = (args[1] || "SUP").toUpperCase();
      const key = `epic_activities_${env.toLowerCase()}`;
      const cfg = await storage.getAgentConfig(key);
      let acts: any[] = [];
      if (cfg?.value) {
        try {
          const parsed = JSON.parse(cfg.value);
          if (Array.isArray(parsed)) {
            acts = parsed;
          } else if (parsed.activities && Array.isArray(parsed.activities)) {
            acts = parsed.activities;
          }
        } catch {}
      }
      if (!acts.length) return ok(`No activities cataloged for ${env}.${nl}Run: epic search-crawl ${env}`);
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
        "  - Post results to Rachael TreeView",
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
    if (args[0] === "login") {
      const { getSecret } = await import("./secrets");
      const { smartFetch, isExtensionConnected } = await import("./bridge-queue");

      if (args[1] === "--setup") {
        const epicUser = await getSecret("epic_username");
        const epicPass = await getSecret("epic_password");
        const lines = [
          "=== EPIC LOGIN SETUP ===",
          "",
          `  EPIC_USERNAME: ${epicUser ? "configured" : "NOT SET"}`,
          `  EPIC_PASSWORD: ${epicPass ? "configured" : "NOT SET"}`,
          `  Bridge:        ${isExtensionConnected() ? "connected" : "NOT connected"}`,
          "",
        ];
        if (!epicUser || !epicPass) {
          lines.push("  To configure credentials:");
          lines.push("    secrets request epic_username epic_password --purpose \"Epic CWP/Hyperspace login\"");
        }
        if (!isExtensionConnected()) {
          lines.push("  Bridge extension must be connected for web form fill.");
        }
        if (epicUser && epicPass && isExtensionConnected()) {
          lines.push("  All systems ready. Run: epic login");
        }
        return ok(lines.join(nl));
      }

      const epicUser = await getSecret("epic_username");
      const epicPass = await getSecret("epic_password");
      if (!epicUser || !epicPass) {
        return fail("[epic login] Credentials not configured. Run: epic login --setup");
      }
      if (!isExtensionConnected()) {
        return fail("[epic login] Bridge extension not connected. Run: bridge-status");
      }

      const target = args[1] || "all";
      const results: string[] = ["=== EPIC LOGIN ===", ""];
      let cwpDone = false;
      let hswDone = false;

      if (target === "all" || target === "cwp") {
        emitEvent("cli", "Authenticating CWP portal...", "info", { metadata: { command: "epic login" } });
        try {
          const cwpResult = await smartFetch("https://cwp.ucsd.edu", "dom", "epic-login-cwp", {
            reuseTab: true,
            spaWaitMs: 5000,
            fillFields: {
              'input[name="username"], input[type="text"][id*="user"], #username, input[name="login"]': epicUser,
              'input[name="password"], input[type="password"], #password': epicPass,
            },
            submitSelector: 'button[type="submit"], input[type="submit"], #loginButton, button[name="submit"]',
            fillDelayMs: 300,
            waitAfterSubmitMs: 8000,
            maxText: 5000,
          }, 60000);
          if (cwpResult.error) {
            results.push(`  CWP: FAILED - ${cwpResult.error}`);
          } else {
            cwpDone = true;
            results.push("  CWP: Credentials filled. Waiting for Duo approval...");
            results.push("       (Approve the Duo push on your phone)");
          }
        } catch (e: unknown) {
          results.push(`  CWP: ERROR - ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (target === "all" || target === "hsw") {
        emitEvent("cli", "Authenticating Hyperspace Web...", "info", { metadata: { command: "epic login" } });
        try {
          const hswUrl = "https://epicweb.ucsd.edu";
          const hswResult = await smartFetch(hswUrl, "dom", "epic-login-hsw", {
            reuseTab: true,
            spaWaitMs: 5000,
            fillFields: {
              'input[name="username"], input[type="text"][id*="user"], #username': epicUser,
              'input[name="password"], input[type="password"], #password': epicPass,
            },
            submitSelector: 'button[type="submit"], input[type="submit"], #loginButton',
            fillDelayMs: 300,
            waitAfterSubmitMs: 8000,
            maxText: 5000,
          }, 60000);
          if (hswResult.error) {
            results.push(`  Hyperspace Web: FAILED - ${hswResult.error}`);
          } else {
            hswDone = true;
            results.push("  Hyperspace Web: Credentials filled. Waiting for Duo approval...");
          }
        } catch (e: unknown) {
          results.push(`  Hyperspace Web: ERROR - ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (target === "all" || target === "text") {
        const agentPort = process.env.PORT || 5000;
        try {
          const statusResp = await fetch(`http://localhost:${agentPort}/api/epic/agent/status`);
          const statusData = statusResp.ok ? await statusResp.json() as { connected?: boolean } : { connected: false };
          if (!statusData.connected) {
            results.push("  Text/PuTTY: Desktop agent not connected (skipped).");
            results.push("              Launch Text from CWP portal after Duo approval.");
          } else {
            const resp = await fetch(`http://localhost:${agentPort}/api/epic/agent/send`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "login",
                credentials: { username: epicUser, password: epicPass },
              }),
            });
            const data = resp.ok ? await resp.json() as { ok?: boolean; commandId?: string } : { ok: false };
            if (data.ok && data.commandId) {
              results.push("  Text/PuTTY: Login command queued for desktop agent.");
              results.push("              Agent will handle double-login sequence.");
              const pollStart = Date.now();
              const POLL_TIMEOUT = 30000;
              const POLL_INTERVAL = 3000;
              let loginResult: string | null = null;
              while (Date.now() - pollStart < POLL_TIMEOUT) {
                await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
                try {
                  const resultResp = await fetch(`http://localhost:${agentPort}/api/epic/agent/result/${data.commandId}`);
                  if (resultResp.ok) {
                    const resultData = await resultResp.json() as { result?: { status?: string; error?: string } };
                    if (resultData.result) {
                      loginResult = resultData.result.status === "ok" ? "SUCCESS" : `FAILED: ${resultData.result.error || "unknown"}`;
                      break;
                    }
                  }
                } catch {
                  // Agent may still be processing
                }
              }
              if (loginResult) {
                results.push(`              Result: ${loginResult}`);
              } else {
                results.push("              (Still processing — check with: epic status)");
              }
            } else {
              results.push("  Text/PuTTY: Failed to queue login command.");
            }
          }
        } catch (e: unknown) {
          results.push(`  Text/PuTTY: ${e instanceof Error ? e.message : "Desktop agent not reachable (skipped)."}`);
        }
      }

      await storage.setAgentConfig("boot_last_login", new Date().toISOString(), "boot");

      results.push("");
      if (cwpDone || hswDone) {
        results.push("  Tap Duo approve on your phone to complete authentication.");
      }
      results.push("  Re-run specific targets: epic login cwp | epic login hsw | epic login text");
      return ok(results.join(nl));
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
        "  - Polls Rachael for commands every 3s",
        "  - Takes screenshots on demand",
        "  - Navigates Hyperspace via Claude vision",
        "  - Clicks buttons/menus by name",
        "",
        "Commands:",
        "  epic search SUP patient     - fuzzy search and return results",
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
      if (args[1] === "--clear") {
        const env = (args[2] || "SUP").toUpperCase();
        const client = args[3] || "hyperspace";
        const key = `epic_tree_${env.toLowerCase()}_${client}`;
        await storage.setAgentConfig(key, "", "epic");
        return ok(`Cleared ${client} tree for ${env}. Next menu-crawl will do a full scan.`);
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

    if (args[0] === "menu-crawl") {
      const clientArg = args.find(a => a === "text" || a === "hyperspace") || "hyperspace";
      const envArg = args.find(a => ["SUP", "POC", "TST", "PRD"].includes(a.toUpperCase()) && a !== clientArg);
      const env = (envArg || "SUP").toUpperCase();
      const depthArg = args.find(a => /^\d+$/.test(a) && parseInt(a) <= 10);
      const depth = parseInt(depthArg || "4", 10);
      const client = clientArg;
      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "menu_crawl", env, depth, client }),
        });
        const data = await resp.json() as any;
        if (client === "text") {
          if (data.ok) return ok(`Text menu crawl started for ${env}. Command ID: ${data.commandId}${nl}The agent will type numbered menu options into the Epic Text terminal.${nl}This may take several minutes. Check the tree afterwards with: epic tree`);
        } else {
          if (data.ok) return ok(`Menu crawl started for ${env} (depth=${depth}). Command ID: ${data.commandId}${nl}The agent will click through each menu and use AI vision to catalog all items.${nl}This may take several minutes. Check the tree afterwards with: epic tree`);
        }
        return fail(`[epic] Failed to send menu-crawl command`);
      } catch (e: any) {
        return fail(`[epic] ${e.message}`);
      }
    }

    if (args[0] === "search") {
      const env = (args[1] || "SUP").toUpperCase();
      const queryText = args.slice(2).join(" ");
      if (!queryText) return fail("[epic] Usage: epic search SUP patient lookup");
      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "search", env, query: queryText }),
        });
        const sendData = await resp.json() as any;
        if (!sendData.ok) return fail("[epic] Failed to send search command");
        const cmdId = sendData.commandId;
        const maxWait = 30000;
        const pollInterval = 1500;
        let elapsed = 0;
        while (elapsed < maxWait) {
          await new Promise(r => setTimeout(r, pollInterval));
          elapsed += pollInterval;
          const pollResp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/result/${cmdId}`);
          const result = await pollResp.json() as any;
          if (result.status === "pending") continue;
          if (result.status === "error") {
            return fail(`[epic] Search failed: ${result.error || "unknown error"}`);
          }
          if (result.status === "complete" && result.data) {
            const d = result.data;
            const items = d.items || [];
            if (items.length === 0) {
              return ok(`No results for "${queryText}" in ${env}.`);
            }
            const header = `=== EPIC SEARCH: "${queryText}" (${env}) === ${items.length} result${items.length !== 1 ? "s" : ""}${d.truncated ? " (truncated)" : ""}`;
            const rows: string[] = [header, ""];
            for (let i = 0; i < items.length; i++) {
              const item = items[i];
              const cat = item.category ? ` [${item.category}]` : "";
              rows.push(`  ${String(i + 1).padStart(2)}. ${item.name}${cat}`);
            }
            if (d.truncated) {
              rows.push("");
              rows.push("  (more results may exist - refine your query)");
            }
            return ok(rows.join(nl));
          }
        }
        return fail(`[epic] Search timed out after ${maxWait / 1000}s. Command ID: ${cmdId}`);
      } catch (e: any) {
        return fail(`[epic] ${e.message}`);
      }
    }

    if (args[0] === "search-crawl") {
      const envArg = args.find(a => ["SUP", "POC", "TST", "PRD"].includes(a.toUpperCase()));
      const env = (envArg || "SUP").toUpperCase();
      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "search_crawl", env }),
        });
        const data = await resp.json() as any;
        if (data.ok) return ok(`Search-based activity discovery started for ${env}. Command ID: ${data.commandId}${nl}The agent will type A-Z in the search bar and read autocomplete results.${nl}Progress saves after each letter. Check results with: epic activities ${env}`);
        return fail(`[epic] Failed to send search-crawl command`);
      } catch (e: any) {
        return fail(`[epic] ${e.message}`);
      }
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

      const aliasCfg = await storage.getAgentConfig("epic_aliases");
      let epicAliases: Record<string, string> = {};
      if (aliasCfg?.value) {
        try { epicAliases = JSON.parse(aliasCfg.value); } catch {}
      }
      const resolvedAlias = epicAliases[target.toLowerCase()];
      const effectiveTarget = resolvedAlias || target;

      if (effectiveTarget.includes(">")) {
        const isTextPath = /^\d+\s/.test(effectiveTarget.split(">")[0].trim());
        resolved = { path: effectiveTarget, client: isTextPath ? "text" : "hyperspace", name: resolvedAlias ? `${target} -> ${effectiveTarget}` : effectiveTarget };
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

    if (args[0] === "view") {
      const firstArg = (args[1] || "").toUpperCase();
      const env = EPIC_ENVS.has(firstArg) ? firstArg : "SUP";
      const restArgs = EPIC_ENVS.has(firstArg) ? args.slice(2) : args.slice(1);
      const showAll = restArgs.includes("--all");
      let focus = "";
      const focusIdx = restArgs.indexOf("--focus");
      if (focusIdx !== -1 && restArgs[focusIdx + 1]) {
        focus = restArgs.slice(focusIdx + 1).filter(a => a !== "--all").join(" ");
      }

      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "view", env, showAll, focus }),
        });
        const sendData = await resp.json() as any;
        if (!sendData.ok) return fail("[epic] Failed to send view command");
        const cmdId = sendData.commandId;

        let result: any = null;
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 500));
          const poll = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/result/${cmdId}`);
          const pollData = await poll.json() as any;
          if (pollData.status && pollData.status !== "pending") {
            result = pollData;
            break;
          }
        }

        if (!result) return fail("[epic] View timed out (30s). Is the desktop agent running?");
        if (result.status === "error") return fail(`[epic] ${result.error || "View failed"}`);

        const d = result.data || {};
        const elements = d.elements || [];
        const window = d.window || "Unknown";
        const focusLabel = d.focus || "";

        const activityName = d.activity || "";
        if (activityName) {
          await cacheFieldLayout(env, activityName, elements, window);
        }

        if (!elements.length) {
          return ok(`=== EPIC VIEW: ${env} ===${nl}Window: ${window}${activityName ? `${nl}Activity: ${activityName}` : ""}${focusLabel ? `${nl}Focus: ${focusLabel}` : ""}${nl}${nl}No interactive elements found.`);
        }

        const lines: string[] = [];
        lines.push(`=== EPIC VIEW: ${env} ===`);
        lines.push(`Window: ${window}`);
        if (activityName) lines.push(`Activity: ${activityName}`);
        if (focusLabel) lines.push(`Focus: ${focusLabel}`);
        lines.push(`Elements: ${d.interactiveCount || 0} interactive` + (showAll ? `, ${elements.length} total` : ""));
        lines.push("");
        lines.push(...renderElementLines(elements));
        lines.push(`Interact: epic do ${env} <hint> [value]`);
        lines.push(`Refresh:  epic view ${env}`);
        if (activityName) lines.push(`Cached:   epic fields ${env} ${activityName.toLowerCase()}`);
        return ok(lines.join(nl));
      } catch (e: any) {
        return fail(`[epic] ${e.message}`);
      }
    }

    if (args[0] === "screen") {
      const firstArg = (args[1] || "").toUpperCase();
      const hasEnv = EPIC_ENVS.has(firstArg);
      const env = hasEnv ? firstArg : "SUP";
      const target = (hasEnv ? args.slice(2) : args.slice(1)).join(" ");
      if (!target) return fail(`[epic] Usage: epic screen [env] <activity>${nl}Example: epic screen chart`);

      function fMatchScreen(text: string, q: string): boolean {
        const lower = text.toLowerCase();
        const words = q.toLowerCase().split(/\s+/);
        return words.every(w => lower.includes(w));
      }

      function findInTreeScreen(node: any, query: string, client: string): { path: string; client: string; name: string } | null {
        for (const child of (node.children || [])) {
          if (fMatchScreen(child.name || "", query)) {
            return { path: child.path || child.name, client, name: child.name };
          }
          const found = findInTreeScreen(child, query, client);
          if (found) return found;
        }
        return null;
      }

      let resolved: { path: string; client: string; name: string } | null = null;

      const aliasCfg = await storage.getAgentConfig("epic_aliases");
      let epicAliases: Record<string, string> = {};
      if (aliasCfg?.value) {
        try { epicAliases = JSON.parse(aliasCfg.value); } catch {}
      }
      const resolvedAlias = epicAliases[target.toLowerCase()];
      const effectiveTarget = resolvedAlias || target;

      if (effectiveTarget.includes(">")) {
        const isTextPath = /^\d+\s/.test(effectiveTarget.split(">")[0].trim());
        resolved = { path: effectiveTarget, client: isTextPath ? "text" : "hyperspace", name: resolvedAlias ? `${target} -> ${effectiveTarget}` : effectiveTarget };
      } else {
        for (const client of ["hyperspace", "text"]) {
          const key = `epic_tree_${env.toLowerCase()}_${client}`;
          const cfg = await storage.getAgentConfig(key);
          if (cfg?.value) {
            try {
              const tree = JSON.parse(cfg.value);
              const found = findInTreeScreen(tree, effectiveTarget, client);
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
              const match = acts.find((a: any) => fMatchScreen(a.name || "", effectiveTarget));
              if (match) resolved = { path: match.name, client: "hyperspace", name: match.name };
            } catch {}
          }
        }
      }

      if (!resolved) return fail(`[epic] No activity matching "${target}" in ${env} tree.${nl}Run: epic search ${target}`);

      try {
        const navResp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "navigate_path", env, path: resolved.path, client: resolved.client }),
        });
        const navData = await navResp.json() as any;
        if (!navData.ok) return fail("[epic] Failed to send navigation command");
        const navCmdId = navData.commandId;

        let navCompleted = false;
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 500));
          const poll = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/result/${navCmdId}`);
          const pollData = await poll.json() as any;
          if (pollData.status === "error") return fail(`[epic] Navigation failed: ${pollData.error || "unknown error"}`);
          if (pollData.status && pollData.status !== "pending") { navCompleted = true; break; }
        }

        if (!navCompleted) return fail("[epic] Navigation timed out (30s). Is the desktop agent running?");

        await new Promise(r => setTimeout(r, 1500));

        const viewResp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "view", env, _activity_label: resolved.name }),
        });
        const viewData = await viewResp.json() as any;
        if (!viewData.ok) return fail("[epic] Failed to send view command");
        const viewCmdId = viewData.commandId;

        let viewResult: any = null;
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 500));
          const poll = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/result/${viewCmdId}`);
          const pollData = await poll.json() as any;
          if (pollData.status && pollData.status !== "pending") {
            viewResult = pollData;
            break;
          }
        }

        if (!viewResult) return fail("[epic] View timed out (30s). Is the desktop agent running?");
        if (viewResult.status === "error") return fail(`[epic] ${viewResult.error || "View failed"}`);

        const d = viewResult.data || {};
        const elements = d.elements || [];
        const windowTitle = d.window || "Unknown";
        const activityLabel = d.activity || resolved.name;

        if (activityLabel) {
          await cacheFieldLayout(env, activityLabel, elements, windowTitle);
        }

        const lines: string[] = [];
        lines.push(`=== EPIC SCREEN: ${env} ===`);
        lines.push(`Activity: ${activityLabel}`);
        lines.push(`Window: ${windowTitle}`);
        lines.push(`Elements: ${elements.filter((e: any) => !e.static).length} interactive`);
        lines.push(`Cached: yes`);
        lines.push("");

        if (elements.length) {
          lines.push(...renderElementLines(elements));
        } else {
          lines.push("No interactive elements found.");
          lines.push("");
        }

        lines.push(`Interact: epic do ${env} <hint> [value]`);
        lines.push(`Cached:   epic fields ${env} ${activityLabel.toLowerCase()}`);
        lines.push(`Refresh:  epic screen ${env} ${target}`);
        return ok(lines.join(nl));
      } catch (e: any) {
        return fail(`[epic] ${e.message}`);
      }
    }

    if (args[0] === "fields") {
      const firstArg = (args[1] || "").toUpperCase();
      const hasEnv = EPIC_ENVS.has(firstArg);
      const env = hasEnv ? firstArg : "SUP";
      const activity = (hasEnv ? args.slice(2) : args.slice(1)).join(" ");

      const allConfigs = await storage.getAgentConfigs();
      const prefix = `epic_fields_${env.toLowerCase()}_`;
      const fieldConfigs = allConfigs.filter(c => c.key.startsWith(prefix));

      if (!activity) {
        if (!fieldConfigs.length) return ok(`No cached field layouts for ${env}.${nl}Run: epic screen ${env} <activity>`);

        const lines: string[] = [];
        lines.push(`=== EPIC FIELDS: ${env} === (${fieldConfigs.length} cached)`);
        lines.push("");

        for (const cfg of fieldConfigs) {
          try {
            const cache = JSON.parse(cfg.value);
            const age = Date.now() - (cache.timestamp || 0);
            const stale = age > 300000 ? " (stale)" : "";
            lines.push(`  ${(cache.activity || cfg.key.replace(prefix, "")).padEnd(30)} ${String(cache.fieldCount || 0).padStart(3)} fields  ${formatAge(age)}${stale}`);
          } catch {
            lines.push(`  ${cfg.key.replace(prefix, "").padEnd(30)} (invalid cache)`);
          }
        }
        lines.push("");
        lines.push(`View: epic fields ${env} <activity>`);
        lines.push(`Refresh: epic screen ${env} <activity>`);
        return ok(lines.join(nl));
      }

      const slug = slugify(activity);
      let matchedCfg = fieldConfigs.find(c => c.key === `${prefix}${slug}`);
      if (!matchedCfg) {
        matchedCfg = fieldConfigs.find(c => {
          try {
            const cache = JSON.parse(c.value);
            return (cache.activity || "").toLowerCase().includes(activity.toLowerCase());
          } catch { return false; }
        });
      }

      if (!matchedCfg) {
        return fail(`[epic] No cached fields for "${activity}" in ${env}.${nl}Run: epic screen ${env} ${activity}`);
      }

      try {
        const cache = JSON.parse(matchedCfg.value);
        const elements = cache.elements || [];
        const age = Date.now() - (cache.timestamp || 0);
        const staleMsg = age > 300000 ? `${nl}(stale - last updated ${formatAge(age)}, run: epic screen ${env} ${activity})` : "";

        const lines: string[] = [];
        lines.push(`=== EPIC FIELDS: ${env} / ${cache.activity || activity} ===`);
        lines.push(`Window: ${cache.window || "Unknown"}`);
        lines.push(`Fields: ${cache.fieldCount || 0} interactive`);
        lines.push(`Updated: ${formatAge(age)}${age > 300000 ? " (stale)" : ""}`);
        lines.push("");

        if (elements.length) {
          lines.push(...renderElementLines(elements));
        } else {
          lines.push("No elements cached.");
          lines.push("");
        }

        lines.push(`Interact: epic do ${env} <hint> [value]`);
        lines.push(`Refresh:  epic screen ${env} ${activity}${staleMsg}`);
        return ok(lines.join(nl));
      } catch {
        return fail(`[epic] Corrupted cache for "${activity}". Run: epic screen ${env} ${activity}`);
      }
    }

    if (args[0] === "do") {
      const firstArg = (args[1] || "").toUpperCase();
      const hasEnv = EPIC_ENVS.has(firstArg);
      const env = hasEnv ? firstArg : "SUP";
      const hint = (hasEnv ? args[2] || "" : args[1] || "").toLowerCase();
      const value = (hasEnv ? args.slice(3) : args.slice(2)).join(" ");
      if (!hint) {
        let hintHelp = "";
        const currentActCfg = await storage.getAgentConfig(`epic_current_activity_${env.toLowerCase()}`);
        const currentActivity = currentActCfg?.value || "";
        if (currentActivity) {
          const cacheKey = `epic_fields_${env.toLowerCase()}_${slugify(currentActivity)}`;
          const cacheCfg = await storage.getAgentConfig(cacheKey);
          if (cacheCfg?.value) {
            try {
              const cache = JSON.parse(cacheCfg.value);
              const hints = (cache.elements || []).filter((e: any) => e.hint).slice(0, 15);
              if (hints.length) {
                hintHelp = `${nl}${nl}Current activity: ${cache.activity || currentActivity}${nl}Available hints:`;
                for (const h of hints) {
                  hintHelp += `${nl}  [${h.hint}] ${h.controlType || ""} ${h.name || ""}`;
                }
              }
            } catch {}
          }
        }
        return fail(`[epic] Usage: epic do [env] <hint> [value]${nl}Run 'epic view' first to see available hints.${hintHelp}`);
      }

      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "do", env, hint, value }),
        });
        const sendData = await resp.json() as any;
        if (!sendData.ok) return fail("[epic] Failed to send do command");
        const cmdId = sendData.commandId;

        let result: any = null;
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 500));
          const poll = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/result/${cmdId}`);
          const pollData = await poll.json() as any;
          if (pollData.status && pollData.status !== "pending") {
            result = pollData;
            break;
          }
        }

        if (!result) return fail("[epic] Action timed out (30s). Is the desktop agent running?");
        if (result.status === "error") return fail(`[epic] ${result.error || "Action failed"}`);

        const d = result.data || {};
        const elements = d.elements || [];
        const window = d.window || "Unknown";
        const activityName = d.activity || "";

        if (activityName) {
          await cacheFieldLayout(env, activityName, elements, window);
        }

        const lines: string[] = [];
        lines.push(`=== EPIC DO: ${env} [${hint}]${value ? ` = "${value}"` : ""} ===`);
        lines.push(`Window: ${window}`);
        if (activityName) lines.push(`Activity: ${activityName}`);
        lines.push(`Action: complete`);
        lines.push("");

        if (elements.length) {
          lines.push(...renderElementLines(elements));
        }

        lines.push(`Next: epic do ${env} <hint> [value]`);
        return ok(lines.join(nl));
      } catch (e: any) {
        return fail(`[epic] ${e.message}`);
      }
    }

    if (args[0] === "menu") {
      const firstArg = (args[1] || "").toUpperCase();
      const hasEnv = EPIC_ENVS.has(firstArg);
      const envArg = hasEnv ? firstArg : "SUP";
      const restArgs = hasEnv ? args.slice(2) : args.slice(1);
      const goFlag = restArgs.includes("--go");
      const indices = restArgs.filter(a => a !== "--go" && /^\d+$/.test(a)).map(Number);

      let tree: any = null;
      let clientType = "";
      for (const client of ["hyperspace", "text"]) {
        const key = `epic_tree_${envArg.toLowerCase()}_${client}`;
        const cfg = await storage.getAgentConfig(key);
        if (cfg?.value) {
          try {
            tree = JSON.parse(cfg.value);
            clientType = client;
            break;
          } catch {}
        }
      }

      if (!tree) return fail(`[epic] No stored tree for ${envArg}. Run: epic tree --refresh ${envArg}`);

      let current = tree;
      const breadcrumbs = [tree.client || clientType];

      for (const idx of indices) {
        const children = current.children || [];
        if (idx < 1 || idx > children.length) {
          return fail(`[epic] Invalid index ${idx}. Range: 1-${children.length}`);
        }
        current = children[idx - 1];
        breadcrumbs.push(current.name || `[${idx}]`);
      }

      if (goFlag && current.path) {
        try {
          const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "navigate_path", env: envArg, path: current.path, client: clientType }),
          });
          const data = await resp.json() as any;
          if (data.ok) {
            return ok(`Navigating: ${current.name}${nl}Path: ${current.path}${nl}Client: ${clientType}${nl}Command ID: ${data.commandId}`);
          }
          return fail("[epic] Failed to send navigation command");
        } catch (e: any) {
          return fail(`[epic] ${e.message}`);
        }
      }

      const children = current.children || [];
      const lines: string[] = [];
      lines.push(`=== EPIC MENU: ${envArg} (${clientType}) ===`);
      lines.push(`Path: ${breadcrumbs.join(" > ")}`);
      lines.push("");

      if (!children.length) {
        if (current.name) {
          lines.push(`  Leaf: ${current.name}`);
          if (current.path) {
            lines.push(`  Path: ${current.path}`);
            lines.push("");
            lines.push(`Navigate: epic menu ${envArg} ${indices.join(" ")} --go`);
          }
        } else {
          lines.push("  (empty)");
        }
      } else {
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          const subCount = (child.children || []).length;
          const arrow = subCount > 0 ? ` (${subCount})` : "";
          const ct = child.controlType ? ` [${child.controlType}]` : "";
          lines.push(`  ${String(i + 1).padStart(3)}. ${child.name}${ct}${arrow}`);
        }
        lines.push("");
        const idxStr = indices.length > 0 ? indices.join(" ") + " " : "";
        lines.push(`Drill: epic menu ${envArg} ${idxStr}<number>`);
        lines.push(`Go:    epic menu ${envArg} ${idxStr}<number> --go`);
      }

      return ok(lines.join(nl));
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

    if (args[0] === "record") {
      if (args[1] === "start") {
        const env = (args[2] || "SUP").toUpperCase();
        try {
          const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/record/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ env }),
          });
          const data = await resp.json() as any;
          if (data.ok) {
            emitEvent("cli", `Recording started for ${env}`, "info");
            return ok(`Recording started for ${env}.${nl}The desktop agent will capture screenshots every 2-3 seconds.${nl}Run: epic record stop  to finish.`);
          }
          return fail(`[epic] ${data.error || "Failed to start recording"}`);
        } catch (e: any) {
          return fail(`[epic] ${e.message}`);
        }
      }
      if (args[1] === "stop") {
        try {
          const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/record/stop`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          const data = await resp.json() as any;
          if (data.ok) {
            const steps: any[] = data.steps || [];
            if (steps.length === 0) {
              return ok(`Recording stopped. No navigation steps captured.`);
            }
            const lines = [`Recording stopped. ${steps.length} step(s) captured:`, ""];
            for (const s of steps) {
              lines.push(`  ${s.step}. ${s.description}  [${s.screen}]  +${s.timeDelta}s`);
            }
            lines.push("", `Save with: epic record save <workflow name>`);
            return ok(lines.join(nl));
          }
          return fail(`[epic] ${data.error || "Failed to stop recording"}`);
        } catch (e: any) {
          return fail(`[epic] ${e.message}`);
        }
      }
      if (args[1] === "save") {
        const name = args.slice(2).join(" ").trim();
        if (!name) return fail("[epic] Usage: epic record save <workflow name>");
        try {
          const statusResp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/record/status`);
          const status = await statusResp.json() as any;
          if (status.stepCount === 0) {
            return fail("[epic] No recorded steps to save. Start and stop a recording first.");
          }

          if (status.active) {
            await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/record/stop`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({}),
            });
          }

          const saveResp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/record/save`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          });
          const data = await saveResp.json() as any;
          if (data.ok) {
            return ok(`Workflow "${name}" saved with ${status.stepCount} step(s).`);
          }
          return fail(`[epic] ${data.error || "Failed to save workflow"}`);
        } catch (e: any) {
          return fail(`[epic] ${e.message}`);
        }
      }
      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/record/status`);
        const data = await resp.json() as any;
        if (data.active) {
          const elapsed = Math.floor((Date.now() - data.startedAt) / 1000);
          return ok(`Recording active for ${data.env} (${elapsed}s, ${data.stepCount} steps).${nl}Run: epic record stop`);
        }
        return ok([
          "Epic Workflow Recorder",
          "======================",
          "  epic record start [env]  - Start recording navigation",
          "  epic record stop         - Stop recording, show steps",
          "  epic record save <name>  - Save last recorded steps as workflow",
        ].join(nl));
      } catch (e: any) {
        return fail(`[epic] ${e.message}`);
      }
    }

    if (args[0] === "workflows") {
      const allCfgs = await storage.getAgentConfigs();
      const workflows: any[] = [];
      for (const cfg of allCfgs) {
        if (cfg.key.startsWith("epic_workflow_") && cfg.value) {
          try {
            const wf = JSON.parse(cfg.value);
            workflows.push({
              key: cfg.key.replace("epic_workflow_", ""),
              name: wf.name || cfg.key.replace("epic_workflow_", ""),
              env: wf.env || "SUP",
              steps: (wf.steps || []).length,
              createdAt: wf.createdAt || "?",
            });
          } catch {}
        }
      }
      if (workflows.length === 0) {
        return ok(`No saved workflows.${nl}Record one: epic record start`);
      }
      const lines = [`=== EPIC WORKFLOWS === (${workflows.length})`, ""];
      for (let i = 0; i < workflows.length; i++) {
        const w = workflows[i];
        lines.push(`  ${i + 1}. ${w.name}  [${w.env}]  ${w.steps} steps  ${w.createdAt}`);
      }
      lines.push("", "Replay with: epic replay <name>");
      return ok(lines.join(nl));
    }

    if (args[0] === "replay") {
      const name = args.slice(1).join(" ").trim();
      if (!name) return fail("[epic] Usage: epic replay <workflow name>");
      const safeName = name.replace(/[^a-zA-Z0-9_\- ]/g, "").trim().replace(/\s+/g, "_").toLowerCase();
      const key = `epic_workflow_${safeName}`;
      const cfg = await storage.getAgentConfig(key);
      if (!cfg?.value) return fail(`[epic] Workflow "${name}" not found. Use: epic workflows`);
      let wf: any;
      try { wf = JSON.parse(cfg.value); } catch { return fail("[epic] Corrupt workflow data"); }
      const steps = wf.steps || [];
      if (steps.length === 0) return fail("[epic] Workflow has no steps");

      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "replay", env: wf.env || "SUP", steps }),
        });
        const data = await resp.json() as any;
        if (data.ok) {
          return ok(`Replaying workflow "${wf.name}" (${steps.length} steps) on ${wf.env}.${nl}Command ID: ${data.commandId}${nl}Desktop agent will execute each step with vision verification.`);
        }
        return fail("[epic] Failed to send replay command");
      } catch (e: any) {
        return fail(`[epic] ${e.message}`);
      }
    }

    if (args[0] === "workflow" && args[1] === "delete") {
      const name = args.slice(2).join(" ").trim();
      if (!name) return fail("[epic] Usage: epic workflow delete <name>");
      const safeName = name.replace(/[^a-zA-Z0-9_\- ]/g, "").trim().replace(/\s+/g, "_").toLowerCase();
      const key = `epic_workflow_${safeName}`;
      const cfg = await storage.getAgentConfig(key);
      if (!cfg?.value) return fail(`[epic] Workflow "${name}" not found.`);
      await storage.deleteAgentConfig(key);
      return ok(`Workflow "${name}" deleted.`);
    }

    if (args[0] === "launch") {
      const env = (args[1] || "SUP").toUpperCase();
      const activity = args.slice(2).join(" ");
      if (!activity) return fail("[epic] Usage: epic launch SUP Results Review");
      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "launch", env, activity }),
        });
        const data = await resp.json() as any;
        if (data.ok) return ok(`Launching '${activity}' via search bar in ${env}${nl}Command ID: ${data.commandId}${nl}The agent will click Epic button, type in search, and open the activity.`);
        return fail(`[epic] Failed to send launch command`);
      } catch (e: any) {
        return fail(`[epic] ${e.message}`);
      }
    }

    if (args[0] === "patient") {
      const env = (args[1] || "SUP").toUpperCase();
      const patient = args.slice(2).join(" ");
      if (!patient) return fail("[epic] Usage: epic patient SUP Smith, John");
      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "patient", env, patient }),
        });
        const data = await resp.json() as any;
        if (data.ok) return ok(`Patient search sent: '${patient}' in ${env}${nl}Command ID: ${data.commandId}${nl}The agent will open patient lookup and search.`);
        return fail(`[epic] Failed to send patient command`);
      } catch (e: any) {
        return fail(`[epic] ${e.message}`);
      }
    }

    if (args[0] === "read") {
      const env = (args[1] || "SUP").toUpperCase();
      const focus = args.slice(2).join(" ");
      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "read_screen", env, focus }),
        });
        const data = await resp.json() as any;
        if (data.ok) {
          const focusNote = focus ? ` (focus: ${focus})` : "";
          return ok(`Screen read requested for ${env}${focusNote}${nl}Command ID: ${data.commandId}${nl}The agent will screenshot and extract structured data from the current screen.`);
        }
        return fail(`[epic] Failed to send read command`);
      } catch (e: any) {
        return fail(`[epic] ${e.message}`);
      }
    }

    if (args[0] === "alias") {
      if (args[1] === "set" || (args[1] && args[1] !== "list" && args[1] !== "rm")) {
        const aliasName = args[1] === "set" ? args[2] : args[1];
        const aliasPath = args[1] === "set" ? args.slice(3).join(" ") : args.slice(2).join(" ");
        if (!aliasName || !aliasPath) return fail("[epic] Usage: epic alias <name> <path>${nl}  Example: epic alias lr Lab > Results Review");
        const cfg = await storage.getAgentConfig("epic_aliases");
        let aliases: Record<string, string> = {};
        if (cfg?.value) {
          try { aliases = JSON.parse(cfg.value); } catch {}
        }
        aliases[aliasName.toLowerCase()] = aliasPath;
        await storage.setAgentConfig("epic_aliases", JSON.stringify(aliases), "epic");
        return ok(`Alias saved: '${aliasName}' -> '${aliasPath}'${nl}Use: epic go SUP ${aliasName}`);
      }
      if (args[1] === "rm" || args[1] === "delete") {
        const aliasName = args[2];
        if (!aliasName) return fail("[epic] Usage: epic alias rm <name>");
        const cfg = await storage.getAgentConfig("epic_aliases");
        let aliases: Record<string, string> = {};
        if (cfg?.value) {
          try { aliases = JSON.parse(cfg.value); } catch {}
        }
        if (aliases[aliasName.toLowerCase()]) {
          delete aliases[aliasName.toLowerCase()];
          await storage.setAgentConfig("epic_aliases", JSON.stringify(aliases), "epic");
          return ok(`Alias '${aliasName}' deleted.`);
        }
        return fail(`[epic] Alias '${aliasName}' not found.`);
      }
      const cfg = await storage.getAgentConfig("epic_aliases");
      let aliases: Record<string, string> = {};
      if (cfg?.value) {
        try { aliases = JSON.parse(cfg.value); } catch {}
      }
      const keys = Object.keys(aliases);
      if (keys.length === 0) return ok(`No Epic aliases defined.${nl}Set one: epic alias lr Lab > Results Review`);
      const lines = ["=== EPIC ALIASES ===", ""];
      for (const k of keys) {
        lines.push(`  ${k.padEnd(15)} -> ${aliases[k]}`);
      }
      lines.push("", "Use: epic go SUP <alias>");
      return ok(lines.join(nl));
    }

    if (args[0] === "batch" || args[0] === "run") {
      const env = (args[1] || "SUP").toUpperCase();
      const recipeArg = args.slice(2).join(" ");
      if (!recipeArg) return fail(`[epic] Usage: epic run SUP <recipe_name>${nl}Recipes chain multiple commands. Create with: recipe save <name>${nl}Or provide inline JSON steps.`);

      const recipeCfg = await storage.getAgentConfig(`epic_recipe_${recipeArg.toLowerCase()}`);
      let steps: any[] = [];
      if (recipeCfg?.value) {
        try { steps = JSON.parse(recipeCfg.value); } catch {}
      }

      if (steps.length === 0) {
        try {
          steps = JSON.parse(recipeArg);
        } catch {
          return fail(`[epic] Recipe '${recipeArg}' not found. List recipes: epic recipes`);
        }
      }

      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "batch", env, steps }),
        });
        const data = await resp.json() as any;
        if (data.ok) return ok(`Batch execution started: ${steps.length} steps in ${env}${nl}Command ID: ${data.commandId}`);
        return fail(`[epic] Failed to send batch command`);
      } catch (e: any) {
        return fail(`[epic] ${e.message}`);
      }
    }

    if (args[0] === "recipe") {
      if (args[1] === "save") {
        const name = args[2];
        const stepsJson = args.slice(3).join(" ");
        if (!name || !stepsJson) return fail(`[epic] Usage: epic recipe save <name> <JSON steps array>${nl}Example steps: [{"type":"launch","activity":"Results Review"},{"type":"wait","seconds":2},{"type":"read_screen"}]`);
        try {
          const steps = JSON.parse(stepsJson);
          await storage.setAgentConfig(`epic_recipe_${name.toLowerCase()}`, JSON.stringify(steps), "epic");
          return ok(`Recipe '${name}' saved with ${steps.length} steps.${nl}Run with: epic run SUP ${name}`);
        } catch {
          return fail(`[epic] Invalid JSON for recipe steps.`);
        }
      }
      if (args[1] === "delete" || args[1] === "rm") {
        const name = args[2];
        if (!name) return fail("[epic] Usage: epic recipe delete <name>");
        await storage.deleteAgentConfig(`epic_recipe_${name.toLowerCase()}`);
        return ok(`Recipe '${name}' deleted.`);
      }
      const configs = await storage.getAgentConfigs();
      const recipes = configs.filter((c: any) => c.key.startsWith("epic_recipe_"));
      if (recipes.length === 0) return ok(`No recipes saved.${nl}Create one: epic recipe save <name> <JSON steps>`);
      const lines = ["=== EPIC RECIPES ===", ""];
      for (const r of recipes) {
        const rName = r.key.replace("epic_recipe_", "");
        let stepCount = 0;
        try { stepCount = JSON.parse(r.value).length; } catch {}
        lines.push(`  ${rName.padEnd(20)} (${stepCount} steps)`);
      }
      lines.push("", "Run with: epic run SUP <recipe_name>");
      return ok(lines.join(nl));
    }

    if (args[0] === "recipes") {
      const configs = await storage.getAgentConfigs();
      const recipes = configs.filter((c: any) => c.key.startsWith("epic_recipe_"));
      if (recipes.length === 0) return ok(`No recipes saved.${nl}Create one: epic recipe save <name> <JSON steps>`);
      const lines = ["=== EPIC RECIPES ===", ""];
      for (const r of recipes) {
        const rName = r.key.replace("epic_recipe_", "");
        let stepCount = 0;
        try { stepCount = JSON.parse(r.value).length; } catch {}
        lines.push(`  ${rName.padEnd(20)} (${stepCount} steps)`);
      }
      lines.push("", "Run with: epic run SUP <recipe_name>");
      return ok(lines.join(nl));
    }

    if (args[0] === "shortcuts") {
      const env = (args[1] || "SUP").toUpperCase();
      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "shortcuts", env }),
        });
        const data = await resp.json() as any;
        if (data.ok) return ok(`Keyboard shortcut scan started for ${env}${nl}Command ID: ${data.commandId}${nl}The agent will identify visible and known shortcuts.`);
        return fail(`[epic] Failed to send shortcuts command`);
      } catch (e: any) {
        return fail(`[epic] ${e.message}`);
      }
    }

    return ok([
      "Epic commands:",
      "",
      "  NAVIGATION",
      "  epic go <env> <path>      - Navigate using stored path or alias",
      "  epic launch <env> <name>  - Open activity via search bar (fastest)",
      "  epic search <query>       - Search across all activities",
      "  epic patient <env> <name> - Search for a patient",
      "",
      "  SCREEN",
      "  epic screenshot <env>     - Capture current screen",
      "  epic read <env> [focus]   - Extract structured data from screen",
      "  epic click <env> <el>     - Click an element by name",
      "",
      "  DISCOVERY",
      "  epic menu-crawl [env]     - Auto-crawl Hyperspace menus (vision)",
      "  epic menu-crawl text [env] - Auto-crawl Text menus (keystroke)",
      "  epic search-crawl [env]   - Discover activities via A-Z search autocomplete",
      "  epic tree <env>           - Show full navigation tree",
      "  epic activities <env>     - Show cataloged activities",
      "  epic shortcuts <env>      - Discover keyboard shortcuts",
      "  epic scan                 - One-time activity scan guide",
      "",
      "  ALIASES & RECIPES",
      "  epic alias <name> <path>  - Create shortcut alias",
      "  epic alias                - List all aliases",
      "  epic alias rm <name>      - Delete an alias",
      "  epic recipe save <n> <json> - Save a multi-step recipe",
      "  epic recipes              - List saved recipes",
      "  epic run <env> <recipe>   - Execute a recipe",
      "",
      "  VIMIUM (Live Accessibility Tree)",
      "  epic view [env]           - Read live UI tree with hint keys",
      "  epic view [env] --all     - Include static text/labels",
      "  epic view [env] --focus X - Scope to panel/group X",
      "  epic do [env] <hint>      - Click/select element by hint",
      "  epic do [env] <hint> <val>- Type value into field by hint",
      "  epic screen [env] <name>  - Go to activity + view + cache",
      "  epic fields [env]         - List cached field layouts",
      "  epic fields [env] <name>  - Show cached fields instantly",
      "  epic menu [env]           - Browse stored nav tree",
      "  epic menu [env] 3 2       - Drill into tree by numbers",
      "  epic menu [env] 3 --go    - Navigate to tree item",
      "",
      "  WORKFLOWS",
      "  epic record start [env]   - Start recording workflow",
      "  epic record stop          - Stop recording",
      "  epic record save <name>   - Save recorded workflow",
      "  epic workflows            - List saved workflows",
      "  epic replay <name>        - Replay a saved workflow",
      "",
      "  SYSTEM",
      "  epic status               - Desktop agent status",
      "  epic navigate <env> <target> - Navigate Hyperspace (vision)",
      "  epic mf <masterfile> [item] - Text masterfile lookup",
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

  async function galaxyWaitAndRecord(isRead: boolean): Promise<string | null> {
    const { waitForGalaxyRateLimit } = await import("./galaxy-scraper");
    return waitForGalaxyRateLimit(isRead);
  }

  function galaxyDone(): void {
    import("./galaxy-scraper").then(m => m.galaxyRequestDone());
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

        let kbId: number | null = null;
        let kbMemories = 0;
        try {
          const { ingestToKb } = await import("./galaxy-scraper");
          const kbResult = await ingestToKb(
            url,
            title,
            category,
            extractedText.substring(0, 50000),
            ["galaxy", "epic", category.toLowerCase()],
          );
          kbId = kbResult.kbEntry.id;
          kbMemories = kbResult.memoriesCreated;
        } catch (kbErr: any) {
          console.error("[galaxy read] KB ingest failed:", kbErr.message);
        }

        const lines = [
          `Galaxy guide saved:`,
          `  Title:    ${title}`,
          `  Category: ${category}`,
          `  URL:      ${url}`,
          `  Reader:   #${saved.id}`,
          `  Size:     ${extractedText.length} chars`,
        ];
        if (kbId) {
          lines.push(`  KB Entry: #${kbId} (${kbMemories} memories created)`);
        }
        lines.push("", "View in TreeView GALAXY KB section.");
        return ok(lines.join(nl));
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

    if (args[0] === "context") {
      const { scrapeGalaxyContext, isGalaxyContextEnabled } = await import("./galaxy-scraper");
      const term = args.slice(1).join(" ");
      if (!term) return fail("[galaxy] Usage: galaxy context <term or topic>");

      const enabled = await isGalaxyContextEnabled();
      if (!enabled) {
        return fail("[galaxy] Galaxy context mode is OFF. Enable with: galaxy auto on");
      }

      emitEvent("galaxy-context", `Manual context scrape: "${term}"`, "info");
      const result = await scrapeGalaxyContext(term);
      if (result.error) {
        return fail(`[galaxy] Context scrape failed: ${result.error}`);
      }
      return ok([
        `Galaxy context scrape complete:`,
        `  Term:     ${term}`,
        `  Guides:   ${result.guidesRead} read`,
        `  Memories: ${result.memoriesCreated} created`,
        "",
        "Content stored as semantic memories for agent use.",
      ].join(nl));
    }

    if (args[0] === "auto") {
      const { isGalaxyContextEnabled, setGalaxyContextEnabled, getGalaxyContextStats, getContextQueue } = await import("./galaxy-scraper");

      if (args[1] === "on") {
        await setGalaxyContextEnabled(true);
        emitEvent("galaxy-context", "Galaxy context mode ENABLED", "info");
        return ok("Galaxy context mode is now ON. The agent will proactively search Galaxy for Epic context.");
      }

      if (args[1] === "off") {
        await setGalaxyContextEnabled(false);
        emitEvent("galaxy-context", "Galaxy context mode DISABLED", "info");
        return ok("Galaxy context mode is now OFF.");
      }

      const enabled = await isGalaxyContextEnabled();
      const stats = await getGalaxyContextStats();
      const queue = await getContextQueue();

      const lines = [
        `=== GALAXY CONTEXT MODE ===`,
        `  Status:           ${enabled ? "ON" : "OFF"}`,
        `  Last run:         ${stats.lastRun || "never"}`,
        `  Total searches:   ${stats.totalSearches}`,
        `  Guides read:      ${stats.totalGuidesRead}`,
        `  Memories created: ${stats.memoriesCreated}`,
        `  Errors:           ${stats.errors}`,
        "",
        `  Queue (${queue.length}):`,
      ];
      if (queue.length > 0) {
        for (const t of queue.slice(0, 10)) {
          lines.push(`    - ${t}`);
        }
        if (queue.length > 10) lines.push(`    ... +${queue.length - 10} more`);
      } else {
        lines.push("    (empty)");
      }
      if (stats.lastTerms.length > 0) {
        lines.push("", `  Recent terms:`);
        for (const t of stats.lastTerms.slice(0, 10)) {
          lines.push(`    - ${t}`);
        }
      }
      lines.push("", "  galaxy auto on   - Enable context mode");
      lines.push("  galaxy auto off  - Disable context mode");
      return ok(lines.join(nl));
    }

    if (args[0] === "queue") {
      const { addToContextQueue, getContextQueue } = await import("./galaxy-scraper");
      const terms = args.slice(1).join(" ").split(",").map(t => t.trim()).filter(t => t.length > 2);
      if (terms.length === 0) {
        const queue = await getContextQueue();
        if (queue.length === 0) return ok("Galaxy context queue is empty.");
        return ok([`Galaxy context queue (${queue.length}):`, ...queue.map(t => `  - ${t}`)].join(nl));
      }
      await addToContextQueue(terms);
      return ok(`Added ${terms.length} term(s) to Galaxy context queue: ${terms.join(", ")}`);
    }

    if (args[0] === "kb") {
      const kbSub = (args[1] || "").toLowerCase();

      if (kbSub === "search") {
        const query = args.slice(2).join(" ");
        if (!query) return fail("[galaxy] Usage: galaxy kb search <query>");
        const results = await storage.searchGalaxyKb(query);
        if (results.length === 0) return ok(`No KB entries match "${query}".`);
        const lines = [`=== GALAXY KB SEARCH: "${query}" === (${results.length} results)`, ""];
        for (const e of results) {
          const v = e.verified ? " [VERIFIED]" : e.flagged ? " [FLAGGED]" : "";
          lines.push(`  #${String(e.id).padStart(4)} ${e.title.substring(0, 60)}${v}`);
          lines.push(`         ${e.category} | ${e.memoryCount} memories | ${new Date(e.createdAt).toLocaleDateString()}`);
          if (e.summary) lines.push(`         ${e.summary.substring(0, 80)}`);
        }
        return ok(lines.join(nl));
      }

      if (kbSub === "verify") {
        const id = parseInt(args[2], 10);
        if (isNaN(id)) return fail("[galaxy] Usage: galaxy kb verify <id>");
        const entry = await storage.verifyGalaxyKbEntry(id, "user");
        if (!entry) return fail(`[galaxy] KB entry #${id} not found.`);
        return ok(`KB entry #${id} verified: "${entry.title}"${nl}Linked memories will receive a relevance boost.`);
      }

      if (kbSub === "flag") {
        const id = parseInt(args[2], 10);
        if (isNaN(id)) return fail("[galaxy] Usage: galaxy kb flag <id> [reason]");
        const reason = args.slice(3).join(" ") || "Flagged by user";
        const entry = await storage.flagGalaxyKbEntry(id, reason);
        if (!entry) return fail(`[galaxy] KB entry #${id} not found.`);
        return ok(`KB entry #${id} flagged: "${entry.title}"${nl}Reason: ${reason}`);
      }

      if (kbSub === "note") {
        const id = parseInt(args[2], 10);
        if (isNaN(id)) return fail("[galaxy] Usage: galaxy kb note <id> <note text>");
        const noteText = args.slice(3).join(" ");
        if (!noteText) return fail("[galaxy] Provide note text after the ID.");
        const existing = await storage.getGalaxyKbEntry(id);
        if (!existing) return fail(`[galaxy] KB entry #${id} not found.`);
        const combined = existing.userNotes ? `${existing.userNotes}\n---\n${noteText}` : noteText;
        await storage.updateGalaxyKbEntry(id, { userNotes: combined });
        return ok(`Note added to KB entry #${id}: "${existing.title}"`);
      }

      if (kbSub === "stats") {
        const stats = await storage.getGalaxyKbStats();
        const lines = [
          "=== GALAXY KB STATS ===",
          `  Total entries:  ${stats.total}`,
          `  Verified:       ${stats.verified}`,
          `  Flagged:        ${stats.flagged}`,
          `  Categories:     ${stats.categories.length}`,
        ];
        if (stats.categories.length > 0) {
          lines.push("", "  Categories:");
          for (const c of stats.categories) {
            lines.push(`    - ${c}`);
          }
        }
        return ok(lines.join(nl));
      }

      const idNum = parseInt(kbSub, 10);
      if (!isNaN(idNum) && idNum > 0) {
        const entry = await storage.getGalaxyKbEntry(idNum);
        if (!entry) return fail(`[galaxy] KB entry #${idNum} not found.`);
        const linkedMemories = await storage.getLinkedMemories(entry.id);
        const lines = [
          `=== GALAXY KB #${entry.id} ===`,
          `  Title:       ${entry.title}`,
          `  Category:    ${entry.category}`,
          `  URL:         ${entry.url}`,
          `  Status:      ${entry.verified ? "VERIFIED" : entry.flagged ? "FLAGGED" : "unverified"}`,
          `  Memories:    ${entry.memoryCount}`,
          `  Agent Access: ${entry.agentAccessCount}`,
          `  Tags:        ${entry.tags.join(", ") || "(none)"}`,
          `  Created:     ${new Date(entry.createdAt).toLocaleString()}`,
        ];
        if (entry.summary) lines.push("", `  Summary:`, `    ${entry.summary}`);
        if (entry.userNotes) lines.push("", `  Notes:`, `    ${entry.userNotes}`);
        if (entry.flagReason) lines.push("", `  Flag reason: ${entry.flagReason}`);
        if (entry.verifiedBy) lines.push(`  Verified by: ${entry.verifiedBy} at ${entry.verifiedAt ? new Date(entry.verifiedAt).toLocaleString() : "?"}`);
        if (linkedMemories.length > 0) {
          lines.push("", `  Linked Memories (${linkedMemories.length}):`);
          for (const m of linkedMemories.slice(0, 5)) {
            lines.push(`    #${m.id} [${m.memoryType}] rel:${m.relevanceScore} ${m.content.substring(0, 80)}`);
          }
          if (linkedMemories.length > 5) lines.push(`    ... +${linkedMemories.length - 5} more`);
        }
        lines.push("", "  galaxy kb verify <id>  - Mark as verified");
        lines.push("  galaxy kb flag <id>    - Flag for review");
        lines.push("  galaxy kb note <id>    - Add a note");
        return ok(lines.join(nl));
      }

      const entries = await storage.getGalaxyKbEntries();
      if (entries.length === 0) {
        return ok("Galaxy KB is empty. Use: galaxy search + galaxy read to populate.");
      }
      const catMap = new Map<string, typeof entries>();
      for (const e of entries) {
        if (!catMap.has(e.category)) catMap.set(e.category, []);
        catMap.get(e.category)!.push(e);
      }
      const lines = [`=== GALAXY KNOWLEDGE BASE === (${entries.length} entries)`, ""];
      for (const [cat, items] of Array.from(catMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`  ${cat} (${items.length})`);
        for (const e of items.slice(0, 8)) {
          const v = e.verified ? " [V]" : e.flagged ? " [F]" : "";
          lines.push(`    #${String(e.id).padStart(4)} ${e.title.substring(0, 55)}${v}`);
        }
        if (items.length > 8) lines.push(`    ... +${items.length - 8} more`);
      }
      lines.push("", "  galaxy kb <id>         - View entry details");
      lines.push("  galaxy kb search <q>   - Search KB");
      lines.push("  galaxy kb verify <id>  - Mark verified");
      lines.push("  galaxy kb flag <id>    - Flag for review");
      lines.push("  galaxy kb note <id>    - Add user note");
      lines.push("  galaxy kb stats        - KB statistics");
      return ok(lines.join(nl));
    }

    return ok([
      "Galaxy Knowledge Base (galaxy.epic.com)",
      "========================================",
      "  galaxy search <query>    - Search Galaxy for articles/guides",
      "  galaxy read <url or #>   - Fetch & save a guide to Reader + KB",
      "  galaxy recent            - Show recently saved Galaxy guides",
      "  galaxy context <term>    - Scrape Galaxy for context on a term",
      "  galaxy auto [on|off]     - Toggle/view autonomous context mode",
      "  galaxy queue [terms,...] - View/add to the context queue",
      "  galaxy kb [search|<id>]  - Browse/search the Knowledge Base",
      "  galaxy kb verify <id>    - Verify a KB entry",
      "  galaxy kb flag <id>      - Flag a KB entry for review",
      "  galaxy kb note <id>      - Add a note to a KB entry",
      "  galaxy kb stats          - KB statistics",
      "",
      "Galaxy is behind Epic SSO. Requires Chrome extension bridge.",
      "Rate limited: 3-8s between requests, max 5 per session.",
    ].join(nl));
  });

  registerCommand("meals", "Meal planning & grocery cart agent",
    "meals [plan|add-recipe|list|cart|prefs|history|pantry|restock|kiddo|kiddo-log|tonight] ...",
    async (args) => {
      const nl = String.fromCharCode(10);
      const sub = (args[0] || "").toLowerCase();

      if (sub === "plan") {
        const prefs = await storage.getAgentConfig("meals_dietary_prefs");
        const dietaryPrefs = prefs ? JSON.parse(prefs.value) : {
          householdSize: 3,
          dietaryRestrictions: [],
          allergies: [],
          cuisinePreferences: ["American", "Italian", "Mexican", "Asian"],
          appliances: ["Instant Pot", "sous vide", "rice cooker", "stove", "toaster oven", "crockpot"],
          kiddoName: "Willa",
          kiddoCurrentFavorites: ["Go-Gurt", "chicken nuggets", "Goldfish crackers"],
        };

        const kiddoLogs = await storage.getKiddoFoodLogs();
        const accepted = kiddoLogs.filter(l => l.verdict === "accepted").map(l => l.itemName);
        const rejected = kiddoLogs.filter(l => l.verdict === "rejected").map(l => l.itemName);

        const pantry = await storage.getPantryItems("in_stock");
        const pantryNames = pantry.map(p => p.name);

        const today = new Date();
        const weekStart = today.toISOString().split("T")[0];
        const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

        const llmConfig = { defaultModel: "openrouter/anthropic/claude-sonnet-4", aliases: {}, routing: {} };

        const messages: LLMMessage[] = [
          {
            role: "system",
            content: `You are a meal planning assistant. Generate a weekly meal plan as valid JSON.
The household has these appliances: ${dietaryPrefs.appliances.join(", ")}.
Household size: ${dietaryPrefs.householdSize}.
Dietary restrictions: ${dietaryPrefs.dietaryRestrictions.join(", ") || "none"}.
Allergies: ${dietaryPrefs.allergies.join(", ") || "none"}.
Cuisine preferences: ${dietaryPrefs.cuisinePreferences.join(", ")}.
Items currently in pantry: ${pantryNames.join(", ") || "none"}.

Picky eater profile for ${dietaryPrefs.kiddoName || "Willa"}:
- Current favorites: ${(dietaryPrefs.kiddoCurrentFavorites || []).join(", ")}
- Previously accepted new foods: ${accepted.join(", ") || "none yet"}
- Previously rejected foods: ${rejected.join(", ") || "none yet"}
Include one "bridge food" trial lunch for ${dietaryPrefs.kiddoName || "Willa"} during the week.

Return ONLY a JSON array of 7 day objects with this structure:
[{"day":"Monday","breakfast":{"name":"...","appliance":"stove","ingredients":["..."]},"lunch":{"name":"...","appliance":"none","ingredients":["..."]},"dinner":{"name":"...","appliance":"Instant Pot","ingredients":["..."]}}]
One lunch should have "isKiddoTrial":true and "bridgeRationale":"..." explaining the bridge food strategy.`
          },
          { role: "user", content: `Generate a weekly meal plan starting ${weekStart} for the ${days.join(", ")} days.` }
        ];

        try {
          const result = await executeLLM(messages, undefined, llmConfig, {});
          let planDays: any[] = [];
          const content = result.content || "";
          const jsonMatch = content.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            planDays = JSON.parse(jsonMatch[0]);
          }

          if (planDays.length === 0) {
            return fail("Failed to parse meal plan from LLM response");
          }

          const existingActive = await storage.getActiveMealPlan();
          if (existingActive) {
            await storage.updateMealPlan(existingActive.id, { status: "archived" });
          }

          const plan = await storage.createMealPlan({
            weekStart,
            days: planDays,
            preferencesSnapshot: dietaryPrefs,
            status: "active",
          });

          const lines = [`=== Weekly Meal Plan (${weekStart}) ===`, ""];
          for (const d of planDays) {
            lines.push(`📅 ${d.day}`);
            if (d.breakfast) lines.push(`  🌅 Breakfast: ${d.breakfast.name} [${d.breakfast.appliance}]`);
            if (d.lunch) {
              const trial = d.lunch.isKiddoTrial ? ` ⭐ KIDDO TRIAL` : "";
              lines.push(`  ☀️ Lunch: ${d.lunch.name} [${d.lunch.appliance || "none"}]${trial}`);
              if (d.lunch.bridgeRationale) lines.push(`     Bridge: ${d.lunch.bridgeRationale}`);
            }
            if (d.dinner) lines.push(`  🌙 Dinner: ${d.dinner.name} [${d.dinner.appliance}]`);
            lines.push("");
          }
          lines.push(`Plan ID: ${plan.id}`);
          return ok(lines.join(nl));
        } catch (err: any) {
          return fail(`Failed to generate meal plan: ${err.message}`);
        }
      }

      if (sub === "add-recipe") {
        const recipeParts = args.slice(1).join(" ");
        if (!recipeParts) return fail("Usage: meals add-recipe <day> <meal> <recipe name> [appliance]\nExample: meals add-recipe monday dinner Beef Stew Instant Pot");
        const plan = await storage.getActiveMealPlan();
        if (!plan) return fail("No active meal plan. Run 'meals plan' first.");

        const tokens = recipeParts.split(/\s+/);
        const day = tokens[0]?.toLowerCase();
        const mealSlot = tokens[1]?.toLowerCase();
        const validDays = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
        const validSlots = ["breakfast","lunch","dinner"];
        if (!validDays.includes(day)) return fail(`Invalid day: ${day}. Use one of: ${validDays.join(", ")}`);
        if (!validSlots.includes(mealSlot)) return fail(`Invalid meal slot: ${mealSlot}. Use one of: ${validSlots.join(", ")}`);

        const remaining = tokens.slice(2).join(" ");
        const applianceMatch = remaining.match(/\[(.+?)\]$/);
        const appliance = applianceMatch ? applianceMatch[1] : "stove";
        const recipeName = applianceMatch ? remaining.replace(/\[.+?\]$/, "").trim() : remaining;
        if (!recipeName) return fail("Please provide a recipe name.");

        const days = ((plan.plan as any)?.days || []) as any[];
        let dayEntry = days.find((d: any) => d.day?.toLowerCase() === day);
        if (!dayEntry) {
          dayEntry = { day: day.charAt(0).toUpperCase() + day.slice(1) };
          days.push(dayEntry);
        }
        dayEntry[mealSlot] = { name: recipeName, appliance, ingredients: [] };
        await storage.updateMealPlan(plan.id, { days } as any);

        return ok(`Added "${recipeName}" [${appliance}] to ${day} ${mealSlot} in plan ${plan.weekStart}.`);
      }

      if (sub === "list") {
        const plan = await storage.getActiveMealPlan();
        if (!plan) return ok("No active meal plan. Run 'meals plan' to generate one.");

        const lines = [`=== Active Meal Plan (${plan.weekStart}) ===`, ""];
        const days = (plan.days || []) as any[];
        for (const d of days) {
          lines.push(`📅 ${d.day}`);
          if (d.breakfast) lines.push(`  🌅 Breakfast: ${d.breakfast.name} [${d.breakfast.appliance}]`);
          if (d.lunch) {
            const trial = d.lunch.isKiddoTrial ? ` ⭐ KIDDO TRIAL` : "";
            lines.push(`  ☀️ Lunch: ${d.lunch.name} [${d.lunch.appliance || "none"}]${trial}`);
          }
          if (d.dinner) lines.push(`  🌙 Dinner: ${d.dinner.name} [${d.dinner.appliance}]`);
          lines.push("");
        }

        const lists = await storage.getShoppingLists();
        const activeList = lists.find(l => l.mealPlanId === plan.id);
        if (activeList) {
          lines.push("=== Shopping List ===");
          const items = (activeList.items || []) as any[];
          for (const item of items) {
            const score = item.nutriScore ? ` [${item.nutriScore.toUpperCase()}]` : "";
            lines.push(`  ${item.quantity} ${item.unit} ${item.name}${score}`);
          }
        } else {
          lines.push("No shopping list generated yet. Ingredients from the plan:");
          const allIngredients = new Set<string>();
          for (const d of days) {
            for (const meal of [d.breakfast, d.lunch, d.dinner, ...(d.snacks || [])]) {
              if (meal?.ingredients) {
                for (const ing of meal.ingredients) allIngredients.add(ing);
              }
            }
          }
          for (const ing of Array.from(allIngredients)) lines.push(`  - ${ing}`);
        }

        return ok(lines.join(nl));
      }

      if (sub === "cart") {
        const store = (args[1] || "").toLowerCase();
        if (!store || !["walmart", "costco"].includes(store)) {
          return fail("Usage: meals cart walmart|costco");
        }

        const plan = await storage.getActiveMealPlan();
        if (!plan) return fail("No active meal plan. Run 'meals plan' first.");

        const days = (plan.days || []) as any[];
        const allIngredients = new Map<string, { quantity: number; unit: string }>();
        for (const d of days) {
          for (const meal of [d.breakfast, d.lunch, d.dinner, ...(d.snacks || [])]) {
            if (meal?.ingredients) {
              for (const ing of meal.ingredients) {
                const existing = allIngredients.get(ing);
                if (existing) {
                  existing.quantity += 1;
                } else {
                  allIngredients.set(ing, { quantity: 1, unit: "item" });
                }
              }
            }
          }
        }

        const pantry = await storage.getPantryItems("in_stock");
        const pantryNames = new Set(pantry.map(p => p.name.toLowerCase()));

        const shoppingItems: any[] = [];
        const storeProfile = getStoreProfile(store);
        for (const [name, info] of Array.from(allIngredients)) {
          if (pantryNames.has(name.toLowerCase())) continue;
          let healthScore: number | undefined;
          let nutriScore: string | undefined;
          try {
            const scored = await findBestProduct(name, 1);
            if (scored.length > 0) {
              healthScore = scored[0].healthScore;
              nutriScore = scored[0].product.nutriscore_grade || undefined;
            }
          } catch {}
          shoppingItems.push({
            name,
            quantity: info.quantity,
            unit: info.unit,
            category: "grocery",
            store,
            healthScore,
            nutriScore,
          });
        }

        const list = await storage.createShoppingList({
          mealPlanId: plan.id,
          items: shoppingItems,
          cartStatus: "ready",
          store,
        });

        const lines = [
          `=== ${store.charAt(0).toUpperCase() + store.slice(1)} Cart ===`,
          storeProfile ? `Store: ${storeProfile.name} (${storeProfile.searchUrl})` : "",
          `Shopping list created with ${shoppingItems.length} items (ID: ${list.id})`,
          "",
          "Items to cart:",
        ].filter(Boolean);
        for (const item of shoppingItems) {
          const score = item.nutriScore ? ` [Nutri-Score: ${item.nutriScore.toUpperCase()}]` : "";
          lines.push(`  ${item.quantity} ${item.unit} ${item.name}${score}`);
        }
        lines.push("");
        lines.push(`Cart status: ${list.cartStatus}`);
        lines.push("Browser automation will search each item on the store and add to cart via site profile.");

        return ok(lines.join(nl));
      }

      if (sub === "prefs") {
        const action = (args[1] || "view").toLowerCase();
        const prefsConfig = await storage.getAgentConfig("meals_dietary_prefs");
        let prefs = prefsConfig ? JSON.parse(prefsConfig.value) : {
          householdSize: 3,
          dietaryRestrictions: [],
          allergies: [],
          cuisinePreferences: ["American", "Italian", "Mexican", "Asian"],
          appliances: ["Instant Pot", "sous vide", "rice cooker", "stove", "toaster oven", "crockpot"],
          kiddoName: "Willa",
          kiddoCurrentFavorites: ["Go-Gurt", "chicken nuggets", "Goldfish crackers"],
        };

        if (action === "set") {
          const key = args[2];
          const value = args.slice(3).join(" ");
          if (!key || !value) return fail("Usage: meals prefs set <key> <value>");
          if (key === "householdSize") {
            prefs.householdSize = parseInt(value, 10);
          } else if (key === "restrictions") {
            prefs.dietaryRestrictions = value.split(",").map((s: string) => s.trim());
          } else if (key === "allergies") {
            prefs.allergies = value.split(",").map((s: string) => s.trim());
          } else if (key === "cuisines") {
            prefs.cuisinePreferences = value.split(",").map((s: string) => s.trim());
          } else if (key === "appliances") {
            prefs.appliances = value.split(",").map((s: string) => s.trim());
          } else {
            return fail(`Unknown preference key: ${key}. Valid: householdSize, restrictions, allergies, cuisines, appliances`);
          }
          await storage.setAgentConfig("meals_dietary_prefs", JSON.stringify(prefs), "meals");
          return ok(`Updated ${key} = ${value}`);
        }

        const lines = [
          "=== Dietary Preferences ===",
          `  Household size: ${prefs.householdSize}`,
          `  Restrictions: ${prefs.dietaryRestrictions.join(", ") || "none"}`,
          `  Allergies: ${prefs.allergies.join(", ") || "none"}`,
          `  Cuisines: ${prefs.cuisinePreferences.join(", ")}`,
          `  Appliances: ${prefs.appliances.join(", ")}`,
          "",
          "=== Picky Eater Profile ===",
          `  Name: ${prefs.kiddoName || "Willa"}`,
          `  Current favorites: ${(prefs.kiddoCurrentFavorites || []).join(", ")}`,
          "",
          "Update: meals prefs set <key> <value>",
          "Keys: householdSize, restrictions, allergies, cuisines, appliances",
        ];
        return ok(lines.join(nl));
      }

      if (sub === "history") {
        const plans = await storage.getMealPlans();
        if (plans.length === 0) return ok("No meal plan history.");
        const lines = ["=== Meal Plan History ===", ""];
        for (const p of plans.slice(0, 10)) {
          const dayCount = Array.isArray(p.days) ? (p.days as any[]).length : 0;
          lines.push(`  #${p.id}  ${p.weekStart}  [${p.status}]  ${dayCount} days`);
        }
        return ok(lines.join(nl));
      }

      if (sub === "pantry") {
        const items = await storage.getPantryItems();
        if (items.length === 0) return ok("Pantry is empty. Items are added when you cart/purchase groceries.");
        const lines = ["=== Pantry Inventory ===", ""];
        const now = new Date();
        for (const item of items) {
          const exp = item.estimatedExpiration ? new Date(item.estimatedExpiration) : null;
          let expStr = "";
          if (exp) {
            const daysLeft = Math.round((exp.getTime() - now.getTime()) / 86400000);
            if (daysLeft < 0) expStr = ` ⚠️ EXPIRED ${Math.abs(daysLeft)}d ago`;
            else if (daysLeft <= 3) expStr = ` ⚠️ Expires in ${daysLeft}d`;
            else expStr = ` (expires in ${daysLeft}d)`;
          }
          const consume = item.avgDaysToConsume ? ` | ~${item.avgDaysToConsume}d to consume` : "";
          lines.push(`  ${item.name.padEnd(25)} ${item.quantity} ${item.unit}  [${item.category}]${expStr}${consume}  [${item.status}]`);
        }
        return ok(lines.join(nl));
      }

      if (sub === "restock") {
        const items = await storage.getPantryItems("in_stock");
        const now = new Date();
        const needsRestock: Array<{ item: typeof items[0]; reason: string; priority: number }> = [];

        for (const item of items) {
          const exp = item.estimatedExpiration ? new Date(item.estimatedExpiration) : null;
          if (exp) {
            const daysLeft = Math.round((exp.getTime() - now.getTime()) / 86400000);
            if (daysLeft <= 3) {
              needsRestock.push({
                item,
                reason: daysLeft < 0 ? `Expired ${Math.abs(daysLeft)}d ago` : `Expires in ${daysLeft}d`,
                priority: daysLeft < 0 ? 0 : 1,
              });
              continue;
            }
          }

          if (item.avgDaysToConsume) {
            const purchaseDate = new Date(item.purchaseDate);
            const daysSincePurchase = Math.round((now.getTime() - purchaseDate.getTime()) / 86400000);
            const estimatedRemaining = Math.max(0, item.avgDaysToConsume - daysSincePurchase);
            if (estimatedRemaining <= 2) {
              needsRestock.push({
                item,
                reason: `Estimated ${estimatedRemaining}d of supply left (avg ${item.avgDaysToConsume}d to consume)`,
                priority: 2,
              });
            }
          }
        }

        needsRestock.sort((a, b) => a.priority - b.priority);

        if (needsRestock.length === 0) {
          return ok("All pantry items look good. Nothing needs restocking right now.");
        }

        const lines = ["=== Restock Recommendations ===", ""];
        for (const { item, reason } of needsRestock) {
          lines.push(`  🔄 ${item.name} - ${reason}`);
        }
        lines.push("", `${needsRestock.length} item(s) need restocking.`);
        lines.push("Run 'meals cart walmart' or 'meals cart costco' to add to cart.");
        return ok(lines.join(nl));
      }

      if (sub === "kiddo") {
        const prefsConfig = await storage.getAgentConfig("meals_dietary_prefs");
        const prefs = prefsConfig ? JSON.parse(prefsConfig.value) : { kiddoName: "Willa", kiddoCurrentFavorites: ["Go-Gurt", "chicken nuggets", "Goldfish crackers"] };
        const logs = await storage.getKiddoFoodLogs();
        const accepted = logs.filter(l => l.verdict === "accepted");
        const rejected = logs.filter(l => l.verdict === "rejected");

        const totalTrials = accepted.length + rejected.length;
        const acceptanceRate = totalTrials > 0 ? Math.round((accepted.length / totalTrials) * 100) : 0;

        const recentRejections = rejected.filter(r => {
          const d = new Date(r.logDate);
          return (new Date().getTime() - d.getTime()) < 14 * 86400000;
        });

        let strategy = "normal";
        if (recentRejections.length >= 3) strategy = "cautious (many recent rejections)";
        else if (accepted.length > rejected.length * 2) strategy = "adventurous (good acceptance rate)";

        const lines = [
          `=== Picky Eater Profile: ${prefs.kiddoName || "Willa"} ===`,
          "",
          `Current favorites: ${(prefs.kiddoCurrentFavorites || []).join(", ")}`,
          "",
          `Accepted foods (${accepted.length}):`,
        ];
        for (const a of accepted.slice(0, 10)) {
          lines.push(`  ✅ ${a.itemName}${a.similaritySource ? ` (bridge from: ${a.similaritySource})` : ""}`);
        }
        lines.push("", `Rejected foods (${rejected.length}):`);
        for (const r of rejected.slice(0, 10)) {
          lines.push(`  ❌ ${r.itemName}${r.similaritySource ? ` (bridge from: ${r.similaritySource})` : ""}`);
        }
        lines.push("", `Acceptance rate: ${acceptanceRate}% (${accepted.length}/${totalTrials})`);
        lines.push(`Strategy: ${strategy}`);
        lines.push("", "Log new trials: meals kiddo-log <item> accepted|rejected");
        return ok(lines.join(nl));
      }

      if (sub === "kiddo-log") {
        const itemParts: string[] = [];
        let verdict = "";
        for (let i = 1; i < args.length; i++) {
          if (args[i] === "accepted" || args[i] === "rejected") {
            verdict = args[i];
            break;
          }
          itemParts.push(args[i]);
        }
        const itemName = itemParts.join(" ");
        if (!itemName || !verdict) {
          return fail("Usage: meals kiddo-log <item name> accepted|rejected");
        }

        const log = await storage.createKiddoFoodLog({
          itemName,
          verdict: verdict as "accepted" | "rejected",
        });

        const emoji = verdict === "accepted" ? "✅" : "❌";
        return ok(`${emoji} Logged: ${itemName} → ${verdict} (ID: ${log.id})`);
      }

      if (sub === "tonight") {
        const action = (args[1] || "").toLowerCase();
        const today = new Date().toISOString().split("T")[0];

        if (action === "accept" || action === "skip") {
          const todayRec = await storage.getNightlyRecommendationByDate(today);
          if (!todayRec) return fail("No recommendation for today to " + action);
          if (todayRec.status !== "pending") return fail(`Today's recommendation is already ${todayRec.status}.`);
          await storage.updateNightlyRecommendationStatus(todayRec.id, action === "accept" ? "accepted" : "skipped");
          return ok(`Recommendation ${action}ed. (ID: ${todayRec.id})`);
        }

        const rec = await storage.getNightlyRecommendationByDate(today);
        if (!rec) {
          return ok("No recommendation for tonight yet. The nightly program runs automatically.");
        }

        const lines = [`=== Tonight's Recommendation (${rec.recDate}) ===`, ""];

        if (rec.recipeRecommendation) {
          const r = rec.recipeRecommendation as any;
          lines.push("🍽️ Household Recipe:");
          lines.push(`  ${r.name} [${r.appliance}]`);
          if (r.ingredients) lines.push(`  Ingredients: ${r.ingredients.join(", ")}`);
          if (r.instructions) lines.push(`  ${r.instructions.slice(0, 200)}`);
          if (r.nutriScoreAvg) lines.push(`  Avg Nutri-Score: ${r.nutriScoreAvg}`);
          lines.push("");
        }

        if (rec.kiddoLunchSuggestion) {
          const k = rec.kiddoLunchSuggestion as any;
          lines.push("🧒 Kiddo Lunch Suggestion:");
          lines.push(`  ${k.item}`);
          if (k.bridgeRationale) lines.push(`  Bridge: ${k.bridgeRationale}`);
          if (k.similarTo) lines.push(`  Similar to: ${k.similarTo}`);
          lines.push("");
        }

        lines.push(`Status: ${rec.status}`);
        if (rec.status === "pending") {
          lines.push("", "Accept: meals tonight accept");
          lines.push("Skip: meals tonight skip");
        }
        return ok(lines.join(nl));
      }

      return ok([
        "Meal Planning & Grocery Cart Agent",
        "===================================",
        "  meals plan                          - Generate weekly meal plan (appliance-tagged)",
        "  meals add-recipe <name>             - Add a user recipe to the plan",
        "  meals list                          - Show current meal plan & shopping list",
        "  meals cart walmart|costco            - Build shopping list & add to store cart",
        "  meals prefs [set <key> <value>]      - View/update dietary preferences",
        "  meals history                       - Browse past meal plans",
        "  meals pantry                        - View pantry inventory with expiration dates",
        "  meals restock                       - Show items low or expiring soon",
        "  meals kiddo                         - Willa's picky eater profile",
        "  meals kiddo-log <item> accepted|rejected - Log food trial result",
        "  meals tonight                       - Show nightly recommendation",
        "  meals tonight accept|skip           - Accept or skip recommendation",
      ].join(nl));
    });

  registerCommand("boot", "Morning startup sequence", "boot [--status|--skip-login]", async (args) => {
    const nl = String.fromCharCode(10);
    const { isExtensionConnected } = await import("./bridge-queue");
    const { getSecret } = await import("./secrets");

    if (args[0] === "--status" || args[0] === "status") {
      const bridgeConnected = isExtensionConnected();
      const epicUser = await getSecret("epic_username");
      const lastLogin = await storage.getAgentConfig("boot_last_login");
      const lastOutlook = await storage.getAgentConfig("outlook_last_sync");
      const lastSnow = await storage.getAgentConfig("snow_last_sync");
      const lastWorkspace = await storage.getAgentConfig("boot_last_workspace");
      const keepalive = await storage.getAgentConfig("citrix_keepalive");

      const emailCount = (await storage.getOutlookEmails({ limit: 1 })).length > 0;
      const ticketCount = (await storage.getSnowTickets({ limit: 1 })).length > 0;

      const wsConfigKey = "citrix_workspace_apps";
      const DEFAULT_WS: Array<{ app: string; portal: string }> = [
        { app: "SUP Hyperdrive", portal: "UCSD CWP" },
        { app: "POC Hyperdrive", portal: "UCSD CWP" },
        { app: "TST Hyperdrive", portal: "UCSD CWP" },
        { app: "SUP Text Access", portal: "UCSD CWP" },
        { app: "POC Text Access", portal: "UCSD CWP" },
        { app: "TST Text Access", portal: "UCSD CWP" },
      ];
      let wsApps = DEFAULT_WS;
      try {
        const wsCfg = await storage.getAgentConfig(wsConfigKey);
        if (wsCfg?.value) {
          const parsed = JSON.parse(wsCfg.value);
          if (Array.isArray(parsed) && parsed.length > 0) {
            if (typeof parsed[0] === "string") {
              wsApps = parsed.map((a: string) => {
                const atIdx = a.lastIndexOf("@");
                if (atIdx > 0) return { app: a.substring(0, atIdx).trim(), portal: a.substring(atIdx + 1).trim() };
                return { app: a, portal: "UCSD CWP" };
              });
            } else {
              wsApps = parsed;
            }
          }
        }
      } catch {}

      function ageStr(isoStr: string | undefined): string {
        if (!isoStr) return "never";
        const age = Math.round((Date.now() - new Date(isoStr).getTime()) / 60000);
        if (age < 60) return `${age}m ago`;
        if (age < 1440) return `${Math.round(age / 60)}h ago`;
        return `${Math.round(age / 1440)}d ago`;
      }

      const lines = [
        "=== BOOT STATUS ===",
        "",
        `  Bridge:          ${bridgeConnected ? "CONNECTED" : "OFFLINE"}`,
        `  Epic Credentials: ${epicUser ? "configured" : "NOT SET"}`,
        `  Last Login:      ${ageStr(lastLogin?.value)}`,
        `  Last Workspace:  ${ageStr(lastWorkspace?.value)}`,
        `  Last Outlook:    ${ageStr(lastOutlook?.value)} ${emailCount ? "(data persisted)" : "(no data)"}`,
        `  Last SNOW:       ${ageStr(lastSnow?.value)} ${ticketCount ? "(data persisted)" : "(no data)"}`,
        `  Citrix Keepalive: ${keepalive?.value === "true" ? "ON" : "OFF"}`,
        "",
        `  Workspace Apps (${wsApps.length}):`,
        ...wsApps.map((e: { app: string; portal: string }) => `    - ${e.app}`),
        "",
        "  boot             - Run full startup",
        "  boot --skip-login - Skip login, just sync data",
      ];
      return ok(lines.join(nl));
    }

    const skipLogin = args.includes("--skip-login") || args.includes("--skip");

    if (args.includes("--stop") || args.includes("stop")) {
      await storage.setAgentConfig("boot_abort", "true", "boot");
      return ok("Boot abort signal sent. Running boot will stop after current step.");
    }

    await storage.setAgentConfig("boot_abort", "false", "boot");

    const steps: Array<{ name: string; run: () => Promise<string> }> = [];
    const agentPort = process.env.PORT || 5000;

    const checkAbort = async (): Promise<boolean> => {
      const v = await storage.getAgentConfig("boot_abort");
      return v?.value === "true";
    };

    const checkAgentConnected = async (): Promise<boolean> => {
      try {
        const statusResp = await fetch(`http://localhost:${agentPort}/api/epic/agent/status`);
        const statusData = statusResp.ok ? await statusResp.json() as { connected?: boolean } : { connected: false };
        return !!statusData.connected;
      } catch {
        return false;
      }
    };

    const sendAgentLogin = async (env: string, client: string, username: string, password: string): Promise<string> => {
      try {
        const resp = await fetch(`http://localhost:${agentPort}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.BRIDGE_TOKEN || ""}` },
          body: JSON.stringify({ type: "login", env, client, credentials: { username, password } }),
        });
        const data = resp.ok ? await resp.json() as { ok?: boolean; commandId?: string } : { ok: false };
        if (!data.ok || !data.commandId) return "login queue failed";

        const pollStart = Date.now();
        while (Date.now() - pollStart < 90000) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          if (await checkAbort()) return "aborted";
          try {
            const rResp = await fetch(`http://localhost:${agentPort}/api/epic/agent/result/${data.commandId}`);
            const rData = rResp.ok ? await rResp.json() as { status?: string; error?: string; data?: { logged_in?: number; details?: string[] } } : {};
            if (rData.status === "complete") {
              const count = rData.data?.logged_in ?? 0;
              const details = rData.data?.details;
              if (count > 0) return "logged in";
              const detail = details?.length ? details.join(" | ").substring(0, 120) : "no windows logged in";
              return `login failed: ${detail}`;
            }
            if (rData.status === "error") {
              const errMsg = rData.error || "unknown error";
              return `login failed: ${errMsg.substring(0, 80)}`;
            }
          } catch {}
        }
        return "login timeout";
      } catch (e: any) {
        return `login error: ${e.message?.substring(0, 40) || "unknown"}`;
      }
    };

    let cwpTabId: number | null = null;

    const checkAgentWindowExists = async (env: string, client: string): Promise<boolean> => {
      try {
        const resp = await fetch(`http://localhost:${agentPort}/api/epic/agent/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.BRIDGE_TOKEN || ""}` },
          body: JSON.stringify({ type: "check_windows", env, client }),
        });
        const data = resp.ok ? await resp.json() as { ok?: boolean; commandId?: string } : { ok: false };
        if (!data.ok || !data.commandId) return false;
        const pollStart = Date.now();
        while (Date.now() - pollStart < 10000) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          try {
            const rResp = await fetch(`http://localhost:${agentPort}/api/epic/agent/result/${data.commandId}`);
            const rData = rResp.ok ? await rResp.json() as { status?: string; data?: { found?: boolean; title?: string } } : {};
            if (rData.status === "complete") {
              return rData.data?.found === true;
            }
          } catch {}
        }
        return false;
      } catch { return false; }
    };

    const launchCitrixApp = async (appName: string, portalUrl: string): Promise<string> => {
      const { submitJob, waitForResult } = await import("./bridge-queue");
      try {
        const opts: Record<string, any> = {
          maxText: 2000,
          reuseTab: true,
          spaWaitMs: 2000,
          citrixApiLaunch: appName,
          autoOpenDownload: true,
          pollTimeoutMs: 15000,
        };
        if (cwpTabId) opts.reuseTabId = cwpTabId;
        const jobId = submitJob("dom", portalUrl, "boot-workspace", opts);
        const result = await waitForResult(jobId, 30000);
        if (result.tabId) cwpTabId = result.tabId;
        const debug = result.clickDebug || {};
        if (debug.error) {
          const availApps = debug.availableApps ? ` Available: ${debug.availableApps.slice(0, 10).join(", ")}` : "";
          const stepsStr = Array.isArray(debug.steps) ? debug.steps.join(" → ") : "";
          const matched = debug.matchedApp ? ` Matched: ${debug.matchedApp}` : "";
          const method = debug.method ? ` Method: ${debug.method}` : "";
          emitEvent("cli", `[citrix] ${appName}: ${debug.error}${matched}${method}${availApps}`, "warn", { metadata: { command: "boot" } });
          if (stepsStr) {
            emitEvent("cli", `[citrix] Debug steps: ${stepsStr.substring(0, 200)}`, "info", { metadata: { command: "boot" } });
          }
          return `launch failed: ${debug.error.substring(0, 80)}${availApps ? " — check app name" : ""}`;
        }
        if (debug.matchedApp) {
          const fuzzy = Array.isArray(debug.steps) && debug.steps.includes("fuzzy-match") ? " (fuzzy match)" : "";
          emitEvent("cli", `[citrix] Matched: ${debug.matchedApp} (${debug.method || "api"})${fuzzy}`, "info", { metadata: { command: "boot" } });
        }
        const dlResult = debug.dlResult || "";
        if (dlResult) {
          emitEvent("cli", `[citrix] Download: ${dlResult}`, "info", { metadata: { command: "boot" } });
        }
        if (dlResult.startsWith("timeout")) {
          emitEvent("cli", `[citrix] ICA download timed out for ${appName}`, "warn", { metadata: { command: "boot" } });
          return `launch failed: ICA download timeout for ${appName}`;
        }
        if (result.error) return `launch failed: ${result.error.substring(0, 50)}`;
        return "ok";
      } catch (e: any) {
        return `launch error: ${e.message?.substring(0, 50) || "unknown"}`;
      }
    };

    const waitForAgentWindow = async (env: string, client: string, timeoutMs: number = 30000): Promise<boolean> => {
      const POLL_INTERVAL = 3000;
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        if (await checkAbort()) return false;
        const found = await checkAgentWindowExists(env, client);
        if (found) {
          emitEvent("cli", `${env} ${client} window detected`, "info", { metadata: { command: "boot" } });
          return true;
        }
      }
      emitEvent("cli", `${env} ${client} window not detected after ${timeoutMs / 1000}s`, "warn", { metadata: { command: "boot" } });
      return false;
    };

    if (!skipLogin) {
      steps.push({
        name: "Epic Login (CWP)",
        run: async () => {
          const epicUser = await getSecret("epic_username");
          const epicPass = await getSecret("epic_password");
          if (!epicUser || !epicPass) return "SKIPPED (credentials not configured)";
          if (!isExtensionConnected()) return "SKIPPED (bridge not connected)";
          const { submitJob, waitForResult } = await import("./bridge-queue");
          try {
            const jobId = submitJob("dom", "https://cwp.ucsd.edu", "boot-cwp-login", {
              reuseTab: true,
              spaWaitMs: 5000,
              fillFields: {
                'input[name="username"], input[type="text"][id*="user"], #username, input[name="login"]': epicUser,
                'input[name="password"], input[type="password"], #password': epicPass,
              },
              submitSelector: 'button[type="submit"], input[type="submit"], #loginButton, button[name="submit"]',
              fillDelayMs: 300,
              waitAfterSubmitMs: 8000,
              maxText: 5000,
            });
            const cwpResult = await waitForResult(jobId, 60000);
            if (cwpResult.tabId) cwpTabId = cwpResult.tabId;
            if (cwpResult.error) return `failed: ${cwpResult.error.substring(0, 80)}`;
          } catch (e: any) {
            return `failed: ${e.message?.substring(0, 60) || "unknown"}`;
          }
          await storage.setAgentConfig("boot_last_login", new Date().toISOString(), "boot");
          return "done (approve Duo on phone)";
        },
      });

      steps.push({
        name: "Duo Wait",
        run: async () => {
          emitEvent("cli", "Waiting 30s for Duo approval...", "info", { metadata: { command: "boot" } });
          const { submitJob, waitForResult } = await import("./bridge-queue");
          const WAIT_MS = 30000;
          const POLL_MS = 5000;
          const start = Date.now();
          while (Date.now() - start < WAIT_MS) {
            await new Promise(resolve => setTimeout(resolve, POLL_MS));
            if (await checkAbort()) return "aborted";
            try {
              const opts: Record<string, any> = {
                maxText: 1000,
                reuseTab: true,
                spaWaitMs: 3000,
              };
              if (cwpTabId) opts.reuseTabId = cwpTabId;
              const jobId = submitJob("dom", "https://cwp.ucsd.edu", "boot-duo-check", opts);
              const check = await waitForResult(jobId, 15000);
              if (check.tabId) cwpTabId = check.tabId;
              const text = check.text || "";
              if (text.includes("Citrix") || text.includes("StoreFront") || text.includes("Desktops") || text.includes("Apps")) {
                return "done (Duo approved)";
              }
            } catch {}
          }
          return "done (30s elapsed — continue)";
        },
      });
    }

    const wsConfigKey = "citrix_workspace_apps";
    const DEFAULT_WS_APPS: Array<{ app: string; portal: string }> = [
      { app: "SUP Hyperdrive", portal: "UCSD CWP" },
      { app: "SUP Text Access", portal: "UCSD CWP" },
      { app: "POC Hyperdrive", portal: "UCSD CWP" },
      { app: "POC Text Access", portal: "UCSD CWP" },
      { app: "TST Hyperdrive", portal: "UCSD CWP" },
      { app: "TST Text Access", portal: "UCSD CWP" },
    ];

    let wsApps: Array<{ app: string; portal: string }> = DEFAULT_WS_APPS;
    try {
      const wsCfg = await storage.getAgentConfig(wsConfigKey);
      if (wsCfg?.value) {
        const parsed = JSON.parse(wsCfg.value);
        if (Array.isArray(parsed) && parsed.length > 0) {
          if (typeof parsed[0] === "string") {
            wsApps = parsed.map((a: string) => {
              const atIdx = a.lastIndexOf("@");
              if (atIdx > 0) return { app: a.substring(0, atIdx).trim(), portal: a.substring(atIdx + 1).trim() };
              return { app: a, portal: "UCSD CWP" };
            });
          } else {
            wsApps = parsed;
          }
        }
      }
    } catch {}

    const portalsCfg = await storage.getAgentConfig("citrix_portals");
    let portals: Array<{ name: string; url: string }> = [{ name: "UCSD CWP", url: "https://cwp.ucsd.edu" }];
    if (portalsCfg?.value) {
      try {
        const parsed = JSON.parse(portalsCfg.value);
        if (Array.isArray(parsed) && parsed.length > 0) portals = parsed;
      } catch {}
    }

    const epicUser = !skipLogin ? await getSecret("epic_username") : null;
    const epicPass = !skipLogin ? await getSecret("epic_password") : null;

    const parseAppEnvClient = (appName: string): { env: string; client: string } => {
      const upper = appName.toUpperCase();
      let env = "SUP";
      if (upper.includes("POC")) env = "POC";
      else if (upper.includes("TST")) env = "TST";
      const client = (upper.includes("TEXT") || upper.includes("TERMINAL") || upper.includes("SESSION")) ? "text" : "hyperspace";
      return { env, client };
    };

    const APP_OPEN_WAIT_MS = 12000;

    const envGroups = new Map<string, { hyperdrive: typeof wsApps[0] | null; text: typeof wsApps[0] | null; portal: string }>();
    for (const entry of wsApps) {
      const { env, client } = parseAppEnvClient(entry.app);
      const portal = portals.find(p => p.name.toLowerCase() === entry.portal.toLowerCase());
      const portalUrl = portal?.url || "https://cwp.ucsd.edu";
      if (!envGroups.has(env)) envGroups.set(env, { hyperdrive: null, text: null, portal: portalUrl });
      const group = envGroups.get(env)!;
      group.portal = portalUrl;
      if (client === "text") group.text = entry;
      else group.hyperdrive = entry;
    }

    let loginEverFailed = false;
    const isLoginSuccess = (r: string) => r === "logged in";

    for (const [env, group] of envGroups) {
      let envHyperdriveOk = false;

      if (group.hyperdrive) {
        steps.push({
          name: group.hyperdrive.app,
          run: async () => {
            if (await checkAbort()) return "aborted";
            if (loginEverFailed) return "skipped (prior login failed)";
            if (!isExtensionConnected()) return "SKIPPED (bridge not connected)";

            const agentUp = await checkAgentConnected();
            let windowAlreadyExists = false;
            if (agentUp) {
              windowAlreadyExists = await checkAgentWindowExists(env, "hyperspace");
              if (windowAlreadyExists) {
                emitEvent("cli", `${group.hyperdrive!.app} window already open — skipping Citrix launch`, "info", { metadata: { command: "boot" } });
              }
            }

            if (!windowAlreadyExists) {
              emitEvent("cli", `Launching ${group.hyperdrive!.app}...`, "info", { metadata: { command: "boot" } });
              const launchResult = await launchCitrixApp(group.hyperdrive!.app, group.portal);
              if (launchResult !== "ok") { loginEverFailed = true; return launchResult; }

              if (agentUp) {
                emitEvent("cli", `Waiting for ${group.hyperdrive!.app} window...`, "info", { metadata: { command: "boot" } });
                const detected = await waitForAgentWindow(env, "hyperspace", 30000);
                if (!detected) {
                  await new Promise(resolve => setTimeout(resolve, APP_OPEN_WAIT_MS));
                }
              } else {
                await new Promise(resolve => setTimeout(resolve, APP_OPEN_WAIT_MS));
              }
            }

            if (await checkAbort()) return "launched (aborted before login)";

            if (!skipLogin && epicUser && epicPass) {
              if (!agentUp) return "launched (agent not connected)";

              emitEvent("cli", `Logging into ${group.hyperdrive!.app}...`, "info", { metadata: { command: "boot" } });
              const loginResult = await sendAgentLogin(env, "hyperspace", epicUser, epicPass);
              await storage.setAgentConfig("boot_last_workspace", new Date().toISOString(), "boot");

              if (isLoginSuccess(loginResult)) {
                envHyperdriveOk = true;
                return loginResult;
              }
              loginEverFailed = true;
              return loginResult;
            }

            await storage.setAgentConfig("boot_last_workspace", new Date().toISOString(), "boot");
            envHyperdriveOk = true;
            return "launched";
          },
        });
      }

      if (group.text) {
        steps.push({
          name: group.text.app,
          run: async () => {
            if (await checkAbort()) return "aborted";
            if (loginEverFailed) return "skipped (prior login failed)";
            if (group.hyperdrive && !envHyperdriveOk) return `skipped (${env} Hyperdrive login not confirmed)`;
            if (!isExtensionConnected()) return "SKIPPED (bridge not connected)";

            const agentUp = await checkAgentConnected();
            let textWindowExists = false;
            if (agentUp) {
              textWindowExists = await checkAgentWindowExists(env, "text");
              if (textWindowExists) {
                emitEvent("cli", `${group.text!.app} window already open — skipping Citrix launch`, "info", { metadata: { command: "boot" } });
              }
            }

            if (!textWindowExists) {
              emitEvent("cli", `Launching ${group.text!.app}...`, "info", { metadata: { command: "boot" } });
              const launchResult = await launchCitrixApp(group.text!.app, group.portal);
              if (launchResult !== "ok") { loginEverFailed = true; return launchResult; }

              if (agentUp) {
                emitEvent("cli", `Waiting for ${group.text!.app} window...`, "info", { metadata: { command: "boot" } });
                const detected = await waitForAgentWindow(env, "text", 30000);
                if (!detected) {
                  await new Promise(resolve => setTimeout(resolve, APP_OPEN_WAIT_MS));
                }
              } else {
                await new Promise(resolve => setTimeout(resolve, APP_OPEN_WAIT_MS));
              }
            }

            if (await checkAbort()) return "launched (aborted before login)";

            if (!skipLogin && epicUser && epicPass) {
              if (!agentUp) return "launched (agent not connected)";

              emitEvent("cli", `Logging into ${group.text!.app}...`, "info", { metadata: { command: "boot" } });
              const loginResult = await sendAgentLogin(env, "text", epicUser, epicPass);
              await storage.setAgentConfig("boot_last_workspace", new Date().toISOString(), "boot");

              if (!isLoginSuccess(loginResult)) {
                loginEverFailed = true;
              }
              return loginResult;
            }

            await storage.setAgentConfig("boot_last_workspace", new Date().toISOString(), "boot");
            return "launched";
          },
        });
      }
    }

    steps.push({
      name: "Outlook Sync",
      run: async () => {
        if (await checkAbort()) return "aborted";
        if (!isExtensionConnected()) {
          const persisted = await storage.getOutlookEmails({ limit: 50 });
          const unread = persisted.filter(e => e.unread).length;
          if (persisted.length > 0) return `offline — ${persisted.length} emails in DB (${unread} unread)`;
          return "SKIPPED (bridge not connected, no persisted data)";
        }
        const lastSync = await storage.getOutlookSyncTimestamp();
        const isFirstSync = !lastSync;
        const result = await executeChainRaw(`outlook inbox${isFirstSync ? " --refresh" : ""}`);
        if (result.exitCode !== 0) return `failed: ${result.stdout.slice(0, 80)}`;
        const match = result.stdout.match(/(\d+) messages/);
        const deltaMatch = result.stdout.match(/(\d+) new, (\d+) updated/);
        if (deltaMatch) return `done (${match?.[1] || "?"} total, ${deltaMatch[1]} new, ${deltaMatch[2]} updated)`;
        return match ? `done (${match[1]} emails)` : "done";
      },
    });

    steps.push({
      name: "ServiceNow Sync",
      run: async () => {
        if (await checkAbort()) return "aborted";
        if (!isExtensionConnected()) {
          const persisted = await storage.getSnowTickets({ limit: 200 });
          if (persisted.length > 0) return `offline — ${persisted.length} tickets in DB`;
          return "SKIPPED (bridge not connected, no persisted data)";
        }
        const lastSync = await storage.getSnowSyncTimestamp();
        const isFirstSync = !lastSync;
        if (isFirstSync) {
          const result = await executeChainRaw("snow refresh");
          if (result.exitCode !== 0) return `failed: ${result.stdout.slice(0, 80)}`;
          const match = result.stdout.match(/Total:\s+(\d+)/);
          return match ? `done (${match[1]} tickets)` : "done";
        }
        const types = ["incidents", "changes", "requests"];
        const summaries: string[] = [];
        for (const t of types) {
          const result = await executeChainRaw(`snow ${t}`);
          if (result.exitCode === 0) {
            const match = result.stdout.match(/(\d+)\s+(incident|change|request)/i);
            summaries.push(`${match?.[1] || "?"} ${t}`);
          }
        }
        return `done (${summaries.join(", ")})`;
      },
    });

    steps.push({
      name: "Citrix Keepalive",
      run: async () => {
        await storage.setAgentConfig("citrix_keepalive", "true", "citrix");
        startCitrixKeepalive();
        return "enabled (10m interval)";
      },
    });

    const lines = ["=== MORNING BOOT ===", ""];
    let failed = 0;
    let aborted = false;
    for (const step of steps) {
      if (aborted) {
        lines.push(`  [~] ${step.name}: skipped (boot aborted)`);
        continue;
      }
      emitEvent("cli", `Boot: ${step.name}...`, "info", { metadata: { command: "boot" } });
      try {
        const result = await step.run();
        if (result === "aborted") {
          aborted = true;
          lines.push(`  [!] ${step.name}: ABORTED`);
          continue;
        }
        const isFailure = result.startsWith("failed") || result.startsWith("launch failed") || result.startsWith("launch error") || result.startsWith("login failed");
        const isSkip = result.startsWith("SKIPPED") || result.startsWith("skipped");
        const icon = isFailure || isSkip ? "x" : "+";
        if (isFailure) failed++;
        lines.push(`  [${icon}] ${step.name}: ${result}`);
      } catch (e: any) {
        failed++;
        lines.push(`  [x] ${step.name}: ERROR - ${e.message}`);
      }
    }

    await storage.setAgentConfig("boot_last_run", new Date().toISOString(), "boot");
    await storage.setAgentConfig("boot_abort", "false", "boot");

    lines.push("");
    if (aborted) {
      lines.push("  Boot was aborted. Run 'boot' to restart.");
    } else if (failed > 0) {
      lines.push(`  ${steps.length - failed}/${steps.length} steps completed. ${failed} failed.`);
    } else {
      lines.push(`  All ${steps.length} steps completed.`);
    }
    lines.push("");
    lines.push("  boot --status  Check system status");
    lines.push("  boot --stop    Abort running boot");

    return ok(lines.join(nl));
  });

  registerCommand("ask", "Ask a question with memory-aware context and smart model routing",
    "ask <question> | ask --model <model> <q> | ask --cheap|--standard|--premium <q> | ask --compare <q> | ask --reset | ask --prefer <model> | ask local [on|off]",
    async (args, _stdin) => {
      const nl = String.fromCharCode(10);

      if (args.length === 0) {
        const status = await getPreprocessStatus();
        const pref = getPreferredModel();
        const lines = [
          "=== ASK ===",
          "",
          "Pre-processing: DeepSeek (cheap LLM) handles classification, memory",
          "filtering, KB verification, and context compression automatically.",
          `Local fallback: ${status.localFallback ? "ON" : "OFF"} (used when no cloud API keys)`,
          `Preferred model: ${pref || "(auto-route by complexity)"}`,
          "",
          "Usage:",
          "  ask <question>                Ask with smart routing and memory context",
          "  ask --model <id> <question>   Override model for this query",
          "  ask --cheap <question>        Route to cheapest model",
          "  ask --standard <question>     Route to standard-tier model",
          "  ask --premium <question>      Route to premium-tier model",
          "  ask --compare <question>      Compare cheap vs premium side by side",
          "  ask --reset                   Clear conversation context",
          "  ask --prefer <model>          Set default model preference",
          "  ask status                    Show pre-processing pipeline stats",
          "  ask local on|off              Toggle local model fallback",
        ];
        return ok(lines.join(nl));
      }

      if (args[0] === "status") {
        const status = await getPreprocessStatus();
        const lines = [
          "=== ASK PRE-PROCESSING PIPELINE ===",
          "",
          "Primary: Cheap cloud LLM (DeepSeek or cheapest in roster)",
          "  Handles: classification, memory filtering, KB verification,",
          "           quality gating, context compression",
          "",
          `  Queries processed:   ${status.queriesProcessed}`,
          `  Tokens saved:        ~${status.tokensSavedEstimate} (on main model)`,
          `  Preprocess tokens:   ${status.preprocessTokensUsed}`,
          `  Preprocess cost:     $${status.preprocessCost.toFixed(4)}`,
          `  KB direct hits:      ${status.kbDirectHits}`,
          `  Quality gate catches:${status.qualityGateCatches}`,
          "",
          `Fallback: Local Ollama (${status.localModelName})`,
          `  Status:              ${status.localFallback ? "ENABLED" : "DISABLED"}`,
          `  Model loaded:        ${status.localModelLoaded ? "yes" : "no"}`,
          `  RAM usage:           ${status.ramUsage}`,
          "",
          "Pipeline order:",
          "  1. Classify query (cheap LLM -> local fallback -> heuristics)",
          "  2. Search KB for direct answer",
          "  3. Verify KB match (cheap LLM)",
          "  4. Quality-gate KB answer (cheap LLM) — catch bad answers",
          "  5. Search + filter memories (cheap LLM prunes irrelevant)",
          "  6. Compress context if routing to expensive model",
          "  7. Route to appropriate model tier based on complexity",
        ];
        return ok(lines.join(nl));
      }

      if (args[0] === "local") {
        if (args.length === 1) {
          const status = await getPreprocessStatus();
          const lines = [
            "=== LOCAL MODEL FALLBACK ===",
            "",
            `  Status:           ${status.localFallback ? "ENABLED" : "DISABLED"}`,
            `  Model:            ${status.localModelName}`,
            `  Model loaded:     ${status.localModelLoaded ? "yes" : "no"}`,
            `  RAM usage:        ${status.ramUsage}`,
            "",
            "The local model is a fallback for when no cloud API keys are available.",
            "It handles basic query classification only. All other pre-processing",
            "(memory filtering, KB verification, quality gating, context compression)",
            "requires the cheap cloud LLM (DeepSeek) for reliable results.",
            "",
            "Toggle: ask local on | ask local off",
          ];
          return ok(lines.join(nl));
        }

        const toggle = args[1]?.toLowerCase();
        if (toggle === "on") {
          await setLocalFallback(true);
          emitEvent("ask", "Local model fallback enabled", "action");
          const status = await getPreprocessStatus();
          return ok("Local model fallback: ON\nModel: " + status.localModelName);
        }
        if (toggle === "off") {
          await setLocalFallback(false);
          emitEvent("ask", "Local model fallback disabled", "action");
          return ok("Local model fallback: OFF");
        }
        return fail(`[error] ask local: expected on|off, got "${toggle}"`);
      }

      if (args[0] === "--reset") {
        resetConversation();
        return ok("Conversation context cleared.");
      }

      if (args[0] === "--prefer") {
        const modelRef = args.slice(1).join(" ");
        if (!modelRef) return fail("[error] ask --prefer: provide a model name or id");
        await setPreferredModel(modelRef);
        const current = getPreferredModel();
        if (current) {
          emitEvent("ask", `Model preference set: ${current}`, "action");
          return ok(`Default model preference set to: ${current}\nClear with: ask --prefer auto`);
        } else {
          emitEvent("ask", "Model preference cleared (auto-routing)", "action");
          return ok("Model preference cleared. Using automatic routing.");
        }
      }

      let modelOverride: string | undefined;
      let tierOverride: "cheap" | "standard" | "premium" | undefined;
      let compareMode = false;
      let questionArgs = [...args];

      if (args[0] === "--model" && args.length >= 3) {
        modelOverride = args[1];
        questionArgs = args.slice(2);
      } else if (args[0] === "--cheap") {
        tierOverride = "cheap";
        questionArgs = args.slice(1);
      } else if (args[0] === "--standard") {
        tierOverride = "standard";
        questionArgs = args.slice(1);
      } else if (args[0] === "--premium") {
        tierOverride = "premium";
        questionArgs = args.slice(1);
      } else if (args[0] === "--compare") {
        compareMode = true;
        questionArgs = args.slice(1);
      }

      const question = questionArgs.join(" ");
      if (!question.trim()) {
        return fail("[error] ask: provide a question");
      }

      if (compareMode) {
        emitEvent("ask", `Compare mode: "${question.slice(0, 80)}"`, "action");
        const result = await askCompare(question);
        if (result.results.length === 0) {
          return fail("[error] No models available for comparison");
        }

        const lines = ["=== MODEL COMPARISON ===", ""];
        for (const r of result.results) {
          const costStr = r.cost > 0 ? `$${r.cost.toFixed(4)}` : "N/A";
          lines.push(`--- ${r.label} (${r.tier}) ---`);
          lines.push(`  Model:    ${r.model}`);
          lines.push(`  Tokens:   ${r.tokensUsed}`);
          lines.push(`  Cost:     ${costStr}`);
          lines.push(`  Time:     ${r.durationMs}ms`);
          lines.push("");
          const answerLines = r.answer.split("\n");
          for (const al of answerLines) {
            lines.push(`  ${al}`);
          }
          lines.push("");
        }

        const totalCost = result.results.reduce((s, r) => s + r.cost, 0);
        lines.push(`Total cost: $${totalCost.toFixed(4)}`);
        lines.push("");
        lines.push("Set preference: ask --prefer <model-name>");

        return ok(lines.join(nl));
      }

      emitEvent("ask", `Query: "${question.slice(0, 80)}"`, "action");
      const result = await askEngine(question, {
        model: modelOverride,
        tier: tierOverride,
      });

      const lines: string[] = [];

      if (result.fromKb) {
        lines.push("[Source: Galaxy KB — verified by cheap LLM, 0 main-model tokens]");
        lines.push("");
      }

      lines.push(result.answer);
      lines.push("");
      lines.push("---");
      lines.push(`Model: ${result.model} | Tokens: ${result.tokensUsed} | Cost: $${result.cost.toFixed(4)}`);
      lines.push(`Routing: ${result.routingReason}`);

      if (result.compressed) {
        lines.push(`Context compressed: ~${result.tokensSaved} tokens saved via cheap-model pre-processing`);
      }

      if (result.preprocessModel) {
        lines.push(`Pre-processor: ${result.preprocessModel} ($${(result.preprocessCost || 0).toFixed(4)} total preprocess cost)`);
      }

      return ok(lines.join(nl));
    });
}

registerBuiltinCommands();

export function getRegisteredCommands(): string[] {
  return Array.from(commands.keys());
}

export function getCommandHelp(): string {
  return getCommandList();
}
