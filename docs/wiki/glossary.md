# Glossary

Terms used throughout Rachael's UI, CLI, and source code.

| Term | Meaning |
|------|---------|
| **Minibuffer** | The Emacs-style command palette at the bottom of the web UI (`client/src/components/editor/Minibuffer.tsx`). Modes: `command`, `search`, `capture`, `add-url`, `shell`. |
| **M-x** | Emacs convention for "execute extended command" — Rachael opens the minibuffer in `command` mode via Space, Alt-X, or Ctrl-K. |
| **Capture** | Quickly throw text into the inbox (`captures` table) without classifying it. Templated forms (task `t `, journal `j`, screenshot `s`, bookmark `b`, meeting `m`) live in `shared/capture-templates.ts`. |
| **Refile** | Convert a capture into a task or note (`POST /api/captures/:id/refile`). |
| **Inbox** | The list of unprocessed captures shown in the Tree view. |
| **Briefing** | A daily digest produced by `standup` and `overnight-digest` programs. HTML files saved to `.briefings/` and served at `/briefings/:filename`. |
| **Standup** | The morning briefing CLI (`server/cli-engine.ts`). Two-tier output (LLM TLDR + raw source feed). |
| **Program** | A user-authored automation stored in the `programs` table with inline TypeScript code, optional schedule/cron, optional config, and a cost tier. |
| **Skill** | A reusable toolkit (e.g. `resilient-fetch`, `fuzzy-match`) stored in `skills` table or shipped in `skills/*.ts`. |
| **Recipe** | A saved CLI command chain that can be triggered manually or on cron (`recipes` table). |
| **Runtime** | The autonomous tick loop in `server/agent-runtime.ts`. Toggle ON/OFF from the Programs view or `runtime` CLI. |
| **Tick** | One loop iteration of the runtime — finds due programs/recipes, runs them, applies budget. |
| **Cost tier** | `cheap` / `standard` / `premium` — picks a model from the roster in `server/model-router.ts`. |
| **Token budget** | `daily_token_budget` agent_config key. LLM-required programs are skipped when exhausted. |
| **Roster** | The model list returned by `getModelRoster()` (DeepSeek, Qwen, Sonnet, etc.) with live pricing. |
| **Openclaw** | Internal codename for Rachael's self-modification system. The `openclaw_proposals` table holds proposed config / recipe changes. |
| **Proposal** | A pending `openclaw_proposals` row. Apply via `proposals approve <id>` or via the cockpit. |
| **Evolution** | The 6-step LLM-judged self-improvement loop in `server/evolution-engine.ts`. |
| **Gate** | One of the 5 evolution validation gates (constitution, regression, size, drift, safety). |
| **Golden suite** | Regression test cases promoted from successful corrections (`golden_suite` table). |
| **Constitution** | Immutable agent rules in `server/evolution-config/constitution.md`. Triple-Sonnet judge with minority veto enforces them. |
| **Soul prompt** | The persona/system prompt assembled from `server/evolution-config/persona.md` + related files. |
| **Memory** | Long-term knowledge in `agent_memories` (and optionally Qdrant). Three types: episodic, semantic, procedural. |
| **Qdrant** | Optional vector DB for hybrid (dense + sparse BM25) search. Falls back to Postgres `ilike`. |
| **Consolidation** | Post-run LLM judge that extracts memories from raw program output (`server/memory-consolidation.ts`). |
| **Subject** | The thing a semantic memory is about. Used for contradiction detection (a new fact about the same subject expires the old one). |
| **Galaxy KB** | The Epic-documentation knowledge base (`galaxy_kb` table, `server/galaxy-scraper.ts`). |
| **Bridge** | Routes a fetch through the user's real Chrome via the extension. `smartFetch()` tries bridge first, falls back to direct fetch. |
| **Bridge token** | UUID shared secret sent in `X-Bridge-Token` by the extension. Persisted via `BRIDGE_TOKEN` env var. |
| **Bridge-only domain** | A host that *must* go through the extension (Reddit, Outlook, Teams, Galaxy, Epic, UCSD). Direct fetch is blocked. |
| **Site profile** | A configurable scraper definition: URL patterns + extraction selectors + named actions (`site_profiles` table). |
| **Navigation path** | An ordered sequence of steps (navigate / click / type / wait / extract) tied to a profile (`navigation_paths` table). |
| **Replay** | Re-executing a saved navigation recipe with fingerprint verification (`server/replay-engine.ts`). |
| **Recipe (replay-engine)** | An LLM-synthesized procedure per navigation edge (different concept from the `recipes` table — those are CLI command chains). |
| **Fingerprint** | A short content/screen hash used to detect "same screen" before/after navigation. |
| **Takeover point** | A pause in agent execution that requires a human to confirm, reject, or take over. |
| **Permission level** | `autonomous` (agent runs freely), `approval` (waits for human), `blocked` (refused). Stored per action in `action_permissions`. |
| **Audit log** | `audit_log` table — actor (human/agent), action, target, permission level, result, timestamp. |
| **Cockpit** | The shared-control view (`client/src/components/views/CockpitView.tsx`) where takeover points appear and the human can switch the control mode. |
| **Control mode** | `human` or `agent` — who is currently driving. Tracked in the control bus. |
| **AuthGate** | The full-screen login splash (`client/src/components/AuthGate.tsx`) that asks for `OPENCLAW_API_KEY` if the server requires auth. |
| **CRT theme** | The phosphor color scheme (`amber`, `green`, `blue`, `devtools`, `solarized`, `dracula`, `redAlert`) provided by `client/src/lib/crt-theme.tsx`. |
| **TV mode** | A scaled-up layout for Google TV (`?tv=1` or `toggle-tv-mode` in palette). |
| **Boot** | Morning startup sequence (`epic login` → `outlook sync` → `snow sync` → `citrix keepalive`). |
| **Smart capture** | The `POST /api/captures/smart` endpoint that parses raw text into a task or note based on cues (date words, `TODO`, etc). |
| **Smart routing** | `ask` engine's complexity classifier that picks cheap/standard/premium model tiers. |
| **Two-stage pipeline** | A program with `config.TWO_STAGE = "true"` tries cheap first, escalates to premium only on failure. |
| **DOM job** | A bridge job type that opens a real Chrome tab, lets JS render, and runs a content script for extraction (vs. raw HTTP `fetch` job). |
| **Heartbeat** | Periodic POST from the Chrome extension or Epic desktop agent that keeps "connected" status alive (90s window for extension, 60s for Epic). |
| **Pulse** | A program/integration that scrapes the user's intranet directory. |
| **Estate-car-finder, free-stuff-radar, foreclosure-monitor** | Domain-specific seeded scraping programs. See `server/seed-data.ts`. |
