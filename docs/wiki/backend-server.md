# Server bootstrap

Source: [`server/index.ts`](../../server/index.ts)

## Boot sequence

1. Create `express()` app and a node `http.Server`.
2. Mount middleware (in order):
   - `cors({ origin: true, credentials: true })` — reflects `Origin` ⚠ see [audit](./audit.md#security)
   - `express.json` (with `req.rawBody` capture)
   - `express.urlencoded`
   - `rateLimitMiddleware` from [`server/rate-limit.ts`](../../server/rate-limit.ts)
3. Register two early public routes:
   - `GET /launch` — opens Rachael in a small popup window (used by the
     extension shortcut).
   - `GET /api/auth/check` — tells the SPA whether `OPENCLAW_API_KEY` is set.
4. Mount the **auth gate** middleware (`server/index.ts:57`):
   - Bypassed paths: `/api/auth/check`, `/api/cockpit/events`,
     `/api/bridge/*`, `/api/epic/agent/*`, `/api/epic/record/*`,
     `/api/epic/activities`, `/api/epic/tree`,
     `/api/epic/grammar` (only from localhost), `/api/secrets/form/*`,
     `/api/secrets/submit`.
   - When `OPENCLAW_API_KEY` is **not** configured, `POST/PUT/PATCH/DELETE`
     are refused with 401 and `GET` is allowed unauthenticated.
   - When configured, every non-bypassed request needs `Authorization: Bearer
     <OPENCLAW_API_KEY>`.
5. Request logger middleware (`server/index.ts:86`) — prints `METHOD path
   status in <ms>` and (for non-sensitive routes) the JSON response body.
   Sensitive prefixes whose body is suppressed:
   `/api/mail/`, `/api/chat/`, `/api/secrets`, `/api/outlook-emails`,
   `/api/snow-tickets`, `/api/boot/`, `/api/bridge/`.
6. Async IIFE:
   - `await import("./agent-runtime")` and call `initRuntime()`.
   - `await registerRoutes(httpServer, app)` (registers everything in
     `server/routes.ts` and seeds the database via `seed-data.ts`).
   - Add the global error handler (`server/index.ts:119`).
   - In dev: `setupVite()` (HMR). In prod: `serveStatic()` from
     [`server/static.ts`](../../server/static.ts).
   - `httpServer.listen(PORT, "0.0.0.0", { reusePort: true })`.

## Sub-systems initialized at boot

- `agent-runtime.ts` `initRuntime()` — starts the tick loop and recipe scheduler.
- `model-router.ts` `loadRosterFromConfig(storage)` — pulls live model list
  and overrides from `agent_config`.
- `routes.ts` calls `seedDatabase()` from `server/seed-data.ts` (idempotent).
- `bridge-queue.ts` — lazy; the queue itself has no boot step.

## Notable behaviour

- **CORS is permissive** by design (the same UI is sometimes loaded via
  Replit's `*.replit.app` domain or the user's DO droplet). The audit calls
  out the credentialed-everywhere implication.
- **Auth check is path-prefix based**, which can produce false positives if a
  future route accidentally starts with one of the bypass prefixes. See
  [audit § Security #1](./audit.md#1-auth-bypass-list-uses-prefix-matching).
- `reusePort: true` on `listen` lets the dev server be restarted without
  socket churn but means a stale process can keep serving — restart the
  workflow after a deploy.
