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
bucket.putText('pages/aaa111aaa111.html', '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>button{display:none}section{position:absolute}</style></head><body><h1>Review this sentence</h1></body></html>');
const browser = await chromium.launch({headless:true});
try {
  for (const viewport of [{width:1280,height:900},{width:390,height:844}]) {
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
    assert.equal(await page.locator('#pages-review #toggle').isVisible(),true);
    await page.locator('h1').evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);});
    await page.locator('#pages-review #toggle').click();
    await page.locator('#pages-review #messages li').first().waitFor();
    assert.equal(await page.locator('#pages-review #quote').textContent(),'Review this sentence');
    const text = `Browser ${viewport.width} <img src=x onerror=alert(1)>`;
    await page.locator('#pages-review #author').fill('검증');
    await page.locator('#pages-review #body').fill(text);
    failSave = true;
    await page.locator('#pages-review #submit').click();
    await page.locator('#pages-review #status').filter({hasText:'다시 시도'}).waitFor();
    assert.equal(await page.locator('#pages-review #body').inputValue(),text);
    failSave = false;
    await page.locator('#pages-review #submit').click();
    await page.locator('#pages-review #messages li').filter({hasText:text}).waitFor();
    assert.equal(await page.locator('#pages-review #messages img').count(),0);
    await page.reload();
    await page.locator('#pages-review #toggle').click();
    await page.locator('#pages-review #messages li').filter({hasText:text}).waitFor();
    const panel = await page.locator('#pages-review #panel').boundingBox();
    assert.ok(panel.x >= 0 && panel.x + panel.width <= viewport.width);
    await page.locator('#pages-review #body').press('Escape');
    assert.equal(await page.locator('#pages-review #panel').isVisible(),false);
    assert.deepEqual(errors,[]);
    console.log(`PASS ${viewport.width}: open, quote, failed-save draft, save, reload, XSS text, bounds, Escape`);
    await context.close();
  }
} finally { await browser.close(); database.close(); }
