
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
const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
const REGION = props.CL_REGION || "inlandempire";
const KEYWORDS = (props.KEYWORDS || "furniture,electronics,tools,appliance,computer,monitor,desk,hot tub,spa").split(",").map((k: string) => k.trim());
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface FreeItem { title: string; url: string; location: string; }

async function searchFree(keyword: string): Promise<FreeItem[]> {
  const url = "https://" + REGION + ".craigslist.org/search/zip?query=" + encodeURIComponent(keyword);
  const br = await bridgeFetch(url, { headers: { "User-Agent": UA } });
  if (br.error) return [];
  const html = (typeof br.body === "string" ? br.body : br.text) || "";
  if (!html) return [];
  const items: FreeItem[] = [];
  const linkRe = /<a href="(https:\/\/[^"]*craigslist[^"]*\.html)">/g;
  const titleRe = /<div class="title">([^<]*)<\/div>/g;
  const locRe = /<div class="location">([^<]*)<\/div>/g;
  const links: string[] = []; const titles: string[] = []; const locs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) links.push(m[1]);
  while ((m = titleRe.exec(html)) !== null) titles.push(m[1]);
  while ((m = locRe.exec(html)) !== null) locs.push(m[1]);
  for (let i = 0; i < titles.length && i < 10; i++) {
    items.push({ title: titles[i], url: links[i] || "", location: (locs[i] || "").trim() });
  }
  return items;
}

async function execute() {
  const allItems: FreeItem[] = [];
  const matchedKeywords: string[] = [];
  for (const kw of KEYWORDS) {
    try {
      const results = await searchFree(kw);
      if (results.length > 0) matchedKeywords.push(kw + ":" + results.length);
      allItems.push(...results);
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch {}
  }
  const unique = new Map<string, FreeItem>();
  for (const item of allItems) {
    if (!unique.has(item.title)) unique.set(item.title, item);
  }
  const deduped = Array.from(unique.values());
  const lines = deduped.slice(0, 30).map(item =>
    "  [FREE] " + item.title + (item.location ? " [" + item.location + "]" : "") + NL + "    " + item.url
  );
  const summary = "Free Stuff Radar: " + deduped.length + " items found (" + REGION + ")" + NL +
    "Keywords hit: " + (matchedKeywords.length > 0 ? matchedKeywords.join(", ") : "none") + NL + NL + lines.join(NL);
  return { summary, metric: String(deduped.length) };
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
