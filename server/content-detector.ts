export interface ContentDetection {
  type: "url" | "image" | "gif" | "code" | "text";
  url?: string;
  domain?: string;
}

export interface UrlMetadata {
  title?: string;
  description?: string;
  image?: string;
  domain: string;
  contentType?: string;
}

const IMAGE_EXTENSIONS = /\.(gif|png|jpg|jpeg|webp|svg|bmp)(\?.*)?$/i;
const GIF_EXTENSION = /\.gif(\?.*)?$/i;
const IMAGE_HOSTS = ["giphy.com", "imgur.com", "tenor.com", "i.imgur.com", "media.giphy.com", "i.redd.it"];

const CODE_PATTERNS = [
  /\bfunction\s+\w+/,
  /\bconst\s+\w+\s*=/,
  /\blet\s+\w+\s*=/,
  /\bvar\s+\w+\s*=/,
  /\bimport\s+/,
  /\bexport\s+(default\s+)?/,
  /\bclass\s+\w+/,
  /\bdef\s+\w+/,
  /=>\s*\{/,
  /\breturn\s+/,
];

export function detectContentType(content: string): ContentDetection {
  const trimmed = content.trim();

  const urlMatch = trimmed.match(/^(https?:\/\/\S+)/i);
  if (urlMatch) {
    const url = urlMatch[1];
    let domain: string;
    try {
      domain = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      domain = "";
    }

    if (GIF_EXTENSION.test(url) || (IMAGE_HOSTS.some(h => domain.includes(h)) && url.includes("gif"))) {
      return { type: "gif", url, domain };
    }

    if (IMAGE_EXTENSIONS.test(url) || IMAGE_HOSTS.some(h => domain.includes(h))) {
      return { type: "image", url, domain };
    }

    return { type: "url", url, domain };
  }

  let codeScore = 0;
  for (const pattern of CODE_PATTERNS) {
    if (pattern.test(trimmed)) codeScore++;
  }
  if (codeScore >= 2 || (trimmed.includes("{") && trimmed.includes("}") && codeScore >= 1)) {
    return { type: "code" };
  }

  return { type: "text" };
}

export async function fetchUrlMetadata(url: string): Promise<UrlMetadata> {
  let domain: string;
  try {
    domain = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    domain = url;
  }

  const result: UrlMetadata = { domain };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OrgCloudBot/1.0)",
        "Accept": "text/html,application/xhtml+xml,*/*",
      },
      redirect: "follow",
    });

    clearTimeout(timeout);

    const responseContentType = response.headers.get("content-type") || "";
    result.contentType = responseContentType;

    if (responseContentType.startsWith("image/")) {
      result.title = `Image from ${domain}`;
      return result;
    }

    if (!responseContentType.includes("text/html")) {
      result.title = `File from ${domain}`;
      return result;
    }

    const html = await response.text();

    const ogTitle = html.match(/<meta\s+(?:property|name)=["']og:title["']\s+content=["']([^"']+)["']/i);
    const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    result.title = ogTitle?.[1] || titleTag?.[1] || undefined;
    if (result.title) result.title = result.title.trim().slice(0, 200);

    const ogDesc = html.match(/<meta\s+(?:property|name)=["']og:description["']\s+content=["']([^"']+)["']/i);
    const metaDesc = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
    result.description = ogDesc?.[1] || metaDesc?.[1] || undefined;
    if (result.description) result.description = result.description.trim().slice(0, 300);

    const ogImage = html.match(/<meta\s+(?:property|name)=["']og:image["']\s+content=["']([^"']+)["']/i);
    result.image = ogImage?.[1] || undefined;

  } catch {
    // timeout or fetch error — return partial data
  }

  return result;
}
