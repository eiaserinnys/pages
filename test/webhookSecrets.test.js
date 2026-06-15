'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createWebhookSecretStore, hashWebhookSecret } = require('../src/webhookSecrets');

test('webhook secret store keeps the secret outside page metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-webhook-secrets-'));
  const store = createWebhookSecretStore({ dbPath: path.join(root, 'meta.sqlite') });
  try {
    const hash = store.save('abc123abc123', 'signing-secret');
    assert.equal(hash, hashWebhookSecret('signing-secret'));
    assert.equal(store.get('abc123abc123'), 'signing-secret');

    assert.equal(store.save('abc123abc123', ''), null);
    assert.equal(store.get('abc123abc123'), '');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
