import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import worker from '../src/worker.mjs';
import { createVtuberLiveSession } from '../src/vtuberLive.mjs';

const env = { BASE_URL: 'https://pages.test', ALLOWED_EMAILS: 'owner@test', VTUBER_OPENAI_API_KEY: 'server-only-test-key' };
const user = { email: 'owner@test' };
const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const request = (body = { sdp }, origin = env.BASE_URL) => new Request(env.BASE_URL + '/api/vtuber-live/session', {
  method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('unauthenticated, disallowed user and cross-origin requests never reach OpenAI', async () => {
  const never = () => assert.fail('unexpected billable request');
  assert.equal((await createVtuberLiveSession(request(), env, null, never)).status, 401);
  assert.equal((await createVtuberLiveSession(request(), env, { email: 'other@test' }, never)).status, 401);
  assert.equal((await createVtuberLiveSession(request({}, 'https://other.test'), env, user, never)).status, 403);
});

test('rejects malformed, oversized and unconfigured requests before billing', async () => {
  const never = () => assert.fail('unexpected billable request');
  assert.equal((await createVtuberLiveSession(request({ sdp: 'bad' }), env, user, never)).status, 400);
  assert.equal((await createVtuberLiveSession(request({ sdp: 'x'.repeat(65537) }), env, user, never)).status, 413);
  assert.equal((await createVtuberLiveSession(request(), { ...env, VTUBER_OPENAI_API_KEY: '' }, user, never)).status, 503);
});

test('uses server-owned model and voice, preserves opaque session ID and suppresses duplicate starts', async () => {
  let calls = 0;
  const upstream = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/live/sessions');
    const sent = JSON.parse(init.body);
    assert.equal(sent.session.model, 'gpt-live-1');
    assert.equal(sent.session.audio.output.voice, 'quartz');
    assert.equal(sent.session.delegation.responses.model, 'gpt-5.6-luna');
    assert.equal(sent.transport.sdp, sdp);
    assert.equal(init.headers.Authorization, 'Bearer server-only-test-key');
    return Response.json({ session: { id: 'opaque_123', secret: 'must-not-return' }, transport: { sdp: 'answer' }, extra: 'ignored' }, { status: 201 });
  };
  const response = await createVtuberLiveSession(request({ sdp, model: 'arbitrary-model', instructions: 'override' }), env, user, upstream);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { session: { id: 'opaque_123' }, transport: { type: 'webrtc', sdp: 'answer' } });
  assert.equal((await createVtuberLiveSession(request(), env, user, upstream)).status, 429);
  assert.equal(calls, 1);
});

test('worker rejects missing or forged session cookies before upstream', async () => {
  const workerEnv = { ...env, SESSION_SECRET: 'test-session', PAGES_API_TOKEN: 'test', GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', PAGES_DB: {}, PAGES_BUCKET: {} };
  assert.equal((await worker.fetch(request(), workerEnv, {})).status, 401);
  const forged = request(); forged.headers.set('cookie', 'pages.session=forged.invalid');
  assert.equal((await worker.fetch(forged, workerEnv, {})).status, 401);
  const payload = Buffer.from(JSON.stringify({ email: user.email, exp: Math.floor(Date.now()/1000)+60 })).toString('base64url');
  const signature = createHmac('sha256', workerEnv.SESSION_SECRET).update(payload).digest('base64url');
  const authed = request({}, 'https://untrusted.test'); authed.headers.set('cookie', `pages.session=${payload}.${signature}`);
  assert.equal((await worker.fetch(authed, workerEnv, {})).status, 403);
});
