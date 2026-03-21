import { storage } from "./storage";
import { insertProgramSchema, insertSkillSchema, insertSiteProfileSchema, insertNavigationPathSchema } from "@shared/schema";

export async function seedDatabase(): Promise<void> {
  await seedSiteProfiles();

  const existingPrograms = await storage.getPrograms();
  if (existingPrograms.length > 0) {
    console.log("[seed] Database already has programs, skipping seed");
    return;
  }

  console.log("[seed] Seeding database with programs, skills, config...");

  const programSeedInputs = [
    {
      name: "hn-pulse",
      type: "monitor",
      schedule: "every 12h",
      cronExpression: "0 7,19 * * *",
      instructions: "Monitor Hacker News for top stories. Uses free Firebase HN API.",
      config: { SCORE_THRESHOLD: "100", MAX_STORIES: "10", TASK_TYPE: "research", METRIC: "stories_found", DIRECTION: "higher" },
      costTier: "free",
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
      instructions: "Check model availability on OpenRouter. Tests free models, queries live pricing from /api/v1/models, auto-updates roster pricing, discovers new free models, and flags offline/expensive models.",
      config: { TASK_TYPE: "research", METRIC: "free_models_working", DIRECTION: "higher", LLM_REQUIRED: "false" },
      costTier: "free",
      tags: ["program", "budget"],
      code: `const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const ROSTER_MODELS = [
  "google/gemma-3-4b-it:free",
  "google/gemma-3-12b-it:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
  "meta-llama/llama-3.2-3b-instruct:free",
  "qwen/qwen3-4b:free",
  "deepseek/deepseek-chat",
  "deepseek/deepseek-reasoner",
];
const INTERESTING_PROVIDERS = ["google", "meta-llama", "mistralai", "qwen", "deepseek", "microsoft"];
const MAX_CHEAP_COST = 1.0;

async function execute() {
  const results: Array<{ model: string; status: string; latency: number }> = [];
  const rosterUpdates: Array<{ id: string; inputCostPer1M?: number; outputCostPer1M?: number; tier?: string; strengths?: string[]; label?: string; _remove?: boolean }> = [];
  const proposals: Array<{section: string; diff: string; reason: string}> = [];
  let discoveredFree = 0;

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
      const newFreeModels = allModels.filter((m: any) => {
        if (existingIds.has(m.id)) return false;
        const provider = (m.id || "").split("/")[0];
        if (!INTERESTING_PROVIDERS.includes(provider)) return false;
        const cost = parseFloat(m.pricing?.prompt || "1");
        return cost === 0 || m.id.endsWith(":free");
      });

      for (const m of newFreeModels.slice(0, 5)) {
        discoveredFree++;
        const label = m.name || m.id.split("/").pop();
        rosterUpdates.push({
          id: m.id,
          tier: "free",
          strengths: ["general"],
          label: label,
          inputCostPer1M: 0,
          outputCostPer1M: 0,
        });
        proposals.push({ section: "PROGRAMS", diff: "New free model discovered: " + m.id + " (" + label + "). Added to roster.", reason: "Free model auto-discovery" });
      }

      for (const modelId of ROSTER_MODELS) {
        const info = modelsMap.get(modelId);
        if (info?.pricing) {
          const inputCost = parseFloat(info.pricing.prompt || "0") * 1_000_000;
          if (inputCost > 20 && modelId.includes(":free")) {
            rosterUpdates.push({ id: modelId, _remove: true });
            proposals.push({ section: "PROGRAMS", diff: "Model " + modelId + " was free but now costs $" + inputCost.toFixed(2) + "/1M. Removed from roster.", reason: "Free model now paid: " + modelId });
          }
        }
      }
    }
  } catch {}

  const freeModels = ROSTER_MODELS.filter(m => m.includes(":free"));
  for (const model of freeModels) {
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
  if (discoveredFree > 0) notes.push("Discovered " + discoveredFree + " new free models");
  if (proposals.length > 0) notes.push(proposals.length + " proposals");
  const noteStr = notes.length > 0 ? " | " + notes.join(", ") : "";
  const summary = results.map(r => (r.status === "OK" ? "[+]" : "[-]") + " " + r.model.split("/").pop() + " " + r.status + " (" + r.latency + "ms)").join("\\n");
  return { summary: "Model Scout: " + working.length + "/" + results.length + " free models working" + noteStr + "\\n" + summary, metric: String(working.length), proposals };
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
const MODELS = ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4-20250514", "google/gemma-3-12b-it:free"];

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
      schedule: "daily",
      cronExpression: "0 9 * * *",
      instructions: "Scrape GitHub trending page for repos in specified languages.",
      config: { LANGUAGES: "typescript,rust,python,go", SINCE: "daily", TASK_TYPE: "research", METRIC: "repos_found", DIRECTION: "higher", LLM_REQUIRED: "false" },
      costTier: "free",
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
      instructions: "Nightly SoCal Craigslist estate/low-mileage car scanner.",
      config: { REGIONS: "inlandempire,losangeles,orangecounty,sandiego", MIN_PRICE: "2000", MAX_PRICE: "25000", TOP_N: "8", TASK_TYPE: "research", METRIC: "deals_found", DIRECTION: "higher", TIMEOUT: "300" },
      costTier: "standard",
      tags: ["program"],
      code: null,
    },
    {
      name: "fed-rates",
      type: "monitor",
      schedule: "daily",
      cronExpression: "0 6 * * *",
      instructions: "Fetch latest values for key FRED economic series.",
      config: { SERIES_IDS: "DGS10,DGS2,T10Y2Y,FEDFUNDS,UNRATE", TASK_TYPE: "research", METRIC: "data_points", DIRECTION: "higher", LLM_REQUIRED: "false" },
      costTier: "free",
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
      schedule: "every 6h",
      cronExpression: "0 */6 * * *",
      instructions: "Scrape Craigslist free section for items matching keywords.",
      config: { CL_REGION: "inlandempire", KEYWORDS: "furniture,electronics,tools,appliance,computer,monitor,desk", TASK_TYPE: "research", METRIC: "items_found", DIRECTION: "higher" },
      costTier: "free",
      tags: ["program"],
      code: null,
    },
    {
      name: "sec-filings",
      type: "monitor",
      schedule: "daily",
      cronExpression: "0 9 * * *",
      instructions: "Search SEC EDGAR for recent filings from specific companies.",
      config: { TICKER_LIST: "AAPL,TSLA,NVDA,MSFT,GOOG", FILING_TYPES: "10-K,10-Q,8-K", TASK_TYPE: "research", METRIC: "filings_found", DIRECTION: "higher", LLM_REQUIRED: "false" },
      costTier: "free",
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
      instructions: "Monitor Craigslist listings matching search query under max price.",
      config: { SEARCH_QUERY: "car,truck,suv", CL_REGION: "inlandempire", MAX_PRICE: "5000", TASK_TYPE: "research", METRIC: "price_changes", DIRECTION: "higher" },
      costTier: "free",
      tags: ["program"],
      code: null,
    },
    {
      name: "foreclosure-monitor",
      type: "monitor",
      schedule: "daily",
      cronExpression: "0 8 * * *",
      instructions: "Scrape HUD homes for foreclosures and government property listings near ZIP code.",
      config: { STATE: "CA", ZIP_CODE: "92373", TASK_TYPE: "research", METRIC: "listings_found", DIRECTION: "higher" },
      costTier: "free",
      tags: ["program"],
      code: null,
    },
    {
      name: "mandela-berenstain",
      type: "monitor",
      schedule: "daily",
      cronExpression: "0 22 * * *",
      instructions: "Mandela Effect research — comb Internet Archive TV Guide scans for Berenstain Bears spelling variants.",
      config: { START_YEAR: "1985", END_YEAR: "2003", CONCURRENCY: "5", TASK_TYPE: "research", METRIC: "total_mentions", DIRECTION: "higher", OUTPUT_TYPE: "proposal", TIMEOUT: "600" },
      costTier: "standard",
      tags: ["program"],
      code: null,
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
      costTier: "free",
      tags: ["program", "budget", "meta"],
      code: `async function execute() {
  const port = process.env.__BRIDGE_PORT || process.env.PORT || "5000";
  const BASE = "http://localhost:" + port;

  let budgetData = { used: 0, budget: 500000, remaining: 500000, percentUsed: 0, estimatedCostToday: 0, report: { byProgram: {}, byModel: {} } };
  let modelsData = [];
  let recentResults = [];
  let memoriesData: any[] = [];
  try { const r = await fetch(BASE + "/api/budget"); if (r.ok) budgetData = await r.json(); } catch {}
  try { const r = await fetch(BASE + "/api/models"); if (r.ok) modelsData = await r.json(); } catch {}
  try { const r = await fetch(BASE + "/api/results?limit=50"); if (r.ok) recentResults = await r.json(); } catch {}
  try { const r = await fetch(BASE + "/api/memories?limit=30"); if (r.ok) memoriesData = await r.json(); } catch {}

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
  ];

  for (const raw of programSeedInputs) {
    try {
      const p = insertProgramSchema.parse(raw);
      await storage.createProgram(p);
    } catch (e) {
      console.error(`[seed] Failed to create program ${raw.name}:`, e);
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
    { key: "default_model", value: "openrouter/google/gemma-3-4b-it:free", category: "agents" },
    { key: "max_concurrent", value: "5", category: "agents" },
    { key: "user_timezone", value: "America/Los_Angeles", category: "user" },
    { key: "user_preferences", value: "CRT aesthetic, Doom Emacs-inspired UI, autonomous agents, org-mode workflows", category: "user" },
    { key: "persistent_context", value: "Craigslist regions are subdomains. HN API is free. Working free OpenRouter models: gemma-3-4b-it:free, mistral-small-3.1-24b-instruct:free, qwen3-4b:free, llama-3.2-3b-instruct:free, gemma-3-12b-it:free.", category: "memory" },
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
      description: "ServiceNow — incident, change, and request management via DOM scraping",
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
