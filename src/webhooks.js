'use strict';

const crypto = require('crypto');

const WEBHOOK_TIMEOUT_MS = 5000;

function normalizeWebhookUrl(value) {
  if (!value) return '';
  if (typeof value !== 'string') {
    throw new WebhookConfigurationError('webhook URL must be a string');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WebhookConfigurationError('webhook URL must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new WebhookConfigurationError('webhook URL must use http or https');
  }
  return url.toString();
}

function buildAnnotationWebhookEvent({ revId, count, timestamp = new Date().toISOString() }) {
  return {
    event: 'pages.annotations.updated',
    rev_id: revId,
    count,
    annotations_url: `/api/annotations/${revId}`,
    page_url: `/p/${revId}`,
    timestamp,
  };
}

function queueAnnotationWebhook({ url, payload, secret = '', timeoutMs = WEBHOOK_TIMEOUT_MS }) {
  if (!url) return false;
  setImmediate(() => {
    postAnnotationWebhook({ url, payload, secret, timeoutMs }).catch((err) => {
      console.error('[pages] annotation webhook failed', {
        url: redactWebhookUrl(url),
        revId: payload?.rev_id,
        error: err.message,
      });
    });
  });
  return true;
}

async function postAnnotationWebhook({ url, payload, secret = '', timeoutMs = WEBHOOK_TIMEOUT_MS }) {
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
  };
  if (secret) {
    headers['X-Pages-Webhook-Signature'] = `sha256=${signWebhookBody(body, secret)}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`webhook returned ${response.status}`);
    }
    return { status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

function signWebhookBody(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function redactWebhookUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    if (url.search) {
      url.search = '?redacted';
    }
    return url.toString();
  } catch {
    return '<invalid webhook url>';
  }
}

class WebhookConfigurationError extends Error {}

module.exports = {
  WEBHOOK_TIMEOUT_MS,
  WebhookConfigurationError,
  buildAnnotationWebhookEvent,
  normalizeWebhookUrl,
  postAnnotationWebhook,
  queueAnnotationWebhook,
  redactWebhookUrl,
  signWebhookBody,
};
