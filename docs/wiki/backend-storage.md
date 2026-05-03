# Storage layer

Source: [`server/storage.ts`](../../server/storage.ts) (~1152 lines)

## IStorage interface

`server/storage.ts` exports a single `storage` object that implements every
data access method used by `server/routes.ts`, `server/cli-engine.ts`,
`server/agent-runtime.ts`, `server/evolution-engine.ts`, etc.

Method groups (per Drizzle table — see [data model](./data-model.md)):

- **programs**: `getPrograms`, `getProgram`, `createProgram`, `updateProgram`,
  `deleteProgram`, `toggleProgramEnabled`, `markProgramRun`,
  `getProgramsForTick`.
- **skills**: `getSkills`, `getSkill`, `createSkill`, `updateSkill`,
  `deleteSkill`.
- **agent_config**: `getAgentConfigs`, `getAgentConfig`, `setAgentConfig`,
  `deleteAgentConfig`.
- **tasks**: `getTasks`, `getTasksByDate`, `getOverdueTasks`,
  `getUpcomingTasks`, `getTask`, `createTask`, `updateTask`, `deleteTask`.
- **notes**: `getNotes`, `getNote`, `createNote`, `updateNote`, `deleteNote`.
- **captures**: `getCaptures`, `getCapture`, `createCapture`,
  `markCaptureProcessed`, `deleteCapture`.
- **agent_results**: `getAgentResults`, `getLatestResults`,
  `createAgentResult`, `getAgentResult`.
- **reader_pages**: `getReaderPages`, `getReaderPage`, `createReaderPage`,
  `deleteReaderPage`.
- **openclaw_proposals**: list/get/create/resolve/reject.
- **site_profiles** + **navigation_paths**: standard CRUD; navigation_paths
  cascade-delete with the parent profile.
- **recipes**: CRUD, plus `incrementRunCount`, `setLastOutput`.
- **audit_log**: `appendAudit`, `getAuditLog`.
- **transcripts**, **action_permissions**, **radar_seen_items**,
  **radar_engagement**, **agent_memories**, **evolution_versions**,
  **golden_suite**, **evolution_observations**, **judge_cost_tracking**,
  **galaxy_kb**, **outlook_emails**, **snow_tickets**, **meal_plans**,
  **shopping_lists**, **pantry_items**, **kiddo_food_log**,
  **nightly_recommendations** — full CRUD as needed by their callers.

## Cross-cutting helpers

- `searchAll(q: string)` — runs `ilike '%q%'` against tasks, notes, programs,
  captures, results, reader pages, recipes, galaxy_kb in parallel.
  ⚠ See [audit § Performance](./audit.md#performance).
- `setAgentConfig` triggers `loadRosterFromConfig` when the key is
  `model_roster_overrides` (called from the route, not here).

## Database connection

[`server/db.ts`](../../server/db.ts) (13 lines):

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
```

A single shared pool. There is **no transaction usage** anywhere in
`storage.ts` — operations that should be atomic (e.g. toggle-task-and-create-
next-occurrence) run as separate statements. See [audit § Data
integrity](./audit.md#data-integrity).

## SQLite usage (orthogonal)

`better-sqlite3` is in `package.json` and used only by the local OCR KB code
in `server/routes.ts` (~line 967). Postgres is the system-of-record for
everything else. See [audit § Dependency hygiene](./audit.md#dependency-hygiene).
