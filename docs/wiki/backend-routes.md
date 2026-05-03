# REST API routes

Source: [`server/routes.ts`](../../server/routes.ts) (~3815 lines)

All routes live in this single file. Auth is enforced globally at the
middleware level (see [server bootstrap](./backend-server.md)) — the table
below highlights routes that bypass it.

## Authoring conventions

- Most write routes validate `req.body` with a Zod schema from
  [`shared/schema.ts`](../../shared/schema.ts) (e.g. `insertProgramSchema`).
- Routes that don't validate (especially under `/api/epic/*` and
  `/api/sessions/*`) read fields off `req.body` directly — see [audit §
  Security #3](./audit.md#3-many-routes-skip-zod-validation).
- Errors propagate to the global error middleware in `server/index.ts:119`.

## Route groups

### Programs and skills
- `GET    /api/programs`
- `GET    /api/programs/:id`
- `POST   /api/programs`
- `PATCH  /api/programs/:id`
- `DELETE /api/programs/:id`
- `POST   /api/programs/:id/toggle`
- `POST   /api/programs/:id/trigger` — `agent-runtime.manualTrigger`
- `GET/POST/PATCH/DELETE /api/skills(/:id)`

### Tasks and agenda
- `GET    /api/tasks` (optional `?status=`)
- `GET    /api/tasks/agenda` — `{overdue, today, upcoming, briefings}`
- `GET    /api/tasks/:id`
- `POST   /api/tasks`
- `PATCH  /api/tasks/:id`
- `POST   /api/tasks/:id/toggle` (handles `repeat` rollover)
- `DELETE /api/tasks/:id`

### Notes
- `GET/POST/PATCH/DELETE /api/notes(/:id)`

### Captures
- `GET  /api/captures` (optional `?processed=`)
- `POST /api/captures` — raw insert
- `POST /api/captures/smart` — parse text via `capture-parser.ts`, create task or note
- `POST /api/captures/enrich` — detect URL + fetch metadata via `content-detector.ts`
- `POST /api/captures/:id/process`
- `POST /api/captures/:id/refile` — convert to task/note
- `DELETE /api/captures/:id`
- `GET  /api/capture-templates`
- `POST /api/uploads/image` (multer, 10 MB cap) → `GET /api/uploads/:filename`

### Backlinks / search
- `GET /api/backlinks/:type/:id` — finds `[[id:type]]` references
- `GET /api/search?q=…` — global ilike across tasks/notes/programs/captures/etc.

### Agent results & briefings
- `GET /api/results` (optional `?program=`, `?limit=`)
- `GET /api/results/latest`
- `GET /api/results/:id`
- `GET /briefings/` — directory listing
- `GET /briefings/:filename` — serves HTML or MP3 from `.briefings/`

### Reader
- `GET/POST/DELETE /api/reader(/:id)` — saved/scraped pages

### Site profiles & navigation paths
- `GET/POST/PATCH/DELETE /api/site-profiles(/:id)`
- `GET/POST/PATCH/DELETE /api/navigation-paths(/:id)`
- `POST /api/scraper/execute` — by `pathId` or raw `url`
- `POST /api/scraper/match` — find profile for URL

### Recipes (CLI command chains)
- `GET/POST/PATCH/DELETE /api/recipes(/:id)`
- `POST /api/recipes/:id/trigger`

### Openclaw proposals
- `GET    /api/proposals`
- `POST   /api/proposals/:id/approve`
- `POST   /api/proposals/:id/reject`

### Agent runtime
- `GET  /api/runtime` — `{active, lastTick, queue}`
- `POST /api/runtime/toggle`
- `GET  /api/budget` — `BudgetStatus`
- `GET  /api/models` — roster + quality

### Evolution
- `GET  /api/evolution/state` / `/versions` / `/observations` / `/judges/cost`
- `POST /api/evolution/observe` / `/consolidate` / `/rollback/:version`
- `POST /api/memory/migrate-to-qdrant`
- `GET  /api/memory/search?q=…&limit=N&program=…` — hybrid Qdrant+PG

### CLI
- `POST /api/cli/run` — `{command}` → executes via `cli-engine.executeChain`
- `GET  /api/cli/help`
- `GET  /api/cli/commands`

### Cockpit / control bus
- `GET  /api/cockpit/events` — Server-Sent Events (no auth, see audit)
- `GET  /api/control` — `{mode, paused}`
- `POST /api/control/toggle`
- `GET  /api/audit`
- `GET  /api/permissions` / `POST /api/permissions/:navPathId/:actionName`
- `GET  /api/takeover-points` / `POST /api/takeover-points/:id/resolve`

### Bridge (Chrome extension protocol)

These routes **bypass the global auth gate** and instead use the
`X-Bridge-Token` header (or `?token=` param) validated in
[`server/bridge-queue.ts`](../../server/bridge-queue.ts).

- `GET  /api/bridge/status` — combined Playwright + extension health
- `POST /api/bridge/launch`, `POST /api/bridge/close`
- `POST /api/bridge/login` — interactive login session
- `GET  /api/bridge/ext/health` — public, no auth
- `GET  /api/bridge/ext/token` — auth-gated (returns the token)
- `GET  /api/bridge/ext/jobs` — extension polls
- `POST /api/bridge/ext/results` — extension posts result
- `POST /api/bridge/ext/submit` — server-side enqueue
- `GET  /api/bridge/ext/queue`

### Outlook / Teams / Snow
- `GET /api/mail/inbox` — bridge-cached
- `GET /api/mail/:index`
- `GET /api/mail/calendar`
- `GET /api/chat/list`
- `GET /api/snow/records`
- `POST /api/snow/refresh`
- `GET /api/snow/queue`
- `GET /api/outlook-emails`, `GET /api/snow-tickets` — persisted DB rows
- `GET /api/boot/status`

### Galaxy KB
- `GET  /api/galaxy-kb` (list, optional `?category=`)
- `GET  /api/galaxy-kb/:id`
- `PATCH /api/galaxy-kb/:id`
- `DELETE /api/galaxy-kb/:id`
- `POST /api/galaxy-kb/:id/verify`
- `POST /api/galaxy-kb/:id/flag`

### Epic Hyperspace (desktop agent)

These routes **bypass the global auth gate** to allow the desktop agent to
poll. They check the bridge token internally where required.

- `POST /api/epic/agent/heartbeat`
- `POST /api/epic/agent/results`
- `POST /api/epic/agent/send`
- `GET  /api/epic/agent/commands`
- `GET  /api/epic/agent/status`
- `GET  /api/epic/agent/screenshot/:id` — base64 PNG
- `GET  /api/epic/agent-script` — downloads the python agent
- `POST /api/epic/uia-tree`
- `POST /api/epic/record/start` / `/stop`
- `GET  /api/epic/activities/:env` / `POST /api/epic/activities`
- `GET  /api/epic/tree` (heartbeat-piggyback nav-tree stream)
- `POST /api/epic/grammar` — only allowed from localhost

### Sessions (Instant Replay)
- `GET  /api/sessions` / `POST /api/sessions/stream`
- `GET  /api/sessions/pathfind` (`?from=&to=&windowKey=` or `&target=`)
- `POST /api/sessions/replay`
- `GET  /api/sessions/recipes`

### Voice & transcripts
- `POST /api/voice-cmd` (Bearer auth) — Google Home / IFTTT
- `POST /api/memo` (Bearer auth)
- `POST /api/transcripts/record/start` / `:sessionId/chunk` / `:sessionId/stop`
- `POST /api/transcripts/upload` — multer audio upload
- `GET  /api/transcripts` / `GET /api/transcripts/:id`

### Secrets
- `POST /api/secrets/request` (auth) — generate magic-link
- `GET  /api/secrets/form/:id` (public) — render the form
- `POST /api/secrets/submit` (public) — store secrets
- `GET  /api/secrets/:name` (auth) — retrieve

### Devices, recipes, inspector, iOS (planned)

The following routes are **planned, not yet present** — they land with
the CU stack tasks (task #96 (trajectory memory & skills),
task #97 (analyst inspector)), the LilyGo keyboard
(task #101 (LilyGo keyboard)), and the iOS adapter
(task #102 (iOS adapter)).

- `GET    /api/devices` — list paired devices.
- `POST   /api/devices/pair` — start pairing (returns 6-digit code) or
  claim a code from the device.
- `POST   /api/devices/:id/arm` — flip the `armed` flag (audit-logged).
- `DELETE /api/devices/:id` — unpair.
- `WSS    /ws/keyboard` — LilyGo T-Keyboard transport (auth via
  paired-device token in the upgrade `Authorization: Bearer` header).
  See [integrations-lilygo-keyboard](./integrations-lilygo-keyboard.md).
- `WSS    /ws/wda` — WebDriverAgent bridge transport for the iOS WDA
  adapter (`tools/ios_wda_bridge.py` connects from the user's Mac).
- `POST   /api/ios/cmd` — server-side enqueue of an iOS action.
- `POST   /api/ios/result` — Apple Shortcuts adapter posts results
  back.
- `GET    /api/recipes` *(CU — distinct from today's CLI-chain
  `/api/recipes`; see [data-model § disambiguation](./data-model.md#disambiguation-note)
  — the existing route will be renamed `/api/cli-recipes` or the new
  one namespaced `/api/cu-recipes`)*.
- `POST   /api/recipes/:id/replay` — replay a CU recipe.
- `GET    /api/recipes/proposals` — pending analyst-promotion queue.
- `POST   /api/recipes/proposals/:id/approve|reject` — analyst
  decision; on approve a `recipes` row is committed.
- `GET    /api/inspector/trajectories` — list recent trajectories.
- `GET    /api/inspector/trajectories/:id` — full step timeline +
  per-step `RouterTrace`.
- `POST   /api/inspector/trajectories/:id/take-over` — pause and
  create a takeover point at the current step.
- `POST   /api/inspector/trajectories/:id/branch` — edit-and-resume.
- `POST   /api/inspector/unlock` — owner-only, audited unlock of raw
  (un-redacted) observations for one trajectory; expiry required. See
  [safety](./safety.md).

### Misc
- `GET  /api/tree` — giant consolidated state for the Tree view
- `GET  /api/notifications` — in-process notifications (max 100)
- `POST /api/notifications/:id/read`
- `POST /api/openrouter/test` — sanity-check OpenRouter key

For the file-by-file structure of supporting modules see the next pages.
