CREATE TABLE IF NOT EXISTS webhook_secrets (
  rev_id TEXT PRIMARY KEY,
  secret TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
