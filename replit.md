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

## Five-View Architecture

Narrow tab bar at top, full-height views below:

1. **Agenda View** (1:AGD) — Default. Overdue tasks, today's tasks, upcoming, latest agent briefings. Sections fold/unfold with Tab.
2. **Tree View** (2:TRE) — Everything in one hierarchy: tasks, programs, skills, notes, inbox, reader pages. Tab to fold sections.
3. **Programs View** (3:PRG) — List of all programs with enable/disable, trigger, runtime status. Runtime ON/OFF toggle.
4. **Results View** (4:RES) — Chronological agent outputs. Tab to expand full output.
5. **Reader View** (5:RDR) — Saved web pages. Enter to read, Escape to go back.

## Keyboard Navigation

- `j`/`k` — Move cursor up/down
- `g`/`G` — Jump to top/bottom
- `Tab` — Fold/unfold section or expand detail
- `Enter` — Toggle task status, open item
- `Escape` — Back to agenda
- `1-5` — Switch views directly
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

## Agent Runtime

- Programs read from DB `programs` table
- Inline TypeScript code executed in sandboxed `AsyncFunction`
- LLM cascade (free → cheap → standard → premium) via model-router
- Results written to `agent_results` table
- Proposals written to `openclaw_proposals` table
- PROPOSE: / REMEMBER: directives in LLM output auto-create proposals/memory

## Seeded Programs (12)

hn-pulse, openrouter-model-scout, research-radar (meta), hn-deep-digest, github-trending, estate-car-finder, fed-rates, free-stuff-radar, sec-filings, price-watch, foreclosure-monitor, mandela-berenstain

## Key Server Files

- `server/routes.ts` — REST API for all entities
- `server/storage.ts` — Database CRUD layer
- `server/agent-runtime.ts` — Program execution, scheduling, LLM cascade
- `server/llm-client.ts` — Multi-provider LLM client (Anthropic, OpenAI, OpenRouter)
- `server/model-router.ts` — Model selection, cost tiers, task type detection
- `server/seed-data.ts` — Initial program/skill/config data
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
