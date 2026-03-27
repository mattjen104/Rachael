
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

const NL = String.fromCharCode(10);
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const FILTER_MODEL = "anthropic/claude-sonnet-4";
const SYNTH_MODEL = "anthropic/claude-sonnet-4";
const UA = "OrgCloud/2.0 (research-radar; +https://orgcloud.dev)";

const SUBREDDITS = [
  "LocalLLaMA", "MachineLearning", "artificial", "OpenAI",
  "ClaudeAI", "Anthropic", "LLMDevs", "singularity",
  "ollama", "LangChain", "StableDiffusion", "comfyui",
  "SelfHosted", "OpenClaw", "agi", "ArtificialInteligence"
];

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function parseRetryAfter(val: string | null): number {
  if (!val) return 5000;
  const n = parseInt(val, 10);
  if (!isNaN(n)) return Math.min(n, 30) * 1000;
  const d = Date.parse(val);
  if (!isNaN(d)) return Math.min(Math.max(d - Date.now(), 1000), 30000);
  return 5000;
}

async function retryFetch(url: string, opts: any = {}, retries = 2): Promise<Response> {
  opts.headers = Object.assign({ "User-Agent": UA }, opts.headers || {});
  opts.signal = opts.signal || AbortSignal.timeout(15000);
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 429) {
        await sleep(parseRetryAfter(r.headers.get("retry-after")));
        continue;
      }
      if (r.ok) return r;
      if (i < retries) { await sleep(2000 * (i + 1)); continue; }
      throw new Error("HTTP " + r.status);
    } catch (e: any) {
      if (i === retries) throw e;
      await sleep(2000 * (i + 1));
    }
  }
  throw new Error("retries exhausted");
}

async function callLLM(prompt: string, model: string, maxTokens = 3000): Promise<{ok: boolean; text: string}> {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + OPENROUTER_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.4 }),
      signal: AbortSignal.timeout(120000),
    });
    const d = await r.json();
    const text = d.choices?.[0]?.message?.content?.trim();
    if (text) return { ok: true, text };
    return { ok: false, text: "[model error: " + JSON.stringify(d.error || "no content").slice(0, 100) + "]" };
  } catch (e: any) { return { ok: false, text: "[model unavailable: " + (e.message || "").slice(0, 80) + "]" }; }
}

interface SourceItem {
  source: string;
  sub?: string;
  title: string;
  score: number;
  url: string;
  selftext?: string;
  topComment?: string;
  tags?: string[];
  description?: string;
  lang?: string;
}

let __bridgeAvailable: boolean | null = null;
async function checkBridge(): Promise<boolean> {
  if (__bridgeAvailable !== null) return __bridgeAvailable;
  try {
    const r = await fetch("http://localhost:" + __bridgePort + "/api/bridge/status", {
      headers: { "Authorization": "Bearer " + __apiKey },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) { __bridgeAvailable = false; return false; }
    const d = await r.json() as any;
    __bridgeAvailable = d.extension?.connected === true;
    return __bridgeAvailable;
  } catch { __bridgeAvailable = false; return false; }
}

const MAX_COMMENTS_PER_SUB = 3;

async function fetchRedditBridge(sub: string): Promise<SourceItem[]> {
  try {
    await sleep(1500);
    const url = "https://www.reddit.com/r/" + sub + "/hot.json?limit=15&raw_json=1";
    const br = await bridgeFetch(url, { timeout: 20000, headers: { "Accept": "application/json" } });
    if (br.error) return [];
    let d: any;
    try { d = typeof br.body === "object" && br.body !== null ? br.body : JSON.parse(br.text || "{}"); } catch { return []; }
    const posts = (d.data?.children || [])
      .filter((c: any) => c.data && !c.data.stickied)
      .slice(0, 10);
    const results: SourceItem[] = [];
    let commentsFetched = 0;
    for (const p of posts) {
      const pd = p.data;
      let topComment = "";
      if (commentsFetched < MAX_COMMENTS_PER_SUB && pd.num_comments > 0) {
        try {
          await sleep(1200);
          const cbr = await bridgeFetch("https://www.reddit.com/r/" + sub + "/comments/" + pd.id + ".json?limit=1&sort=top&raw_json=1", { timeout: 15000, headers: { "Accept": "application/json" } });
          if (!cbr.error) {
            let cd: any;
            try { cd = typeof cbr.body === "object" && cbr.body !== null ? cbr.body : JSON.parse(cbr.text || "[]"); } catch { cd = []; }
            const first = (cd[1]?.data?.children || []).find((c: any) => c.kind === "t1");
            if (first?.data?.body) { topComment = first.data.body.slice(0, 500); commentsFetched++; }
          }
        } catch {}
      }
      results.push({
        source: "reddit", sub,
        title: pd.title || "", score: pd.score || 0,
        url: "https://www.reddit.com" + (pd.permalink || ""),
        selftext: (pd.selftext || "").slice(0, 400),
        topComment,
      });
    }
    return results;
  } catch { return []; }
}

async function fetchRedditRSS(sub: string): Promise<SourceItem[]> {
  try {
    await sleep(500);
    const r = await retryFetch("https://www.reddit.com/r/" + sub + "/.rss?limit=15", {
      headers: { "Accept": "application/rss+xml, application/xml, text/xml" }
    }, 1);
    const xml = await r.text();
    const entryRe = /<entry>[\s\S]*?<\/entry>/g;
    const results: SourceItem[] = [];
    let entryMatch;
    while ((entryMatch = entryRe.exec(xml)) !== null && results.length < 10) {
      const entry = entryMatch[0];
      const titleM = entry.match(/<title[^>]*>([^<]+)<\/title>/);
      const linkM = entry.match(/<link[^>]*href="([^"]+)"/);
      const contentM = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/);
      const title = (titleM ? titleM[1] : "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
      if (!title || title.includes("updates on")) continue;
      let selftext = "";
      if (contentM) {
        selftext = contentM[1].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
      }
      results.push({ source: "reddit", sub, title, score: 0, url: linkM ? linkM[1] : "", selftext });
    }
    return results;
  } catch { return []; }
}

async function fetchAllReddit(): Promise<{items: SourceItem[]; bySub: Record<string, SourceItem[]>; status: string; mode: string}> {
  const useBridge = await checkBridge();
  const mode = useBridge ? "bridge" : "rss";
  const bySub: Record<string, SourceItem[]> = {};
  const failed: string[] = [];
  for (const sub of SUBREDDITS) {
    const posts = useBridge ? await fetchRedditBridge(sub) : await fetchRedditRSS(sub);
    if (posts.length === 0) failed.push(sub);
    else bySub[sub] = posts;
  }
  const allItems: SourceItem[] = [];
  for (const sub of SUBREDDITS) {
    if (bySub[sub]) allItems.push(...bySub[sub]);
  }
  if (useBridge) allItems.sort((a, b) => b.score - a.score);
  let status = mode + ":ok";
  if (failed.length > 0) status = mode + ":partial (" + failed.length + " failed: " + failed.join(",") + ")";
  return { items: allItems, bySub, status, mode };
}

async function fetchHN(): Promise<{items: SourceItem[]; text: string}> {
  try {
    const topIds = await retryFetch("https://hacker-news.firebaseio.com/v0/topstories.json").then(r => r.json());
    const items: SourceItem[] = [];
    for (const id of topIds.slice(0, 30)) {
      const s = await retryFetch("https://hacker-news.firebaseio.com/v0/item/" + id + ".json").then(r => r.json());
      if (s && s.score >= 30) {
        items.push({
          source: "hn", title: s.title || "", score: s.score || 0,
          url: s.url || ("https://news.ycombinator.com/item?id=" + s.id),
          description: "Comments: https://news.ycombinator.com/item?id=" + s.id,
        });
      }
      if (items.length >= 15) break;
    }
    const text = "HN Top:" + NL + items.map(i => i.title + " (" + i.score + " pts)").join(NL);
    return { items, text };
  } catch { return { items: [], text: "HN: [fetch failed]" }; }
}

async function fetchGitHub(): Promise<{items: SourceItem[]; text: string}> {
  const langs = ["typescript", "python", "rust"];
  const items: SourceItem[] = [];
  for (const lang of langs) {
    try {
      const r = await retryFetch("https://github.com/trending/" + lang + "?since=daily", {
        headers: { "Accept": "text/html" }
      });
      const html = await r.text();
      const re = /class="Box-row"[\s\S]*?href="\/([^"]+)"/g;
      let m;
      while ((m = re.exec(html)) !== null && items.filter(i => i.lang === lang).length < 5) {
        const repo = m[1].replace(/\/\s/g, "/");
        items.push({
          source: "github", title: repo, score: 0,
          url: "https://github.com/" + repo,
          lang,
        });
      }
    } catch {}
  }
  const text = "GitHub Trending:" + NL + items.map(i => "[" + i.lang + "] " + i.title).join(NL);
  return { items, text };
}

async function fetchLobsters(): Promise<{items: SourceItem[]; text: string}> {
  try {
    const r = await retryFetch("https://lobste.rs/hottest.json");
    const d = await r.json();
    const items: SourceItem[] = d.slice(0, 15).filter((p: any) => p.score >= 3)
      .map((p: any) => ({
        source: "lobsters" as const, title: p.title, score: p.score,
        url: p.url || p.comments_url || "",
        tags: p.tags || [],
        description: p.comments_url || "",
      }));
    const text = "Lobsters Hot:" + NL + items.map(i => i.title + " (" + i.score + " pts, " + (i.tags || []).join(",") + ")").join(NL);
    return { items, text };
  } catch { return { items: [], text: "Lobsters: [fetch failed]" }; }
}

async function fetchLemmy(community: string): Promise<{items: SourceItem[]; text: string}> {
  try {
    const r = await retryFetch("https://lemmy.world/api/v3/post/list?sort=Hot&limit=10&community_name=" + community);
    const d = await r.json();
    const items: SourceItem[] = (d.posts || []).filter((p: any) => p.counts.score >= 2).slice(0, 8)
      .map((p: any) => ({
        source: "lemmy" as const, sub: community,
        title: p.post.name, score: p.counts.score,
        url: p.post.url || p.post.ap_id || "",
      }));
    const text = "Lemmy c/" + community + ":" + NL + (items.length ? items.map(i => i.title + " (" + i.score + " pts)").join(NL) : "[no recent hot posts]");
    return { items, text };
  } catch { return { items: [], text: "Lemmy c/" + community + ": [fetch failed]" }; }
}

async function fetchArxiv(): Promise<{items: SourceItem[]; text: string}> {
  try {
    const r = await retryFetch("https://rss.arxiv.org/rss/cs.AI");
    const xml = await r.text();
    const items: SourceItem[] = [];
    const re = /<item>[\s\S]*?<title>([^<]+)<\/title>[\s\S]*?<link>([^<]+)<\/link>/g;
    let m;
    while ((m = re.exec(xml)) !== null && items.length < 12) {
      const t = m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      if (!t.includes("updates on arXiv")) {
        items.push({ source: "arxiv", title: t.trim(), score: 0, url: m[2].trim() });
      }
    }
    const text = "ArXiv CS.AI (recent):" + NL + items.map(i => i.title).join(NL);
    return { items, text };
  } catch { return { items: [], text: "ArXiv: [fetch failed]" }; }
}

async function execute() {
  const [redditResult, hnResult, ghResult, lobstersResult, lemmyMLResult, lemmyAIResult, arxivResult] = await Promise.all([
    fetchAllReddit(),
    fetchHN(), fetchGitHub(), fetchLobsters(),
    fetchLemmy("machinelearning"), fetchLemmy("artificial_intelligence"),
    fetchArxiv(),
  ]);

  const allTextSources = [
    hnResult.text, ghResult.text, lobstersResult.text,
    lemmyMLResult.text, lemmyAIResult.text, arxivResult.text,
  ].join(NL + NL);

  const redditText = redditResult.items.slice(0, 40).map(p => {
    let entry = "r/" + p.sub + " | " + p.title;
    if (p.score > 0) entry += " (" + p.score + " pts)";
    if (p.selftext) entry += NL + "  " + p.selftext.slice(0, 200);
    if (p.topComment) entry += NL + "  Top comment: " + p.topComment.slice(0, 300);
    return entry;
  }).join(NL + NL);
  const allSources = allTextSources + NL + NL + "REDDIT:" + NL + redditText;

  const filterResult = await callLLM(
    "You are a research relevance filter for an AI engineer who builds:" + NL +
    "- Autonomous agent systems (planning, tool use, memory)" + NL +
    "- Local LLM deployment (ollama, llama.cpp, quantization)" + NL +
    "- Browser automation and scraping" + NL +
    "- Voice/speech interfaces" + NL +
    "- Knowledge management and org-mode-style tools" + NL +
    "- OpenClaw (AI governance, proposals, voting)" + NL + NL +
    "From this raw feed, select ONLY the 15-20 most relevant items. For each, preserve the source, title, score, and top comment if available. Drop anything generic, off-topic, political hot takes, memes, or low-signal." + NL + NL +
    "RAW FEED:" + NL + allSources + NL + NL +
    "Output ONLY the filtered items, one per line, preserving original formatting. No commentary.",
    FILTER_MODEL, 3000
  );

  const synthInput = filterResult.ok ? filterResult.text : allSources.slice(0, 6000);

  const briefingResult = await callLLM(
    "You are a senior research analyst for an AI/LLM-focused developer. Synthesize these curated items into an actionable briefing:" + NL + NL +
    synthInput + NL + NL +
    "Produce these sections:" + NL +
    "1. WHAT'S NEW: Top 5 developments worth knowing (include why each matters)" + NL +
    "2. COMMUNITY PULSE: What the Reddit AI community is excited/worried about (cite specific subs and top comments)" + NL +
    "3. EXPERIMENTS: 3 concrete things to try this week with links or repo names" + NL +
    "4. LOCAL LLM WATCH: Any new models, quantizations, or deployment techniques" + NL +
    "5. LLM EXPLOITATION: Notable jailbreaks, prompt injection, security concerns" + NL +
    "6. SYSTEM PROPOSALS: 2 improvements for an automated agent/research system" + NL + NL +
    "Be concise, specific, and actionable. Include Reddit community sentiment where relevant.",
    SYNTH_MODEL, 4000
  );

  const briefing = briefingResult.text;

  function trimItems(arr: any[], n: number) { return arr.slice(0, n).map((i: any) => ({ title: (i.title || "").slice(0, 120), url: i.url || "", score: i.score || 0, sub: i.sub || "", source: i.source, tags: i.tags, topComment: i.topComment ? i.topComment.slice(0, 200) : undefined, lang: i.lang, description: i.description })); }
  const trimSub: Record<string, any[]> = {};
  for (const [sub, items] of Object.entries(redditResult.bySub)) { trimSub[sub] = trimItems(items as any[], 8); }
  const structuredData = {
    reddit: { bySub: trimSub, mode: redditResult.mode, status: redditResult.status },
    hn: trimItems(hnResult.items, 12),
    github: trimItems(ghResult.items, 10),
    lobsters: trimItems(lobstersResult.items, 10),
    lemmy: { machinelearning: trimItems(lemmyMLResult.items, 6), artificial_intelligence: trimItems(lemmyAIResult.items, 6) },
    arxiv: trimItems(arxivResult.items, 10),
    meta: {
      redditCount: redditResult.items.length,
      hnCount: hnResult.items.length,
      ghCount: ghResult.items.length,
      lobstersCount: lobstersResult.items.length,
      arxivCount: arxivResult.items.length,
      filterOk: filterResult.ok,
      synthOk: briefingResult.ok,
      timestamp: new Date().toISOString(),
    },
  };

  const redditCount = redditResult.items.length;
  const statusLine = "reddit:" + redditCount + "(" + redditResult.status + ") hn:" + hnResult.items.length + " arxiv:" + arxivResult.items.length + " gh:" + ghResult.items.length + " lobsters:" + lobstersResult.items.length;
  const llmStatus = (filterResult.ok ? "filter:ok" : "filter:FAIL") + " " + (briefingResult.ok ? "synth:ok" : "synth:FAIL");
  const metricStr = statusLine + " | " + llmStatus;

  const proposals: Array<{section: string; diff: string; reason: string}> = [];
  const re = /\d+\.\s*([^:]+):\s*([\s\S]*?)(?=\d+\.|$)/g;
  let m;
  while ((m = re.exec(briefing)) !== null) {
    proposals.push({ section: m[1].trim(), diff: "", reason: m[2].trim().slice(0, 500) });
  }

  return {
    summary: briefing + NL + NL + "--- Sources: " + metricStr + NL + "<!--STRUCTURED_DATA_START-->" + NL + JSON.stringify(structuredData) + NL + "<!--STRUCTURED_DATA_END-->",
    metric: metricStr,
    proposals,
  };
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
