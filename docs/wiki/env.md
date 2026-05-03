# Environment variables

Authoritative list of env vars used at runtime. The starter file is
[`.env.example`](../../.env.example); the table below also includes vars
that are not in `.env.example` but exist in the code.

| Var | Required? | Default | Purpose |
|-----|-----------|---------|---------|
| `DATABASE_URL` | yes | — | Postgres connection string |
| `OPENROUTER_API_KEY` | recommended | — | Default LLM gateway |
| `OPENCLAW_API_KEY` | yes (for write) | — | API key that protects writes; also derives the secrets encryption key |
| `BRIDGE_TOKEN` | yes (for extension) | random UUID lazily | Shared secret with the Chrome extension; persisted across deploys when set |
| `PORT` | no | 5000 | HTTP port |
| `NODE_ENV` | no | — | `production` switches to esbuild bundle |
| `RACHAEL_SELF_HOSTED` | no | unset | When `true`, enables `sh` CLI + `local-compute` shell exec |
| `RACHAEL_DOMAIN` | no | — | Used by Caddy for SSL on DO |
| `NTFY_CHANNEL` | no | rachael-standup | ntfy.sh topic |
| `NTFY_EMAIL` | no | — | ntfy.sh email forwarding |
| `ANTHROPIC_API_KEY` | no | — | Direct Anthropic (bypass OpenRouter) |
| `OPENAI_API_KEY` | no | — | Direct OpenAI |
| `QDRANT_URL` | no | http://localhost:6333 | Vector DB |
| `QDRANT_API_KEY` | no | — | Qdrant cloud |
| `QDRANT_TIMEOUT_MS` | no | 5000 | Qdrant request timeout |
| `OLLAMA_URL` | no | http://localhost:11434 | Embeddings host |
| `EMBEDDING_MODEL` | no | nomic-embed-text | Ollama model id |
| `JUDGE_DAILY_COST_CAP` | no | 5.0 | USD/day cap for evolution judges |
| `MAX_GOLDEN_SUITE_SIZE` | no | 100 | Regression test cases cap |
| `DRIFT_THRESHOLD` | no | 0.4 | Jaccard similarity floor for evolution drift gate |
| `SUCCESS_RATE_ROLLBACK_THRESHOLD` | no | 0.6 | Auto-rollback trigger |
| `VITE_API_BASE` | client only | window.origin | Compile-time base URL for the SPA |

Vars **present in code but missing from `.env.example`** (`replit.md`'s notes
imply they exist):

- `RACHAEL_SELF_HOSTED`, `JUDGE_DAILY_COST_CAP`, `MAX_GOLDEN_SUITE_SIZE`,
  `DRIFT_THRESHOLD`, `SUCCESS_RATE_ROLLBACK_THRESHOLD`, `EMBEDDING_MODEL`,
  `QDRANT_TIMEOUT_MS`, `QDRANT_API_KEY`, `OLLAMA_URL`, `RACHAEL_DOMAIN`.

See [audit § Deployment](./audit.md#deployment-and-ops) for the
documentation gap recommendation.
