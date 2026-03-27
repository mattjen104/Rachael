
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

const bridgePort = typeof __bridgePort !== "undefined" ? __bridgePort : "5000";

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

  const prompt = "Generate a nightly meal recommendation as JSON with two fields:\n" +
    "1. recipeRecommendation: {name, appliance, ingredients: [], instructions}\n" +
    "2. kiddoLunchSuggestion: {item, bridgeRationale, similarTo}\n\n" +
    "Appliances: " + prefs.appliances.join(", ") + "\n" +
    "Cuisine prefs: " + (prefs.cuisinePreferences || []).join(", ") + "\n" +
    "DO NOT repeat these recipes: " + pastRecipeNames.join(", ") + "\n" +
    "DO NOT repeat these kiddo items: " + pastKiddoItems.join(", ") + "\n" +
    "Expiring pantry items (prefer using): " + (expiringItems.join(", ") || "none") + "\n" +
    "Kiddo favorites: " + (prefs.kiddoCurrentFavorites || []).join(", ") + "\n" +
    "Kiddo accepted: " + acceptedFoods.join(", ") + "\n" +
    "Kiddo rejected: " + rejectedFoods.join(", ") + "\n" +
    "Return ONLY valid JSON.";

  const llmRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (process.env.OPENROUTER_API_KEY || "") },
    body: JSON.stringify({ model: "anthropic/claude-sonnet-4", messages: [{ role: "user", content: prompt }], max_tokens: 1000 }),
  });
  const llmData = await llmRes.json();
  const content = llmData.choices?.[0]?.message?.content || "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
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
