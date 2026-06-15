'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const COMMENTS_MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '001_comments.sql');
const DOCUMENTS_MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '003_documents_revisions.sql');

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const RESERVED_SLUGS = new Set([
  'api',
  'auth',
  'd',
  'dashboard',
  'login',
  'logout',
  'p',
  'static',
]);
const DEFAULT_OWNER = 'api';
const PUBLISHED_STATUS = 'published';

function createDocumentStore({ dbPath }) {
  if (!dbPath) {
    throw new Error('dbPath is required');
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(COMMENTS_MIGRATION_PATH, 'utf8'));
  db.exec(fs.readFileSync(DOCUMENTS_MIGRATION_PATH, 'utf8'));

  const selectBySlug = db.prepare(`
    SELECT doc_id, slug, title, owner, latest_revision, created_at, updated_at
    FROM documents
    WHERE slug = ?
  `);
  const selectById = db.prepare(`
    SELECT doc_id, slug, title, owner, latest_revision, created_at, updated_at
    FROM documents
    WHERE doc_id = ?
  `);
  const selectRevision = db.prepare(`
    SELECT rev_id, doc_id, rev_number, status, created_at
    FROM revisions
    WHERE rev_id = ?
  `);
  const selectRevisionDocument = db.prepare(`
    SELECT
      d.doc_id,
      d.slug,
      d.title,
      d.owner,
      d.latest_revision,
      d.created_at AS doc_created_at,
      d.updated_at,
      r.rev_id,
      r.rev_number,
      r.status,
      r.created_at AS rev_created_at
    FROM revisions r
    JOIN documents d ON d.doc_id = r.doc_id
    WHERE r.rev_id = ?
  `);
  const selectRevisionBySlugNumber = db.prepare(`
    SELECT r.rev_id, r.doc_id, r.rev_number, r.status, r.created_at
    FROM revisions r
    JOIN documents d ON d.doc_id = r.doc_id
    WHERE d.slug = ? AND r.rev_number = ?
  `);
  const selectRevisionsByDoc = db.prepare(`
    SELECT rev_id, doc_id, rev_number, status, created_at
    FROM revisions
    WHERE doc_id = ?
    ORDER BY rev_number DESC
  `);
  const selectMaxRevisionNumber = db.prepare(`
    SELECT COALESCE(MAX(rev_number), 0) AS max_rev_number
    FROM revisions
    WHERE doc_id = ?
  `);
  const selectLatestRevisionNumber = db.prepare(`
    SELECT r.rev_number
    FROM documents d
    JOIN revisions r ON r.rev_id = d.latest_revision
    WHERE d.doc_id = ?
  `);
  const insertDocument = db.prepare(`
    INSERT INTO documents (doc_id, slug, title, owner, latest_revision, created_at, updated_at)
    VALUES (@doc_id, @slug, @title, @owner, NULL, @created_at, @updated_at)
  `);
  const insertDocumentIgnore = db.prepare(`
    INSERT OR IGNORE INTO documents (doc_id, slug, title, owner, latest_revision, created_at, updated_at)
    VALUES (@doc_id, @slug, @title, @owner, NULL, @created_at, @updated_at)
  `);
  const updateDocument = db.prepare(`
    UPDATE documents
    SET title = @title,
        owner = @owner,
        updated_at = @updated_at
    WHERE doc_id = @doc_id
  `);
  const updateDocumentLatest = db.prepare(`
    UPDATE documents
    SET title = @title,
        latest_revision = @latest_revision,
        updated_at = @updated_at
    WHERE doc_id = @doc_id
  `);
  const insertRevisionIgnore = db.prepare(`
    INSERT OR IGNORE INTO revisions (rev_id, doc_id, rev_number, status, created_at)
    VALUES (@rev_id, @doc_id, @rev_number, @status, @created_at)
  `);

  const appendRevisionTransaction = db.transaction((input) => {
    const slug = normalizeSlug(input.slug);
    const now = input.createdAt || new Date().toISOString();
    let doc = selectBySlug.get(slug);
    if (!doc) {
      doc = {
        doc_id: newDocId(),
        slug,
        title: titleValue(input.title),
        owner: ownerValue(input.owner),
        latest_revision: null,
        created_at: now,
        updated_at: now,
      };
      insertDocument.run(doc);
    }

    const maxRow = selectMaxRevisionNumber.get(doc.doc_id);
    const revNumber = maxRow.max_rev_number + 1;
    insertRevisionIgnore.run({
      rev_id: input.revId,
      doc_id: doc.doc_id,
      rev_number: revNumber,
      status: PUBLISHED_STATUS,
      created_at: now,
    });
    updateDocumentLatest.run({
      doc_id: doc.doc_id,
      title: titleValue(input.title),
      latest_revision: input.revId,
      updated_at: now,
    });

    return getDocumentSnapshot(slug);
  });

  const ensureKnownRevisionTransaction = db.transaction((input) => {
    const now = input.createdAt || new Date().toISOString();
    const docId = nonEmptyString(input.docId) || anonymousDocId(input.revId);
    const slug = input.slug === null || input.slug === undefined ? null : normalizeSlug(input.slug);
    const owner = ownerValue(input.owner);
    const title = titleValue(input.title);
    const revNumber = positiveInteger(input.revNumber) || 1;
    insertDocumentIgnore.run({
      doc_id: docId,
      slug,
      title,
      owner,
      created_at: now,
      updated_at: now,
    });
    updateDocument.run({
      doc_id: docId,
      title,
      owner,
      updated_at: now,
    });
    insertRevisionIgnore.run({
      rev_id: input.revId,
      doc_id: docId,
      rev_number: revNumber,
      status: input.status || PUBLISHED_STATUS,
      created_at: now,
    });

    const latest = selectLatestRevisionNumber.get(docId);
    if (!latest || revNumber >= latest.rev_number) {
      updateDocumentLatest.run({
        doc_id: docId,
        title,
        latest_revision: input.revId,
        updated_at: now,
      });
    }
    return selectRevision.get(input.revId);
  });

  function getDocumentSnapshot(slug) {
    const doc = selectBySlug.get(slug);
    if (!doc) return null;
    const revisions = selectRevisionsByDoc.all(doc.doc_id).map(formatRevisionRow);
    const latestRevision = revisions.find((revision) => revision.revId === doc.latest_revision) || null;
    return {
      docId: doc.doc_id,
      slug: doc.slug,
      title: doc.title,
      owner: doc.owner,
      latestRevision: doc.latest_revision,
      createdAt: doc.created_at,
      updatedAt: doc.updated_at,
      revision: latestRevision,
      revisions,
    };
  }

  return {
    close() {
      db.close();
    },
    appendRevision(input) {
      return appendRevisionTransaction(input);
    },
    ensureAnonymousRevision({ revId, title, owner, createdAt }) {
      return ensureKnownRevisionTransaction({
        docId: anonymousDocId(revId),
        slug: null,
        revId,
        revNumber: 1,
        title,
        owner,
        createdAt,
      });
    },
    ensureRevisionFromMeta(meta) {
      if (!meta || !nonEmptyString(meta.id)) return null;
      const documentMeta = meta.document && typeof meta.document === 'object' ? meta.document : null;
      if (documentMeta?.slug) {
        return ensureKnownRevisionTransaction({
          docId: documentMeta.docId,
          slug: documentMeta.slug,
          revId: meta.id,
          revNumber: documentMeta.revNumber,
          title: meta.title,
          owner: documentMeta.owner || meta.owner,
          createdAt: meta.createdAt,
        });
      }
      return ensureKnownRevisionTransaction({
        docId: anonymousDocId(meta.id),
        slug: null,
        revId: meta.id,
        revNumber: 1,
        title: meta.title,
        owner: meta.owner,
        createdAt: meta.createdAt,
      });
    },
    getDocument(slug) {
      return getDocumentSnapshot(normalizeSlug(slug));
    },
    getRevision(revId) {
      const row = selectRevision.get(revId);
      return row ? formatRevisionRow(row) : null;
    },
    getRevisionDocument(revId) {
      const row = selectRevisionDocument.get(revId);
      return row ? formatRevisionDocumentRow(row) : null;
    },
    getRevisionBySlugNumber(slug, revNumber) {
      const row = selectRevisionBySlugNumber.get(normalizeSlug(slug), positiveInteger(revNumber));
      return row ? formatRevisionRow(row) : null;
    },
    hasRevision(revId) {
      return Boolean(selectRevision.get(revId));
    },
    getDocumentById(docId) {
      const doc = selectById.get(docId);
      if (!doc) return null;
      if (doc.slug) return getDocumentSnapshot(doc.slug);
      const revisions = selectRevisionsByDoc.all(doc.doc_id).map(formatRevisionRow);
      const latestRevision = revisions.find((revision) => revision.revId === doc.latest_revision) || null;
      return {
        docId: doc.doc_id,
        slug: null,
        title: doc.title,
        owner: doc.owner,
        latestRevision: doc.latest_revision,
        createdAt: doc.created_at,
        updatedAt: doc.updated_at,
        revision: latestRevision,
        revisions,
      };
    },
  };
}

function normalizeSlug(slug) {
  if (typeof slug !== 'string') {
    throw new DocumentStoreError('doc slug must be a string');
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new DocumentStoreError('doc slug must match ^[a-z0-9][a-z0-9_-]{2,63}$');
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new DocumentStoreError(`reserved doc slug: ${slug}`);
  }
  return slug;
}

function isValidDocumentSlug(slug) {
  return typeof slug === 'string' && SLUG_PATTERN.test(slug) && !RESERVED_SLUGS.has(slug);
}

function formatRevisionRow(row) {
  return {
    revId: row.rev_id,
    docId: row.doc_id,
    revNumber: row.rev_number,
    status: row.status,
    createdAt: row.created_at,
  };
}

function formatRevisionDocumentRow(row) {
  return {
    docId: row.doc_id,
    slug: row.slug,
    title: row.title,
    owner: row.owner,
    latestRevision: row.latest_revision,
    createdAt: row.doc_created_at,
    updatedAt: row.updated_at,
    revision: {
      revId: row.rev_id,
      docId: row.doc_id,
      revNumber: row.rev_number,
      status: row.status,
      createdAt: row.rev_created_at,
    },
  };
}

function anonymousDocId(revId) {
  return `anon_${revId}`;
}

function newDocId() {
  return `doc_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function titleValue(title) {
  return nonEmptyString(title) || '(제목 없음)';
}

function ownerValue(owner) {
  return nonEmptyString(owner) || DEFAULT_OWNER;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : '';
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

class DocumentStoreError extends Error {}

module.exports = {
  DocumentStoreError,
  RESERVED_SLUGS,
  SLUG_PATTERN,
  backfillDocumentMetadata,
  createDocumentStore,
  formatDocumentResponse,
  isValidDocumentSlug,
  normalizeSlug,
};

function formatDocumentResponse(documentRecord, baseUrl) {
  return {
    docId: documentRecord.docId,
    slug: documentRecord.slug,
    title: documentRecord.title,
    owner: documentRecord.owner,
    latestRevision: documentRecord.latestRevision,
    stableUrl: `${baseUrl}/d/${documentRecord.slug}`,
    createdAt: documentRecord.createdAt,
    updatedAt: documentRecord.updatedAt,
    revisions: documentRecord.revisions.map((revision) => ({
      revId: revision.revId,
      revNumber: revision.revNumber,
      status: revision.status,
      createdAt: revision.createdAt,
      pageUrl: `${baseUrl}/p/${revision.revId}`,
      revisionUrl: `${baseUrl}/d/${documentRecord.slug}/r/${revision.revNumber}`,
    })),
  };
}

function backfillDocumentMetadata({ pagesDir, documents, logger = console }) {
  let files = [];
  try {
    files = fs.readdirSync(pagesDir).filter((file) => file.endsWith('.json'));
  } catch {
    return;
  }
  for (const file of files) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(pagesDir, file), 'utf8'));
      documents.ensureRevisionFromMeta(meta);
    } catch (err) {
      logger.error(`[pages] failed to backfill document metadata for ${file}`, err);
    }
  }
}
