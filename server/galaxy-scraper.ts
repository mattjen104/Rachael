import { storage } from "./storage";
import { storeMemoryWithQdrant } from "./memory-consolidation";
import type { GalaxyKbEntry } from "@shared/schema";

const GALAXY_CONFIG_KEY = "galaxy_context_enabled";
const GALAXY_QUEUE_KEY = "galaxy_context_queue";
const GALAXY_STATS_KEY = "galaxy_context_stats";

interface GalaxyContextStats {
  lastRun: string | null;
  totalSearches: number;
  totalGuidesRead: number;
  memoriesCreated: number;
  errors: number;
  lastTerms: string[];
}

const defaultStats: GalaxyContextStats = {
  lastRun: null,
  totalSearches: 0,
  totalGuidesRead: 0,
  memoriesCreated: 0,
  errors: 0,
  lastTerms: [],
};

interface GalaxySearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const galaxyGlobalLock = {
  lastFetchTime: 0,
  readCount: 0,
  readSessionStart: 0,
  inFlight: false,
};

function randomDelay(minMs: number, maxMs: number): number {
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForGalaxyRateLimit(isRead: boolean): Promise<string | null> {
  if (galaxyGlobalLock.inFlight) {
    return "Galaxy request already in progress.";
  }

  const now = Date.now();

  if (isRead) {
    const SESSION_WINDOW = 10 * 60 * 1000;
    if (now - galaxyGlobalLock.readSessionStart > SESSION_WINDOW) {
      galaxyGlobalLock.readCount = 0;
      galaxyGlobalLock.readSessionStart = now;
    }
    if (galaxyGlobalLock.readCount >= 5) {
      const cooldown = randomDelay(30000, 60000);
      const sinceLast = now - galaxyGlobalLock.lastFetchTime;
      if (sinceLast < cooldown) {
        return `Cooldown active (${galaxyGlobalLock.readCount} guides fetched). Waiting.`;
      }
      galaxyGlobalLock.readCount = 0;
      galaxyGlobalLock.readSessionStart = now;
    }
  }

  const sinceLast = now - galaxyGlobalLock.lastFetchTime;
  const minWait = randomDelay(3000, 8000);
  if (sinceLast < minWait && galaxyGlobalLock.lastFetchTime > 0) {
    await sleep(minWait - sinceLast);
  }

  galaxyGlobalLock.inFlight = true;
  galaxyGlobalLock.lastFetchTime = Date.now();
  if (isRead) galaxyGlobalLock.readCount++;
  return null;
}

export function galaxyRequestDone(): void {
  galaxyGlobalLock.inFlight = false;
}

async function galaxyBridgeFetch(url: string, submittedBy: string, options?: any): Promise<any> {
  const { submitJob, waitForResult, isExtensionConnected } = await import("./bridge-queue");
  if (!isExtensionConnected()) {
    throw new Error("Chrome extension bridge not connected — cannot reach Galaxy.");
  }
  const jobId = submitJob("dom", url, submittedBy, options, 0);
  return waitForResult(jobId, 45000);
}

let robotsParsed: { disallowed: string[] } | null = null;

async function checkRobots(urlPath: string): Promise<boolean> {
  if (!robotsParsed) {
    try {
      const { submitJob, waitForResult, isExtensionConnected } = await import("./bridge-queue");
      if (isExtensionConnected()) {
        const jobId = submitJob("fetch", "https://galaxy.epic.com/robots.txt", "galaxy-ctx-robots", {}, 0);
        const result = await waitForResult(jobId, 10000);
        const body = typeof result.body === "string" ? result.body : "";
        const disallowed: string[] = [];
        let isUA = false;
        for (const line of body.split(/\n/)) {
          const trimmed = line.trim();
          if (trimmed.toLowerCase().startsWith("user-agent:")) {
            isUA = trimmed.includes("*");
          }
          if (isUA && trimmed.toLowerCase().startsWith("disallow:")) {
            const path = trimmed.substring(9).trim();
            if (path) disallowed.push(path);
          }
        }
        robotsParsed = { disallowed };
      } else {
        robotsParsed = { disallowed: [] };
      }
    } catch {
      robotsParsed = { disallowed: [] };
    }
  }
  try {
    const path = new URL(urlPath).pathname;
    for (const d of robotsParsed.disallowed) {
      if (path.startsWith(d)) return false;
    }
  } catch {}
  return true;
}

export async function isGalaxyContextEnabled(): Promise<boolean> {
  const cfg = await storage.getAgentConfig(GALAXY_CONFIG_KEY);
  return cfg?.value === "true";
}

export async function setGalaxyContextEnabled(enabled: boolean): Promise<void> {
  await storage.setAgentConfig(GALAXY_CONFIG_KEY, enabled ? "true" : "false", "galaxy");
}

export async function getGalaxyContextStats(): Promise<GalaxyContextStats> {
  const cfg = await storage.getAgentConfig(GALAXY_STATS_KEY);
  if (!cfg?.value) return { ...defaultStats };
  try {
    return JSON.parse(cfg.value);
  } catch {
    return { ...defaultStats };
  }
}

async function saveStats(stats: GalaxyContextStats): Promise<void> {
  await storage.setAgentConfig(GALAXY_STATS_KEY, JSON.stringify(stats), "galaxy");
}

export async function getContextQueue(): Promise<string[]> {
  const cfg = await storage.getAgentConfig(GALAXY_QUEUE_KEY);
  if (!cfg?.value) return [];
  try {
    return JSON.parse(cfg.value);
  } catch {
    return [];
  }
}

export async function addToContextQueue(terms: string[]): Promise<void> {
  const existing = await getContextQueue();
  const merged = [...new Set([...existing, ...terms.map(t => t.trim().toLowerCase())])];
  await storage.setAgentConfig(GALAXY_QUEUE_KEY, JSON.stringify(merged.slice(0, 50)), "galaxy");
}

async function removeFromQueue(term: string): Promise<void> {
  const existing = await getContextQueue();
  const filtered = existing.filter(t => t !== term);
  await storage.setAgentConfig(GALAXY_QUEUE_KEY, JSON.stringify(filtered), "galaxy");
}

async function searchGalaxy(query: string): Promise<GalaxySearchResult[]> {
  const searchUrl = `https://galaxy.epic.com/Search/GetResults?query=${encodeURIComponent(query)}&page=1&pageSize=10`;

  if (!(await checkRobots(searchUrl))) {
    console.log(`[galaxy-ctx] Search URL blocked by robots.txt: ${searchUrl}`);
    return [];
  }

  const rateMsg = await waitForGalaxyRateLimit(false);
  if (rateMsg) {
    console.log(`[galaxy-ctx] Rate limited: ${rateMsg}`);
    return [];
  }

  try {
    const result = await galaxyBridgeFetch(searchUrl, "galaxy-context-search", {
      maxText: 30000,
      includeHtml: true,
      maxHtml: 50000,
      spaWaitMs: 3000,
    });

    if (result.error) {
      console.log(`[galaxy-ctx] Search failed: ${result.error}`);
      return [];
    }

    const html = (typeof result.body === "string" ? result.body : "") || "";
    const results: GalaxySearchResult[] = [];

    const pattern = /<a[^>]*href=["']([^"']*?)["'][^>]*>([^<]{3,})<\/a>[^<]*(?:<[^>]+>[^<]*){0,5}/gi;
    let match;
    while ((match = pattern.exec(html)) !== null && results.length < 5) {
      let href = match[1];
      const title = match[2].trim();
      if (title.length < 4) continue;
      if (href.includes("/Search/") || href.includes("/Account/") || href.includes("javascript:")) continue;
      if (!href.startsWith("http")) href = `https://galaxy.epic.com${href}`;

      let snippet = "";
      const after = html.substring(match.index + match[0].length, match.index + match[0].length + 300);
      const clean = after.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (clean.length > 10) snippet = clean.substring(0, 120);

      const isDupe = results.some(r => r.url === href || r.title === title);
      if (!isDupe) results.push({ title, url: href, snippet });
    }

    return results;
  } finally {
    galaxyRequestDone();
  }
}

async function readGalaxyGuide(url: string, fromSearch: boolean, searchQuery?: string): Promise<{ title: string; category: string; text: string } | null> {
  if (!(await checkRobots(url))) {
    console.log(`[galaxy-ctx] URL blocked by robots.txt: ${url}`);
    return null;
  }

  const rateMsg = await waitForGalaxyRateLimit(true);
  if (rateMsg) {
    console.log(`[galaxy-ctx] Rate limited: ${rateMsg}`);
    return null;
  }

  try {
    if (fromSearch && searchQuery) {
      const refUrl = `https://galaxy.epic.com/Search/GetResults?query=${encodeURIComponent(searchQuery)}&page=1&pageSize=10`;
      await galaxyBridgeFetch(refUrl, "galaxy-ctx-browse-search", { maxText: 1000, spaWaitMs: 1500 });
    } else {
      await galaxyBridgeFetch("https://galaxy.epic.com", "galaxy-ctx-browse-home", { maxText: 1000, spaWaitMs: 1500 });
    }
    await sleep(randomDelay(2000, 5000));

    const result = await galaxyBridgeFetch(url, "galaxy-ctx-read", {
      maxText: 50000,
      includeHtml: true,
      maxHtml: 100000,
      spaWaitMs: 3000,
    });

    if (result.error) {
      console.log(`[galaxy-ctx] Read failed: ${result.error}`);
      return null;
    }

    const html = (typeof result.body === "string" ? result.body : "") || "";
    const text = result.text || "";

    let title = "";
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) title = titleMatch[1].trim();
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (h1Match) title = h1Match[1].trim();
    if (!title) title = text.split(/\n/)[0]?.trim().substring(0, 100) || "Galaxy Article";

    let category = "";
    const breadcrumbMatch = html.match(/<[^>]*class=["'][^"']*breadcrumb[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
    if (breadcrumbMatch) {
      const crumbLinks = breadcrumbMatch[1].match(/>([^<]{2,})</g);
      if (crumbLinks && crumbLinks.length > 1) {
        category = crumbLinks[crumbLinks.length - 2].replace(/^>/, "").trim();
      }
    }
    if (!category) {
      try {
        const pathParts = new URL(url).pathname.split("/").filter(Boolean);
        if (pathParts.length > 1) {
          category = decodeURIComponent(pathParts[0]).replace(/[-_]/g, " ");
          category = category.charAt(0).toUpperCase() + category.slice(1);
        }
      } catch {}
    }
    if (!category) category = "General";

    const extracted = text.length > 100 ? text : html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return { title, category, text: extracted.substring(0, 50000) };
  } finally {
    galaxyRequestDone();
  }
}

function chunkText(text: string, maxChunk: number = 1500): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length > maxChunk && current.length > 100) {
      chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }
  if (current.trim().length > 50) {
    chunks.push(current.trim());
  }

  const hardCapped: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChunk * 2) {
      hardCapped.push(chunk);
    } else {
      const sentences = chunk.split(/(?<=[.!?])\s+/);
      let sub = "";
      for (const sentence of sentences) {
        if (sub.length + sentence.length > maxChunk && sub.length > 100) {
          hardCapped.push(sub.trim());
          sub = sentence;
        } else {
          sub += (sub ? " " : "") + sentence;
        }
      }
      if (sub.trim().length > 50) {
        hardCapped.push(sub.trim().substring(0, maxChunk * 2));
      }
    }
  }
  return hardCapped;
}

async function generateKbSummary(title: string, text: string): Promise<string> {
  try {
    const { executeLLM } = await import("./llm-client");
    const truncated = text.substring(0, 4000);
    const result = await executeLLM(
      [
        { role: "system", content: "You are a concise technical writer. Summarize the following Epic Galaxy guide in 2-4 sentences. Focus on: what it covers, key configuration points, and practical relevance for Epic analysts." },
        { role: "user", content: `Title: ${title}\n\n${truncated}` },
      ],
      "deepseek/deepseek-chat",
      undefined,
      {}
    );
    return result.content?.trim() || title;
  } catch {
    const firstPara = text.split(/\n\n/)[0]?.trim() || "";
    return firstPara.substring(0, 300) || title;
  }
}

export async function ingestToKb(
  url: string,
  title: string,
  category: string,
  fullText: string,
  tags: string[],
  searchTerm?: string
): Promise<{ kbEntry: GalaxyKbEntry; memoriesCreated: number }> {
  const existing = await storage.getGalaxyKbByUrl(url);
  if (existing) {
    const updated = await storage.updateGalaxyKbEntry(existing.id, {
      title,
      category,
      fullText: fullText.substring(0, 50000),
      tags,
      searchTerm: searchTerm || existing.searchTerm || undefined,
    });
    return { kbEntry: updated || existing, memoriesCreated: 0 };
  }

  const summary = await generateKbSummary(title, fullText);

  const kbEntry = await storage.createGalaxyKbEntry({
    title,
    url,
    category,
    summary,
    fullText: fullText.substring(0, 50000),
    tags,
    searchTerm: searchTerm || undefined,
  });

  const chunks = chunkText(fullText);
  let memoriesCreated = 0;
  for (const chunk of chunks) {
    if (chunk.length < 100) continue;

    const memoryContent = `[Galaxy KB #${kbEntry.id}: ${title}] (Category: ${category})\n\n${chunk}`;
    const subject = `epic:galaxy:${(searchTerm || title).toLowerCase().replace(/\s+/g, "-")}`;

    await storeMemoryWithQdrant(
      memoryContent,
      "semantic",
      "galaxy-kb",
      ["galaxy", "epic", category.toLowerCase(), ...(searchTerm ? [searchTerm.toLowerCase()] : [])],
      0.85,
      subject,
      kbEntry.id
    );
    memoriesCreated++;
  }

  if (memoriesCreated > 0) {
    await storage.updateGalaxyKbEntry(kbEntry.id, { memoryCount: memoriesCreated });
  }

  return { kbEntry, memoriesCreated };
}

export async function scrapeGalaxyContext(term: string): Promise<{ memoriesCreated: number; guidesRead: number; error?: string }> {
  const stats = await getGalaxyContextStats();
  let memoriesCreated = 0;
  let guidesRead = 0;

  try {
    console.log(`[galaxy-ctx] Searching Galaxy for: "${term}"`);
    const results = await searchGalaxy(term);
    stats.totalSearches++;

    if (results.length === 0) {
      console.log(`[galaxy-ctx] No results for "${term}"`);
      await removeFromQueue(term);
      stats.lastRun = new Date().toISOString();
      await saveStats(stats);
      return { memoriesCreated: 0, guidesRead: 0 };
    }

    const topResults = results.slice(0, 2);

    for (const result of topResults) {
      await sleep(randomDelay(3000, 8000));

      const guide = await readGalaxyGuide(result.url, true, term);
      if (!guide) continue;

      guidesRead++;
      stats.totalGuidesRead++;

      try {
        await storage.createReaderPage({
          url: result.url,
          title: guide.title,
          extractedText: guide.text,
          domain: "galaxy.epic.com",
        });
      } catch {}

      const kbResult = await ingestToKb(
        result.url,
        guide.title,
        guide.category,
        guide.text,
        ["galaxy", "epic", guide.category.toLowerCase(), term.toLowerCase()],
        term
      );
      memoriesCreated += kbResult.memoriesCreated;
      stats.memoriesCreated += kbResult.memoriesCreated;
    }

    await removeFromQueue(term);
    stats.lastRun = new Date().toISOString();
    if (!stats.lastTerms.includes(term)) {
      stats.lastTerms = [term, ...stats.lastTerms].slice(0, 20);
    }
    await saveStats(stats);

    console.log(`[galaxy-ctx] Done: "${term}" — ${guidesRead} guides, ${memoriesCreated} memories`);
    return { memoriesCreated, guidesRead };
  } catch (e: any) {
    stats.errors++;
    stats.lastRun = new Date().toISOString();
    await saveStats(stats);
    console.error(`[galaxy-ctx] Error scraping "${term}":`, e.message);
    return { memoriesCreated, guidesRead, error: e.message };
  }
}

export async function runGalaxyContextCycle(): Promise<void> {
  const enabled = await isGalaxyContextEnabled();
  if (!enabled) return;

  const queue = await getContextQueue();
  if (queue.length === 0) return;

  const { isExtensionConnected } = await import("./bridge-queue");
  if (!isExtensionConnected()) {
    console.log("[galaxy-ctx] Skipping — Chrome extension not connected");
    return;
  }

  const term = queue[0];
  console.log(`[galaxy-ctx] Processing queued term: "${term}" (${queue.length} in queue)`);
  await scrapeGalaxyContext(term);
}

export async function extractTermsFromEpicResults(rawOutput: string): Promise<string[]> {
  const terms: string[] = [];

  const epicPatterns = [
    /(?:activity|function|module|component|workflow|report|smartphrase|template|navigator|BPA|rule):\s*["']?([A-Za-z][A-Za-z0-9 \-]{3,40})["']?/gi,
    /(?:Epic|Hyperspace|Caboodle|Cogito|Clarity|MyChart|Willow|Beacon|Cadence|Prelude|Resolute|Tapestry|Bugsy|Cupid|Radar|Stork|Bones|Wisdom)\s+([A-Za-z][A-Za-z0-9 ]{3,30})/gi,
    /(?:unknown|unfamiliar|not found|unrecognized)\s+(?:activity|function|module|feature)?\s*["']?([A-Za-z][A-Za-z0-9 \-]{3,40})["']?/gi,
  ];

  for (const pattern of epicPatterns) {
    let m;
    while ((m = pattern.exec(rawOutput)) !== null) {
      const term = m[1].trim();
      if (term.length >= 4 && term.length <= 40) {
        terms.push(term);
      }
    }
  }

  return [...new Set(terms)].slice(0, 5);
}
