import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

const tables = [
  `CREATE TABLE IF NOT EXISTS programs (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL DEFAULT 'monitor',
    schedule TEXT,
    cron_expression TEXT,
    code TEXT,
    code_lang TEXT DEFAULT 'typescript',
    instructions TEXT NOT NULL DEFAULT '',
    config JSONB DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT true,
    cost_tier TEXT NOT NULL DEFAULT 'free',
    tags TEXT[] NOT NULL DEFAULT '{}',
    last_run TIMESTAMP,
    next_run TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS skills (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'skill',
    script_path TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS agent_config (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'general'
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'TODO',
    body TEXT NOT NULL DEFAULT '',
    scheduled_date TEXT,
    deadline_date TEXT,
    priority TEXT,
    tags TEXT[] NOT NULL DEFAULT '{}',
    parent_id INTEGER,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS notes (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    tags TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS captures (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    source TEXT,
    processed BOOLEAN NOT NULL DEFAULT false,
    detected_type TEXT,
    url_title TEXT,
    url_description TEXT,
    url_image TEXT,
    url_domain TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS agent_results (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    program_id INTEGER,
    program_name TEXT NOT NULL,
    summary TEXT NOT NULL,
    metric TEXT,
    model TEXT,
    tokens_used INTEGER,
    iteration INTEGER,
    raw_output TEXT,
    status TEXT NOT NULL DEFAULT 'ok',
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS reader_pages (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    extracted_text TEXT NOT NULL DEFAULT '',
    domain TEXT,
    scraped_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS openclaw_proposals (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    section TEXT NOT NULL,
    target_name TEXT,
    reason TEXT NOT NULL,
    current_content TEXT NOT NULL,
    proposed_content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    source TEXT NOT NULL DEFAULT 'agent',
    warnings TEXT,
    proposal_type TEXT NOT NULL DEFAULT 'change',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS site_profiles (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    base_url TEXT NOT NULL DEFAULT '',
    url_patterns TEXT[] NOT NULL DEFAULT '{}',
    extraction_selectors JSONB DEFAULT '{}',
    actions JSONB DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS navigation_paths (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    site_profile_id INTEGER NOT NULL REFERENCES site_profiles(id) ON DELETE CASCADE,
    steps JSONB NOT NULL DEFAULT '[]',
    extraction_rules JSONB DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    command TEXT NOT NULL,
    schedule TEXT,
    cron_expression TEXT,
    enabled BOOLEAN NOT NULL DEFAULT true,
    last_run TIMESTAMP,
    next_run TIMESTAMP,
    run_count INTEGER NOT NULL DEFAULT 0,
    last_output TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS org_files (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS clipboard_items (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    "timestamp" TIMESTAMP NOT NULL DEFAULT NOW(),
    archived BOOLEAN NOT NULL DEFAULT false,
    pinned BOOLEAN NOT NULL DEFAULT false,
    detected_type TEXT,
    url_title TEXT,
    url_description TEXT,
    url_image TEXT,
    url_domain TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS agent_memories (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    program_name TEXT,
    content TEXT NOT NULL,
    memory_type TEXT NOT NULL DEFAULT 'fact',
    tags TEXT[] NOT NULL DEFAULT '{}',
    relevance_score INTEGER NOT NULL DEFAULT 100,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed TIMESTAMP NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
];

const extraTables = [
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "timestamp" TIMESTAMP NOT NULL DEFAULT NOW(),
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    permission_level TEXT,
    result TEXT NOT NULL DEFAULT 'success',
    details TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS action_permissions (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nav_path_id INTEGER NOT NULL REFERENCES navigation_paths(id) ON DELETE CASCADE,
    action_name TEXT NOT NULL,
    permission_level TEXT NOT NULL DEFAULT 'autonomous'
  )`,
];

const alterations = [
  `ALTER TABLE site_profiles ADD COLUMN IF NOT EXISTS default_permission TEXT NOT NULL DEFAULT 'autonomous'`,
  `ALTER TABLE navigation_paths ADD COLUMN IF NOT EXISTS permission_level TEXT NOT NULL DEFAULT 'autonomous'`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS image_url TEXT`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repeat TEXT`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_id INTEGER`,
  `ALTER TABLE notes ADD COLUMN IF NOT EXISTS image_url TEXT`,
  `ALTER TABLE captures ADD COLUMN IF NOT EXISTS image_url TEXT`,
  `ALTER TABLE captures ADD COLUMN IF NOT EXISTS template TEXT`,
];

const indexes = [
  `CREATE INDEX IF NOT EXISTS idx_agent_memories_program ON agent_memories(program_name)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_memories_type ON agent_memories(memory_type)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_memories_relevance ON agent_memories(relevance_score DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_memories_last_accessed ON agent_memories(last_accessed DESC)`,
];

async function pushSchema() {
  for (const ddl of tables) {
    await db.execute(sql.raw(ddl));
  }
  for (const ddl of extraTables) {
    await db.execute(sql.raw(ddl));
  }
  for (const alt of alterations) {
    try { await db.execute(sql.raw(alt)); } catch {}
  }
  for (const idx of indexes) {
    try { await db.execute(sql.raw(idx)); } catch {}
  }
  console.log(`[push-schema] Ensured ${tables.length + extraTables.length} tables exist`);
  await pool.end();
}

pushSchema().catch((err) => {
  console.error("[push-schema] Error:", err.message);
  process.exit(1);
});
