import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, makeMarker, markerHtml, PagesDocState, stateUrl, workerFetchFor, BASE_URL } from './helpers/docStateFixture.mjs';

const SLUG = 'state-doc';
const opts = (call) => ({ fetch: workerFetchFor(call), baseUrl: BASE_URL });

async function publish(upload, html, extra = {}) {
  const response = await upload({ doc: SLUG, html, ...extra });
  assert.equal(response.status, 201, await response.clone().text());
  return response;
}

test('marker registration: create, keep, reset on change, untouched without marker, 400 when malformed', { timeout: 60_000 }, async (t) => {
  const { upload, stateRow, call } = fixture(t);
  const first = await makeMarker('made-up-password-one');
  await publish(upload, markerHtml(first.config));
  let row = stateRow(SLUG);
  assert.equal(row.version, 0);
  assert.equal(row.blob, null);
  assert.equal(row.verifier, first.config.verifier);

  const save = await PagesDocState.saveState(SLUG, first.keys.writeKey, 0, 'blob-one', opts(call));
  assert.equal(save.status, 'saved');

  await publish(upload, markerHtml(first.config));
  row = stateRow(SLUG);
  assert.equal(row.version, 1);
  assert.equal(row.blob, 'blob-one');

  await publish(upload, '<html><body>no marker</body></html>');
  row = stateRow(SLUG);
  assert.equal(row.version, 1);
  assert.equal(row.blob, 'blob-one');

  const second = await makeMarker('made-up-password-two', { salt: first.config.salt });
  await publish(upload, markerHtml(second.config));
  row = stateRow(SLUG);
  assert.equal(row.version, 2);
  assert.equal(row.blob, null);
  assert.equal(row.verifier, second.config.verifier);

  const revisionsBefore = await (await call(`/api/documents/${SLUG}`)).json();
  const good = second.config;
  const bad = [
    { ...good, v: 2 },
    { ...good, iter: 9999 },
    { ...good, iter: 1000001 },
    { ...good, iter: 120000.5 },
    { ...good, salt: 'AAAA' },
    { ...good, salt: '***not-base64***' },
    { ...good, verifier: 'short' },
    { ...good, verifier: `${good.verifier}=` },
  ];
  for (const config of bad) {
    const response = await upload({ doc: SLUG, html: markerHtml(config) });
    assert.equal(response.status, 400, JSON.stringify(config));
  }
  const malformedJson = await upload({ doc: SLUG, html: '<script type="application/json" id="pages-doc-state">{oops</script>' });
  assert.equal(malformedJson.status, 400);
  const revisionsAfter = await (await call(`/api/documents/${SLUG}`)).json();
  assert.equal(revisionsAfter.revisions.length, revisionsBefore.revisions.length, 'rejected uploads create no revision');
});

test('marker in a bundle entrypoint registers state; anonymous uploads ignore it', { timeout: 60_000 }, async (t) => {
  const { upload, stateRow, db } = fixture(t);
  const { config } = await makeMarker('made-up-password-bundle');
  const html = markerHtml(config);
  const response = await upload({
    doc: SLUG,
    entrypoint: 'main.html',
    files: [{ path: 'main.html', content: Buffer.from(html).toString('base64'), encoding: 'base64' }],
  });
  assert.equal(response.status, 201);
  assert.equal(stateRow(SLUG).verifier, config.verifier);
  const anonymous = await upload({ html });
  assert.equal(anonymous.status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM document_state').get().n, 1);
});

test('GET state: missing document, state not enabled, body, private requires auth', { timeout: 60_000 }, async (t) => {
  const { upload, call } = fixture(t);
  let response = await call(stateUrl('nope-doc'));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'document_not_found' });

  await publish(upload, markerHtml(null));
  response = await call(stateUrl(SLUG));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'state_not_enabled' });

  const { config } = await makeMarker('made-up-password-get');
  await publish(upload, markerHtml(config));
  response = await call(stateUrl(SLUG));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { version: 0, blob: null, updatedAt: null });

  await publish(upload, markerHtml(config), { private: true });
  response = await call(stateUrl(SLUG));
  assert.equal(response.status, 401);
  response = await call(stateUrl(SLUG), { method: 'PUT', headers: { 'X-Pages-Write-Key': 'x' }, body: '{}' });
  assert.equal(response.status, 401);

  response = await call(stateUrl(SLUG), { method: 'DELETE' });
  assert.equal(response.status, 405);
});

test('PUT state: write key, shape, size, version conflict, success', { timeout: 60_000 }, async (t) => {
  const { upload, call } = fixture(t);
  const { config, keys } = await makeMarker('made-up-password-put');
  await publish(upload, markerHtml(config));
  const put = (body, headers = {}) => call(stateUrl(SLUG), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const good = { 'X-Pages-Write-Key': keys.writeKey };

  let response = await put({ baseVersion: 0, blob: 'b' });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'invalid_write_key' });
  const wrongKey = Buffer.alloc(32, 7).toString('base64url');
  response = await put({ baseVersion: 0, blob: 'b' }, { 'X-Pages-Write-Key': wrongKey });
  assert.equal(response.status, 403);

  for (const body of ['not json', { baseVersion: -1, blob: 'b' }, { baseVersion: 1.5, blob: 'b' }, { baseVersion: 0, blob: 5 }, { blob: 'b' }]) {
    response = await put(body, good);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { error: 'invalid_state' });
  }

  response = await put({ baseVersion: 0, blob: 'x'.repeat(1024 * 1024 + 1) }, good);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'state_too_large' });

  response = await put({ baseVersion: 0, blob: 'first' }, good);
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.version, 1);
  assert.ok(saved.updatedAt);

  response = await put({ baseVersion: 0, blob: 'stale' }, good);
  assert.equal(response.status, 409);
  const conflict = await response.json();
  assert.equal(conflict.error, 'version_conflict');
  assert.equal(conflict.version, 1);
  assert.equal(conflict.blob, 'first');

  const current = await (await call(stateUrl(SLUG))).json();
  assert.equal(current.version, 1);
  assert.equal(current.blob, 'first');
});

test('round trip through the reference client: encrypt, save, fetch, decrypt, conflict', { timeout: 60_000 }, async (t) => {
  const { upload, call } = fixture(t);
  const password = 'made-up-password-roundtrip';
  const { config } = await makeMarker(password);
  await publish(upload, markerHtml(config));
  const o = opts(call);

  const keys = await PagesDocState.deriveKeys(password, config);
  assert.equal(keys.verified, true);
  assert.equal((await PagesDocState.deriveKeys('wrong made-up password', config)).verified, false);

  const value = { notes: ['안녕', 'second'], n: 3 };
  const blob = await PagesDocState.encryptState(keys.encKey, value);
  assert.deepEqual(await PagesDocState.saveState(SLUG, keys.writeKey, 0, blob, o), {
    status: 'saved', version: 1, updatedAt: (await PagesDocState.fetchState(SLUG, o)).updatedAt,
  });

  const fetched = await PagesDocState.fetchState(SLUG, o);
  assert.equal(fetched.version, 1);
  assert.deepEqual(await PagesDocState.decryptState(keys.encKey, fetched.blob), value);
  assert.ok(!fetched.blob.includes('second'), 'server blob is not plaintext');

  const conflict = await PagesDocState.saveState(SLUG, keys.writeKey, 0, blob, o);
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.version, 1);
  assert.equal(conflict.blob, fetched.blob);

  await assert.rejects(
    PagesDocState.saveState(SLUG, Buffer.alloc(32, 1).toString('base64url'), 1, blob, o),
    (err) => err.status === 403 && err.error === 'invalid_write_key',
  );
  await assert.rejects(PagesDocState.fetchState('missing-doc', o), (err) => err.status === 404 && err.error === 'document_not_found');
});
