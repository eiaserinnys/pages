import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const { default: worker } = await import(process.env.REVIEW_WORKER_MODULE || '../src/worker.mjs');
import { createDatabase, createBucket, d1, seedDatabase, seedBucket } from '../test/helpers/workerFixture.mjs';

// Browser requests exercise the real Worker and SQLite through the D1 adapter.
const database = createDatabase();
const bucket = createBucket();
seedDatabase(database); seedBucket(bucket);
const env = { PAGES_DB: d1(database), PAGES_BUCKET: bucket, PAGES_API_TOKEN: 'test-token',
  SESSION_SECRET: 'secret', BASE_URL: 'https://pages.example.test', GOOGLE_CLIENT_ID: 'client',
  GOOGLE_CLIENT_SECRET: 'secret', ALLOWED_EMAILS: 'tester@example.com' };
bucket.putJson('pages/aaa111aaa111.json', {id:'aaa111aaa111',reviewable:true});
bucket.putText('pages/aaa111aaa111.html', '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{padding:20px;font:18px/1.8 sans-serif}button{display:none}section{position:absolute}p{margin:30px 0}</style></head><body><h1>Inline review</h1><p id="first">First context: <strong>Repeated</strong> phrase. Ending one.</p><p id="second">Second context: <strong>Repeated</strong> phrase. Ending two.</p></body></html>');
const browser = await chromium.launch({headless:true});
try {
  for (const viewport of [{width:1280,height:900},{width:390,height:844}]) {
    database.prepare('DELETE FROM comments').run();
    const context = await browser.newContext({viewport});
    let failSave = false;
    const errors = [];
    await context.route('https://pages.example.test/**', async route => {
      const req = route.request();
      if (failSave && req.method() === 'POST') return route.fulfill({status:503,body:'unavailable'});
      const response = await worker.fetch(new Request(req.url(), {method:req.method(),headers:req.headers(),body:req.postData() || undefined}),env,{waitUntil(){}});
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(env.BASE_URL + '/d/alpha-doc/');
    await page.locator('#pages-review #toggle').waitFor();
    // Real pointer drag spans a strong element and the following text node.
    const points=await page.locator('#second').evaluate(p=>{
      const r=document.createRange();r.setStart(p.querySelector('strong').firstChild,0);r.setEnd(p.querySelector('strong').firstChild,1);const a=r.getBoundingClientRect();
      r.setStart(p.querySelector('strong').nextSibling,7);r.setEnd(p.querySelector('strong').nextSibling,8);const b=r.getBoundingClientRect();
      return {x1:a.left+1,y1:a.top+a.height/2,x2:b.left+1,y2:b.top+b.height/2};
    });
    await page.mouse.move(points.x1,points.y1);await page.mouse.down();await page.mouse.move(points.x2,points.y2,{steps:20});await page.mouse.up();
    await page.locator('#pages-review #trigger').click();
    assert.equal(await page.locator('#pages-review #quote').textContent(),'Repeated phrase');
    const text = `Browser ${viewport.width} <img src=x onerror=alert(1)>`;
    await page.locator('#pages-review #author').fill('검증');
    await page.locator('#pages-review #body').fill(text);
    assert.ok(await page.locator('#pages-review .draft').count()>0);
    failSave = true;
    await page.locator('#pages-review #submit').click();
    await page.locator('#pages-review #status').filter({hasText:'다시 시도'}).waitFor();
    assert.equal(await page.locator('#pages-review #body').inputValue(),text);
    assert.equal(await page.locator('#pages-review #quote').textContent(),'Repeated phrase');
    failSave = false;
    await page.locator('#pages-review #submit').click();
    await page.locator('#pages-review #messages li').filter({hasText:text}).waitFor();
    assert.equal(await page.locator('#pages-review #messages img').count(),0);
    await page.locator('#pages-review #body').fill('Reply '+viewport.width);
    await page.locator('#pages-review #submit').click();
    await page.locator('#pages-review #messages li').filter({hasText:'Reply '+viewport.width}).waitFor();
    await page.reload();
    await page.locator('#pages-review .marker').first().waitFor();
    const highlights=await page.locator('#pages-review .highlight').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().top));
    const second=await page.locator('#second').boundingBox(),first=await page.locator('#first').boundingBox();
    assert.ok(highlights.every(top=>top>=second.y && top<second.y+second.height));
    assert.ok(highlights.every(top=>top>first.y+first.height));
    await page.locator('#pages-review .marker').last().click();
    await page.locator('#pages-review #messages li').filter({hasText:text}).waitFor();
    await page.locator('#pages-review #messages li').filter({hasText:'Reply '+viewport.width}).waitFor();
    const panel = await page.locator('#pages-review #panel').boundingBox();
    assert.ok(panel.x >= 0 && panel.x + panel.width <= viewport.width);
    await page.locator('#pages-review #body').press('Escape');
    assert.equal(await page.locator('#pages-review #panel').isVisible(),false);
    await page.locator('#second strong').click();
    await page.locator('#pages-review #messages li').filter({hasText:text}).waitFor();
    await page.locator('#pages-review #close').click();
    await page.goto(env.BASE_URL+'/p/aaa111aaa111/');
    await page.locator('#pages-review .marker').waitFor();
    // Context resolves the exact occurrence even after text offsets shift.
    await page.locator('h1').evaluate(el=>el.prepend('Inserted text '));
    await page.waitForTimeout(100);
    assert.ok(await page.locator('#pages-review .highlight').count()>0);
    assert.equal(await page.locator('#second').textContent(),'Second context: Repeated phrase. Ending two.');
    assert.deepEqual(errors,[]);
    // Native keyboard select-all follows the same selectionchange path.
    await page.locator('#first').evaluate(el=>{el.tabIndex=0;el.focus();});
    await page.keyboard.press('Control+a');
    await page.locator('#pages-review #trigger').waitFor();
    // Wrapping and scrolling do not leave highlights outside the clipping box.
    await page.locator('#second').evaluate(el=>{getSelection().removeAllRanges();const wrapper=document.createElement('div');wrapper.id='scroller';wrapper.style.cssText='height:100px;overflow:auto;width:100%';el.before(wrapper);wrapper.append(el);const spacer=document.createElement('div');spacer.style.height='400px';wrapper.append(spacer);});
    await page.waitForTimeout(100);
    await page.locator('#scroller').evaluate(el=>el.scrollTop=200);
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#pages-review .highlight').count(),0);
    await page.locator('#scroller').evaluate(el=>el.scrollTop=0);
    await page.locator('#pages-review .highlight').first().waitFor();
    console.log(`PASS ${viewport.width}: pointer selection across nodes, anchored draft, failed-save retry, thread reply, reload at second occurrence, context fallback, XSS text, bounds, Escape`);
    await context.close();
  }
  // A bundled iframe gets its own anchor scope even when its text matches the parent.
  database.prepare('DELETE FROM comments').run();
  database.prepare('INSERT INTO revision_bundles (rev_id,entrypoint) VALUES (?,?)').run('aaa111aaa111','index.html');
  const assetInsert=database.prepare('INSERT INTO revision_assets (rev_id,path,bytes_key,content_type) VALUES (?,?,?,?)');
  for(const path of ['index.html','frame.html']) assetInsert.run('aaa111aaa111',path,'assets/inline/'+path,'text/html');
  bucket.putText('assets/inline/index.html','<html><body><p id="same">Same phrase</p><iframe src="frame.html" style="width:600px;height:400px"></iframe></body></html>');
  bucket.putText('assets/inline/frame.html','<html><body><p id="same">Same phrase</p></body></html>');
  const context=await browser.newContext();
  await context.route('https://pages.example.test/**',async route=>{const req=route.request();const response=await worker.fetch(new Request(req.url(),{method:req.method(),headers:req.headers(),body:req.postData() || undefined}),env,{waitUntil(){}});await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});});
  const page=await context.newPage();await page.goto(env.BASE_URL+'/d/alpha-doc/');
  const frame=page.frameLocator('iframe');await frame.locator('#pages-review #toggle').waitFor();
  await frame.locator('#same').evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(r);});
  await frame.locator('#pages-review #trigger').click();await frame.locator('#pages-review #body').fill('Frame thread');await frame.locator('#pages-review #submit').click();await frame.locator('#pages-review #messages').filter({hasText:'Frame thread'}).waitFor();
  await page.reload();await frame.locator('#pages-review .marker').waitFor();assert.equal(await page.locator('#pages-review .highlight').count(),0);
  const saved=JSON.parse(database.prepare('SELECT payload_json FROM comments').get().payload_json);assert.equal(saved.asset_path,'frame.html');
  await frame.locator('#pages-review .marker').click();await frame.locator('#pages-review #messages').filter({hasText:'Frame thread'}).waitFor();
  // Legacy duplicate quotes are listed as unresolved instead of picking the first match.
  bucket.putText('assets/inline/index.html','<html><body><p>Same phrase</p><p>Same phrase</p></body></html>');
  const legacy={id:'legacy',comment:'Legacy ambiguous',selected_text:'Same phrase',replies:[]};
  database.prepare('INSERT INTO comments VALUES (?,?,?,?,?,?,?,?,?)').run('legacy','aaa111aaa111','{}',legacy.comment,'tester','2026-09-09T00:00:00Z',0,JSON.stringify(legacy),'2026-09-09T00:00:00Z');
  await page.reload();await page.locator('#pages-review #toggle').filter({hasText:'2'}).waitFor();assert.equal(await page.locator('#pages-review .highlight').count(),0);
  await page.locator('#pages-review #toggle').click();await page.locator('#pages-review #messages li').filter({hasText:'Legacy ambiguous'}).locator('button').click();await page.locator('#pages-review #status').filter({hasText:'원문 위치를 확인할 수 없습니다'}).waitFor();
  console.log('PASS bundle iframe asset isolation and restoration; ambiguous legacy quote stays unresolved');
  await context.close();
} finally { await browser.close(); database.close(); }
