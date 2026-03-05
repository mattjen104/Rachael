import * as chrono from "chrono-node";

export interface ParsedCapture {
  type: "task" | "note";
  title: string;
  scheduledDate?: string;
  deadlineDate?: string;
  scheduledTime?: string;
  nestingLevel: number;
  tags: string[];
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

export function parseCaptureEntry(input: string): ParsedCapture {
  const trimmed = input.trim();
  if (!trimmed) return { type: "note", title: "", nestingLevel: 0, tags: [] };

  let body = trimmed;
  let nestingLevel = 0;

  const nestMatch = body.match(/^(>+)\s*/);
  if (nestMatch) {
    nestingLevel = nestMatch[1].length;
    body = body.slice(nestMatch[0].length);
  }

  let type: ParsedCapture["type"] = "note";
  if (/^t\s+/i.test(body)) {
    type = "task";
    body = body.replace(/^t\s+/i, "").trim();
  }

  if (type === "note") {
    return {
      type: "note",
      title: body,
      nestingLevel,
      tags: [],
    };
  }

  const isDeadline = /\b(due|by)\s+/i.test(body);

  const results = chrono.parse(body, new Date(), { forwardDate: true });

  let scheduledDate: string | undefined;
  let deadlineDate: string | undefined;
  let scheduledTime: string | undefined;
  let title = body;

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

    title = body.slice(0, parsed.index).trim();
    const afterDate = body.slice(parsed.index + parsed.text.length).trim();
    if (afterDate) {
      title = title ? `${title} ${afterDate}` : afterDate;
    }
  }

  if (!title) title = body;

  title = title.replace(/\s+/g, " ").trim();
  title = title.replace(/^(due|by)\s*/i, "").trim();

  if (!title) title = body;

  return {
    type: "task",
    title: title.charAt(0).toUpperCase() + title.slice(1),
    scheduledDate,
    deadlineDate,
    scheduledTime,
    nestingLevel,
    tags: [],
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

  if (body) {
    lines.push(`${indent}`);
    const bodyLines = body.split("\n").map(l => `${indent}${l}`);
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
