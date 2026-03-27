
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

async function callPremiumLLM(prompt: string, maxTokens = 4500): Promise<{ok: boolean; text: string}> {
  const models = ["anthropic/claude-sonnet-4", "anthropic/claude-3.5-sonnet"];
  for (const modelId of models) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + OPENROUTER_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.4 }),
        signal: AbortSignal.timeout(120000),
      });
      const d = await r.json();
      const text = d.choices?.[0]?.message?.content?.trim();
      if (text) return { ok: true, text };
    } catch {}
  }
  return { ok: false, text: "[LLM unavailable for weekly strategy]" };
}

async function execute() {
  const port = process.env.__BRIDGE_PORT || process.env.PORT || "5000";
  const BASE = "http://localhost:" + port;
  const hdrs: Record<string, string> = { "Content-Type": "application/json" };
  if (__apiKey) hdrs["Authorization"] = "Bearer " + __apiKey;

  const { saveBriefingAndNotify } = await import(__projectRoot + "/server/briefing-utils");

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  let allResults: any[] = [];
  let allMemories: any[] = [];
  let proposals: any[] = [];
  let programs: any[] = [];
  let goalsData: Array<{name: string; keywords: string[]; priority: number}> = [];
  let digestResults: any[] = [];

  try { const r = await fetch(BASE + "/api/results?limit=200", { headers: hdrs }); if (r.ok) allResults = await r.json(); } catch {}
  try { const r = await fetch(BASE + "/api/memories?limit=200", { headers: hdrs }); if (r.ok) allMemories = await r.json(); } catch {}
  try { const r = await fetch(BASE + "/api/proposals?limit=50", { headers: hdrs }); if (r.ok) proposals = await r.json(); } catch {}
  try { const r = await fetch(BASE + "/api/programs", { headers: hdrs }); if (r.ok) programs = await r.json(); } catch {}
  try { const r = await fetch(BASE + "/api/config/user_goals", { headers: hdrs }); if (r.ok) { const d = await r.json(); goalsData = JSON.parse(d.value || "[]"); } } catch {}
  try { const r = await fetch(BASE + "/api/results?program=overnight-digest&limit=7", { headers: hdrs }); if (r.ok) digestResults = await r.json(); } catch {}

  const weekResults = allResults.filter((r: any) => new Date(r.createdAt || r.timestamp || 0).getTime() > sevenDaysAgo);
  const weekMemories = allMemories.filter((m: any) => new Date(m.createdAt || m.lastAccessed || 0).getTime() > sevenDaysAgo);
  const weekProposals = proposals.filter((p: any) => new Date(p.createdAt || 0).getTime() > sevenDaysAgo);

  const digestSummaries = digestResults.map((d: any) => {
    const date = new Date(d.createdAt || d.timestamp || 0).toISOString().slice(0, 10);
    return "[" + date + "] " + (d.summary || "").slice(0, 1500);
  }).join(NL + NL);

  const goalProgressSection: string[] = [];
  for (const goal of goalsData.sort((a, b) => a.priority - b.priority)) {
    const relatedResults = weekResults.filter((r: any) => {
      const text = ((r.summary || "") + " " + (r.rawOutput || "")).toLowerCase();
      return goal.keywords.some(kw => text.includes(kw.toLowerCase()));
    });
    const relatedMemories = weekMemories.filter((m: any) => {
      const text = (m.content || "").toLowerCase();
      return goal.keywords.some(kw => text.includes(kw.toLowerCase()));
    });
    goalProgressSection.push("GOAL [P" + goal.priority + "]: " + goal.name);
    goalProgressSection.push("  Results this week: " + relatedResults.length + ", Memories: " + relatedMemories.length);
    for (const r of relatedResults.slice(0, 5)) {
      goalProgressSection.push("  - [" + (r.programName || "?") + "] " + (r.summary || "").slice(0, 200));
    }
    goalProgressSection.push("");
  }

  const byProgram: Record<string, { runs: number; errors: number }> = {};
  for (const r of weekResults) {
    const name = r.programName || "unknown";
    if (!byProgram[name]) byProgram[name] = { runs: 0, errors: 0 };
    byProgram[name].runs++;
    if (r.status === "error") byProgram[name].errors++;
  }

  const agentPerf = Object.entries(byProgram)
    .sort(([, a], [, b]) => b.runs - a.runs)
    .map(([name, data]) => name + ": " + data.runs + " runs" + (data.errors > 0 ? ", " + data.errors + " errors" : ""))
    .join(NL);

  const observations = weekMemories.filter((m: any) => m.memoryType === "observation");
  const observationTexts = observations.slice(0, 30).map((m: any) => {
    const date = new Date(m.createdAt || m.lastAccessed || 0).toISOString().slice(0, 10);
    return "[" + date + "] " + (m.content || "").slice(0, 250);
  }).join(NL);

  const proposalSummary = weekProposals.map((p: any) => {
    return "- [" + (p.status || "?") + "] " + (p.reason || "").slice(0, 150);
  }).join(NL);

  const now = new Date();
  const weekNum = Math.ceil(((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 86400000 + new Date(now.getFullYear(), 0, 1).getDay() + 1) / 7);
  const weekLabel = now.getFullYear() + "-W" + String(weekNum).padStart(2, "0");

  const prompt = "You are a strategic advisor reviewing a week of autonomous agent activity. Write a thoughtful weekly strategy digest for a busy engineer." + NL + NL +
    "USER GOALS:" + NL + goalsData.map(g => "- [P" + g.priority + "] " + g.name).join(NL) + NL + NL +
    "DAILY DIGEST SUMMARIES THIS WEEK:" + NL + digestSummaries.slice(0, 6000) + NL + NL +
    "GOAL PROGRESS THIS WEEK:" + NL + goalProgressSection.join(NL).slice(0, 3000) + NL + NL +
    "AGENT OBSERVATIONS (" + observations.length + " total):" + NL + observationTexts.slice(0, 3000) + NL + NL +
    "PROPOSALS THIS WEEK (" + weekProposals.length + "):" + NL + proposalSummary.slice(0, 1500) + NL + NL +
    "AGENT PERFORMANCE:" + NL + agentPerf.slice(0, 1500) + NL + NL +
    "Write in Markdown with EXACTLY these section headers:" + NL +
    "## Week in Review" + NL + "For each goal, summarize what moved forward and what stalled this week. Be specific with what was discovered vs what remains unclear." + NL + NL +
    "## Pattern Detection" + NL + "Recurring themes across the week's research. 'X was mentioned by 3 separate sources this week.' Cross-reference observations and flag emerging trends." + NL + NL +
    "## Next Week Focus" + NL + "Suggested priority shifts based on what's developing. What should get more attention? What can be deprioritized? Be opinionated." + NL + NL +
    "## Agent Performance" + NL + "Which programs delivered value vs burned tokens. Compressed to 3-4 lines. Flag any that should be disabled or reconfigured." + NL + NL +
    "CRITICAL: This is strategic reflection, not a status report. Connect dots across the week. Identify what the data means, not just what happened.";

  const llmResult = await callPremiumLLM(prompt);
  const briefingText = llmResult.ok ? llmResult.text : "## Weekly Strategy" + NL + NL + "[LLM unavailable]" + NL + NL + "## Raw Stats" + NL + "Results this week: " + weekResults.length + ", Proposals: " + weekProposals.length;

  const dateStamp = now.toISOString().slice(0, 10);
  const htmlFilename = "weekly-" + weekLabel + ".html";
  const { htmlUrl, notifyStatus } = await saveBriefingAndNotify(briefingText, htmlFilename, "Weekly Strategy - " + weekLabel, "Weekly Strategy Digest", weekLabel, "weekly-strategy", "WEEKLY,brain", BASE, hdrs);

  return { summary: "=== WEEKLY STRATEGY DIGEST ===" + NL + "Week: " + weekLabel + NL + "HTML: " + htmlUrl + NL + "Notify: " + notifyStatus + NL + NL + briefingText, metric: String(weekResults.length) };
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
