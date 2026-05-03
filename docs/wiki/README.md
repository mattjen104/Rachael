# Rachael Wiki

This wiki documents **Rachael** — your autonomous-agent / personal-OS workspace
that has grown into a multi-runtime system spanning a React+Vite frontend, an
Express+Drizzle backend, a Chrome extension, Python desktop tools, an evolution
engine, multiple LLM integrations, and 10 specialized views.

> **How to read this wiki**
>
> - Start with **[Overview](./overview.md)** for the big picture.
> - Each page is short and focused on one concern, and links to the actual
>   source files it documents (so you can jump from doc → code).
> - When you see a finding called out, the [audit](./audit.md) explains what's
>   weak and what to do about it.
> - This wiki is **hand-written from real source inspection** — the route
>   names, table names, file paths, and component names are all real and
>   current as of the audit pass. If something drifts later, follow the file
>   link and re-verify.

## Pages

### Architecture & getting oriented
- [Overview](./overview.md) — what Rachael is, top-level architecture diagram, tech stack
- [Glossary](./glossary.md) — terms you'll see throughout (minibuffer, takeover, openclaw, capture, refile, briefing, etc.)

### Frontend
- [Frontend shell & views](./frontend.md) — `Workspace.tsx`, the 10 ViewModes, routing, theming, AuthGate
- [Minibuffer & command palette](./minibuffer.md) — the M-x style command bar

### Backend
- [Server bootstrap](./backend-server.md) — `server/index.ts`, middleware stack, auth gating
- [REST API routes](./backend-routes.md) — every route group in `server/routes.ts`
- [Storage layer](./backend-storage.md) — the `IStorage` interface and Drizzle queries
- [Ask engine](./ask-engine.md) — `ask <question>` pipeline
- [Agent runtime](./agent-runtime.md) — programs, plan-execute-evaluate, tick loop
- [Evolution engine](./evolution.md) — observe → critique → deltas → 5-gate validation → apply → rollback
- [Model router & token budget](./model-router.md) — model roster, cost tiers, daily budget
- [Control bus & permissions](./control-bus.md) — autonomous/approval/blocked, takeover points
- [Browser bridge & bridge queue](./bridge.md) — Chrome extension protocol, smartFetch, job queue
- [Scrapers (universal + galaxy)](./scrapers.md) — site profiles, navigation paths, Galaxy KB
- [Replay engine](./replay.md) — recipe synthesis, BFS pathfinding, instant replay
- [Transcription & voice synth](./transcription-voice.md) — meeting recording, NPR-style TTS
- [Memory subsystem](./memory.md) — Qdrant + Postgres hybrid search, consolidation
- [Sanitization & rate limiting](./safety.md) — `sanitize.ts`, `output-sanitizer.ts`, `rate-limit.ts`
- [Secrets & magic links](./secrets.md) — encrypted secret collection
- [CLI engine](./cli.md) — every Unix-style command, chain operators, recipes

### Data
- [Data model](./data-model.md) — every Drizzle table, columns, relationships, ER diagram

### Integrations
- [Outlook & Teams](./integrations-outlook-teams.md)
- [ServiceNow](./integrations-snow.md)
- [Galaxy KB](./integrations-galaxy.md)
- [Epic Hyperspace (pywinauto / vision)](./integrations-epic.md)
- [Foundation Hosted](./integrations-foundation-hosted.md) — Epic's hosted environment; not currently first-class in code (see page)
- [Citrix workspace launcher](./integrations-citrix.md)
- [Pulse (UCSD intranet)](./integrations-pulse.md)
- [Chrome extension](./integrations-chrome-extension.md)
- [GitHub (trending + research-radar source)](./integrations-github.md)
- [Notifications (ntfy / webhooks / email)](./integrations-notify.md)
- [LLM providers (Anthropic, OpenAI, OpenRouter)](./integrations-llm.md)
- Qdrant — see [Memory subsystem](./memory.md) (Qdrant is the vector backend, not a standalone integration page)

### Desktop & automation
- [Desktop automation tools](./desktop-tools.md) — `tools/epic_agent.py`, `tools/epic_scan.py`, `tools/ocr_overlay.py`, TUI client

### Operations
- [Environment variables](./env.md) — full reference (`.env.example` + variables not documented there)
- [Build, deploy, run](./operations.md) — `npm run dev`, `script/build.ts`, `scripts/do-install.sh`, `scripts/post-merge.sh`
- [Seed data](./seed-data.md) — what `server/seed-data.ts` provisions on first boot

### Quality
- [Testing](./testing.md) — what `tests/` covers and what doesn't
- [**Best-practices audit**](./audit.md) ⚠ — blind spots and recommended fixes, grouped by area

---

Source-of-truth: this wiki was generated against the repo's current state.
The original long-form notes that the owner has been writing live in
[`replit.md`](../../replit.md) at the repo root — that file is also
authoritative and frequently updated by the owner.
