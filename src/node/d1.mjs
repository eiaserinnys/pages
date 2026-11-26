import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);
const executors = new WeakMap();

export function openDatabase(file) {
  const database = new Database(file);
  database.pragma('journal_mode = WAL');
  applyMigrations(database);
  return database;
}

function applyMigrations(database) {
  database.exec('CREATE TABLE IF NOT EXISTS pages_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(database.prepare('SELECT name FROM pages_migrations').pluck().all());
  const record = database.prepare('INSERT INTO pages_migrations (name, applied_at) VALUES (?, ?)');
  const names = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
  for (const name of names) {
    if (applied.has(name)) continue;
    const sql = readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8');
    database.transaction(() => {
      database.exec(sql);
      record.run(name, new Date().toISOString());
    })();
  }
}

export function createD1(database) {
  return {
    prepare(sql) {
      const prepared = database.prepare(sql);
      let values = [];
      const execute = () => (prepared.reader
        ? { success: true, results: prepared.all(...values), meta: {} }
        : { success: true, results: [], meta: toMeta(prepared.run(...values)) });
      const statement = {
        bind(...nextValues) { values = nextValues; return statement; },
        async first() { return prepared.get(...values) || null; },
        async all() { return { success: true, results: prepared.all(...values), meta: {} }; },
        async run() { return execute(); },
      };
      executors.set(statement, execute);
      return statement;
    },
    async batch(statements) {
      return database.transaction(() => statements.map((statement) => executors.get(statement)()))();
    },
  };
}

function toMeta(result) {
  return { changes: result.changes, last_row_id: Number(result.lastInsertRowid) };
}
