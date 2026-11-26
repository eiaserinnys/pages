// R2-shaped object store in one SQLite table next to the D1 tables: get (with range), put (keeps httpMetadata.contentType), delete (key or array).
export function createSqliteBucket(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS node_bucket_objects (
      key TEXT PRIMARY KEY,
      body BLOB NOT NULL,
      content_type TEXT,
      size INTEGER NOT NULL,
      uploaded_at TEXT NOT NULL
    )
  `);
  const selectWhole = database.prepare('SELECT content_type, size, body FROM node_bucket_objects WHERE key = ?');
  const selectPart = database.prepare('SELECT content_type, size, substr(body, ?, ?) AS body FROM node_bucket_objects WHERE key = ?');
  const selectSuffix = database.prepare('SELECT content_type, size, substr(body, max(size - ?, 0) + 1) AS body FROM node_bucket_objects WHERE key = ?');
  const upsert = database.prepare(`
    INSERT INTO node_bucket_objects (key, body, content_type, size, uploaded_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET body = excluded.body, content_type = excluded.content_type,
      size = excluded.size, uploaded_at = excluded.uploaded_at
  `);
  const remove = database.prepare('DELETE FROM node_bucket_objects WHERE key = ?');

  function read(key, range) {
    if (!range) return selectWhole.get(key);
    if (Number.isInteger(range.suffix)) return selectSuffix.get(range.suffix, key);
    const offset = range.offset ?? 0;
    return selectPart.get(offset + 1, range.length ?? -1, key);
  }

  function putSync(key, value, options) {
    const bytes = typeof value === 'string'
      ? Buffer.from(value, 'utf8')
      : value instanceof ArrayBuffer
        ? Buffer.from(value)
        : ArrayBuffer.isView(value)
          ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          : null;
    if (!bytes) throw new Error('object value must be a string, ArrayBuffer, or typed array');
    upsert.run(key, bytes, options?.httpMetadata?.contentType ?? null, bytes.byteLength, new Date().toISOString());
  }

  return {
    async get(key, options) {
      const row = read(key, options?.range);
      if (!row) return null;
      const bytes = new Uint8Array(row.body.buffer, row.body.byteOffset, row.body.byteLength);
      return {
        key,
        body: new ReadableStream({
          start(controller) {
            if (bytes.byteLength) controller.enqueue(bytes);
            controller.close();
          },
        }),
        size: row.size,
        httpMetadata: { contentType: row.content_type ?? undefined },
        ...(options?.range ? { range: options.range } : {}),
        async text() { return new TextDecoder().decode(bytes); },
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
      };
    },

    async put(key, value, options) {
      putSync(key, value, options);
    },

    // Synchronous put for test seeding.
    putSync,

    async delete(keys) {
      database.transaction(() => {
        for (const key of Array.isArray(keys) ? keys : [keys]) remove.run(key);
      })();
    },
  };
}
