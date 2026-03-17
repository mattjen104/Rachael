
const __ctx = JSON.parse(process.env.__INLINE_CTX || '{}');
const __projectRoot = process.env.__PROJECT_ROOT || process.cwd();
const __skillPath = (name: string) => __projectRoot + "/skills/" + name;
const __bridgePort = process.env.__BRIDGE_PORT || "5000";
const __bridgeToken = process.env.__BRIDGE_TOKEN || "";
const __apiKey = process.env.__API_KEY || "";

const __BRIDGE_ONLY_DOMAINS = ["galaxy.epic.com", ".ucsd.edu", ".reddit.com", "reddit.com", ".live.com", "outlook.live.com", ".office.com", "teams.microsoft.com"];
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

const MAX_COMMENTS_PER_SUB = 3;

async function fetchRedditSub(sub: string): Promise<Array<{title: string; score: number; url: string; selftext: string; topComment: string; sub: string}>> {
  try {
    await sleep(1500);
    const url = "https://www.reddit.com/r/" + sub + "/hot.json?limit=10&raw_json=1";
    const br = await bridgeFetch(url, { headers: { "Accept": "application/json" } });
    if (br.error) return [];
    const raw = br.text || (typeof br.body === "string" ? br.body : JSON.stringify(br.body));
    let d: any;
    try { d = typeof br.body === "object" && br.body !== null ? br.body : JSON.parse(raw || "{}"); } catch { return []; }
    const posts = (d.data?.children || [])
      .filter((c: any) => c.data && !c.data.stickied && c.data.score >= 10)
      .slice(0, 6);
    const results: Array<{title: string; score: number; url: string; selftext: string; topComment: string; sub: string}> = [];
    let commentsFetched = 0;
    for (const p of posts) {
      const pd = p.data;
      let topComment = "";
      if (commentsFetched < MAX_COMMENTS_PER_SUB) {
        try {
          await sleep(1200);
          const commentUrl = "https://www.reddit.com/r/" + sub + "/comments/" + pd.id + ".json?limit=1&sort=top&raw_json=1";
          const cbr = await bridgeFetch(commentUrl, { headers: { "Accept": "application/json" } });
          if (!cbr.error) {
            const craw = cbr.text || (typeof cbr.body === "string" ? cbr.body : JSON.stringify(cbr.body));
            let cd: any;
            try { cd = typeof cbr.body === "object" && cbr.body !== null ? cbr.body : JSON.parse(craw || "[]"); } catch { cd = []; }
            const comments = cd[1]?.data?.children || [];
            const first = comments.find((c: any) => c.kind === "t1");
            if (first?.data?.body) {
              topComment = first.data.body.slice(0, 500);
              commentsFetched++;
            }
          }
        } catch {}
      }
      results.push({
        title: pd.title || "",
        score: pd.score || 0,
        url: pd.url || "",
        selftext: (pd.selftext || "").slice(0, 300),
        topComment,
        sub,
      });
    }
    return results;
  } catch { return []; }
}

async function fetchRedditRSS(sub: string): Promise<Array<{title: string; score: number; url: string; selftext: string; topComment: string; sub: string}>> {
  try {
    await sleep(500);
    const r = await retryFetch("https://www.reddit.com/r/" + sub + "/.rss?limit=10", {
      headers: { "Accept": "application/rss+xml, application/xml, text/xml" }
    }, 1);
    const xml = await r.text();
    const titleRe = /<entry>[\s\S]*?<title[^>]*>([^<]+)<\/title>/g;
    const linkRe = /<entry>[\s\S]*?<link[^>]*href="([^"]+)"/g;
    const titles: string[] = [];
    const links: string[] = [];
    let m;
    while ((m = titleRe.exec(xml)) !== null) titles.push(m[1]);
    while ((m = linkRe.exec(xml)) !== null) links.push(m[1]);
    return titles.slice(0, 6).map((t, i) => ({
      title: t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
      score: 0,
      url: links[i] || "",
      selftext: "",
      topComment: "",
      sub,
    }));
  } catch { return []; }
}

async function fetchAllReddit(): Promise<{text: string; status: string}> {
  const allPosts: Array<{title: string; score: number; url: string; selftext: string; topComment: string; sub: string}> = [];
  const failed: string[] = [];
  const bridgeFailed: string[] = [];
  for (const sub of SUBREDDITS) {
    const posts = await fetchRedditSub(sub);
    if (posts.length === 0) {
      bridgeFailed.push(sub);
      const rssPosts = await fetchRedditRSS(sub);
      if (rssPosts.length === 0) { failed.push(sub); }
      else { allPosts.push(...rssPosts); }
    } else {
      allPosts.push(...posts);
    }
  }
  allPosts.sort((a, b) => b.score - a.score);
  const lines: string[] = [];
  for (const p of allPosts.slice(0, 40)) {
    let entry = "r/" + p.sub + " | " + p.title + " (" + p.score + " pts)";
    if (p.selftext) entry += NL + "  Post: " + p.selftext.slice(0, 200);
    if (p.topComment) entry += NL + "  Top comment: " + p.topComment.slice(0, 300);
    lines.push(entry);
  }
  let status = "ok";
  if (failed.length > 0 && bridgeFailed.length > 0) {
    status = "partial (bridge:" + bridgeFailed.length + " rss-fallback:" + (bridgeFailed.length - failed.length) + " total-failed:" + failed.length + ")";
  } else if (bridgeFailed.length > 0) {
    status = "rss-fallback (" + bridgeFailed.length + " subs via RSS)";
  }
  return {
    text: "REDDIT AI/LLM (" + allPosts.length + " posts from " + (SUBREDDITS.length - failed.length) + "/" + SUBREDDITS.length + " subs):" + NL + lines.join(NL + NL),
    status,
  };
}

async function fetchHN(): Promise<string> {
  try {
    const topIds = await retryFetch("https://hacker-news.firebaseio.com/v0/topstories.json").then(r => r.json());
    const stories: string[] = [];
    for (const id of topIds.slice(0, 25)) {
      const s = await retryFetch("https://hacker-news.firebaseio.com/v0/item/" + id + ".json").then(r => r.json());
      if (s && s.score >= 50) stories.push(s.title + " (" + s.score + " pts)");
      if (stories.length >= 12) break;
    }
    return "HN Top:" + NL + stories.join(NL);
  } catch { return "HN: [fetch failed]"; }
}

async function fetchGitHub(): Promise<string> {
  const langs = ["typescript", "python", "rust"];
  const repos: string[] = [];
  for (const lang of langs) {
    try {
      const r = await retryFetch("https://github.com/trending/" + lang + "?since=daily", {
        headers: { "Accept": "text/html" }
      });
      const html = await r.text();
      const re = /class="Box-row"[\s\S]*?href="\/([^"]+)"/g;
      let m;
      while ((m = re.exec(html)) !== null && repos.length < 6) {
        repos.push("[" + lang + "] " + m[1].replace(/\/\s/g, "/"));
      }
    } catch {}
  }
  return "GitHub Trending:" + NL + repos.join(NL);
}

async function fetchLobsters(): Promise<string> {
  try {
    const r = await retryFetch("https://lobste.rs/hottest.json");
    const d = await r.json();
    return "Lobsters Hot:" + NL + d.slice(0, 10).filter((p: any) => p.score >= 5)
      .map((p: any) => p.title + " (" + p.score + " pts, " + (p.tags || []).join(",") + ")").join(NL);
  } catch { return "Lobsters: [fetch failed]"; }
}

async function fetchLemmy(community: string): Promise<string> {
  try {
    const r = await retryFetch("https://lemmy.world/api/v3/post/list?sort=Hot&limit=10&community_name=" + community);
    const d = await r.json();
    const posts = (d.posts || []).filter((p: any) => p.counts.score >= 3).slice(0, 5)
      .map((p: any) => p.post.name + " (" + p.counts.score + " pts)");
    return "Lemmy c/" + community + ":" + NL + (posts.length ? posts.join(NL) : "[no recent hot posts]");
  } catch { return "Lemmy c/" + community + ": [fetch failed]"; }
}

async function fetchArxiv(): Promise<string> {
  try {
    const r = await retryFetch("https://rss.arxiv.org/rss/cs.AI");
    const xml = await r.text();
    const titles: string[] = [];
    const re = /<item>[\s\S]*?<title>([^<]+)<\/title>/g;
    let m;
    while ((m = re.exec(xml)) !== null && titles.length < 10) {
      const t = m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      if (!t.includes("updates on arXiv")) titles.push(t.trim());
    }
    return "ArXiv CS.AI (recent):" + NL + titles.join(NL);
  } catch { return "ArXiv: [fetch failed]"; }
}

async function execute() {
  const [redditResult, hn, gh, lobsters, lemmyML, lemmyAI, arxiv] = await Promise.all([
    fetchAllReddit(),
    fetchHN(), fetchGitHub(), fetchLobsters(),
    fetchLemmy("machinelearning"), fetchLemmy("artificial_intelligence"),
    fetchArxiv(),
  ]);

  const allSources = [hn, gh, lobsters, lemmyML, lemmyAI, arxiv, redditResult.text].join(NL + NL);

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
  const redditCount = (redditResult.text.match(/r\//g) || []).length;
  const hnCount = (hn.match(/pts\)/g) || []).length;
  const arxivCount = (arxiv.split(NL).length - 1);
  const ghCount = (gh.split(NL).length - 1);
  const statusLine = "reddit:" + redditCount + "(" + redditResult.status + ") hn:" + hnCount + " arxiv:" + arxivCount + " gh:" + ghCount;
  const llmStatus = (filterResult.ok ? "filter:ok" : "filter:FAIL") + " " + (briefingResult.ok ? "synth:ok" : "synth:FAIL");
  const metricStr = statusLine + " | " + llmStatus;

  const proposals: Array<{section: string; diff: string; reason: string}> = [];
  const re = /\d+\.\s*([^:]+):\s*([\s\S]*?)(?=\d+\.|$)/g;
  let m;
  while ((m = re.exec(briefing)) !== null) {
    proposals.push({ section: m[1].trim(), diff: "", reason: m[2].trim().slice(0, 500) });
  }

  return { summary: briefing + NL + NL + "--- Sources: " + metricStr, metric: metricStr, proposals };
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
