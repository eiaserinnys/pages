'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { issueAnnotationToken, verifyAnnotationToken } = require('../src/capabilityTokens');

test('annotation capability token is scoped to one revision', () => {
  const issued = issueAnnotationToken({
    revId: 'abc123abc123',
    secret: 'test-secret',
    ttlSeconds: 60,
    now: 1_000_000,
  });

  assert.equal(
    verifyAnnotationToken(issued.token, {
      revId: 'abc123abc123',
      secret: 'test-secret',
      now: 1_000_000,
    }).ok,
    true
  );
  assert.equal(
    verifyAnnotationToken(issued.token, {
      revId: 'def456def456',
      secret: 'test-secret',
      now: 1_000_000,
    }).error,
    'wrong_scope'
  );
});

test('annotation capability token expires', () => {
  const issued = issueAnnotationToken({
    revId: 'abc123abc123',
    secret: 'test-secret',
    ttlSeconds: 1,
    now: 1_000_000,
  });

  assert.equal(
    verifyAnnotationToken(issued.token, {
      revId: 'abc123abc123',
      secret: 'test-secret',
      now: 1_003_000,
    }).error,
    'expired_token'
  );
});
