
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

async function callLLM(prompt: string, maxTokens = 4000): Promise<{ok: boolean; text: string}> {
  const models = ["deepseek/deepseek-chat", "anthropic/claude-sonnet-4"];
  for (const modelId of models) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + OPENROUTER_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.3 }),
        signal: AbortSignal.timeout(120000),
      });
      const d = await r.json();
      const text = d.choices?.[0]?.message?.content?.trim();
      if (text) return { ok: true, text };
    } catch {}
  }
  return { ok: false, text: "[LLM unavailable for digest synthesis]" };
}

interface ResearchItem {
  source: string; sub?: string; title: string; score: number; url: string;
  selftext?: string; topComment?: string; lang?: string; tags?: string[];
}

function parseRadarData(rawOutput: string): { items: ResearchItem[]; sources: Record<string, ResearchItem[]> } {
  const items: ResearchItem[] = [];
  const sources: Record<string, ResearchItem[]> = {};
  const sdStart = rawOutput.indexOf("STRUCTURED_DATA_START");
  const sdEnd = rawOutput.indexOf("STRUCTURED_DATA_END");
  if (sdStart === -1 || sdEnd === -1) return { items, sources };
  try {
    const chunk = rawOutput.substring(sdStart, sdEnd);
    const jsonStart = chunk.indexOf(NL) + 1;
    let jsonStr = chunk.substring(jsonStart).trim();
    const lastBrace = jsonStr.lastIndexOf("}");
    if (lastBrace > 0) jsonStr = jsonStr.substring(0, lastBrace + 1);
    const parsed = JSON.parse(jsonStr);
    if (parsed.reddit?.bySub) {
      for (const [sub, posts] of Object.entries(parsed.reddit.bySub)) {
        const postArr = Array.isArray(posts) ? posts : [];
        for (const p of postArr) {
          const item: ResearchItem = { source: "reddit", sub, title: p.title || "", score: p.score || 0, url: p.url || "", selftext: p.selftext, topComment: p.topComment };
          items.push(item);
          if (!sources["reddit/" + sub]) sources["reddit/" + sub] = [];
          sources["reddit/" + sub].push(item);
        }
      }
    }
    if (parsed.hn) for (const h of parsed.hn) { const item: ResearchItem = { source: "hn", title: h.title || "", score: h.score || 0, url: h.url || "" }; items.push(item); (sources["hn"] = sources["hn"] || []).push(item); }
    if (parsed.github) for (const g of parsed.github) { const item: ResearchItem = { source: "github", title: g.title || "", score: 0, url: g.url || "", lang: g.lang }; items.push(item); (sources["github"] = sources["github"] || []).push(item); }
    if (parsed.lobsters) for (const l of parsed.lobsters) { const item: ResearchItem = { source: "lobsters", title: l.title || "", score: l.score || 0, url: l.url || "", tags: l.tags }; items.push(item); (sources["lobsters"] = sources["lobsters"] || []).push(item); }
    if (parsed.arxiv) for (const a of parsed.arxiv) { const item: ResearchItem = { source: "arxiv", title: a.title || "", score: 0, url: a.url || "" }; items.push(item); (sources["arxiv"] = sources["arxiv"] || []).push(item); }
  } catch {}
  return { items, sources };
}

function matchItemsToGoals(items: ResearchItem[], goals: Array<{name: string; keywords: string[]; priority: number}>): Record<string, ResearchItem[]> {
  const matched: Record<string, ResearchItem[]> = {};
  for (const goal of goals) matched[goal.name] = [];
  const unmatched: ResearchItem[] = [];
  for (const item of items) {
    const text = (item.title + " " + (item.selftext || "") + " " + (item.topComment || "") + " " + (item.tags || []).join(" ")).toLowerCase();
    let found = false;
    for (const goal of goals) {
      const hits = goal.keywords.filter(kw => text.includes(kw.toLowerCase()));
      if (hits.length > 0) { matched[goal.name].push(item); found = true; }
    }
    if (!found) unmatched.push(item);
  }
  matched["_unmatched"] = unmatched;
  return matched;
}

async function execute() {
  const port = process.env.__BRIDGE_PORT || process.env.PORT || "5000";
  const BASE = "http://localhost:" + port;
  const hdrs: Record<string, string> = { "Content-Type": "application/json" };
  if (__apiKey) hdrs["Authorization"] = "Bearer " + __apiKey;

  let results: any[] = [];
  let allMemories: any[] = [];
  let pendingProposals: any[] = [];
  let programs: any[] = [];
  let radarResults: any[] = [];
  let goalsData: Array<{name: string; keywords: string[]; priority: number}> = [];
  let olderDigests: any[] = [];

  try { const r = await fetch(BASE + "/api/results?limit=100", { headers: hdrs }); if (r.ok) results = await r.json(); } catch {}
  try { const r = await fetch(BASE + "/api/memories?limit=100", { headers: hdrs }); if (r.ok) allMemories = await r.json(); } catch {}
  try { const r = await fetch(BASE + "/api/proposals?status=pending", { headers: hdrs }); if (r.ok) pendingProposals = await r.json(); } catch {}
  try { const r = await fetch(BASE + "/api/programs", { headers: hdrs }); if (r.ok) programs = await r.json(); } catch {}
  try { const r = await fetch(BASE + "/api/results?program=research-radar&limit=1", { headers: hdrs }); if (r.ok) radarResults = await r.json(); } catch {}
  try { const r = await fetch(BASE + "/api/config/user_goals", { headers: hdrs }); if (r.ok) { const d = await r.json(); goalsData = JSON.parse(d.value || "[]"); } } catch {}
  try { const r = await fetch(BASE + "/api/results?program=overnight-digest&limit=3", { headers: hdrs }); if (r.ok) olderDigests = await r.json(); } catch {}

  const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const recentResults = results.filter((r: any) => new Date(r.createdAt || r.timestamp || 0).getTime() > twelveHoursAgo);
  const recentMemories = allMemories.filter((m: any) => new Date(m.createdAt || m.lastAccessed || 0).getTime() > twelveHoursAgo);
  const threeDayMemories = allMemories.filter((m: any) => {
    const t = new Date(m.createdAt || m.lastAccessed || 0).getTime();
    return t > threeDaysAgo && t <= twelveHoursAgo;
  });

  if (recentResults.length === 0 && recentMemories.length === 0) {
    return { summary: "Daily Brief: No activity in the last 12 hours. All systems idle.", metric: "0" };
  }

  let radarItems: ResearchItem[] = [];
  let radarSources: Record<string, ResearchItem[]> = {};
  if (radarResults.length > 0 && radarResults[0].rawOutput) {
    const parsed = parseRadarData(radarResults[0].rawOutput);
    radarItems = parsed.items;
    radarSources = parsed.sources;
  }

  const goalMatches = goalsData.length > 0 ? matchItemsToGoals(radarItems, goalsData) : {};

  const byProgram: Record<string, { runs: number; errors: number; lastMetric: string; summaries: string[] }> = {};
  for (const r of recentResults) {
    const name = r.programName || "unknown";
    if (!byProgram[name]) byProgram[name] = { runs: 0, errors: 0, lastMetric: "0", summaries: [] };
    byProgram[name].runs++;
    if (r.status === "error") byProgram[name].errors++;
    if (r.metric) byProgram[name].lastMetric = r.metric;
    if (r.summary) byProgram[name].summaries.push(r.summary.slice(0, 300));
  }

  const observationMemories = recentMemories.filter((m: any) => m.memoryType === "observation");

  const goalSection: string[] = [];
  if (goalsData.length > 0) {
    for (const goal of goalsData.sort((a, b) => a.priority - b.priority)) {
      const matched = goalMatches[goal.name] || [];
      goalSection.push("GOAL [P" + goal.priority + "]: " + goal.name);
      if (matched.length > 0) {
        goalSection.push("  Matched " + matched.length + " items from research feed:");
        for (const item of matched.slice(0, 8)) {
          goalSection.push("  - [" + item.source + (item.sub ? "/r/" + item.sub : "") + "] " + item.title.slice(0, 120));
          if (item.url) goalSection.push("    " + item.url);
          if (item.topComment) goalSection.push("    Top comment: " + item.topComment.slice(0, 150));
        }
      } else {
        goalSection.push("  No matching items in latest research scan.");
      }
      const goalObs = observationMemories.filter((m: any) => {
        const content = (m.content || "").toLowerCase();
        return goal.keywords.some(kw => content.includes(kw.toLowerCase()));
      });
      if (goalObs.length > 0) {
        goalSection.push("  Agent observations:");
        for (const m of goalObs.slice(0, 3)) {
          goalSection.push("  * " + (m.content || "").slice(0, 200));
        }
      }
      goalSection.push("");
    }
  }

  const prevContext: string[] = [];
  if (threeDayMemories.length > 0) {
    prevContext.push("PREVIOUS DAYS OBSERVATIONS (" + threeDayMemories.length + " memories from last 3 days):");
    for (const m of threeDayMemories.filter((m: any) => m.memoryType === "observation").slice(0, 15)) {
      prevContext.push("  [" + new Date(m.createdAt || m.lastAccessed).toISOString().slice(0, 10) + "] " + (m.content || "").slice(0, 200));
    }
  }
  if (olderDigests.length > 0) {
    prevContext.push("");
    prevContext.push("PREVIOUS DIGEST SUMMARIES:");
    for (const d of olderDigests.slice(0, 2)) {
      const date = new Date(d.createdAt || d.timestamp || 0).toISOString().slice(0, 10);
      prevContext.push("  [" + date + "] " + (d.summary || "").slice(0, 500));
    }
  }

  const systemHealth: string[] = [];
  systemHealth.push("SYSTEM STATUS:");
  const enabledCount = programs.filter((p: any) => p.enabled).length;
  systemHealth.push("  " + enabledCount + " programs enabled, " + Object.keys(byProgram).length + " ran in last 12h");
  const errorProgs = Object.entries(byProgram).filter(([, d]) => d.errors >= 2);
  if (errorProgs.length > 0) {
    systemHealth.push("  Errors: " + errorProgs.map(([n, d]) => n + " (" + d.errors + ")").join(", "));
  }
  if (pendingProposals.length > 0) {
    systemHealth.push("  Pending proposals: " + pendingProposals.length);
  }

  const unmatchedItems = goalMatches["_unmatched"] || [];
  const highScoreUnmatched = unmatchedItems.filter(i => i.score > 50 || i.source === "arxiv" || i.source === "github").slice(0, 15);

  const llmPrompt = "You are a personal intelligence briefing writer. The user has an autonomous agent system that monitors Reddit, HN, GitHub, Lobsters, ArXiv, and more. Your job is to write a GOAL-ORIENTED daily brief, NOT a system status report." + NL + NL +
    "USER GOALS (in priority order):" + NL + goalsData.map(g => "- [P" + g.priority + "] " + g.name + " (keywords: " + g.keywords.slice(0, 8).join(", ") + ")").join(NL) + NL + NL +
    "RESEARCH ITEMS MATCHED TO GOALS:" + NL + goalSection.join(NL) + NL + NL +
    "HIGH-VALUE UNMATCHED ITEMS (" + highScoreUnmatched.length + "):" + NL +
    highScoreUnmatched.map(i => "- [" + i.source + "] " + i.title.slice(0, 120) + (i.url ? NL + "  " + i.url : "")).join(NL) + NL + NL +
    (prevContext.length > 0 ? "CROSS-DAY CONTEXT:" + NL + prevContext.join(NL) + NL + NL : "") +
    systemHealth.join(NL) + NL + NL +
    "Write the brief in Markdown using these EXACT section headers:" + NL +
    "## Goal Progress" + NL + "For each goal, 2-3 bullets on what the overnight research revealed. Connect findings to goals. Skip goals with no relevant findings." + NL + NL +
    "## Deep Reads" + NL + "3-5 links genuinely worth reading. For each, include the URL and a paragraph explaining WHY it matters to the user's specific goals. Be selective, not exhaustive." + NL + NL +
    "## Developing Threads" + NL + "Topics that span multiple days. Connect today's findings to previous days' observations. If no cross-day connections exist, note emerging topics to watch." + NL + NL +
    "## Agent Activity" + NL + "2-3 sentences max. What agents learned overnight, what they propose. Compressed, not program-by-program." + NL + NL +
    "## Action Items" + NL + "3-5 concrete, goal-tied actions. 'Read this paper because...', 'Try this technique for...', 'This OpenClaw proposal needs...'. NOT operational housekeeping." + NL + NL +
    "## System Health" + NL + "Brief operational status. Errors, budget, model availability. Keep to 2-3 lines. Operational proposals go here, not in Action Items." + NL + NL +
    "CRITICAL: Include actual URLs from the data. Be specific, not vague. Write for a busy engineer who wants to know what matters TODAY.";

  const llmResult = await callLLM(llmPrompt, 4000);

  const digestProposals: Array<{section: string; diff: string; reason: string}> = [];
  for (const [name, data] of errorProgs) {
    digestProposals.push({ section: "PROGRAMS", diff: "Program " + name + " had " + data.errors + " errors in the last 12h.", reason: "High error rate: " + name });
  }

  const briefingText = llmResult.ok ? llmResult.text : "## Daily Brief" + NL + NL + "[LLM synthesis unavailable]" + NL + NL + "## Raw Data" + NL + goalSection.join(NL);

  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10);
  const htmlFilename = "digest-" + dateStamp + ".html";

  const { saveBriefingAndNotify } = await import(__projectRoot + "/server/briefing-utils");
  const { htmlUrl, notifyStatus } = await saveBriefingAndNotify(briefingText, htmlFilename, "OrgCloud Daily Brief - " + dateStamp, "Daily Intelligence Brief", dateStamp, "overnight-digest", "briefcase,radio", BASE, hdrs);

  const summaryLines: string[] = [];
  summaryLines.push("=== DAILY INTELLIGENCE BRIEF ===");
  summaryLines.push("Generated: " + now.toISOString() + " | " + recentResults.length + " results, " + radarItems.length + " research items");
  if (htmlUrl) summaryLines.push("HTML: " + htmlUrl);
  summaryLines.push("Notify: " + notifyStatus);
  summaryLines.push("");
  summaryLines.push(briefingText);

  return { summary: summaryLines.join(NL), metric: String(digestProposals.length), proposals: digestProposals };
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
