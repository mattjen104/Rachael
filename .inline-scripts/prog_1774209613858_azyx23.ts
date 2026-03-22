
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
