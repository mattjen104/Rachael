# Scrapers (universal + Galaxy)

## Universal scraper

Source: [`server/universal-scraper.ts`](../../server/universal-scraper.ts) (~432 lines)

A generic engine that executes ordered **navigation steps** against a target
URL using the bridge. A scraper is no longer hand-coded per site — it's a
**site profile** + a **navigation path** in the database.

### Data

- `site_profiles` — `name`, `baseUrl`, `urlPatterns[]`,
  `extractionSelectors`, `actions`, `defaultPermission`.
- `navigation_paths` — `name`, `siteProfileId` (FK), ordered `steps[]`,
  `extractionRules`, `permissionLevel`.

A `NavigationStep` is one of:

```ts
{ action: "navigate" | "click" | "click_text" | "type" | "press_key"
        | "wait" | "scroll" | "extract", target?, value?, waitMs?, description? }
```

### Engine

`executeNavigationPath(path, context)`:

1. For each step → call the bridge (DOM job for click/type/extract; fetch
   job for plain navigate).
2. Apply `extractionRules` to the final DOM.
3. Return text + extracted data.

### Best-effort fallback

`bestEffortExtract(url)` — used when `matchProfileToUrl(url)` returns no
profile. Pulls `<title>`, meta description, and the largest `<article>` /
`<main>` text block.

### Routes

- `GET/POST/PATCH/DELETE /api/site-profiles(/:id)`
- `GET/POST/PATCH/DELETE /api/navigation-paths(/:id)`
- `POST /api/scraper/execute`
- `POST /api/scraper/match`

### CLI

- `scrape <url>` — best-effort or auto-matched profile
- `scrape profile <name>` — run that profile's default path
- `scrape path <id>` — run a specific path

### Seeded profiles

`server/seed-data.ts` ships profiles for: outlook, teams, any-website. The
old hardcoded `server/app-adapters.ts` is kept as Playwright-based fallback.

---

## Galaxy KB scraper

Source: [`server/galaxy-scraper.ts`](../../server/galaxy-scraper.ts) (~538 lines)

Specialized scraper for Epic's Galaxy documentation site
(`galaxy.epic.com`, bridge-only).

### Modes

- **Manual** — `galaxy context <term>` (CLI) and `galaxy read <id>`.
- **Autonomous** — when `galaxy auto` is `on`, the scraper is woken up after
  any Epic-related program run. Terms are extracted from the run output and
  queued for lookup on a 15-min tick.

### Human-like behavior

- Randomized 3–8 s delays.
- Natural referrer chain (search page → article).
- Hard cap of 5 articles per session.
- 30–60 s cooldown between sessions.
- Respects `robots.txt`.
- A single global lock prevents the autonomous scraper and the CLI from
  running concurrently.

### Knowledge base ingestion

Both manual and auto runs flow through `ingestToKb()`:

1. Insert/update a `galaxy_kb` row with `title`, `url`, `category`,
   LLM-generated `summary`, full text.
2. Chunk full text and store as `agent_memories` rows with
   `subject = epic:galaxy:<term>` and `sourceKbId` pointing back to the KB
   entry.
3. Increment `memoryCount` on the KB entry.

### Verification workflow

- `galaxy kb verify <id>` — marks verified; boosts linked memories'
  `relevanceScore` to 95.
- `galaxy kb flag <id> [reason]` — flags for human review.
- `galaxy kb note <id> <text>` — append user note.
- `galaxy kb stats` — totals.

### Routes

- `GET  /api/galaxy-kb` (with `?category=`)
- `GET  /api/galaxy-kb/:id`
- `PATCH/DELETE /api/galaxy-kb/:id`
- `POST /api/galaxy-kb/:id/verify` and `/flag`

### View

`client/src/components/views/GalaxyKbView.tsx` browses entries grouped by
Epic category breadcrumb, with verification status icons and per-entry
memory counts.
