'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const COMMENTS_MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '001_comments.sql');
const DOCUMENTS_MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '003_documents_revisions.sql');
const ASSETS_MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '004_revision_assets.sql');

const MAX_BUNDLE_FILES = 200;
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
const MAX_PATH_LENGTH = 512;
const MAX_PATH_SEGMENT_LENGTH = 128;
const INDEX_ENTRYPOINT = 'index.html';
const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.pdf', 'application/pdf'],
  ['.wasm', 'application/wasm'],
  ['.xml', 'application/xml; charset=utf-8'],
]);

function createBundleStore({ dbPath, pagesDir }) {
  if (!dbPath) throw new Error('dbPath is required');
  if (!pagesDir) throw new Error('pagesDir is required');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(bundleRoot(pagesDir), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(COMMENTS_MIGRATION_PATH, 'utf8'));
  db.exec(fs.readFileSync(DOCUMENTS_MIGRATION_PATH, 'utf8'));
  db.exec(fs.readFileSync(ASSETS_MIGRATION_PATH, 'utf8'));

  const deleteAssets = db.prepare('DELETE FROM revision_assets WHERE rev_id = ?');
  const deleteBundle = db.prepare('DELETE FROM revision_bundles WHERE rev_id = ?');
  const insertBundle = db.prepare(`
    INSERT INTO revision_bundles (rev_id, entrypoint, file_count, total_size_bytes, created_at)
    VALUES (@rev_id, @entrypoint, @file_count, @total_size_bytes, @created_at)
  `);
  const insertAsset = db.prepare(`
    INSERT INTO revision_assets (rev_id, path, bytes_key, content_type, size_bytes, created_at)
    VALUES (@rev_id, @path, @bytes_key, @content_type, @size_bytes, @created_at)
  `);
  const selectBundle = db.prepare(`
    SELECT rev_id, entrypoint, file_count, total_size_bytes, created_at
    FROM revision_bundles
    WHERE rev_id = ?
  `);
  const selectAsset = db.prepare(`
    SELECT rev_id, path, bytes_key, content_type, size_bytes, created_at
    FROM revision_assets
    WHERE rev_id = ? AND path = ?
  `);
  const selectAssets = db.prepare(`
    SELECT rev_id, path, bytes_key, content_type, size_bytes, created_at
    FROM revision_assets
    WHERE rev_id = ?
    ORDER BY path ASC
  `);

  const replaceManifest = db.transaction((manifest) => {
    deleteAssets.run(manifest.revId);
    deleteBundle.run(manifest.revId);
    insertBundle.run({
      rev_id: manifest.revId,
      entrypoint: manifest.entrypoint,
      file_count: manifest.files.length,
      total_size_bytes: manifest.totalSizeBytes,
      created_at: manifest.createdAt,
    });
    for (const file of manifest.files) {
      insertAsset.run({
        rev_id: manifest.revId,
        path: file.path,
        bytes_key: file.bytesKey,
        content_type: file.contentType,
        size_bytes: file.sizeBytes,
        created_at: manifest.createdAt,
      });
    }
  });

  return {
    close() {
      db.close();
    },
    replaceBundle({ revId, docId, entrypoint, files, createdAt }) {
      const manifest = buildManifest({ revId, docId, entrypoint, files, createdAt });
      const targetRoot = bundleDirectory(pagesDir, docId, revId);
      fs.rmSync(targetRoot, { recursive: true, force: true });
      for (const file of manifest.files) {
        const filePath = path.join(bundleRoot(pagesDir), file.bytesKey);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, file.bytes);
      }
      replaceManifest(manifest);
      return formatBundle(manifest);
    },
    getBundle(revId) {
      const row = selectBundle.get(revId);
      if (!row) return null;
      return {
        revId: row.rev_id,
        entrypoint: row.entrypoint,
        fileCount: row.file_count,
        totalSizeBytes: row.total_size_bytes,
        createdAt: row.created_at,
        assets: selectAssets.all(revId).map(formatAssetRow),
      };
    },
    getAsset(revId, requestPath) {
      const bundle = selectBundle.get(revId);
      if (!bundle) return null;
      const assetPath = requestPath ? normalizeBundlePath(requestPath) : bundle.entrypoint;
      const row = selectAsset.get(revId, assetPath);
      return row ? formatAssetRow(row) : null;
    },
    resolveAssetFile(asset) {
      return path.join(bundleRoot(pagesDir), asset.bytesKey);
    },
  };
}

function normalizeUploadBundle({ html, files, entrypoint }, limits = {}) {
  if (files !== undefined && html !== undefined) {
    throw new BundleStoreError('provide either html or files, not both');
  }
  if (files !== undefined) {
    return normalizeFilesBundle({ files, entrypoint }, limits);
  }
  if (!html || typeof html !== 'string') {
    throw new BundleStoreError('html field is required');
  }
  return normalizeFilesBundle({
    entrypoint: INDEX_ENTRYPOINT,
    files: [
      {
        path: INDEX_ENTRYPOINT,
        content: Buffer.from(html, 'utf8').toString('base64'),
        encoding: 'base64',
        contentType: 'text/html; charset=utf-8',
      },
    ],
  }, limits);
}

function normalizeFilesBundle({ files, entrypoint }, limits = {}) {
  const maxFiles = limits.maxFiles || MAX_BUNDLE_FILES;
  const maxBytes = limits.maxBytes || MAX_BUNDLE_BYTES;
  if (!Array.isArray(files) || files.length === 0) {
    throw new BundleStoreError('files must be a non-empty array');
  }
  if (files.length > maxFiles) {
    throw new BundleStoreError(`bundle exceeds ${maxFiles} file limit`, 413);
  }
  const normalizedEntrypoint = normalizeBundlePath(entrypoint || INDEX_ENTRYPOINT);
  const seen = new Set();
  let totalSizeBytes = 0;
  const normalizedFiles = files.map((file, index) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new BundleStoreError(`files[${index}] must be an object`);
    }
    const assetPath = normalizeBundlePath(file.path);
    if (seen.has(assetPath)) {
      throw new BundleStoreError(`duplicate bundle path: ${assetPath}`);
    }
    seen.add(assetPath);
    const bytes = decodeFileContent(file, index);
    totalSizeBytes += bytes.length;
    if (totalSizeBytes > maxBytes) {
      throw new BundleStoreError(`bundle exceeds ${maxBytes} byte limit`, 413);
    }
    return {
      path: assetPath,
      bytes,
      contentType: normalizeContentType(file.contentType, assetPath),
      sizeBytes: bytes.length,
    };
  });
  if (!seen.has(normalizedEntrypoint)) {
    throw new BundleStoreError(`entrypoint not found in bundle: ${normalizedEntrypoint}`);
  }
  return {
    entrypoint: normalizedEntrypoint,
    files: normalizedFiles,
    totalSizeBytes,
  };
}

function withPatchedEntrypoint(bundle, patcher) {
  const files = bundle.files.map((file) => {
    if (file.path !== bundle.entrypoint) return file;
    const patched = patcher(file.bytes.toString('utf8'));
    const bytes = Buffer.from(patched, 'utf8');
    return {
      ...file,
      bytes,
      sizeBytes: bytes.length,
      contentType: normalizeContentType(file.contentType, file.path),
    };
  });
  const totalSizeBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
  if (totalSizeBytes > MAX_BUNDLE_BYTES) {
    throw new BundleStoreError(`bundle exceeds ${MAX_BUNDLE_BYTES} byte limit`, 413);
  }
  return { ...bundle, files, totalSizeBytes };
}

function normalizeBundlePath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BundleStoreError('bundle path must be a non-empty string');
  }
  if (value.length > MAX_PATH_LENGTH) {
    throw new BundleStoreError(`bundle path exceeds ${MAX_PATH_LENGTH} characters`);
  }
  if (value.includes('\0')) {
    throw new BundleStoreError('bundle path must not contain NULL bytes');
  }
  if (value.includes('\\')) {
    throw new BundleStoreError('bundle path must use forward slashes');
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new BundleStoreError('bundle path must be relative');
  }
  const segments = value.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new BundleStoreError('bundle path must not contain empty, . or .. segments');
    }
    if (segment.length > MAX_PATH_SEGMENT_LENGTH) {
      throw new BundleStoreError(`bundle path segment exceeds ${MAX_PATH_SEGMENT_LENGTH} characters`);
    }
    const baseName = segment.split('.')[0].toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(baseName)) {
      throw new BundleStoreError(`reserved bundle path segment: ${segment}`);
    }
  }
  return segments.join('/');
}

function decodeFileContent(file, index) {
  if (file.encoding && file.encoding !== 'base64') {
    throw new BundleStoreError(`files[${index}].encoding must be base64`);
  }
  if (typeof file.content !== 'string') {
    throw new BundleStoreError(`files[${index}].content must be a base64 string`);
  }
  const bytes = Buffer.from(file.content, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== file.content.replace(/\s/g, '').replace(/=+$/, '')) {
    throw new BundleStoreError(`files[${index}].content is not valid base64`);
  }
  return bytes;
}

function normalizeContentType(value, assetPath) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return inferContentType(assetPath);
}

function inferContentType(assetPath) {
  return CONTENT_TYPES.get(path.posix.extname(assetPath).toLowerCase()) || 'application/octet-stream';
}

function buildManifest({ revId, docId, entrypoint, files, createdAt }) {
  const safeDocId = safeKeySegment(docId, 'docId');
  const safeRevId = safeKeySegment(revId, 'revId');
  return {
    revId,
    docId,
    entrypoint,
    files: files.map((file) => ({
      ...file,
      bytesKey: `${safeDocId}/${safeRevId}/${file.path}`,
    })),
    totalSizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    createdAt: createdAt || new Date().toISOString(),
  };
}

function safeKeySegment(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new BundleStoreError(`${name} is not safe for bundle storage`);
  }
  return value;
}

function bundleRoot(pagesDir) {
  return path.join(pagesDir, 'bundles');
}

function bundleDirectory(pagesDir, docId, revId) {
  return path.join(bundleRoot(pagesDir), safeKeySegment(docId, 'docId'), safeKeySegment(revId, 'revId'));
}

function formatBundle(manifest) {
  return {
    revId: manifest.revId,
    entrypoint: manifest.entrypoint,
    fileCount: manifest.files.length,
    totalSizeBytes: manifest.totalSizeBytes,
    assets: manifest.files.map((file) => ({
      path: file.path,
      bytesKey: file.bytesKey,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
    })),
  };
}

function formatAssetRow(row) {
  return {
    revId: row.rev_id,
    path: row.path,
    bytesKey: row.bytes_key,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
}

class BundleStoreError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

module.exports = {
  BundleStoreError,
  MAX_BUNDLE_BYTES,
  MAX_BUNDLE_FILES,
  createBundleStore,
  inferContentType,
  normalizeBundlePath,
  normalizeUploadBundle,
  withPatchedEntrypoint,
};
