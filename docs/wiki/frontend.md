# Frontend shell & views

Source: [`client/src/`](../../client/src)

## Bootstrap

- [`client/src/main.tsx`](../../client/src/main.tsx) mounts `<App />`.
- [`client/src/App.tsx`](../../client/src/App.tsx) wraps the app in providers
  and a single wouter `<Switch>`:

  ```
  QueryClientProvider
   └── TvModeProvider
        └── CrtThemeProvider
             └── AuthGate
                  └── TooltipProvider
                       ├── Toaster
                       ├── TvShortcutOverlay
                       └── Router → / Workspace, * NotFound
  ```

- Routing uses [`wouter`](https://github.com/molefrog/wouter). The whole app is
  effectively a single-page workspace at `/`. `not-found.tsx` is the catch-all.

## AuthGate

[`client/src/components/AuthGate.tsx`](../../client/src/components/AuthGate.tsx)

- On mount calls `GET /api/auth/check` (no auth required).
- If the server reports `requiresAuth: true`, looks for a stored API key
  (via `getStoredApiKey()` in `client/src/lib/queryClient.ts`) and probes
  `GET /api/org-files` with `Authorization: Bearer …`.
- If the key works → render children. Otherwise show a password input that
  stores the key in `localStorage` on success.
- Catch-all `catch` falls through to `authenticated` if the server is
  unreachable, so a broken backend doesn't lock you out of the static UI.

## Workspace shell

[`client/src/pages/Workspace.tsx`](../../client/src/pages/Workspace.tsx) is the
single page (~287 lines). It owns:

| State                  | Purpose                                               |
|------------------------|-------------------------------------------------------|
| `viewMode`             | Which view component to render                        |
| `minibufferOpen`       | Whether the command palette is showing                |
| `minibufferInitialMode`| `command` / `search` / `capture` / `add-url` / `shell`|
| `lastCommand`          | Toast text for the bottom status bar                  |
| `selectedItemId`       | Pre-select when navigating into Reader/Results/etc.   |
| `pendingShellCmd`      | Pre-fill for the shell minibuffer                     |
| `editorItem`           | Inline edit task/note overlay                         |
| `captureContext`       | URL/title/selection passed in from Chrome extension   |

### ViewMode union

The `ViewMode` type lives in `client/src/components/layout/Sidebar.tsx`. The
ten panels (in tab-order) are:

| # | Key       | Component                          | Purpose                                                            |
|---|-----------|------------------------------------|--------------------------------------------------------------------|
| 1 | agenda    | `views/AgendaView.tsx`             | Today / overdue / upcoming tasks + latest agent briefings          |
| 2 | tree      | `views/TreeView.tsx` (1646 lines)  | One unified outline: tasks/notes/inbox/programs/skills/mail/snow…  |
| 3 | programs  | `views/ProgramsView.tsx`           | Toggle/trigger programs, see runtime status                        |
| 4 | results   | `views/ResultsView.tsx`            | Chronological agent outputs (expand to see full)                   |
| 5 | reader    | `views/ReaderView.tsx`             | Saved web pages (extracted text)                                   |
| 6 | transcripts | `views/TranscriptsView.tsx`      | Meeting transcripts (mic / tab / upload)                           |
| 7 | cockpit   | `views/CockpitView.tsx` (623 lines)| Activity stream, takeover points, audit, permissions               |
| 8 | snow      | `views/SnowView.tsx`               | ServiceNow incidents/changes/requests                              |
| 9 | voice     | `views/VoiceView.tsx`              | Browser mic → CLI command via Web Speech API                       |
| 0 | evolution | `views/EvolutionPanel.tsx`         | Versions, gate results, judge cost, observation viewer             |
|   | galaxy-kb | `views/GalaxyKbView.tsx`           | Galaxy Knowledge Base browsing                                     |

The number row keys `1`-`0` switch directly between views — see the keyboard
handler at `Workspace.tsx:202` (the `0` key maps to index 9 = evolution).

## Keyboard handling

Workspace registers a single `keydown` listener (`Workspace.tsx:157`) that
respects active inputs:

| Key                                    | Action                                          |
|----------------------------------------|-------------------------------------------------|
| `Esc`                                  | Close minibuffer / inline editor / back to agenda |
| `Space` or `Alt+X` or `Ctrl+K`         | Open minibuffer in **command** mode             |
| `/`                                    | Open minibuffer in **search** mode              |
| `c`                                    | Open minibuffer in **capture** mode             |
| `:`                                    | Open minibuffer in **shell** mode               |
| `1`-`9`, `0`                           | Jump to view by index                           |
| Inside views: `j`/`k`/`g`/`G`/`Tab`/`Enter` | Per-view (handled in each view)            |

A second listener (`paste` in `Workspace.tsx:139`) auto-captures any text
pasted while no input is focused (mirrors the Chrome extension's `capture` action).

## State management

- **Server state** uses TanStack Query through hooks in
  [`client/src/hooks/use-org-data.ts`](../../client/src/hooks/use-org-data.ts)
  (~558 lines, one hook per resource — `useTasks`, `usePrograms`,
  `useTriggerProgram`, `useSmartCapture`, `useAgenda`, etc.).
- **UI state** lives in `Workspace.tsx`, prop-drilled to child views. There
  is **no global UI store** — see [audit](./audit.md#frontend) for prop-drilling
  notes.

## Theming

- [`client/src/lib/crt-theme.tsx`](../../client/src/lib/crt-theme.tsx) provides
  `CrtThemeProvider` + `useCrtTheme()`. Seven themes: `amber`, `green`, `blue`,
  `devtools`, `solarized`, `dracula`, `redAlert`. Cycle with `cycleTheme()`
  (also exposed as `cycle-theme` in the minibuffer).
- [`client/src/index.css`](../../client/src/index.css) hosts the CRT scanline,
  glow, and font-mono base styles.
- [`client/src/hooks/use-tv-mode.tsx`](../../client/src/hooks/use-tv-mode.tsx)
  toggles `<html class="tv-mode">` for 10-foot Google TV layout.

## Layout chrome

- [`client/src/components/layout/Sidebar.tsx`](../../client/src/components/layout/Sidebar.tsx) — top tab bar.
- [`client/src/components/layout/StatusBar.tsx`](../../client/src/components/layout/StatusBar.tsx) — bottom bar with view name + last command + minibuffer button.
- [`client/src/components/layout/NotificationToast.tsx`](../../client/src/components/layout/NotificationToast.tsx) — long-running command notifications.

## API client

[`client/src/lib/queryClient.ts`](../../client/src/lib/queryClient.ts):

- `apiUrl(path)` prepends `VITE_API_BASE` (or localStorage `rachael_api_base`,
  or current origin) so the same client can talk to a remote DO droplet.
- `getStoredApiKey()` / `setStoredApiKey()` keep the API key in localStorage.
- `defaultFetcher` injects the `Authorization: Bearer …` header.

## Test-id coverage

Workspace, AuthGate, all view components, and most interactive elements have
`data-testid` attributes (e.g. `workspace`, `auth-gate`, `input-api-key`,
`button-auth-submit`, `text-auth-error`). The shadcn `ui/` primitives mostly
*don't* — see [audit § Frontend](./audit.md#frontend).
