#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_PATH = join(REPO_ROOT, 'wrangler.toml');
const DEFAULT_OUT = join(REPO_ROOT, 'wrangler.deploy.toml');
const GENERATED_HEADER = '# Generated from wrangler.toml by scripts/render_wrangler_config.mjs. Do not commit.\n';

const PLACEHOLDERS = [
  ['PAGES_BASE_URL', 'BASE_URL = "https://pages.example.com"', (v) => `BASE_URL = ${JSON.stringify(v)}`],
  ['PAGES_D1_DATABASE_ID', 'database_id = "00000000-0000-0000-0000-000000000000"', (v) => `database_id = ${JSON.stringify(v)}`],
];

function readVar(env, name) {
  const value = (env[name] ?? '').trim();
  return value === '' ? null : value;
}

function readDeployValues(env) {
  const values = {
    PAGES_BASE_URL: readVar(env, 'PAGES_BASE_URL'),
    PAGES_D1_DATABASE_ID: readVar(env, 'PAGES_D1_DATABASE_ID'),
    PAGES_ROUTE_PATTERN: readVar(env, 'PAGES_ROUTE_PATTERN'),
    PAGES_ZONE_NAME: readVar(env, 'PAGES_ZONE_NAME'),
  };
  const missing = [];
  if (!values.PAGES_BASE_URL) missing.push('PAGES_BASE_URL');
  if (!values.PAGES_D1_DATABASE_ID) missing.push('PAGES_D1_DATABASE_ID');
  if (values.PAGES_ZONE_NAME && !values.PAGES_ROUTE_PATTERN) missing.push('PAGES_ROUTE_PATTERN');
  if (values.PAGES_ROUTE_PATTERN && !values.PAGES_ZONE_NAME) missing.push('PAGES_ZONE_NAME');
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);

  let host;
  try {
    host = new URL(values.PAGES_BASE_URL).hostname;
  } catch {
    throw new Error(`PAGES_BASE_URL is not a URL: ${values.PAGES_BASE_URL}`);
  }
  if (values.PAGES_BASE_URL.endsWith('/')) throw new Error('PAGES_BASE_URL must not end with /');
  if (!values.PAGES_ROUTE_PATTERN && !host.endsWith('.workers.dev')) {
    throw new Error('Missing environment variables: PAGES_ROUTE_PATTERN, PAGES_ZONE_NAME (required unless PAGES_BASE_URL is on workers.dev)');
  }
  return values;
}

export function renderWranglerConfig(template, env) {
  const values = readDeployValues(env);
  const lines = template.split('\n');
  for (const [name, placeholder, render] of PLACEHOLDERS) {
    const at = lines.flatMap((line, i) => (line === placeholder ? [i] : []));
    if (at.length !== 1) throw new Error(`wrangler.toml placeholder for ${name} not found exactly once: ${placeholder}`);
    lines[at[0]] = render(values[name]);
  }
  while (lines[0]?.startsWith('#')) lines.shift();

  let out = GENERATED_HEADER + lines.join('\n').trimEnd() + '\n';
  if (values.PAGES_ROUTE_PATTERN) {
    out += `\n[[routes]]\npattern = ${JSON.stringify(values.PAGES_ROUTE_PATTERN)}\nzone_name = ${JSON.stringify(values.PAGES_ZONE_NAME)}\ncustom_domain = true\n`;
  }
  return out;
}

function parseOut(argv) {
  if (argv.length === 0) return DEFAULT_OUT;
  if (argv.length === 2 && argv[0] === '--out') return resolve(argv[1]);
  throw new Error('Usage: node scripts/render_wrangler_config.mjs [--out <path>]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const out = parseOut(process.argv.slice(2));
    writeFileSync(out, renderWranglerConfig(readFileSync(TEMPLATE_PATH, 'utf8'), process.env));
    console.log(`Wrote ${out}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
