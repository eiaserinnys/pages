CREATE TABLE IF NOT EXISTS comments (
  comment_id TEXT PRIMARY KEY,
  rev_id TEXT NOT NULL,
  anchor TEXT NOT NULL CHECK (json_valid(anchor)),
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_rev_created
  ON comments (rev_id, created_at, comment_id);
