import { humanDelay, setDomainGap } from "./resilient-fetch";

export interface RedditPost {
  id: string;
  title: string;
  url: string;
  permalink: string;
  subreddit: string;
  author: string;
  score: number;
  numComments: number;
  selftext: string;
  created: number;
  flair: string;
  isself: boolean;
}

export interface RedditSearchOpts {
  subreddit: string;
  sort?: "hot" | "new" | "top" | "rising";
  time?: "hour" | "day" | "week" | "month" | "year" | "all";
  limit?: number;
}

export interface RedditComment {
  author: string;
  body: string;
  score: number;
}

const REDDIT_DOMAIN = "www.reddit.com";
const UA = "OrgCloud:agent-intel:v1.0 (by /u/orgcloud_bot)";

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function decodeEntities(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'");
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function extractIdFromPermalink(permalink: string): string {
  const m = permalink.match(/\/comments\/([a-z0-9]+)\//);
  return m ? m[1] : "";
}

function parseAtomFeed(xml: string, subreddit: string): RedditPost[] {
  const posts: RedditPost[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];

    const titleMatch = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : "";

    const linkMatch = entry.match(/<link[^>]*href="([^"]*)"[^>]*\/>/);
    const permalink = linkMatch ? linkMatch[1] : "";

    const authorMatch = entry.match(/<name>\/u\/([^<]*)<\/name>/);
    const author = authorMatch ? authorMatch[1] : "[deleted]";

    const contentMatch = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/);
    const rawContent = contentMatch ? decodeEntities(contentMatch[1]) : "";
    const selftext = stripHtml(rawContent).slice(0, 500);

    const updatedMatch = entry.match(/<updated>([^<]*)<\/updated>/);
    const created = updatedMatch ? Math.floor(new Date(updatedMatch[1]).getTime() / 1000) : 0;

    const contentLinkMatch = rawContent.match(/\[link\]\s*\(<a href="([^"]+)">/);
    const externalUrl = contentLinkMatch ? contentLinkMatch[1] : permalink;

    const id = extractIdFromPermalink(permalink);
    const isself = !contentLinkMatch || externalUrl.includes("reddit.com/r/");

    if (title && permalink) {
      posts.push({
        id,
        title,
        url: isself ? permalink : externalUrl,
        permalink,
        subreddit,
        author,
        score: 0,
        numComments: 0,
        selftext: isself ? selftext : "",
        created,
        flair: "",
        isself,
      });
    }
  }
  return posts;
}

async function fetchViaRSS(subreddit: string, sort: string, limit: number): Promise<RedditPost[]> {
  const url = `https://${REDDIT_DOMAIN}/r/${subreddit}/${sort}.rss?limit=${limit}`;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": UA },
    });
    if (!resp.ok) {
      console.error(`[reddit-toolkit] RSS r/${subreddit} returned ${resp.status}`);
      return [];
    }
    const xml = await resp.text();
    return parseAtomFeed(xml, subreddit);
  } catch (err: any) {
    console.error(`[reddit-toolkit] RSS error r/${subreddit}:`, err.message);
    return [];
  }
}

async function fetchViaJSON(subreddit: string, sort: string, time: string, limit: number): Promise<RedditPost[]> {
  const timeParam = (sort === "top" || sort === "new") ? `&t=${time}` : "";
  const url = `https://${REDDIT_DOMAIN}/r/${subreddit}/${sort}.json?limit=${limit}${timeParam}&raw_json=1`;
  try {
    const resp = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": UA,
      },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const children = data?.data?.children || [];
    return children
      .filter((c: any) => c.kind === "t3" && c.data)
      .map((c: any) => {
        const d = c.data;
        return {
          id: d.id || "",
          title: decodeEntities(d.title || ""),
          url: d.url || "",
          permalink: `https://reddit.com${d.permalink || ""}`,
          subreddit: d.subreddit || subreddit,
          author: d.author || "[deleted]",
          score: d.score || 0,
          numComments: d.num_comments || 0,
          selftext: (d.selftext || "").slice(0, 500),
          created: d.created_utc || 0,
          flair: d.link_flair_text || "",
          isself: !!d.is_self,
        } as RedditPost;
      });
  } catch {
    return [];
  }
}

export async function fetchSubreddit(opts: RedditSearchOpts): Promise<RedditPost[]> {
  const { subreddit, sort = "hot", time = "day", limit = 25 } = opts;
  setDomainGap(REDDIT_DOMAIN, 800);

  let posts = await fetchViaJSON(subreddit, sort, time, limit);

  if (posts.length === 0) {
    posts = await fetchViaRSS(subreddit, sort, limit);
    if (posts.length > 0) {
      console.error(`[reddit-toolkit] r/${subreddit}: JSON blocked, RSS fallback got ${posts.length} posts`);
    }
  }
  return posts;
}

export async function fetchPostComments(permalink: string, limit: number = 10): Promise<RedditComment[]> {
  setDomainGap(REDDIT_DOMAIN, 800);
  await sleep(humanDelay(400));

  const cleanPermalink = permalink.replace(/\/$/, "");
  const url = `https://${REDDIT_DOMAIN}${cleanPermalink.replace("https://reddit.com", "")}.json?limit=${limit}&sort=top&raw_json=1`;

  try {
    const resp = await fetch(url, { headers: { "Accept": "application/json", "User-Agent": UA } });
    if (!resp.ok) return [];
    const data = await resp.json();

    if (!Array.isArray(data) || data.length < 2) return [];
    const commentListing = data[1]?.data?.children || [];

    return commentListing
      .filter((c: any) => c.kind === "t1" && c.data && !c.data.stickied)
      .slice(0, limit)
      .map((c: any) => ({
        author: c.data.author || "[deleted]",
        body: decodeEntities((c.data.body || "").slice(0, 400)),
        score: c.data.score || 0,
      }));
  } catch {
    return [];
  }
}

export async function fetchMultipleSubreddits(
  subreddits: string[],
  opts: Omit<RedditSearchOpts, "subreddit"> = {}
): Promise<RedditPost[]> {
  const allPosts: RedditPost[] = [];
  for (const sub of subreddits) {
    const posts = await fetchSubreddit({ subreddit: sub, ...opts });
    allPosts.push(...posts);
    if (sub !== subreddits[subreddits.length - 1]) await sleep(humanDelay(600));
  }
  return allPosts;
}

export function dedupeByTitle(posts: RedditPost[], threshold: number = 0.85): RedditPost[] {
  const seen: string[] = [];
  return posts.filter(p => {
    const norm = p.title.toLowerCase().replace(/[^a-z0-9 ]/g, "");
    for (const s of seen) {
      if (norm === s) return false;
      const overlap = norm.split(" ").filter(w => s.includes(w)).length;
      const total = Math.max(norm.split(" ").length, s.split(" ").length);
      if (total > 0 && overlap / total > threshold) return false;
    }
    seen.push(norm);
    return true;
  });
}

export function filterByScore(posts: RedditPost[], minScore: number): RedditPost[] {
  return posts.filter(p => p.score >= minScore);
}

export function sortByScore(posts: RedditPost[]): RedditPost[] {
  return [...posts].sort((a, b) => b.score - a.score);
}
