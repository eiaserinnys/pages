import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

// R2-shaped object store on the file system: get (with range), put (keeps httpMetadata.contentType), delete (key or array).
export function createFileBucket(rootDir) {
  const objectsDir = resolve(rootDir, 'objects');
  const metaDir = resolve(rootDir, 'meta');

  function locate(key) {
    if (typeof key !== 'string' || !key) throw new Error('object key must be a non-empty string');
    const file = resolve(objectsDir, key);
    if (!file.startsWith(objectsDir + sep)) throw new Error(`object key leaves the data folder: ${key}`);
    return { file, metaFile: resolve(metaDir, `${key}.json`) };
  }

  function encode(key, value, options) {
    const { file, metaFile } = locate(key);
    const bytes = typeof value === 'string'
      ? Buffer.from(value, 'utf8')
      : value instanceof ArrayBuffer
        ? Buffer.from(value)
        : ArrayBuffer.isView(value)
          ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          : null;
    if (!bytes) throw new Error('object value must be a string, ArrayBuffer, or typed array');
    const contentType = options?.httpMetadata?.contentType;
    return { file, metaFile, bytes, metaJson: contentType ? JSON.stringify({ contentType }) : null };
  }

  return {
    async get(key, options) {
      const { file, metaFile } = locate(key);
      let data;
      try {
        data = await readFile(file);
      } catch (error) {
        if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) return null;
        throw error;
      }
      const contentType = await readFile(metaFile, 'utf8').then((text) => JSON.parse(text).contentType, () => undefined);
      const range = options?.range;
      const part = range ? data.subarray(range.offset, range.offset + range.length) : data;
      const bytes = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
      return {
        key,
        body: bytes,
        size: data.byteLength,
        httpMetadata: { contentType },
        async text() { return new TextDecoder().decode(bytes); },
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
      };
    },

    async put(key, value, options) {
      const { file, metaFile, bytes, metaJson } = encode(key, value, options);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes);
      if (metaJson) {
        await mkdir(dirname(metaFile), { recursive: true });
        await writeFile(metaFile, metaJson);
      } else {
        await rm(metaFile, { force: true });
      }
    },

    // Synchronous put for test seeding.
    putSync(key, value, options) {
      const { file, metaFile, bytes, metaJson } = encode(key, value, options);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      if (metaJson) {
        mkdirSync(dirname(metaFile), { recursive: true });
        writeFileSync(metaFile, metaJson);
      }
    },

    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        const { file, metaFile } = locate(key);
        await rm(file, { force: true });
        await rm(metaFile, { force: true });
      }
    },
  };
}
