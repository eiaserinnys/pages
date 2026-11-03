import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import worker from '../src/worker.mjs';
import { createBucket, createDatabase, d1, seedBucket, seedDatabase } from './helpers/workerFixture.mjs';

const BASE_URL = 'https://pages.example.test';
const SECRET = 'worker-session-secret';
const EMAIL = 'tester@example.com';
const REDIRECT_URI = 'http://127.0.0.1:43127/callback';
const VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';

function fixture() {
  const database = createDatabase();
  const bucket = createBucket();
  seedDatabase(database);
  seedBucket(bucket);
  return {
    database,
    bucket,
    env: {
      PAGES_DB: d1(database),
      PAGES_BUCKET: bucket,
      PAGES_API_TOKEN: 'test-token',
      SESSION_SECRET: SECRET,
      BASE_URL,
      GOOGLE_CLIENT_ID: 'test-client',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      ALLOWED_EMAILS: EMAIL,
    },
  };
}

function sessionCookie(email = EMAIL) {
  const payload = Buffer.from(JSON.stringify({
    email,
    name: 'Test User',
    exp: Math.floor(Date.now() / 1000) + 60,
  })).toString('base64url');
  return `pages.session=${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
}

function signedToken(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function codeChallenge(verifier = VERIFIER) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function call(env, path, init = {}) {
  return worker.fetch(new Request(`${BASE_URL}${path}`, init), env, { waitUntil() {} });
}

async function registerClient(env, redirectUri = REDIRECT_URI) {
  const response = await call(env, '/auth/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Pages desktop',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function authorize(env, client, { cookie = sessionCookie(), state = 'random-state' } = {}) {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    state,
    code_challenge: codeChallenge(),
    code_challenge_method: 'S256',
    scope: 'openid profile',
    resource: 'https://pages.example.test',
  });
  return call(env, `/auth/oauth/authorize?${query}`, cookie ? { headers: { Cookie: cookie } } : {});
}

async function exchangeCode(env, client, code, verifier = VERIFIER) {
  return call(env, '/auth/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      redirect_uri: client.redirect_uris[0],
      code_verifier: verifier,
    }),
  });
}

test('OAuth discovery, loopback client registration, session authorize, PKCE exchange, replay, refresh, and allowlist', async () => {
  const { database, env } = fixture();
  const discovery = await call(env, '/.well-known/oauth-authorization-server');
  assert.equal(discovery.status, 200);
  assert.deepEqual(await discovery.json(), {
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/auth/oauth/authorize`,
    token_endpoint: `${BASE_URL}/auth/oauth/token`,
    registration_endpoint: `${BASE_URL}/auth/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  });

  const client = await registerClient(env);
  assert.equal(client.token_endpoint_auth_method, 'none');
  assert.deepEqual(client.redirect_uris, [REDIRECT_URI]);
  assert.deepEqual(client.grant_types, ['authorization_code', 'refresh_token']);

  for (const redirectUri of ['http://localhost:43127/callback', 'http://[::1]:43127/callback']) {
    assert.equal((await registerClient(env, redirectUri)).redirect_uris[0], redirectUri);
  }

  const outside = await call(env, '/auth/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://attacker.example/callback'] }),
  });
  assert.equal(outside.status, 400);
  assert.deepEqual(await outside.json(), { error: 'invalid_redirect_uri' });

  const unsupportedAuth = await call(env, '/auth/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'client_secret_basic' }),
  });
  assert.equal(unsupportedAuth.status, 400);
  assert.deepEqual(await unsupportedAuth.json(), { error: 'invalid_client_metadata' });

  const loginRequired = await authorize(env, client, { cookie: '' });
  assert.equal(loginRequired.status, 302);
  const loginUrl = new URL(loginRequired.headers.get('location'), BASE_URL);
  assert.equal(loginUrl.pathname, '/auth/google');
  const returnTo = new URL(loginUrl.searchParams.get('returnTo'), BASE_URL);
  assert.equal(returnTo.pathname, '/auth/oauth/authorize');
  assert.equal(returnTo.searchParams.get('client_id'), client.client_id);
  assert.equal(returnTo.searchParams.get('state'), 'random-state');
  assert.equal(returnTo.searchParams.get('code_challenge'), codeChallenge());
  assert.equal(returnTo.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(returnTo.searchParams.get('scope'), 'openid profile');
  assert.equal(returnTo.searchParams.get('resource'), BASE_URL);

  const unregisteredRedirect = await call(env, `/auth/oauth/authorize?${new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: 'http://127.0.0.1:43128/callback',
    state: 's', code_challenge: codeChallenge(), code_challenge_method: 'S256',
  })}`, { headers: { Cookie: sessionCookie() } });
  assert.equal(unregisteredRedirect.status, 400);
  assert.deepEqual(await unregisteredRedirect.json(), { error: 'invalid_redirect_uri' });

  const authorization = await authorize(env, client);
  assert.equal(authorization.status, 302);
  const callback = new URL(authorization.headers.get('location'));
  assert.equal(callback.origin, new URL(REDIRECT_URI).origin);
  assert.equal(callback.pathname, '/callback');
  assert.equal(callback.searchParams.get('state'), 'random-state');
  const code = callback.searchParams.get('code');
  assert.ok(code);

  const wrongVerifier = await exchangeCode(env, client, code, 'wrong-verifier');
  assert.equal(wrongVerifier.status, 400);
  assert.deepEqual(await wrongVerifier.json(), { error: 'invalid_grant' });

  const tokenResponse = await exchangeCode(env, client, code);
  assert.equal(tokenResponse.status, 200);
  assert.equal(tokenResponse.headers.get('cache-control'), 'no-store');
  const tokens = await tokenResponse.json();
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.expires_in, 3600);
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);

  const replay = await exchangeCode(env, client, code);
  assert.equal(replay.status, 400);
  assert.deepEqual(await replay.json(), { error: 'invalid_grant' });

  const refreshed = await call(env, '/auth/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token }),
  });
  assert.equal(refreshed.status, 200);
  const refreshedTokens = await refreshed.json();
  assert.ok(refreshedTokens.access_token);
  assert.ok(refreshedTokens.refresh_token);

  env.ALLOWED_EMAILS = 'other@example.com';
  const revoked = await call(env, '/auth/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token }),
  });
  assert.equal(revoked.status, 400);
  assert.deepEqual(await revoked.json(), { error: 'invalid_grant' });
  database.close();
});

test('OAuth Bearer protects management routes and provides private pages through signed view links', async () => {
  const { database, bucket, env } = fixture();
  const client = await registerClient(env);
  const authorization = await authorize(env, client);
  const code = new URL(authorization.headers.get('location')).searchParams.get('code');
  const tokensResponse = await exchangeCode(env, client, code);
  const tokens = await tokensResponse.json();
  const headers = { Authorization: `Bearer ${tokens.access_token}` };

  const listResponse = await call(env, '/api/dashboard/pages', { headers });
  assert.equal(listResponse.status, 200);
  const pages = await listResponse.json();
  const privatePage = pages.items.find((item) => item.id === 'ddd444ddd444');
  assert.match(privatePage.viewUrl, /^https:\/\/pages\.example\.test\/v\//);
  const publicPage = pages.items.find((item) => item.id === 'ccc333ccc333');
  assert.equal(publicPage.viewUrl, publicPage.url);

  const documents = await (await call(env, '/api/dashboard/documents', { headers })).json();
  const privateDocument = documents.items.find((item) => item.slug === 'alpha-doc');
  assert.match(privateDocument.viewUrl, /^https:\/\/pages\.example\.test\/v\//);
  const documentDetail = await call(env, '/api/dashboard/documents/alpha-doc', { headers });
  assert.equal(documentDetail.status, 200);
  const documentJson = await documentDetail.json();
  assert.match(documentJson.viewUrl, /^https:\/\/pages\.example\.test\/v\//);
  assert.equal(documentJson.url, `${BASE_URL}/d/alpha-doc/`);
  assert.equal('viewUrl' in documentJson.revisions[0], false);
  const documentView = await call(env, new URL(documentJson.viewUrl).pathname);
  assert.equal(documentView.status, 200);
  assert.match(await documentView.text(), /Alpha OG/);
  const pageDetail = await call(env, '/api/dashboard/pages/ddd444ddd444', { headers });
  assert.equal(pageDetail.status, 200);
  assert.match((await pageDetail.json()).viewUrl, /^https:\/\/pages\.example\.test\/v\//);

  const publicDocument = documents.items.find((item) => item.slug === 'percent-doc');
  assert.equal(publicDocument.viewUrl, publicDocument.url);

  const altered = tokens.access_token.slice(0, -1) + (tokens.access_token.endsWith('a') ? 'b' : 'a');
  const badBearer = await call(env, '/api/dashboard/pages', {
    headers: { Authorization: `Bearer ${altered}`, Cookie: sessionCookie() },
  });
  assert.equal(badBearer.status, 401);
  assert.deepEqual(await badBearer.json(), { error: 'invalid_token' });
  assert.equal(badBearer.headers.get('www-authenticate'), 'Bearer error="invalid_token"');

  const expired = signedToken({ typ: 'pages.oauth_access', email: EMAIL, exp: Math.floor(Date.now() / 1000) - 1 });
  const expiredBearer = await call(env, '/api/dashboard/pages', { headers: { Authorization: `Bearer ${expired}` } });
  assert.equal(expiredBearer.status, 401);
  assert.equal(expiredBearer.headers.get('www-authenticate'), 'Bearer error="invalid_token"');

  const makePrivate = await call(env, '/api/pages/ccc333ccc333/visibility', {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ private: true }),
  });
  assert.equal(makePrivate.status, 200);
  const documentVisibility = await call(env, '/api/dashboard/documents/alpha-doc/visibility', {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ private: false }),
  });
  assert.equal(documentVisibility.status, 200);
  assert.equal((await documentVisibility.json()).private, false);
  const deleteResponse = await call(env, '/api/pages/ddd444ddd444', { method: 'DELETE', headers });
  assert.equal(deleteResponse.status, 204);

  bucket.putJson('pages/ccc333ccc333.json', { id: 'ccc333ccc333', private: true, reviewable: true });
  const privateList = await (await call(env, '/api/dashboard/pages', { headers })).json();
  const linkedPage = privateList.items.find((item) => item.id === 'ccc333ccc333');
  const view = new URL(linkedPage.viewUrl);
  assert.match(view.pathname, /^\/v\//);
  const token = view.pathname.split('/')[2];
  const pageResponse = await call(env, view.pathname);
  assert.equal(pageResponse.status, 200);
  assert.equal(pageResponse.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(pageResponse.headers.get('cache-control'), 'private, no-store');
  assert.equal(pageResponse.headers.get('x-robots-tag'), 'noindex');
  const reviewHtml = await pageResponse.text();
  assert.match(reviewHtml, /댓글 남기기/);
  const capabilityToken = JSON.parse(reviewHtml.match(/window\.__PAGES_REVIEW__=(.*?);/)[1]).capabilityToken;
  const annotationResponse = await call(env, '/api/annotations/ccc333ccc333', {
    headers: { 'X-Pages-Annotation-Token': capabilityToken },
  });
  assert.equal(annotationResponse.status, 200);
  const annotationWrite = await call(env, '/api/annotations/ccc333ccc333', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pages-Annotation-Token': capabilityToken },
    body: JSON.stringify({ id: 'view-link-comment', comment: 'A note from the private view' }),
  });
  assert.equal(annotationWrite.status, 201);

  const assetResponse = await call(env, `/v/${token}/chart.svg?download=1`);
  assert.equal(assetResponse.status, 200);
  assert.equal(await assetResponse.text(), '<svg></svg>');
  const slashRedirect = await call(env, `/v/${token}?mode=print`);
  assert.equal(slashRedirect.status, 302);
  assert.equal(slashRedirect.headers.get('location'), `/v/${token}/?mode=print`);

  const expiredView = signedToken({ typ: 'pages.view', rev: 'ccc333ccc333', exp: Math.floor(Date.now() / 1000) - 1 });
  const expiredViewResponse = await call(env, `/v/${expiredView}/`);
  assert.equal(expiredViewResponse.status, 410);
  assert.match(await expiredViewResponse.text(), /열람 링크가 만료되었습니다/);

  const tamperedView = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  assert.equal((await call(env, `/v/${tamperedView}/`)).status, 404);
  database.close();
});
