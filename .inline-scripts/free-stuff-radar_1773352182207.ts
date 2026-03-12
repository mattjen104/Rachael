
const __ctx = JSON.parse(process.env.__INLINE_CTX || '{}');
const __projectRoot = process.env.__PROJECT_ROOT || process.cwd();
const __skillPath = (name: string) => __projectRoot + "/skills/" + name;

   const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
   const CL_REGION = props.CL_REGION || "inlandempire";
   const KEYWORDS = (props.KEYWORDS || "furniture,tools,electronics").split(",").map(k => k.trim().toLowerCase());

   async function execute() {
     const items: {title: string; url: string}[] = [];
     try {
       const r = await fetch("https://" + CL_REGION + ".craigslist.org/search/zip", {
         headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
       });
       const html = await r.text();
       const re = new RegExp("href=\\"(https://[^\\"]*craigslist[^\\"]+)\\"[^>]*>[\\\\s\\\\S]*?class=\\"title\\">([^<]+)", "gi");
       let m;
       while ((m = re.exec(html)) !== null) {
         const title = m[2].trim();
         if (KEYWORDS.some(kw => title.toLowerCase().includes(kw))) {
           items.push({ title, url: m[1] });
         }
       }
     } catch {}
     let summary = "Free stuff (" + CL_REGION + "): " + items.length + " keyword matches";
     for (const item of items.slice(0, 15)) summary += "\n- " + item.title + " " + item.url;
     if (items.length === 0) summary += "\nNo matches this scan.";
     return { summary, metric: String(items.length) };
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
