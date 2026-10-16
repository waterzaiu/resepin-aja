// Offline regression of the real inline client: failed scans preserve photos and offer manual recovery.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, 'resep-in-aja.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function setup(response) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set(['hidden']);
      elements.set(id, {classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),toggle(){},contains:c=>classes.has(c)},style:{},lastChild:{textContent:''},value:'',innerHTML:'',textContent:'',handlers:{},addEventListener(type,fn){this.handlers[type]=fn;},scrollIntoView(){this.scrolled=true;},focus(){this.focused=true;}});
    }
    return elements.get(id);
  }
  const calls = [];
  const context = vm.createContext({document:{getElementById:element},window:{addEventListener(){}},navigator:{},URL,FormData,AbortController,console:{error(){}},fetch:async(url,options)=>{
    if(url !== '/api/scan-resep') return {ok:true,json:async()=>({recipes:[]})};
    calls.push(options.body);
    return response();
  }});
  vm.runInContext(script, context);
  const run = code=>vm.runInContext(code,context);
  context.photos = ['photo-one','photo-two','photo-three'].map(name=>{const blob=new Blob([name],{type:'image/png'});blob.name=name;return blob;});
  run('handleFileSelect(photos)');
  element('manualIngredients').value='tempe, cabai';
  return {run,element,calls};
}
(async()=>{
  for (const [name,response] of [
    ['provider failure',async()=>({ok:false,status:503,json:async()=>({error:'Semua provider AI gagal.'})})],
    ['invalid image',async()=>({ok:false,status:400,json:async()=>({error:'Format gambar tidak didukung.'})})],
    ['network failure',async()=>{throw new TypeError('Failed to fetch');}],
    ['non-JSON failure',async()=>({ok:false,status:502,json:async()=>{throw new SyntaxError('Unexpected token <');}})],
  ]) {
    const s=setup(response);
    await s.run('handleSubmit()');
    assert(!s.element('errorBox').classList.contains('hidden'),name);
    assert(!s.element('scanManualLink').classList.contains('hidden'),`${name}: manual recovery must be visible`);
    assert.match(html, /id="scanManualLink"[^>]*href="#manualIngredients"/);
    assert.match(html, /id="manualIngredients"[^>]*type="text"/);
    s.element('scanManualLink').handlers.click();
    assert(s.element('manualIngredients').focused,'manual recovery focuses existing input');
    assert.equal(s.element('manualIngredients').value,'tempe, cabai');
    const message=s.element('errorMsg').textContent;
    assert.match(message,/coba lagi/i);
    assert.match(message,/manual/i);
    assert(!/server\.py|Unexpected token|Failed to fetch/.test(message),'no deployment-specific or raw transport advice');
    if(name==='invalid image') assert.match(message,/Format gambar tidak didukung/);
    assert.equal(s.run('imageFiles.length'),3,'failed scan retains all selected photos');
    assert.equal(s.element('resultContainer').innerHTML,'','failure must not fabricate ingredients or recipes');
    assert(!s.element('submitBtn').classList.contains('hidden'));
    assert.equal(s.element('uploadBtn').disabled,false);
    await s.element('retryBtn').handlers.click();
    assert.equal(s.calls.length,2,'retry sends another scan');
    for(let i=0;i<3;i++) assert.equal(await s.calls[0].getAll('image')[i].text(),await s.calls[1].getAll('image')[i].text(),'retry keeps the same photos');
    s.run("showError('Pilih foto terlebih dahulu.')");
    assert(s.element('scanManualLink').classList.contains('hidden'),'generic validation must not retain scan recovery state');
    console.log(`PASS: ${name}: manual recovery, accurate error, retained photos and retry`);
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
