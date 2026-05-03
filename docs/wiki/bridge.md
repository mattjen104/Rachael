# Browser bridge & bridge queue

Sources:
- [`server/bridge-queue.ts`](../../server/bridge-queue.ts) (~437 lines) — server-side queue + `smartFetch`
- [`server/browser-bridge.ts`](../../server/browser-bridge.ts) (~795 lines) — Playwright-based fallback
- [`chrome-extension/`](../../chrome-extension/) — MV3 extension that drains the queue

## Why a bridge

Rachael's agents need to scrape sites that the user is logged into (Outlook,
Teams, Reddit, Galaxy, Citrix, Epic) from the **user's real Chrome** — that
way scraping uses the correct session cookies and the user's IP, instead of
a cloud datacenter IP that gets fingerprinted and blocked.

## The two paths

```
              ┌──────────────────┐
agent code ──▶│  smartFetch(url) │
              └────────┬─────────┘
                       │ tries (1) bridge if extension is online
                       ▼
              ┌──────────────────┐         ┌─────────────────────┐
              │ bridge-queue.ts  │ ◀──poll │ Chrome extension    │
              │  (server queue)  │         │ (background.js)     │
              └────────┬─────────┘  result └─────────────────────┘
                       │ falls back if (a) extension absent and
                       │ (b) URL is NOT bridge-only
                       ▼
              ┌──────────────────┐
              │ direct fetch     │
              └──────────────────┘
```

## Bridge-only domains (force-extension)

Hard-coded in two places (kept in sync; see audit):

- `server/bridge-queue.ts` (server-side `smartFetch`).
- `server/agent-runtime.ts` (inline-code `bridgeFetch`/`smartFetch`).
- `server/cli-engine.ts` (`bridge --direct` guard).

Domains:

- `galaxy.epic.com`
- `*.ucsd.edu`
- `reddit.com` / `*.reddit.com`
- `*.live.com` / `outlook.live.com`
- `*.office.com` / `teams.microsoft.com`

These never fall back to direct fetch — the extension is the only path.

## Job types

- `fetch` — raw HTTP via the user's browser cookies.
- `dom` — opens a real Chrome tab, lets JS render, runs a content-script
  selector extraction, returns the result.

## Auth

- A bridge token (lazy UUID, persisted via `BRIDGE_TOKEN` env var).
- Extension stores token via `chrome-extension/options.html`.
- Sent in every poll/post as `X-Bridge-Token` header.
- Server validates via `validateBridgeToken` from `bridge-queue.ts`.

The bridge token is a **separate secret** from `OPENCLAW_API_KEY` and
purposely so — the extension doesn't have the API key.

## Heartbeat

- Extension polls `GET /api/bridge/ext/jobs` ~every 30 s
  (Chrome alarms minimum).
- Each poll sends `X-Ext-Version`, `X-Jobs-Completed`, `X-Last-Error` headers.
- Server tracks `extensionLastSeen` with a 90 s staleness window.

## Retry & serial execution

- Failed jobs auto-requeue up to `maxRetries` (default 2).
- Extension processes jobs sequentially with a 1.5 s delay between them
  (anti-bot heuristic).

## Routes (recap)

See [REST API routes § Bridge](./backend-routes.md#bridge-chrome-extension-protocol).

## Manifest

`chrome-extension/manifest.json`:

- MV3, `<all_urls>` host permissions ⚠ see [audit § Security #7](./audit.md#7-chrome-extension-host-permissions-are-all_urls).
- Permissions: `activeTab`, `tabs`, `tabCapture`, `offscreen`, `scripting`,
  `storage`, `alarms`, `downloads`, `downloads.open`, `notifications`.
- Keyboard commands: Alt+X (palette), Alt+C (capture), Alt+S (search),
  Alt+A (agenda).

## Playwright fallback

`server/browser-bridge.ts` runs Playwright Chromium for cases where the
extension can't help (server-side login flows, scrapers without the
extension installed). Driven by:

- `POST /api/bridge/launch`
- `POST /api/bridge/login` (interactive session)
- `POST /api/bridge/close`
