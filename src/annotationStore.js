'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '001_comments.sql');
const DEFAULT_SCHEMA_VERSION = '1.0';
const DEFAULT_STATUS = 'needs_agent_review';
const STATUS_VALUES = new Set(['needs_agent_review', 'needs_user_reply', 'resolved']);

function createAnnotationStore({ dbPath }) {
  if (!dbPath) {
    throw new Error('dbPath is required');
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(fs.readFileSync(MIGRATION_PATH, 'utf8'));

  const selectByRev = db.prepare(
    'SELECT payload_json FROM comments WHERE rev_id = ? ORDER BY created_at ASC, comment_id ASC'
  );
  const deleteByRev = db.prepare('DELETE FROM comments WHERE rev_id = ?');
  const insertComment = db.prepare(`
    INSERT INTO comments (
      comment_id, rev_id, anchor, body, author, created_at, resolved, payload_json, updated_at
    ) VALUES (
      @comment_id, @rev_id, @anchor, @body, @author, @created_at, @resolved, @payload_json, @updated_at
    )
  `);

  const replaceTransaction = db.transaction((revId, payload) => {
    deleteByRev.run(revId);
    const updatedAt = new Date().toISOString();
    for (const comment of payload.comments) {
      const row = rowFromComment(revId, comment, updatedAt);
      insertComment.run(row);
    }
  });

  return {
    close() {
      db.close();
    },
    list(revId) {
      const comments = selectByRev.all(revId).map((row) => JSON.parse(row.payload_json));
      return {
        schema_version: DEFAULT_SCHEMA_VERSION,
        document_id: revId,
        comments,
      };
    },
    replace(revId, rawPayload) {
      const payload = normalizeCommentsPayload(revId, rawPayload);
      replaceTransaction(revId, payload);
      return payload;
    },
  };
}

function normalizeCommentsPayload(revId, rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    throw new AnnotationStoreError('request body must be a comments object');
  }
  if (!Array.isArray(rawPayload.comments)) {
    throw new AnnotationStoreError('comments must be an array');
  }
  const documentId = nonEmptyString(rawPayload.document_id) || revId;
  return {
    schema_version: nonEmptyString(rawPayload.schema_version) || DEFAULT_SCHEMA_VERSION,
    document_id: documentId,
    comments: rawPayload.comments.map((comment, index) => normalizeComment(documentId, comment, index)),
  };
}

function normalizeComment(documentId, rawComment, index) {
  if (!rawComment || typeof rawComment !== 'object' || Array.isArray(rawComment)) {
    throw new AnnotationStoreError(`comments[${index}] must be an object`);
  }
  const id = nonEmptyString(rawComment.id);
  if (!id) {
    throw new AnnotationStoreError(`comments[${index}].id is required`);
  }
  const status = STATUS_VALUES.has(rawComment.status) ? rawComment.status : DEFAULT_STATUS;
  const comment = {
    ...rawComment,
    id,
    document_id: nonEmptyString(rawComment.document_id) || documentId,
    block_id: stringValue(rawComment.block_id),
    selected_text: stringValue(rawComment.selected_text),
    prefix: stringValue(rawComment.prefix),
    suffix: stringValue(rawComment.suffix),
    comment: stringValue(rawComment.comment ?? rawComment.body),
    status,
    created_at: nonEmptyString(rawComment.created_at) || new Date().toISOString(),
    replies: Array.isArray(rawComment.replies) ? rawComment.replies : [],
  };
  return comment;
}

function rowFromComment(revId, comment, updatedAt) {
  const anchor = {
    document_id: comment.document_id,
    block_id: comment.block_id,
    selected_text: comment.selected_text,
    prefix: comment.prefix,
    suffix: comment.suffix,
  };
  return {
    comment_id: comment.id,
    rev_id: revId,
    anchor: JSON.stringify(anchor),
    body: comment.comment,
    author: nonEmptyString(comment.author) || 'reviewer',
    created_at: comment.created_at,
    resolved: comment.status === 'resolved' ? 1 : 0,
    payload_json: JSON.stringify(comment),
    updated_at: updatedAt,
  };
}

function newCommentId() {
  return `cmt_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : '';
}

function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

class AnnotationStoreError extends Error {}

module.exports = {
  AnnotationStoreError,
  createAnnotationStore,
  newCommentId,
  normalizeCommentsPayload,
};
