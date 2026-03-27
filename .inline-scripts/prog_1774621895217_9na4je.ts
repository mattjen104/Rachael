
const __ctx = JSON.parse(process.env.__INLINE_CTX || '{}');
const config = __ctx.properties || {};
const __projectRoot = process.env.__PROJECT_ROOT || process.cwd();
const __skillPath = (name: string) => __projectRoot + "/skills/" + name;
const __bridgePort = process.env.__BRIDGE_PORT || "5000";
const __bridgeToken = process.env.__BRIDGE_TOKEN || "";
const __apiKey = process.env.__API_KEY || "";

const __BRIDGE_ONLY_DOMAINS = ["galaxy.epic.com", ".ucsd.edu", "pulse.ucsd.edu", ".reddit.com", "reddit.com", ".live.com", "outlook.live.com", ".office.com", "teams.microsoft.com"];
function __isBridgeOnly(targetUrl: string): boolean {
  try {
    const host = new URL(targetUrl).hostname.toLowerCase();
    return __BRIDGE_ONLY_DOMAINS.some(d => d.startsWith(".") ? host.endsWith(d) || host === d.slice(1) : host === d);
  } catch { return false; }
}

async function bridgeFetch(url: string, options?: { type?: "fetch" | "dom"; selectors?: Record<string, string>; timeout?: number; headers?: Record<string, string> }): Promise<{ status?: number; body?: any; text?: string; extracted?: any; error?: string; source?: string }> {
  const type = options?.type || "fetch";
  const timeout = options?.timeout || 45000;
  const bridgeOnly = __isBridgeOnly(url);
  const directFallback = async (): Promise<{ status?: number; body?: any; text?: string; error?: string; source?: string }> => {
    if (bridgeOnly) return { error: "bridge-only domain — direct fetch blocked (requires browser bridge with real session)", source: "blocked" };
    try {
      const r = await fetch(url, { headers: options?.headers || { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" }, signal: AbortSignal.timeout(15000) });
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("json")) { const j = await r.json(); return { status: r.status, body: j, text: JSON.stringify(j), source: "direct" }; }
      const t = await r.text(); return { status: r.status, body: t, text: t, source: "direct" };
    } catch (e2: any) {
      return { error: e2.message || String(e2), source: "direct" };
    }
  };
  try {
    const r = await fetch("http://localhost:" + __bridgePort + "/api/bridge/ext/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Token": __bridgeToken },
      body: JSON.stringify({ type, url, submittedBy: "program", wait: timeout, options: { selectors: options?.selectors, headers: options?.headers, maxText: 15000 } }),
    });
    if (!r.ok) return await directFallback();
    const result = await r.json();
    if (result.error) {
      if (bridgeOnly) return { error: result.error + " (bridge-only domain, no fallback)", source: "bridge-only-failed" };
      const fallback = await directFallback();
      if (!fallback.error) return fallback;
      return { error: result.error + " (bridge); " + fallback.error + " (direct)", source: "both-failed" };
    }
    if (result.body && !result.text) result.text = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
    result.source = result.source || "bridge";
    return result;
  } catch (e: any) {
    return await directFallback();
  }
}

async function smartFetch(url: string, init?: RequestInit): Promise<Response> {
  const ANTI_BOT = [403, 429, 503];
  if (__isBridgeOnly(url)) {
    const bridgeResult = await bridgeFetch(url, { type: "fetch", headers: init?.headers as Record<string, string> | undefined });
    if (bridgeResult.error) throw new Error(bridgeResult.error);
    const body = bridgeResult.text || (typeof bridgeResult.body === "string" ? bridgeResult.body : JSON.stringify(bridgeResult.body));
    return new Response(body, { status: bridgeResult.status || 200, headers: { "content-type": "text/html" } });
  }
  try {
    const r = await fetch(url, init);
    if (ANTI_BOT.includes(r.status)) {
      const bridgeResult = await bridgeFetch(url, { type: "fetch", headers: init?.headers as Record<string, string> | undefined });
      if (!bridgeResult.error) {
        const body = bridgeResult.text || (typeof bridgeResult.body === "string" ? bridgeResult.body : JSON.stringify(bridgeResult.body));
        return new Response(body, { status: bridgeResult.status || 200, headers: { "content-type": r.headers.get("content-type") || "text/html" } });
      }
      return r;
    }
    return r;
  } catch (e: any) {
    const bridgeResult = await bridgeFetch(url, { type: "fetch", headers: init?.headers as Record<string, string> | undefined });
    if (bridgeResult.error) throw new Error(bridgeResult.error);
    const body = bridgeResult.text || (typeof bridgeResult.body === "string" ? bridgeResult.body : JSON.stringify(bridgeResult.body));
    return new Response(body, { status: bridgeResult.status || 200, headers: { "content-type": "text/html" } });
  }
}

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const NL = String.fromCharCode(10);

async function callCheapLLM(prompt: string, maxTokens = 2500): Promise<{ok: boolean; text: string}> {
  const models = ["deepseek/deepseek-chat", "qwen/qwen-2.5-72b-instruct"];
  for (const modelId of models) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + OPENROUTER_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.3 }),
        signal: AbortSignal.timeout(90000),
      });
      const d = await r.json();
      const text = d.choices?.[0]?.message?.content?.trim();
      if (text) return { ok: true, text };
    } catch {}
  }
  return { ok: false, text: "[LLM unavailable for meeting prep]" };
}

const DEDUP_FILE = ".briefings/.meeting-prep-dedup.json";

async function getDedup(): Promise<Record<string, string>> {
  const fs = await import("fs");
  try {
    if (fs.existsSync(DEDUP_FILE)) {
      const data = JSON.parse(fs.readFileSync(DEDUP_FILE, "utf-8"));
      const today = new Date().toISOString().slice(0, 10);
      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(data)) {
        if (v === today) filtered[k] = v as string;
      }
      return filtered;
    }
  } catch {}
  return {};
}

async function setDedup(key: string): Promise<void> {
  const fs = await import("fs");
  const pathMod = await import("path");
  const dir = pathMod.dirname(DEDUP_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = await getDedup();
  existing[key] = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(DEDUP_FILE, JSON.stringify(existing));
}

async function execute() {
  const port = process.env.__BRIDGE_PORT || process.env.PORT || "5000";
  const BASE = "http://localhost:" + port;
  const hdrs: Record<string, string> = { "Content-Type": "application/json" };
  if (__apiKey) hdrs["Authorization"] = "Bearer " + __apiKey;

  const { saveBriefingAndNotify } = await import(__projectRoot + "/server/briefing-utils");

  let navPaths: any[] = [];
  try {
    const r = await fetch(BASE + "/api/navigation-paths", { headers: hdrs });
    if (r.ok) navPaths = await r.json();
  } catch {}

  const openInboxPath = navPaths.find((p: any) => p.name === "open-inbox");
  if (!openInboxPath) {
    return { summary: "Meeting Prep: No open-inbox navigation path found. No calendar access.", metric: "0" };
  }

  const CALENDAR_URL = "https://outlook.cloud.microsoft/calendar/view/day";
  const CALENDAR_SELECTORS = {
    events: '[data-app-section="CalendarSurface"] [role="listitem"], [aria-label*="event"], [data-testid*="calendar-event"], .ms-CalendarDay-event',
    eventTitle: '[role="heading"], [data-testid*="event-title"], .ms-CalendarDay-eventTitle',
    eventTime: '[data-testid*="event-time"], .ms-CalendarDay-eventTime, time',
    eventDetails: '[data-testid*="event-details"], .ms-CalendarDay-eventDetails',
  };

  let calendarText = "";
  let dataSource = "";

  try {
    const bridgeResult = await bridgeFetch(CALENDAR_URL, {
      type: "dom",
      selectors: CALENDAR_SELECTORS,
      timeout: 30000,
    });
    if (!bridgeResult.error) {
      const extracted = bridgeResult.extracted || bridgeResult.text || (typeof bridgeResult.body === "string" ? bridgeResult.body : JSON.stringify(bridgeResult.body || {}));
      if (extracted && String(extracted).length > 20) {
        calendarText = String(extracted);
        dataSource = "live-calendar";
      }
    }
  } catch {}

  if (!calendarText) {
    try {
      const inboxStep = (openInboxPath.steps || []).find((s: any) => s.action === "navigate");
      const inboxUrl = inboxStep?.target || "https://outlook.cloud.microsoft/mail/inbox";
      const inboxSelectors = openInboxPath.extractionRules || {};
      const bridgeResult = await bridgeFetch(inboxUrl, {
        type: "dom",
        selectors: inboxSelectors,
        timeout: 30000,
      });
      if (!bridgeResult.error) {
        const extracted = bridgeResult.extracted || bridgeResult.text || (typeof bridgeResult.body === "string" ? bridgeResult.body : "");
        if (extracted && String(extracted).length > 20) {
          calendarText = String(extracted);
          dataSource = "live-inbox";
        }
      }
    } catch {}
  }

  if (!calendarText) {
    return { summary: "Meeting Prep: Could not fetch calendar data from Outlook (bridge not connected or no session). Skipping.", metric: "0" };
  }

  const now = new Date();
  const nowMs = now.getTime();
  const windowStartMs = nowMs + 30 * 60 * 1000;
  const windowEndMs = nowMs + 45 * 60 * 1000;

  interface ParsedEvent { subject: string; startTime: Date; timeStr: string; key: string }
  const parsedEvents: ParsedEvent[] = [];

  const isoDateTimeRe = /(d{4}-d{2}-d{2}Td{2}:d{2})/g;
  let isoMatch;
  while ((isoMatch = isoDateTimeRe.exec(calendarText)) !== null) {
    const startTime = new Date(isoMatch[1]);
    if (isNaN(startTime.getTime())) continue;
    const startMs = startTime.getTime();
    if (startMs < windowStartMs || startMs > windowEndMs) continue;

    const contextStart = Math.max(0, isoMatch.index - 200);
    const contextEnd = Math.min(calendarText.length, isoMatch.index + 200);
    const context = calendarText.substring(contextStart, contextEnd);
    const subjectMatch = context.match(/(?:subject|title|event)[:\s]*([^\n]{3,100})/i);
    const subject = subjectMatch ? subjectMatch[1].trim() : context.replace(/[\n\r]+/g, " ").trim().slice(0, 100);
    if (subject.length < 3) continue;
    const key = subject.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 50) + "-" + startTime.toISOString().slice(0, 16).replace(/[^0-9]/g, "");
    const timeStr = startTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    parsedEvents.push({ subject, startTime, timeStr, key });
  }

  if (parsedEvents.length === 0) {
    const lines = calendarText.split(NL);
    for (const line of lines) {
      const timeMatch = line.match(/(d{1,2}:d{2}s*(?:AM|PM|am|pm))/);
      if (!timeMatch) continue;

      const timeStr = timeMatch[1].trim();
      const timeParts = timeStr.match(/(d{1,2}):(d{2})s*(AM|PM|am|pm)/i);
      if (!timeParts) continue;

      let hour = parseInt(timeParts[1], 10);
      const minute = parseInt(timeParts[2], 10);
      const ampm = timeParts[3].toUpperCase();
      if (ampm === "PM" && hour < 12) hour += 12;
      if (ampm === "AM" && hour === 12) hour = 0;

      const meetingTime = new Date(now);
      meetingTime.setHours(hour, minute, 0, 0);
      const meetingMs = meetingTime.getTime();

      if (meetingMs < windowStartMs || meetingMs > windowEndMs) continue;

      const subject = line.replace(timeMatch[0], "").replace(/^[-*\s]+/, "").trim().slice(0, 120);
      if (subject.length < 3) continue;
      const key = subject.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 50) + "-" + meetingTime.toISOString().slice(0, 16).replace(/[^0-9]/g, "");
      parsedEvents.push({ subject, startTime: meetingTime, timeStr, key });
    }
  }

  if (parsedEvents.length === 0) {
    return { summary: "Meeting Prep: No upcoming events found in 30-45 minute window (source: " + dataSource + ").", metric: "0" };
  }

  const dedup = await getDedup();
  const newEvents = parsedEvents.filter(e => !dedup[e.key]);

  if (newEvents.length === 0) {
    return { summary: "Meeting Prep: All upcoming meetings already prepped today.", metric: "0" };
  }

  let transcripts: any[] = [];
  try { const r = await fetch(BASE + "/api/transcripts?limit=20", { headers: hdrs }); if (r.ok) transcripts = await r.json(); } catch {}

  let results: any[] = [];
  try { const r = await fetch(BASE + "/api/results?limit=30", { headers: hdrs }); if (r.ok) results = await r.json(); } catch {}

  let memories: any[] = [];
  try { const r = await fetch(BASE + "/api/memories?limit=30", { headers: hdrs }); if (r.ok) memories = await r.json(); } catch {}

  let preppedCount = 0;
  const summaryParts: string[] = [];

  for (const event of newEvents.slice(0, 3)) {
    const keywords = event.subject.toLowerCase().split(/\s+/).filter(w => w.length > 3);

    const relatedTranscripts = transcripts.filter((t: any) => {
      const title = (t.title || "").toLowerCase();
      return keywords.some(kw => title.includes(kw));
    }).slice(0, 3);

    const relatedResults = results.filter((r: any) => {
      const text = ((r.summary || "") + " " + (r.rawOutput || "")).toLowerCase();
      return keywords.some(kw => text.includes(kw));
    }).slice(0, 5);

    const relatedMemories = memories.filter((m: any) => {
      const text = (m.content || "").toLowerCase();
      return keywords.some(kw => text.includes(kw));
    }).slice(0, 5);

    const transcriptContext = relatedTranscripts.map((t: any) => {
      const text = t.rawText || "";
      return "Transcript: " + (t.title || "untitled") + " (" + new Date(t.createdAt).toISOString().slice(0, 10) + ")" + NL + text.slice(0, 800);
    }).join(NL + NL);

    const snowTickets = results.filter((r: any) => {
      const prog = (r.programName || "").toLowerCase();
      const text = ((r.summary || "") + " " + (r.rawOutput || "")).toLowerCase();
      const isSnow = prog.includes("snow") || prog.includes("servicenow") || prog.includes("incident") || prog.includes("change") || prog.includes("list-my-");
      return isSnow && keywords.some(kw => text.includes(kw));
    }).slice(0, 5);

    const resultContext = relatedResults.map((r: any) => "- [" + (r.programName || "?") + "] " + (r.summary || "").slice(0, 200)).join(NL);
    const snowContext = snowTickets.map((r: any) => "- [SNOW/" + (r.programName || "?") + "] " + (r.summary || "").slice(0, 200)).join(NL);
    const memoryContext = relatedMemories.map((m: any) => "- " + (m.content || "").slice(0, 200)).join(NL);

    const prompt = "You are a meeting prep assistant. Generate a concise 1-page prep brief for the following meeting." + NL + NL +
      "MEETING: " + event.subject + " at " + event.timeStr + " (starts at " + event.startTime.toISOString() + ")" + NL + NL +
      (transcriptContext ? "PREVIOUS MEETING TRANSCRIPTS (same series):" + NL + transcriptContext + NL + NL : "") +
      (snowContext ? "RELATED SERVICENOW TICKETS:" + NL + snowContext + NL + NL : "") +
      (resultContext ? "RELATED AGENT RESULTS:" + NL + resultContext + NL + NL : "") +
      (memoryContext ? "RELATED MEMORIES:" + NL + memoryContext + NL + NL : "") +
      "Write in Markdown with EXACTLY these section headers:" + NL +
      "## Last Time" + NL + "Key decisions and action items from previous occurrences of this meeting. If no transcript history, note that." + NL + NL +
      "## Open Items" + NL + "Related tickets, pending work, or context from agent results. If no related items, state that." + NL + NL +
      "## Talking Points" + NL + "3-5 suggested discussion items based on available context. If limited context, suggest general preparation steps." + NL + NL +
      "Be concise. This is a quick-reference brief, not a detailed report.";

    const llmResult = await callCheapLLM(prompt);
    const briefingText = llmResult.ok ? llmResult.text : "## Meeting Prep: " + event.subject + NL + NL + "[LLM unavailable]" + NL + NL + "## Context" + NL + "Related results: " + relatedResults.length + ", transcripts: " + relatedTranscripts.length;

    const dateStamp = new Date().toISOString().slice(0, 10);
    const safeSubject = event.key.slice(0, 40);
    const htmlFilename = "meeting-prep-" + dateStamp + "-" + safeSubject + ".html";
    const { htmlUrl } = await saveBriefingAndNotify(briefingText, htmlFilename, "Meeting Prep: " + event.subject, "Meeting Prep: " + event.subject, dateStamp, "meeting-prep", "calendar,clipboard", BASE, hdrs);

    await setDedup(event.key);
    preppedCount++;
    summaryParts.push("Prepped: " + event.subject + " (" + event.timeStr + ") -> " + htmlUrl);
  }

  return { summary: "=== MEETING PREP ===" + NL + "Source: " + dataSource + NL + summaryParts.join(NL), metric: String(preppedCount) };
}

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
