
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

const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
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
