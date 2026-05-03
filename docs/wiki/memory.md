# Memory subsystem

Sources:
- [`server/qdrant-client.ts`](../../server/qdrant-client.ts) (~298 lines)
- [`server/memory-consolidation.ts`](../../server/memory-consolidation.ts) (~423 lines)
- `agent_memories` table (see [data model](./data-model.md))

## Backends

- **Primary**: Qdrant (vector DB) using Ollama embeddings (`nomic-embed-text`).
- **Fallback**: Postgres `agent_memories` table with `ilike` search.
- Both are always written to so that disabling Qdrant doesn't lose data.

`QDRANT_URL`, `OLLAMA_URL`, `EMBEDDING_MODEL`, `QDRANT_TIMEOUT_MS` env vars
control the backend (defaults documented in [env](./env.md)).

## Hybrid search

`searchMemoriesHybrid(query, opts)`:

1. Dense cosine over Ollama embeddings.
2. Sparse BM25 (FNV-1a hash-based TF) for keyword matches.
3. Combine via Reciprocal Rank Fusion.

Endpoint: `GET /api/memory/search?q=…&limit=N&program=…`.

## Memory types

- `episodic` — events / observations from agent runs.
- `semantic` — facts with `subject` and `validUntil`.
- `procedural` — strategies / procedures (often emitted from program output
  via the consolidation judge).

## Contradiction detection

When a new `semantic` memory is written:

1. Find existing memories with the same `subject`.
2. Heuristic check: token overlap + negation words → mark as contradicting.
3. Set `validUntil` on the older memory to "now" (soft expire).

Heuristic-only — see [audit § Agent safety](./audit.md#agent-safety).

## Token-budget-aware context

When building context for a prompt, the assembler prefers:

```
semantic facts > episodic memories > procedural memories
```

…and respects a per-call token cap.

## Migration

`POST /api/memory/migrate-to-qdrant` re-embeds existing Postgres rows into
Qdrant. Idempotent (`qdrant_id` column).

## Consolidation

After each program run:

1. The consolidation judge (LLM) reads the raw output and extracts
   episodes / facts / procedures.
2. Falls back to heuristic extraction (correction patterns, preference
   patterns, procedure detection) when judges are unavailable or capped.
3. Writes new `agent_memories` rows.

## CLI

- `memory show` — dump persistent memory.
- `memory store <text>` — append a timestamped entry.
- `memory search <query>` — hybrid search.
- `memory recent [N]` — last N entries.
- `memory forget <pattern>` — delete matches.
