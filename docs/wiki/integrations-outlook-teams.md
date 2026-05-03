# Integrations — Outlook & Teams

Sources:
- [`server/app-adapters.ts`](../../server/app-adapters.ts) (~883 lines) — legacy Playwright path
- `server/cli-engine.ts` — `outlook` and `teams` commands (use `smartFetch`)

## Bridge requirement

Both `outlook.live.com`/`*.office.com` and `teams.microsoft.com` are
**bridge-only** domains. The agent never hits these directly; everything
goes through the user's authenticated Chrome session via the
[bridge](./bridge.md).

## Outlook

CLI:

- `outlook` — list inbox.
- `outlook calendar` — today's events.
- `outlook read <n>` — body of message n.
- `outlook search <query>` — historical search across persisted emails.
- `outlook sync` — incremental scrape, upserts into `outlook_emails`.

API:

- `GET /api/mail/inbox` — bridge-cached.
- `GET /api/mail/:index`, `GET /api/mail/calendar`.
- `GET /api/outlook-emails` — persisted DB rows.

Persistence:

- Table `outlook_emails` (`messageId` unique).
- `agent_config.outlook_last_sync` tracks the last incremental cursor.
- `boot` chains `epic login` → `outlook sync` → `snow sync` → `citrix keepalive`.

## Teams

CLI: `teams` (chats / channels).

API: `GET /api/chat/list`.

Caching:

- Cached in memory (`getMailCache`, `getCalendarCache`, `getTeamsCache` from
  `cli-engine.ts`).
- API routes serve cached data to the Tree view.

## Legacy Playwright adapters

`server/app-adapters.ts` retains Playwright scrapers for fallback when the
extension isn't connected. Functions: `openOutlook`, `openTeams`,
`getOutlookEmails`, `readOutlookEmail`, `getTeamsChats`, `readTeamsChat`.
