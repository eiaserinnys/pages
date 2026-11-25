#!/usr/bin/env node
// Builds a password-locked page from an HTML shell and a JSON data file.
// Usage: see docs/document-state.md. Dependency-free; the password comes from an environment variable only.
import { readFileSync, writeFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLIENT_PATH = fileURLToPath(new URL('../client/pagesDocState.js', import.meta.url));
const DEFAULT_ITER = 120000;
const MIN_LEAK_LENGTH = 8;

const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');
const toBase64Url = (bytes) => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function scriptRe(id) {
  return new RegExp(`(<script\\b[^>]*\\bid\\s*=\\s*["']${id}["'][^>]*>)([\\s\\S]*?)(</script\\s*>)`, 'i');
}

async function deriveBits(password, saltBytes, iter, bitLength) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: iter },
    material,
    bitLength,
  ));
}

async function encryptPayload(password, plaintext, iter) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bits = await deriveBits(password, salt, iter, 256);
  const key = await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)));
  return { v: 1, iter, salt: toBase64(salt), iv: toBase64(iv), ct: toBase64(ct) };
}

async function stateVerifier(password, saltBase64, iter) {
  const bits = await deriveBits(password, Buffer.from(saltBase64, 'base64'), iter, 512);
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bits.slice(32, 64))));
}

function readMarker(html, label) {
  const match = html.match(scriptRe('pages-doc-state'));
  if (!match) throw new Error(`${label}: pages-doc-state marker not found`);
  const config = JSON.parse(match[2]);
  if (config.v !== 1 || !config.salt || !Number.isInteger(config.iter) || !config.verifier) {
    throw new Error(`${label}: pages-doc-state marker is malformed`);
  }
  return config;
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') {
    if (value.length >= MIN_LEAK_LENGTH) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

async function buildEncryptedPage({ shell, data, password, state = false, stateFrom = null, iter = DEFAULT_ITER }) {
  if (!password) throw new Error('password is empty');
  if (!Number.isInteger(iter) || iter < 10000 || iter > 1000000) throw new Error('iter must be an integer between 10000 and 1000000');
  const payloadMatch = shell.match(scriptRe('encrypted-payload'));
  if (!payloadMatch) throw new Error('shell has no <script id="encrypted-payload"> element');

  const payload = await encryptPayload(password, JSON.stringify(data), iter);
  const fill = (html, id, content) => html.replace(scriptRe(id), (_, open, _old, close) => `${open}${content}${close}`);
  let html = fill(shell, 'encrypted-payload', JSON.stringify(payload));

  if (state || stateFrom) {
    let salt;
    let stateIter = iter;
    if (stateFrom) {
      const previous = readMarker(stateFrom, 'state-from');
      salt = previous.salt;
      stateIter = previous.iter;
    } else {
      salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
    }
    const verifier = await stateVerifier(password, salt, stateIter);
    if (stateFrom && verifier !== readMarker(stateFrom, 'state-from').verifier) {
      throw new Error('password does not match the state-from marker; republishing would wipe the server state');
    }
    const marker = JSON.stringify({ v: 1, iter: stateIter, salt, verifier });
    if (scriptRe('pages-doc-state').test(html)) {
      html = fill(html, 'pages-doc-state', marker);
    } else {
      const tag = `<script type="application/json" id="pages-doc-state">${marker}</script>\n`;
      if (!/<\/head>/i.test(html)) throw new Error('shell has no </head> to insert the pages-doc-state marker before');
      html = html.replace(/<\/head>/i, (head) => `${tag}${head}`);
    }
  }

  if (scriptRe('pages-doc-state-client').test(html)) {
    html = fill(html, 'pages-doc-state-client', `\n${readFileSync(CLIENT_PATH, 'utf8')}\n`);
  }

  for (const secret of collectStrings(data)) {
    if (html.includes(secret)) throw new Error('plaintext leak: a data string value appears in the output');
  }
  return html;
}

function parseArgs(argv) {
  const args = { state: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--state') args.state = true;
    else if (['--shell', '--data', '--out', '--password-env', '--state-from', '--iter'].includes(flag)) {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      args[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  for (const required of ['shell', 'data', 'out', 'passwordEnv']) {
    if (!args[required]) throw new Error(`missing --${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  return args;
}

async function main(argv, env) {
  const args = parseArgs(argv);
  const password = env[args.passwordEnv];
  if (!password) throw new Error(`environment variable ${args.passwordEnv} is empty or not set`);
  const html = await buildEncryptedPage({
    shell: readFileSync(args.shell, 'utf8'),
    data: JSON.parse(readFileSync(args.data, 'utf8')),
    password,
    state: args.state,
    stateFrom: args.stateFrom ? readFileSync(args.stateFrom, 'utf8') : null,
    iter: args.iter === undefined ? DEFAULT_ITER : Number(args.iter),
  });
  writeFileSync(args.out, html);
  console.log(`wrote ${args.out} (${Buffer.byteLength(html)} bytes)`);
}

export { buildEncryptedPage, stateVerifier };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
