# Integrations — Chrome extension

Source: [`chrome-extension/`](../../chrome-extension/)

## Files

| File                  | Role                                                  |
|-----------------------|-------------------------------------------------------|
| `manifest.json`       | MV3 manifest (`<all_urls>`, alarms, tabs, offscreen)  |
| `background.js` (1359 lines) | Service worker — polls bridge queue, executes jobs |
| `offscreen.html` / `.js` | Offscreen document for `tabCapture` audio recording |
| `options.html` / `.js` / `.css` | Settings page (server URL + bridge token) |
| `icon48.png`          | Toolbar icon                                          |

## Permissions (manifest)

- `activeTab`, `tabs`, `tabCapture`, `offscreen`, `scripting`, `storage`,
  `alarms`, `downloads`, `downloads.open`, `notifications`.
- `host_permissions: ["<all_urls>"]` — broad. See
  [audit § Security #7](./audit.md#7-chrome-extension-host-permissions-are-all_urls).

## Keyboard shortcuts

| Combo  | Action                                          |
|--------|-------------------------------------------------|
| Alt+X  | Open Rachael command palette                    |
| Alt+C  | Open capture mode                               |
| Alt+S  | Open search mode                                |
| Alt+A  | Jump to agenda                                  |

## Polling

- Chrome `alarms` minimum interval: 30 s.
- Each tick: `GET /api/bridge/ext/jobs` → process serially with 1.5 s gap →
  `POST /api/bridge/ext/results`.
- Heartbeat headers: `X-Bridge-Token`, `X-Ext-Version`, `X-Jobs-Completed`,
  `X-Last-Error`.

## Job execution

- `fetch` — direct HTTP from extension context (cookies attached).
- `dom` — `chrome.tabs.create({active:false})` → wait for load → inject
  content script with selector queries → return extracted data → close tab.

## Capture flow

The extension's popup posts `{action: "capture", url, title, selection}` to
the open Rachael window via `window.postMessage`. The Workspace listener
calls `useSmartCapture()` (see [Workspace](./frontend.md)).

## Configuration

`options.html`:

- API base URL.
- Bridge token (paste once; stored in `chrome.storage.local`).
