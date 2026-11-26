import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { renderWranglerConfig } from '../scripts/render_wrangler_config.mjs';

const CLI = new URL('../scripts/render_wrangler_config.mjs', import.meta.url).pathname;
const TEMPLATE = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const DB_ID = '11111111-2222-4333-8444-555555555555';
const OWN_DOMAIN = {
  PAGES_BASE_URL: 'https://docs.example.com',
  PAGES_D1_DATABASE_ID: DB_ID,
  PAGES_ROUTE_PATTERN: 'docs.example.com',
  PAGES_ZONE_NAME: 'example.com',
};

function runCli(env) {
  const out = join(mkdtempSync(join(tmpdir(), 'render-wrangler-')), 'wrangler.deploy.toml');
  const result = spawnSync(process.execPath, [CLI, '--out', out], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
  return { ...result, out };
}

test('template carries no deploy values and no routes', () => {
  assert.doesNotMatch(TEMPLATE, /^\s*ALLOWED_EMAILS\s*=/m);
  assert.doesNotMatch(TEMPLATE, /\[\[routes\]\]/);
});

test('renders own-domain config with a custom domain route', () => {
  const out = renderWranglerConfig(TEMPLATE, OWN_DOMAIN);
  assert.match(out, /^BASE_URL = "https:\/\/docs\.example\.com"$/m);
  assert.match(out, new RegExp(`^database_id = "${DB_ID}"$`, 'm'));
  assert.ok(out.trimEnd().endsWith('[[routes]]\npattern = "docs.example.com"\nzone_name = "example.com"\ncustom_domain = true'));
  assert.doesNotMatch(out, /pages\.example\.com|00000000-0000/);
  assert.match(out, /^name = "pages-cloudflare"$/m);
  assert.match(out, /^main = "src\/worker\.mjs"$/m);
});

test('renders workers.dev config without routes', () => {
  const out = renderWranglerConfig(TEMPLATE, {
    PAGES_BASE_URL: 'https://pages-cloudflare.someone.workers.dev',
    PAGES_D1_DATABASE_ID: DB_ID,
    PAGES_ROUTE_PATTERN: '',
    PAGES_ZONE_NAME: '',
  });
  assert.match(out, /^BASE_URL = "https:\/\/pages-cloudflare\.someone\.workers\.dev"$/m);
  assert.doesNotMatch(out, /\[\[routes\]\]/);
});

test('CLI writes the rendered file', () => {
  const result = runCli(OWN_DOMAIN);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(result.out, 'utf8'), renderWranglerConfig(TEMPLATE, OWN_DOMAIN));
});

const failures = [
  ['empty base url', { PAGES_BASE_URL: '' }, /Missing environment variables: PAGES_BASE_URL$/],
  ['missing database id', { PAGES_D1_DATABASE_ID: undefined }, /Missing environment variables: PAGES_D1_DATABASE_ID$/],
  ['route without zone', { PAGES_ZONE_NAME: '' }, /Missing environment variables: PAGES_ZONE_NAME$/],
  ['zone without route', { PAGES_ROUTE_PATTERN: '' }, /Missing environment variables: PAGES_ROUTE_PATTERN$/],
  ['own domain without route', { PAGES_ROUTE_PATTERN: '', PAGES_ZONE_NAME: '' }, /PAGES_ROUTE_PATTERN, PAGES_ZONE_NAME/],
  ['trailing slash', { PAGES_BASE_URL: 'https://docs.example.com/' }, /PAGES_BASE_URL must not end with \//],
];

for (const [name, override, message] of failures) {
  test(`CLI fails on ${name}`, () => {
    const env = { ...OWN_DOMAIN, ...override };
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    const result = runCli(env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.trim(), message);
    assert.equal(result.stderr.trim().split('\n').length, 1);
  });
}

test('fails when a placeholder is missing from the template', () => {
  const broken = TEMPLATE.replace('database_id = "00000000-0000-0000-0000-000000000000"', 'database_id = "x"');
  assert.throws(() => renderWranglerConfig(broken, OWN_DOMAIN), /placeholder for PAGES_D1_DATABASE_ID/);
});
