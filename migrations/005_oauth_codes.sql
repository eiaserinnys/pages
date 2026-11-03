CREATE TABLE IF NOT EXISTS oauth_used_codes (
  jti TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
