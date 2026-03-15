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
      instructions: "Check free model availability on OpenRouter. Tests each model with a simple prompt.",
      config: { TASK_TYPE: "research", METRIC: "free_models_working", DIRECTION: "higher" },
      costTier: "free",
      tags: ["program"],
      code: `const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const FREE_MODELS = [
  "google/gemma-3-4b-it:free",
  "google/gemma-3-12b-it:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
  "meta-llama/llama-3.2-3b-instruct:free",
  "qwen/qwen3-4b:free",
];

async function execute() {
  const results: Array<{ model: string; status: string; latency: number }> = [];
  for (const model of FREE_MODELS) {
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
  const working = results.filter(r => r.status === "OK");
  const summary = results.map(r => (r.status === "OK" ? "[+]" : "[-]") + " " + r.model.split("/").pop() + " " + r.status + " (" + r.latency + "ms)").join("\\n");
  return { summary: "Model Scout: " + working.length + "/" + results.length + " free models working\\n" + summary, metric: String(working.length) };
}`,
      codeLang: "typescript",
    },
    {
      name: "research-radar",
      type: "meta",
      schedule: "daily",
      cronExpression: "30 23 * * *",
      instructions: "Unified research radar — aggregates HN, GitHub trending, Lobsters, Lemmy (c/machinelearning), ArXiv CS.AI, and synthesizes via LLM into: (a) what's new and important, (b) concrete experiments to try, (c) how people are exploiting/jailbreaking LLMs, (d) improvement proposals for the system itself. Output is both a readable briefing and structured proposals.",
      config: { TASK_TYPE: "research", COST_TIER: "premium", METRIC: "proposals_made", DIRECTION: "higher", OUTPUT_TYPE: "proposal", TIMEOUT: "300" },
      costTier: "premium",
      tags: ["program", "meta"],
      code: `const NL = String.fromCharCode(10);
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const MODEL = "anthropic/claude-sonnet-4";

async function callLLM(prompt: string): Promise<string> {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + OPENROUTER_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 2000, temperature: 0.7 }),
    });
    const d = await r.json();
    const text = d.choices?.[0]?.message?.content?.trim();
    if (text) return text;
  } catch {}
  return "[model unavailable]";
}

async function fetchHN(): Promise<string> {
  const topIds = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json").then(r => r.json());
  const stories: string[] = [];
  for (const id of topIds.slice(0, 20)) {
    const s = await fetch("https://hacker-news.firebaseio.com/v0/item/" + id + ".json").then(r => r.json());
    if (s && s.score >= 50) stories.push(s.title + " (" + s.score + " pts)");
    if (stories.length >= 10) break;
  }
  return "HN Top:" + NL + stories.join(NL);
}

async function fetchGitHub(): Promise<string> {
  const langs = ["typescript", "python", "rust"];
  const repos: string[] = [];
  for (const lang of langs) {
    try {
      const r = await fetch("https://github.com/trending/" + lang + "?since=daily", {
        headers: { "User-Agent": "OrgCloud/1.0", "Accept": "text/html" }
      });
      const html = await r.text();
      const re = /class="Box-row"[\\s\\S]*?href="\\/([^"]+)"/g;
      let m;
      while ((m = re.exec(html)) !== null && repos.length < 5) {
        repos.push("[" + lang + "] " + m[1].replace(/\\/\\s/g, "/"));
      }
    } catch {}
  }
  return "GitHub Trending:" + NL + repos.join(NL);
}

async function fetchLobsters(): Promise<string> {
  try {
    const r = await fetch("https://lobste.rs/hottest.json", { signal: AbortSignal.timeout(10000) });
    const d = await r.json();
    const items = d.slice(0, 10)
      .filter((p: any) => p.score >= 5)
      .map((p: any) => p.title + " (" + p.score + " pts, " + (p.tags || []).join(",") + ")");
    return "Lobsters Hot:" + NL + items.join(NL);
  } catch { return "Lobsters: [fetch failed]"; }
}

async function fetchLemmy(community: string): Promise<string> {
  try {
    const r = await fetch("https://lemmy.world/api/v3/post/list?sort=Hot&limit=10&community_name=" + community, {
      signal: AbortSignal.timeout(10000)
    });
    const d = await r.json();
    const posts = (d.posts || [])
      .filter((p: any) => p.counts.score >= 3)
      .slice(0, 5)
      .map((p: any) => p.post.name + " (" + p.counts.score + " pts)");
    return "Lemmy c/" + community + ":" + NL + (posts.length ? posts.join(NL) : "[no recent hot posts]");
  } catch { return "Lemmy c/" + community + ": [fetch failed]"; }
}

async function fetchArxiv(): Promise<string> {
  try {
    const r = await fetch("https://rss.arxiv.org/rss/cs.AI", { signal: AbortSignal.timeout(10000) });
    const xml = await r.text();
    const titles: string[] = [];
    const re = /<item>[\\s\\S]*?<title>([^<]+)<\\/title>/g;
    let m;
    while ((m = re.exec(xml)) !== null && titles.length < 8) {
      const t = m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      if (!t.includes("updates on arXiv")) titles.push(t.trim());
    }
    return "ArXiv CS.AI (recent):" + NL + titles.join(NL);
  } catch { return "ArXiv: [fetch failed]"; }
}

async function execute() {
  const [hn, gh, lobsters, lemmyML, lemmyAI, arxiv] = await Promise.all([
    fetchHN(), fetchGitHub(), fetchLobsters(),
    fetchLemmy("machinelearning"), fetchLemmy("artificial_intelligence"),
    fetchArxiv(),
  ]);
  const communityAll = [lobsters, lemmyML, lemmyAI].join(NL + NL);
  const briefing = await callLLM(
    "You are a research radar for an AI/LLM-focused developer. Synthesize these sources into a briefing:" + NL + NL +
    hn + NL + NL + gh + NL + NL + communityAll + NL + NL + arxiv + NL + NL +
    "Produce:" + NL +
    "1. WHAT'S NEW: Top 3 developments worth knowing" + NL +
    "2. EXPERIMENTS: 2 concrete things to try" + NL +
    "3. LLM EXPLOITATION: Any notable jailbreaks, prompt injection techniques, or security concerns" + NL +
    "4. SYSTEM PROPOSALS: 1-2 improvements for an automated research agent system" + NL + NL +
    "Be concise and actionable."
  );

  const proposals: Array<{section: string; diff: string; reason: string}> = [];
  const re = /\\d+\\.\\s*([^:]+):\\s*([\\s\\S]*?)(?=\\d+\\.|$)/g;
  let m;
  while ((m = re.exec(briefing)) !== null) {
    proposals.push({ section: m[1].trim(), diff: "", reason: m[2].trim().slice(0, 500) });
  }

  return { summary: briefing, metric: String(proposals.length || 1), proposals };
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
      config: { LANGUAGES: "typescript,rust,python,go", SINCE: "daily", TASK_TYPE: "research", METRIC: "repos_found", DIRECTION: "higher" },
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
      config: { REGIONS: "inlandempire,losangeles,orangecounty,sandiego", MIN_PRICE: "2000", MAX_PRICE: "15000", TOP_N: "8", TASK_TYPE: "research", METRIC: "deals_found", DIRECTION: "higher", TIMEOUT: "300" },
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
      config: { SERIES_IDS: "DGS10,DGS2,T10Y2Y,FEDFUNDS,UNRATE", TASK_TYPE: "research", METRIC: "data_points", DIRECTION: "higher" },
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
      config: { TICKER_LIST: "AAPL,TSLA,NVDA,MSFT,GOOG", FILING_TYPES: "10-K,10-Q,8-K", TASK_TYPE: "research", METRIC: "filings_found", DIRECTION: "higher" },
      costTier: "free",
      tags: ["program"],
      code: null,
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
      name: "best-effort-extract",
      description: "Open any URL and extract content using generic selectors (use with url parameter)",
      siteProfileId: profileMap.get("any-website")!,
      steps: [
        { action: "wait" as const, waitMs: 3000, description: "Wait for page to load" },
        { action: "extract" as const, description: "Extract all visible content" },
      ],
      extractionRules: { content: "body" },
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
