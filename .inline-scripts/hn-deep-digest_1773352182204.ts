
const __ctx = JSON.parse(process.env.__INLINE_CTX || '{}');
const __projectRoot = process.env.__PROJECT_ROOT || process.cwd();
const __skillPath = (name: string) => __projectRoot + "/skills/" + name;

   const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
   const TOP_N = parseInt(props.TOP_N || "8", 10);
   const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
   const MODELS = ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4-20250514", "google/gemma-3-12b-it:free"];

   async function fetchHN(path: string) {
     return fetch("https://hacker-news.firebaseio.com/v0/" + path + ".json").then(r => r.json());
   }

   async function callLLM(prompt: string): Promise<string> {
     if (!OPENROUTER_KEY) return "[no API key]";
     for (const model of MODELS) {
       try {
         const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
           method: "POST",
           headers: { "Authorization": "Bearer " + OPENROUTER_KEY, "Content-Type": "application/json" },
           body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 1000, temperature: 0.3 }),
         });
         const d = await r.json();
         const text = d.choices?.[0]?.message?.content?.trim();
         if (text) return "[" + model.split("/").pop()!.split(":")[0] + "] " + text;
       } catch { continue; }
     }
     return "[models unavailable]";
   }

   async function getComments(storyId: number, limit: number): Promise<string[]> {
     const story = await fetchHN("item/" + storyId);
     const kidIds = (story.kids || []).slice(0, limit);
     const comments: string[] = [];
     for (const kid of kidIds) {
       try {
         const c = await fetchHN("item/" + kid);
         if (c && c.text && !c.deleted && !c.dead) {
           const clean = c.text.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
           if (clean.length > 20) comments.push((c.by || "anon") + ": " + clean.slice(0, 300));
         }
       } catch {}
     }
     return comments;
   }

   async function execute() {
     const t0 = Date.now();
     const topIds = await fetchHN("topstories");
     const stories: Array<{ title: string; url: string; score: number; by: string; id: number }> = [];

     for (const id of topIds.slice(0, 30)) {
       const s = await fetchHN("item/" + id);
       if (s && s.score >= 50) stories.push({ title: s.title, url: s.url || "", score: s.score, by: s.by, id: s.id });
       if (stories.length >= TOP_N) break;
     }

     let fullDigest = "HN Deep Digest (" + stories.length + " stories)\n\n";
     for (const story of stories) {
       const comments = await getComments(story.id, 8);
       const commentBlock = comments.length > 0 ? "\n\nTop comments:\n" + comments.map(c => "- " + c).join("\n") : "";

       const analysis = await callLLM(
         "Analyze this HN story and comments. Give:\n" +
         "CONSENSUS: What most commenters agree on (1-2 sentences)\n" +
         "CONTRARIAN: Any notable dissenting view (1 sentence)\n" +
         "ACTIONABLE: One thing a reader could do based on this (1 sentence)\n\n" +
         "Story: " + story.title + "\nURL: " + story.url + "\nScore: " + story.score + commentBlock
       );

       fullDigest += "[" + story.score + "] " + story.title + "\n  " + story.url + "\n" + analysis + "\n\n";
     }

     const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
     fullDigest = fullDigest.trim() + "\n\n(" + elapsed + "s)";
     return { summary: fullDigest, metric: String(stories.length) };
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
