
const __ctx = JSON.parse(process.env.__INLINE_CTX || '{}');
const __projectRoot = process.env.__PROJECT_ROOT || process.cwd();
const __skillPath = (name: string) => __projectRoot + "/skills/" + name;

   const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
   const MODELS = ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o-mini"];

   async function callLLM(prompt: string): Promise<string> {
     for (const model of MODELS) {
       try {
         const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
           method: "POST",
           headers: { "Authorization": "Bearer " + OPENROUTER_KEY, "Content-Type": "application/json" },
           body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 2000, temperature: 0.7 }),
         });
         const d = await r.json();
         const text = d.choices?.[0]?.message?.content?.trim();
         if (text) return text;
       } catch { continue; }
     }
     return "[models unavailable]";
   }

   async function execute() {
     const result = await callLLM(
       "You are a META program proposer for OrgCloud Space. Suggest 2-3 new automation programs that would be useful for a healthcare IT professional who also does side projects.\n\n" +
       "Each program should:\n- Use only free public APIs (no auth required) or the OpenRouter API\n- Run on a schedule (hourly, daily, etc.)\n- Produce actionable intelligence\n- Be implementable as a single TypeScript code block\n\n" +
       "Format each as an org-mode program block with ** TODO name :program: heading, PROPERTIES, description, and a complete TypeScript code block."
     );
     return { summary: result, metric: "1" };
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
