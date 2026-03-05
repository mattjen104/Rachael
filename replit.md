# OrgCloud Space

A Doom Emacs-inspired web application for managing Org-mode knowledge files backed by iCloud Drive integration and a system clipboard manager.

## Architecture

- **Frontend**: React + Vite + Tailwind CSS v4 + shadcn/ui components
- **Backend**: Express.js REST API
- **Database**: PostgreSQL via Drizzle ORM
- **Routing**: wouter (frontend), Express (backend)

## Key Features

1. **Org Buffer View** (default) - All org files rendered as one continuous buffer. Each file becomes a `*` top-level heading with its content's headings bumped one level deeper. Looks like a real Emacs org-mode terminal buffer.
2. **Agenda View** - Bullet-journal-style agenda derived by parsing org file content. Filters: Today, Week, All TODOs, Done. Toggles task status directly in the org file content.
3. **Roam View** - Backlinks research system showing all nodes with `[[link]]` connections. Each node expandable to show its content and backlinks (other headings referencing it). Terminal-style bullet organization.
4. **Clipboard/Capture View** - Full main view for smart capture. Inline editing, `t` prefix for TODO tasks, `>` nesting for heading depth, `[[` backlink autocomplete. Content type detection (URL/gif/image/code) with metadata enrichment. Always targets inbox.org.
5. **Org Capture Modal** - Quick task creation (keyboard shortcut `c`). Fields: title, target file, scheduled date, tags. Appends TODO to file's INBOX section.
6. **Inline Quick-Add** - Fast task input at top of Agenda Today view.
7. **LilyGO T-Keyboard TUI Sim** - Simulated 160x40 terminal for ESP32 hardware device at `/tui`.
8. **Four-View Architecture** - Workspace has exactly 4 swappable views (Org/Agenda/Roam/Capture) via a narrow icon sidebar. No file-centric navigation — everything is view-centric. All GUI icons replaced with ASCII/Unicode text characters for terminal authenticity.

## Key Server Components

- `server/org-parser.ts` - Parses raw org file content to extract headings, TODO/DONE status, SCHEDULED/DEADLINE dates, tags, and properties. Also provides `buildAgenda()` for grouping items by date (overdue/today/upcoming) and `toggleHeadingStatus()` for in-place status toggling.
- `server/capture-parser.ts` - Simplified capture language: single `t` prefix for TODO tasks, no prefix = plain note. Supports `>` nesting (`> t` = level 3, `>> t` = level 4). Uses `chrono-node` for NL date parsing; "due/by" → DEADLINE, other dates → SCHEDULED. Exports `parseCaptureEntry()`, `formatOrgEntry(parsed, body?)`, `formatNoteContent(text, body?)`.
- `server/content-detector.ts` - Auto-detects clipboard content type (url/gif/image/code/text). `fetchUrlMetadata()` fetches page title, og:description, og:image, and domain from URLs.

## Data Model (shared/schema.ts)

- `orgFiles` - Org-mode file storage (name, content)
- `clipboardItems` - Clipboard capture history (content, type, timestamp, archived, detectedType, urlTitle, urlDescription, urlImage, urlDomain)
- `agendaItems` - Legacy task/agenda tracking (text, status, scheduledDate, carriedOver)

## API Routes (server/routes.ts)

### Org Files
- `GET/POST /api/org-files` - List/create org files
- `GET /api/org-files/by-name/:name` - Get file by name
- `PATCH /api/org-files/:id` - Update file content
- `POST /api/org-files/capture` - Quick capture with explicit fields (title, fileName, scheduledDate, tags)

### Org Queries (parsed from file content)
- `GET /api/org-query/headings?q=` - Search all org headings by title substring (max 20 results). Used for `[[` backlink autocomplete.
- `GET /api/org-query/agenda` - Returns structured agenda (overdue, today, upcoming) parsed from all org files
- `GET /api/org-query/todos` - Returns all TODO headings across files
- `GET /api/org-query/done` - Returns all DONE headings across files
- `POST /api/org-query/toggle` - Toggle TODO/DONE status in org file content by fileName + lineNumber

### Clipboard
- `GET/POST /api/clipboard` - List/create clipboard items
- `PATCH /api/clipboard/:id` - Update clipboard item content and metadata
- `DELETE /api/clipboard/:id` - Remove clipboard item
- `POST /api/clipboard/enrich` - Detect content type and fetch URL metadata
- `POST /api/clipboard/smart-capture` - Parse `t` prefix with NL dates + `>` nesting, append to org file. Accepts optional `originalContent` for body embedding.
- `POST /api/clipboard/:id/append-to-org` - Append clipboard item to org file (uses capture parser for tasks, note format for plain text)

### Other
- `POST /api/seed` - Seed initial data

## Pages

- `/` - Main workspace (editor/agenda + sidebar + clipboard)
- `/tui` - LilyGO T-Keyboard terminal simulation

## Design

- CRT phosphor monochrome theme system (`client/src/lib/crt-theme.tsx`):
  - Three profiles from cool-retro-term source: Default Amber (#ff8100), Mono Green (#0ccc68), Deep Blue (#7fb4ff)
  - Each profile defines full HSL color maps for all CSS variables (background, foreground, primary, muted, border, org-syntax colors)
  - Global CRT effects via CSS: scanlines, vignette, static noise, traveling glow bar, text phosphor bloom, subtle flicker
  - Theme persists in localStorage, synced between workspace and TUI pages
  - Toggle button in sidebar header cycles through profiles
- JetBrains Mono font used site-wide (monospace everywhere for terminal feel)
- Vim-style status bar with mode indicators
- Org-mode syntax highlighting uses brightness variations within the single phosphor hue
