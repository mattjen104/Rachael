# OrgCloud Space

A Doom Emacs-inspired web application for managing Org-mode knowledge files backed by iCloud Drive integration and an OpenClaw management control plane.

## Architecture

- **Frontend**: React + Vite + Tailwind CSS v4 + shadcn/ui components
- **Backend**: Express.js REST API
- **Database**: PostgreSQL via Drizzle ORM
- **Routing**: wouter (frontend), Express (backend)

## Three-View Architecture

The workspace has exactly 3 swappable views via a narrow icon sidebar. All GUI icons are ASCII/Unicode text characters for terminal authenticity.

1. **Outliner View** (`{*}`) — Single-document editor with Emacs-style buffer tab bar to switch between org files. Shows file title header (from `#+TITLE:`) and full heading tree for the selected file. Features: drag-and-drop reordering, guide lines, collapsible children, draggable body paragraphs, backlinks with `[N]` indicator, inline editing. Keyboard: `[`/`]` cycle buffers, `j`/`k` cursor navigation, `?` which-key overlay.

2. **Agenda View** (`☰`) — 4 tabs: Today, Week, TODOs, Done.
   - **Today tab**: Daily page backed by `journal.org`. Shows date header, DailyInput (smart parsing: `t ` task, `>` nesting, `[[` backlinks, plain text = note), scheduled/overdue items, daily log entries. Collapsible `▸ captured (N)` section shows items with cross-file references (Referenced from/Captured to). Tasks cross-file to inbox.org; notes stay in journal.
   - **Week/TODOs/Done tabs**: Cross-file flat lists showing ALL items from ALL org files.
   - `§ filename` links navigate to the Outliner view with that file selected.
   - Keyboard: `1-4` switch tabs, `j`/`k` cursor navigation, `?` which-key overlay.

3. **Control View** (`⌘`) — Mail/Teams/OpenClaw dashboard. Three sub-tabs: `[mail]` for Outlook inbox scraping, `[teams]` for Teams chat scraping, `[claw]` for OpenClaw autonomous AI agent management. Bridge status indicator shows browser connection state. Login flow opens visible Playwright browser for Microsoft auth.

## Key Features

- **Org Capture Modal** — Quick task creation (`Alt+C`). Templates: todo, note, link + OpenClaw templates (skill, program, channel — shown only when target file is `openclaw.org`). Skill template generates `:skill:` tagged heading with PROPERTIES (DESCRIPTION, VERSION). Program template generates TODO `:program:` heading with SCHEDULED repeater, METRIC/DIRECTION properties, Results sub-heading. Channel template inserts under CONFIG/channels. Also triggered by pasting outside any input field.
- **Daily Page System** — `journal.org` auto-populates with daily headings (`* YYYY-MM-DD Day`). Captures create references under today's heading. Completing a task (TODO→DONE) adds a CLOSED timestamp and logs a reference in the daily page.
- **DailyInput** — Smart capture input on Today tab. `t ` prefix = task, `>` = nesting, `[[` = backlink autocomplete, plain text = note. Tasks go to inbox.org + journal reference; notes go directly to journal.
- **Minibuffer (M-x)** — Emacs-style command palette at screen bottom, activated by `SPC` or `Ctrl+K`. Commands: `switch-to-outliner`, `switch-to-agenda`, `switch-to-control`, `org-capture`, `cycle-theme`, `search-headings` (prefix `/`), `clipboard-search`, `create-file`, `toggle-hints`.
- **CRT Theme System** — Phosphor monochrome profiles: Amber, Green, Blue, DevTools. Persisted in localStorage. Cycled via sidebar `#` button or `M-x cycle-theme`.
- **Clipboard API** — Chrome extension pushes clipboard items via REST API. Items can be searched via `M-x clipboard-search`. Filing buttons (`[t]`/`[n]`/`[l]`) archive items to org files.
- **OpenClaw Control Plane** — Org-mode config for autonomous AI agent: SOUL (identity), SKILLS, CONFIG (providers/channels), PROGRAMS (autonomous loops). Bidirectional sync, proposals/approval system, version history.
- **LilyGO T-Keyboard TUI Sim** — Simulated 160x40 terminal at `/tui`.

## Key Server Components

- `server/org-parser.ts` - Parses raw org file content to extract headings, TODO/DONE status, SCHEDULED/DEADLINE dates, tags, and properties. Also provides `buildAgenda()` for grouping items by date (overdue/today/upcoming), `toggleHeadingStatus()` for in-place status toggling, `moveHeadingWithinFile()` for drag-and-drop reordering, `extractHeadingBlock()` and `changeHeadingLevel()` for cross-file moves.
- `server/capture-parser.ts` - Simplified capture language: single `t` prefix for TODO tasks, no prefix = plain note. Supports `>` nesting (`> t` = level 3, `>> t` = level 4). Uses `chrono-node` for NL date parsing; "due/by" → DEADLINE, other dates → SCHEDULED. Exports `parseCaptureEntry()`, `formatOrgEntry(parsed, body?)`, `formatNoteContent(text, body?)`.
- `server/content-detector.ts` - Auto-detects clipboard content type (url/gif/image/code/text). `fetchUrlMetadata()` fetches page title, og:description, og:image, and domain from URLs.
- `server/browser-bridge.ts` - Playwright browser manager for headless Chromium. Handles launch/close, login session flow (visible → detect auth → transition to headless), session persistence.
- `server/app-adapters.ts` - Outlook email scraper and Teams chat scraper. Ported from MicroTerminal project.
- `server/scrape-buffer.ts` - In-memory buffer for scraped data. No database — scrape is triggered on demand from the UI.
- `server/sanitize.ts` - Text sanitization utility. Replaces Unicode characters with ASCII equivalents.
- `server/openclaw-compiler.ts` - Bidirectional compiler for OpenClaw config. Compile: org → SOUL.md, SKILL.md, openclaw.json, programs. Import: native files → org format.

## Data Model (shared/schema.ts)

- `orgFiles` - Org-mode file storage (name, content)
- `clipboardItems` - Clipboard capture history (content, type, timestamp, archived, pinned, detectedType, urlTitle, urlDescription, urlImage, urlDomain)
- `agendaItems` - Legacy task/agenda tracking (text, status, scheduledDate, carriedOver)
- `openclawProposals` - OpenClaw change proposals (section, targetName, reason, currentContent, proposedContent, status, createdAt, resolvedAt)
- `openclawVersions` - OpenClaw org file version snapshots (orgContent, label, createdAt)

## API Routes (server/routes.ts)

### Org Files
- `GET/POST /api/org-files` - List/create org files
- `GET /api/org-files/by-name/:name` - Get file by name
- `PATCH /api/org-files/:id` - Update file content
- `POST /api/org-files/capture` - Quick capture with explicit fields (title, fileName, scheduledDate, tags)

### Org Queries (parsed from file content)
- `GET /api/org-query/headings?q=` - Search all org headings by title substring (max 20 results)
- `GET /api/org-query/agenda` - Returns structured agenda (overdue, today, upcoming)
- `GET /api/org-query/todos` - Returns all TODO headings across files
- `GET /api/org-query/done` - Returns all DONE headings across files
- `POST /api/org-query/toggle` - Toggle TODO/DONE status
- `POST /api/org-query/reschedule` - Change SCHEDULED date
- `POST /api/org-query/edit-title` - Edit heading title
- `POST /api/org-query/delete-heading` - Delete a heading and its body
- `POST /api/org-query/move-heading` - Move a heading within a file (drag-and-drop)
- `POST /api/org-query/move-heading-cross` - Move a heading between files
- `POST /api/org-query/reorder-body-line` - Reorder body paragraphs within a heading
- `GET /api/org-query/backlinks` - Get all headings with their backlink references
- `GET /api/org-query/journal-daily?date=` - Get journal entries for a specific date
- `POST /api/org-query/journal-add` - Add a note to today's journal
- `POST /api/org-query/daily-capture` - Smart capture to daily page (task/note/backlink)

### Clipboard
- `GET/POST /api/clipboard` - List/create clipboard items
- `PATCH /api/clipboard/:id` - Update clipboard item
- `DELETE /api/clipboard/:id` - Remove clipboard item
- `POST /api/clipboard/enrich` - Detect content type and fetch URL metadata
- `POST /api/clipboard/smart-capture` - Parse capture syntax, append to org file
- `POST /api/clipboard/:id/append-to-org` - File clipboard item to org

### Browser Bridge / Scraping
- `GET /api/browser/status` - Bridge running/auth state
- `POST /api/browser/launch` - Start headless Chromium
- `POST /api/browser/close` - Stop browser
- `POST /api/browser/login` - Open visible browser for Microsoft auth
- `POST /api/browser/login/done` - Save session cookies after login
- `GET /api/bridge/diagnostics` - Playwright/Chromium diagnostics

### Mail & Teams (in-memory)
- `GET /api/mail/scrape` - Trigger Outlook scrape
- `GET /api/mail/buffer` - Return cached emails
- `GET /api/mail/:index` - Read full email body
- `POST /api/mail/reply` - Reply to email via Playwright
- `GET /api/teams/scrape` - Trigger Teams scrape
- `GET /api/teams/buffer` - Return cached chats
- `GET /api/teams/chat/:index` - Read chat messages
- `POST /api/teams/send` - Send Teams message

### OpenClaw Control Plane
- `GET /api/openclaw/compiled` - Full compiled output
- `GET /api/openclaw/soul.md` - Raw SOUL.md text
- `GET /api/openclaw/skill/:name` - Specific SKILL.md
- `GET /api/openclaw/config.json` - Compiled openclaw.json
- `GET /api/openclaw/programs` - List of program descriptors
- `GET /api/openclaw/program/:name` - Single program instructions
- `POST /api/openclaw/program/:name/result` - Append iteration result
- `GET /api/openclaw/status` - Compile status and counts
- `POST /api/openclaw/compile` - Force recompile
- `POST /api/openclaw/import` - Import native OpenClaw files into org
- `POST /api/openclaw/propose` - Create a change proposal
- `GET /api/openclaw/proposals` - List proposals
- `POST /api/openclaw/proposals/:id/accept` - Accept proposal
- `POST /api/openclaw/proposals/:id/reject` - Reject proposal
- `GET /api/openclaw/versions` - Version history
- `POST /api/openclaw/versions/:id/restore` - Restore to previous version

### Other
- `POST /api/seed` - Seed initial data
- `GET /api/scrape/buffer` - Return entire scrape buffer (for Chrome extension)

## Pages

- `/` - Main workspace (Outliner/Agenda/Control views + sidebar)
- `/tui` - LilyGO T-Keyboard terminal simulation

## View Components

- `client/src/components/editor/OrgView.tsx` - Exports both `OutlinerView` and `AgendaView` (named exports). `AgendaView` is also the default export.
- `client/src/components/editor/MailView.tsx` - Control view (mail/teams/claw tabs)
- `client/src/components/layout/Sidebar.tsx` - View switcher sidebar. Exports `ViewMode` type (`"outliner" | "agenda" | "control"`)
- `client/src/components/layout/StatusBar.tsx` - Vim-style status bar with mode indicator and echo area
- `client/src/components/editor/Minibuffer.tsx` - M-x command palette
- `client/src/components/editor/OrgCapture.tsx` - Capture modal
- `client/src/pages/Workspace.tsx` - Main workspace layout wiring all views together

## Chrome Extension (Side Panel)

The `chrome-extension/` directory contains a Manifest V3 Chrome extension that embeds OrgCloud Space as a persistent side panel in the browser.

### Features
- Full OrgCloud Space interface in Chrome's Side Panel
- `Alt+C` keyboard shortcut opens the panel with page context (URL, title, selected text)
- Capture modal pre-fills from the current page when triggered via the extension
- Settings page to configure the OrgCloud Space API URL

### Files
- `manifest.json` — Manifest V3 config
- `background.js` — Service worker
- `sidepanel.html/js/css` — Side panel UI with iframe embedding
- `options.html/js/css` — Settings page for API URL

## Design

- CRT phosphor monochrome theme system (`client/src/lib/crt-theme.tsx`):
  - Four profiles: Default Amber (#ff8100), Mono Green (#0ccc68), Deep Blue (#7fb4ff), DevTools
  - Each profile defines full HSL color maps for all CSS variables
  - Global CRT effects via CSS: scanlines, vignette, static noise, traveling glow bar, text phosphor bloom, subtle flicker
  - Theme persists in localStorage
  - Toggle button in sidebar header cycles through profiles
- IBM Plex Mono font used site-wide (base 13px in `index.css`)
- Vim-style status bar with mode indicators
- Org-mode syntax highlighting uses brightness variations within the single phosphor hue
- Icon rule: NO Lucide SVG icons. ASCII/Unicode only.
