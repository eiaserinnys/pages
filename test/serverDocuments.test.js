'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const test = require('node:test');

const API_TOKEN = 'test-api-token';

test('server supports anonymous pages and opt-in document revisions', async () => {
  const server = await startPagesServer();
  try {
    const anonymous = await postPage(server, {
      html: '<h1>Anonymous</h1>',
      title: 'Anonymous',
    });
    assert.deepEqual(Object.keys(anonymous).sort(), ['id', 'url']);
    assert.match(anonymous.id, /^[0-9a-f]{12}$/);
    assert.equal(anonymous.url, `${server.baseUrl}/p/${anonymous.id}`);

    const first = await postPage(server, {
      html: '<h1>Doc V1</h1>',
      title: 'Doc V1',
      doc: 'phase-two-doc',
    });
    assert.equal(first.revNumber, 1);
    assert.equal(first.revId, first.id);
    assert.equal(first.stableUrl, `${server.baseUrl}/d/phase-two-doc`);
    assert.equal(first.revisionUrl, `${server.baseUrl}/d/phase-two-doc/r/1`);

    const second = await postPage(server, {
      html: '<h1>Doc V2</h1>',
      title: 'Doc V2',
      doc: 'phase-two-doc',
    });
    assert.equal(second.docId, first.docId);
    assert.equal(second.revNumber, 2);
    assert.equal(second.revId, second.id);

    const latestRedirect = await fetch(`${server.baseUrl}/d/phase-two-doc`, { redirect: 'manual' });
    assert.equal(latestRedirect.status, 302);
    assert.equal(latestRedirect.headers.get('location'), '/d/phase-two-doc/r/2');

    const fixedFirst = await fetchText(`${server.baseUrl}/d/phase-two-doc/r/1`);
    const fixedSecond = await fetchText(`${server.baseUrl}/d/phase-two-doc/r/2`);
    assert.match(fixedFirst, /Doc V1/);
    assert.match(fixedSecond, /Doc V2/);

    const metadata = await fetchJson(`${server.baseUrl}/api/documents/phase-two-doc`);
    assert.equal(metadata.docId, first.docId);
    assert.equal(metadata.latestRevision, second.revId);
    assert.deepEqual(metadata.revisions.map((revision) => revision.revNumber), [2, 1]);
    assert.deepEqual(metadata.revisions.map((revision) => revision.revId), [second.revId, first.revId]);

    const badSlug = await postPage(server, {
      html: '<h1>Bad</h1>',
      title: 'Bad',
      doc: 'api',
    }, { expectedStatus: 400 });
    assert.match(badSlug.error, /reserved doc slug/);
  } finally {
    await stopPagesServer(server);
  }
});

test('review comments stay scoped to the revision that received them', async () => {
  const server = await startPagesServer();
  try {
    const first = await postPage(server, {
      html: '<h1>Review V1</h1>',
      title: 'Review V1',
      doc: 'review-doc',
      reviewable: true,
    });
    const second = await postPage(server, {
      html: '<h1>Review V2</h1>',
      title: 'Review V2',
      doc: 'review-doc',
      reviewable: true,
    });

    await putComments(server, first.review, {
      schema_version: '1.0',
      document_id: first.revId,
      comments: [
        {
          id: 'cmt_rev1',
          document_id: first.revId,
          block_id: 'intro',
          selected_text: 'Review V1',
          prefix: '',
          suffix: '',
          comment: 'Fix v1 only',
          status: 'needs_agent_review',
          created_at: '2026-06-15T00:00:00.000Z',
          replies: [],
        },
      ],
    });

    const firstComments = await fetchJson(`${server.baseUrl}${first.review.annotationsUrl}`);
    const secondComments = await fetchJson(`${server.baseUrl}${second.review.annotationsUrl}`);
    assert.equal(firstComments.comments.length, 1);
    assert.equal(firstComments.comments[0].id, 'cmt_rev1');
    assert.equal(secondComments.comments.length, 0);
  } finally {
    await stopPagesServer(server);
  }
});

async function startPagesServer() {
  const port = await getFreePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-server-'));
  const pagesDir = path.join(root, 'pages');
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      PAGES_DIR: pagesDir,
      PAGES_API_TOKEN: API_TOKEN,
      SESSION_SECRET: 'test-session-secret',
      BASE_URL: baseUrl,
      GOOGLE_CLIENT_ID: 'test-client',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      ALLOWED_EMAILS: 'tester@example.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString('utf8')));
  await waitForServer(child, logs);
  return { baseUrl, child, root, logs };
}

async function stopPagesServer(server) {
  if (!server.child.killed) {
    server.child.kill('SIGTERM');
    const timeout = setTimeout(() => server.child.kill('SIGKILL'), 1000);
    try {
      await once(server.child, 'exit');
    } finally {
      clearTimeout(timeout);
    }
  }
  fs.rmSync(server.root, { recursive: true, force: true });
}

function waitForServer(child, logs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`server did not start:\n${logs.join('')}`));
    }, 5000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited with ${code}:\n${logs.join('')}`));
    });
    child.stdout.on('data', (chunk) => {
      if (chunk.toString('utf8').includes('Server running on port')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

async function postPage(server, payload, { expectedStatus = 201 } = {}) {
  const response = await fetch(`${server.baseUrl}/api/pages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(body));
  return body;
}

async function putComments(server, review, payload) {
  const response = await fetch(`${server.baseUrl}${review.annotationsUrl}`, {
    method: 'PUT',
    headers: {
      [review.tokenHeader]: review.capabilityToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function fetchText(url) {
  const response = await fetch(url);
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return body;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
