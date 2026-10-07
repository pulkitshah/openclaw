export const WALLET_SCHEMA_VERSION = "schema-1";

// Column names follow the design spec §3. `id` is the append order: the running balance is
// `balance_after_paise` of the greatest id, never of the newest `at` (backfilled rows are dated in
// the past but appended later).
export const WALLET_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS wallet_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS wallet_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  balance_after_paise INTEGER NOT NULL,
  charge TEXT,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  rate_json TEXT,
  unpriced INTEGER,
  service TEXT,
  units REAL,
  unit TEXT,
  activity TEXT,
  ref TEXT,
  label TEXT NOT NULL,
  session_key TEXT,
  agent_id TEXT,
  run_id TEXT,
  source TEXT,
  reference TEXT,
  note TEXT,
  "by" TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_wallet_entries_at ON wallet_entries(at);
CREATE INDEX IF NOT EXISTS idx_wallet_entries_session_at ON wallet_entries(session_key, at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_entries_credit_reference
  ON wallet_entries(reference) WHERE kind = 'credit';
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_entries_hosting_ref
  ON wallet_entries(ref) WHERE activity = 'hosting';

CREATE TABLE IF NOT EXISTS wallet_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  credit_limit_paise INTEGER NOT NULL DEFAULT 0,
  low_balance_paise INTEGER NOT NULL DEFAULT 20000,
  enforce INTEGER NOT NULL DEFAULT 0,
  last_low_notice_at INTEGER,
  last_stop_notice_at INTEGER,
  stopped_since INTEGER,
  hosting_started_on TEXT,
  backfill_done_at INTEGER,
  meter_started_at INTEGER,
  backfill_result_json TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS wallet_backfill_marks (
  session_key TEXT NOT NULL,
  day TEXT NOT NULL,
  marked_at INTEGER NOT NULL,
  PRIMARY KEY (session_key, day)
) STRICT;
`;
