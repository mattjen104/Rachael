# Integrations — ServiceNow

CLI: `snow` (in [`server/cli-engine.ts`](../../server/cli-engine.ts))

Subcommands:

- `snow` — incidents dashboard.
- `snow incidents | changes | requests` — by record type.
- `snow detail <number>` — full ticket body (cached in `snow_tickets.detailCached`).
- `snow queue` — workload + SLA-risk analysis.
- `snow persisted | search` — over the local DB cache.
- `snow refresh` — force re-scrape via bridge.

API:

- `GET /api/snow/records` — list with filters.
- `POST /api/snow/refresh` — trigger sync.
- `GET /api/snow/queue` — workload report.
- `GET /api/snow-tickets` — persisted DB rows.

Persistence:

- Table `snow_tickets` (`number` unique).
- Upsert sync from bridge results.
- `agent_config.snow_last_sync` cursor.
- `slaBreached` boolean computed at sync time.

View: [`SnowView.tsx`](../../client/src/components/views/SnowView.tsx).
