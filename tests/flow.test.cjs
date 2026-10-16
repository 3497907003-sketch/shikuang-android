const test = require('node:test'), assert = require('node:assert/strict');
const {fixture}=require('./helpers/app-fixture.cjs');

test('same specimen updates its saved record after retry, precision changes and crop edits',async()=>{
  const f=fixture();await f.photo();await f.click('predictBtn');await f.click('saveBtn');
  assert.equal(f.saved.size,1);const id=[...f.saved.keys()][0];
  f.node('precision').checked=false;f.node('precision').fire('change');await f.click('predictBtn');await f.click('saveBtn');
  f.node('cropRange').value='75';f.node('cropRange').fire('input');await f.click('predictBtn');await f.click('saveBtn');
  assert.equal(f.saved.size,1);assert.equal([...f.saved.keys()][0],id);
  f.node('notes').value='新的观察';f.node('notes').fire('input');await f.click('newSample');
  assert.equal(f.confirmations.length,1);assert.equal(f.saved.size,1);assert.equal(f.node('notes').value,'');assert.equal(f.node('preview').hidden,true);
  await f.photo();await f.click('predictBtn');await f.click('saveBtn');assert.equal(f.saved.size,2);
});

test('failed analysis keeps submitted photos and exposes a working retry',async()=>{
  const f=fixture();await f.photo();f.setError(new Error('资源读取失败'));await f.click('predictBtn');
  assert.equal(f.node('analysisRecovery').hidden,false);assert.equal(f.node('preview').hidden,false);assert.equal(f.node('predictBtn').disabled,false);
  f.setError(null);await f.click('retryAnalysis');assert.equal(f.node('analysisRecovery').hidden,true);assert.equal(f.node('result').hidden,false);
});

test('offline preparation can cancel a stalled service worker and restore retry controls',async()=>{
  const f=fixture({register:()=>new Promise(()=>{})});await f.click('offlineBtn');
  assert.equal(f.node('offlineBtn').disabled,true);assert.equal(f.node('cancelOffline').hidden,false);
  await f.click('cancelOffline');assert.equal(f.node('offlineBtn').disabled,false);assert.equal(f.node('cancelOffline').hidden,true);assert.match(f.node('offlineProgress').textContent,/准备已停止/);
});
test('offline preparation cannot report success before Worker activation or after incomplete cache persistence',async()=>{
  const {serviceWorkerFixture}=require('./helpers/app-fixture.cjs');
  const f=fixture({register:async()=>({})}),h=serviceWorkerFixture();h.serviceWorker.controller=null;h.registration.active=null;
  f.context.navigator.serviceWorker=h.serviceWorker;let downloads=0;f.context.fetch=async()=>{downloads++;throw Error('Must not download before activation');};
  await f.click('offlineBtn');assert.equal(f.node('offlineBtn').disabled,true);assert.equal(downloads,0);assert.doesNotMatch(f.node('offlineProgress').textContent||'',/离线资源已准备/);
  await f.click('cancelOffline');assert.match(f.node('offlineProgress').textContent,/准备已停止/);
  const incomplete=fixture({register:async()=>({}),engine:{prepare:async()=>({models:[]})}});incomplete.context.Request=Request;
  incomplete.context.caches={open:async()=>({put:async()=>{},keys:async()=>[]})};
  incomplete.context.fetch=async request=>typeof request==='string'?new Response(JSON.stringify({schema_version:1,assets:[]})):new Response('Unit fixture static bytes');
  await incomplete.click('offlineBtn');await incomplete.until(()=>!incomplete.node('offlineBtn').disabled);
  assert.match(incomplete.node('offlineProgress').textContent,/准备未完成.*资源未完整保存/);assert.doesNotMatch(incomplete.node('offlineProgress').textContent,/离线资源已准备/);
});

test('declining new specimen confirmation preserves unsaved photo and observations',async()=>{
  const f=fixture();await f.photo();f.node('notes').value='保留观察';f.node('notes').fire('input');f.setConfirmation(false);
  await f.click('newSample');assert.equal(f.node('preview').hidden,false);assert.equal(f.node('notes').value,'保留观察');assert.equal(f.node('predictBtn').disabled,false);
});

test('leaving identification cancels video extraction and refuses late frames',async()=>{
  const f=fixture();await f.photo();let complete,signal;
  f.context.MineralMedia={extractVideo:(_file,_report,options)=>{signal=options.signal;return new Promise(resolve=>{complete=resolve;});}};
  f.node('videoInput').files=[{name:'specimen.mp4',type:'video/mp4',size:100}];f.node('videoInput').fire('change');await f.settle();
  assert.equal(f.node('cancelInput').hidden,false);assert.equal(f.node('predictBtn').disabled,true);
  assert.equal(f.node('cancelInput').textContent,'停止视频取帧');
  f.route('records');assert.equal(signal.aborted,true);
  complete({duration:4,frames:[{src:'data:image/jpeg;base64,TEFURQ==',time:2}]});await f.settle();
  assert.match(f.node('inputSummary').textContent,/已提交 1 张/);assert.equal(f.node('cancelInput').hidden,true);assert.equal(f.node('galleryBtn').disabled,false);
});

test('prepared reference metadata and attribution remain available after the current service worker activates offline',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),stored=new Map();
  const caches={open:async name=>{if(!stored.has(name))stored.set(name,new Map());const cache=stored.get(name);return {put:async(request,response)=>cache.set(typeof request==='string'?request:request.url,response.clone()),match:async request=>cache.get(typeof request==='string'?request:request.url)?.clone(),keys:async()=>[...cache.keys()].map(url=>new Request(url)),delete:async request=>cache.delete(typeof request==='string'?request:request.url)};},keys:async()=>[...stored.keys()],delete:async name=>stored.delete(name)};
  const f=fixture({register:async()=>({})});f.context.caches=caches;f.context.URL=URL;f.context.Request=Request;
  f.context.fetch=async request=>typeof request==='string'?(request.endsWith('reviewed-photo-assets.json')?new Response(JSON.stringify({schema_version:1,assets:[]})):{ok:true,json:async()=>({models:[]})}):new Response('prepared '+new URL(request.url).pathname);
  await f.click('offlineBtn');await f.until(()=>!f.node('offlineBtn').disabled);assert.match(f.node('offlineProgress').textContent,/离线资源已准备/);
  const names=f.context.MineralCore.offlineCaches(f.context.location.href),wasmURL=new URL('vendor/ort-wasm-simd-threaded.wasm',f.context.location.href).href;
  assert.equal(stored.get(names.shell).has(wasmURL),true);assert.equal(stored.get(names.models).has(wasmURL),false);
  const events={},scope=f.context.location.href,worker={addEventListener:(type,fn)=>{events[type]=fn;},registration:{scope},clients:{claim(){}}};
  const WEB=fs.existsSync(require('node:path').join(__dirname,'../web/sw.js'))?'../web/':'../';
  vm.runInNewContext(fs.readFileSync(require.resolve(WEB+'sw.js'),'utf8'),{self:worker,caches,MineralCore:f.context.MineralCore,URL,Request,Response,Headers,TextDecoder,AbortController,setTimeout,clearTimeout,importScripts(){},fetch:async()=>{throw new Error('offline');}});
  let activation;events.activate({waitUntil:promise=>{activation=promise;}});await activation;
  for(const asset of ['data/catalog.json','data/crystals.json','data/image-sources.json','data/reference-manifest.json','data/licenses/ima-cnmnc-2026-09.txt']){
    let response;events.fetch({request:new Request(new URL(asset,scope)),respondWith:promise=>{response=promise;},waitUntil(){}});
    const cached=await response;assert.equal(cached.status,200,asset);assert.match(await cached.text(),/^prepared /,asset);
  }
});
test('offline models use their complete identity URL and a corrupt exact cache entry is bounded, removed and re-fetched',async()=>{
  const crypto=require('node:crypto'),bytes=Buffer.from([1,2,3,4]),sha256=crypto.createHash('sha256').update(bytes).digest('hex'),model={id:'classifier',path:'models/specimen.onnx',bytes:4,sha256};
  const manifest={models:[model]},identityURL='http://127.0.0.1/test/models/specimen.onnx?manifest='+('a'.repeat(64))+'&sha256='+sha256;
  const entries=new Map([[identityURL,new Response(Buffer.from([9]))]]),matches=[],deleted=[],downloads=[];
  const cache={match:async request=>{matches.push(request.url);return entries.get(request.url)?.clone();},keys:async()=>[...entries.keys()].map(url=>new Request(url)),delete:async request=>{deleted.push(request.url);return entries.delete(request.url);},put:async(request,response)=>entries.set(request.url,response.clone())};
  const f=fixture({register:async()=>({}),engine:{prepare:async()=>manifest,modelResources:()=>[{...model,url:identityURL}]}});f.context.caches={open:async()=>cache};f.context.URL=URL;f.context.Request=Request;f.context.crypto=crypto.webcrypto;
  f.context.fetch=async request=>{if(typeof request==='string'&&request.endsWith('reviewed-photo-assets.json'))return new Response(JSON.stringify({schema_version:1,assets:[]}));downloads.push(request.url);return new Response(request.url===identityURL?bytes:'static');};
  await f.click('offlineBtn');await f.until(()=>!f.node('offlineBtn').disabled);assert.match(f.node('offlineProgress').textContent,/离线资源已准备/);assert.deepEqual(matches,[identityURL]);assert.deepEqual(deleted,[identityURL]);assert.equal(downloads.filter(url=>url===identityURL).length,1);assert.deepEqual(Buffer.from(await entries.get(identityURL).arrayBuffer()),bytes);
});
