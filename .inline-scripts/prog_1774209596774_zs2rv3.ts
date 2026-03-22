
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

async function callLLM(prompt: string, maxTokens = 3000): Promise<{ok: boolean; text: string}> {
  const freeModels = ["google/gemma-3-12b-it:free", "qwen/qwen3-4b:free", "meta-llama/llama-3.2-3b-instruct:free"];
  const paidModels = ["deepseek/deepseek-chat", "qwen/qwen-2.5-72b-instruct", "anthropic/claude-sonnet-4"];
  const allModels = [...freeModels, ...paidModels];
  for (const modelId of allModels) {
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
  return { ok: false, text: "[LLM unavailable for digest synthesis]" };
}

function extractRadarReddit(rawOutput: string): string {
  const NL = String.fromCharCode(10);
  const sdStart = rawOutput.indexOf("STRUCTURED_DATA_START");
  const sdEnd = rawOutput.indexOf("STRUCTURED_DATA_END");
  if (sdStart === -1 || sdEnd === -1) return "";
  try {
    const chunk = rawOutput.substring(sdStart, sdEnd);
    const jsonStart = chunk.indexOf(NL) + 1;
    let jsonStr = chunk.substring(jsonStart).trim();
    const lastBrace = jsonStr.lastIndexOf("}");
    if (lastBrace > 0) jsonStr = jsonStr.substring(0, lastBrace + 1);
    const parsed = JSON.parse(jsonStr);
    if (!parsed.reddit || !parsed.reddit.bySub) return "";
    const subs = Object.keys(parsed.reddit.bySub);
    const lines: string[] = [];
    lines.push("REDDIT ACROSS " + subs.length + " SUBREDDITS (via research-radar, mode=" + (parsed.reddit.mode || "unknown") + "):");
    for (const sub of subs) {
      const posts = parsed.reddit.bySub[sub] || [];
      if (posts.length === 0) continue;
      lines.push("");
      lines.push("r/" + sub + " (" + posts.length + " posts):");
      for (const p of posts.slice(0, 5)) {
        let line = "  " + (p.title || "").slice(0, 120);
        if (p.score > 0) line += " (" + p.score + " pts)";
        if (p.url) line += NL + "    " + p.url;
        if (p.topComment) line += NL + "    Top comment: " + p.topComment.slice(0, 200);
        lines.push(line);
      }
    }
    if (parsed.hn && parsed.hn.length > 0) {
      lines.push("");
      lines.push("HACKER NEWS TOP (" + parsed.hn.length + " items):");
      for (const h of parsed.hn.slice(0, 8)) {
        lines.push("  " + (h.title || "").slice(0, 120) + " (" + (h.score || 0) + " pts)");
        if (h.url) lines.push("    " + h.url);
      }
    }
    if (parsed.github && parsed.github.length > 0) {
      lines.push("");
      lines.push("GITHUB TRENDING (" + parsed.github.length + " repos):");
      for (const g of parsed.github.slice(0, 6)) {
        lines.push("  [" + (g.lang || "?") + "] " + (g.title || ""));
        if (g.url) lines.push("    " + g.url);
      }
    }
    if (parsed.lobsters && parsed.lobsters.length > 0) {
      lines.push("");
      lines.push("LOBSTERS (" + parsed.lobsters.length + " items):");
      for (const l of parsed.lobsters.slice(0, 5)) {
        lines.push("  " + (l.title || "").slice(0, 120) + " (" + (l.score || 0) + " pts)");
        if (l.url) lines.push("    " + l.url);
      }
    }
    if (parsed.arxiv && parsed.arxiv.length > 0) {
      lines.push("");
      lines.push("ARXIV CS.AI (" + parsed.arxiv.length + " papers):");
      for (const a of parsed.arxiv.slice(0, 5)) {
        lines.push("  " + (a.title || "").slice(0, 120));
        if (a.url) lines.push("    " + a.url);
      }
    }
    return lines.join(NL);
  } catch { return ""; }
}

async function execute() {
  const port = process.env.__BRIDGE_PORT || process.env.PORT || "5000";
  const BASE = "http://localhost:" + port;
  const NL = String.fromCharCode(10);
  const hdrs: Record<string, string> = { "Content-Type": "application/json" };
  if (__apiKey) hdrs["Authorization"] = "Bearer " + __apiKey;

  let results: any[] = [];
  let memories: any[] = [];
  let pendingProposals: any[] = [];
  let programs: any[] = [];
  let radarResults: any[] = [];
  try { const r = await fetch(BASE + "/api/results?limit=100", { headers: hdrs }); if (r.ok) results = await r.json(); } catch {}
  try { const r = await fetch(BASE + "/api/memories?limit=50", { headers: hdrs }); if (r.ok) memories = await r.json(); } catch {}
  try { const r = await fetch(BASE + "/api/proposals?status=pending", { headers: hdrs }); if (r.ok) pendingProposals = await r.json(); } catch {}
  try { const r = await fetch(BASE + "/api/programs", { headers: hdrs }); if (r.ok) programs = await r.json(); } catch {}
  try { const r = await fetch(BASE + "/api/results?program=research-radar&limit=1", { headers: hdrs }); if (r.ok) radarResults = await r.json(); } catch {}

  const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
  const recentResults = results.filter((r: any) => new Date(r.createdAt || r.timestamp || 0).getTime() > twelveHoursAgo);
  const recentMemories = memories.filter((m: any) => new Date(m.createdAt || m.lastAccessed || 0).getTime() > twelveHoursAgo);

  if (recentResults.length === 0 && recentMemories.length === 0) {
    return { summary: "Overnight Digest: No activity in the last 12 hours. All systems idle.", metric: "0" };
  }

  let radarRedditSection = "";
  if (radarResults.length > 0 && radarResults[0].rawOutput) {
    radarRedditSection = extractRadarReddit(radarResults[0].rawOutput);
  }

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

  const dataLines: string[] = [];
  dataLines.push("PROGRAM ACTIVITY (last 12h):");
  for (const [name, data] of Object.entries(byProgram).sort((a, b) => b[1].runs - a[1].runs)) {
    const status = data.errors > 0 ? " [" + data.errors + " errors]" : "";
    dataLines.push("  " + name + ": " + data.runs + " runs, metric=" + data.lastMetric + status);
    const lastSummary = data.summaries[data.summaries.length - 1];
    if (lastSummary) dataLines.push("    > " + lastSummary.slice(0, 250));
  }
  if (observationMemories.length > 0) {
    dataLines.push("");
    dataLines.push("KEY FINDINGS (from evaluate loop):");
    for (const m of observationMemories.slice(0, 10)) {
      dataLines.push("  * " + (m.content || "").slice(0, 200));
    }
  }
  if (pendingProposals.length > 0) {
    dataLines.push("");
    dataLines.push("PENDING PROPOSALS (" + pendingProposals.length + "):");
    for (const p of pendingProposals.slice(0, 8)) {
      dataLines.push("  [" + p.section + "] " + (p.reason || "").slice(0, 120));
    }
  }
  const enabledCount = programs.filter((p: any) => p.enabled).length;
  const idleProgs = programs.filter((p: any) => p.enabled && !byProgram[p.name]);
  dataLines.push("");
  dataLines.push("SYSTEM: " + enabledCount + " programs enabled, " + idleProgs.length + " idle in last 12h");

  const llmPrompt = "You are a morning briefing synthesizer for an autonomous agent system. Analyze the overnight data below and produce a structured briefing." + NL + NL +
    "DATA:" + NL + dataLines.join(NL) + NL + NL +
    (radarRedditSection ? "RESEARCH FEED (most recent research-radar scan):" + NL + radarRedditSection + NL + NL : "") +
    "Produce these sections:" + NL +
    "1. EXECUTIVE SUMMARY: 2-3 sentence overview of overnight activity" + NL +
    "2. KEY FINDINGS: Most important results or trends across programs" + NL +
    "3. REDDIT & COMMUNITY PULSE: Summarize notable threads from MULTIPLE subreddits. Include the subreddit name, post title, and URL for at least 8-10 notable items across different subs. Highlight community sentiment and top comments where available." + NL +
    "4. LINKS ROUNDUP: List the top 15-20 most interesting links from ALL sources (Reddit, HN, GitHub, Lobsters, ArXiv) with source label, title, and URL. Spread across diverse sources." + NL +
    "5. CONCERNS: Any errors, persistent zero-result programs, or anomalies" + NL +
    "6. PROPOSALS: 1-3 specific, actionable proposals for schedule changes, config adjustments, or program improvements. Format each as: PROPOSAL: <description>" + NL +
    "Be concise and actionable. Include URLs. This briefing is for the system operator reviewing overnight results at 6 AM.";

  const llmResult = await callLLM(llmPrompt, 3000);

  const digestProposals: Array<{section: string; diff: string; reason: string}> = [];

  const errorProgs = Object.entries(byProgram).filter(([, d]) => d.errors >= 2);
  for (const [name, data] of errorProgs) {
    digestProposals.push({
      section: "PROGRAMS",
      diff: "Program " + name + " had " + data.errors + " errors in the last 12h. Investigate or reduce schedule frequency.",
      reason: "High error rate: " + name,
    });
  }
  const zeroMetricProgs = Object.entries(byProgram).filter(([, d]) => d.lastMetric === "0" && d.runs >= 2);
  for (const [name] of zeroMetricProgs) {
    digestProposals.push({
      section: "PROGRAMS",
      diff: "Program " + name + " returned 0 results across " + byProgram[name].runs + " runs. Adjust config or disable.",
      reason: "Persistent zero results: " + name,
    });
  }

  if (llmResult.ok) {
    const proposalRe = /PROPOSAL:\\s*(.+)/gi;
    let pm;
    while ((pm = proposalRe.exec(llmResult.text)) !== null) {
      digestProposals.push({
        section: "DIGEST",
        diff: pm[1].trim().slice(0, 500),
        reason: "LLM-synthesized overnight proposal",
      });
    }
  }

  const lines: string[] = [];
  lines.push("=== OVERNIGHT DIGEST ===");
  lines.push("Generated: " + new Date().toISOString());
  lines.push("Coverage: last 12 hours | " + recentResults.length + " results from " + Object.keys(byProgram).length + " programs");
  if (radarRedditSection) lines.push("Research feed: " + (radarRedditSection.split(NL).length) + " lines from latest radar scan");
  lines.push("");
  if (llmResult.ok) {
    lines.push(llmResult.text);
  } else {
    lines.push("[LLM synthesis unavailable - raw data follows]");
    lines.push("");
    for (const dl of dataLines) lines.push(dl);
    if (radarRedditSection) {
      lines.push("");
      lines.push(radarRedditSection);
    }
  }
  lines.push("");
  lines.push("Total proposals: " + digestProposals.length + " | Pending: " + pendingProposals.length);

  return { summary: lines.join(NL), metric: String(digestProposals.length), proposals: digestProposals };
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
