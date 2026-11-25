CREATE TABLE IF NOT EXISTS document_state (
  doc_id TEXT PRIMARY KEY,
  salt TEXT NOT NULL,
  iter INTEGER NOT NULL,
  verifier TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  blob TEXT,
  updated_at TEXT,
  FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
);
