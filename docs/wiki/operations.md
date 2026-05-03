# Build, deploy, run

## Local development

```bash
npm install
npm run db:push       # push Drizzle schema to DATABASE_URL
npm run dev           # NODE_ENV=development tsx server/index.ts
```

`npm run dev` runs the Express server with `tsx` and **starts Vite from the
same process** (`server/vite.ts` is imported lazily in dev). The web UI is
served at `http://localhost:5000/`.

There is also `npm run dev:client` (`vite dev --port 5000`) which runs only
the front-end against a remote backend (set `VITE_API_BASE`).

## Production build

```bash
npm run build         # tsx script/build.ts
npm run start         # NODE_ENV=production node dist/index.cjs
```

`script/build.ts`:

1. `vite build` → `dist/public/`.
2. `esbuild` bundles `server/index.ts` → `dist/index.cjs` (CJS, minified).
3. Most deps are externals; a small `allowlist` is bundled into the server
   bundle to reduce cold-start syscalls.
4. Copies `server/seed-org-files.json` if present.

## DigitalOcean deploy

```bash
curl -sL https://raw.githubusercontent.com/mattjen104/Rachael/main/scripts/do-install.sh | bash
```

`scripts/do-install.sh` (10 steps): apt packages → Node 20 → Postgres →
Chromium → app user/clone → DB user+db → deps → env file → systemd unit →
TUI client. Caddy is configured for SSL when `RACHAEL_DOMAIN` is set.

`scripts/do-update.sh`:

```bash
sudo bash scripts/do-update.sh
```

…pulls latest, `npm ci`, `npm run build`, `db:push`, restart service.

## Replit (this workspace)

`.replit` runs `npm run dev` as the `Start application` workflow. The
deployment block is `autoscale` with `dist/public` as the static dir.

## Post-merge hook

`scripts/post-merge.sh` (8 lines) runs after every git merge. Currently
just prints a heads-up — no automatic `db:push` or `npm install`. If you
add new tables, run `npm run db:push` manually.

## DB migration discipline

- All schema changes go through `npm run db:push` (Drizzle Kit).
- **No migration files** are checked in — `drizzle.config.ts` writes to
  `./migrations` but the CI process does not run them. The audit calls this
  out as a risk for production safety.
- A `scripts/push-schema.ts` helper exists for headless DBs.

## Backups

There is **no backup script** in the repo. The DB is the system of record;
back it up via standard Postgres dumps from the DO droplet.
