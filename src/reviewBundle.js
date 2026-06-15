'use strict';

function injectReviewConfig(html, config) {
  const script = `<script>window.__PAGES_REVIEW__=${safeJson(config)};</script>`;
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${script}\n</head>`);
  }
  return `${script}\n${html}`;
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

module.exports = {
  injectReviewConfig,
};
