import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto as crypto } from 'node:crypto';
import test from 'node:test';

const CLI = new URL('../scripts/build-encrypted-page.mjs', import.meta.url).pathname;
const PASSWORD = 'made-up-builder-password';
const DATA = { title: 'short', lines: ['a distinctly long line of fake script text', 7, { inner: 'another fake long value' }] };
const SHELL = `<html><head><title>shell</title></head><body>
<script id="encrypted-payload" type="application/json"></script>
<script id="pages-doc-state-client"></script>
</body></html>`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'build-page-'));
  const file = (name, content) => { writeFileSync(join(dir, name), content); return join(dir, name); };
  return { dir, file, path: (name) => join(dir, name) };
}

function run(args, env = { PW: PASSWORD }) {
  return spawnSync(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
}

function scriptJson(html, id) {
  const match = html.match(new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)</script>`));
  return match ? JSON.parse(match[1]) : null;
}

async function decrypt(payload, password) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: Buffer.from(payload.salt, 'base64'), iterations: payload.iter },
    material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(payload.iv, 'base64') }, key, Buffer.from(payload.ct, 'base64'));
  return JSON.parse(new TextDecoder().decode(plain));
}

test('builder encrypts the data, writes a state marker, and inlines the client', { timeout: 120_000 }, async () => {
  const s = setup();
  const args = ['--shell', s.file('shell.html', SHELL), '--data', s.file('data.json', JSON.stringify(DATA)),
    '--out', s.path('out.html'), '--password-env', 'PW', '--state', '--iter', '10000'];
  const result = run(args);
  assert.equal(result.status, 0, result.stderr);
  const html = readFileSync(s.path('out.html'), 'utf8');

  const payload = scriptJson(html, 'encrypted-payload');
  assert.equal(payload.v, 1);
  assert.equal(payload.iter, 10000);
  assert.deepEqual(await decrypt(payload, PASSWORD), DATA);
  await assert.rejects(decrypt(payload, 'another made-up password'));

  const marker = scriptJson(html, 'pages-doc-state');
  assert.equal(marker.v, 1);
  assert.match(marker.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(html.indexOf('id="pages-doc-state"') < html.indexOf('</head>'), 'marker is inserted before </head>');
  assert.ok(html.includes('globalThis.PagesDocState'), 'client is inlined');
  assert.ok(!html.includes('a distinctly long line'));

  const second = run(args.map((a) => (a === s.path('out.html') ? s.path('out2.html') : a)));
  assert.equal(second.status, 0, second.stderr);
  const marker2 = scriptJson(readFileSync(s.path('out2.html'), 'utf8'), 'pages-doc-state');
  assert.notEqual(marker2.salt, marker.salt, 'without --state-from a new salt is used');
});

test('--state-from keeps the salt, rejects a different password', { timeout: 120_000 }, () => {
  const s = setup();
  const base = ['--shell', s.file('shell.html', SHELL), '--data', s.file('data.json', JSON.stringify(DATA)),
    '--password-env', 'PW', '--iter', '10000'];
  assert.equal(run([...base, '--out', s.path('v1.html'), '--state']).status, 0);
  const v1 = scriptJson(readFileSync(s.path('v1.html'), 'utf8'), 'pages-doc-state');

  const again = run([...base, '--out', s.path('v2.html'), '--state-from', s.path('v1.html')]);
  assert.equal(again.status, 0, again.stderr);
  const v2 = scriptJson(readFileSync(s.path('v2.html'), 'utf8'), 'pages-doc-state');
  assert.deepEqual(v2, v1);

  const wrong = run([...base, '--out', s.path('v3.html'), '--state-from', s.path('v1.html')], { PW: 'a different made-up password' });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /state-from/);
});

test('builder fails without the payload element, without the password, and on plaintext leaks', { timeout: 120_000 }, () => {
  const s = setup();
  const data = s.file('data.json', JSON.stringify(DATA));
  const common = (shell) => ['--shell', s.file(shell.name, shell.html), '--data', data, '--out', s.path('o.html'), '--password-env', 'PW', '--iter', '10000'];

  const noPayload = run(common({ name: 'a.html', html: '<html><head></head></html>' }));
  assert.notEqual(noPayload.status, 0);
  assert.match(noPayload.stderr, /encrypted-payload/);

  const noPassword = run(common({ name: 'b.html', html: SHELL }), {});
  assert.notEqual(noPassword.status, 0);

  const leaky = run(common({ name: 'c.html', html: `${SHELL}<p>a distinctly long line of fake script text</p>` }));
  assert.notEqual(leaky.status, 0);
  assert.match(leaky.stderr, /plaintext leak/);

  const positional = run(['--shell', s.path('a.html'), '--data', data, '--out', s.path('o.html'), '--password', PASSWORD]);
  assert.notEqual(positional.status, 0);
});
