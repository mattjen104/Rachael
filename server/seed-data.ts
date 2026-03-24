import { storage } from "./storage";
import { insertProgramSchema, insertSkillSchema, insertSiteProfileSchema, insertNavigationPathSchema } from "@shared/schema";

export async function seedDatabase(): Promise<void> {
  await seedSiteProfiles();

  const existingPrograms = await storage.getPrograms();
  const isFirstRun = existingPrograms.length === 0;

  if (isFirstRun) {
    console.log("[seed] Seeding database with programs, skills, config...");
  }

  const programSeedInputs = [
    {
      name: "hn-pulse",
      type: "monitor",
      schedule: "every 12h",
      cronExpression: "0 7,19 * * *",
      instructions: "Monitor Hacker News for top stories. Uses free Firebase HN API.",
      config: { SCORE_THRESHOLD: "100", MAX_STORIES: "10", TASK_TYPE: "research", METRIC: "stories_found", DIRECTION: "higher" },
      costTier: "cheap",
      tags: ["program"],
      code: `const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
const SCORE_THRESHOLD = parseInt(props.SCORE_THRESHOLD || "100", 10);
const MAX_STORIES = parseInt(props.MAX_STORIES || "10", 10);

async function execute() {
  const topIds = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json").then(r => r.json());
  const stories = [];
  for (const id of topIds.slice(0, 30)) {
    const story = await fetch("https://hacker-news.firebaseio.com/v0/item/" + id + ".json").then(r => r.json());
    if (story && story.score >= SCORE_THRESHOLD) {
      stories.push({ title: story.title, url: story.url || "", score: story.score, by: story.by });
    }
    if (stories.length >= MAX_STORIES) break;
  }
  const summary = stories.map((s, i) => (i + 1) + ". [" + s.score + "] " + s.title + " (" + s.by + ")\\n   " + s.url).join("\\n");
  return { summary: "HN Pulse: " + stories.length + " stories above " + SCORE_THRESHOLD + " points\\n" + summary, metric: String(stories.length) };
}`,
      codeLang: "typescript",
    },
    {
      name: "openrouter-model-scout",
      type: "monitor",
      schedule: "every 12h",
      cronExpression: "0 6,18 * * *",
      instructions: "Check model availability on OpenRouter. Tests core models (DeepSeek, Claude), queries live pricing from /api/v1/models, auto-updates roster pricing, and flags offline models.",
      config: { TASK_TYPE: "research", METRIC: "models_working", DIRECTION: "higher", LLM_REQUIRED: "false" },
      costTier: "cheap",
      tags: ["program", "budget"],
      code: `const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const ROSTER_MODELS = [
  "deepseek/deepseek-chat",
  "deepseek/deepseek-reasoner",
  "qwen/qwen-2.5-72b-instruct",
  "anthropic/claude-3.5-sonnet",
  "anthropic/claude-sonnet-4",
];
const INTERESTING_PROVIDERS = ["deepseek", "anthropic", "qwen"];
const MAX_CHEAP_COST = 5.0;

async function execute() {
  const results: Array<{ model: string; status: string; latency: number }> = [];
  const rosterUpdates: Array<{ id: string; inputCostPer1M?: number; outputCostPer1M?: number; tier?: string; strengths?: string[]; label?: string; _remove?: boolean }> = [];
  const proposals: Array<{section: string; diff: string; reason: string}> = [];
  let discoveredNew = 0;

  try {
    const modelsResp = await fetch("https://openrouter.ai/api/v1/models", {
      headers: OPENROUTER_KEY ? { "Authorization": "Bearer " + OPENROUTER_KEY } : {},
    });
    if (modelsResp.ok) {
      const modelsData = await modelsResp.json();
      const allModels = modelsData.data || [];
      const modelsMap = new Map();
      for (const m of allModels) modelsMap.set(m.id, m);

      for (const modelId of ROSTER_MODELS) {
        const info = modelsMap.get(modelId);
        if (info?.pricing) {
          const inputCost = parseFloat(info.pricing.prompt || "0") * 1_000_000;
          const outputCost = parseFloat(info.pricing.completion || "0") * 1_000_000;
          rosterUpdates.push({ id: modelId, inputCostPer1M: Math.round(inputCost * 100) / 100, outputCostPer1M: Math.round(outputCost * 100) / 100 });
        } else if (!info) {
          rosterUpdates.push({ id: modelId, _remove: true });
          proposals.push({ section: "PROGRAMS", diff: "Model " + modelId + " not found on OpenRouter. Removed from active roster.", reason: "Model offline/removed: " + modelId });
        }
      }

      const existingIds = new Set(ROSTER_MODELS);
      const candidateModels = allModels.filter((m: any) => {
        if (existingIds.has(m.id)) return false;
        const provider = (m.id || "").split("/")[0];
        if (!INTERESTING_PROVIDERS.includes(provider)) return false;
        const cost = parseFloat(m.pricing?.prompt || "99");
        return cost * 1_000_000 <= MAX_CHEAP_COST;
      });

      for (const m of candidateModels.slice(0, 5)) {
        discoveredNew++;
        const label = m.name || m.id.split("/").pop();
        const inputCost = parseFloat(m.pricing?.prompt || "0") * 1_000_000;
        const outputCost = parseFloat(m.pricing?.completion || "0") * 1_000_000;
        rosterUpdates.push({
          id: m.id,
          tier: "cheap",
          strengths: ["general"],
          label: label,
          inputCostPer1M: Math.round(inputCost * 100) / 100,
          outputCostPer1M: Math.round(outputCost * 100) / 100,
        });
        proposals.push({ section: "PROGRAMS", diff: "New cheap model ($" + inputCost.toFixed(2) + "/1M) discovered: " + m.id + " (" + label + "). Added to roster.", reason: "Model auto-discovery" });
      }

      for (const modelId of ROSTER_MODELS) {
        const info = modelsMap.get(modelId);
        if (info?.pricing) {
          const inputCost = parseFloat(info.pricing.prompt || "0") * 1_000_000;
          if (inputCost > 20) {
            proposals.push({ section: "PROGRAMS", diff: "Model " + modelId + " pricing increased to $" + inputCost.toFixed(2) + "/1M. Review budget impact.", reason: "Pricing alert: " + modelId });
          }
        }
      }
    }
  } catch {}

  for (const model of ROSTER_MODELS) {
    const t0 = Date.now();
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + OPENROUTER_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Say OK" }], max_tokens: 5 }),
      });
      const d = await r.json();
      const ms = Date.now() - t0;
      if (d.choices?.[0]?.message?.content) {
        results.push({ model, status: "OK", latency: ms });
      } else if (d.error) {
        results.push({ model, status: "ERR: " + (d.error.message || "").slice(0, 50), latency: ms });
      } else {
        results.push({ model, status: "NO_RESPONSE", latency: ms });
      }
    } catch (e: any) {
      results.push({ model, status: "FAIL: " + (e.message || "").slice(0, 50), latency: Date.now() - t0 });
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  if (rosterUpdates.length > 0) {
    try {
      const port = process.env.__BRIDGE_PORT || process.env.PORT || "5000";
      await fetch("http://localhost:" + port + "/api/config/model_roster_overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: JSON.stringify(rosterUpdates), category: "budget" }),
      });
    } catch {}
  }

  const working = results.filter(r => r.status === "OK");
  const notes = [];
  if (rosterUpdates.length > 0) notes.push("Pricing updated for " + rosterUpdates.length + " models");
  if (discoveredNew > 0) notes.push("Discovered " + discoveredNew + " new models");
  if (proposals.length > 0) notes.push(proposals.length + " proposals");
  const noteStr = notes.length > 0 ? " | " + notes.join(", ") : "";
  const summary = results.map(r => (r.status === "OK" ? "[+]" : "[-]") + " " + r.model.split("/").pop() + " " + r.status + " (" + r.latency + "ms)").join("\\n");
  return { summary: "Model Scout: " + working.length + "/" + results.length + " core models working" + noteStr + "\\n" + summary, metric: String(working.length), proposals };
}`,
      codeLang: "typescript",
    },
    {
      name: "research-radar",
      type: "meta",
      schedule: "daily",
      cronExpression: "30 23 * * *",
      instructions: "Self-improving research radar — dual-source Reddit (front page + niche subs), cross-run dedup, engagement-informed filtering, source quality scoring, and auto-proposal execution. Aggregates HN, GitHub trending, Lobsters, Lemmy, ArXiv CS.AI. Two-stage LLM pipeline with closed feedback loop.",
      config: {
        TASK_TYPE: "research", COST_TIER: "premium", METRIC: "proposals_made", DIRECTION: "higher", OUTPUT_TYPE: "proposal", TIMEOUT: "600",
        NICHE_SUBS: JSON.stringify(["LocalLLaMA", "MachineLearning", "artificial", "OpenAI", "ClaudeAI", "Anthropic", "LLMDevs", "singularity", "ollama", "LangChain", "StableDiffusion", "comfyui", "SelfHosted", "OpenClaw", "agi", "ArtificialInteligence"]),
        INTEREST_AREAS: JSON.stringify(["Autonomous agent systems (planning, tool use, memory)", "Local LLM deployment (ollama, llama.cpp, quantization)", "Browser automation and scraping", "Voice/speech interfaces", "Knowledge management and org-mode-style tools", "OpenClaw (AI governance, proposals, voting)"]),
        SCORE_THRESHOLD: "10",
        GITHUB_LANGS: JSON.stringify(["typescript", "python", "rust"]),
        SOURCE_SCORES: "{}",
        CONFIG_CHANGES: "[]",
        FRONT_PAGE_ENABLED: "true",
        ENABLED_SOURCES: JSON.stringify({ hn: true, github: true, lobsters: true, lemmy: true, arxiv: true, reddit: true }),
        LEMMY_COMMUNITIES: JSON.stringify(["machinelearning", "artificial_intelligence"]),
        ARXIV_CATEGORY: "cs.AI",
      },
      costTier: "premium",
      tags: ["program", "meta"],
      code: `const NL = String.fromCharCode(10);
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const FILTER_MODEL = "anthropic/claude-sonnet-4";
const SYNTH_MODEL = "anthropic/claude-sonnet-4";
const UA = "OrgCloud/2.0 (research-radar; +https://orgcloud.dev)";
const SERVER_BASE = "http://localhost:" + (__bridgePort || "5000");

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
      if (r.status === 429) { await sleep(parseRetryAfter(r.headers.get("retry-after"))); continue; }
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

function contentHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return "h" + (h >>> 0).toString(36);
}

interface SourceItem {
  source: string; sub?: string; title: string; score: number; url: string;
  selftext?: string; topComment?: string; tags?: string[]; description?: string; lang?: string;
  channel?: string;
}

let __bridgeAvailable: boolean | null = null;
async function checkBridge(): Promise<boolean> {
  if (__bridgeAvailable !== null) return __bridgeAvailable;
  try {
    const r = await fetch(SERVER_BASE + "/api/bridge/status", {
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
    const posts = (d.data?.children || []).filter((c: any) => c.data && !c.data.stickied).slice(0, 10);
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
      results.push({ source: "reddit", sub, channel: "niche", title: pd.title || "", score: pd.score || 0, url: "https://www.reddit.com" + (pd.permalink || ""), selftext: (pd.selftext || "").slice(0, 400), topComment });
    }
    return results;
  } catch { return []; }
}

async function fetchRedditRSS(sub: string): Promise<SourceItem[]> {
  try {
    await sleep(500);
    const r = await retryFetch("https://www.reddit.com/r/" + sub + "/.rss?limit=15", { headers: { "Accept": "application/rss+xml, application/xml, text/xml" } }, 1);
    const xml = await r.text();
    const entryRe = /<entry>[\\s\\S]*?<\\/entry>/g;
    const results: SourceItem[] = [];
    let entryMatch;
    while ((entryMatch = entryRe.exec(xml)) !== null && results.length < 10) {
      const entry = entryMatch[0];
      const titleM = entry.match(/<title[^>]*>([^<]+)<\\/title>/);
      const linkM = entry.match(/<link[^>]*href="([^"]+)"/);
      const contentM = entry.match(/<content[^>]*>([\\s\\S]*?)<\\/content>/);
      const title = (titleM ? titleM[1] : "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
      if (!title || title.includes("updates on")) continue;
      let selftext = "";
      if (contentM) { selftext = contentM[1].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\\s+/g, " ").trim().slice(0, 400); }
      results.push({ source: "reddit", sub, channel: "niche", title, score: 0, url: linkM ? linkM[1] : "", selftext });
    }
    return results;
  } catch { return []; }
}

async function fetchFrontPage(): Promise<SourceItem[]> {
  const useBridge = await checkBridge();
  if (!useBridge) return [];
  try {
    await sleep(1000);
    const br = await bridgeFetch("https://www.reddit.com/best.json?limit=25&raw_json=1", { timeout: 25000, headers: { "Accept": "application/json" } });
    if (br.error) return [];
    let d: any;
    try { d = typeof br.body === "object" && br.body !== null ? br.body : JSON.parse(br.text || "{}"); } catch { return []; }
    const posts = (d.data?.children || []).filter((c: any) => c.data && !c.data.stickied).slice(0, 20);
    return posts.map((p: any) => {
      const pd = p.data;
      return { source: "reddit", sub: pd.subreddit || "frontpage", channel: "frontpage" as const, title: pd.title || "", score: pd.score || 0, url: "https://www.reddit.com" + (pd.permalink || ""), selftext: (pd.selftext || "").slice(0, 400) };
    });
  } catch { return []; }
}

async function fetchAllReddit(nicheSubs: string[], frontPageEnabled: boolean): Promise<{items: SourceItem[]; bySub: Record<string, SourceItem[]>; status: string; mode: string; frontPageCount: number; nicheCount: number}> {
  const useBridge = await checkBridge();
  const mode = useBridge ? "bridge" : "rss";
  const bySub: Record<string, SourceItem[]> = {};
  const failed: string[] = [];
  let frontPageItems: SourceItem[] = [];

  if (frontPageEnabled && useBridge) {
    frontPageItems = await fetchFrontPage();
  }

  for (const sub of nicheSubs) {
    const posts = useBridge ? await fetchRedditBridge(sub) : await fetchRedditRSS(sub);
    if (posts.length === 0) failed.push(sub);
    else bySub[sub] = posts;
  }

  const seen = new Set<string>();
  const allItems: SourceItem[] = [];
  for (const item of frontPageItems) {
    const key = item.url || item.title;
    if (!seen.has(key)) { seen.add(key); allItems.push(item); }
  }
  for (const sub of nicheSubs) {
    if (bySub[sub]) {
      for (const item of bySub[sub]) {
        const key = item.url || item.title;
        if (!seen.has(key)) { seen.add(key); allItems.push(item); }
      }
    }
  }
  if (useBridge) allItems.sort((a, b) => b.score - a.score);

  let status = mode + ":ok";
  if (failed.length > 0) status = mode + ":partial (" + failed.length + " failed: " + failed.join(",") + ")";
  return { items: allItems, bySub, status, mode, frontPageCount: frontPageItems.length, nicheCount: allItems.length - frontPageItems.length };
}

async function fetchHN(): Promise<{items: SourceItem[]; text: string}> {
  try {
    const topIds = await retryFetch("https://hacker-news.firebaseio.com/v0/topstories.json").then(r => r.json());
    const items: SourceItem[] = [];
    for (const id of topIds.slice(0, 30)) {
      const s = await retryFetch("https://hacker-news.firebaseio.com/v0/item/" + id + ".json").then(r => r.json());
      if (s && s.score >= 30) { items.push({ source: "hn", title: s.title || "", score: s.score || 0, url: s.url || ("https://news.ycombinator.com/item?id=" + s.id), description: "Comments: https://news.ycombinator.com/item?id=" + s.id }); }
      if (items.length >= 15) break;
    }
    return { items, text: "HN Top:" + NL + items.map(i => i.title + " (" + i.score + " pts)").join(NL) };
  } catch { return { items: [], text: "HN: [fetch failed]" }; }
}

async function fetchGitHub(langs: string[]): Promise<{items: SourceItem[]; text: string}> {
  const items: SourceItem[] = [];
  for (const lang of langs) {
    try {
      const r = await retryFetch("https://github.com/trending/" + lang + "?since=daily", { headers: { "Accept": "text/html" } });
      const html = await r.text();
      const re = /class="Box-row"[\\s\\S]*?href="\\/([^"]+)"/g;
      let m;
      while ((m = re.exec(html)) !== null && items.filter(i => i.lang === lang).length < 5) {
        const repo = m[1].replace(/\\/\\s/g, "/");
        items.push({ source: "github", title: repo, score: 0, url: "https://github.com/" + repo, lang });
      }
    } catch {}
  }
  return { items, text: "GitHub Trending:" + NL + items.map(i => "[" + i.lang + "] " + i.title).join(NL) };
}

async function fetchLobsters(): Promise<{items: SourceItem[]; text: string}> {
  try {
    const r = await retryFetch("https://lobste.rs/hottest.json");
    const d = await r.json();
    const items: SourceItem[] = d.slice(0, 15).filter((p: any) => p.score >= 3).map((p: any) => ({ source: "lobsters" as const, title: p.title, score: p.score, url: p.url || p.comments_url || "", tags: p.tags || [], description: p.comments_url || "" }));
    return { items, text: "Lobsters Hot:" + NL + items.map(i => i.title + " (" + i.score + " pts, " + (i.tags || []).join(",") + ")").join(NL) };
  } catch { return { items: [], text: "Lobsters: [fetch failed]" }; }
}

async function fetchLemmy(community: string): Promise<{items: SourceItem[]; text: string}> {
  try {
    const r = await retryFetch("https://lemmy.world/api/v3/post/list?sort=Hot&limit=10&community_name=" + community);
    const d = await r.json();
    const items: SourceItem[] = (d.posts || []).filter((p: any) => p.counts.score >= 2).slice(0, 8).map((p: any) => ({ source: "lemmy" as const, sub: community, title: p.post.name, score: p.counts.score, url: p.post.url || p.post.ap_id || "" }));
    return { items, text: "Lemmy c/" + community + ":" + NL + (items.length ? items.map(i => i.title + " (" + i.score + " pts)").join(NL) : "[no recent hot posts]") };
  } catch { return { items: [], text: "Lemmy c/" + community + ": [fetch failed]" }; }
}

async function fetchArxiv(category?: string): Promise<{items: SourceItem[]; text: string}> {
  const cat = category || "cs.AI";
  try {
    const r = await retryFetch("https://rss.arxiv.org/rss/" + cat);
    const xml = await r.text();
    const items: SourceItem[] = [];
    const re = /<item>[\\s\\S]*?<title>([^<]+)<\\/title>[\\s\\S]*?<link>([^<]+)<\\/link>/g;
    let m;
    while ((m = re.exec(xml)) !== null && items.length < 12) {
      const t = m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      if (!t.includes("updates on arXiv")) items.push({ source: "arxiv", title: t.trim(), score: 0, url: m[2].trim() });
    }
    return { items, text: "ArXiv " + cat + " (recent):" + NL + items.map(i => i.title).join(NL) };
  } catch { return { items: [], text: "ArXiv: [fetch failed]" }; }
}

async function getSeenHashes(): Promise<Set<string>> {
  try {
    const hdrs: Record<string, string> = {};
    if (__apiKey) hdrs["Authorization"] = "Bearer " + __apiKey;
    const r = await fetch(SERVER_BASE + "/api/radar/seen?days=7", { headers: hdrs, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return new Set();
    const d = await r.json();
    return new Set(d.hashes || []);
  } catch { return new Set(); }
}

async function storeSeenItems(items: Array<{contentHash: string; source: string; url?: string; title?: string}>): Promise<void> {
  try {
    const hdrs: Record<string, string> = { "Content-Type": "application/json" };
    if (__apiKey) hdrs["Authorization"] = "Bearer " + __apiKey;
    await fetch(SERVER_BASE + "/api/radar/seen", {
      method: "POST", headers: hdrs,
      body: JSON.stringify({ items }), signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

async function getEngagementSummary(): Promise<{topics: string[]; sources: string[]; count: number}> {
  try {
    const hdrs: Record<string, string> = {};
    if (__apiKey) hdrs["Authorization"] = "Bearer " + __apiKey;
    const r = await fetch(SERVER_BASE + "/api/radar/engagement?days=7", { headers: hdrs, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { topics: [], sources: [], count: 0 };
    const entries = await r.json();
    const topicCounts: Record<string, number> = {};
    const sourceCounts: Record<string, number> = {};
    for (const e of entries) {
      const words = (e.title || "").toLowerCase().split(/\\s+/).filter((w: string) => w.length > 4);
      for (const w of words) topicCounts[w] = (topicCounts[w] || 0) + 1;
      if (e.source) sourceCounts[e.source] = (sourceCounts[e.source] || 0) + 1;
    }
    const topics = Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(e => e[0]);
    const sources = Object.entries(sourceCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
    return { topics, sources, count: entries.length };
  } catch { return { topics: [], sources: [], count: 0 }; }
}

async function updateProgramConfig(programName: string, updates: Record<string, string>): Promise<void> {
  try {
    const authHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (__apiKey) authHeaders["Authorization"] = "Bearer " + __apiKey;
    const r = await fetch(SERVER_BASE + "/api/programs", { headers: authHeaders, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return;
    const progs = await r.json();
    const prog = progs.find((p: any) => p.name === programName);
    if (!prog) return;
    const newConfig = { ...(prog.config || {}), ...updates };
    await fetch(SERVER_BASE + "/api/programs/" + prog.id + "/config", {
      method: "PATCH", headers: authHeaders,
      body: JSON.stringify({ config: newConfig }), signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

async function execute(__ctx: any) {
  const props = __ctx?.properties || {};
  const nicheSubs: string[] = JSON.parse(props.NICHE_SUBS || '["LocalLLaMA","MachineLearning","artificial","OpenAI","ClaudeAI","Anthropic","LLMDevs","singularity","ollama","LangChain","StableDiffusion","comfyui","SelfHosted","OpenClaw","agi","ArtificialInteligence"]');
  const interestAreas: string[] = JSON.parse(props.INTEREST_AREAS || '["Autonomous agent systems","Local LLM deployment","Browser automation","Voice/speech interfaces","Knowledge management","OpenClaw (AI governance)"]');
  const scoreThreshold = parseInt(props.SCORE_THRESHOLD || "10", 10);
  const githubLangs: string[] = JSON.parse(props.GITHUB_LANGS || '["typescript","python","rust"]');
  const frontPageEnabled = props.FRONT_PAGE_ENABLED !== "false";
  const prevSourceScores: Record<string, number> = JSON.parse(props.SOURCE_SCORES || "{}");
  const configChanges: any[] = JSON.parse(props.CONFIG_CHANGES || "[]");
  const enabledSources: Record<string, boolean> = JSON.parse(props.ENABLED_SOURCES || '{"hn":true,"github":true,"lobsters":true,"lemmy":true,"arxiv":true,"reddit":true}');
  const lemmyCommunities: string[] = JSON.parse(props.LEMMY_COMMUNITIES || '["machinelearning","artificial_intelligence"]');
  const arxivCategory: string = props.ARXIV_CATEGORY || "cs.AI";

  const seenHashes = await getSeenHashes();
  const engagement = await getEngagementSummary();

  const fetches: Promise<any>[] = [];
  fetches.push(enabledSources.reddit !== false ? fetchAllReddit(nicheSubs, frontPageEnabled) : Promise.resolve({ items: [], text: "", status: "disabled", frontPageCount: 0, nicheCount: 0 }));
  fetches.push(enabledSources.hn !== false ? fetchHN() : Promise.resolve({ items: [], text: "" }));
  fetches.push(enabledSources.github !== false ? fetchGitHub(githubLangs) : Promise.resolve({ items: [], text: "" }));
  fetches.push(enabledSources.lobsters !== false ? fetchLobsters() : Promise.resolve({ items: [], text: "" }));
  for (const community of lemmyCommunities) {
    fetches.push(enabledSources.lemmy !== false ? fetchLemmy(community) : Promise.resolve({ items: [], text: "" }));
  }
  fetches.push(enabledSources.arxiv !== false ? fetchArxiv(arxivCategory) : Promise.resolve({ items: [], text: "" }));

  const results = await Promise.all(fetches);
  const redditResult = results[0];
  const hnResult = results[1];
  const ghResult = results[2];
  const lobstersResult = results[3];
  const lemmyResults = results.slice(4, 4 + lemmyCommunities.length);
  const arxivResult = results[4 + lemmyCommunities.length];

  const allRawItems: SourceItem[] = [
    ...redditResult.items, ...hnResult.items, ...ghResult.items,
    ...lobstersResult.items, ...lemmyResults.flatMap((r: any) => r.items), ...arxivResult.items,
  ];

  let dedupCount = 0;
  const newSeenItems: Array<{contentHash: string; source: string; url?: string; title?: string}> = [];
  const dedupedItems: SourceItem[] = [];
  for (const item of allRawItems) {
    const hash = contentHash(item.title + "|" + (item.url || ""));
    if (seenHashes.has(hash)) { dedupCount++; continue; }
    seenHashes.add(hash);
    newSeenItems.push({ contentHash: hash, source: item.source, url: item.url, title: item.title?.slice(0, 200) });
    dedupedItems.push(item);
  }

  await storeSeenItems(newSeenItems);

  const sourceCounts: Record<string, {scraped: number; survived: number}> = {};
  for (const item of allRawItems) {
    const key = item.source + (item.sub ? "/" + item.sub : "");
    if (!sourceCounts[key]) sourceCounts[key] = { scraped: 0, survived: 0 };
    sourceCounts[key].scraped++;
  }

  const dedupedHN = dedupedItems.filter(i => i.source === "hn");
  const dedupedGH = dedupedItems.filter(i => i.source === "github");
  const dedupedLobsters = dedupedItems.filter(i => i.source === "lobsters");
  const dedupedLemmy = dedupedItems.filter(i => i.source === "lemmy");
  const dedupedArxiv = dedupedItems.filter(i => i.source === "arxiv");

  const hnText = dedupedHN.length ? "HN Top:" + NL + dedupedHN.map(i => i.title + " (" + i.score + " pts)").join(NL) : "";
  const ghText = dedupedGH.length ? "GitHub Trending:" + NL + dedupedGH.map(i => "[" + (i.lang || "") + "] " + i.title).join(NL) : "";
  const lobstersText = dedupedLobsters.length ? "Lobsters Hot:" + NL + dedupedLobsters.map(i => i.title + " (" + i.score + " pts, " + (i.tags || []).join(",") + ")").join(NL) : "";
  const lemmyText = dedupedLemmy.length ? "Lemmy:" + NL + dedupedLemmy.map(i => "[c/" + (i.sub || "") + "] " + i.title + " (" + i.score + " pts)").join(NL) : "";
  const arxivText = dedupedArxiv.length ? "ArXiv " + arxivCategory + " (recent):" + NL + dedupedArxiv.map(i => i.title).join(NL) : "";

  const allTextSources = [hnText, ghText, lobstersText, lemmyText, arxivText].filter((t: string) => t).join(NL + NL);
  const redditText = dedupedItems.filter(i => i.source === "reddit" && (i.channel === "frontpage" || (i.score || 0) >= scoreThreshold)).slice(0, 40).map(p => {
    let entry = "[" + (p.channel || "niche") + "] r/" + p.sub + " | " + p.title;
    if (p.score > 0) entry += " (" + p.score + " pts)";
    if (p.selftext) entry += NL + "  " + p.selftext.slice(0, 200);
    if (p.topComment) entry += NL + "  Top comment: " + p.topComment.slice(0, 300);
    return entry;
  }).join(NL + NL);
  const allSources = allTextSources + NL + NL + "REDDIT:" + NL + redditText;

  let engagementPrompt = "";
  if (engagement.count > 0) {
    engagementPrompt = NL + "RECENT ENGAGEMENT CONTEXT (user clicked/read these topics recently, weight them higher):" + NL;
    if (engagement.topics.length > 0) engagementPrompt += "Recently engaged topics: " + engagement.topics.join(", ") + NL;
    if (engagement.sources.length > 0) engagementPrompt += "High-signal sources: " + engagement.sources.join(", ") + NL;
    engagementPrompt += "Total engagements last 7 days: " + engagement.count + NL;
  }

  const filterResult = await callLLM(
    "You are a research relevance filter for an AI engineer who builds:" + NL +
    interestAreas.map(a => "- " + a).join(NL) + NL +
    engagementPrompt + NL +
    "From this raw feed, select ONLY the 15-20 most relevant items. For each, preserve the source, title, score, and top comment if available. Drop anything generic, off-topic, political hot takes, memes, or low-signal." + NL + NL +
    "RAW FEED:" + NL + allSources + NL + NL +
    "Output ONLY the filtered items, one per line, preserving original formatting. No commentary.",
    FILTER_MODEL, 3000
  );

  const filteredText = filterResult.ok ? filterResult.text : "";
  for (const item of dedupedItems) {
    const key = item.source + (item.sub ? "/" + item.sub : "");
    if (sourceCounts[key] && filteredText.includes(item.title.slice(0, 40))) {
      sourceCounts[key].survived++;
    }
  }

  const engagedSourceCounts: Record<string, number> = {};
  for (const s of engagement.sources) { engagedSourceCounts[s] = (engagedSourceCounts[s] || 0) + 1; }
  const maxEngaged = Math.max(1, ...Object.values(engagedSourceCounts));

  const sourceSignals: Record<string, number> = {};
  for (const [key, counts] of Object.entries(sourceCounts)) {
    if (counts.scraped > 0) {
      const surviveRatio = counts.survived / counts.scraped;
      const engageBoost = (engagedSourceCounts[key] || 0) / maxEngaged;
      const blended = surviveRatio * 0.7 + engageBoost * 0.3;
      const prev = prevSourceScores[key];
      sourceSignals[key] = Math.round((prev !== undefined ? prev * 0.3 + blended * 0.7 : blended) * 100) / 100;
    }
  }

  const channelSignals: Record<string, Record<string, number>> = { frontpage: {}, niche: {} };
  for (const item of dedupedItems) {
    if (item.source !== "reddit") continue;
    const ch = item.channel === "frontpage" ? "frontpage" : "niche";
    const key = item.source + "/" + (item.sub || "unknown");
    if (!channelSignals[ch][key]) channelSignals[ch][key] = 0;
    if (filteredText.includes(item.title.slice(0, 40))) channelSignals[ch][key]++;
  }

  await updateProgramConfig("research-radar", { SOURCE_SCORES: JSON.stringify(sourceSignals) });

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
    "6. SYSTEM PROPOSALS: Exactly 2 improvements for the research radar system. For each, output on a new line: PROPOSAL_TYPE: (one of: add-source, drop-source, add-interest, adjust-threshold) | DETAIL: (the specific value) | REASON: (why)" + NL + NL +
    "Be concise, specific, and actionable. Include Reddit community sentiment where relevant.",
    SYNTH_MODEL, 4000
  );

  const briefing = briefingResult.text;

  const recentChanges = configChanges.filter((c: any) => {
    const d = new Date(c.appliedAt);
    return Date.now() - d.getTime() < 7 * 24 * 60 * 60 * 1000;
  });

  let healthFooter = NL + NL + "---" + NL + "## RADAR HEALTH" + NL;
  healthFooter += "Items deduped this run: " + dedupCount + NL;
  healthFooter += "Front page contribution: " + redditResult.frontPageCount + " items | Niche sub contribution: " + redditResult.nicheCount + " items" + NL;
  healthFooter += "Source signal scores (survive*0.7 + engage*0.3): " + Object.entries(sourceSignals).map(([k, v]) => k + "=" + v).join(", ") + NL;
  const fpKeys = Object.entries(channelSignals.frontpage).filter(([, v]) => v > 0).map(([k, v]) => k + ":" + v);
  const nicheKeys = Object.entries(channelSignals.niche).filter(([, v]) => v > 0).map(([k, v]) => k + ":" + v);
  if (fpKeys.length || nicheKeys.length) {
    healthFooter += "Channel breakdown — frontpage survived: " + (fpKeys.length ? fpKeys.join(", ") : "none") + " | niche survived: " + (nicheKeys.length ? nicheKeys.join(", ") : "none") + NL;
  }
  healthFooter += "Engagement trend: " + (engagement.count > 0 ? engagement.count + " clicks (7d)" : "no engagement data") + NL;
  if (recentChanges.length > 0) {
    healthFooter += "Config changes since last run: " + recentChanges.map((c: any) => c.action + " (" + new Date(c.appliedAt).toLocaleDateString() + ")").join(", ") + NL;
  }

  const redditCount = redditResult.items.length;
  const lemmyItemCount = lemmyResults.reduce((sum: number, r: any) => sum + r.items.length, 0);
  const statusLine = "reddit:" + redditCount + "(" + redditResult.status + ") hn:" + hnResult.items.length + " arxiv:" + arxivResult.items.length + " gh:" + ghResult.items.length + " lobsters:" + lobstersResult.items.length + " lemmy:" + lemmyItemCount + " deduped:" + dedupCount;
  const llmStatus = (filterResult.ok ? "filter:ok" : "filter:FAIL") + " " + (briefingResult.ok ? "synth:ok" : "synth:FAIL");
  const metricStr = statusLine + " | " + llmStatus;

  const proposals: Array<{section: string; diff: string; reason: string}> = [];
  const proposalRe = /PROPOSAL_TYPE:\\s*(add-source|drop-source|add-interest|adjust-threshold)\\s*\\|\\s*DETAIL:\\s*([^|]+)\\|\\s*REASON:\\s*(.+)/gi;
  let pm;
  while ((pm = proposalRe.exec(briefing)) !== null) {
    const pType = pm[1].trim().toLowerCase();
    const detail = pm[2].trim();
    const reason = pm[3].trim();
    let proposedContent: any = { radarConfigAction: pType };
    if (pType === "add-source" || pType === "drop-source") proposedContent.sub = detail;
    else if (pType === "add-interest") proposedContent.interest = detail;
    else if (pType === "adjust-threshold") proposedContent.threshold = parseInt(detail, 10) || scoreThreshold;
    proposals.push({ section: "SYSTEM PROPOSALS", diff: JSON.stringify(proposedContent), reason: reason.slice(0, 500) });
  }

  for (const [src, signal] of Object.entries(sourceSignals)) {
    if (signal < 0.05 && (sourceCounts[src]?.scraped || 0) >= 5) {
      const sub = src.split("/")[1];
      if (sub && nicheSubs.includes(sub)) {
        proposals.push({
          section: "SYSTEM PROPOSALS",
          diff: JSON.stringify({ radarConfigAction: "drop-source", sub }),
          reason: "Source r/" + sub + " has signal ratio " + signal + " — consistently low relevance. Consider dropping.",
        });
      }
    }
  }

  function trimItems(arr: any[], n: number) { return arr.slice(0, n).map((i: any) => ({ title: (i.title || "").slice(0, 120), url: i.url || "", score: i.score || 0, sub: i.sub || "", source: i.source, tags: i.tags, topComment: i.topComment ? i.topComment.slice(0, 200) : undefined, lang: i.lang, description: i.description, channel: i.channel })); }
  const trimSub: Record<string, any[]> = {};
  for (const [sub, items] of Object.entries(redditResult.bySub)) { trimSub[sub] = trimItems(items as any[], 8); }
  const structuredData = {
    reddit: { bySub: trimSub, mode: redditResult.mode, status: redditResult.status, frontPageCount: redditResult.frontPageCount, nicheCount: redditResult.nicheCount },
    hn: trimItems(hnResult.items, 12),
    github: trimItems(ghResult.items, 10),
    lobsters: trimItems(lobstersResult.items, 10),
    lemmy: Object.fromEntries(lemmyCommunities.map((c: string, i: number) => [c, trimItems((lemmyResults[i] || { items: [] }).items, 6)])),
    arxiv: trimItems(arxivResult.items, 10),
    meta: {
      redditCount, hnCount: hnResult.items.length, ghCount: ghResult.items.length, lobstersCount: lobstersResult.items.length, lemmyCount: lemmyItemCount, arxivCount: arxivResult.items.length,
      filterOk: filterResult.ok, synthOk: briefingResult.ok, dedupCount, frontPageCount: redditResult.frontPageCount, nicheCount: redditResult.nicheCount,
      sourceSignals, engagementCount: engagement.count, timestamp: new Date().toISOString(),
    },
  };

  return {
    summary: briefing + healthFooter + NL + "--- Sources: " + metricStr + NL + "<!--STRUCTURED_DATA_START-->" + NL + JSON.stringify(structuredData) + NL + "<!--STRUCTURED_DATA_END-->",
    metric: metricStr,
    proposals,
  };
}`,
      codeLang: "typescript",
    },
    {
      name: "hn-deep-digest",
      type: "transform",
      schedule: "daily",
      cronExpression: "0 23 * * *",
      instructions: "Overnight HN deep digest — fetches top stories + top comments, synthesizes consensus/contrarian/actionable per story.",
      config: { TOP_N: "8", TASK_TYPE: "research", METRIC: "stories_digested", DIRECTION: "higher", TIMEOUT: "300" },
      costTier: "standard",
      tags: ["program"],
      code: `const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
const TOP_N = parseInt(props.TOP_N || "8", 10);
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const MODELS = ["deepseek/deepseek-chat", "anthropic/claude-sonnet-4"];

async function fetchHN(path: string) {
  return fetch("https://hacker-news.firebaseio.com/v0/" + path + ".json").then(r => r.json());
}

async function callLLM(prompt: string): Promise<string> {
  if (!OPENROUTER_KEY) return "[no API key]";
  for (const model of MODELS) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + OPENROUTER_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 1000, temperature: 0.3 }),
      });
      const d = await r.json();
      const text = d.choices?.[0]?.message?.content?.trim();
      if (text) return "[" + model.split("/").pop()!.split(":")[0] + "] " + text;
    } catch { continue; }
  }
  return "[models unavailable]";
}

async function getComments(storyId: number, limit: number): Promise<string[]> {
  const story = await fetchHN("item/" + storyId);
  const kidIds = (story.kids || []).slice(0, limit);
  const comments: string[] = [];
  for (const kid of kidIds) {
    try {
      const c = await fetchHN("item/" + kid);
      if (c && c.text && !c.deleted && !c.dead) {
        const clean = c.text.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\\s+/g, " ").trim();
        if (clean.length > 20) comments.push((c.by || "anon") + ": " + clean.slice(0, 300));
      }
    } catch {}
  }
  return comments;
}

async function execute() {
  const t0 = Date.now();
  const topIds = await fetchHN("topstories");
  const stories: Array<{ title: string; url: string; score: number; by: string; id: number }> = [];
  for (const id of topIds.slice(0, 30)) {
    const s = await fetchHN("item/" + id);
    if (s && s.score >= 50) stories.push({ title: s.title, url: s.url || "", score: s.score, by: s.by, id: s.id });
    if (stories.length >= TOP_N) break;
  }
  let fullDigest = "HN Deep Digest (" + stories.length + " stories)\\n\\n";
  for (const story of stories) {
    const comments = await getComments(story.id, 8);
    const commentBlock = comments.length > 0 ? "\\n\\nTop comments:\\n" + comments.map(c => "- " + c).join("\\n") : "";
    const analysis = await callLLM(
      "Analyze this HN story and comments. Give:\\nCONSENSUS: What most commenters agree on (1-2 sentences)\\nCONTRARIAN: Any notable dissenting view (1 sentence)\\nACTIONABLE: One thing a reader could do based on this (1 sentence)\\n\\nStory: " + story.title + "\\nURL: " + story.url + "\\nScore: " + story.score + commentBlock
    );
    fullDigest += "[" + story.score + "] " + story.title + "\\n  " + story.url + "\\n" + analysis + "\\n\\n";
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  fullDigest = fullDigest.trim() + "\\n\\n(" + elapsed + "s)";
  return { summary: fullDigest, metric: String(stories.length) };
}`,
      codeLang: "typescript",
    },
    {
      name: "github-trending",
      type: "monitor",
      schedule: "every 8h",
      cronExpression: "0 6,14,22 * * *",
      instructions: "Scrape GitHub trending page for repos in specified languages.",
      config: { LANGUAGES: "typescript,rust,python,go", SINCE: "daily", TASK_TYPE: "research", METRIC: "repos_found", DIRECTION: "higher", LLM_REQUIRED: "false" },
      costTier: "cheap",
      tags: ["program"],
      code: `const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
const LANGUAGES = (props.LANGUAGES || "typescript,rust,python").split(",").map(l => l.trim());
const SINCE = props.SINCE || "daily";

async function fetchTrending(lang: string): Promise<{name: string; url: string; lang: string}[]> {
  const repos: {name: string; url: string; lang: string}[] = [];
  try {
    const r = await fetch("https://github.com/trending/" + encodeURIComponent(lang) + "?since=" + SINCE, {
      headers: { "User-Agent": "OrgCloud/1.0", "Accept": "text/html" }
    });
    const html = await r.text();
    const re = new RegExp("href=\\"/([^/]+/[^/\\"]+)\\"[^>]*>[\\\\s\\\\S]*?</a>", "g");
    let m;
    while ((m = re.exec(html)) !== null) {
      const name = m[1];
      if (!name.includes(".") && !name.includes("?") && name.split("/").length === 2) {
        repos.push({ name, url: "https://github.com/" + name, lang });
      }
    }
  } catch {}
  return repos;
}

async function execute() {
  const results = await Promise.all(LANGUAGES.map(l => fetchTrending(l)));
  const seen = new Set<string>();
  const all = results.flat().filter(r => { if (seen.has(r.name)) return false; seen.add(r.name); return true; });
  let summary = "GitHub trending (" + SINCE + "): " + all.length + " repos across " + LANGUAGES.join(", ");
  for (const r of all.slice(0, 20)) summary += "\\n- [" + r.lang + "] " + r.name + " " + r.url;
  return { summary, metric: String(all.length) };
}`,
      codeLang: "typescript",
    },
    {
      name: "estate-car-finder",
      type: "monitor",
      schedule: "daily",
      cronExpression: "0 22 * * *",
      instructions: "Nightly SoCal Craigslist targeted vehicle finder. Searches for specific Japanese makes/models (Subaru Forester, Toyota Camry/Avalon/Prius/Venza, Honda CR-V/Odyssey, Nissan Rogue) plus estate/low-mileage deals. Uses craigslist-toolkit for targeted searches, scam detection, and tiered scoring.",
      config: { REGIONS: "inlandempire,losangeles,orangecounty,sandiego", MIN_PRICE: "2000", MAX_PRICE: "30000", TOP_N: "15", TARGET_MAKES: "subaru,toyota,honda,nissan", TARGET_MODELS: "forester:subaru:10000,camry:toyota:10000,avalon:toyota:10000,prius:toyota:8000,venza:toyota:12000,cr-v:honda:10000,odyssey:honda:8000,rogue:nissan:9000", TASK_TYPE: "research", METRIC: "deals_found", DIRECTION: "higher", TIMEOUT: "300", TWO_STAGE: "true" },
      costTier: "standard",
      tags: ["program"],
      code: `const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
const REGIONS = (props.REGIONS || "inlandempire").split(",").map(s => s.trim());
const MIN_PRICE = parseInt(props.MIN_PRICE || "2000", 10);
const MAX_PRICE = parseInt(props.MAX_PRICE || "30000", 10);
const TOP_N = parseInt(props.TOP_N || "15", 10);

const DEFAULT_MODELS = "forester:subaru:10000,camry:toyota:10000,avalon:toyota:10000,prius:toyota:8000,venza:toyota:12000,cr-v:honda:10000,odyssey:honda:8000,rogue:nissan:9000";
const TARGET_VEHICLES: Array<{ make: string; model: string; typicalMinPrice: number }> =
  (props.TARGET_MODELS || DEFAULT_MODELS).split(",").map((entry: string) => {
    const [model, make, minPrice] = entry.trim().split(":");
    return { make: (make || "").toLowerCase(), model: (model || "").toLowerCase(), typicalMinPrice: parseInt(minPrice || "8000", 10) };
  }).filter((v: { make: string; model: string }) => v.make && v.model);

const DEFAULT_MAKES = "subaru,toyota,honda,nissan";
const TARGET_MAKES = new Set(
  (props.TARGET_MAKES || DEFAULT_MAKES).split(",").map((s: string) => s.trim().toLowerCase())
);

const ESTATE_KEYWORDS = ["estate", "low miles", "one owner", "garage kept", "original owner", "elderly", "grandma", "grandpa", "deceased", "single owner"];
const SCAM_PHRASES = ["we finance", "no credit check", "buy here pay here", "in-house financing", "everyone approved", "bad credit ok", "no credit no problem", "guaranteed approval", "ez financing", "easy financing"];

const NL = String.fromCharCode(10);

interface Listing {
  id: string;
  title: string;
  price: number;
  url: string;
  region: string;
  date: string;
  isTargetVehicle: boolean;
  matchedMake: string;
  matchedModel: string;
  score: number;
  scamFlags: string[];
}

const { searchCraigslist } = await import(__skillPath("craigslist-toolkit"));

function detectMakeModel(title: string): { make: string; model: string } | null {
  const lower = title.toLowerCase();
  for (const v of TARGET_VEHICLES) {
    const modelVariants = [v.model];
    if (v.model === "cr-v") modelVariants.push("crv", "cr v");
    const makeFound = lower.includes(v.make);
    const modelFound = modelVariants.some(mv => lower.includes(mv));
    if (makeFound && modelFound) return { make: v.make, model: v.model };
    if (modelFound) return { make: v.make, model: v.model };
  }
  for (const make of TARGET_MAKES) {
    if (lower.includes(make)) return { make, model: "" };
  }
  return null;
}

function detectScamFlags(listing: { title: string; price: number }): string[] {
  const flags: string[] = [];
  const lower = listing.title.toLowerCase();
  for (const phrase of SCAM_PHRASES) {
    if (lower.includes(phrase)) flags.push(phrase);
  }
  const detected = detectMakeModel(listing.title);
  if (detected && detected.model) {
    const vehicle = TARGET_VEHICLES.find(v => v.make === detected.make && v.model === detected.model);
    if (vehicle && listing.price > 0 && listing.price < vehicle.typicalMinPrice * 0.4) {
      flags.push("price suspiciously low for " + detected.make + " " + detected.model);
    }
  }
  if (lower.includes("multiple") && lower.includes("available")) flags.push("multiple vehicles listed");
  if (lower.match(/\\d{3}[-.\\s]?\\d{3}[-.\\s]?\\d{4}.*\\d{3}[-.\\s]?\\d{3}[-.\\s]?\\d{4}/)) flags.push("multiple phone numbers");
  const genericPatterns = ["great car", "runs great", "must see", "won't last", "call now", "act fast"];
  let genericCount = 0;
  for (const gp of genericPatterns) { if (lower.includes(gp)) genericCount++; }
  if (genericCount >= 3) flags.push("suspiciously generic description");
  return flags;
}

function scoreListing(listing: Listing): number {
  let score = 0;
  const lower = listing.title.toLowerCase();

  if (listing.matchedModel) {
    score += 50;
  } else if (listing.matchedMake) {
    score += 25;
  }

  for (const kw of ESTATE_KEYWORDS) {
    if (lower.includes(kw)) score += 10;
  }

  if (lower.includes("low miles") || lower.includes("low mileage")) score += 5;
  if (lower.includes("certified") || lower.includes("cpo")) score += 8;
  if (lower.includes("clean title")) score += 5;
  if (lower.includes("one owner") || lower.includes("single owner")) score += 5;

  if (!listing.isTargetVehicle) {
    if (listing.price < 8000) score += 5;
    if (listing.price < 5000) score += 5;
  }

  if (listing.scamFlags.length > 0) {
    score -= listing.scamFlags.length * 15;
  }

  return score;
}

let searchFailures = 0;

async function searchTargetedQueries(): Promise<Listing[]> {
  const allListings: Listing[] = [];
  const seenIds = new Set<string>();

  const searchQueries: Array<{ query: string; make: string; model: string }> = [];
  for (const v of TARGET_VEHICLES) {
    searchQueries.push({ query: v.make + " " + v.model, make: v.make, model: v.model });
  }

  for (const region of REGIONS) {
    for (const sq of searchQueries) {
      try {
        const results = await searchCraigslist({
          region,
          category: "cta",
          query: sq.query,
          params: { min_price: String(MIN_PRICE), max_price: String(MAX_PRICE) },
          maxPages: 1,
          delayMs: 1200,
          warmUp: false,
        });
        for (const r of results) {
          if (seenIds.has(r.id)) continue;
          seenIds.add(r.id);
          const price = r.price || 0;
          if (price < MIN_PRICE || price > MAX_PRICE) continue;
          const detected = detectMakeModel(r.title);
          const scamFlags = detectScamFlags({ title: r.title, price });
          const listing: Listing = {
            id: r.id,
            title: r.title,
            price,
            url: r.url,
            region,
            date: r.date || "",
            isTargetVehicle: !!(detected && detected.model),
            matchedMake: detected?.make || "",
            matchedModel: detected?.model || "",
            score: 0,
            scamFlags,
          };
          listing.score = scoreListing(listing);
          allListings.push(listing);
        }
      } catch { searchFailures++; }
    }
  }
  return allListings;
}

async function searchGeneralEstate(): Promise<Listing[]> {
  const allListings: Listing[] = [];
  const seenIds = new Set<string>();

  for (const region of REGIONS) {
    for (const kw of ["estate sale car", "low miles one owner", "elderly owner car"]) {
      try {
        const results = await searchCraigslist({
          region,
          category: "cta",
          query: kw,
          params: { min_price: String(MIN_PRICE), max_price: String(MAX_PRICE) },
          maxPages: 1,
          delayMs: 1200,
          warmUp: false,
        });
        for (const r of results) {
          if (seenIds.has(r.id)) continue;
          seenIds.add(r.id);
          const price = r.price || 0;
          if (price < MIN_PRICE || price > MAX_PRICE) continue;
          const detected = detectMakeModel(r.title);
          const scamFlags = detectScamFlags({ title: r.title, price });
          const listing: Listing = {
            id: r.id,
            title: r.title,
            price,
            url: r.url,
            region,
            date: r.date || "",
            isTargetVehicle: !!detected?.model,
            matchedMake: detected?.make || "",
            matchedModel: detected?.model || "",
            score: 0,
            scamFlags,
          };
          listing.score = scoreListing(listing);
          allListings.push(listing);
        }
      } catch { searchFailures++; }
    }
  }
  return allListings;
}

async function execute() {
  const [targeted, general] = await Promise.all([searchTargetedQueries(), searchGeneralEstate()]);

  const deduped = new Map<string, Listing>();
  for (const l of [...targeted, ...general]) {
    const existing = deduped.get(l.id);
    if (!existing || l.score > existing.score) {
      deduped.set(l.id, l);
    }
  }
  const all = Array.from(deduped.values());

  const targetMatches = all.filter(l => l.isTargetVehicle && l.scamFlags.length === 0).sort((a, b) => b.score - a.score);
  const flaggedTargets = all.filter(l => l.isTargetVehicle && l.scamFlags.length > 0).sort((a, b) => b.score - a.score);
  const otherDeals = all.filter(l => !l.isTargetVehicle && l.score > 0).sort((a, b) => b.score - a.score);

  let summary = "=== Targeted Vehicle Finder ===" + NL;
  summary += "Scanned " + all.length + " listings across " + REGIONS.join(", ") + NL;
  summary += "Target vehicles: " + TARGET_VEHICLES.map(v => v.make + " " + v.model).join(", ") + NL;
  summary += "Price range: $" + MIN_PRICE + " - $" + MAX_PRICE + NL;
  if (searchFailures > 0) summary += "Note: " + searchFailures + " search queries failed (network/rate-limit)" + NL;
  summary += NL;

  summary += "--- TARGET VEHICLE MATCHES (" + targetMatches.length + ") ---" + NL;
  if (targetMatches.length === 0) {
    summary += "  No clean target vehicle matches found this scan." + NL;
  }
  for (const l of targetMatches.slice(0, TOP_N)) {
    summary += "  [" + l.matchedMake.toUpperCase() + " " + l.matchedModel.toUpperCase() + "] $" + l.price + " | " + l.title.slice(0, 80) + NL;
    summary += "    " + l.url + " [" + l.region + "] (score: " + l.score + ")" + NL;
  }

  if (flaggedTargets.length > 0) {
    summary += NL + "--- FLAGGED TARGET LISTINGS (" + flaggedTargets.length + ") ---" + NL;
    for (const l of flaggedTargets.slice(0, 5)) {
      summary += "  [FLAGGED] $" + l.price + " | " + l.title.slice(0, 70) + NL;
      summary += "    Flags: " + l.scamFlags.join(", ") + NL;
      summary += "    " + l.url + " [" + l.region + "]" + NL;
    }
  }

  if (otherDeals.length > 0) {
    summary += NL + "--- OTHER NOTABLE DEALS (" + otherDeals.length + ") ---" + NL;
    for (const l of otherDeals.slice(0, 5)) {
      summary += "  $" + l.price + " | " + l.title.slice(0, 80) + NL;
      summary += "    " + l.url + " [" + l.region + "] (score: " + l.score + ")" + NL;
    }
  }

  return { summary, metric: String(targetMatches.length) };
}`,
      codeLang: "typescript",
    },
    {
      name: "fed-rates",
      type: "monitor",
      schedule: "daily",
      cronExpression: "0 6 * * *",
      instructions: "Fetch latest values for key FRED economic series.",
      config: { SERIES_IDS: "DGS10,DGS2,T10Y2Y,FEDFUNDS,UNRATE", TASK_TYPE: "research", METRIC: "data_points", DIRECTION: "higher", LLM_REQUIRED: "false" },
      costTier: "cheap",
      tags: ["program"],
      code: `const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
const SERIES = (props.SERIES_IDS || "DGS10,DGS2,FEDFUNDS").split(",").map(s => s.trim());

async function fetchSeries(id: string): Promise<{id: string; value: string; date: string}> {
  try {
    const r = await fetch("https://fred.stlouisfed.org/series/" + id, {
      headers: { "User-Agent": "OrgCloud/1.0" }
    });
    const html = await r.text();
    const valM = html.match(new RegExp("class=\\"[^\\"]*obs-value[^\\"]*\\"[^>]*>([^<]+)"));
    const dateM = html.match(new RegExp("class=\\"[^\\"]*obs-date[^\\"]*\\"[^>]*>([^<]+)"));
    return { id, value: valM ? valM[1].trim() : "N/A", date: dateM ? dateM[1].trim() : "" };
  } catch { return { id, value: "error", date: "" }; }
}

async function execute() {
  const results = await Promise.all(SERIES.map(s => fetchSeries(s)));
  const valid = results.filter(r => r.value !== "error");
  let summary = "FRED economic data (" + valid.length + "/" + SERIES.length + " series):";
  for (const r of results) summary += "\\n  " + r.id + ": " + r.value + (r.date ? " (" + r.date + ")" : "");
  return { summary, metric: String(valid.length) };
}`,
      codeLang: "typescript",
    },
    {
      name: "free-stuff-radar",
      type: "monitor",
      schedule: "every 4h",
      cronExpression: "0 */4 * * *",
      enabled: false,
      instructions: "Scrape Craigslist free section for items matching keywords. Returns structured listing data for LLM triage. DISABLED: Craigslist blocks server IPs without Chrome bridge.",
      config: { CL_REGIONS: "inlandempire,losangeles,orangecounty", KEYWORDS: "furniture,electronics,tools,appliance,computer,monitor,desk,chair,table,tv,printer,laptop", TASK_TYPE: "research", METRIC: "items_found", DIRECTION: "higher", LLM_REQUIRED: "false" },
      costTier: "cheap",
      tags: ["program"],
      code: `const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
const REGIONS = (props.CL_REGIONS || props.CL_REGION || "inlandempire").split(",").map(s => s.trim());
const KEYWORDS = (props.KEYWORDS || "furniture,electronics,tools").split(",").map(s => s.trim().toLowerCase());

interface FreeItem { title: string; url: string; region: string; date: string; matched: string[] }

async function scrapeRegion(region: string): Promise<FreeItem[]> {
  const items: FreeItem[] = [];
  try {
    const url = "https://" + region + ".craigslist.org/search/zip?format=rss&sort=date";
    const r = await smartFetch(url, { headers: { "User-Agent": "OrgCloud/1.0" } });
    const xml = await r.text();
    if (xml.includes("blocked") && xml.length < 500) return items;
    const entries = xml.split("<item ");
    for (let i = 1; i < entries.length && items.length < 60; i++) {
      const titleM = entries[i].match(/<title><![CDATA[\\[(.*?)\\]]]>/s) || entries[i].match(/<title>([^<]+)/);
      const linkM = entries[i].match(/<link>([^<]+)/);
      const dateM = entries[i].match(/<dc:date>([^<]+)/) || entries[i].match(/<pubDate>([^<]+)/);
      const title = titleM ? titleM[1].trim() : "";
      const lower = title.toLowerCase();
      const matched = KEYWORDS.filter(kw => lower.includes(kw));
      if (matched.length > 0) {
        items.push({ title, url: linkM ? linkM[1].trim() : "", region, date: dateM ? dateM[1].trim() : "", matched });
      }
    }
  } catch {}
  return items;
}

async function execute() {
  const allResults = await Promise.all(REGIONS.map(r => scrapeRegion(r)));
  const all = allResults.flat();
  all.sort((a, b) => b.matched.length - a.matched.length);
  let summary = "Free Stuff Radar: " + all.length + " matching items across " + REGIONS.join(", ") + String.fromCharCode(10);
  for (const item of all.slice(0, 15)) {
    summary += String.fromCharCode(10) + "  [" + item.matched.join(",") + "] " + item.title.slice(0, 70) + String.fromCharCode(10) + "    " + item.url + " (" + item.region + ")";
  }
  if (all.length === 0) summary += String.fromCharCode(10) + "  No matching free items found this cycle.";
  return { summary, metric: String(all.length) };
}`,
      codeLang: "typescript",
    },
    {
      name: "sec-filings",
      type: "monitor",
      schedule: "daily",
      cronExpression: "0 9 * * *",
      instructions: "Search SEC EDGAR for recent filings from specific companies.",
      config: { TICKER_LIST: "AAPL,TSLA,NVDA,MSFT,GOOG", FILING_TYPES: "10-K,10-Q,8-K", TASK_TYPE: "research", METRIC: "filings_found", DIRECTION: "higher", LLM_REQUIRED: "false" },
      costTier: "cheap",
      tags: ["program"],
      code: `const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
const TICKERS = (props.TICKER_LIST || "AAPL,TSLA,NVDA").split(",").map(t => t.trim());
const FILING_TYPES = (props.FILING_TYPES || "10-K,10-Q,8-K").split(",").map(t => t.trim());

async function fetchFilings(ticker: string): Promise<Array<{ticker: string; type: string; date: string; url: string}>> {
  const filings: Array<{ticker: string; type: string; date: string; url: string}> = [];
  try {
    const r = await fetch("https://efts.sec.gov/LATEST/search-index?q=%22" + ticker + "%22&dateRange=custom&startdt=" + new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0] + "&enddt=" + new Date().toISOString().split("T")[0] + "&forms=" + FILING_TYPES.join(","), {
      headers: { "User-Agent": "OrgCloud research@orgcloud.dev", "Accept": "application/json" }
    });
    if (!r.ok) {
      const r2 = await fetch("https://efts.sec.gov/LATEST/search-index?q=%22" + ticker + "%22&forms=" + FILING_TYPES.join(","), {
        headers: { "User-Agent": "OrgCloud research@orgcloud.dev", "Accept": "application/json" }
      });
      if (!r2.ok) return filings;
      const d2 = await r2.json();
      for (const hit of (d2.hits?.hits || []).slice(0, 5)) {
        const src = hit._source || {};
        filings.push({ ticker, type: src.form_type || "?", date: (src.file_date || "").slice(0, 10), url: "https://www.sec.gov/Archives/edgar/data/" + (src.file_num || "") });
      }
      return filings;
    }
    const d = await r.json();
    for (const hit of (d.hits?.hits || []).slice(0, 5)) {
      const src = hit._source || {};
      filings.push({ ticker, type: src.form_type || "?", date: (src.file_date || "").slice(0, 10), url: "https://www.sec.gov/Archives/edgar/data/" + (src.file_num || "") });
    }
  } catch {}
  return filings;
}

async function execute() {
  const results = await Promise.all(TICKERS.map(t => fetchFilings(t)));
  const all = results.flat();
  let summary = "SEC EDGAR filings: " + all.length + " found for " + TICKERS.join(", ");
  for (const f of all.slice(0, 20)) summary += "\\n  [" + f.type + "] " + f.ticker + " " + f.date + " " + f.url;
  return { summary, metric: String(all.length) };
}`,
      codeLang: "typescript",
    },
    {
      name: "price-watch",
      type: "monitor",
      schedule: "daily",
      cronExpression: "0 7 * * *",
      instructions: "Monitor Craigslist vehicle listings under max price. Scrapes RSS, deduplicates, surfaces cheapest deals.",
      config: { SEARCH_QUERIES: "car,truck,suv", CL_REGIONS: "inlandempire,losangeles", MAX_PRICE: "5000", TOP_N: "10", TASK_TYPE: "research", METRIC: "listings_found", DIRECTION: "higher", LLM_REQUIRED: "false" },
      costTier: "cheap",
      tags: ["program"],
      code: `const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
const QUERIES = (props.SEARCH_QUERIES || props.SEARCH_QUERY || "car").split(",").map(s => s.trim());
const REGIONS = (props.CL_REGIONS || props.CL_REGION || "inlandempire").split(",").map(s => s.trim());
const MAX_PRICE = parseInt(props.MAX_PRICE || "5000", 10);
const TOP_N = parseInt(props.TOP_N || "10", 10);

interface Vehicle { title: string; price: number; url: string; region: string; query: string }

async function search(region: string, query: string): Promise<Vehicle[]> {
  const vehicles: Vehicle[] = [];
  try {
    const url = "https://" + region + ".craigslist.org/search/cta?format=rss&query=" + encodeURIComponent(query) + "&max_price=" + MAX_PRICE + "&sort=date";
    const r = await smartFetch(url, { headers: { "User-Agent": "OrgCloud/1.0" } });
    const xml = await r.text();
    if (xml.includes("blocked") && xml.length < 500) return vehicles;
    const items = xml.split("<item ");
    for (let i = 1; i < items.length && vehicles.length < 30; i++) {
      const titleM = items[i].match(/<title><![CDATA[\\[(.*?)\\]]]>/s) || items[i].match(/<title>([^<]+)/);
      const linkM = items[i].match(/<link>([^<]+)/);
      const title = titleM ? titleM[1].trim() : "";
      const priceM = title.match(/\\$([\\d,]+)/);
      const price = priceM ? parseInt(priceM[1].replace(",", ""), 10) : 0;
      if (title && price > 0 && price <= MAX_PRICE) {
        vehicles.push({ title, price, url: linkM ? linkM[1].trim() : "", region, query });
      }
    }
  } catch {}
  return vehicles;
}

async function execute() {
  const tasks: Promise<Vehicle[]>[] = [];
  for (const region of REGIONS) for (const q of QUERIES) tasks.push(search(region, q));
  const results = (await Promise.all(tasks)).flat();
  const seen = new Set<string>();
  const unique = results.filter(v => { const key = v.url || v.title; if (seen.has(key)) return false; seen.add(key); return true; });
  unique.sort((a, b) => a.price - b.price);
  const top = unique.slice(0, TOP_N);
  let summary = "Price Watch: " + unique.length + " vehicles under $" + MAX_PRICE + " across " + REGIONS.join(", ") + String.fromCharCode(10);
  for (const v of top) {
    summary += String.fromCharCode(10) + "  $" + v.price + " | " + v.title.slice(0, 75) + String.fromCharCode(10) + "    " + v.url;
  }
  if (unique.length === 0) summary += String.fromCharCode(10) + "  No listings found.";
  return { summary, metric: String(unique.length) };
}`,
      codeLang: "typescript",
    },
    {
      name: "foreclosure-monitor",
      type: "monitor",
      schedule: "daily",
      cronExpression: "0 8 * * *",
      instructions: "Scrape HUD homes, Fannie Mae HomePath, and public auction sites for foreclosures and government property listings near target ZIP codes.",
      config: { STATE: "CA", ZIP_CODES: "92373,92374,92376,92404,92405", TASK_TYPE: "research", METRIC: "listings_found", DIRECTION: "higher", LLM_REQUIRED: "false" },
      costTier: "cheap",
      tags: ["program"],
      code: `const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
const STATE = props.STATE || "CA";
const ZIP_CODES = (props.ZIP_CODES || props.ZIP_CODE || "92373").split(",").map(s => s.trim());

interface ForeclosureListing { source: string; title: string; price: string; location: string; url: string }

async function scrapeHUD(): Promise<ForeclosureListing[]> {
  const listings: ForeclosureListing[] = [];
  try {
    const url = "https://www.hudhomestore.gov/Listing/PropertySearchResult?sState=" + STATE + "&sZipCode=" + ZIP_CODES[0] + "&iMiles=25&sPropType=SFR&iPageSize=20&sLanguage=ENGLISH";
    const r = await smartFetch(url, { headers: { "User-Agent": "OrgCloud/1.0", "Accept": "text/html" } });
    const html = await r.text();
    const rows = html.split("PropertyDetail");
    for (let i = 1; i < rows.length && listings.length < 15; i++) {
      const addrM = rows[i].match(/>([^<]*(?:St|Ave|Blvd|Dr|Rd|Ct|Ln|Way|Cir)[^<]*)</i);
      const priceM = rows[i].match(/\\$[\\d,]+/);
      const caseM = rows[i].match(/CaseNumber=([^&"]+)/);
      listings.push({
        source: "HUD",
        title: addrM ? addrM[1].trim() : "HUD Property",
        price: priceM ? priceM[0] : "N/A",
        location: STATE,
        url: caseM ? "https://www.hudhomestore.gov/Listing/PropertyDetail?CaseNumber=" + caseM[1] : "https://www.hudhomestore.gov"
      });
    }
  } catch {}
  return listings;
}

async function scrapeHomePath(): Promise<ForeclosureListing[]> {
  const listings: ForeclosureListing[] = [];
  try {
    const url = "https://www.homepath.fanniemae.com/cg-bin/fhmse/se_search?state=" + STATE + "&zip=" + ZIP_CODES[0] + "&radius=25&format=json";
    const r = await smartFetch(url, { headers: { "User-Agent": "OrgCloud/1.0" } });
    if (r.ok) {
      const text = await r.text();
      const addresses = text.match(/"address"\\s*:\\s*"([^"]+)"/g) || [];
      const prices = text.match(/"listPrice"\\s*:\\s*"?([\\d,]+)/g) || [];
      for (let i = 0; i < Math.min(addresses.length, 10); i++) {
        const addr = addresses[i].replace(/"address"\\s*:\\s*"/, "").replace(/"$/, "");
        const price = prices[i] ? "$" + prices[i].replace(/"listPrice"\\s*:\\s*"?/, "") : "N/A";
        listings.push({ source: "HomePath", title: addr, price, location: STATE, url: "https://www.homepath.fanniemae.com" });
      }
    }
  } catch {}
  return listings;
}

async function execute() {
  const [hud, homepath] = await Promise.all([scrapeHUD(), scrapeHomePath()]);
  const all = [...hud, ...homepath];
  let summary = "Foreclosure Monitor (" + STATE + ", ZIPs: " + ZIP_CODES.join(",") + "): " + all.length + " properties found" + String.fromCharCode(10);
  if (hud.length > 0) {
    summary += String.fromCharCode(10) + "=== HUD Homes (" + hud.length + ") ===" + String.fromCharCode(10);
    for (const l of hud) summary += "  " + l.price + " | " + l.title + String.fromCharCode(10) + "    " + l.url + String.fromCharCode(10);
  }
  if (homepath.length > 0) {
    summary += String.fromCharCode(10) + "=== HomePath (" + homepath.length + ") ===" + String.fromCharCode(10);
    for (const l of homepath) summary += "  " + l.price + " | " + l.title + String.fromCharCode(10) + "    " + l.url + String.fromCharCode(10);
  }
  if (all.length === 0) summary += "  No foreclosure listings found near target ZIP codes.";
  return { summary, metric: String(all.length) };
}`,
      codeLang: "typescript",
    },
    {
      name: "mandela-berenstain",
      type: "monitor",
      schedule: "daily",
      cronExpression: "0 22 * * *",
      instructions: "Mandela Effect research — search Internet Archive and web for Berenstain/Berenstein Bears spelling variants. Collects real evidence links with source context for LLM synthesis.",
      config: { SEARCH_TERMS: "berenstain bears,berenstein bears", TASK_TYPE: "research", METRIC: "total_mentions", DIRECTION: "higher", OUTPUT_TYPE: "proposal", TIMEOUT: "600", TWO_STAGE: "true" },
      costTier: "standard",
      tags: ["program"],
      code: `const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
const SEARCH_TERMS = (props.SEARCH_TERMS || "berenstain bears,berenstein bears").split(",").map(s => s.trim());

interface ArchiveResult { title: string; identifier: string; year: string; mediaType: string; url: string; spelling: string }

async function searchArchive(term: string): Promise<ArchiveResult[]> {
  const results: ArchiveResult[] = [];
  try {
    const q = encodeURIComponent(term);
    const url = "https://archive.org/advancedsearch.php?q=" + q + "&fl[]=identifier&fl[]=title&fl[]=year&fl[]=mediatype&rows=25&output=json&sort[]=downloads+desc";
    const r = await fetch(url, { headers: { "User-Agent": "OrgCloud/1.0" } });
    const data = await r.json();
    const docs = data?.response?.docs || [];
    const spelling = term.toLowerCase().includes("berenstein") ? "berenstein" : "berenstain";
    for (const doc of docs) {
      results.push({
        title: doc.title || "Untitled",
        identifier: doc.identifier || "",
        year: doc.year || "unknown",
        mediaType: doc.mediatype || "unknown",
        url: "https://archive.org/details/" + (doc.identifier || ""),
        spelling
      });
    }
  } catch {}
  return results;
}

async function searchWikipedia(): Promise<string[]> {
  const mentions: string[] = [];
  try {
    const r = await fetch("https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=berenstain+OR+berenstein+bears+spelling&srnamespace=0&srlimit=10&format=json", {
      headers: { "User-Agent": "OrgCloud/1.0" }
    });
    const data = await r.json();
    for (const item of data?.query?.search || []) {
      const snippet = (item.snippet || "").replace(/<[^>]*>/g, "").slice(0, 120);
      mentions.push(item.title + ": " + snippet);
    }
  } catch {}
  return mentions;
}

async function execute() {
  const archiveResults = await Promise.all(SEARCH_TERMS.map(t => searchArchive(t)));
  const wikiMentions = await searchWikipedia();
  const allArchive = archiveResults.flat();
  const berenstain = allArchive.filter(r => r.spelling === "berenstain");
  const berenstein = allArchive.filter(r => r.spelling === "berenstein");
  let summary = "Mandela Effect Research: Berenstain vs Berenstein Bears" + String.fromCharCode(10);
  summary += String.fromCharCode(10) + "Internet Archive hits: " + allArchive.length + " total (" + berenstain.length + " berenstain, " + berenstein.length + " berenstein)" + String.fromCharCode(10);
  summary += String.fromCharCode(10) + "=== BERENSTAIN results (canonical) ===" + String.fromCharCode(10);
  for (const r of berenstain.slice(0, 8)) {
    summary += "  [" + r.year + "] [" + r.mediaType + "] " + r.title.slice(0, 60) + String.fromCharCode(10) + "    " + r.url + String.fromCharCode(10);
  }
  summary += String.fromCharCode(10) + "=== BERENSTEIN results (variant) ===" + String.fromCharCode(10);
  for (const r of berenstein.slice(0, 8)) {
    summary += "  [" + r.year + "] [" + r.mediaType + "] " + r.title.slice(0, 60) + String.fromCharCode(10) + "    " + r.url + String.fromCharCode(10);
  }
  if (wikiMentions.length > 0) {
    summary += String.fromCharCode(10) + "=== Wikipedia mentions ===" + String.fromCharCode(10);
    for (const m of wikiMentions) summary += "  " + m + String.fromCharCode(10);
  }
  return { summary, metric: String(allArchive.length) };
}`,
      codeLang: "typescript",
    },
    {
      name: "nightly-meal-recommender",
      type: "monitor",
      schedule: "daily",
      cronExpression: "0 21 * * *",
      instructions: "Nightly meal recommendation program. Generates one new dinner recipe for the household (appliance-tagged, scored by Open Food Facts for ingredients) and one new lunch item for Willa based on her bridge food strategy and acceptance history. Avoids repeating previous recommendations; factors in pantry stock and expiring items.",
      config: { TASK_TYPE: "creative", TIMEOUT: "120" },
      costTier: "standard",
      tags: ["program", "meals"],
      code: `const bridgePort = typeof __bridgePort !== "undefined" ? __bridgePort : "5000";

async function execute() {
  const today = new Date().toISOString().split("T")[0];

  const configRes = await fetch("http://localhost:" + bridgePort + "/api/config/meals_dietary_prefs");
  let prefs = { householdSize: 3, appliances: ["Instant Pot", "sous vide", "rice cooker", "stove", "toaster oven", "crockpot"], kiddoName: "Willa", kiddoCurrentFavorites: ["Go-Gurt", "chicken nuggets", "Goldfish crackers"], cuisinePreferences: ["American", "Italian", "Mexican", "Asian"] };
  if (configRes.ok) {
    const c = await configRes.json();
    try { prefs = JSON.parse(c.value); } catch {}
  }

  const pastRecsRes = await fetch("http://localhost:" + bridgePort + "/api/nightly-recommendations?limit=30");
  const pastRecs = pastRecsRes.ok ? await pastRecsRes.json() : [];
  const pastRecipeNames = pastRecs.map((r: any) => r.recipeRecommendation?.name).filter(Boolean);
  const pastKiddoItems = pastRecs.map((r: any) => r.kiddoLunchSuggestion?.item).filter(Boolean);

  const pantryRes = await fetch("http://localhost:" + bridgePort + "/api/pantry?status=in_stock");
  const pantry = pantryRes.ok ? await pantryRes.json() : [];
  const expiringItems = pantry.filter((p: any) => {
    if (!p.estimatedExpiration) return false;
    const daysLeft = Math.round((new Date(p.estimatedExpiration).getTime() - Date.now()) / 86400000);
    return daysLeft <= 3 && daysLeft >= 0;
  }).map((p: any) => p.name);

  const kiddoRes = await fetch("http://localhost:" + bridgePort + "/api/kiddo-food-log");
  const kiddoLogs = kiddoRes.ok ? await kiddoRes.json() : [];
  const acceptedFoods = kiddoLogs.filter((l: any) => l.verdict === "accepted").map((l: any) => l.itemName);
  const rejectedFoods = kiddoLogs.filter((l: any) => l.verdict === "rejected").map((l: any) => l.itemName);

  const prompt = "Generate a nightly meal recommendation as JSON with two fields:\\n" +
    "1. recipeRecommendation: {name, appliance, ingredients: [], instructions}\\n" +
    "2. kiddoLunchSuggestion: {item, bridgeRationale, similarTo}\\n\\n" +
    "Appliances: " + prefs.appliances.join(", ") + "\\n" +
    "Cuisine prefs: " + (prefs.cuisinePreferences || []).join(", ") + "\\n" +
    "DO NOT repeat these recipes: " + pastRecipeNames.join(", ") + "\\n" +
    "DO NOT repeat these kiddo items: " + pastKiddoItems.join(", ") + "\\n" +
    "Expiring pantry items (prefer using): " + (expiringItems.join(", ") || "none") + "\\n" +
    "Kiddo favorites: " + (prefs.kiddoCurrentFavorites || []).join(", ") + "\\n" +
    "Kiddo accepted: " + acceptedFoods.join(", ") + "\\n" +
    "Kiddo rejected: " + rejectedFoods.join(", ") + "\\n" +
    "Return ONLY valid JSON.";

  const llmRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (process.env.OPENROUTER_API_KEY || "") },
    body: JSON.stringify({ model: "anthropic/claude-sonnet-4", messages: [{ role: "user", content: prompt }], max_tokens: 1000 }),
  });
  const llmData = await llmRes.json();
  const content = llmData.choices?.[0]?.message?.content || "";
  const jsonMatch = content.match(/\\{[\\s\\S]*\\}/);
  let rec = { recipeRecommendation: null as any, kiddoLunchSuggestion: null as any };
  if (jsonMatch) {
    try { rec = JSON.parse(jsonMatch[0]); } catch {}
  }

  await fetch("http://localhost:" + bridgePort + "/api/nightly-recommendations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recDate: today, recipeRecommendation: rec.recipeRecommendation, kiddoLunchSuggestion: rec.kiddoLunchSuggestion, status: "pending" }),
  });

  const recipeName = rec.recipeRecommendation?.name || "unknown";
  const kiddoItem = rec.kiddoLunchSuggestion?.item || "unknown";
  return { summary: "Nightly Meal Rec (" + today + "): Recipe: " + recipeName + " | Kiddo: " + kiddoItem, metric: "1" };
}`,
      codeLang: "typescript",
    },
    {
      name: "budget-strategist",
      type: "meta",
      schedule: "every 8h",
      cronExpression: "0 2,10,18 * * *",
      instructions: "Budget strategist: reviews token usage, model quality, cost efficiency, and cross-program patterns. Produces structured proposals for budget adjustments, model routing, and schedule optimization.",
      config: { TASK_TYPE: "reasoning", LLM_REQUIRED: "false", METRIC: "budget_efficiency", DIRECTION: "higher" },
      costTier: "cheap",
      tags: ["program", "budget", "meta"],
      code: `async function execute() {
  const port = process.env.__BRIDGE_PORT || process.env.PORT || "5000";
  const BASE = "http://localhost:" + port;

  const hdrs: Record<string, string> = { "Content-Type": "application/json" };
  if (__apiKey) hdrs["Authorization"] = "Bearer " + __apiKey;

  let budgetData = { used: 0, budget: 500000, remaining: 500000, percentUsed: 0, estimatedCostToday: 0, report: { byProgram: {}, byModel: {} } };
  let modelsData = [];
  let recentResults = [];
  let memoriesData: any[] = [];
  try { const r = await fetch(BASE + "/api/budget", { headers: hdrs }); if (r.ok) budgetData = await r.json(); } catch {}
  try { const r = await fetch(BASE + "/api/models", { headers: hdrs }); if (r.ok) modelsData = await r.json(); } catch {}
  try { const r = await fetch(BASE + "/api/results?limit=50", { headers: hdrs }); if (r.ok) recentResults = await r.json(); } catch {}
  try { const r = await fetch(BASE + "/api/memories?limit=30", { headers: hdrs }); if (r.ok) memoriesData = await r.json(); } catch {}

  const proposals: Array<{section: string; diff: string; reason: string}> = [];
  const worklog: Record<string, any> = {
    timestamp: new Date().toISOString(),
    budget: { used: budgetData.used, budget: budgetData.budget, percentUsed: budgetData.percentUsed, estimatedCost: budgetData.estimatedCostToday },
    modelHealth: {} as Record<string, any>,
    programAnalysis: {} as Record<string, any>,
    proposals: [] as string[],
  };

  for (const m of modelsData) {
    const q = m.quality || { successes: 0, failures: 0, score: 100 };
    worklog.modelHealth[m.id] = { tier: m.tier, quality: q.score, successes: q.successes, failures: q.failures };
    if (q.score < 50 && (q.successes + q.failures) >= 5) {
      proposals.push({ section: "PROGRAMS", diff: "Deprioritize model " + m.id + " (quality " + q.score + "%, " + q.failures + " failures)", reason: "Model " + m.label + " has degraded quality score of " + q.score + "%" });
      worklog.proposals.push("deprioritize:" + m.id);
    }
  }

  const byProg = budgetData.report?.byProgram || {};
  const progEntries = Object.entries(byProg);
  const totalTokens = budgetData.used || 1;
  for (const [name, data] of progEntries) {
    const d = data as any;
    const pct = Math.round((d.tokens / totalTokens) * 100);
    worklog.programAnalysis[name] = { tokens: d.tokens, cost: d.cost, calls: d.calls, budgetShare: pct };
    if (pct > 40) {
      proposals.push({ section: "PROGRAMS", diff: "Program " + name + " consumes " + pct + "% of budget. Consider: reduce schedule frequency, switch to TWO_STAGE=true, or lower cost tier.", reason: "Budget concentration risk: " + name + " using " + d.tokens + " tokens (" + pct + "%)" });
      worklog.proposals.push("reduce:" + name);
    }
  }

  const errorResults = recentResults.filter((r: any) => r.status === "error");
  if (errorResults.length > 10) {
    const errorProgs = new Set(errorResults.map((r: any) => r.programName));
    for (const name of errorProgs) {
      const progErrors = errorResults.filter((r: any) => r.programName === name).length;
      if (progErrors >= 3) {
        proposals.push({ section: "PROGRAMS", diff: "Program " + name + " has " + progErrors + " recent errors. Consider disabling or investigating.", reason: "High error rate in " + name });
        worklog.proposals.push("investigate:" + name);
      }
    }
  }

  if (budgetData.percentUsed > 80) {
    proposals.push({ section: "PROGRAMS", diff: "Budget at " + budgetData.percentUsed + "%. Recommend increasing daily_token_budget or reducing program schedules.", reason: "Budget approaching limit" });
    worklog.proposals.push("budget-warning");
  }

  const memoryPrograms = new Map<string, number>();
  for (const mem of memoriesData) {
    const prog = mem.programName || mem.source || "unknown";
    memoryPrograms.set(prog, (memoryPrograms.get(prog) || 0) + 1);
  }
  worklog.memoryAnalysis = { totalMemories: memoriesData.length, byProgram: Object.fromEntries(memoryPrograms) };
  const silentPrograms = Object.keys(byProg).filter(p => !memoryPrograms.has(p));
  if (silentPrograms.length > 0) {
    proposals.push({ section: "PROGRAMS", diff: "Programs consuming budget but producing no memories: " + silentPrograms.join(", "), reason: "Silent programs detected" });
    worklog.proposals.push("silent:" + silentPrograms.join(","));
  }

  const NL = String.fromCharCode(10);
  const lines = ["=== BUDGET STRATEGIST REPORT ==="];
  lines.push("Budget: " + budgetData.used.toLocaleString() + " / " + budgetData.budget.toLocaleString() + " (" + budgetData.percentUsed + "%) | Est: $" + (budgetData.estimatedCostToday || 0).toFixed(4));

  if (progEntries.length > 0) {
    lines.push("", "--- Program Usage ---");
    const sorted = progEntries.sort((a, b) => ((b[1] as any).tokens || 0) - ((a[1] as any).tokens || 0));
    for (const [name, data] of sorted.slice(0, 10)) {
      const d = data as any;
      lines.push("  " + name.padEnd(25) + " " + (d.tokens || 0).toLocaleString().padStart(8) + " tok  $" + (d.cost || 0).toFixed(4));
    }
  }

  if (proposals.length > 0) {
    lines.push("", "--- Proposals (" + proposals.length + ") ---");
    for (const p of proposals) lines.push("  * " + p.reason);
  }

  lines.push("", "WORKLOG:" + JSON.stringify(worklog));

  return { summary: lines.join(NL), metric: String(proposals.length), proposals };
}`,
      codeLang: "typescript",
    },
    {
      name: "overnight-digest",
      type: "meta",
      schedule: "daily",
      cronExpression: "0 13 * * *",
      instructions: "Goal-oriented daily intelligence brief. Matches research findings to user goals, generates wiki-style HTML briefing, and auto-sends via ntfy. Runs at 6 AM PT.",
      config: { TASK_TYPE: "reasoning", LLM_REQUIRED: "false", OUTPUT_TYPE: "proposal", METRIC: "proposals_generated", DIRECTION: "higher", TIMEOUT: "300" },
      costTier: "cheap",
      tags: ["program", "meta", "digest"],
      code: `const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
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
}`,
      codeLang: "typescript",
    },
    {
      name: "snow-shift-brief",
      type: "meta",
      schedule: "weekdays",
      cronExpression: "30 13 * * 1-5",
      instructions: "ServiceNow shift brief. Pulls open incidents, changes, requests, and group queue items via the existing ServiceNow navigation paths (list-my-incidents, list-my-changes, list-my-requests, list-group-queue), then synthesizes an SLA-aware shift briefing. Runs at 6:30 AM PT weekdays.",
      config: { TASK_TYPE: "extraction", LLM_REQUIRED: "false", OUTPUT_TYPE: "proposal", METRIC: "items_briefed", DIRECTION: "higher", TIMEOUT: "180" },
      costTier: "cheap",
      tags: ["program", "meta", "digest", "snow"],
      code: `const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const NL = String.fromCharCode(10);

async function callCheapLLM(prompt: string, maxTokens = 3000): Promise<{ok: boolean; text: string}> {
  const models = ["deepseek/deepseek-chat", "qwen/qwen-2.5-72b-instruct"];
  for (const modelId of models) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + OPENROUTER_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.2 }),
        signal: AbortSignal.timeout(90000),
      });
      const d = await r.json();
      const text = d.choices?.[0]?.message?.content?.trim();
      if (text) return { ok: true, text };
    } catch {}
  }
  return { ok: false, text: "[LLM unavailable for SNOW brief]" };
}

async function execute() {
  const port = process.env.__BRIDGE_PORT || process.env.PORT || "5000";
  const BASE = "http://localhost:" + port;
  const hdrs: Record<string, string> = { "Content-Type": "application/json" };
  if (__apiKey) hdrs["Authorization"] = "Bearer " + __apiKey;

  const { saveBriefingAndNotify } = await import(__projectRoot + "/server/briefing-utils");

  const NAV_PATH_NAMES = ["list-my-incidents", "list-my-changes", "list-my-requests", "list-group-queue"];
  let navPaths: any[] = [];
  try {
    const r = await fetch(BASE + "/api/navigation-paths", { headers: hdrs });
    if (r.ok) navPaths = await r.json();
  } catch {}

  const snowData: Record<string, string> = {};
  let liveFetchCount = 0;

  let snowInstanceUrl = "";
  try {
    const cfgR = await fetch(BASE + "/api/config/snow_instance", { headers: hdrs });
    if (cfgR.ok) { const cfgData = await cfgR.json(); snowInstanceUrl = (cfgData.value || "").replace(/\\/+$/, ""); }
  } catch {}
  if (!snowInstanceUrl) snowInstanceUrl = "https://uchealth.service-now.com";

  let sowSuccess = false;
  try {
    const sowUrl = snowInstanceUrl + "/now/sow/home";
    const sowResult = await bridgeFetch(sowUrl, { type: "dom", timeout: 30000 });
    const sowText = sowResult.text || (typeof sowResult.body === "string" ? sowResult.body : "");
    if (sowText.length > 200) {
      snowData["sow-home"] = String(sowText).slice(0, 8000);
      liveFetchCount++;
      sowSuccess = true;
    }
  } catch {}

  if (!sowSuccess) {
    const snowPaths = navPaths.filter((p: any) => NAV_PATH_NAMES.includes(p.name));
    if (snowPaths.length === 0) {
      return { summary: "SNOW Shift Brief: No ServiceNow data sources available (SOW homepage failed, no classic nav paths). Cannot generate brief.", metric: "0" };
    }

    for (const pathName of NAV_PATH_NAMES) {
      const navPath = snowPaths.find((p: any) => p.name === pathName);
      if (!navPath) {
        snowData[pathName] = "Navigation path '" + pathName + "' not found";
        continue;
      }

      const steps = navPath.steps || [];
      const navigateStep = steps.find((s: any) => s.action === "navigate");
      const targetUrl = navigateStep?.target || "";
      const extractionRules = navPath.extractionRules || {};

      if (!targetUrl) {
        snowData[pathName] = "No target URL defined for " + pathName;
        continue;
      }

      try {
        const result = await bridgeFetch(targetUrl, {
          type: "dom",
          selectors: extractionRules,
          timeout: 30000,
        });

        if (result.error) {
          snowData[pathName] = "[bridge error] " + result.error;
          continue;
        }

        const extracted = result.extracted || result.text || (typeof result.body === "string" ? result.body : JSON.stringify(result.body || {}));
        if (extracted && String(extracted).length > 10) {
          snowData[pathName] = String(extracted).slice(0, 3000);
          liveFetchCount++;
        } else {
          snowData[pathName] = "Empty response from " + pathName + " (bridge returned no content)";
        }
      } catch (e: any) {
        snowData[pathName] = "[fetch error] " + (e.message || "unknown").slice(0, 200);
      }
    }
  }

  const shiftStart = new Date();
  shiftStart.setHours(shiftStart.getHours() - 14);
  const overnightCutoff = shiftStart.toISOString();

  let allResults: any[] = [];
  try { const r = await fetch(BASE + "/api/results?limit=50", { headers: hdrs }); if (r.ok) allResults = await r.json(); } catch {}
  const overnightActivity = allResults
    .filter((r: any) => {
      const name = (r.programName || "").toLowerCase();
      const isSnow = name.includes("snow") || name.includes("servicenow") || name.includes("incident") || name.includes("change") || NAV_PATH_NAMES.some(n => name.includes(n));
      const isRecent = new Date(r.createdAt || 0).getTime() > shiftStart.getTime();
      return isSnow && isRecent;
    })
    .map((r: any) => "- " + (r.summary || "").slice(0, 200))
    .join(NL)
    .slice(0, 1500);

  const sowHomeData = snowData["sow-home"] || "";
  const dataSection = sowHomeData
    ? "SERVICENOW DASHBOARD (scraped from SOW homepage):" + NL + sowHomeData.slice(0, 6000)
    : "MY OPEN INCIDENTS (from list-my-incidents):" + NL + (snowData["list-my-incidents"] || "No data").slice(0, 3000) + NL + NL +
      "MY CHANGE REQUESTS (from list-my-changes):" + NL + (snowData["list-my-changes"] || "No data").slice(0, 2000) + NL + NL +
      "MY REQUEST ITEMS (from list-my-requests):" + NL + (snowData["list-my-requests"] || "No data").slice(0, 2000) + NL + NL +
      "GROUP QUEUE (from list-group-queue):" + NL + (snowData["list-group-queue"] || "No data").slice(0, 2000);
  const prompt = "You are a ServiceNow shift briefing writer for an IT operations engineer. Synthesize the following SNOW data into a concise shift brief." + NL + NL +
    dataSection + NL + NL +
    "OVERNIGHT ACTIVITY (items updated since " + overnightCutoff + "):" + NL + (overnightActivity || "No overnight activity detected") + NL + NL +
    "Write in Markdown with EXACTLY these section headers:" + NL +
    "## SLA Risk" + NL + "Items approaching SLA breach, sorted by urgency. Include ticket numbers, short descriptions, and time remaining if apparent. If none at risk, state that clearly." + NL + NL +
    "## Overnight Activity" + NL + "Tickets updated since last shift (~14 hours ago). New assignments, state changes, comments added overnight. 3-5 bullets max." + NL + NL +
    "## Today's Actions" + NL + "Changes scheduled for today, approvals pending, items needing immediate attention. Prioritized list, 3-7 items." + NL + NL +
    "Be concise and specific. Use ticket numbers. Skip sections if no data is available (say 'No data available').";

  const llmResult = await callCheapLLM(prompt);
  const briefingText = llmResult.ok ? llmResult.text : "## SNOW Shift Brief" + NL + NL + "[LLM unavailable]" + NL + NL + "## Raw Data" + NL + Object.entries(snowData).map(([k, v]) => k + ": " + v.slice(0, 300)).join(NL);

  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10);
  const htmlFilename = "snow-" + dateStamp + ".html";
  const { htmlUrl, notifyStatus } = await saveBriefingAndNotify(briefingText, htmlFilename, "SNOW Shift Brief - " + dateStamp, "SNOW Shift Brief", dateStamp, "snow-shift-brief", "SNOW,briefcase", BASE, hdrs);

  const sourceLabel = sowSuccess ? "SOW homepage" : "classic nav paths (" + liveFetchCount + "/" + NAV_PATH_NAMES.length + ")";
  return { summary: "=== SNOW SHIFT BRIEF ===" + NL + "Generated: " + now.toISOString() + NL + "HTML: " + htmlUrl + NL + "Notify: " + notifyStatus + NL + "Source: " + sourceLabel + NL + NL + briefingText, metric: String(liveFetchCount) };
}`,
      codeLang: "typescript",
    },
    {
      name: "meeting-prep",
      type: "meta",
      schedule: "every 15 min",
      cronExpression: "*/15 * * * *",
      instructions: "Meeting prep brief. Checks for upcoming meetings in 30-45 min window using Outlook calendar data from the open-inbox navigation path. Gathers context from transcripts and SNOW tickets, generates a prep brief. Deduplicates so each meeting gets one brief per day.",
      config: { TASK_TYPE: "reasoning", LLM_REQUIRED: "false", OUTPUT_TYPE: "proposal", METRIC: "meetings_prepped", DIRECTION: "higher", TIMEOUT: "180" },
      costTier: "cheap",
      tags: ["program", "meta", "meeting", "prep"],
      code: `const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
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

  const isoDateTimeRe = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/g;
  let isoMatch;
  while ((isoMatch = isoDateTimeRe.exec(calendarText)) !== null) {
    const startTime = new Date(isoMatch[1]);
    if (isNaN(startTime.getTime())) continue;
    const startMs = startTime.getTime();
    if (startMs < windowStartMs || startMs > windowEndMs) continue;

    const contextStart = Math.max(0, isoMatch.index - 200);
    const contextEnd = Math.min(calendarText.length, isoMatch.index + 200);
    const context = calendarText.substring(contextStart, contextEnd);
    const subjectMatch = context.match(/(?:subject|title|event)[:\\s]*([^\\n]{3,100})/i);
    const subject = subjectMatch ? subjectMatch[1].trim() : context.replace(/[\\n\\r]+/g, " ").trim().slice(0, 100);
    if (subject.length < 3) continue;
    const key = subject.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 50) + "-" + startTime.toISOString().slice(0, 16).replace(/[^0-9]/g, "");
    const timeStr = startTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    parsedEvents.push({ subject, startTime, timeStr, key });
  }

  if (parsedEvents.length === 0) {
    const lines = calendarText.split(NL);
    for (const line of lines) {
      const timeMatch = line.match(/(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))/);
      if (!timeMatch) continue;

      const timeStr = timeMatch[1].trim();
      const timeParts = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)/i);
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

      const subject = line.replace(timeMatch[0], "").replace(/^[-*\\s]+/, "").trim().slice(0, 120);
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
    const keywords = event.subject.toLowerCase().split(/\\s+/).filter(w => w.length > 3);

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
}`,
      codeLang: "typescript",
    },
    {
      name: "weekly-strategy",
      type: "meta",
      schedule: "weekly",
      cronExpression: "0 2 * * 0",
      instructions: "Weekly strategy digest. Aggregates the full week's daily digests, goal progress, developing threads, and agent proposals. Uses premium model (Claude) for strategic synthesis. Runs Sunday 7 PM PT.",
      config: { TASK_TYPE: "reasoning", LLM_REQUIRED: "false", OUTPUT_TYPE: "proposal", METRIC: "insights_generated", DIRECTION: "higher", TIMEOUT: "300" },
      costTier: "premium",
      tags: ["program", "meta", "digest", "weekly", "strategy"],
      code: `const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
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
}`,
      codeLang: "typescript",
    },
  ];

  if (isFirstRun) {
    for (const raw of programSeedInputs) {
      try {
        const p = insertProgramSchema.parse(raw);
        await storage.createProgram(p);
      } catch (e) {
        console.error(`[seed] Failed to create program ${raw.name}:`, e);
      }
    }
  } else {
    const existingNames = new Set(existingPrograms.map(p => p.name));
    let reconciled = 0;
    for (const raw of programSeedInputs) {
      if (existingNames.has(raw.name)) continue;
      try {
        const p = insertProgramSchema.parse(raw);
        await storage.createProgram(p);
        reconciled++;
        console.log(`[seed] Reconciled missing program: ${raw.name}`);
      } catch (e) {
        console.error(`[seed] Failed to reconcile program ${raw.name}:`, e);
      }
    }
    if (reconciled > 0) {
      console.log(`[seed] Reconciled ${reconciled} missing programs into existing database`);
    }
  }

  const skillSeedInputs = [
    {
      name: "orgcloud-sync",
      description: "Sync config with OrgCloud and propose self-modifications",
      type: "skill",
      content: "Handles uploading, downloading, and proposing changes between the local OpenClaw instance and the OrgCloud control plane.",
    },
    {
      name: "composable-programs",
      description: "Design philosophy for building chainable, composable automation programs",
      type: "skill",
      content: "Programs fall into five composable types: MONITORS, FILTERS, TRANSFORMS, ACTORS, META. Use TRIGGERS property to declare chaining. Prefer hardenable pure-code programs.",
    },
  ];

  if (isFirstRun) {
    for (const raw of skillSeedInputs) {
      try {
        const s = insertSkillSchema.parse(raw);
        await storage.createSkill(s);
      } catch (e) {
        console.error(`[seed] Failed to create skill ${raw.name}:`, e);
      }
    }

    const configSeeds = [
      { key: "soul", value: "Be genuinely helpful, not performatively helpful. Have opinions. Be resourceful before asking. Earn trust through competence.", category: "soul" },
      { key: "default_model", value: "openrouter/deepseek/deepseek-chat", category: "agents" },
      { key: "max_concurrent", value: "5", category: "agents" },
      { key: "user_timezone", value: "America/Los_Angeles", category: "user" },
      { key: "user_preferences", value: "CRT aesthetic, Doom Emacs-inspired UI, autonomous agents, org-mode workflows", category: "user" },
      { key: "persistent_context", value: "Craigslist regions are subdomains. HN API is free. Core models: DeepSeek V3 (cheap default), Qwen 2.5 72B (cheap backup), DeepSeek R1 (standard reasoning), Claude 3.5 Sonnet (standard), Claude Sonnet 4 (premium).", category: "memory" },
      { key: "user_goals", value: JSON.stringify([
        { name: "OpenClaw & agentic AI", keywords: ["openclaw", "agentic", "agent", "autonomous", "llm", "claude", "gpt", "openai", "anthropic", "langchain", "autogpt", "crew", "swarm", "tool-use", "function-calling", "mcp"], priority: 1 },
        { name: "Autonomous agent architecture", keywords: ["agent-runtime", "planning", "memory", "tool-use", "reasoning", "self-improvement", "feedback-loop", "orchestration", "multi-agent", "reflection"], priority: 1 },
        { name: "Epic Hyperspace agent", keywords: ["epic", "hyperspace", "ehr", "emr", "healthcare", "citrix", "selenium", "pyautogui", "vision", "screen-reading", "rpa", "automation"], priority: 2 },
        { name: "Personal finance & deals", keywords: ["finance", "budget", "deal", "sale", "discount", "investment", "savings", "frugal", "craigslist", "estate-sale", "foreclosure", "fed-rate", "interest-rate"], priority: 3 },
        { name: "Meal planning & nutrition", keywords: ["meal", "recipe", "nutrition", "cooking", "food", "diet", "grocery", "pantry", "kiddo", "toddler-food"], priority: 3 },
      ]), category: "goals" },
      { key: "notify_channel", value: process.env.NTFY_CHANNEL || "orgcloud-standup", category: "notifications" },
      { key: "notify_email", value: process.env.NOTIFY_EMAIL || "", category: "notifications" },
    ];

    for (const c of configSeeds) {
      try {
        await storage.setAgentConfig(c.key, c.value, c.category);
      } catch (e) {
        console.error(`[seed] Failed to set config ${c.key}:`, e);
      }
    }

    console.log(`[seed] Seeded ${programSeedInputs.length} programs, ${skillSeedInputs.length} skills, ${configSeeds.length} config entries`);
  }
}

async function seedSiteProfiles(): Promise<void> {
  const siteProfileSeeds = [
    {
      name: "outlook",
      description: "Microsoft Outlook Web — email inbox scraping",
      baseUrl: "https://outlook.cloud.microsoft/mail/inbox",
      urlPatterns: ["outlook\\.office\\.com", "outlook\\.live\\.com", "outlook\\.office365\\.com", "outlook\\.cloud\\.microsoft"],
      extractionSelectors: {
        messageList: '[aria-label*="Message list"], [data-convid]',
        readingPane: '[data-app-section="ReadingPane"]',
        subject: '[role="heading"]',
        sender: '[title]',
      },
      actions: {
        reply: { selector: 'button[aria-label*="Reply"]', type: "click", description: "Reply to current email" },
        send: { selector: 'button[aria-label*="Send"]', type: "click", description: "Send composed email" },
      },
      enabled: true,
    },
    {
      name: "teams",
      description: "Microsoft Teams — chat scraping",
      baseUrl: "https://teams.microsoft.com/_#/conversations",
      urlPatterns: ["teams\\.microsoft\\.com", "teams\\.live\\.com", "teams\\.cloud\\.microsoft"],
      extractionSelectors: {
        chatList: '[data-tid="chat-list-item"], [data-tid="left-rail-chat-list"]',
        messagePane: '[data-tid="message-pane-list"]',
        chatTitle: '[data-tid="chat-item-title"]',
        chatMessage: '[data-tid="chat-item-message"]',
      },
      actions: {
        sendMessage: { selector: '[data-tid="ckeditor"] [contenteditable="true"]', type: "type", description: "Type and send a message" },
        openChat: { selector: '[data-tid="app-bar-chat-button"]', type: "click", description: "Navigate to Chat tab" },
      },
      enabled: true,
    },
    {
      name: "servicenow",
      description: "ServiceNow — incident, change, and request management via DOM scraping (SOW + Classic UI)",
      baseUrl: "",
      urlPatterns: [".*\\.service-now\\.com"],
      extractionSelectors: {
        listRows: 'tr.list_row, tr[data-type="list_row"], table.list_table tbody tr',
        listHeaders: 'th.list_header_cell, th[data-type="list_header_cell"]',
        formFields: '.form-group, .label_spacing, td.label',
        recordNumber: 'input[id="sys_display.x_number"], span.breadcrumb_element, .output_span[id*="number"]',
        shortDescription: 'input[id*="short_description"], textarea[id*="short_description"]',
        state: 'select[id*="state"], .output_span[id*="state"]',
        priority: 'select[id*="priority"], .output_span[id*="priority"]',
        assignedTo: 'input[id*="assigned_to"], .output_span[id*="assigned_to"]',
        assignmentGroup: 'input[id*="assignment_group"], .output_span[id*="assignment_group"]',
      },
      actions: {
        openRecord: { selector: 'tr.list_row td a, tr[data-type="list_row"] td a', type: "click", description: "Open a record from list view" },
        backToList: { selector: 'button[id="back_button"], a.breadcrumb_element', type: "click", description: "Navigate back to list view" },
      },
      enabled: true,
    },
    {
      name: "any-website",
      description: "Generic website — best-effort content extraction using page content API",
      baseUrl: "",
      urlPatterns: ["https?://.*"],
      extractionSelectors: {
        title: "title",
        body: "body",
        main: "main, article, [role='main']",
        headings: "h1, h2, h3",
      },
      actions: {},
      enabled: true,
    },
    {
      name: "walmart",
      description: "Walmart — grocery search and add-to-cart automation",
      baseUrl: "https://www.walmart.com",
      urlPatterns: ["walmart\\.com"],
      extractionSelectors: {
        searchResults: '[data-testid="list-view"]',
        productName: '[data-automation-id="product-title"]',
        productPrice: '[data-automation-id="product-price"] .f2',
        addToCartButton: '[data-tl-id="ProductTileAddToCartBtn"]',
        productImage: 'img[data-testid="productTileImage"]',
      },
      actions: {
        search: { selector: 'input[aria-label="Search"]', type: "type", description: "Type product search query" },
        addToCart: { selector: '[data-tl-id="ProductTileAddToCartBtn"]', type: "click", description: "Add product to cart" },
      },
      enabled: true,
    },
    {
      name: "costco",
      description: "Costco — grocery search and add-to-cart automation",
      baseUrl: "https://www.costco.com",
      urlPatterns: ["costco\\.com"],
      extractionSelectors: {
        searchResults: ".product-list",
        productName: ".description a",
        productPrice: ".price",
        addToCartButton: "#add-to-cart-btn",
        productImage: ".product-img-holder img",
      },
      actions: {
        search: { selector: '#search-field', type: "type", description: "Type product search query" },
        addToCart: { selector: '#add-to-cart-btn', type: "click", description: "Add product to cart" },
      },
      enabled: true,
    },
  ];

  let seededCount = 0;
  for (const raw of siteProfileSeeds) {
    try {
      const existing = await storage.getSiteProfileByName(raw.name);
      if (existing) continue;
      const p = insertSiteProfileSchema.parse(raw);
      await storage.createSiteProfile(p);
      seededCount++;
    } catch (e) {
      console.error(`[seed] Failed to create site profile ${raw.name}:`, e);
    }
  }

  const allProfiles = await storage.getSiteProfiles();
  const profileMap = new Map(allProfiles.map(p => [p.name, p.id]));

  const navPathSeeds = [
    {
      name: "open-inbox",
      description: "Navigate to Outlook inbox, scroll to load more, and extract message list",
      siteProfileId: profileMap.get("outlook")!,
      steps: [
        { action: "navigate" as const, target: "https://outlook.cloud.microsoft/mail/inbox", description: "Open Outlook inbox" },
        { action: "wait" as const, waitMs: 3000, description: "Wait for inbox message list to load" },
        { action: "scroll" as const, target: '[aria-label*="Message list"], [role="listbox"]', description: "Scroll inbox to load more messages" },
        { action: "wait" as const, waitMs: 1500, description: "Wait after scroll for additional messages" },
        { action: "extract" as const, description: "Extract message summaries (from, subject, preview, date)" },
      ],
      extractionRules: {
        messageItems: '[data-convid], [role="listbox"] [role="option"]',
        subject: '[role="heading"]',
        sender: '[title]',
        preview: '[aria-label*="Message list"] span',
      },
    },
    {
      name: "read-email",
      description: "Click an email to open it in the reading pane and extract full content (from/to/subject/body/date)",
      siteProfileId: profileMap.get("outlook")!,
      steps: [
        { action: "click" as const, target: '[data-convid], [role="listbox"] [role="option"]', description: "Click first email in list" },
        { action: "wait" as const, waitMs: 2000, description: "Wait for reading pane to render" },
        { action: "extract" as const, description: "Extract email detail: from, to, subject, body, date" },
      ],
      extractionRules: {
        readingPane: '[data-app-section="ReadingPane"], .ReadingPaneContainerClass, [aria-label*="Reading"], [role="complementary"]',
        subject: '[role="heading"]',
        sender: '[title]',
        body: '[data-app-section="ReadingPane"] div, article, [data-app-section="ConversationContainer"]',
      },
    },
    {
      name: "open-chat-list",
      description: "Navigate to Teams chat view, wait for chat list, and extract conversation summaries",
      siteProfileId: profileMap.get("teams")!,
      steps: [
        { action: "navigate" as const, target: "https://teams.microsoft.com/_#/conversations", description: "Open Teams chat view" },
        { action: "wait" as const, waitMs: 3000, description: "Wait for chat list to load" },
        { action: "scroll" as const, target: '[data-tid="left-rail-chat-list"], [data-tid="chat-list"]', description: "Scroll to load more chats" },
        { action: "wait" as const, waitMs: 1000, description: "Wait after scroll" },
        { action: "extract" as const, description: "Extract chat list (title, last message, timestamp)" },
      ],
      extractionRules: {
        chatItems: '[data-tid="chat-list-item"]',
        chatTitle: '[data-tid="chat-item-title"]',
        lastMessage: '[data-tid="chat-item-message"]',
        timestamp: '[data-tid="chat-item-timestamp"]',
      },
    },
    {
      name: "read-chat",
      description: "Click a chat conversation and extract the message thread (sender, text, time per message)",
      siteProfileId: profileMap.get("teams")!,
      steps: [
        { action: "click" as const, target: '[data-tid="chat-list-item"]', description: "Click first chat conversation" },
        { action: "wait" as const, waitMs: 2000, description: "Wait for message thread to load" },
        { action: "scroll" as const, target: '[data-tid="message-pane-list"]', description: "Scroll up to load older messages" },
        { action: "wait" as const, waitMs: 1000, description: "Wait after scroll" },
        { action: "extract" as const, description: "Extract messages: sender, body, timestamp" },
      ],
      extractionRules: {
        messagePane: '[data-tid="message-pane-list"]',
        messages: '[data-tid="chat-pane-message"]',
        sender: '[data-tid="message-author-name"]',
        body: '[data-tid="message-body"]',
        timestamp: '[data-tid="message-timestamp"]',
      },
    },
    {
      name: "list-my-incidents",
      description: "Navigate to ServiceNow and list incidents assigned to the current user",
      siteProfileId: profileMap.get("servicenow")!,
      steps: [
        { action: "navigate" as const, target: "{baseUrl}/nav_to.do?uri=incident_list.do?sysparm_query=assigned_to=javascript:gs.getUserID()^active=true^ORDERBYDESCsys_updated_on", description: "Open my incidents list" },
        { action: "wait" as const, waitMs: 4000, description: "Wait for list to render" },
        { action: "scroll" as const, target: "table.list_table, .list2_body", description: "Scroll list to load more rows" },
        { action: "wait" as const, waitMs: 1500, description: "Wait after scroll" },
        { action: "extract" as const, description: "Extract incident list data" },
      ],
      extractionRules: {
        rows: 'tr.list_row, tr[data-type="list_row"]',
        number: 'td[class*="number"] a',
        shortDescription: 'td[class*="short_description"]',
        state: 'td[class*="state"]',
        priority: 'td[class*="priority"]',
      },
    },
    {
      name: "list-my-changes",
      description: "Navigate to ServiceNow and list change requests assigned to the current user",
      siteProfileId: profileMap.get("servicenow")!,
      steps: [
        { action: "navigate" as const, target: "{baseUrl}/nav_to.do?uri=change_request_list.do?sysparm_query=assigned_to=javascript:gs.getUserID()^active=true^ORDERBYDESCsys_updated_on", description: "Open my change requests" },
        { action: "wait" as const, waitMs: 4000, description: "Wait for list to render" },
        { action: "scroll" as const, target: "table.list_table, .list2_body", description: "Scroll list" },
        { action: "wait" as const, waitMs: 1500, description: "Wait after scroll" },
        { action: "extract" as const, description: "Extract change request list data" },
      ],
      extractionRules: {
        rows: 'tr.list_row, tr[data-type="list_row"]',
        number: 'td[class*="number"] a',
        shortDescription: 'td[class*="short_description"]',
        state: 'td[class*="state"]',
        priority: 'td[class*="priority"]',
      },
    },
    {
      name: "list-my-requests",
      description: "Navigate to ServiceNow and list service catalog request items assigned to the current user",
      siteProfileId: profileMap.get("servicenow")!,
      steps: [
        { action: "navigate" as const, target: "{baseUrl}/nav_to.do?uri=sc_req_item_list.do?sysparm_query=assigned_to=javascript:gs.getUserID()^active=true^ORDERBYDESCsys_updated_on", description: "Open my request items" },
        { action: "wait" as const, waitMs: 4000, description: "Wait for list to render" },
        { action: "scroll" as const, target: "table.list_table, .list2_body", description: "Scroll list" },
        { action: "wait" as const, waitMs: 1500, description: "Wait after scroll" },
        { action: "extract" as const, description: "Extract request item list data" },
      ],
      extractionRules: {
        rows: 'tr.list_row, tr[data-type="list_row"]',
        number: 'td[class*="number"] a',
        shortDescription: 'td[class*="short_description"]',
        state: 'td[class*="state"]',
      },
    },
    {
      name: "view-record-detail",
      description: "Open a specific ServiceNow record by number and extract its details",
      siteProfileId: profileMap.get("servicenow")!,
      steps: [
        { action: "wait" as const, waitMs: 3000, description: "Wait for form to render" },
        { action: "extract" as const, description: "Extract record detail fields" },
      ],
      extractionRules: {
        formFields: '.form-group, .label_spacing',
        number: 'input[id*="number"], .output_span[id*="number"]',
        shortDescription: 'input[id*="short_description"], textarea[id*="short_description"]',
        state: 'select[id*="state"], .output_span[id*="state"]',
        priority: 'select[id*="priority"], .output_span[id*="priority"]',
        assignedTo: 'input[id*="assigned_to"], .output_span[id*="assigned_to"]',
        assignmentGroup: 'input[id*="assignment_group"], .output_span[id*="assignment_group"]',
        description: 'textarea[id*="description"], .output_span[id*="description"]',
      },
    },
    {
      name: "list-group-queue",
      description: "List all active items in the user's assignment group queue",
      siteProfileId: profileMap.get("servicenow")!,
      steps: [
        { action: "navigate" as const, target: "{baseUrl}/nav_to.do?uri=incident_list.do?sysparm_query=assignment_group!=NULL^active=true^ORDERBYDESCsys_updated_on", description: "Open group queue" },
        { action: "wait" as const, waitMs: 4000, description: "Wait for list to render" },
        { action: "scroll" as const, target: "table.list_table, .list2_body", description: "Scroll list" },
        { action: "wait" as const, waitMs: 1500, description: "Wait after scroll" },
        { action: "extract" as const, description: "Extract group queue data" },
      ],
      extractionRules: {
        rows: 'tr.list_row, tr[data-type="list_row"]',
        number: 'td[class*="number"] a',
        shortDescription: 'td[class*="short_description"]',
        state: 'td[class*="state"]',
        assignedTo: 'td[class*="assigned_to"]',
        assignmentGroup: 'td[class*="assignment_group"]',
      },
    },
    {
      name: "scrape-sow-home",
      description: "Scrape the ServiceNow Service Operations Workspace (SOW) homepage dashboard to extract all visible tickets (incidents, changes, requests)",
      siteProfileId: profileMap.get("servicenow")!,
      steps: [
        { action: "navigate" as const, target: "{baseUrl}/now/sow/home", description: "Open SOW homepage dashboard" },
        { action: "wait" as const, waitMs: 6000, description: "Wait for SPA dashboard widgets to render" },
        { action: "scroll" as const, target: "", description: "Scroll page to trigger lazy-loaded widgets" },
        { action: "wait" as const, waitMs: 3000, description: "Wait for additional widgets to load" },
        { action: "scroll" as const, target: "", description: "Scroll again to load remaining content" },
        { action: "wait" as const, waitMs: 2000, description: "Final wait for all content" },
        { action: "extract" as const, description: "Extract all ticket data from dashboard" },
      ],
      extractionRules: {
        body: "body",
      },
    },
    {
      name: "best-effort-extract",
      description: "Open any URL and extract content using generic selectors (use with url parameter)",
      siteProfileId: profileMap.get("any-website")!,
      steps: [
        { action: "wait" as const, waitMs: 3000, description: "Wait for page to load" },
        { action: "extract" as const, description: "Extract all visible content" },
      ],
      extractionRules: { content: "body" },
    },
    {
      name: "walmart-search",
      description: "Search Walmart for a product and extract results",
      siteProfileId: profileMap.get("walmart")!,
      steps: [
        { action: "navigate" as const, target: "https://www.walmart.com/search?q={query}", description: "Open Walmart search" },
        { action: "wait" as const, waitMs: 4000, description: "Wait for search results to load" },
        { action: "scroll" as const, target: '[data-testid="list-view"]', description: "Scroll results" },
        { action: "extract" as const, description: "Extract product names, prices, and add-to-cart buttons" },
      ],
      extractionRules: {
        products: '[data-testid="list-view"] [data-item-id]',
        productName: '[data-automation-id="product-title"]',
        productPrice: '[data-automation-id="product-price"]',
      },
    },
    {
      name: "walmart-add-to-cart",
      description: "Add a specific Walmart product to cart",
      siteProfileId: profileMap.get("walmart")!,
      steps: [
        { action: "click" as const, target: '[data-tl-id="ProductTileAddToCartBtn"]', description: "Click Add to Cart button" },
        { action: "wait" as const, waitMs: 2000, description: "Wait for cart confirmation" },
        { action: "extract" as const, description: "Confirm item was added" },
      ],
      extractionRules: { confirmation: '[data-testid="cart-confirmation"]' },
      permissionLevel: "approval" as const,
    },
    {
      name: "costco-search",
      description: "Search Costco for a product and extract results",
      siteProfileId: profileMap.get("costco")!,
      steps: [
        { action: "navigate" as const, target: "https://www.costco.com/CatalogSearch?dept=All&keyword={query}", description: "Open Costco search" },
        { action: "wait" as const, waitMs: 4000, description: "Wait for search results to load" },
        { action: "scroll" as const, target: ".product-list", description: "Scroll results" },
        { action: "extract" as const, description: "Extract product names, prices" },
      ],
      extractionRules: {
        products: ".product-list .product",
        productName: ".description a",
        productPrice: ".price",
      },
    },
    {
      name: "costco-add-to-cart",
      description: "Add a specific Costco product to cart",
      siteProfileId: profileMap.get("costco")!,
      steps: [
        { action: "click" as const, target: "#add-to-cart-btn", description: "Click Add to Cart button" },
        { action: "wait" as const, waitMs: 2000, description: "Wait for cart confirmation" },
        { action: "extract" as const, description: "Confirm item was added" },
      ],
      extractionRules: { confirmation: ".added-to-cart-confirm" },
      permissionLevel: "approval" as const,
    },
  ];

  const existingPaths = new Set<string>();
  for (const profile of allProfiles) {
    const paths = await storage.getNavigationPaths(profile.id);
    for (const p of paths) existingPaths.add(`${p.siteProfileId}:${p.name}`);
  }

  let pathSeededCount = 0;
  for (const raw of navPathSeeds) {
    try {
      if (!raw.siteProfileId) continue;
      if (existingPaths.has(`${raw.siteProfileId}:${raw.name}`)) continue;
      const p = insertNavigationPathSchema.parse(raw);
      await storage.createNavigationPath(p);
      pathSeededCount++;
    } catch (e) {
      console.error(`[seed] Failed to create nav path ${raw.name}:`, e);
    }
  }

  if (seededCount > 0 || pathSeededCount > 0) {
    console.log(`[seed] Seeded ${seededCount} site profiles, ${pathSeededCount} navigation paths`);
  }
}
