import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.mjs';
import { createDatabase, createBucket, d1, seedDatabase, seedBucket } from './helpers/workerFixture.mjs';

async function fixture(t) {
  const db = createDatabase(); t.after(() => db.close());
  const bucket = createBucket(); seedDatabase(db); seedBucket(bucket);
  const env = { PAGES_DB:d1(db), PAGES_BUCKET:bucket, PAGES_API_TOKEN:'token', SESSION_SECRET:'secret',
    BASE_URL:'https://pages.example.test', GOOGLE_CLIENT_ID:'client', GOOGLE_CLIENT_SECRET:'secret', ALLOWED_EMAILS:'tester@example.com' };
  bucket.putJson('pages/aaa111aaa111.json',{id:'aaa111aaa111',reviewable:true});
  const call = (path, options) => worker.fetch(new Request(env.BASE_URL+path,options),env,{waitUntil(){}});
  const html = await (await call('/p/aaa111aaa111/')).text();
  const config = JSON.parse(html.match(/window\.__PAGES_REVIEW__=(.*?);/)[1]);
  const headers = {'Content-Type':'application/json',[config.tokenHeader]:config.capabilityToken};
  const endpoint = '/api/annotations/aaa111aaa111';
  const post = (body,path=endpoint,extra={}) => call(path,{method:'POST',headers,body:JSON.stringify(body),...extra});
  return {db,bucket,call,post,endpoint,config};
}

test('inline anchors preserve position, context and asset identity instead of quote-only storage', async t => {
  const {db,post,call,endpoint,config} = await fixture(t);
  const note = {id:'anchored-note',comment:'Check this',author:'Writer',selected_text:'repeat',
    block_id:'second',prefix:'second ',suffix:' context',asset_path:'index.html',text_position:{start:100,end:106}};
  assert.equal((await post(note)).status,201);
  const saved = (await (await call(endpoint)).json()).comments.find(c=>c.id===note.id);
  for (const key of ['selected_text','block_id','prefix','suffix','asset_path','text_position']) assert.deepEqual(saved[key],note[key],key);
  const anchor = JSON.parse(db.prepare('SELECT anchor FROM comments WHERE comment_id=?').get(note.id).anchor);
  assert.deepEqual(anchor.text_position,note.text_position);
  assert.equal(anchor.asset_path,'index.html');
  assert.equal(config.assetPath,'index.html');
  assert.equal((await post(note)).status,200);
  assert.equal((await post({...note,text_position:{start:200,end:206}})).status,409);
  for (const text_position of [{start:-1,end:5},{start:1,end:1},{start:0,end:7},{start:'0',end:6}]) {
    assert.equal((await post({...note,id:'invalid',text_position})).status,400);
  }
  assert.equal((await post({...note,id:'unsafe',asset_path:'../frame.html'})).status,400);
});

test('thread replies append atomically, remain idempotent and preserve the original anchor', async t => {
  const {post,call,endpoint,bucket} = await fixture(t);
  await post({id:'thread',comment:'Original',selected_text:'repeat',prefix:'second ',suffix:' context'});
  const url = endpoint+'/thread/replies';
  const replies = [{id:'reply-a',comment:'First reply'},{id:'reply-b',comment:'Second reply'}];
  assert.equal((await post(replies[0],url,{headers:{}})).status,401);
  const responses = await Promise.all(replies.map(reply=>post(reply,url)));
  assert.deepEqual(responses.map(r=>r.status),[201,201]);
  assert.equal((await post(replies[0],url)).status,200);
  assert.equal((await post({...replies[0],comment:'Overwrite'},url)).status,409);
  assert.equal((await post({id:'empty',comment:' '},url)).status,400);
  assert.equal((await post(replies[0],endpoint+'/missing/replies')).status,404);
  const saved = (await (await call(endpoint)).json()).comments.find(c=>c.id==='thread');
  assert.equal(saved.comment,'Original'); assert.equal(saved.prefix,'second ');
  assert.deepEqual(saved.replies.map(r=>r.comment),['First reply','Second reply']);
  bucket.putJson('pages/aaa111aaa111.json',{id:'aaa111aaa111',reviewable:true,private:true});
  assert.equal((await post({id:'private',comment:'No'},url)).status,401);
});
