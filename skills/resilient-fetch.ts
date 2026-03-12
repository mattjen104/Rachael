const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.3; rv:122.0) Gecko/20100101 Firefox/122.0",
];

interface RFetchOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  jitterMs?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  rotateUA?: boolean;
  referer?: string;
  method?: string;
  body?: string;
}

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function jitteredDelay(base: number, jitter: number, attempt: number): number {
  const expo = base * Math.pow(2, attempt);
  return expo + Math.floor(Math.random() * jitter);
}

export async function rfetch(url: string, opts: RFetchOptions = {}): Promise<Response> {
  const {
    maxRetries = 3,
    baseDelayMs = 500,
    jitterMs = 300,
    timeoutMs = 30000,
    headers = {},
    rotateUA = true,
    referer,
    method = "GET",
    body,
  } = opts;

  const controller = new AbortController();
  const merged: Record<string, string> = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    ...(rotateUA ? { "User-Agent": randomUA() } : {}),
    ...(referer ? { "Referer": referer } : {}),
    ...headers,
  };

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(jitteredDelay(baseDelayMs, jitterMs, attempt - 1));
      if (rotateUA) merged["User-Agent"] = randomUA();
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method,
        headers: merged,
        body: method !== "GET" ? body : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (resp.status === 429 || resp.status >= 500) {
        lastError = new Error(`HTTP ${resp.status} from ${url}`);
        continue;
      }
      return resp;
    } catch (e: any) {
      clearTimeout(timer);
      lastError = e;
      if (e.name === "AbortError" && attempt >= maxRetries) break;
    }
  }
  throw lastError || new Error(`rfetch failed after ${maxRetries + 1} attempts: ${url}`);
}

export async function rfetchJSON(url: string, opts: RFetchOptions = {}): Promise<any> {
  const r = await rfetch(url, { ...opts, headers: { ...opts.headers, "Accept": "application/json" } });
  return r.json();
}

export async function rfetchText(url: string, opts: RFetchOptions = {}): Promise<string> {
  const r = await rfetch(url, opts);
  return r.text();
}

interface ThrottledBatchOpts<T, R> {
  items: T[];
  concurrency: number;
  delayMs?: number;
  fn: (item: T, index: number) => Promise<R>;
}

export async function throttledBatch<T, R>(opts: ThrottledBatchOpts<T, R>): Promise<R[]> {
  const { items, concurrency, delayMs = 200, fn } = opts;
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      if (idx > 0 && delayMs > 0) {
        await sleep(delayMs + Math.floor(Math.random() * delayMs * 0.5));
      }
      results[idx] = await fn(items[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export { USER_AGENTS, randomUA, sleep };
