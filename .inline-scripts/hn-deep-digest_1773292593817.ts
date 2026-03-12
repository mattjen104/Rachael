
const __ctx = JSON.parse(process.env.__INLINE_CTX || '{}');

   const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
   const TOP_N = parseInt(props.TOP_N || "12", 10);
   const COMMENTS_PER = parseInt(props.COMMENTS_PER_STORY || "15", 10);
   const KEYWORDS = (props.KEYWORDS || "autonomous agent,llm,emacs").split(",").map((k: string) => k.trim().toLowerCase());
   const LLM_MODEL = props.LLM_MODEL || "google/gemma-3-12b-it:free";
   const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";

   interface Story { id: number; title: string; url: string; score: number; descendants: number; relevance: number; }
   interface Comment { id: number; by: string; text: string; kids?: number[]; }

   async function hnGet(path: string): Promise<any> {
     const r = await fetch("https://hacker-news.firebaseio.com/v0/" + path + ".json");
     return r.json();
   }

   async function fetchBatch(ids: number[]): Promise<any[]> {
     const results: any[] = [];
     for (let i = 0; i < ids.length; i += 10) {
       const batch = await Promise.all(ids.slice(i, i + 10).map(id => hnGet("item/" + id)));
       results.push(...batch.filter(Boolean));
     }
     return results;
   }

   async function getTopComments(storyId: number, limit: number): Promise<Comment[]> {
     const story = await hnGet("item/" + storyId);
     if (!story || !story.kids || story.kids.length === 0) return [];
     const topKids = story.kids.slice(0, limit);
     const comments = await fetchBatch(topKids);
     return comments.filter((c: any) => c.type === "comment" && c.text).map((c: any) => ({
       id: c.id, by: c.by || "anon", text: c.text.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/g, " ").slice(0, 600),
       kids: c.kids,
     }));
   }

   function stripHtml(s: string): string { return s.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim(); }

   const FREE_MODELS = [
     LLM_MODEL,
     "mistralai/mistral-small-3.1-24b-instruct:free",
     "meta-llama/llama-3.2-3b-instruct:free",
     "google/gemma-3-4b-it:free",
     "qwen/qwen3-4b:free",
     "nvidia/nemotron-nano-9b-v2:free",
     "openai/gpt-oss-20b:free",
   ];

   async function callFreeLLM(prompt: string): Promise<string> {
     if (!OPENROUTER_KEY) return "[no API key — skipped LLM synthesis]";
     for (const model of FREE_MODELS) {
       try {
         const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
           method: "POST",
           headers: { "Authorization": "Bearer " + OPENROUTER_KEY, "Content-Type": "application/json" },
           body: JSON.stringify({
             model,
             messages: [{ role: "user", content: prompt }],
             max_tokens: 400,
             temperature: 0.3,
           }),
         });
         const data = await r.json();
         const text = data.choices?.[0]?.message?.content?.trim();
         if (text) return text;
         if (data.error?.code === 429) { await new Promise(r => setTimeout(r, 2000)); continue; }
         if (data.error) continue;
       } catch { continue; }
     }
     return "[all free models rate-limited — retry later]";
   }

   async function execute() {
     const t0 = Date.now();

     // 1. Fetch top + best stories
     const [topIds, bestIds] = await Promise.all([hnGet("topstories"), hnGet("beststories")]);
     const seen = new Set<number>();
     const allIds: number[] = [];
     for (const id of [...topIds.slice(0, 60), ...bestIds.slice(0, 40)]) {
       if (!seen.has(id)) { seen.add(id); allIds.push(id); }
     }

     const items = await fetchBatch(allIds);

     // 2. Score and rank
     const scored: Story[] = items
       .filter((s: any) => s.type === "story" && s.title && (s.descendants || 0) >= 5)
       .map((s: any) => {
         const lower = s.title.toLowerCase();
         const relevance = KEYWORDS.reduce((acc: number, kw: string) => acc + (lower.includes(kw) ? 2 : 0), 0);
         return { id: s.id, title: s.title, url: s.url || "https://news.ycombinator.com/item?id=" + s.id, score: s.score || 0, descendants: s.descendants || 0, relevance };
       })
       .sort((a: Story, b: Story) => (b.relevance + b.score / 100) - (a.relevance + a.score / 100))
       .slice(0, TOP_N);

     // 3. Fetch comments and synthesize each
     const digests: string[] = [];
     let synthesized = 0;

     for (const story of scored) {
       const comments = await getTopComments(story.id, COMMENTS_PER);
       const commentText = comments.map((c: Comment) => c.by + ": " + c.text).join("\n");

       let synthesis: string;
       if (comments.length < 3) {
         synthesis = "(too few comments to synthesize)";
       } else {
         synthesis = await callFreeLLM(
           "You are summarizing a Hacker News discussion. Be concise (4-6 lines max).\n\n" +
           "Story: " + story.title + "\nURL: " + story.url + "\n" +
           story.score + " points, " + story.descendants + " comments\n\n" +
           "Top comments:\n" + commentText.slice(0, 3000) + "\n\n" +
           "Respond with exactly:\nCONSENSUS: (what most commenters agree on, 1-2 sentences)\nCONTRARIAN: (the strongest dissenting view, 1-2 sentences)\nACTIONABLE: (any useful links, tools, or advice mentioned in comments, or \"none\")"
         );
         synthesized++;
       }

       const tag = story.relevance > 0 ? "[RELEVANT]" : "";
       digests.push(
         "--- " + tag + " " + story.title + " ---\n" +
         "    " + story.url + " | " + story.score + "pts | " + story.descendants + "c\n" +
         synthesis
       );

       // Rate limit: small pause between LLM calls
       if (comments.length >= 3) await new Promise(r => setTimeout(r, 1500));
     }

     const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
     const header = "=== HN Deep Digest (" + scored.length + " stories, " + synthesized + " synthesized, " + elapsed + "s) ===";
     const summary = header + "\n\n" + digests.join("\n\n");

     return { summary, metric: String(synthesized) };
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
