
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
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

const FREE_MODELS = [
  'google/gemma-3-4b-it:free',
  'google/gemma-3-12b-it:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'qwen/qwen3-4b:free',
  'qwen/qwen3-8b:free',
  'deepseek/deepseek-r1-0528:free',
];

interface ModelResult {
  model: string;
  status: string;
  latency: number;
}

async function testModel(model: string): Promise<ModelResult> {
  const t0 = Date.now();
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENROUTER_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with only the word OK' }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const d = await r.json() as any;
    const ms = Date.now() - t0;
    if (d.choices?.[0]?.message?.content) {
      return { model, status: 'OK', latency: ms };
    }
    if (d.error) {
      return { model, status: 'ERR: ' + (d.error.message || '').slice(0, 60), latency: ms };
    }
    return { model, status: 'NO_RESPONSE', latency: ms };
  } catch (e: any) {
    return { model, status: 'FAIL: ' + (e.message || '').slice(0, 60), latency: Date.now() - t0 };
  }
}

async function execute() {
  const results: ModelResult[] = [];
  for (const model of FREE_MODELS) {
    results.push(await testModel(model));
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  const working = results.filter(r => r.status === 'OK');
  const lines = results.map(r => {
    const tag = r.status === 'OK' ? '[+]' : '[-]';
    const short = r.model.split('/').pop() || r.model;
    return tag + ' ' + short + ' ' + r.status + ' (' + r.latency + 'ms)';
  });
  const summary = 'Model Scout: ' + working.length + '/' + results.length + ' free models working' + NL + lines.join(NL);
  return { summary, metric: String(working.length) };
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
