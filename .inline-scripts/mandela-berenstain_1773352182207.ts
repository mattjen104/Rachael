
const __ctx = JSON.parse(process.env.__INLINE_CTX || '{}');
const __projectRoot = process.env.__PROJECT_ROOT || process.cwd();
const __skillPath = (name: string) => __projectRoot + "/skills/" + name;

   const props = (typeof __ctx !== "undefined" && __ctx.properties) || {};
   const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
   const START_YEAR = parseInt(props.START_YEAR || "1985", 10);
   const END_YEAR = parseInt(props.END_YEAR || "2003", 10);
   const CONCURRENCY = parseInt(props.CONCURRENCY || "5", 10);

   const { searchArchive, batchSearchOCR } = await import(__skillPath("archive-toolkit"));
   const { levenshtein, soundex } = await import(__skillPath("fuzzy-match"));
   const { rfetchJSON } = await import(__skillPath("resilient-fetch"));

   const TARGETS = ["berenstain", "berenstein"];

   const MODELS = ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o-mini", "google/gemma-3-12b-it:free"];

   async function callLLM(prompt: string): Promise<string> {
     if (!OPENROUTER_KEY) return "(no API key)";
     for (const model of MODELS) {
       try {
         const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
           method: "POST",
           headers: { "Authorization": "Bearer " + OPENROUTER_KEY, "Content-Type": "application/json" },
           body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 1200 }),
         });
         const d = await r.json();
         if (d.choices?.[0]?.message?.content) return d.choices[0].message.content;
       } catch {}
     }
     return "(LLM unavailable)";
   }

   async function execute() {
     const t0 = Date.now();

     const tvGuides = await searchArchive({
       query: "title:(tv guide)",
       mediatype: "texts",
       yearRange: [START_YEAR, END_YEAR],
       maxRows: 500,
     });

     const newspapers = await searchArchive({
       query: "title:(tv listings OR television schedule OR tv schedule OR tv week) berenstain OR berenstein",
       mediatype: "texts",
       yearRange: [START_YEAR, END_YEAR],
       maxRows: 200,
     });

     const allItems: ArchiveItem[] = [];
     const seenIds = new Set<string>();
     for (const item of [...tvGuides, ...newspapers]) {
       if (!seenIds.has(item.identifier)) {
         seenIds.add(item.identifier);
         allItems.push(item);
       }
     }

     const { results, stats } = await batchSearchOCR(allItems, TARGETS, {
       maxDist: 2,
       contextLines: 2,
       concurrency: CONCURRENCY,
       delayMs: 300,
     });

     for (const r of results) {
       r.hits = r.hits.filter(h => {
         const ctx = (h.context || "").toLowerCase();
         return ctx.includes("bears") || ctx.includes("bear ");
       });
     }
     stats.totalHits = results.reduce((s, r) => s + r.hits.length, 0);

     interface Tally { exact: number; fuzzy: number; examples: Array<{ matched: string; context: string; year: number; issue: string; distance: number }> }
     const variantTally = new Map<string, Tally>();
     const byYear: Record<number, Record<string, number>> = {};

     for (const r of results) {
       for (const h of r.hits) {
         const normalized = h.matched.toLowerCase();
         let variant = h.exact ? (normalized.includes("berenstein") ? "Berenstein" : "Berenstain") : "Fuzzy:" + h.matched;

         for (const known of ["berenstain", "berenstein", "berenstien", "beranstain", "beranstein", "bernstain"]) {
           if (levenshtein(normalized, known) <= 1) { variant = known.charAt(0).toUpperCase() + known.slice(1); break; }
         }

         if (!variantTally.has(variant)) variantTally.set(variant, { exact: 0, fuzzy: 0, examples: [] });
         const t = variantTally.get(variant)!;
         if (h.exact || h.distance === 0) t.exact++; else t.fuzzy++;
         if (t.examples.length < 5) {
           t.examples.push({ matched: h.matched, context: h.context, year: r.item.year, issue: r.item.title, distance: h.distance });
         }

         const y = r.item.year;
         if (!byYear[y]) byYear[y] = {};
         byYear[y][variant] = (byYear[y][variant] || 0) + 1;
       }
     }

     const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
     let report = "MANDELA EFFECT: BERENSTAIN BEARS SPELLING ANALYSIS\n";
     report += "Sources: Internet Archive TV Guide + newspaper/TV listing scans (" + START_YEAR + "-" + END_YEAR + ")\n\n";
     report += "Items searched: " + stats.total + " | With OCR: " + stats.withOCR + " | No OCR: " + stats.noOCR + " | Errors: " + stats.errors + "\n";
     report += "Total hits: " + stats.totalHits + " (exact + fuzzy dist<=2, filtered: must mention bears) | Time: " + elapsed + "s\n";
     report += "Soundex Berenstain=" + soundex("Berenstain") + " Berenstein=" + soundex("Berenstein") + " (identical = phonetically ambiguous)\n\n";

     report += "SPELLING TALLY\n";
     const sorted = [...variantTally.entries()].sort((a, b) => (b[1].exact + b[1].fuzzy) - (a[1].exact + a[1].fuzzy));
     if (sorted.length === 0) report += "  No mentions found.\n";
     for (const [variant, data] of sorted) {
       const total = data.exact + data.fuzzy;
       const pctE = stats.totalHits > 0 ? ((data.exact / stats.totalHits) * 100).toFixed(1) : "0";
       report += "  " + variant + ": " + total + " (" + data.exact + " exact, " + data.fuzzy + " fuzzy) " + pctE + "% of total\n";
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
         report += "  " + ex.year + " | " + ex.issue.slice(0, 55) + "\n";
         report += "    Match: " + ex.matched + " (distance: " + ex.distance + ")\n";
         report += "    Context: " + ex.context.slice(0, 250) + "\n";
       }
     }

     if (stats.totalHits > 0) {
       const analysisData = sorted.map(([v, d]) => v + ": " + (d.exact + d.fuzzy) + " (" + d.exact + " exact, " + d.fuzzy + " fuzzy)").join(", ");
       const yearData = Object.entries(byYear).sort().map(([y, vs]) => y + ": " + Object.entries(vs).map(([v, c]) => v + "=" + c).join(", ")).join("; ");
       const analysis = await callLLM(
         "Mandela Effect research. Scanned " + stats.withOCR + " digitized items (" + START_YEAR + "-" + END_YEAR + ") from Internet Archive, including TV Guides and newspapers.\n\n" +
         "Used fuzzy matching (Levenshtein distance <= 2) to catch OCR garbles.\n" +
         "Spelling counts: " + analysisData + "\nBy year: " + yearData + "\n\n" +
         "The correct spelling has ALWAYS been Berenstain. OCR frequently misreads characters.\n" +
         "Analyze: (1) Which fuzzy matches are likely genuine misprints vs OCR artifacts? " +
         "(2) Does the ratio of exact to fuzzy matches tell us about print quality vs actual misspellings? " +
         "(3) Could OCR errors create false Mandela Effect evidence? " +
         "(4) Rate the evidence quality on a 1-10 scale. " +
         "(5) Suggest 3 specific follow-up research steps to expand this dataset."
       );
       report += "\nAI ANALYSIS\n" + analysis;
     }

     return { summary: report, metric: String(stats.totalHits) };
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
