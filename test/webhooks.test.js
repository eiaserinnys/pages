'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const test = require('node:test');
const {
  buildAnnotationWebhookEvent,
  normalizeWebhookUrl,
  postAnnotationWebhook,
  redactWebhookUrl,
  signWebhookBody,
} = require('../src/webhooks');

test('annotation webhook posts plain JSON without a signature when no secret is configured', async () => {
  const { server, url, received } = await startWebhookServer();
  try {
    const payload = buildAnnotationWebhookEvent({
      revId: 'abc123abc123',
      count: 2,
      timestamp: '2026-06-15T00:00:00.000Z',
    });

    const result = await postAnnotationWebhook({ url, payload, timeoutMs: 1000 });
    assert.equal(result.status, 204);
    assert.deepEqual(JSON.parse(received[0].body), payload);
    assert.equal(received[0].headers['x-pages-webhook-signature'], undefined);
  } finally {
    await closeServer(server);
  }
});

test('annotation webhook signs the exact JSON body when a secret is configured', async () => {
  const { server, url, received } = await startWebhookServer();
  try {
    const payload = buildAnnotationWebhookEvent({
      revId: 'abc123abc123',
      count: 1,
      timestamp: '2026-06-15T00:00:00.000Z',
    });

    await postAnnotationWebhook({ url, payload, secret: 'signing-secret', timeoutMs: 1000 });
    const body = received[0].body;
    const expected = crypto.createHmac('sha256', 'signing-secret').update(body).digest('hex');
    assert.equal(received[0].headers['x-pages-webhook-signature'], `sha256=${expected}`);
    assert.equal(signWebhookBody(body, 'signing-secret'), expected);
  } finally {
    await closeServer(server);
  }
});

test('annotation webhook rejects non-2xx responses for fire-and-forget logging', async () => {
  const { server, url } = await startWebhookServer({ status: 500 });
  try {
    await assert.rejects(
      () => postAnnotationWebhook({
        url,
        payload: buildAnnotationWebhookEvent({ revId: 'abc123abc123', count: 1 }),
        timeoutMs: 1000,
      }),
      /webhook returned 500/
    );
  } finally {
    await closeServer(server);
  }
});

test('webhook URL must be absolute http or https', () => {
  assert.equal(normalizeWebhookUrl('https://example.com/hook'), 'https://example.com/hook');
  assert.throws(() => normalizeWebhookUrl('/relative'), /absolute URL/);
  assert.throws(() => normalizeWebhookUrl('file:///tmp/hook'), /http or https/);
});

test('webhook failure logs redact URL credentials and query tokens', () => {
  assert.equal(
    redactWebhookUrl('https://user:pass@example.com/hook?token=secret&x=1'),
    'https://example.com/hook?redacted'
  );
});

function startWebhookServer({ status = 204 } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.statusCode = status;
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        received,
        url: `http://127.0.0.1:${address.port}/webhook`,
      });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
