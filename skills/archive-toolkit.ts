import { rfetchJSON, rfetchText, throttledBatch, setDomainGap } from "./resilient-fetch";
import { fuzzyMatchLines, type LineFuzzyHit } from "./fuzzy-match";

export interface ArchiveItem {
  identifier: string;
  title: string;
  year: number;
  mediatype?: string;
  collection?: string;
}

export interface ArchiveSearchOpts {
  query: string;
  mediatype?: string;
  yearRange?: [number, number];
  collection?: string;
  maxRows?: number;
  fields?: string[];
  sort?: string;
}

setDomainGap("archive.org", 400);

export async function searchArchive(opts: ArchiveSearchOpts): Promise<ArchiveItem[]> {
  const { query, mediatype, yearRange, collection, maxRows = 500, fields = ["identifier", "title", "year"], sort = "year asc" } = opts;
  let q = query;
  if (mediatype) q += ` mediatype:(${mediatype})`;
  if (yearRange) q += ` year:[${yearRange[0]} TO ${yearRange[1]}]`;
  if (collection) q += ` collection:(${collection})`;

  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl=${fields.join(",")}&output=json&rows=${maxRows}&sort=${encodeURIComponent(sort)}`;
  const d = await rfetchJSON(url, { maxRetries: 3, timeoutMs: 30000, stickySession: true });
  return (d.response?.docs || []).map((doc: any) => ({
    identifier: doc.identifier,
    title: doc.title || doc.identifier,
    year: parseInt(doc.year, 10) || 0,
    mediatype: doc.mediatype,
    collection: doc.collection,
  }));
}

export async function getItemFiles(identifier: string): Promise<ArchiveFile[]> {
  const meta = await rfetchJSON(`https://archive.org/metadata/${identifier}/files`, {
    maxRetries: 2,
    stickySession: true,
    cacheTtlMs: 60000,
  });
  return (meta.result || []).map((f: any) => ({
    name: f.name,
    format: f.format || "",
    size: parseInt(f.size, 10) || 0,
    source: f.source || "",
  }));
}

export interface ArchiveFile {
  name: string;
  format: string;
  size: number;
  source: string;
}

export async function getOCRText(identifier: string, filename?: string): Promise<string | null> {
  const files = await getItemFiles(identifier);
  const txtFile = filename
    ? files.find(f => f.name === filename)
    : files.find(f => f.name.endsWith("_djvu.txt"))
      || files.find(f => f.name.endsWith(".txt") && f.source !== "metadata");

  if (!txtFile) return null;
  return rfetchText(
    `https://archive.org/download/${identifier}/${encodeURIComponent(txtFile.name)}`,
    { maxRetries: 2, timeoutMs: 30000, stickySession: true, cacheTtlMs: 120000 }
  );
}

export interface OCRSearchResult {
  item: ArchiveItem;
  hadOCR: boolean;
  error: boolean;
  hits: LineFuzzyHit[];
}

export async function searchOCRText(
  item: ArchiveItem,
  targets: string[],
  opts: { maxDist?: number; contextLines?: number; falsePositives?: string[] } = {}
): Promise<OCRSearchResult> {
  const { maxDist = 0, contextLines = 2, falsePositives = [] } = opts;
  try {
    const text = await getOCRText(item.identifier);
    if (!text) return { item, hadOCR: false, error: false, hits: [] };

    const lines = text.split("\n");
    const allHits: LineFuzzyHit[] = [];

    for (const target of targets) {
      const hits = fuzzyMatchLines(lines, target, { maxDist, contextLines });
      for (const h of hits) {
        const lower = h.context.toLowerCase();
        if (falsePositives.some(fp => lower.includes(fp.toLowerCase()))) continue;
        allHits.push(h);
      }
    }

    return { item, hadOCR: true, error: false, hits: allHits };
  } catch {
    return { item, hadOCR: false, error: true, hits: [] };
  }
}

export async function batchSearchOCR(
  items: ArchiveItem[],
  targets: string[],
  opts: { maxDist?: number; contextLines?: number; falsePositives?: string[]; concurrency?: number; delayMs?: number } = {}
): Promise<{ results: OCRSearchResult[]; stats: { total: number; withOCR: number; noOCR: number; errors: number; totalHits: number } }> {
  const { concurrency = 5, delayMs = 300, ...searchOpts } = opts;

  const results = await throttledBatch({
    items,
    concurrency,
    delayMs,
    fn: (item) => searchOCRText(item, targets, searchOpts),
  });

  const stats = {
    total: items.length,
    withOCR: results.filter(r => r.hadOCR).length,
    noOCR: results.filter(r => !r.hadOCR && !r.error).length,
    errors: results.filter(r => r.error).length,
    totalHits: results.reduce((sum, r) => sum + r.hits.length, 0),
  };

  return { results, stats };
}
