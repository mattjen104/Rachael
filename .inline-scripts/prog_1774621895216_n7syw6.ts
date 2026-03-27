
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
const REGIONS = (props.REGIONS || "inlandempire").split(",").map(s => s.trim());
const MIN_PRICE = parseInt(props.MIN_PRICE || "2000", 10);
const MAX_PRICE = parseInt(props.MAX_PRICE || "25000", 10);
const TOP_N = parseInt(props.TOP_N || "8", 10);
const KEYWORDS = ["estate", "low miles", "one owner", "garage kept", "original owner", "elderly", "grandma", "grandpa", "deceased", "single owner"];

interface Listing { title: string; price: number; url: string; region: string; date: string }

async function scrapeRegion(region: string): Promise<Listing[]> {
  const listings: Listing[] = [];
  try {
    const url = "https://" + region + ".craigslist.org/search/cta?format=rss&min_price=" + MIN_PRICE + "&max_price=" + MAX_PRICE + "&sort=date";
    const r = await smartFetch(url, { headers: { "User-Agent": "OrgCloud/1.0" } });
    const xml = await r.text();
    if (xml.includes("blocked") && xml.length < 500) return listings;
    const items = xml.split("<item ");
    for (let i = 1; i < items.length && listings.length < 50; i++) {
      const titleM = items[i].match(/<title><![CDATA[\\[(.*?)\\]]]>/s) || items[i].match(/<title>([^<]+)/);
      const linkM = items[i].match(/<link>([^<]+)/);
      const dateM = items[i].match(/<dc:date>([^<]+)/) || items[i].match(/<pubDate>([^<]+)/);
      const title = titleM ? titleM[1].trim() : "";
      const link = linkM ? linkM[1].trim() : "";
      const priceM = title.match(/\\$([\\d,]+)/);
      const price = priceM ? parseInt(priceM[1].replace(",", ""), 10) : 0;
      if (title && price >= MIN_PRICE && price <= MAX_PRICE) {
        listings.push({ title, price, url: link, region, date: dateM ? dateM[1].trim() : "" });
      }
    }
  } catch {}
  return listings;
}

function scoreByKeywords(listing: Listing): number {
  const lower = listing.title.toLowerCase();
  let score = 0;
  for (const kw of KEYWORDS) { if (lower.includes(kw)) score += 10; }
  if (listing.price < 8000) score += 5;
  if (listing.price < 5000) score += 5;
  return score;
}

async function execute() {
  const allResults = await Promise.all(REGIONS.map(r => scrapeRegion(r)));
  const all = allResults.flat();
  all.sort((a, b) => scoreByKeywords(b) - scoreByKeywords(a));
  const top = all.slice(0, TOP_N);
  let summary = "Estate/Low-Mile Car Scan: " + all.length + " total listings across " + REGIONS.join(", ") + String.fromCharCode(10);
  summary += "Top " + top.length + " deals (keyword-scored):" + String.fromCharCode(10);
  for (const l of top) {
    summary += String.fromCharCode(10) + "  $" + l.price + " | " + l.title.slice(0, 80) + String.fromCharCode(10) + "    " + l.url + " [" + l.region + "]";
  }
  return { summary, metric: String(top.length) };
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
