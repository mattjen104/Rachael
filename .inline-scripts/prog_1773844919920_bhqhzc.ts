
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

const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
const TOP_N = parseInt(props.TOP_N || "6", 10);
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const NL = String.fromCharCode(10);

async function fetchHN(path: string) {
  return fetch("https://hacker-news.firebaseio.com/v0/" + path + ".json").then(r => r.json());
}

async function callLLM(prompt: string, maxTokens = 1500): Promise<string> {
  if (!OPENROUTER_KEY) return "[no API key]";
  const model = "anthropic/claude-sonnet-4";
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + OPENROUTER_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.3 }),
    });
    const d = await r.json();
    return d.choices?.[0]?.message?.content?.trim() || "[empty response]";
  } catch (e: any) { return "[LLM error: " + (e.message || e) + "]"; }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
}

async function getCommentTree(itemId: number, depth: number, maxPerLevel: number): Promise<string[]> {
  if (depth <= 0) return [];
  try {
    const item = await fetchHN("item/" + itemId);
    if (!item || item.deleted || item.dead || !item.text) return [];
    const clean = stripHtml(item.text);
    if (clean.length < 15) return [];
    const prefix = depth < 3 ? "  ".repeat(3 - depth) + "> " : "";
    const lines: string[] = [prefix + (item.by || "anon") + ": " + clean.slice(0, 500)];
    const kids = (item.kids || []).slice(0, maxPerLevel);
    for (const kid of kids) {
      const childLines = await getCommentTree(kid, depth - 1, Math.max(2, maxPerLevel - 1));
      lines.push(...childLines);
    }
    return lines;
  } catch { return []; }
}

async function execute() {
  const t0 = Date.now();
  const topIds = await fetchHN("topstories");
  const stories: Array<{ title: string; url: string; score: number; by: string; id: number; descendants: number }> = [];
  for (const id of topIds.slice(0, 40)) {
    const s = await fetchHN("item/" + id);
    if (s && s.score >= 50 && (s.descendants || 0) >= 10) {
      stories.push({ title: s.title, url: s.url || ("https://news.ycombinator.com/item?id=" + s.id), score: s.score, by: s.by, id: s.id, descendants: s.descendants || 0 });
    }
    if (stories.length >= TOP_N) break;
  }

  let fullDigest = "# HN Deep Digest (" + stories.length + " stories)" + NL + NL;

  for (const story of stories) {
    const commentLines: string[] = [];
    try {
      const storyData = await fetchHN("item/" + story.id);
      const topKids = (storyData.kids || []).slice(0, 15);
      for (const kid of topKids) {
        const tree = await getCommentTree(kid, 3, 3);
        commentLines.push(...tree);
        if (commentLines.length > 60) break;
      }
    } catch {}

    const commentText = commentLines.slice(0, 60).join(NL);
    const hnLink = "https://news.ycombinator.com/item?id=" + story.id;

    const prompt = [
      "You are summarizing a Hacker News discussion for a technical reader who wants to understand what the community thinks, not just what the article says.",
      "",
      "Story: " + story.title,
      "URL: " + (story.url || hnLink),
      "Score: " + story.score + " | Comments: " + story.descendants,
      "",
      "=== DISCUSSION ===",
      commentText,
      "=== END ===",
      "",
      "Write a discussion digest in this format:",
      "",
      "DISCUSSION SUMMARY: 2-3 sentences capturing what the community is actually talking about. Focus on the substance of the debate, technical insights shared, and experiences people are reporting. Not just 'people liked it' but WHAT they said.",
      "",
      "KEY ARGUMENTS:",
      "- List 3-5 distinct viewpoints, technical insights, or experiences raised by commenters. Each should be a specific point someone made, not a generic observation. Attribute to username when insightful.",
      "",
      "TENSION: One sentence on the main disagreement or unresolved question in the thread, if any.",
      "",
      "SIGNAL: One sentence on whether this discussion reveals something interesting about industry trends, developer sentiment, or a technical shift.",
    ].join(NL);

    const analysis = await callLLM(prompt, 1200);

    fullDigest += "## [" + story.score + " pts | " + story.descendants + " comments] " + story.title + NL;
    fullDigest += "  " + story.url + NL;
    fullDigest += "  HN: " + hnLink + NL + NL;
    fullDigest += analysis + NL + NL;
    fullDigest += "---" + NL + NL;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  fullDigest = fullDigest.trim() + NL + NL + "(" + elapsed + "s)";
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
