
const __ctx = JSON.parse(process.env.__INLINE_CTX || '{}');
const __projectRoot = process.env.__PROJECT_ROOT || process.cwd();
const __skillPath = (name: string) => __projectRoot + "/skills/" + name;

const NL = String.fromCharCode(10);
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

const FREE_MODELS = [
  'google/gemma-3-4b-it:free',
  'google/gemma-3-12b-it:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'qwen/qwen3-4b:free',
  'qwen/qwen3-8b:free',
  'deepseek/deepseek-r1-0528:free',
];

interface ModelResult {
  model: string;
  status: string;
  latency: number;
}

async function testModel(model: string): Promise<ModelResult> {
  const t0 = Date.now();
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENROUTER_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with only the word OK' }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const d = await r.json() as any;
    const ms = Date.now() - t0;
    if (d.choices?.[0]?.message?.content) {
      return { model, status: 'OK', latency: ms };
    }
    if (d.error) {
      return { model, status: 'ERR: ' + (d.error.message || '').slice(0, 60), latency: ms };
    }
    return { model, status: 'NO_RESPONSE', latency: ms };
  } catch (e: any) {
    return { model, status: 'FAIL: ' + (e.message || '').slice(0, 60), latency: Date.now() - t0 };
  }
}

async function execute() {
  const results: ModelResult[] = [];
  for (const model of FREE_MODELS) {
    results.push(await testModel(model));
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  const working = results.filter(r => r.status === 'OK');
  const lines = results.map(r => {
    const tag = r.status === 'OK' ? '[+]' : '[-]';
    const short = r.model.split('/').pop() || r.model;
    return tag + ' ' + short + ' ' + r.status + ' (' + r.latency + 'ms)';
  });
  const summary = 'Model Scout: ' + working.length + '/' + results.length + ' free models working' + NL + lines.join(NL);
  return { summary, metric: String(working.length) };
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
