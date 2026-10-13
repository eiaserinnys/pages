import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.mjs';
import { createDatabase, createBucket, d1, seedDatabase, seedBucket } from './helpers/workerFixture.mjs';

const BASE_URL = 'https://pages.example.test';
const originalHtml = {
  'index.html': '<html><body>Outer shell</body></html>',
  'frame.html': '<html><body>Mockup body</body></html>',
  'extra/other.html': '<html><body>Character sheet</body></html>',
};

function fixture(t) {
  const db = createDatabase();
  t.after(() => db.close());
  const bucket = createBucket();
  seedDatabase(db);
  seedBucket(bucket);
  const env = {
    PAGES_DB: d1(db),
    PAGES_BUCKET: bucket,
    PAGES_API_TOKEN: 'token',
    SESSION_SECRET: 'secret',
    BASE_URL,
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'secret',
    ALLOWED_EMAILS: 'tester@example.com',
  };
  const call = (path, options) => worker.fetch(new Request(BASE_URL + path, options), env, { waitUntil() {} });
  const upload = (body) => call('/api/pages', {
    method: 'POST',
    headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { bucket, call, upload };
}

function encodeFiles(files = originalHtml) {
  return Object.entries(files).map(([path, content]) => ({
    path,
    content: Buffer.from(content, 'utf8').toString('base64'),
    encoding: 'base64',
  }));
}

async function responseBody(call, id, path) {
  const url = path ? `/p/${id}/${path}` : `/p/${id}/`;
  const response = await call(url);
  assert.equal(response.status, 200);
  return response.text();
}

function reviewConfig(source) {
  const match = source.match(/window\.__PAGES_REVIEW__=(.*?);/);
  return match ? JSON.parse(match[1]) : null;
}

test('reviewPaths attaches the review client only to selected bundle HTML', { timeout: 60_000 }, async (t) => {
  const { bucket, call, upload } = fixture(t);
  const response = await upload({
    reviewable: true,
    reviewPaths: ['frame.html', 'frame.html'],
    entrypoint: 'index.html',
    files: encodeFiles(),
  });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.deepEqual(Object.keys(result).sort(), ['id', 'review', 'url']);

  const metaObject = await bucket.get(`pages/${result.id}.json`);
  const meta = JSON.parse(await metaObject.text());
  assert.deepEqual(meta.reviewPaths, ['frame.html']);

  const index = await responseBody(call, result.id, '');
  const frame = await responseBody(call, result.id, 'frame.html');
  const other = await responseBody(call, result.id, 'extra/other.html');
  assert.equal(reviewConfig(index), null);
  assert.deepEqual(reviewConfig(frame).assetPath, 'frame.html');
  assert.equal(reviewConfig(other), null);
  assert.equal(index, originalHtml['index.html']);
  assert.equal(other, originalHtml['extra/other.html']);
});

test('omitting reviewPaths keeps review client injection on every bundle HTML page', { timeout: 60_000 }, async (t) => {
  const { bucket, call, upload } = fixture(t);
  const response = await upload({ reviewable: true, entrypoint: 'index.html', files: encodeFiles() });
  assert.equal(response.status, 201);
  const result = await response.json();
  const metaObject = await bucket.get(`pages/${result.id}.json`);
  const meta = JSON.parse(await metaObject.text());
  assert.equal(Object.hasOwn(meta, 'reviewPaths'), false);

  for (const path of ['', 'frame.html', 'extra/other.html']) {
    const html = await responseBody(call, result.id, path);
    assert.equal(reviewConfig(html).assetPath, path || 'index.html');
  }
});

test('reviewPaths rejects invalid targets with the upload API errors', { timeout: 60_000 }, async (t) => {
  const { upload } = fixture(t);
  const cases = [
    {
      name: 'non-reviewable upload',
      body: { reviewable: false, reviewPaths: ['index.html'], entrypoint: 'index.html', files: encodeFiles() },
      error: 'reviewPaths requires reviewable=true',
    },
    ...[
      ['not an array', 'frame.html'],
      ['empty array', []],
      ['non-string entry', [1]],
    ].map(([name, reviewPaths]) => ({
      name,
      body: { reviewable: true, reviewPaths, entrypoint: 'index.html', files: encodeFiles() },
      error: 'reviewPaths must be a non-empty array of bundle paths',
    })),
    {
      name: 'missing bundle path',
      body: { reviewable: true, reviewPaths: ['missing.html'], entrypoint: 'index.html', files: encodeFiles() },
      error: 'reviewPaths entry not found in bundle: missing.html',
    },
    {
      name: 'non-HTML bundle path',
      body: {
        reviewable: true,
        reviewPaths: ['style.css'],
        entrypoint: 'index.html',
        files: encodeFiles({
          'index.html': originalHtml['index.html'],
          'style.css': 'body {}',
        }).map((file) => file.path === 'style.css' ? { ...file, contentType: 'text/css' } : file),
      },
      error: 'reviewPaths entry is not HTML: style.css',
    },
    {
      name: 'single HTML upload only contains index.html',
      body: { reviewable: true, reviewPaths: ['frame.html'], html: originalHtml['index.html'] },
      error: 'reviewPaths entry not found in bundle: frame.html',
    },
  ];

  for (const { name, body, error } of cases) {
    const response = await upload(body);
    assert.equal(response.status, 400, name);
    assert.deepEqual(await response.json(), { error }, name);
  }
});
