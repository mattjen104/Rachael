
const __ctx = JSON.parse(process.env.__INLINE_CTX || '{}');

   const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
   const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
   const START_YEAR = parseInt(props.START_YEAR || "1985", 10);
   const END_YEAR = parseInt(props.END_YEAR || "2003", 10);
   const BATCH_DELAY = parseInt(props.BATCH_DELAY || "600", 10);

   const MODELS = [
     "anthropic/claude-sonnet-4-20250514",
     "openai/gpt-4o-mini",
     "google/gemma-3-12b-it:free",
   ];

   const SPELLING_PATTERNS: Array<{ label: string; re: RegExp }> = [
     { label: "Berenstain", re: /berenstain(?:\s+bears?)?/gi },
     { label: "Berenstein", re: /berenstein(?:\s+bears?)?/gi },
     { label: "Berenstien", re: /berenstien(?:\s+bears?)?/gi },
     { label: "Beranstain", re: /beranstain(?:\s+bears?)?/gi },
     { label: "Beranstein", re: /beranstein(?:\s+bears?)?/gi },
   ];

   const FALSE_POSITIVES = ["berenger", "berenson", "leonard bernstein", "carl bernstein", "elmer bernstein"];

   interface TVGuideItem { identifier: string; title: string; year: number; }
   interface Mention { variant: string; matched: string; context: string; issue: string; year: number; lineNum: number; }

   async function fetchJSON(url: string): Promise<any> {
     const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" } });
     return r.json();
   }

   async function fetchText(url: string): Promise<string> {
     const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" } });
     return r.text();
   }

   async function getIssueList(): Promise<TVGuideItem[]> {
     const q = encodeURIComponent("title:(\"tv guide\") mediatype:(texts) year:[" + START_YEAR + " TO " + END_YEAR + "]");
     const url = "https://archive.org/advancedsearch.php?q=" + q + "&fl=identifier,title,year&output=json&rows=500&sort=year+asc";
     const d = await fetchJSON(url);
     return (d.response?.docs || []).map((doc: any) => ({
       identifier: doc.identifier,
       title: doc.title || doc.identifier,
       year: parseInt(doc.year, 10) || 0,
     }));
   }

   async function getOCRText(identifier: string): Promise<string | null> {
     try {
       const meta = await fetchJSON("https://archive.org/metadata/" + identifier + "/files");
       const files = meta.result || [];
       const txtFile = files.find((f: any) => f.name.endsWith("_djvu.txt"));
       if (!txtFile) return null;
       return await fetchText("https://archive.org/download/" + identifier + "/" + encodeURIComponent(txtFile.name));
     } catch { return null; }
   }

   function isFalsePositive(ctx: string): boolean {
     const lower = ctx.toLowerCase();
     return FALSE_POSITIVES.some(fp => lower.includes(fp));
   }

   function searchText(text: string, issue: TVGuideItem): Mention[] {
     const mentions: Mention[] = [];
     const lines = text.split("\n");
     const seen = new Set<string>();

     for (let i = 0; i < lines.length; i++) {
       const line = lines[i];
       const lower = line.toLowerCase();
       if (!lower.includes("beren")) continue;
       if (isFalsePositive(lower)) continue;

       const ctxArr = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2));
       const context = ctxArr.join(" | ").slice(0, 300);

       for (const pat of SPELLING_PATTERNS) {
         pat.re.lastIndex = 0;
         let m;
         while ((m = pat.re.exec(line)) !== null) {
           const neighborhood = line.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30);
           if (isFalsePositive(neighborhood)) continue;
           const key = i + "|" + m[0].toLowerCase();
           if (seen.has(key)) continue;
           seen.add(key);
           mentions.push({
             variant: pat.label,
             matched: m[0],
             context,
             issue: issue.title,
             year: issue.year,
             lineNum: i,
           });
         }
       }
     }
     return mentions;
   }

   async function callLLM(prompt: string): Promise<string> {
     if (!OPENROUTER_KEY) return "[no API key]";
     for (const model of MODELS) {
       try {
         const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
           method: "POST",
           headers: { "Authorization": "Bearer " + OPENROUTER_KEY, "Content-Type": "application/json" },
           body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 1500, temperature: 0.3 }),
         });
         const d = await r.json();
         const text = d.choices?.[0]?.message?.content?.trim();
         if (text) return text;
       } catch { continue; }
     }
     return "[models unavailable]";
   }

   async function execute() {
     const t0 = Date.now();
     const issues = await getIssueList();
     if (issues.length === 0) return { summary: "Mandela-Berenstain: No TV Guide issues found", metric: "0" };

     const allMentions: Mention[] = [];
     let issuesScanned = 0;
     let errors = 0;

     for (const issue of issues) {
       try {
         const text = await getOCRText(issue.identifier);
         if (!text) { errors++; continue; }
         allMentions.push(...searchText(text, issue));
         issuesScanned++;
       } catch { errors++; }
       await new Promise(r => setTimeout(r, BATCH_DELAY));
     }

     const tally: Record<string, { count: number; examples: Mention[] }> = {};
     for (const m of allMentions) {
       if (!tally[m.variant]) tally[m.variant] = { count: 0, examples: [] };
       tally[m.variant].count++;
       if (tally[m.variant].examples.length < 5) tally[m.variant].examples.push(m);
     }

     const byYear: Record<number, Record<string, number>> = {};
     for (const m of allMentions) {
       if (!byYear[m.year]) byYear[m.year] = {};
       byYear[m.year][m.variant] = (byYear[m.year][m.variant] || 0) + 1;
     }

     const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
     let report = "MANDELA EFFECT: BERENSTAIN BEARS SPELLING IN TV GUIDE\n";
     report += "Source: Internet Archive digitized TV Guide scans (" + START_YEAR + "-" + END_YEAR + ")\n\n";
     report += "Scanned: " + issuesScanned + " issues with OCR text (of " + issues.length + " found, " + errors + " without OCR)\n";
     report += "Total mentions found: " + allMentions.length + "\n";
     report += "Time: " + elapsed + "s\n\n";

     report += "SPELLING TALLY\n";
     const sorted = Object.entries(tally).sort((a, b) => b[1].count - a[1].count);
     for (const [variant, data] of sorted) {
       const pct = allMentions.length > 0 ? ((data.count / allMentions.length) * 100).toFixed(1) : "0";
       report += "  " + variant + ": " + data.count + " (" + pct + "%)\n";
     }

     report += "\nBY YEAR\n";
     for (const year of Object.keys(byYear).sort()) {
       const variants = byYear[parseInt(year)];
       const parts = Object.entries(variants).map(([v, c]) => v + "=" + c);
       report += "  " + year + ": " + parts.join(", ") + "\n";
     }

     report += "\nSAMPLE MENTIONS\n";
     for (const [variant, data] of sorted) {
       report += "\n[" + variant + "]\n";
       for (const ex of data.examples) {
         report += "  " + ex.year + " | " + ex.issue.slice(0, 50) + "\n";
         report += "    Match: " + ex.matched + "\n";
         report += "    Context: " + ex.context.slice(0, 200) + "\n";
       }
     }

     if (allMentions.length > 0) {
       const analysisData = sorted.map(([v, d]) => v + ": " + d.count).join(", ");
       const yearData = Object.entries(byYear).sort().map(([y, vs]) =>
         y + ": " + Object.entries(vs).map(([v, c]) => v + "=" + c).join(", ")
       ).join("; ");

       const analysis = await callLLM(
         "You are a researcher studying the Mandela Effect (the widespread false memory that the Berenstain Bears were spelled Berenstein Bears).\n\n" +
         "I scanned " + issuesScanned + " digitized TV Guide issues (" + START_YEAR + "-" + END_YEAR + ") from the Internet Archive for all spelling variants. Results:\n\n" +
         analysisData + "\n\nYear-by-year: " + yearData + "\n\n" +
         "CONTEXT: The correct spelling has ALWAYS been Berenstain (the authors surname). OCR from old magazine scans can misread letters. The Berenstain Bears TV show aired on CBS 1985-1986, then PBS 2003.\n\n" +
         "Analyze: (1) Do the results show any genuine Berenstein misprints or only OCR errors? " +
         "(2) What does the consistency of spelling suggest? " +
         "(3) Implications for the Mandela Effect hypothesis? " +
         "(4) Rate evidence quality. (5) Suggest follow-up research."
       );
       report += "\nAI ANALYSIS\n" + analysis;
     }

     return { summary: report, metric: String(allMentions.length) };
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
