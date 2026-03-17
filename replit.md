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
- `transcripts` — Meeting audio transcripts (platform, sourceUrl, durationSeconds, rawText, segments as JSON, status, recordingType)
- `action_permissions` — Per-action permission overrides for navigation paths

## Control Bus & Permissions

- **Control Bus** (`server/control-bus.ts`) — Tracks who is driving (human vs agent), manages turn-taking with pause/resume semantics
- **Permission Levels**: autonomous (agent acts freely), approval (agent pauses and waits for human), blocked (action refused)
- **Takeover Points** — When agent hits an "approval" action, it emits a takeover point visible in Cockpit stream; human can confirm, reject, or take over
- **Audit Log** — All actions (human and agent) logged with actor, action, permission level, result, timestamp

## Seven-View Architecture

Narrow tab bar at top, full-height views below:

1. **Agenda View** (1:AGD) — Default. Overdue tasks, today's tasks, upcoming, latest agent briefings. Sections fold/unfold with Tab.
2. **Tree View** (2:TRE) — Everything in one hierarchy: tasks, programs, skills, notes, inbox, reader pages. Tab to fold sections.
3. **Programs View** (3:PRG) — List of all programs with enable/disable, trigger, runtime status. Runtime ON/OFF toggle.
4. **Results View** (4:RES) — Chronological agent outputs. Tab to expand full output.
5. **Reader View** (5:RDR) — Saved web pages. Enter to read, Escape to go back.
6. **Transcripts View** (6:TRS) — Meeting audio transcription. Record from microphone or tab capture (Teams, Zoom, etc). Transcripts with timestamped segments, platform badges (TEAMS/ZOOM/MEET/OTHER), and recording type (TAB/MIC).
7. **Cockpit View** (7:CKP) — Shared control cockpit. Activity stream, audit log, and permission editor. Tab to toggle control mode (human/agent).

## Keyboard Navigation

- `j`/`k` — Move cursor up/down
- `g`/`G` — Jump to top/bottom
- `Tab` — Fold/unfold (in most views) or toggle control mode (in Cockpit)
- `Enter` — Toggle task status, open item
- `Escape` — Back to agenda
- `1-6` — Switch views directly
- `Space` or `Alt-x` — Open command palette (M-x)
- `/` — Open command palette in search mode
- `c` — Open command palette for capture (or capture selected mail in TreeView)
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
- **30+ built-in commands**: help, programs, results, tasks, notes, captures, capture, search, grep, head, tail, wc, sort, uniq, echo, cat, recipe, config, skills, runtime, profiles, proposals, agenda, memory, scrape, propose-recipe, bridge, bridge-status, bridge-token, notify, standup, outlook
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

## Knowledge Base & Capture (server/cli-engine.ts)

Data flows into the KB as markdown notes stored in the `notes` table:
- `capture mail <n|n,n|all> [--tag TAG]` — Save scraped emails as markdown notes
- `capture calendar [--tag TAG]` — Save calendar events as markdown notes
- `capture text <content>` — Save arbitrary text as a note
- **TreeView shortcut**: Press `c` on a selected mail item to capture it
- **Command palette**: Open with Space/Alt-x, type `capture mail 1,2,3`
- Notes are tagged by source (email, outlook, calendar) for easy filtering
- All KB content is searchable via `search <query>`

## Scraper CLI (server/cli-engine.ts)

- `scrape <url>` — Best-effort extract (or auto-match to a site profile if available)
- `scrape profile <name>` — Run a named site profile's default navigation path
- `scrape path <id>` — Run a specific navigation path by ID
- Output is pipeable text (title, extracted data, body text)

## Notifications (server/cli-engine.ts)

- `notify <message>` — Send a push notification (or pipe: `standup | notify`)
- Supports ntfy.sh (free, no account) and generic webhooks
- Config: `config set notify_channel <channel>` for ntfy.sh, `config set notify_webhook <url>` for webhooks
- For ntfy.sh: install the ntfy app on your phone, subscribe to the same channel name

## Morning Standup (server/cli-engine.ts)

- `standup` — Compiles yesterday's program runs, errors, recipes fired, overdue tasks, new memory
- `standup --days N` — Look back N days instead of 1
- Saved recipe: `morning-standup` = `standup --days 1 | notify` (daily schedule)
- Currently configured to send to ntfy.sh/orgcloud-standup

## Agent Runtime

- Programs read from DB `programs` table
- Inline TypeScript code executed via subprocess (`npx tsx`) for TypeScript support
- LLM cascade (free → cheap → standard → premium) via model-router
- Results written to `agent_results` table
- Proposals written to `openclaw_proposals` table
- PROPOSE: / REMEMBER: directives in LLM output auto-create proposals/memory
- **Recipe scheduler**: `tickRecipes()` runs inside the main tick loop, checks recipes with cron schedules and executes them automatically
- **Default model**: `openrouter/anthropic/claude-sonnet-4` everywhere (NO free models for real work)
- **Morning briefing**: HTML email with navigable index + NPR-style voice synthesis (Microsoft Edge neural TTS via `msedge-tts`). Cron `0 13 * * *` (6am PT). Voice script generated by LLM, synthesized to MP3, attached to ntfy notification.
- **Auto-start**: Runtime defaults to `active: true`, control mode defaults to `agent` — no manual activation needed after server restart
- **Bridge-aware programs**: Inline code wrapper auto-injects `bridgeFetch()` and `smartFetch()` helpers. Programs can call `bridgeFetch(url, opts)` to route through Chrome extension (tries bridge first, falls back to direct). `smartFetch(url, init)` is a drop-in `fetch()` replacement that auto-bridges on 403/429/503. Bridge token + port passed via subprocess env vars (`__BRIDGE_TOKEN`, `__BRIDGE_PORT`).

## Seeded Programs (12) — ALL with real inline code

All programs have hardened inline TypeScript code (no LLM-only programs remaining):
- hn-pulse — HN top stories via Firebase API
- openrouter-model-scout — Tests free model availability on OpenRouter
- research-radar (meta) — Aggregates HN + GitHub trending (via bridge) + Lobsters + Lemmy (c/machinelearning, c/artificial_intelligence) + Reddit r/MachineLearning, r/LocalLLaMA, r/homelab, r/selfhosted (all via bridge) + ArXiv CS.AI, synthesizes via Claude
- hn-deep-digest — Deep discussion digest: fetches 15 comment threads per story (3 levels), Claude summarizes debate substance, key arguments, tensions
- github-trending — GitHub trending repos (via bridge)
- estate-car-finder — SoCal Craigslist estate/low-mile car scanner across 4 regions (via bridge)
- fed-rates — Treasury yields (10Y/2Y/5Y/30Y) via Yahoo Finance JSON API
- free-stuff-radar — Craigslist free section scanner with keyword matching (via bridge)
- sec-filings — SEC EDGAR filings (10-K/10-Q/8-K) via data.sec.gov API
- price-watch — Craigslist vehicle listings under max price with dedup (via bridge)
- foreclosure-monitor — HUD HomeStore + Fannie Mae HomePath + CL REO search (all via bridge, HUD/HomePath use DOM extraction)
- mandela-berenstain — Internet Archive + Open Library search for Berenstain/Berenstein spelling variants
- citrix-launcher — Discovers available Citrix published apps from UCSD CWP (cwp.ucsd.edu). Bridge-only, manual trigger.

## Inline Code Safety Rules

- NEVER use `\n` inside string literals in program code stored to DB — the template wrapper turns them into real newlines
- Use `const NL = String.fromCharCode(10)` + concatenation instead
- OpenRouter model ID is `anthropic/claude-sonnet-4` (NOT `claude-sonnet-4-20250514`)
- Must restart workflow after PATCH to programs (runtime caches in memory)

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
- `client/src/hooks/use-tv-mode.tsx` — TV mode context provider (Google TV / 10-foot UI)
- `client/src/components/views/` — AgendaView, TreeView, ProgramsView, ResultsView, ReaderView
- `client/src/components/layout/Sidebar.tsx` — Top tab bar (TV-aware: full labels in TV mode)
- `client/src/components/layout/StatusBar.tsx` — Bottom status bar with runtime indicator (TV-scaled)
- `client/src/components/editor/Minibuffer.tsx` — Command palette (TV-scaled)
- `client/src/components/tv/TvShortcutOverlay.tsx` — First-run keyboard shortcut guide for TV mode
- `client/src/lib/crt-theme.tsx` — CRT phosphor theme provider

## TV Mode (Google TV Integration)

- Activate via `?tv=1` query parameter or `toggle-tv-mode` command in palette
- Persisted in localStorage (`orgcloud-tv-mode`), auto-activates on subsequent loads
- Scales base font to 26px, increases all padding/spacing/targets for 10-foot viewing
- Removes 500px max-width constraint, fills full 1920px TV screen
- Sidebar shows full view names (Agenda, Tree, etc.) instead of 3-letter abbreviations
- CRT scanline/glow effects tuned for TV-sized rendering (wider scanlines, adjusted glow)
- First-run overlay shows keyboard shortcuts, dismissed with any key
- CSS class `.tv-mode` on `<html>` drives all TV styling via CSS overrides

## Chrome Extension Bridge (chrome-extension/ + server/bridge-queue.ts)

- **Purpose**: Routes scraping through the user's real Chrome browser (real cookies, real IP) — bypasses cloud IP blocks
- **Unified bridge**: `smartFetch()` tries Chrome extension first → falls back to direct server-side fetch. Agents don't need to know which path is used.
- **Flow**: Server queues jobs → Extension polls `/api/bridge/ext/jobs` (sends heartbeat headers) → executes fetch/DOM extraction → posts results to `/api/bridge/ext/results`
- **Auth**: Bridge token (lazy-generated UUID) — extension stores token from options page, sends as `X-Bridge-Token` header
- **Heartbeat**: Extension sends version/jobs-completed/error in poll headers; server tracks `extensionLastSeen` with 90s staleness window
- **Retry logic**: Failed jobs auto-requeue up to `maxRetries` (default 2) before returning error to caller
- **Serial execution**: Extension processes jobs sequentially with 1.5s delay between them to avoid anti-bot detection
- **DOM job type**: Opens a real background tab, waits for JS rendering, injects content script for extraction (not just static HTML parsing)
- **CLI commands**: `bridge <url>` (smart fetch), `bridge-status` (unified status), `bridge-token` (get token for extension setup), `cwp` (UCSD Citrix Workspace browser)
- **Bridge-only domains**: `galaxy.epic.com`, `*.ucsd.edu`, `reddit.com`/`*.reddit.com`, `*.live.com`/`outlook.live.com`, `*.office.com`/`teams.microsoft.com` — these never fall back to direct server-side fetch to avoid automated detection. Enforced in both server-side `smartFetch`, inline program `bridgeFetch`/`smartFetch`, and CLI `bridge --direct` (blocked). List defined in `bridge-queue.ts` (server) and `agent-runtime.ts` (inline wrapper).
- **Bridge token**: Persistent via `BRIDGE_TOKEN` env var. Survives deployments. Health endpoint at `/api/bridge/ext/health` (no auth).
- **Outlook/Teams TUI**: CLI commands `outlook` (inbox/calendar/read) and `teams` (chats/channels) use bridge DOM extraction via `smartFetch`. Results cached in memory (`getMailCache`, `getCalendarCache`, `getTeamsCache` exported from cli-engine.ts). API routes `/api/mail/inbox`, `/api/mail/calendar`, `/api/chat/list` serve cached data to Tree view. `app-adapters.ts` has legacy Playwright-based scrapers as fallback.
- **Job types**: `fetch` (raw HTTP via browser cookies) and `dom` (real tab injection with CSS selector extraction, full JS rendering)
- **API routes**: `/api/bridge/status` (unified Playwright + extension + queue), `/api/bridge/ext/token` (auth-gated), `/api/bridge/ext/jobs`, `/api/bridge/ext/results`, `/api/bridge/ext/queue`, `/api/bridge/ext/submit`
- **Extension files**: `background.js` (polling + tab-based execution), `options.html/js` (URL + token config), `manifest.json` (MV3, `<all_urls>`)
- **Polling interval**: Chrome alarms at 30s minimum; extension polls every ~30s when active

## Preserved Utilities

- `skills/resilient-fetch.ts`, `skills/fuzzy-match.ts`, `skills/reddit-toolkit.ts`, `skills/craigslist-toolkit.ts`, `skills/archive-toolkit.ts`
- `server/model-router.ts`, `server/llm-client.ts`, `server/browser-bridge.ts`, `server/app-adapters.ts`, `server/scrape-buffer.ts`
- `server/output-sanitizer.ts`, `server/rate-limit.ts`, `server/skill-runner.ts`
- Chrome extension in `chrome-extension/`
