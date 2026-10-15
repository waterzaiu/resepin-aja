// Run: PLAYWRIGHT_MODULE=/absolute/path/to/playwright node test_frontend_browser.cjs
// Browser-only deterministic regressions; intercepted responses are test fixtures.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({headless:false, args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
  const failures = [];
  async function test(name, run) {
    const page = await browser.newPage();
    await page.route('**/api/inspirasi', r => r.fulfill({json:{recipes:[]}}));
    await page.goto(process.env.BASE_URL || 'http://localhost:8787');
    try { await run(page); console.log('PASS',name); } catch(e) { failures.push(name); console.log('FAIL', name, e.message); }
    await page.close();
  }
  await test('latest gallery search wins', async p => {
    await p.route('**/api/resep?*', async r => {
      const old = r.request().url().includes('old');
      if(old) await new Promise(r=>setTimeout(r,400));
      await r.fulfill({json:{recipes:[{nama:old?'OLD':'NEW',thumbnail:'https://example.com/a.jpg',url:'https://example.com/a'}]}});
    });
    await p.locator('#recipeQuery').fill('old'); await p.locator('#recipeQuery').press('Enter');
    await p.waitForTimeout(50);
    await p.locator('#recipeQuery').fill('new'); await p.locator('#recipeQuery').press('Enter');
    await p.waitForTimeout(650);
    assert.match(await p.locator('#recipeGallery').innerText(), /NEW/);
  });
  await test('camera tab exit restores empty preview', async p => {
    await p.locator('#cameraBtn').click();
    await p.waitForFunction(()=>document.querySelector('#cameraVideo').videoWidth > 0);
    await p.locator('#tabViral').click(); await p.locator('#tabScan').click();
    assert.equal(await p.locator('#previewEmpty').isVisible(),true);
    assert.equal(await p.locator('#submitBtn').isVisible(),false);
  });
  await test('camera playback failure restores empty preview', async p => {
    await p.evaluate(()=>{HTMLMediaElement.prototype.play=()=>Promise.reject(new Error('test playback failure'));});
    await p.locator('#cameraBtn').click(); await p.locator('#errorBox').waitFor({state:'visible'});
    assert.equal(await p.locator('#previewEmpty').isVisible(),true);
    assert.equal(await p.locator('#submitBtn').isVisible(),false);
  });
  await test('latest manual search wins', async p => {
    await p.route('**/api/recipes/match', async r => {
      const old = r.request().postDataJSON().ingredients[0] === 'old';
      if (old) await new Promise(r=>setTimeout(r,400));
      await r.fulfill({json:{recipes:[],ai_results:[{title:old?'OLD':'NEW'}]}});
    });
    await p.locator('#manualIngredients').fill('old'); await p.locator('#manualIngredients').press('Enter');
    await p.waitForTimeout(50);
    await p.locator('#manualIngredients').fill('new'); await p.locator('#manualIngredients').press('Enter');
    await p.waitForTimeout(650);
    assert.match(await p.locator('#manualResults').innerText(), /NEW/);
  });
  await test('invalid files, count and size limits, reset', async p => {
    const file = {name:'test.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=','base64')};
    await p.locator('#fileInput').setInputFiles({name:'bad.txt',mimeType:'text/plain',buffer:Buffer.from('bad')});
    assert.match(await p.locator('#errorMsg').innerText(), /JPG/);
    await p.locator('#fileInput').setInputFiles({...file,buffer:Buffer.alloc(4*1024*1024+1)});
    assert.match(await p.locator('#errorMsg').innerText(), /4 MB/);
    await p.locator('#fileInput').setInputFiles(Array(6).fill(file));
    assert.match(await p.locator('#errorMsg').innerText(), /Maksimal 5/);
    await p.locator('#fileInput').setInputFiles(Array(2).fill(file));
    assert.match(await p.locator('#photoCount').innerText(), /2\/5/);
    await p.locator('#clearBtn').click();
    assert.equal(await p.locator('#photoCount').innerText(),'');
    assert.equal(await p.locator('#previewEmpty').isVisible(),true);
    assert.equal(await p.locator('#submitBtn').isVisible(),false);
  });
  await browser.close();
  assert.deepEqual(failures, [], 'browser regressions');
})().catch(e=>{console.error(e);process.exitCode=1;});
