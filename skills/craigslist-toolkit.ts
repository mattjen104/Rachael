import { rfetch, rfetchText, throttledBatch, sleep } from "./resilient-fetch";

export interface CListing {
  id: string;
  url: string;
  title: string;
  price: number | null;
  location: string;
  date: string | null;
  thumbnailUrl: string | null;
  jsonLd: any | null;
}

export interface CSearchOpts {
  region: string;
  category?: string;
  query?: string;
  params?: Record<string, string>;
  maxPages?: number;
  delayMs?: number;
}

const RESULTS_PER_PAGE = 120;

function extractJsonLd(html: string): any[] {
  const results: any[] = [];
  const re = /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { results.push(JSON.parse(m[1])); } catch {}
  }
  return results;
}

function parseListingFromJsonLd(ld: any): Partial<CListing> {
  return {
    title: ld.name || ld.title || "",
    price: ld.offers?.price ? parseFloat(ld.offers.price) : null,
    location: ld.offers?.availableAtOrFrom?.address?.addressLocality || "",
    date: ld.datePosted || null,
    thumbnailUrl: Array.isArray(ld.image) ? ld.image[0] : ld.image || null,
  };
}

function parseSearchResultsHtml(html: string, region: string): CListing[] {
  const listings: CListing[] = [];
  const re = /<li[^>]*class="[^"]*cl-search-result[^"]*"[^>]*data-pid="(\d+)"[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>[\s\S]*?<span[^>]*class="label"[^>]*>([\s\S]*?)<\/span>[\s\S]*?(?:<span[^>]*class="priceinfo"[^>]*>([\s\S]*?)<\/span>)?/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const priceMatch = (m[4] || "").match(/\$([0-9,]+)/);
    listings.push({
      id: m[1],
      url: m[2].startsWith("http") ? m[2] : `https://${region}.craigslist.org${m[2]}`,
      title: m[3].replace(/<[^>]*>/g, "").trim(),
      price: priceMatch ? parseInt(priceMatch[1].replace(/,/g, ""), 10) : null,
      location: "",
      date: null,
      thumbnailUrl: null,
      jsonLd: null,
    });
  }

  if (listings.length === 0) {
    const linkRe = /<a[^>]*href="(https?:\/\/[^"]*\.craigslist\.org\/[^"]*\/d\/[^"]*\/\d+\.html)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = linkRe.exec(html)) !== null) {
      const text = m[2].replace(/<[^>]*>/g, "").trim();
      const idMatch = m[1].match(/\/(\d+)\.html/);
      const priceMatch = text.match(/\$([0-9,]+)/);
      if (idMatch) {
        listings.push({
          id: idMatch[1],
          url: m[1],
          title: text.replace(/\$[0-9,]+/, "").trim(),
          price: priceMatch ? parseInt(priceMatch[1].replace(/,/g, ""), 10) : null,
          location: "",
          date: null,
          thumbnailUrl: null,
          jsonLd: null,
        });
      }
    }
  }

  return listings;
}

export async function searchCraigslist(opts: CSearchOpts): Promise<CListing[]> {
  const { region, category = "sss", query, params = {}, maxPages = 3, delayMs = 800 } = opts;
  const all: CListing[] = [];
  const seen = new Set<string>();

  for (let page = 0; page < maxPages; page++) {
    const offset = page * RESULTS_PER_PAGE;
    const qs = new URLSearchParams({ ...params, s: String(offset) });
    if (query) qs.set("query", query);
    const url = `https://${region}.craigslist.org/search/${category}?${qs}`;

    try {
      const html = await rfetchText(url, {
        referer: `https://${region}.craigslist.org/`,
        maxRetries: 2,
        timeoutMs: 20000,
      });

      const listings = parseSearchResultsHtml(html, region);
      if (listings.length === 0) break;

      for (const l of listings) {
        if (!seen.has(l.id)) { seen.add(l.id); all.push(l); }
      }

      if (listings.length < RESULTS_PER_PAGE) break;
      if (page < maxPages - 1) await sleep(delayMs + Math.floor(Math.random() * 400));
    } catch {
      break;
    }
  }

  return all;
}

export async function enrichListing(listing: CListing): Promise<CListing> {
  try {
    const html = await rfetchText(listing.url, { maxRetries: 2, timeoutMs: 15000 });
    const ldArr = extractJsonLd(html);
    if (ldArr.length > 0) {
      const parsed = parseListingFromJsonLd(ldArr[0]);
      listing.jsonLd = ldArr[0];
      if (parsed.title && !listing.title) listing.title = parsed.title;
      if (parsed.price !== null && listing.price === null) listing.price = parsed.price;
      if (parsed.location) listing.location = parsed.location;
      if (parsed.date) listing.date = parsed.date;
      if (parsed.thumbnailUrl) listing.thumbnailUrl = parsed.thumbnailUrl;
    }
  } catch {}
  return listing;
}

export async function searchAndEnrich(opts: CSearchOpts & { enrichConcurrency?: number; enrichCount?: number }): Promise<CListing[]> {
  const { enrichConcurrency = 3, enrichCount = 10, ...searchOpts } = opts;
  const listings = await searchCraigslist(searchOpts);
  const toEnrich = listings.slice(0, enrichCount);
  await throttledBatch({
    items: toEnrich,
    concurrency: enrichConcurrency,
    delayMs: 500,
    fn: async (l) => { await enrichListing(l); },
  });
  return listings;
}

export interface DedupeStore {
  seen: Set<string>;
  add(id: string): boolean;
}

export function makeDedupeStore(previousIds: string[] = []): DedupeStore {
  const seen = new Set(previousIds);
  return {
    seen,
    add(id: string): boolean {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
  };
}

export function parseIdsFromResults(results: string): string[] {
  const ids: string[] = [];
  const re = /\/(\d{10,})\.html/g;
  let m;
  while ((m = re.exec(results)) !== null) ids.push(m[1]);
  return ids;
}
