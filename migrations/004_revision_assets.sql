CREATE TABLE IF NOT EXISTS revision_bundles (
  rev_id TEXT PRIMARY KEY,
  entrypoint TEXT NOT NULL,
  file_count INTEGER NOT NULL CHECK (file_count > 0),
  total_size_bytes INTEGER NOT NULL CHECK (total_size_bytes >= 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (rev_id) REFERENCES revisions(rev_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS revision_assets (
  rev_id TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (rev_id, path),
  FOREIGN KEY (rev_id) REFERENCES revisions(rev_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_revision_assets_rev_path
  ON revision_assets (rev_id, path);
