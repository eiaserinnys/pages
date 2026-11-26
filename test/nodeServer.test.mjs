import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPagesServer } from '../src/node/server.mjs';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function start(dataDir, port) {
  const server = createPagesServer({
    dataDir,
    env: {
      PAGES_API_TOKEN: 'token',
      SESSION_SECRET: 'secret',
      BASE_URL: `http://127.0.0.1:${port}`,
      GOOGLE_CLIENT_ID: 'client',
      GOOGLE_CLIENT_SECRET: 'secret',
      ALLOWED_EMAILS: 'tester@example.com',
    },
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const stop = () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  return { base: `http://127.0.0.1:${port}`, stop };
}

test('self-hosted Node server uploads, serves, and keeps documents across restarts', { timeout: 60_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pages-node-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const port = await freePort();

  let running = await start(dataDir, port);
  t.after(() => running.stop());
  const upload = await fetch(`${running.base}/api/pages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ doc: 'node-doc', title: 'Node Doc', html: '<html><body>Hello Node</body></html>' }),
  });
  assert.equal(upload.status, 201);
  const created = await upload.json();
  assert.equal(created.stableUrl, `${running.base}/d/node-doc`);

  const verify = async () => {
    const stable = await fetch(`${running.base}/d/node-doc/`);
    assert.equal(stable.status, 200);
    assert.match(await stable.text(), /Hello Node/);
    const revision = await fetch(`${running.base}/p/${created.id}/`);
    assert.equal(revision.status, 200);
    assert.match(await revision.text(), /Hello Node/);
    const api = await fetch(`${running.base}/api/documents/node-doc`);
    assert.equal(api.status, 200);
    assert.equal((await api.json()).title, 'Node Doc');
    const redirect = await fetch(`${running.base}/d/node-doc`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), `${running.base}/d/node-doc/`);
    assert.equal((await fetch(`${running.base}/d/no-such-doc/`)).status, 404);
  };
  await verify();

  const unauthorized = await fetch(`${running.base}/api/pages`, { method: 'POST', body: '{}' });
  assert.equal(unauthorized.status, 401);

  await running.stop();
  running = await start(dataDir, await freePort());
  await verify();
});

test('self-hosted Node server streams change events to a signed-in dashboard', { timeout: 60_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pages-node-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const running = await start(dataDir, await freePort());
  t.after(() => running.stop());

  const payload = Buffer.from(JSON.stringify({ email: 'tester@example.com', exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
  const cookie = `pages.session=${payload}.${createHmac('sha256', 'secret').update(payload).digest('base64url')}`;
  const stream = await fetch(`${running.base}/api/events`, { headers: { cookie } });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.getReader();
  t.after(() => reader.cancel());

  const upload = await fetch(`${running.base}/api/pages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ doc: 'event-doc', title: 'Event Doc', html: '<html><body>Event</body></html>' }),
  });
  assert.equal(upload.status, 201);

  let text = '';
  const decoder = new TextDecoder();
  while (!text.includes('\n\n')) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    text += decoder.decode(value, { stream: true });
  }
  assert.match(text, /event: document_updated\ndata: {"type":"document_updated","id":"event-doc"}/);
});
