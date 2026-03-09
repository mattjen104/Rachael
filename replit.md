# OrgCloud Space

A Doom Emacs-inspired web application for managing Org-mode knowledge files backed by iCloud Drive integration and a system clipboard manager.

## Architecture

- **Frontend**: React + Vite + Tailwind CSS v4 + shadcn/ui components
- **Backend**: Express.js REST API
- **Database**: PostgreSQL via Drizzle ORM
- **Routing**: wouter (frontend), Express (backend)

## Key Features

1. **Org Buffer View** (default) - All org files rendered as one continuous buffer. Each file becomes a `*` top-level heading with its content's headings bumped one level deeper. Looks like a real Emacs org-mode terminal buffer.
2. **Agenda View** - Emacs-style org-agenda with filters: Today, Week, All TODOs, Done. Overdue items display inline in the Today view with `Sched. Nx:` indicators (N = days overdue), matching Emacs behavior. Actions on each item: toggle TODO/DONE `[ ]/[x]`, inline title editing (click to edit), reschedule `[s]` (inline date picker), delete `[d]`. Quick-add input at top.
3. **Roam View** - Backlinks research system showing all nodes with `[[link]]` connections. Each node expandable to show its content and backlinks (other headings referencing it). Terminal-style bullet organization.
4. **Clipboard/Capture View** - Full main view for smart capture. Inline editing, `t` prefix for TODO tasks, `>` nesting for heading depth, `[[` backlink autocomplete. Content type detection (URL/gif/image/code) with metadata enrichment. Always targets inbox.org.
5. **Org Capture Modal** - Quick task creation (keyboard shortcut `c`). Fields: title, target file, scheduled date, tags. Appends TODO to file's INBOX section.
6. **Inline Quick-Add** - Fast task input at top of Agenda Today view.
7. **LilyGO T-Keyboard TUI Sim** - Simulated 160x40 terminal for ESP32 hardware device at `/tui`.
8. **Four-View Architecture** - Workspace has exactly 4 swappable views (Org/Agenda/Roam/Capture) via a narrow icon sidebar. No file-centric navigation — everything is view-centric. All GUI icons replaced with ASCII/Unicode text characters for terminal authenticity.
9. **Minibuffer (M-x Command Launcher)** - Emacs-authentic minibuffer at screen bottom, activated by `SPC` (Doom leader key) or `Ctrl+K`/`Cmd+K`. Also clickable via `M-x` button in StatusBar. Fuzzy-matched completion candidates expand upward from the input line. Built-in commands: view switching, org-capture, theme cycling, heading search (prefix `/`). After execution, the StatusBar echo area briefly displays the command result. Designed as the universal interaction paradigm — scales from TUI to desktop. Uses `cmdk` for fuzzy matching.
10. **Clipboard Template Filing** - Each clipboard item has inline `[t]` (todo), `[n]` (note), `[l]` (link) buttons. One click files the item to the default org file using the selected template format. `[t]` creates a TODO with SCHEDULED date. `[n]` creates a plain heading. `[l]` creates a heading with URL, description, and image metadata as body content. After filing, the clipboard item is archived.
11. **Rich Link Capture** - When filing a URL clipboard item as `[l]`, the org entry automatically includes enriched metadata: page title as heading, URL, og:description, og:image link, and source domain as body content.
12. **Inline Gif/Image Preview** - Gif and image URLs in the clipboard render as inline previews. Gifs play at larger size (max-h-40) for visibility.
13. **CopyQ-style Clipboard Management** - Clipboard items can be pinned (`[★]`/`[☆]` toggle) to float to the top and persist. `[⎘]` copy-back button copies content to system clipboard with visual flash. Collapsible `▸ history` section at bottom shows archived items with `[⎘]` copy and `[↑]` unarchive buttons.
14. **Clipboard Pinning** - Pinned items (`pinned` boolean column) sort first in the list and get a subtle visual highlight. Toggle via `[★]`/`[☆]` button on hover.
15. **Agenda § Navigation** - Clicking `§ filename.org` in the Agenda view switches to the Org buffer and scrolls to that file's section. Dead navigation links are now functional.
16. **Heading Jump from Minibuffer** - Selecting a heading from minibuffer search (`/`) now switches to the Org view and scrolls to the exact heading, not just the view.
17. **New Org File Creation** - `create-file` minibuffer command creates new empty `.org` files. Prompts for filename, auto-appends `.org` extension.
18. **Clickable TODO Toggling in Org View** - TODO/DONE keywords in the unified Org buffer are now clickable. Clicking toggles status in-place (via `useToggleOrgStatus`), no need to enter INSERT mode.
19. **Minibuffer Clipboard Search** - `clipboard-search` command in M-x opens a clipboard-specific fuzzy search. Shows all active + archived items, selecting one copies content to system clipboard.
20. **Consistent StatusBar Echo Feedback** - Success messages (capture, filing) now echo through the StatusBar area instead of toast popups. Toasts reserved for errors only.
21. **Navigable Roam Links** - `[[links]]` in the Roam view body content are clickable — clicking navigates to (expands) the target node. Backlink items are also clickable, expanding the source node and scrolling to it.

## Key Server Components

- `server/org-parser.ts` - Parses raw org file content to extract headings, TODO/DONE status, SCHEDULED/DEADLINE dates, tags, and properties. Also provides `buildAgenda()` for grouping items by date (overdue/today/upcoming) and `toggleHeadingStatus()` for in-place status toggling.
- `server/capture-parser.ts` - Simplified capture language: single `t` prefix for TODO tasks, no prefix = plain note. Supports `>` nesting (`> t` = level 3, `>> t` = level 4). Uses `chrono-node` for NL date parsing; "due/by" → DEADLINE, other dates → SCHEDULED. Exports `parseCaptureEntry()`, `formatOrgEntry(parsed, body?)`, `formatNoteContent(text, body?)`.
- `server/content-detector.ts` - Auto-detects clipboard content type (url/gif/image/code/text). `fetchUrlMetadata()` fetches page title, og:description, og:image, and domain from URLs.

## Data Model (shared/schema.ts)

- `orgFiles` - Org-mode file storage (name, content)
- `clipboardItems` - Clipboard capture history (content, type, timestamp, archived, pinned, detectedType, urlTitle, urlDescription, urlImage, urlDomain)
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
- `POST /api/org-query/reschedule` - Change SCHEDULED date for a heading by fileName + lineNumber + newDate
- `POST /api/org-query/edit-title` - Edit heading title text by fileName + lineNumber + newTitle
- `POST /api/org-query/delete-heading` - Delete a heading and its body by fileName + lineNumber

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

## Chrome Extension (Side Panel)

The `chrome-extension/` directory contains a Manifest V3 Chrome extension that embeds OrgCloud Space as a persistent side panel in the browser.

### Features
- Full OrgCloud Space interface (all 4 views) in Chrome's Side Panel
- `Alt+C` keyboard shortcut opens the panel with page context (URL, title, selected text)
- Capture modal pre-fills from the current page when triggered via the extension
- Settings page to configure the OrgCloud Space API URL

### Local Installation
1. Publish the OrgCloud Space app on Replit (or use the dev preview URL)
2. Open Chrome and go to `chrome://extensions`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked" and select the `chrome-extension/` folder
5. Click the extension icon or press `Alt+C` to open the side panel
6. Click the ⚙ settings gear and enter your OrgCloud Space URL
7. The full app loads in the side panel — capture, browse org files, check agenda, navigate Roam links

### How Capture Works
When you press `Alt+C` on any webpage, the extension grabs the page title, URL, and any selected text, then sends it to the app via `postMessage`. The OrgCapture modal opens pre-filled with this context — the title from the page, selected text as the body, and the URL. Choose a template ([t] todo, [n] note, [l] link), pick a target org file, and submit.

### Files
- `manifest.json` — Manifest V3 config with sidePanel, activeTab, scripting permissions
- `background.js` — Service worker to open side panel on action click
- `sidepanel.html/js/css` — Side panel UI with iframe embedding the app
- `options.html/js/css` — Settings page for API URL configuration

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
