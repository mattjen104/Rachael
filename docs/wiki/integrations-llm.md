# Integrations — LLM providers

Source: [`server/llm-client.ts`](../../server/llm-client.ts) (~279 lines)

## Providers

| Provider   | Env var               | Notes                                       |
|------------|-----------------------|---------------------------------------------|
| OpenRouter | `OPENROUTER_API_KEY`  | Default gateway; required.                  |
| Anthropic  | `ANTHROPIC_API_KEY`   | Optional direct path for Claude (bypass OR).|
| OpenAI     | `OPENAI_API_KEY`      | Optional direct path for GPT-4 etc.         |
| Ollama     | `OLLAMA_URL`          | Local-only; opt-in via `ask local on`.      |

## Default model

`anthropic/claude-sonnet-4` (via OpenRouter). The cheapest tier defaults to
DeepSeek V3.

## Behavior

- Per-call timeout: hard 120 s (see audit).
- Multi-provider fallback when one is down.
- Cost accounted into `judge_cost_tracking` for judge calls; into in-memory
  budget tracker for everything else.
- Embedding calls use Ollama (`nomic-embed-text` by default) — see
  [memory](./memory.md).

## Sanity check

`POST /api/openrouter/test` — round-trips a short prompt and returns model
+ tokens used + duration.
