'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { injectReviewConfig } = require('../src/reviewBundle');

test('review config is injected before the closing head tag', () => {
  const html = '<!doctype html><html><head><title>x</title></head><body></body></html>';
  const result = injectReviewConfig(html, {
    revId: 'abc123abc123',
    annotationsUrl: '/api/annotations/abc123abc123',
    tokenHeader: 'X-Pages-Annotation-Token',
    capabilityToken: 'token',
  });

  assert.match(result, /window\.__PAGES_REVIEW__=/);
  assert.ok(result.indexOf('window.__PAGES_REVIEW__') < result.indexOf('</head>'));
});
