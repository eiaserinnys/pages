'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createAnnotationStore } = require('../src/annotationStore');

test('annotation store replaces all comments for one revision', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-annotations-'));
  const store = createAnnotationStore({ dbPath: path.join(root, 'meta.sqlite') });
  try {
    const payload = {
      schema_version: '1.0',
      document_id: 'abc123abc123',
      comments: [
        {
          id: 'cmt_1',
          document_id: 'abc123abc123',
          block_id: 'intro',
          selected_text: 'hello',
          prefix: '',
          suffix: '',
          comment: 'replace hello',
          status: 'needs_agent_review',
          created_at: '2026-06-15T00:00:00.000Z',
          replies: [],
        },
      ],
    };

    store.replace('abc123abc123', payload);
    assert.deepEqual(store.list('abc123abc123'), payload);

    store.replace('abc123abc123', { ...payload, comments: [] });
    assert.deepEqual(store.list('abc123abc123').comments, []);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('annotation store rejects comments without a stable id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-annotations-'));
  const store = createAnnotationStore({ dbPath: path.join(root, 'meta.sqlite') });
  try {
    assert.throws(
      () => store.replace('abc123abc123', { schema_version: '1.0', comments: [{}] }),
      /comments\[0\]\.id is required/
    );
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
