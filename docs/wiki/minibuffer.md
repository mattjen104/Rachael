# Minibuffer & command palette

Source: [`client/src/components/editor/Minibuffer.tsx`](../../client/src/components/editor/Minibuffer.tsx) (~833 lines)

The minibuffer is the bottom-of-screen Emacs-style command bar. It is the
primary UX for issuing commands without leaving the keyboard.

## Modes

| Mode      | Trigger                | Behavior                                              |
|-----------|------------------------|-------------------------------------------------------|
| `command` | Space, Alt+X, Ctrl+K   | Filter and execute named commands (switch view, capture, theme, runtime, budget-status, evolution-…, set-api-base, etc.) |
| `search`  | `/`                    | Full-text search across tasks, notes, programs, captures, results (`GET /api/search`) |
| `capture` | `c`                    | Quick capture — `t <text>` for task, plain text for note. Also accepts a template prefix from `shared/capture-templates.ts` |
| `add-url` | command palette → `add-url` | Save a URL to Reader (`POST /api/reader`)         |
| `shell`   | `:`                    | Run a CLI command via `POST /api/cli/run`             |

## Lifecycle

1. `Workspace.tsx` opens the Minibuffer with `initialMode` + optional
   `initialShellCmd` / `initialCaptureContext` / `initialTemplate`.
2. The Minibuffer fetches a flat command list once on mount
   (built-in `COMMANDS` array) and adds remote items where useful (template
   list, view list, theme list).
3. Typing filters with a fuzzy substring match.
4. Enter dispatches:
   - **command**: calls a registered handler (most call `onSwitchView`,
     `onCycleTheme`, `onNavigate`, or send a fetch).
   - **search**: triggers `GET /api/search?q=…` and shows the result list
     (Enter on a row navigates into the right view).
   - **capture**: posts to `POST /api/captures/smart`.
   - **add-url**: posts to `POST /api/reader`.
   - **shell**: posts to `POST /api/cli/run`, streams the output back into
     the bar, and sends a `NotificationToast`.

## Capture context from the Chrome extension

When the minibuffer is opened from the extension popup it asks the extension
for the current page's `{url, title, selection}` (Workspace.tsx:113) and
pre-fills the input with a sensible default (selection > title > url).

## TV mode

The minibuffer scales itself when `<html>` has the `.tv-mode` class so it
remains usable from a couch with a Bluetooth keyboard.
