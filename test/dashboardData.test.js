'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { extractUnfurl } = require('../src/dashboardData');

test('unfurl extraction prefers Open Graph metadata and resolves relative images', () => {
  const unfurl = extractUnfurl(`<!doctype html>
    <html><head>
      <title>Document title</title>
      <meta content="OG title" property="og:title">
      <meta name="description" content="Plain description">
      <meta property="og:description" content="OG &amp; description">
      <meta content="assets/card.png" property="og:image">
    </head></html>`, {
    url: 'https://pages.example.test/d/alpha-doc/',
    fallbackTitle: 'Fallback',
  });

  assert.deepEqual(unfurl, {
    title: 'OG title',
    description: 'OG & description',
    image: 'https://pages.example.test/d/alpha-doc/assets/card.png',
    url: 'https://pages.example.test/d/alpha-doc/',
  });
});

test('unfurl extraction bounds metadata and leaves invalid numeric entities intact', () => {
  const unfurl = extractUnfurl(`<html><head>
    <title>&#999999999;${'T'.repeat(400)}</title>
    <meta name="description" content="${'D'.repeat(1200)}">
  </head></html>`, {
    url: 'https://pages.example.test/p/aaa111aaa111/',
    fallbackTitle: 'Fallback',
  });

  assert.equal(unfurl.title.startsWith('&#999999999;'), true);
  assert.equal(unfurl.title.length, 300);
  assert.equal(unfurl.description.length, 1000);
});
