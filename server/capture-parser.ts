import * as chrono from "chrono-node";

export interface ParsedCapture {
  type: "task" | "note";
  title: string;
  body?: string;
  scheduledDate?: string;
  deadlineDate?: string;
  scheduledTime?: string;
  nestingLevel: number;
  tags: string[];
  priority?: string;
  repeat?: string;
}

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function formatTime(d: Date): string {
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

function getDayAbbrev(d: Date): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
}

function extractTags(text: string): { cleaned: string; tags: string[] } {
  const tags: string[] = [];
  const cleaned = text.replace(/#(\w[\w-]*)/g, (_, tag) => {
    tags.push(tag.toLowerCase());
    return "";
  });
  return { cleaned: cleaned.replace(/\s+/g, " ").trim(), tags };
}

function extractPriority(text: string): { cleaned: string; priority?: string } {
  const match = text.match(/!([ABC])\b/i);
  if (match) {
    const priority = match[1].toUpperCase();
    const cleaned = text.replace(/!([ABC])\b/i, "").replace(/\s+/g, " ").trim();
    return { cleaned, priority };
  }
  return { cleaned: text };
}

function extractRepeat(text: string): { cleaned: string; repeat?: string } {
  const patterns: Array<[RegExp, string]> = [
    [/\bevery\s+day\b/i, "+1d"],
    [/\bevery\s+week\b/i, "+1w"],
    [/\bevery\s+month\b/i, "+1m"],
    [/\bevery\s+monday\b/i, "+1w"],
    [/\bevery\s+tuesday\b/i, "+1w"],
    [/\bevery\s+wednesday\b/i, "+1w"],
    [/\bevery\s+thursday\b/i, "+1w"],
    [/\bevery\s+friday\b/i, "+1w"],
    [/\bevery\s+saturday\b/i, "+1w"],
    [/\bevery\s+sunday\b/i, "+1w"],
    [/\+1d\b/, "+1d"],
    [/\+1w\b/, "+1w"],
    [/\+1m\b/, "+1m"],
  ];
  for (const [pattern, repeat] of patterns) {
    if (pattern.test(text)) {
      const cleaned = text.replace(pattern, "").replace(/\s+/g, " ").trim();
      return { cleaned, repeat };
    }
  }
  return { cleaned: text };
}

export function parseCaptureEntry(input: string): ParsedCapture {
  const trimmed = input.trim();
  if (!trimmed) return { type: "note", title: "", nestingLevel: 0, tags: [] };

  const lines = trimmed.split("\n");
  const firstLine = lines[0];
  const bodyLines = lines.slice(1);
  const body = bodyLines.length > 0 ? bodyLines.join("\n").trim() : undefined;

  let mainText = firstLine;
  let nestingLevel = 0;

  const nestMatch = mainText.match(/^(>+)\s*/);
  if (nestMatch) {
    nestingLevel = nestMatch[1].length;
    mainText = mainText.slice(nestMatch[0].length);
  }

  let type: ParsedCapture["type"] = "note";
  if (/^t\s+/i.test(mainText)) {
    type = "task";
    mainText = mainText.replace(/^t\s+/i, "").trim();
  }

  const tagResult = extractTags(mainText);
  mainText = tagResult.cleaned;
  const tags = tagResult.tags;

  const priorityResult = extractPriority(mainText);
  mainText = priorityResult.cleaned;
  const priority = priorityResult.priority;

  const repeatResult = extractRepeat(mainText);
  mainText = repeatResult.cleaned;
  const repeat = repeatResult.repeat;

  if (type === "note") {
    return {
      type: "note",
      title: mainText,
      body,
      nestingLevel,
      tags,
      priority,
    };
  }

  const isDeadline = /\b(due|by)\s+/i.test(mainText);

  const results = chrono.parse(mainText, new Date(), { forwardDate: true });

  let scheduledDate: string | undefined;
  let deadlineDate: string | undefined;
  let scheduledTime: string | undefined;
  let title = mainText;

  if (results.length > 0) {
    const parsed = results[0];
    const d = parsed.start.date();

    if (isDeadline) {
      deadlineDate = formatDate(d);
    } else {
      scheduledDate = formatDate(d);
    }

    if (parsed.start.isCertain("hour")) {
      scheduledTime = formatTime(d);
    }

    title = mainText.slice(0, parsed.index).trim();
    const afterDate = mainText.slice(parsed.index + parsed.text.length).trim();
    if (afterDate) {
      title = title ? `${title} ${afterDate}` : afterDate;
    }
  }

  if (!title) title = mainText;

  title = title.replace(/\s+/g, " ").trim();
  title = title.replace(/^(due|by)\s*/i, "").trim();

  if (!title) title = mainText;

  return {
    type: "task",
    title: title.charAt(0).toUpperCase() + title.slice(1),
    body,
    scheduledDate,
    deadlineDate,
    scheduledTime,
    nestingLevel,
    tags,
    priority,
    repeat,
  };
}

export function formatOrgEntry(parsed: ParsedCapture, body?: string): string {
  const { type, title, scheduledDate, deadlineDate, scheduledTime, nestingLevel, tags } = parsed;

  const stars = "*".repeat(2 + nestingLevel);
  const tagStr = tags.length > 0 ? ` :${tags.join(":")}:` : "";
  const indent = "   ";

  let heading: string;
  if (type === "task") {
    heading = `${stars} TODO ${title}${tagStr}`;
  } else {
    heading = `${stars} ${title}${tagStr}`;
  }

  const lines = [heading];

  if (scheduledDate) {
    const d = new Date(scheduledDate + "T12:00:00");
    const dayAbbr = getDayAbbrev(d);
    const timeStr = scheduledTime ? ` ${scheduledTime}` : "";
    lines.push(`${indent}SCHEDULED: <${scheduledDate} ${dayAbbr}${timeStr}>`);
  }

  if (deadlineDate) {
    const d = new Date(deadlineDate + "T12:00:00");
    const dayAbbr = getDayAbbrev(d);
    const timeStr = scheduledTime ? ` ${scheduledTime}` : "";
    lines.push(`${indent}DEADLINE: <${deadlineDate} ${dayAbbr}${timeStr}>`);
  }

  const bodyText = body || parsed.body;
  if (bodyText) {
    lines.push(`${indent}`);
    const bodyLines = bodyText.split("\n").map(l => `${indent}${l}`);
    lines.push(...bodyLines);
  }

  return "\n" + lines.join("\n") + "\n";
}

export function formatNoteContent(text: string, body?: string): string {
  const lines: string[] = [];
  lines.push(`   ${text}`);
  if (body && body !== text) {
    lines.push(`   ${body}`);
  }
  return "\n" + lines.join("\n") + "\n";
}
