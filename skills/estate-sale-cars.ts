interface SkillContext {
  orgContent: string;
  programName: string;
  lastResults: string;
  iteration: number;
}

interface SkillResult {
  summary: string;
  metric?: string;
}

interface CarListing {
  title: string;
  price: string;
  location: string;
  saleDate: string;
  url: string;
  source: string;
}

const VEHICLE_KEYWORDS = [
  "car", "truck", "vehicle", "automobile", "suv", "van", "motorcycle",
  "sedan", "coupe", "convertible", "pickup", "jeep", "mustang", "camaro",
  "corvette", "ford", "chevy", "chevrolet", "toyota", "honda", "dodge",
  "bmw", "mercedes", "porsche", "cadillac", "buick", "oldsmobile",
  "pontiac", "lincoln", "chrysler", "plymouth", "vin", "mileage",
  "engine", "transmission", "4x4", "4wd", "awd",
];

function looksLikeVehicle(text: string): boolean {
  const lower = text.toLowerCase();
  return VEHICLE_KEYWORDS.some(kw => lower.includes(kw));
}

async function scrapeEstateSalesNet(): Promise<CarListing[]> {
  const results: CarListing[] = [];
  try {
    const res = await fetch("https://www.estatesales.net/estate-sales/search?q=car+truck+vehicle&type=sale", {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OrgCloudBot/1.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return results;
    const html = await res.text();

    const salePattern = /<a[^>]*href="(\/estate-sales\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
    let match;
    while ((match = salePattern.exec(html)) !== null) {
      const [, path, title] = match;
      if (looksLikeVehicle(title)) {
        results.push({
          title: title.trim(),
          price: "See listing",
          location: "US",
          saleDate: "See listing",
          url: `https://www.estatesales.net${path}`,
          source: "estatesales.net",
        });
      }
    }
  } catch (e: any) {
    console.warn("[estate-sale-cars] estatesales.net error:", e.message);
  }
  return results;
}

async function scrapeHiBid(): Promise<CarListing[]> {
  const results: CarListing[] = [];
  const queries = ["estate+car", "estate+truck", "estate+vehicle"];

  for (const q of queries) {
    try {
      const res = await fetch(`https://www.hibid.com/search?q=${q}&type=lots`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; OrgCloudBot/1.0)",
          "Accept": "text/html,application/xhtml+xml",
        },
      });
      if (!res.ok) continue;
      const html = await res.text();

      const lotPattern = /<a[^>]*href="(\/lots\/[^"]+)"[^>]*>\s*<[^>]*>([^<]*)<\/[^>]*>/gi;
      let match;
      while ((match = lotPattern.exec(html)) !== null) {
        const [, path, title] = match;
        if (title && looksLikeVehicle(title)) {
          results.push({
            title: title.trim(),
            price: "Auction",
            location: "US",
            saleDate: "See listing",
            url: `https://www.hibid.com${path}`,
            source: "hibid.com",
          });
        }
      }
    } catch (e: any) {
      console.warn("[estate-sale-cars] hibid.com error:", e.message);
    }
  }
  return results;
}

async function scrapeAuctionZip(): Promise<CarListing[]> {
  const results: CarListing[] = [];
  try {
    const res = await fetch("https://www.auctionzip.com/cgi-bin/auctionsearch.cgi?kwd=estate+car+truck&category=150", {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OrgCloudBot/1.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return results;
    const html = await res.text();

    const auctionPattern = /<a[^>]*href="(\/auction-catalog\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
    let match;
    while ((match = auctionPattern.exec(html)) !== null) {
      const [, path, title] = match;
      if (looksLikeVehicle(title)) {
        results.push({
          title: title.trim(),
          price: "Auction",
          location: "US",
          saleDate: "See listing",
          url: `https://www.auctionzip.com${path}`,
          source: "auctionzip.com",
        });
      }
    }
  } catch (e: any) {
    console.warn("[estate-sale-cars] auctionzip.com error:", e.message);
  }
  return results;
}

async function scrapeGSAAuctions(): Promise<CarListing[]> {
  const results: CarListing[] = [];
  try {
    const res = await fetch("https://gsaauctions.gov/gsaauctions/aucdsclnk?sl=71QSCI26047001", {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OrgCloudBot/1.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return results;
    const html = await res.text();

    const itemPattern = /<a[^>]*href="([^"]*aucdsclnk[^"]*)"[^>]*>([^<]+)<\/a>/gi;
    let match;
    while ((match = itemPattern.exec(html)) !== null) {
      const [, path, title] = match;
      if (looksLikeVehicle(title)) {
        results.push({
          title: title.trim(),
          price: "Gov Auction",
          location: "US",
          saleDate: "See listing",
          url: path.startsWith("http") ? path : `https://gsaauctions.gov${path}`,
          source: "gsaauctions.gov",
        });
      }
    }
  } catch (e: any) {
    console.warn("[estate-sale-cars] gsaauctions.gov error:", e.message);
  }
  return results;
}

function deduplicateListings(listings: CarListing[]): CarListing[] {
  const seen = new Set<string>();
  return listings.filter(l => {
    const key = `${l.title.toLowerCase().trim()}|${l.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default async function execute(context: SkillContext): Promise<SkillResult> {
  const startTime = Date.now();

  const [estatesales, hibid, auctionzip, gsa] = await Promise.all([
    scrapeEstateSalesNet(),
    scrapeHiBid(),
    scrapeAuctionZip(),
    scrapeGSAAuctions(),
  ]);

  const allListings = deduplicateListings([
    ...estatesales, ...hibid, ...auctionzip, ...gsa,
  ]);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const sourceCounts: Record<string, number> = {};
  for (const l of allListings) {
    sourceCounts[l.source] = (sourceCounts[l.source] || 0) + 1;
  }

  const sourceBreakdown = Object.entries(sourceCounts)
    .map(([s, c]) => `${s}: ${c}`)
    .join(", ");

  let summary = `Scraped 4 sources in ${elapsed}s. Found ${allListings.length} vehicle listings.`;
  if (sourceBreakdown) summary += ` (${sourceBreakdown})`;

  if (allListings.length > 0) {
    summary += "\n\nTop finds:";
    for (const l of allListings.slice(0, 15)) {
      summary += `\n- ${l.title} | ${l.price} | ${l.source} | ${l.url}`;
    }
  } else {
    summary += "\n\nNo vehicle listings found this run. Sites may have changed layouts or blocked scraping.";
  }

  if (allListings.length > 15) {
    summary += `\n\n... and ${allListings.length - 15} more.`;
  }

  return {
    summary,
    metric: String(allListings.length),
  };
}
