import * as chrono from "chrono-node";

export interface ParsedCapture {
  type: "task" | "appointment" | "note" | "plain";
  title: string;
  scheduledDate?: string;
  deadlineDate?: string;
  scheduledTime?: string;
  tags: string[];
}

const prefixMap: Record<string, ParsedCapture["type"]> = {
  "t ": "task",
  "a ": "appointment",
  "n ": "note",
};

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
  if (!trimmed) return { type: "plain", title: "", tags: [] };

  let type: ParsedCapture["type"] = "plain";
  let body = trimmed;

  for (const [prefix, pType] of Object.entries(prefixMap)) {
    if (trimmed.toLowerCase().startsWith(prefix)) {
      type = pType;
      body = trimmed.slice(prefix.length).trim();
      break;
    }
  }

  if (type === "plain") {
    return { type: "plain", title: trimmed, tags: [] };
  }

  const tags: string[] = [];
  if (type === "appointment") tags.push("appointment");

  const byMatch = body.match(/\bby\s+(.+)/i);
  let isDeadline = false;
  if (byMatch && type === "task") {
    isDeadline = true;
  }

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
  title = title.replace(/^by\s*/i, "").trim();

  return {
    type,
    title: title.charAt(0).toUpperCase() + title.slice(1),
    scheduledDate,
    deadlineDate,
    scheduledTime,
    tags,
  };
}

export function formatOrgEntry(parsed: ParsedCapture): string {
  const { type, title, scheduledDate, deadlineDate, scheduledTime, tags } = parsed;

  const tagStr = tags.length > 0 ? ` :${tags.join(":")}:` : "";

  let heading: string;
  if (type === "note") {
    heading = `** ${title}${tagStr}`;
  } else {
    heading = `** TODO ${title}${tagStr}`;
  }

  const lines = [heading];

  if (scheduledDate) {
    const d = new Date(scheduledDate + "T12:00:00");
    const dayAbbr = getDayAbbrev(d);
    const timeStr = scheduledTime ? ` ${scheduledTime}` : "";
    lines.push(`   SCHEDULED: <${scheduledDate} ${dayAbbr}${timeStr}>`);
  }

  if (deadlineDate) {
    const d = new Date(deadlineDate + "T12:00:00");
    const dayAbbr = getDayAbbrev(d);
    const timeStr = scheduledTime ? ` ${scheduledTime}` : "";
    lines.push(`   DEADLINE: <${deadlineDate} ${dayAbbr}${timeStr}>`);
  }

  if (!scheduledDate && !deadlineDate && type !== "note") {
    const today = new Date();
    const dateStr = formatDate(today);
    const dayAbbr = getDayAbbrev(today);
    lines.push(`   SCHEDULED: <${dateStr} ${dayAbbr}>`);
  }

  return "\n" + lines.join("\n") + "\n";
}
