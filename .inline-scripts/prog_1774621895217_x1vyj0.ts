
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

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
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
