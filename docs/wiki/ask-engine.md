# Ask engine

Source: [`server/ask-engine.ts`](../../server/ask-engine.ts) (~824 lines)

`ask <question>` is the human-facing question-answering interface. It is
invoked from the CLI (`server/cli-engine.ts`) and the minibuffer.

## Pipeline

1. **Pre-process** with the cheapest cloud model (DeepSeek V3 by default):
   - Classify complexity (`simple` / `moderate` / `complex`).
   - Search Galaxy KB for direct answers; verify with a quality gate before
     surfacing.
   - Filter ~20 candidate memories down to 5–8 most relevant.
   - Compress memory context so the expensive model gets only what it needs.

2. **Route** to a tier:
   - `cheap` → DeepSeek V3 (default for simple).
   - `standard` → DeepSeek R1 / Claude 3.5 Sonnet.
   - `premium` → Claude Sonnet 4.

3. **Compose** the prompt: soul prompt + persona + user-profile + persisted
   memory context + conversation history (last 3 exchanges, 10 min TTL) +
   the question.

4. **Call LLM** via `server/llm-client.ts` (multi-provider).

5. **Persist** the exchange into `agent_memories` (episodic) and update KB
   verification stats if a Galaxy entry was used.

## CLI flags

| Flag                | Behavior                                                        |
|---------------------|-----------------------------------------------------------------|
| `--model <id>`      | Override model for one query                                    |
| `--cheap` / `--standard` / `--premium` | Tier shortcut                                |
| `--compare`         | Send to cheap + premium in parallel; show side-by-side          |
| `--prefer <model>`  | Persist preference to `ask_preferred_model` (`auto` to clear)   |
| `--reset`           | Drop conversation context                                       |
| `ask status`        | Show the pre-process pipeline stats                             |
| `ask local on/off`  | Use Ollama `qwen2.5:0.5b` for local fallback (off by default)   |

## Config keys (`agent_config`, category `ask`)

- `ask_local_fallback` — `true`/`false`.
- `ask_preferred_model` — model id or empty.

## Cost notes

- Pre-processing costs about $0.0003 per query.
- Quality gate catches bad KB answers before they reach the user.
- Local fallback (Ollama) is opt-in and exists so the user can keep working
  if no cloud key is configured. The model auto-unloads after 5 min idle via
  Ollama's `keep_alive`.

## Prompt-injection note

User queries and raw memory text are interpolated into the prompt directly.
See [audit § Security #5](./audit.md#5-prompt-injection-via-untrusted-content).
