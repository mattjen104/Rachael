# Rachael

Autonomous agent runtime with 30+ CLI programs, self-evolution engine, and CRT phosphor aesthetic. Doom Emacs-inspired web UI (IBM Plex Mono) with Chrome extension as primary interface. Deployable to DigitalOcean via `scripts/do-install.sh`.

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
- `radar_seen_items` — Cross-run deduplication store for research radar (content hashes, 7-day window)
- `radar_engagement` — User engagement tracking for research radar briefing items (url, source, title)
- `galaxy_kb` — Galaxy Knowledge Base entries (title, url, category, summary, fullText, verified/flagged status, userNotes, memoryCount, searchTerm)
- `agent_memories.source_kb_id` — Links agent memories to their source Galaxy KB entry
- `outlook_emails` — Persisted Outlook emails (messageId, from, subject, date, body, unread, syncedAt)
- `snow_tickets` — Persisted ServiceNow tickets (number, type, shortDescription, state, priority, assignedTo, assignmentGroup, updatedOn, source, syncedAt)

## Instant Replay / Navigation Replay Engine

- **Replay Engine** (`server/replay-engine.ts`) — LLM-synthesized recipes per navigation edge, BFS pathfinding, chained replay execution with fingerprint verification
- **Recipe storage**: `agent_configs` key `nav_recipe_{from_fp}_{to_fp}` — one recipe per unique edge (source + destination fingerprint pair)
- **Recipe synthesis**: On every new edge in `/api/sessions/stream`, LLM generates a named procedure with parameterized steps, tags, safety level. Fallback recipe from recorded action keys if LLM fails.
- **Recipe strengthening**: Repeated edge observations increment confidence, update timing, add alternative action keys
- **Pathfinding**: BFS on navigation tree edges. `GET /api/sessions/pathfind?from=fp&to=fp&windowKey=wk` or `&target=name` for fuzzy match
- **Replay execution**: `POST /api/sessions/replay` queues `nav_replay` command to desktop agent. Agent executes each step, verifies destination via screenshot fingerprint, retries on mismatch (up to 2x)
- **Safety gate**: Hard-block patterns (password, delete, submit order, logout) + LLM risk classification (low/medium/high). High-risk paths require approval.
- **TreeView**: Every destination node shows `>> Go here` action (runs `epic go SUP <title>`). Edges show recipe status: `{new}` or `{confirmed}` (3+ observations)
- **CLI**: `epic go <screen-name>` first checks Epic activity tree, then falls back to nav-tree fuzzy match + pathfinding + replay
- **Agent command**: `nav_replay` type — receives ordered steps with action sequences, trigger keys, expected fingerprints, wait times

## Morning Boot System

- **`boot` command** — Sequences workday startup: epic login → outlook sync → snow sync → citrix keepalive
- **`epic login`** — Bridge form-fill for CWP/Hyperspace/Text with native React SPA setter; credentials via `secrets` module (`epic_username`/`epic_password`)
- **`outlook sync`** — Incremental Outlook inbox scraping with DB persistence; `outlook search` for historical lookups
- **`snow search`/`snow persisted`** — ServiceNow ticket persistence with upsert sync; historical search across persisted tickets
- **Boot status tracking** — `agent_config` keys: `boot_last_login`, `outlook_last_sync`, `snow_last_sync`, `boot_last_run`
- **Shared bridge rate limiter** — `waitForBridgeRateLimit`/`bridgeRequestDone` in bridge-queue.ts; 2-5s minimum gap, 10-request cooldown window
- **API routes**: `/api/outlook-emails`, `/api/snow-tickets`, `/api/boot/status`
- **TreeView fallback** — Shows persisted DB data with `[db]` indicator when bridge data unavailable

## Secure Credential Collection

- **Secrets Module** (`server/secrets.ts`) — AES-256-GCM encrypted secret storage with magic-link collection forms
- `collect-secrets` CLI command creates a time-limited (10 min) magic-link URL for credential collection
- Magic-link forms are public (no auth required); submitted secrets are encrypted at rest
- Secrets stored via `agent_configs` table with `category: "secrets"` prefix
- API: `POST /api/secrets/request` (create request), `GET /api/secrets/form/:id` (public form), `POST /api/secrets/submit` (public submit), `GET /api/secrets/:name` (auth required)
- Response body logging suppressed for all `/api/secrets` routes

## Ask Engine (server/ask-engine.ts)

- **`ask <question>`** — Direct question answering with memory-aware context (hybrid Qdrant + Postgres search, Galaxy KB, conversation history)
- **Smart routing** — Classifies query complexity (simple/moderate/complex) and routes to appropriate model tier (cheap/standard/premium)
- **`ask --model <id>`** — Override model for a single query; `--cheap`, `--standard`, `--premium` tier shortcuts
- **`ask --compare`** — Sends same prompt to cheap + premium models in parallel, shows side-by-side comparison with token/cost data
- **`ask --prefer <model>`** — Set persistent model preference (saved to agent_config); `ask --prefer auto` clears
- **`ask --reset`** — Clears conversation context (last 3 exchanges, 10-minute TTL)
- **`ask status`** — Shows full pre-processing pipeline stats (queries, tokens saved, preprocess cost, KB hits, quality gate catches)
- **Pre-processing pipeline** (DeepSeek / cheapest roster model — primary):
  1. Query complexity classification (simple/moderate/complex) via cheap cloud LLM
  2. KB direct-answer search with cheap LLM verification and quality gating
  3. Memory relevance filtering — cheap LLM prunes 20+ candidates to 5-8
  4. Context compression — compresses memory context before expensive model calls
  - All pre-processing costs ~$0.0003/query; catches bad KB answers before user sees them
- **Local model fallback** (`ask local on/off`) — Uses small Ollama model (qwen2.5:0.5b) for basic classification only when no cloud API keys available. OFF by default. Model auto-unloads after 5 min idle via Ollama `keep_alive`.
- **Config keys** (agent_config, category "ask"): `ask_local_fallback`, `ask_preferred_model`

## Local Compute

- **Local Compute** (`server/local-compute.ts`) — Shell execution for self-hosted instances
- Enabled by `RACHAEL_SELF_HOSTED=true` environment variable
- Programs can use `LOCAL_CAPABILITIES` config for capability declarations
- `sh` CLI command for direct shell access on self-hosted instances

## Control Bus & Permissions

- **Control Bus** (`server/control-bus.ts`) — Tracks who is driving (human vs agent), manages turn-taking with pause/resume semantics
- **Permission Levels**: autonomous (agent acts freely), approval (agent pauses and waits for human), blocked (action refused)
- **Takeover Points** — When agent hits an "approval" action, it emits a takeover point visible in Cockpit stream; human can confirm, reject, or take over
- **Audit Log** — All actions (human and agent) logged with actor, action, permission level, result, timestamp

## TUI Client (tools/tui/)

Python terminal interface for the DO droplet. Uses notcurses when available, falls back to curses (built into Python).

- **Entry point**: `python3 tools/tui/rachael_tui.py [--url URL] [--key KEY] [--theme NAME]`
- **Modules**: `api_client.py` (HTTP client), `themes.py` (6 themes), `rachael_tui.py` (main app)
- **Themes**: phosphor (default), amber, cool-blue, solarized, dracula, red-alert — persisted to `~/.rachael/tui.conf`
- **Layout**: Header bar, sidebar (view list + runtime/budget), main content, mode line, minibuffer
- **Views**: All 10 views (1-0 keys): agenda, tree, programs, results, reader, cockpit, snow, evolution, transcripts, voice
- **Keybindings**: j/k navigate, g/G jump, Tab expand, Enter act, / search, : or M-x command palette, T cycle theme, c capture, X CLI, q quit
- **Setup**: `bash tools/tui/setup.sh` (auto-run by do-install.sh step 9/9)

## Ten-View Architecture

Narrow tab bar at top, full-height views below:

1. **Agenda View** (1:AGD) — Default. Overdue tasks, today's tasks, upcoming, latest agent briefings. Sections fold/unfold with Tab.
2. **Tree View** (2:TRE) — Everything in one hierarchy: tasks, programs, skills, notes, inbox, reader pages, APPS (Citrix by category), MAIL, CHAT, SNOW. Tab to fold sections.
3. **Programs View** (3:PRG) — List of all programs with enable/disable, trigger, runtime status. Runtime ON/OFF toggle.
4. **Results View** (4:RES) — Chronological agent outputs. Tab to expand full output.
5. **Reader View** (5:RDR) — Saved web pages. Enter to read, Escape to go back.
6. **Transcripts View** (6:TRS) — Meeting audio transcription. Record from microphone or tab capture (Teams, Zoom, etc). Transcripts with timestamped segments, platform badges (TEAMS/ZOOM/MEET/OTHER), and recording type (TAB/MIC).
7. **Cockpit View** (7:CKP) — Shared control cockpit. Activity stream, audit log, and permission editor. Tab to toggle control mode (human/agent).
8. **Snow View** (8:SNW) — ServiceNow dashboard. Incidents, changes, requests with SLA indicators. Bridge-powered scraping.
9. **Voice View** (9:VOX) — Voice command center. Press [V] to activate browser mic, speak natural language commands. Uses Web Speech API for recognition, maps to CLI commands, shows results inline. Works on Google TV with Bluetooth keyboard.

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
- **30+ built-in commands**: help, programs, results, tasks, notes, captures, capture, search, grep, head, tail, wc, sort, uniq, echo, cat, recipe, config, skills, runtime, budget, profiles, proposals, agenda, memory, scrape, propose-recipe, bridge, bridge-status, bridge-token, notify, standup, outlook
- **Cockpit events**: CLI commands emit events to the cockpit activity stream (recipe save/run/approve, memory store/forget, scrape)
- **API**: `POST /api/cli/run {command}`, `GET /api/cli/help`, `GET /api/cli/commands`, `GET /api/budget`, `GET /api/models`

## Galaxy Context Scraper & Knowledge Base (server/galaxy-scraper.ts)

- **Autonomous Galaxy browsing**: When enabled, proactively searches Epic Galaxy (galaxy.epic.com) for documentation on terms discovered during Epic agent runs
- **Toggle**: `galaxy auto on` / `galaxy auto off` — OFF by default
- **Human-like behavior**: Randomized 3-8s delays, natural referrer navigation (search page → article), 5-guide-per-session limit, 30-60s cooldowns, robots.txt compliance
- **Shared rate limiting**: CLI `galaxy search/read` and autonomous scraper share a single global lock — cannot run concurrently
- **Memory integration**: Extracted Galaxy content is chunked and stored as semantic memories with subject tags (`epic:galaxy:<term>`), linked to KB entries via `sourceKbId`
- **Agent runtime hook**: After Epic-related programs run, terms are extracted from output and queued for Galaxy lookup (15-min tick cycle)
- **Galaxy KB** (`galaxy_kb` table): Structured knowledge base with LLM-generated summaries, Epic breadcrumb categories, verification workflow, user notes
  - `galaxy kb` — Browse KB entries by category
  - `galaxy kb search <q>` — Search KB by title/summary/category
  - `galaxy kb <id>` — View full entry details
  - `galaxy kb verify <id>` — Mark verified (boosts linked memory relevance to 95)
  - `galaxy kb flag <id> [reason]` — Flag for review
  - `galaxy kb note <id> <text>` — Add user annotation
  - `galaxy kb stats` — Total/verified/flagged/category counts
- **Unified pipeline** (`ingestToKb`): `galaxy read`, `galaxy context`, and auto scraper all produce KB entries linked to agent memories
- **CLI commands**: `galaxy context <term>` (manual scrape), `galaxy auto [on|off]` (toggle/status), `galaxy queue [terms,...]` (view/add queue)
- **TreeView**: GALAXY KB section shows entries organized by Epic category, with verification status icons and memory counts
- **API routes**: `/api/galaxy-kb` (GET list), `/api/galaxy-kb/:id` (GET/PATCH/DELETE), `/api/galaxy-kb/:id/verify` (POST), `/api/galaxy-kb/:id/flag` (POST)

## Token Budget & Model Router (server/model-router.ts)

- **Dynamic model roster**: DeepSeek V3 (cheap default), Qwen 2.5 72B (cheap backup), DeepSeek R1 (standard reasoning), Claude 3.5 Sonnet (standard), Claude Sonnet 4 (premium). No free-tier models — all programs default to "cheap" tier (DeepSeek V3)
- **Live pricing**: `inputCostPer1M` / `outputCostPer1M` per model; auto-updated by `openrouter-model-scout` via OpenRouter `/api/v1/models`
- **Quality tracking**: Per-model success/fail ratio stored in `qualityTracker`; models with low quality deprioritized in cascade
- **Daily token budget**: `daily_token_budget` agent_config key (default 500K tokens); enforced in tick loop — LLM programs skipped when exhausted
- **Code-only programs**: Programs with `config.LLM_REQUIRED = "false"` always run even when budget exhausted
- **Two-stage pipeline**: Programs with `config.TWO_STAGE = "true"` try cheap model first, escalate to premium only if cheap fails
- **Roster overrides**: `model_roster_overrides` agent_config key (JSON array) merged at startup
- **Budget CLI**: `budget [status|models|set <tokens>]`; Minibuffer entries: `budget-status`, `budget-models`
- **Budget API**: `GET /api/budget` returns `BudgetStatus`, `GET /api/models` returns roster with quality scores
- **Strategist program**: `budget-strategist` runs daily at 2AM, produces budget efficiency report

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

## Memory & Evolution Engine

### Memory Backend (server/qdrant-client.ts, server/memory-consolidation.ts)
- **Qdrant hybrid search**: Dense cosine (Ollama embeddings) + BM25 sparse (FNV-1a hash-based TF) via Reciprocal Rank Fusion
- **Three memory types**: episodic (events/observations), semantic (facts with subject+contradiction detection), procedural (strategies/procedures)
- **Graceful fallback**: All operations work via Postgres when Qdrant is unreachable
- **Contradiction detection**: New semantic facts with same subject automatically expire old ones (valid_until timestamp)
- **Token-budget-aware context**: Prioritizes facts > episodes > procedures when building memory context
- **Migration endpoint**: `POST /api/memory/migrate-to-qdrant` migrates existing Postgres memories to Qdrant
- **Hybrid search API**: `GET /api/memory/search?q=<query>&limit=N&program=<name>`

### Memory Consolidation (server/memory-consolidation.ts)
- After each program run, LLM consolidation judge extracts episodes, semantic facts, and procedures from session data
- Falls back to heuristic extraction (correction patterns, preference patterns, procedure detection) when judges unavailable or cost-capped

### Self-Evolution Engine (server/evolution-engine.ts)
- **6-step pipeline**: observe → critique → deltas → 5-gate validation → apply → rollback
- Observations extracted by LLM judge (regex fallback), critiqued, then translated to config deltas
- Config files: `server/evolution-config/` — constitution.md (immutable), persona.md, user-profile.md, domain-knowledge.md, strategies/ (task-patterns, tool-preferences, error-recovery)
- **5 validation gates**: constitution (triple-Sonnet, minority veto), regression (golden suite check), size (line limits), drift (Jaccard similarity), safety (dangerous pattern + triple-Sonnet)
- **Auto-rollback**: If 7-day success rate drops below threshold after evolution, previous version auto-restored
- **Golden suite**: Successful corrections promoted to test cases; capped at configurable max size
- **PROPOSE: enhancement**: Agent proposals routed through gates before storage; rejected proposals stored with explanations
- **Version history**: Full change/gate/metrics tracking in `evolution_versions` table

### LLM Judges (server/llm-judges.ts)
- Triple-Sonnet with minority veto (constitution + safety gates) — fail-closed on errors
- Cascaded Haiku→Sonnet (regression gate) — Haiku first, Sonnet override if rejected
- Observation extraction, quality assessment, consolidation judges
- Daily cost cap (JUDGE_DAILY_COST_CAP env var), all costs tracked in `judge_cost_tracking` table

### Evolution UI (10:EVO)
- Version history with gate results, metrics snapshots, rollback controls
- Metrics dashboard: success rate, correction rate, run count, golden suite size
- Judge cost tracking with breakdown by type
- Observation viewer with consolidation trigger
- Qdrant migration button

### Database Tables
- `agent_memories` — Extended with `subject`, `valid_until`, `qdrant_id` columns
- `evolution_versions` — Version tracking with changes, gate results, metrics snapshots
- `golden_suite` — Regression test cases from successful corrections
- `evolution_observations` — Extracted observations with consolidation tracking
- `judge_cost_tracking` — Daily LLM judge cost tracking by type

### Environment Variables
- `QDRANT_URL` — Qdrant instance URL (default: http://localhost:6333)
- `OLLAMA_URL` — Ollama embedding server URL (default: http://localhost:11434)
- `EMBEDDING_MODEL` — Ollama model for embeddings (default: nomic-embed-text)
- `QDRANT_TIMEOUT_MS` — Qdrant request timeout (default: 5000)
- `JUDGE_DAILY_COST_CAP` — Daily cost cap for LLM judges (default: 5.0)
- `MAX_GOLDEN_SUITE_SIZE` — Max golden suite entries (default: 100)
- `DRIFT_THRESHOLD` — Jaccard similarity threshold for drift gate (default: 0.4)
- `SUCCESS_RATE_ROLLBACK_THRESHOLD` — Auto-rollback trigger (default: 0.6)

## Memory Commands (server/cli-engine.ts)

- `memory show` — View all persistent memory
- `memory store <text>` — Append timestamped entry to persistent context
- `memory search <query>` — Search persistent context + agent results (now uses hybrid search)
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

## Voice Command Webhooks (server/routes.ts)

- `POST /api/voice-cmd` — Natural language voice command endpoint (Google Home / IFTTT). Accepts `{text, source}`, maps to CLI commands via keyword matching, executes, and optionally sends ntfy notification with result. Supports: inbox/email, agenda, snow, standup, tasks, teams, citrix, memo/remember, search/find, notify. Unrecognized text saved as capture.
- `POST /api/memo` — Simple memo webhook. Accepts `{text, source, tags}`, saves as note tagged `memo`+`voice`. Compatible with IFTTT `value1`/`value2` fields.
- Both endpoints require `Authorization: Bearer <OPENCLAW_API_KEY>` header.

## Notifications (server/cli-engine.ts)

- `notify <message>` — Send a push notification (or pipe: `standup | notify`)
- Supports ntfy.sh (free, no account) and generic webhooks
- Config: `config set notify_channel <channel>` for ntfy.sh, `config set notify_webhook <url>` for webhooks
- For ntfy.sh: install the ntfy app on your phone, subscribe to the same channel name

## Morning Standup (server/cli-engine.ts)

- `standup` — Two-tier morning briefing:
  - **Tier 1** (LLM-generated): TLDR, highlights, per-agent sections, needs-attention — synthesized by Claude Sonnet
  - **Tier 2** (data-driven): Full Source Feed with all items from Reddit (16 subs), HN, GitHub Trending, ArXiv CS.AI, Lobsters, Lemmy — rendered directly from structured JSON embedded in research-radar output via `<!--STRUCTURED_DATA_START/END-->` markers
  - Voice script appended as `<!--VOICE_SCRIPT_START/END-->` for TTS
  - All URLs sanitized via `safeUrl()` (https-only), HTML-escaped with quote protection
- `standup --days N` — Look back N days instead of 1
- `standup --raw` — Plain text version (no LLM, no Tier 2)
- Saved recipe: `morning-briefing` = `standup --days 1 | notify` (cron `0 13 * * *` = 6am PT)
- `rawOutput` limit: 100K chars (increased from 50K to fit structured data)

## Agent Runtime

- Programs read from DB `programs` table
- Inline TypeScript code executed via subprocess (`npx tsx`) for TypeScript support
- LLM cascade (cheap → standard → premium) via model-router; NO free-tier models
- Results written to `agent_results` table
- Proposals written to `openclaw_proposals` table
- PROPOSE: / REMEMBER: directives in LLM output auto-create proposals/memory
- **Recipe scheduler**: `tickRecipes()` runs inside the main tick loop, checks recipes with cron schedules and executes them automatically
- **Default model**: `openrouter/anthropic/claude-sonnet-4` everywhere (NO free models for real work)
- **Research Radar** (research-radar, program id=3): Self-improving closed-loop research system. Dual-source Reddit strategy: Channel A fetches user's authenticated front page via bridge (`/best.json`), Channel B scrapes configurable niche subs. Cross-run dedup via content hashing (7-day window, `radar_seen_items` table). Engagement tracking records user clicks on briefing links (`radar_engagement` table), feeding topics/sources back into the filter prompt. Source quality scoring tracks signal-to-noise per source with exponential smoothing, persisted to program config across runs. Dynamic config: niche subs, interest areas, thresholds, enabled sources, Lemmy communities, ArXiv category stored in program `config` JSON (not hardcoded). Score threshold filters low-scoring niche Reddit items. Structured proposals (`add-source`, `drop-source`, `add-interest`, `adjust-threshold`) auto-generated and applied on approval. Radar Health footer in briefings. Two-stage Claude Sonnet pipeline. Code stored in DB; update via `scripts/fix-radar-code.ts`. API endpoints: `/api/radar/seen`, `/api/radar/engagement` (all require auth). Inline scripts use `__apiKey` for authenticated API calls.
- **overnight-digest** (program id=18): Goal-oriented daily intelligence brief. Fetches `user_goals` from config, parses research-radar structured data, keyword-matches items to goals. LLM prompt produces 6-section brief (Goal Progress, Deep Reads, Developing Threads, Agent Activity, Action Items, System Health). Generates CRT-themed wiki-style HTML to `.briefings/digest-YYYY-MM-DD.html` (served at `/briefings/:filename`). Auto-sends via ntfy (channel=`rachael-standup`, email forwarding) with truncated summary + Click link to full brief. DeepSeek→Claude cascade. Cron `0 13 * * *` (6am PT).
- **User goals**: Stored in `agent_config` key `user_goals` as JSON array `[{name, keywords[], priority}]`. 5 goals seeded. CLI: `goals list`, `goals add <name>`, `goals remove <name>`. Used by overnight-digest for goal-matched research.
- **Morning briefing** (standup CLI): HTML email with navigable index + NPR-style voice synthesis (Microsoft Edge neural TTS via `msedge-tts`). Cron `0 13 * * *` (6am PT). Voice script generated by LLM, synthesized to MP3, attached to ntfy notification.
- **Auto-start**: Runtime defaults to `active: true`, control mode defaults to `agent` — no manual activation needed after server restart
- **Bridge-aware programs**: Inline code wrapper auto-injects `bridgeFetch()` and `smartFetch()` helpers. Programs can call `bridgeFetch(url, opts)` to route through Chrome extension (tries bridge first, falls back to direct). `smartFetch(url, init)` is a drop-in `fetch()` replacement that auto-bridges on 403/429/503. Bridge token + port passed via subprocess env vars (`__BRIDGE_TOKEN`, `__BRIDGE_PORT`).

## Seeded Programs (12) — ALL with real inline code

All programs have hardened inline TypeScript code (no LLM-only programs remaining):
- hn-pulse — HN top stories via Firebase API
- openrouter-model-scout — Tests free model availability on OpenRouter
- research-radar (meta) — Self-improving radar: dual-source Reddit (front page + niche subs), cross-run dedup, engagement-informed filtering, source quality scoring, structured proposals, Radar Health footer. Aggregates HN + GitHub trending + Lobsters + Lemmy + ArXiv CS.AI via Claude Sonnet
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
- `client/src/lib/crt-theme.tsx` — CRT phosphor theme provider (7 themes: amber, green, blue, devtools, solarized, dracula, redAlert)
- `client/src/lib/queryClient.ts` — API client with configurable backend URL (`apiUrl()`, `setApiBase()`, `getApiBase()`)

## Remote Backend (DO Droplet)

The web app can connect to a remote backend (e.g., DigitalOcean droplet) instead of the local server:
- **Set via env**: `VITE_API_BASE=https://your-domain.com` at build time
- **Set via localStorage**: `localStorage.setItem("rachael_api_base", "https://your-domain.com")`
- **Set via command palette**: `M-x set-api-base`, then type the URL (e.g., `https://rachael.yourdomain.com`)
- **Clear**: `M-x` then type `reset-api-base` or `clear-api-base`
- All API calls (`fetch`, React Query, SSE) route through `apiUrl()` which prepends the base
- CORS is enabled on the server (`origin: true, credentials: true`)

## TV Mode (Google TV Integration)

- Activate via `?tv=1` query parameter or `toggle-tv-mode` command in palette
- Persisted in localStorage (`rachael-tv-mode`), auto-activates on subsequent loads
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

## Epic Hyperspace Activity Scanner (tools/epic_scan.py)

- **Desktop Python script** that explores Hyperspace menus via screenshots + Claude vision (OpenRouter)
- Uses `pyautogui` + `pygetwindow` to find/screenshot Hyperspace windows, `Pillow` for image processing
- Sends screenshots to Claude via OpenRouter to identify menu items, buttons, tabs, activities
- Posts discovered activities to Rachael API: `POST /api/epic/activities` (auth: Bearer bridge token)
- Activities stored in `agent_config` as `epic_activities_sup`, `epic_activities_poc`, `epic_activities_tst`
- TreeView displays activities under EPIC (Activities) section, grouped by environment then category
- CLI commands: `epic activities <env>`, `epic clear <env>`, `epic scan` (setup instructions)
- API: `GET /api/epic/activities/:env` (read), `POST /api/epic/activities` (write, merges with existing)

## Epic Desktop Agent (tools/epic_agent.py)

- **Background Python agent** that polls Rachael for commands and drives Hyperspace via Claude vision
- Requires env vars: `OPENROUTER_API_KEY`, `BRIDGE_TOKEN` (no hardcoded defaults)
- Commands: navigate (go to activity), screenshot (capture screen), click (click element by name), scan (full menu scan)
- Agent heartbeat/polling every 3s; status endpoint shows connected/disconnected with 60s staleness timeout
- Screenshots stored in-memory Map (max 50), returned as base64 PNG
- Download script: `GET /api/epic/agent-script`
- API endpoints: `/api/epic/agent/commands`, `/api/epic/agent/heartbeat`, `/api/epic/agent/results`, `/api/epic/agent/send`, `/api/epic/agent/status`, `/api/epic/agent/screenshot/:id`
- CLI commands: `epic navigate <env> <target>`, `epic screenshot <env>`, `epic click <env> <element>`, `epic status`, `epic setup`
- M-x commands: epic-status, epic-navigate, epic-screenshot, epic-click, epic-activities, epic-setup
- TreeView: double-click/Enter on epicActivity sends `epic launch <env> <name>` (search bar method); epicTreeNode uses `epic go` if navPath exists, else `epic launch`
- **CRITICAL: Epic search bar requires minimum 2 characters** before showing results. Single-letter prefixes return nothing. search-crawl must start with 2-letter combos (aa-zz).
- **Epic search is FUZZY** — typing "ch" may return "Chart Review" AND "Discharge" AND "Schedule". Not all results start with the typed prefix. search-crawl must collect ALL returned items, not just prefix-matching ones. Truncation detection should count total visible results, not just prefix-matching ones.
- **SendInput (ctypes) for all keyboard input** — All keyboard operations (typewrite, press, hotkey) now use Windows SendInput API via ctypes instead of pyautogui. This is the lowest-level input method and matches real hardware keystrokes, which Citrix forwards correctly. pyautogui is kept only for mouse clicks and as a fallback in SEARCH_OPENERS (`pyautogui_ctrl_space`, `pyautogui_alt_space`) that the calibration system can test if SendInput variants fail.

## Citrix Workspace Launcher

- `citrix workspace` queues all 6 apps for simultaneous launch via Chrome extension bridge
- Default apps: SUP Hyperdrive, POC Hyperdrive, TST Hyperdrive, SUP Text Access, POC Text Access, TST Text Access
- Uses `submitJob` for instant fire-and-forget queuing (no sequential delays)
- Correct StoreFront API path: `/Citrix/CWPSFWeb/Resources/List` (238 resources)
- `citrix keepalive on/off` pings portal every 10 min to prevent session timeout
- Desktop path for .ica files: `C:/Users/mjensen/OneDrive - University of California, San Diego Health/Desktop`

## Preserved Utilities

- `skills/resilient-fetch.ts`, `skills/fuzzy-match.ts`, `skills/reddit-toolkit.ts`, `skills/craigslist-toolkit.ts`, `skills/archive-toolkit.ts`
- `server/model-router.ts`, `server/llm-client.ts`, `server/browser-bridge.ts`, `server/app-adapters.ts`, `server/scrape-buffer.ts`
- `server/output-sanitizer.ts`, `server/rate-limit.ts`, `server/skill-runner.ts`
- Chrome extension in `chrome-extension/`
