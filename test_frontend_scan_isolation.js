// Offline request-level regression: actual client code, mocked DOM and AI transport.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const script = fs.readFileSync('resep-in-aja.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function setup() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {classList:{add(){},remove(){},toggle(){}},style:{},lastChild:{textContent:''},value:'',innerHTML:'',textContent:'',addEventListener(){},scrollIntoView(){}});
    return elements.get(id);
  }
  const calls = [];
  const pending = [];
  const context = vm.createContext({document:{getElementById:element},window:{addEventListener(){}},navigator:{},URL,FormData,AbortController,console,
    fetch:async (url, options) => {
      if (url !== '/api/scan-resep') return {ok:true,json:async()=>({recipes:[]})};
      calls.push(options.body);
      return new Promise(resolve => pending.push(resolve));
    }});
  vm.runInContext(script, context);
  const run = code => vm.runInContext(code, context);
  const select = name => {context.file = new Blob([name],{type:'image/png'}); context.file.name=name; run('handleFileSelect([file])');};
  const finish = (index, title) => pending[index]({ok:true,json:async()=>({recipe:{namaMasakan:title,bahanTerdeteksi:[title],bahanKurang:[],langkah:[],menuAlternatif:[]}})});
  return {run,select,finish,calls,element};
}
(async()=>{
  const s=setup();
  s.select('ayam'); s.select('bawang');
  const first=s.run('handleSubmit()');
  assert.equal(s.calls[0].getAll('image').length,2,'pre-scan uploads remain additive');
  s.finish(0,'ayam'); await first;
  s.select('telur');
  const second=s.run('handleSubmit()');
  assert.equal(s.calls[1].getAll('image').length,1,'second scan must not send previous photos');
  assert.equal(await s.calls[1].get('image').text(),'telur');
  s.finish(1,'telur'); await second;
  console.log('PASS: sequential scans isolate photos; pre-scan multi-upload preserved');
  const r=setup(); r.select('old'); const old=r.run('handleSubmit()');
  r.select('new');
  const fresh=r.run('handleSubmit()');
  assert.equal(r.calls.length,2,'replacement must permit a new scan immediately');
  r.finish(1,'NEW'); await fresh;
  r.finish(0,'OLD'); await old;
  assert(r.element('resultContainer').innerHTML.includes('NEW'),'stale response cannot overwrite new scan');
  assert(!r.element('resultContainer').innerHTML.includes('OLD'));
  console.log('PASS: replacing input cancels old scan and ignores late response');
})().catch(error=>{console.error(error);process.exitCode=1;});
