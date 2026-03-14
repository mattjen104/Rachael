# OrgCloud Command Center

A database-first, keyboard-driven command center optimized for Chrome sidebar use (~400px wide). Features autonomous agent programs, vim motions (j/k/g/G), Tab fold/unfold, and an Emacs-inspired command palette (M-x/Space). CRT phosphor aesthetic.

## Architecture

- **Frontend**: React + Vite + Tailwind CSS v4 + shadcn/ui components
- **Backend**: Express.js REST API
- **Database**: PostgreSQL via Drizzle ORM (all data in typed tables)
- **Routing**: wouter (frontend), Express (backend)

## Database Schema (shared/schema.ts)

All data lives in Postgres tables:
- `programs` — Autonomous agent programs (code, config, schedule, enabled/disabled)
- `skills` — Agent skills/toolkits
- `agent_config` — Key-value config (soul prompt, model aliases, routing, memory)
- `tasks` — TODO/DONE tasks with scheduling, priority, tags
- `notes` — Freeform notes
- `captures` — Inbox items (from paste, chrome extension, smart capture)
- `agent_results` — Chronological agent execution outputs
- `reader_pages` — Saved/scraped web pages for reading
- `openclaw_proposals` — Agent self-modification proposals
- `site_profiles` — Configurable site scraping profiles (URL patterns, selectors, actions, defaultPermission)
- `navigation_paths` — Ordered step sequences for scraping (tied to site profiles, permissionLevel)
- `audit_log` — Records all human/agent actions with timestamps, permission levels, and results

## Control Bus & Permissions

- **Control Bus** (`server/control-bus.ts`) — Tracks who is driving (human vs agent), manages turn-taking with pause/resume semantics
- **Permission Levels**: autonomous (agent acts freely), approval (agent pauses and waits for human), blocked (action refused)
- **Takeover Points** — When agent hits an "approval" action, it emits a takeover point visible in Cockpit stream; human can confirm, reject, or take over
- **Audit Log** — All actions (human and agent) logged with actor, action, permission level, result, timestamp

## Six-View Architecture

Narrow tab bar at top, full-height views below:

1. **Agenda View** (1:AGD) — Default. Overdue tasks, today's tasks, upcoming, latest agent briefings. Sections fold/unfold with Tab.
2. **Tree View** (2:TRE) — Everything in one hierarchy: tasks, programs, skills, notes, inbox, reader pages. Tab to fold sections.
3. **Programs View** (3:PRG) — List of all programs with enable/disable, trigger, runtime status. Runtime ON/OFF toggle.
4. **Results View** (4:RES) — Chronological agent outputs. Tab to expand full output.
5. **Reader View** (5:RDR) — Saved web pages. Enter to read, Escape to go back.
6. **Cockpit View** (6:CPT) — Shared control cockpit. Activity stream, audit log, and permission editor. Tab to toggle control mode (human/agent).

## Keyboard Navigation

- `j`/`k` — Move cursor up/down
- `g`/`G` — Jump to top/bottom
- `Tab` — Fold/unfold (in most views) or toggle control mode (in Cockpit)
- `Enter` — Toggle task status, open item
- `Escape` — Back to agenda
- `1-6` — Switch views directly
- `Space` or `Alt-x` — Open command palette (M-x)
- `/` — Open command palette in search mode
- `c` — Open command palette for capture
- `r` (in Programs) — Trigger selected program
- `R` (in Programs) — Toggle runtime ON/OFF

## Command Palette (Minibuffer)

Emacs-style M-x with modes:
- **command** — Filter and execute commands (switch views, capture, theme, runtime)
- **search** — Full-text search across tasks, notes, programs, skills, captures
- **capture** — Quick capture (prefix "t " for task, plain text for note)
- **add-url** — Save URL to Reader

## CLI Engine (server/cli-engine.ts)

Unix-style command interface with chain parsing. Both humans and the agent can execute commands.

- **Chain operators**: `|` (pipe stdout), `&&` (run if success), `||` (run if fail), `;` (always run)
- **Branch suppression**: When `&&`/`||` skips a segment, downstream `|` pipes in the same branch are also skipped
- **Two-layer output**: `executeChainRaw()` returns raw stdout/stderr/exitCode (for pipes, recipes, internal use); `executeChain()` wraps with presentation (truncation, exit codes, duration)
- **Progressive discovery**: `command --help` for usage, error messages point to correct commands
- **26 built-in commands**: help, programs, results, tasks, notes, captures, search, grep, head, tail, wc, sort, uniq, echo, cat, recipe, config, skills, runtime, profiles, proposals, agenda, memory, scrape, propose-recipe
- **Cockpit events**: CLI commands emit events to the cockpit activity stream (recipe save/run/approve, memory store/forget, scrape)
- **API**: `POST /api/cli/run {command}`, `GET /api/cli/help`, `GET /api/cli/commands`

## Recipes (server/cli-engine.ts + shared/schema.ts)

- `recipes` table: name, command (chain string), schedule, cron, enabled, run_count, last_output
- CLI: `recipe save <name> "<command>"`, `recipe run <name>`, `recipe list`, `recipe info/delete`
- REST: `/api/recipes` CRUD, `/api/recipes/:id/trigger`
- Recipes reuse CLI commands — save a working pipeline, run it later without LLM calls

## Agent-Authored Recipes (server/agent-runtime.ts)

- Programs can emit `RECIPE: <name> "<command>" [--schedule <sched>] [--desc <desc>]` directives in their output
- Directives auto-create proposals in `openclaw_proposals` with section "RECIPES"
- Proposals appear as takeover points in the cockpit stream
- Human can approve via `proposals approve <id>` — recipe is auto-created from the proposal data
- Also available: `propose-recipe <name> "<command>"` CLI command for manual proposals

## Memory Commands (server/cli-engine.ts)

- `memory show` — View all persistent memory
- `memory store <text>` — Append timestamped entry to persistent context
- `memory search <query>` — Search persistent context + agent results
- `memory recent [N]` — Last N memory entries
- `memory forget <pattern>` — Remove matching entries

## Scraper CLI (server/cli-engine.ts)

- `scrape <url>` — Best-effort extract (or auto-match to a site profile if available)
- `scrape profile <name>` — Run a named site profile's default navigation path
- `scrape path <id>` — Run a specific navigation path by ID
- Output is pipeable text (title, extracted data, body text)

## Agent Runtime

- Programs read from DB `programs` table
- Inline TypeScript code executed via subprocess (`npx tsx`) for TypeScript support
- LLM cascade (free → cheap → standard → premium) via model-router
- Results written to `agent_results` table
- Proposals written to `openclaw_proposals` table
- PROPOSE: / REMEMBER: directives in LLM output auto-create proposals/memory

## Seeded Programs (12)

hn-pulse, openrouter-model-scout, research-radar (meta), hn-deep-digest, github-trending, estate-car-finder, fed-rates, free-stuff-radar, sec-filings, price-watch, foreclosure-monitor, mandela-berenstain

## Site Profiles & Universal Scraper Engine

Database-driven scraping system replacing hardcoded adapters:
- `site_profiles` — Configurable site definitions (name, base URL, URL patterns, extraction selectors, named actions)
- `navigation_paths` — Reusable step sequences tied to a profile (navigate, click, type, wait, extract)
- `server/universal-scraper.ts` — Universal engine executing navigation paths via browser bridge
- Seeded profiles: outlook, teams, any-website (best-effort extraction)
- CRUD API: `/api/site-profiles`, `/api/navigation-paths`
- Execution: `POST /api/scraper/execute` (by pathId or raw URL)
- Profile matching: `POST /api/scraper/match` (finds matching profile for a URL)
- Minibuffer commands: `list-site-profiles`, `view-profile:`, `run-scraper:`
- Old `app-adapters.ts` retained as fallback

## Key Server Files

- `server/routes.ts` — REST API for all entities
- `server/storage.ts` — Database CRUD layer
- `server/universal-scraper.ts` — Universal scraper engine (profile-driven)
- `server/agent-runtime.ts` — Program execution, scheduling, LLM cascade
- `server/llm-client.ts` — Multi-provider LLM client (Anthropic, OpenAI, OpenRouter)
- `server/model-router.ts` — Model selection, cost tiers, task type detection
- `server/seed-data.ts` — Initial program/skill/config/site-profile data
- `server/capture-parser.ts` — Smart capture parsing (dates, task detection)
- `server/content-detector.ts` — URL/image/code detection

## Key Client Files

- `client/src/pages/Workspace.tsx` — Main workspace with view switching, keyboard handler
- `client/src/hooks/use-org-data.ts` — React Query hooks for all API endpoints
- `client/src/components/views/` — AgendaView, TreeView, ProgramsView, ResultsView, ReaderView
- `client/src/components/layout/Sidebar.tsx` — Top tab bar
- `client/src/components/layout/StatusBar.tsx` — Bottom status bar with runtime indicator
- `client/src/components/editor/Minibuffer.tsx` — Command palette
- `client/src/lib/crt-theme.tsx` — CRT phosphor theme provider

## Preserved Utilities

- `skills/resilient-fetch.ts`, `skills/fuzzy-match.ts`, `skills/reddit-toolkit.ts`, `skills/craigslist-toolkit.ts`, `skills/archive-toolkit.ts`
- `server/model-router.ts`, `server/llm-client.ts`, `server/browser-bridge.ts`, `server/app-adapters.ts`, `server/scrape-buffer.ts`
- `server/output-sanitizer.ts`, `server/rate-limit.ts`, `server/skill-runner.ts`
- Chrome extension in `chrome-extension/`
