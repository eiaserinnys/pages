'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '002_webhook_secrets.sql');

function createWebhookSecretStore({ dbPath }) {
  if (!dbPath) {
    throw new Error('dbPath is required');
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(fs.readFileSync(MIGRATION_PATH, 'utf8'));

  const upsertSecret = db.prepare(`
    INSERT INTO webhook_secrets (rev_id, secret, secret_hash, created_at, updated_at)
    VALUES (@rev_id, @secret, @secret_hash, @created_at, @updated_at)
    ON CONFLICT(rev_id) DO UPDATE SET
      secret = excluded.secret,
      secret_hash = excluded.secret_hash,
      updated_at = excluded.updated_at
  `);
  const deleteSecret = db.prepare('DELETE FROM webhook_secrets WHERE rev_id = ?');
  const selectSecret = db.prepare('SELECT secret FROM webhook_secrets WHERE rev_id = ?');

  return {
    close() {
      db.close();
    },
    save(revId, secret) {
      if (!secret) {
        deleteSecret.run(revId);
        return null;
      }
      const now = new Date().toISOString();
      const secretHash = hashWebhookSecret(secret);
      upsertSecret.run({
        rev_id: revId,
        secret,
        secret_hash: secretHash,
        created_at: now,
        updated_at: now,
      });
      return secretHash;
    },
    get(revId) {
      const row = selectSecret.get(revId);
      return row?.secret || '';
    },
  };
}

function hashWebhookSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

module.exports = {
  createWebhookSecretStore,
  hashWebhookSecret,
};
