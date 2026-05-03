# Integrations — Pulse (UCSD intranet directory)

Source: [`server/cli-engine.ts`](../../server/cli-engine.ts) ~line 6571
(`registerCommand("pulse", …)`).

Pulse is the UCSD intranet at `pulse.ucsd.edu`. The `pulse` CLI command
crawls the homepage + nav links, builds a fuzzy-searchable directory of
internal links the user cares about, and persists the result in
`agent_config` so subsequent searches are instant and offline-capable.

## Requirements

- The Chrome extension bridge must be connected — Pulse is **bridge-only**
  (UCSD network policy).
- No env vars; no separate secret. The user's existing UCSD session in
  Chrome is what lets the bridge reach the page.

## Subcommands

| Command | Purpose |
|---------|---------|
| `pulse scan` | Crawl the homepage + nav links via DOM job, dedup, merge with stored links. |
| `pulse search <query>` | Fuzzy match against name / category / URL. |
| `pulse list [category]` | List all links or filter by category. |
| `pulse open <name or #>` | Open a link in the user's browser (by name or by index in the last search result). |
| `pulse categories` | List categories. |
| `pulse clear` | Wipe stored links. |

## Storage

Stored under two `agent_config` keys (category `pulse`):

- `pulse_links` — JSON array `{name, url, category}[]`.
- `pulse_last_results` — last search result list, so `pulse open #2` works.

## Crawl behavior

- Starts at `https://pulse.ucsd.edu`.
- Performs a single-level deep crawl (homepage + nav links) — does not chase
  arbitrary links.
- Skips off-domain links.
- Idempotent merge: existing links are preserved, new links appended,
  duplicates collapsed by URL.

There is no scheduled `pulse scan` — the user runs it on demand. A future
program could schedule it nightly.
