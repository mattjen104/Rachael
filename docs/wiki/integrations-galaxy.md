# Integrations — Galaxy KB

See [scrapers § Galaxy KB scraper](./scrapers.md#galaxy-kb-scraper) for the
full pipeline.

Quick reference:

| Command                          | Purpose                                              |
|----------------------------------|------------------------------------------------------|
| `galaxy search <q>`              | Search Galaxy via bridge.                            |
| `galaxy read <id>`               | Read a Galaxy article and ingest into KB.            |
| `galaxy context <term>`          | Manual term lookup with KB ingest.                   |
| `galaxy auto on \| off`          | Toggle autonomous scraping (default OFF).            |
| `galaxy queue [terms,…]`         | View / add to the autonomous lookup queue.           |
| `galaxy kb`                      | Browse KB by category.                               |
| `galaxy kb search <q>`           | Search KB by title/summary/category.                 |
| `galaxy kb <id>`                 | Show full entry.                                     |
| `galaxy kb verify <id>`          | Mark verified (boosts linked memories to relevance 95). |
| `galaxy kb flag <id> [reason]`   | Flag for review.                                     |
| `galaxy kb note <id> <text>`     | Add user annotation.                                 |
| `galaxy kb stats`                | Counts.                                              |

API: `/api/galaxy-kb` CRUD + `/api/galaxy-kb/:id/verify` + `/flag`.

View: [`GalaxyKbView.tsx`](../../client/src/components/views/GalaxyKbView.tsx).

Memories ingested from Galaxy are linked back via
`agent_memories.sourceKbId`.
