'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createPageStorage } = require('../src/pageStorage');

test('page metadata listing is cached and invalidated by writes and deletes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-storage-'));
  const storage = createPageStorage({ pagesDir: root });
  try {
    storage.writeMeta('aaa111aaa111', { id: 'aaa111aaa111', title: 'First' });
    assert.deepEqual(storage.listMetas().map((item) => item.id), ['aaa111aaa111']);

    fs.writeFileSync(path.join(root, 'bbb222bbb222.json'), JSON.stringify({ id: 'bbb222bbb222', title: 'Second' }));
    assert.deepEqual(storage.listMetas().map((item) => item.id), ['aaa111aaa111']);

    storage.writeMeta('bbb222bbb222', { id: 'bbb222bbb222', title: 'Second' });
    assert.deepEqual(storage.listMetas().map((item) => item.id).sort(), ['aaa111aaa111', 'bbb222bbb222']);

    storage.deletePage('aaa111aaa111');
    assert.deepEqual(storage.listMetas().map((item) => item.id), ['bbb222bbb222']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HTML snippets read only the requested prefix', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-storage-snippet-'));
  const storage = createPageStorage({ pagesDir: root });
  try {
    storage.writeHtml('aaa111aaa111', '0123456789');
    assert.equal(storage.readHtmlSnippet('aaa111aaa111', 4), '0123');
    assert.equal(storage.readHtml('aaa111aaa111'), '0123456789');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
