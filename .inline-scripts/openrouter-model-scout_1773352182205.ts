
const __ctx = JSON.parse(process.env.__INLINE_CTX || '{}');
const __projectRoot = process.env.__PROJECT_ROOT || process.cwd();
const __skillPath = (name: string) => __projectRoot + "/skills/" + name;

   const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
   const FREE_MODELS = [
     "google/gemma-3-4b-it:free",
     "google/gemma-3-12b-it:free",
     "mistralai/mistral-small-3.1-24b-instruct:free",
     "meta-llama/llama-3.2-3b-instruct:free",
     "qwen/qwen3-4b:free",
   ];

   async function execute() {
     const results: Array<{ model: string; status: string; latency: number }> = [];
     for (const model of FREE_MODELS) {
       const t0 = Date.now();
       try {
         const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
           method: "POST",
           headers: { "Authorization": "Bearer " + OPENROUTER_KEY, "Content-Type": "application/json" },
           body: JSON.stringify({ model, messages: [{ role: "user", content: "Say OK" }], max_tokens: 5 }),
         });
         const d = await r.json();
         const ms = Date.now() - t0;
         if (d.choices?.[0]?.message?.content) {
           results.push({ model, status: "OK", latency: ms });
         } else if (d.error) {
           results.push({ model, status: "ERR: " + (d.error.message || "").slice(0, 50), latency: ms });
         } else {
           results.push({ model, status: "NO_RESPONSE", latency: ms });
         }
       } catch (e: any) {
         results.push({ model, status: "FAIL: " + (e.message || "").slice(0, 50), latency: Date.now() - t0 });
       }
       await new Promise(r => setTimeout(r, 2000));
     }
     const working = results.filter(r => r.status === "OK");
     const summary = results.map(r => (r.status === "OK" ? "[+]" : "[-]") + " " + r.model.split("/").pop() + " " + r.status + " (" + r.latency + "ms)").join("\n");
     return { summary: "Model Scout: " + working.length + "/" + results.length + " free models working\n" + summary, metric: String(working.length) };
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
