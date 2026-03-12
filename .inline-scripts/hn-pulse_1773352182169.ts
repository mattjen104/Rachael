
const __ctx = JSON.parse(process.env.__INLINE_CTX || '{}');
const __projectRoot = process.env.__PROJECT_ROOT || process.cwd();
const __skillPath = (name: string) => __projectRoot + "/skills/" + name;

   const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
   const SCORE_THRESHOLD = parseInt(props.SCORE_THRESHOLD || "100", 10);
   const MAX_STORIES = parseInt(props.MAX_STORIES || "10", 10);

   async function execute() {
     const topIds = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json").then(r => r.json());
     const stories = [];
     for (const id of topIds.slice(0, 30)) {
       const story = await fetch("https://hacker-news.firebaseio.com/v0/item/" + id + ".json").then(r => r.json());
       if (story && story.score >= SCORE_THRESHOLD) {
         stories.push({ title: story.title, url: story.url || "", score: story.score, by: story.by });
       }
       if (stories.length >= MAX_STORIES) break;
     }
     const summary = stories.map((s, i) => (i + 1) + ". [" + s.score + "] " + s.title + " (" + s.by + ")\n   " + s.url).join("\n");
     return { summary: "HN Pulse: " + stories.length + " stories above " + SCORE_THRESHOLD + " points\n" + summary, metric: String(stories.length) };
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
