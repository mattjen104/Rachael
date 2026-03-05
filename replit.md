# OrgCloud Space

A Doom Emacs-inspired web application for managing Org-mode knowledge files backed by iCloud Drive integration and a system clipboard manager.

## Architecture

- **Frontend**: React + Vite + Tailwind CSS v4 + shadcn/ui components
- **Backend**: Express.js REST API
- **Database**: PostgreSQL via Drizzle ORM
- **Routing**: wouter (frontend), Express (backend)

## Key Features

1. **Org-mode Editor** - Syntax-highlighted viewer/editor for `.org` files with Vim-style modes (NORMAL/INSERT/VISUAL)
2. **Clipboard Manager** - Captures and persists clipboard items, can append them directly into org files
3. **iCloud Capture Streams** - Sidebar showing incoming data sources (Camera Roll, Notes, Files)
4. **LilyGO T-Keyboard TUI Sim** - Simulated 160x40 terminal for ESP32 hardware device, navigated with WASD keys
5. **Agenda System** - Task tracking with automatic carryover of incomplete tasks

## Data Model (shared/schema.ts)

- `orgFiles` - Org-mode file storage (name, content)
- `clipboardItems` - Clipboard capture history (content, type, timestamp, archived)
- `agendaItems` - Task/agenda tracking (text, status, scheduledDate, carriedOver)

## API Routes (server/routes.ts)

- `GET/POST /api/org-files` - List/create org files
- `GET /api/org-files/by-name/:name` - Get file by name
- `PATCH /api/org-files/:id` - Update file content
- `GET/POST /api/clipboard` - List/create clipboard items
- `DELETE /api/clipboard/:id` - Remove clipboard item
- `POST /api/clipboard/:id/append-to-org` - Append clipboard item to org file
- `GET/POST /api/agenda` - List/create agenda items
- `PATCH /api/agenda/:id/status` - Toggle TODO/DONE
- `POST /api/agenda/carry-over` - Move incomplete past tasks to today
- `POST /api/seed` - Seed initial data

## Pages

- `/` - Main workspace (editor + sidebar + clipboard)
- `/tui` - LilyGO T-Keyboard terminal simulation

## Design

- Doom One color palette (dark theme)
- JetBrains Mono for editor typography
- Inter for UI text
- Vim-style status bar with mode indicators
