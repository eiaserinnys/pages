CREATE TABLE IF NOT EXISTS documents (
  doc_id TEXT PRIMARY KEY,
  slug TEXT UNIQUE,
  title TEXT NOT NULL,
  owner TEXT NOT NULL,
  latest_revision TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
  rev_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  rev_number INTEGER NOT NULL CHECK (rev_number > 0),
  status TEXT NOT NULL CHECK (status IN ('published', 'archived')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE,
  UNIQUE (doc_id, rev_number)
);

CREATE INDEX IF NOT EXISTS idx_documents_slug
  ON documents (slug);

CREATE INDEX IF NOT EXISTS idx_revisions_doc_number
  ON revisions (doc_id, rev_number DESC);

CREATE TRIGGER IF NOT EXISTS comments_rev_fk_insert
BEFORE INSERT ON comments
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM revisions WHERE rev_id = NEW.rev_id)
BEGIN
  SELECT RAISE(ABORT, 'comments.rev_id must reference revisions.rev_id');
END;

CREATE TRIGGER IF NOT EXISTS comments_rev_fk_update
BEFORE UPDATE OF rev_id ON comments
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM revisions WHERE rev_id = NEW.rev_id)
BEGIN
  SELECT RAISE(ABORT, 'comments.rev_id must reference revisions.rev_id');
END;
