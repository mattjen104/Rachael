
const __ctx = JSON.parse(process.env.__INLINE_CTX || '{}');
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
const STATE = props.STATE || "CA";
const ZIP = props.ZIP_CODE || "92373";

async function fetchHUD(): Promise<string[]> {
  const lines: string[] = [];
  try {
    const url = "https://www.hudhomestore.gov/Listing/PropertySearchResult?sState=" + STATE + "&sZipCode=" + ZIP + "&sRadius=25&iPageSize=20&iPageNum=1";
    const br = await bridgeFetch(url, { type: "dom", selectors: { addresses: "td.address, .address", prices: "td.price, .price, .listing-price" }, timeout: 30000 });
    if (br.error) {
      lines.push("  [HUD HomeStore: " + br.error.slice(0, 80) + "]");
    } else if (br.extracted && br.extracted.addresses && br.extracted.addresses.length > 0) {
      const addrs = br.extracted.addresses;
      const prices = br.extracted.prices || [];
      for (let i = 0; i < addrs.length; i++) {
        lines.push("  " + addrs[i].text + (prices[i] ? " - " + prices[i].text : ""));
      }
    } else if (br.text) {
      const addrRe = /\d{1,5}\s+[A-Z][a-zA-Z\s]+(?:St|Ave|Blvd|Dr|Ln|Rd|Way|Ct|Pl)/g;
      const found = br.text.match(addrRe) || [];
      if (found.length > 0) {
        for (const addr of found.slice(0, 10)) lines.push("  " + addr);
      } else {
        lines.push("  [HUD HomeStore: page loaded but no parseable listings]");
      }
    } else {
      lines.push("  [HUD HomeStore: empty response]");
    }
  } catch (e: any) {
    lines.push("  [HUD HomeStore error: " + (e.message || "").slice(0, 80) + "]");
  }
  return lines;
}

async function fetchFannieMae(): Promise<string[]> {
  const lines: string[] = [];
  try {
    const url = "https://www.homepath.com/listing?view=map&state=" + STATE + "&zip=" + ZIP + "&radius=25&propertyType=SFR,CONDO";
    const br = await bridgeFetch(url, { type: "dom", selectors: { titles: ".property-title, .listing-title, .property-card-title" }, timeout: 30000 });
    if (br.error) {
      lines.push("  [HomePath: " + br.error.slice(0, 80) + "]");
    } else if (br.extracted && br.extracted.titles && br.extracted.titles.length > 0) {
      for (const t of br.extracted.titles) {
        lines.push("  [HomePath] " + t.text);
      }
    } else if (br.text && br.text.length > 500) {
      lines.push("  [HomePath: page loaded (" + br.text.length + " chars) but no parseable listings]");
    } else {
      lines.push("  [HomePath: empty or blocked response]");
    }
  } catch (e: any) {
    lines.push("  [HomePath error: " + (e.message || "").slice(0, 80) + "]");
  }
  return lines;
}

async function fetchCLForeclosures(): Promise<string[]> {
  const lines: string[] = [];
  const regions = ["inlandempire", "losangeles", "orangecounty"];
  for (const region of regions) {
    try {
      const url = "https://" + region + ".craigslist.org/search/rea?query=" + encodeURIComponent("foreclosure OR bank owned OR REO");
      const br = await bridgeFetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" } });
      if (br.error) continue;
      const html = (typeof br.body === "string" ? br.body : br.text) || "";
      if (!html) continue;
      const titleRe = /<div class="title">([^<]*)<\/div>/g;
      const priceRe = /<div class="price">([^<]*)<\/div>/g;
      const linkRe = /<a href="(https:\/\/[^"]*craigslist[^"]*\.html)">/g;
      const titles: string[] = []; const prices: string[] = []; const lnks: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = titleRe.exec(html)) !== null) titles.push(m[1]);
      while ((m = priceRe.exec(html)) !== null) prices.push(m[1]);
      while ((m = linkRe.exec(html)) !== null) lnks.push(m[1]);
      for (let i = 0; i < titles.length && i < 5; i++) {
        lines.push("  [CL/" + region + "] " + (prices[i] || "no price") + " | " + titles[i] + NL + "    " + (lnks[i] || ""));
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch {}
  }
  return lines;
}

async function execute() {
  const [hudLines, fmLines, clLines] = await Promise.all([
    fetchHUD(),
    fetchFannieMae(),
    fetchCLForeclosures(),
  ]);
  const totalListings = hudLines.length + fmLines.length + clLines.length;
  const summary = "Foreclosure Monitor: " + STATE + " " + ZIP + " (25mi radius)" + NL + NL +
    "=== HUD HomeStore ===" + NL + (hudLines.length > 0 ? hudLines.join(NL) : "  [no results]") + NL + NL +
    "=== Fannie Mae HomePath ===" + NL + (fmLines.length > 0 ? fmLines.join(NL) : "  [no results]") + NL + NL +
    "=== Craigslist REO/Foreclosure ===" + NL + (clLines.length > 0 ? clLines.join(NL) : "  [no results]");
  return { summary, metric: String(totalListings) };
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
