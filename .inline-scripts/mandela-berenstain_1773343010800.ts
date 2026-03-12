
const __ctx = JSON.parse(process.env.__INLINE_CTX || '{}');

   const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
   const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
   const START_YEAR = parseInt(props.START_YEAR || "1985", 10);
   const END_YEAR = parseInt(props.END_YEAR || "2003", 10);
   const CONCURRENCY = parseInt(props.CONCURRENCY || "5", 10);

   const MODELS = ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o-mini", "google/gemma-3-12b-it:free"];

   const SPELLING_PATTERNS: Array<{ label: string; re: RegExp }> = [
     { label: "Berenstain", re: /\bberenstain\b(?:\s+bears?)?/gi },
     { label: "Berenstein", re: /\bberenstein\b(?:\s+bears?)?/gi },
     { label: "Berenstien", re: /\bberenstien\b(?:\s+bears?)?/gi },
     { label: "Beranstain", re: /\bberanstain\b(?:\s+bears?)?/gi },
     { label: "Beranstein", re: /\bberanstein\b(?:\s+bears?)?/gi },
     { label: "Bernstain",  re: /\bbernstain\b(?:\s+bears?)?/gi },
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
     const q = encodeURIComponent("title:(tv guide) mediatype:(texts) year:[" + START_YEAR + " TO " + END_YEAR + "]");
     const url = "https://archive.org/advancedsearch.php?q=" + q + "&fl=identifier,title,year&output=json&rows=500&sort=year+asc";
     const d = await fetchJSON(url);
     return (d.response?.docs || []).map((doc: any) => ({ identifier: doc.identifier, title: doc.title || doc.identifier, year: parseInt(doc.year, 10) || 0 }));
   }

   async function processIssue(issue: TVGuideItem): Promise<{ mentions: Mention[]; hadOCR: boolean; error: boolean }> {
     try {
       const meta = await fetchJSON("https://archive.org/metadata/" + issue.identifier + "/files");
       const files = meta.result || [];
       const txtFile = files.find((f: any) => f.name.endsWith("_djvu.txt"));
       if (!txtFile) return { mentions: [], hadOCR: false, error: false };
       const text = await fetchText("https://archive.org/download/" + issue.identifier + "/" + encodeURIComponent(txtFile.name));
       return { mentions: searchText(text, issue), hadOCR: true, error: false };
     } catch { return { mentions: [], hadOCR: false, error: true }; }
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
       if (!lower.includes("beren") && !lower.includes("bernst")) continue;
       if (isFalsePositive(lower)) continue;
       const ctxArr = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3));
       const context = ctxArr.join(" | ").slice(0, 400);
       for (const pat of SPELLING_PATTERNS) {
         pat.re.lastIndex = 0;
         let m;
         while ((m = pat.re.exec(line)) !== null) {
           const neighborhood = line.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
           if (isFalsePositive(neighborhood)) continue;
           const key = i + "|" + m.index + "|" + m[0].toLowerCase();
           if (seen.has(key)) continue;
           seen.add(key);
           mentions.push({ variant: pat.label, matched: m[0], context, issue: issue.title, year: issue.year, lineNum: i });
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
     let issuesWithOCR = 0;
     let fetchErrors = 0;
     let noOCR = 0;
     for (let i = 0; i < issues.length; i += CONCURRENCY) {
       const batch = issues.slice(i, i + CONCURRENCY);
       const results = await Promise.all(batch.map(issue => processIssue(issue)));
       for (const r of results) {
         if (r.error) fetchErrors++;
         else if (!r.hadOCR) noOCR++;
         else issuesWithOCR++;
         allMentions.push(...r.mentions);
       }
       if (i + CONCURRENCY < issues.length) await new Promise(r => setTimeout(r, 300));
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
     report += "Issues found: " + issues.length + " | With OCR: " + issuesWithOCR + " | No OCR: " + noOCR + " | Errors: " + fetchErrors + "\n";
     report += "Total mentions found: " + allMentions.length + " | Time: " + elapsed + "s\n\n";
     report += "SPELLING TALLY\n";
     const sorted = Object.entries(tally).sort((a, b) => b[1].count - a[1].count);
     if (sorted.length === 0) report += "  No Berenstain/Berenstein mentions found.\n";
     for (const [variant, data] of sorted) {
       const pct = allMentions.length > 0 ? ((data.count / allMentions.length) * 100).toFixed(1) : "0";
       report += "  " + variant + ": " + data.count + " (" + pct + "%)\n";
     }
     if (Object.keys(byYear).length > 0) {
       report += "\nBY YEAR\n";
       for (const year of Object.keys(byYear).sort()) {
         const variants = byYear[parseInt(year)];
         report += "  " + year + ": " + Object.entries(variants).map(([v, c]) => v + "=" + c).join(", ") + "\n";
       }
     }
     report += "\nSAMPLE MENTIONS\n";
     for (const [variant, data] of sorted) {
       report += "\n[" + variant + "]\n";
       for (const ex of data.examples) {
         report += "  " + ex.year + " | " + ex.issue.slice(0, 55) + "\n    Match: " + ex.matched + "\n    Context: " + ex.context.slice(0, 250) + "\n";
       }
     }
     if (allMentions.length > 0) {
       const analysisData = sorted.map(([v, d]) => v + ": " + d.count).join(", ");
       const yearData = Object.entries(byYear).sort().map(([y, vs]) => y + ": " + Object.entries(vs).map(([v, c]) => v + "=" + c).join(", ")).join("; ");
       const analysis = await callLLM(
         "Mandela Effect research. Scanned " + issuesWithOCR + " digitized TV Guide issues (" + START_YEAR + "-" + END_YEAR + ") from Internet Archive.\n\n" +
         "Spelling counts: " + analysisData + "\nBy year: " + yearData + "\n\n" +
         "The correct spelling has ALWAYS been Berenstain. OCR can misread letters.\n" +
         "Analyze: (1) Genuine misprints vs OCR errors? (2) Spelling consistency? (3) Could OCR errors create false Mandela Effect evidence? (4) Evidence quality? (5) 3 follow-up research steps."
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
