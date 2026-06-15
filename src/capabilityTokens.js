'use strict';

const crypto = require('crypto');

function issueAnnotationToken({ revId, secret, ttlSeconds, now = Date.now() }) {
  assertTokenInput({ revId, secret });
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const payload = encodeJson({ typ: 'pages.annotation', rev_id: revId, exp });
  return {
    token: `${payload}.${sign(payload, secret)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

function verifyAnnotationToken(token, { revId, secret, now = Date.now() }) {
  assertTokenInput({ revId, secret });
  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'missing_token' };
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, error: 'invalid_token' };
  }
  const [payloadText, signature] = parts;
  if (!safeEqual(signature, sign(payloadText, secret))) {
    return { ok: false, error: 'invalid_signature' };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadText, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'invalid_payload' };
  }
  if (payload.typ !== 'pages.annotation' || payload.rev_id !== revId) {
    return { ok: false, error: 'wrong_scope' };
  }
  if (!Number.isInteger(payload.exp) || payload.exp < Math.floor(now / 1000)) {
    return { ok: false, error: 'expired_token' };
  }
  return { ok: true, payload };
}

function encodeJson(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function sign(payloadText, secret) {
  return crypto.createHmac('sha256', secret).update(payloadText).digest('base64url');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function assertTokenInput({ revId, secret }) {
  if (!revId || typeof revId !== 'string') {
    throw new Error('revId is required');
  }
  if (!secret || typeof secret !== 'string') {
    throw new Error('secret is required');
  }
}

module.exports = {
  issueAnnotationToken,
  verifyAnnotationToken,
};
