interface BrowserProfile {
  ua: string;
  secChUa: string;
  secChUaPlatform: string;
  secChUaMobile: string;
  acceptLanguage: string;
}

const PROFILES: BrowserProfile[] = [
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    secChUaPlatform: '"macOS"',
    secChUaMobile: "?0",
    acceptLanguage: "en-US,en;q=0.9",
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="123", "Google Chrome";v="123", "Not-A.Brand";v="99"',
    secChUaPlatform: '"Windows"',
    secChUaMobile: "?0",
    acceptLanguage: "en-US,en;q=0.9,es;q=0.8",
  },
  {
    ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="122", "Google Chrome";v="122", "Not-A.Brand";v="99"',
    secChUaPlatform: '"Linux"',
    secChUaMobile: "?0",
    acceptLanguage: "en-US,en;q=0.9",
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Safari/605.1.15",
    secChUa: "",
    secChUaPlatform: "",
    secChUaMobile: "",
    acceptLanguage: "en-US,en;q=0.9",
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
    secChUa: "",
    secChUaPlatform: "",
    secChUaMobile: "",
    acceptLanguage: "en-US,en;q=0.5",
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.3; rv:123.0) Gecko/20100101 Firefox/123.0",
    secChUa: "",
    secChUaPlatform: "",
    secChUaMobile: "",
    acceptLanguage: "en-US,en;q=0.5",
  },
];

const USER_AGENTS = PROFILES.map(p => p.ua);

let _sessionProfile: BrowserProfile | null = null;

function getSessionProfile(): BrowserProfile {
  if (!_sessionProfile) _sessionProfile = PROFILES[Math.floor(Math.random() * PROFILES.length)];
  return _sessionProfile;
}

function randomProfile(): BrowserProfile {
  return PROFILES[Math.floor(Math.random() * PROFILES.length)];
}

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function gaussianRandom(mean: number, stddev: number): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const n = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return Math.max(0, mean + stddev * n);
}

function humanDelay(baseMs: number): number {
  return Math.floor(gaussianRandom(baseMs, baseMs * 0.3));
}

function jitteredDelay(base: number, jitter: number, attempt: number): number {
  const expo = base * Math.pow(2, attempt);
  return expo + Math.floor(Math.random() * jitter);
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function extractOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return ""; }
}

const domainLastRequest = new Map<string, number>();
const DEFAULT_DOMAIN_GAP_MS = 500;
const domainGaps = new Map<string, number>();

function setDomainGap(domain: string, gapMs: number): void {
  domainGaps.set(domain, gapMs);
}

async function enforceDomainGap(domain: string, gapMs?: number): Promise<void> {
  const gap = gapMs ?? domainGaps.get(domain) ?? DEFAULT_DOMAIN_GAP_MS;
  const last = domainLastRequest.get(domain);
  if (last) {
    const elapsed = Date.now() - last;
    if (elapsed < gap) {
      await sleep(gap - elapsed + Math.floor(Math.random() * 100));
    }
  }
  domainLastRequest.set(domain, Date.now());
}

const cookieJar = new Map<string, string[]>();

function storeCookies(domain: string, resp: Response): void {
  const setCookies = resp.headers.getSetCookie?.() ?? [];
  if (setCookies.length === 0) return;
  const existing = cookieJar.get(domain) || [];
  const existingNames = new Set(existing.map(c => c.split("=")[0]));
  for (const sc of setCookies) {
    const name = sc.split("=")[0];
    if (existingNames.has(name)) {
      const idx = existing.findIndex(c => c.startsWith(name + "="));
      if (idx >= 0) existing[idx] = sc.split(";")[0];
    } else {
      existing.push(sc.split(";")[0]);
    }
    existingNames.add(name);
  }
  cookieJar.set(domain, existing);
}

function getCookieHeader(domain: string): string {
  const cookies = cookieJar.get(domain);
  return cookies ? cookies.join("; ") : "";
}

interface CacheEntry { body: string; timestamp: number; status: number; contentType: string }
const responseCache = new Map<string, CacheEntry>();
const MAX_CACHE_SIZE = 200;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

function getCached(url: string, ttlMs: number): CacheEntry | null {
  const entry = responseCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttlMs) {
    responseCache.delete(url);
    return null;
  }
  return entry;
}

function putCache(url: string, body: string, status: number, contentType: string): void {
  if (responseCache.size >= MAX_CACHE_SIZE) {
    const oldest = responseCache.keys().next().value;
    if (oldest) responseCache.delete(oldest);
  }
  responseCache.set(url, { body, timestamp: Date.now(), status, contentType });
}

interface RFetchOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  jitterMs?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  rotateUA?: boolean;
  stickySession?: boolean;
  referer?: string;
  autoReferer?: boolean;
  method?: string;
  body?: string;
  domainGapMs?: number;
  cacheTtlMs?: number | false;
  followRedirects?: boolean;
}

function buildHeaders(profile: BrowserProfile, opts: RFetchOptions, url: string): Record<string, string> {
  const isChrome = profile.ua.includes("Chrome/");
  const h: Record<string, string> = {
    "User-Agent": profile.ua,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": profile.acceptLanguage,
    "Accept-Encoding": "gzip, deflate, br",
    "DNT": "1",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
  };

  if (isChrome && profile.secChUa) {
    h["Sec-CH-UA"] = profile.secChUa;
    h["Sec-CH-UA-Mobile"] = profile.secChUaMobile;
    h["Sec-CH-UA-Platform"] = profile.secChUaPlatform;
    h["Sec-Fetch-Dest"] = "document";
    h["Sec-Fetch-Mode"] = "navigate";
    h["Sec-Fetch-Site"] = opts.referer ? "same-origin" : "none";
    h["Sec-Fetch-User"] = "?1";
  }

  if (opts.referer) {
    h["Referer"] = opts.referer;
  } else if (opts.autoReferer !== false) {
    h["Referer"] = extractOrigin(url) + "/";
  }

  const domain = extractDomain(url);
  const cookie = getCookieHeader(domain);
  if (cookie) h["Cookie"] = cookie;

  if (opts.headers) Object.assign(h, opts.headers);
  return h;
}

async function rfetch(url: string, opts: RFetchOptions = {}): Promise<Response> {
  const {
    maxRetries = 3,
    baseDelayMs = 500,
    jitterMs = 300,
    timeoutMs = 30000,
    rotateUA = true,
    stickySession = false,
    method = "GET",
    body,
    domainGapMs,
  } = opts;

  const domain = extractDomain(url);
  let profile = stickySession ? getSessionProfile() : randomProfile();

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(jitteredDelay(baseDelayMs, jitterMs, attempt - 1));
      if (rotateUA && !stickySession) profile = randomProfile();
    }

    await enforceDomainGap(domain, domainGapMs);

    const headers = buildHeaders(profile, opts, url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: method !== "GET" ? body : undefined,
        signal: controller.signal,
        redirect: opts.followRedirects === false ? "manual" : "follow",
      });
      clearTimeout(timer);

      storeCookies(domain, resp);

      if (resp.status === 429) {
        const retryAfter = resp.headers.get("Retry-After");
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : jitteredDelay(baseDelayMs * 2, jitterMs, attempt);
        await sleep(waitMs);
        lastError = new Error(`HTTP 429 from ${url}`);
        continue;
      }

      if (resp.status >= 500) {
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

async function rfetchText(url: string, opts: RFetchOptions = {}): Promise<string> {
  if (opts.method === "GET" || !opts.method) {
    const ttl = opts.cacheTtlMs;
    if (ttl !== false) {
      const cached = getCached(url, typeof ttl === "number" ? ttl : DEFAULT_CACHE_TTL_MS);
      if (cached) return cached.body;
    }
  }
  const r = await rfetch(url, opts);
  const text = await r.text();
  if (opts.cacheTtlMs !== false && (opts.method === "GET" || !opts.method)) {
    putCache(url, text, r.status, r.headers.get("content-type") || "");
  }
  return text;
}

async function rfetchJSON(url: string, opts: RFetchOptions = {}): Promise<any> {
  const r = await rfetch(url, { ...opts, headers: { ...opts.headers, "Accept": "application/json" } });
  return r.json();
}

async function warmDomain(domain: string, rootUrl?: string): Promise<void> {
  const url = rootUrl || `https://${domain}/`;
  try {
    await rfetch(url, { maxRetries: 1, timeoutMs: 10000, stickySession: true });
  } catch {}
}

interface ThrottledBatchOpts<T, R> {
  items: T[];
  concurrency: number;
  delayMs?: number;
  fn: (item: T, index: number) => Promise<R>;
  onProgress?: (completed: number, total: number) => void;
}

async function throttledBatch<T, R>(opts: ThrottledBatchOpts<T, R>): Promise<R[]> {
  const { items, concurrency, delayMs = 200, fn, onProgress } = opts;
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      if (idx > 0 && delayMs > 0) {
        await sleep(humanDelay(delayMs));
      }
      results[idx] = await fn(items[idx], idx);
      completed++;
      onProgress?.(completed, items.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export {
  rfetch, rfetchText, rfetchJSON, warmDomain, throttledBatch,
  sleep, humanDelay, gaussianRandom,
  randomUA, randomProfile, getSessionProfile, setDomainGap,
  getCookieHeader, cookieJar, responseCache,
  USER_AGENTS, PROFILES,
  type RFetchOptions, type BrowserProfile, type ThrottledBatchOpts,
};
