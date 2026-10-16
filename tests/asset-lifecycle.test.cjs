const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const WEB=fs.existsSync(require('node:path').join(__dirname,'../web/core.js'))?'../web/':'../';
const Core=require(WEB+'core.js'),{fixture,hash}=require('./helpers/model-contract.cjs');
const swSource=fs.readFileSync(require.resolve(WEB+'sw.js'),'utf8');
function cacheStorage() {
  const stores=new Map();return {stores,keys:async()=>[...stores.keys()],delete:async key=>stores.delete(key),open:async key=>{
    if(!stores.has(key))stores.set(key,new Map());const data=stores.get(key),url=key=>typeof key==='string'?key:key.url;
    return {match:async key=>data.get(url(key))?.clone(),put:async(key,value)=>data.set(url(key),value.clone()),delete:async key=>data.delete(url(key)),addAll:async()=>{}};
  }};
}
function serviceWorker(scope='https://localhost/app/',caches=cacheStorage()) {
  const listeners={},network={fetch:async()=>{throw Error('offline');}},context={MineralCore:Core,URL,Request,Response,Headers,TextDecoder,AbortController,DOMException,setTimeout,clearTimeout,crypto:require('node:crypto').webcrypto,caches,importScripts(){},fetch:(...args)=>network.fetch(...args),self:{registration:{scope},addEventListener:(name,callback)=>listeners[name]=callback,skipWaiting:async()=>{},clients:{claim:async()=>{}}}};
  vm.runInNewContext(swSource,context);
  return {caches,network,async request(path,cache='default'){
    let reply;listeners.fetch({request:new Request(new URL(path,scope),{cache}),respondWith:value=>reply=value,waitUntil(){}});return reply;
  },async activate(){let work;listeners.activate({waitUntil:value=>work=value});await work;},async message(data){const work=[];let ack;listeners.message({data,ports:[{postMessage:value=>ack=value}],waitUntil:value=>work.push(value)});await Promise.all(work);return ack;}};
}
async function publish(sw,data=fixture()) {
  const bytes=Buffer.from(JSON.stringify(data.manifest));sw.network.fetch=async()=>new Response(bytes);
  const response=await sw.request('model-manifest.json','no-cache');assert.equal(response.status,200);return {data,manifestHash:hash(bytes)};
}
test('manifest is network-first, bounded offline fallback is explicit, invalid upgrades fail closed',async()=>{
  const sw=serviceWorker();await publish(sw);
  sw.network.fetch=async()=>{throw Error('offline');};
  const offline=await sw.request('model-manifest.json','no-cache');assert.equal(offline.headers.get('x-shikuang-manifest-state'),'offline-cache');
  assert.equal((await sw.request('model-manifest.json','reload')).type,'error');
  sw.network.fetch=async()=>new Response('<html>broken</html>',{headers:{'content-type':'text/html'}});
  assert.equal((await sw.request('model-manifest.json','no-cache')).type,'error');
  const fresh=fixture();fresh.manifest.version='2.5.0-new';await publish(sw,fresh);
  sw.network.fetch=async()=>{throw Error('offline');};
  assert.equal((await (await sw.request('model-manifest.json','no-cache')).json()).version,'2.5.0-new');
});
test('models bind manifest and checksum identities; legacy entries migrate only after verification',async()=>{
  const sw=serviceWorker(),{data,manifestHash}=await publish(sw),model=data.manifest.models[0];
  const key=Core.modelResourceURL(model,manifestHash,'https://localhost/app/').href;
  const store=await sw.caches.open(Core.offlineCaches('https://localhost/app/').models);
  await store.put('https://localhost/app/'+model.path,new Response(Buffer.from([9])));
  sw.network.fetch=async()=>{throw Error('offline');};assert.equal((await sw.request(key)).type,'error');
  assert.equal(await store.match('https://localhost/app/'+model.path),undefined);
  await store.put('https://localhost/app/'+model.path,new Response(data.files[model.path]));
  assert.deepEqual(Buffer.from(await (await sw.request(key)).arrayBuffer()),data.files[model.path]);
  assert.ok(await store.match(key));assert.equal(await store.match('https://localhost/app/'+model.path),undefined);
  const next=new URL(key);next.searchParams.set('manifest','0'.repeat(64));assert.equal((await sw.request(next)).type,'error');
  assert.equal((await sw.request(key,'reload')).type,'error');
  assert.equal((await sw.message({type:'INVALIDATE_MODEL',url:key})).removed,true);assert.equal(await store.match(key),undefined);
});
test('network model corruption never enters cache and repair permits a later valid retry',async()=>{
  const sw=serviceWorker(),{data,manifestHash}=await publish(sw),model=data.manifest.models[0];
  const key=Core.modelResourceURL(model,manifestHash,'https://localhost/app/').href;
  sw.network.fetch=async()=>new Response(Buffer.from([8]));assert.equal((await sw.request(key)).type,'error');
  const cache=await sw.caches.open(Core.offlineCaches('https://localhost/app/').models);assert.equal(await cache.match(key),undefined);
  sw.network.fetch=async()=>new Response(data.files[model.path]);assert.equal((await sw.request(key,'reload')).status,200);assert.ok(await cache.match(key));
});
test('offline preparation retains the entry document exact versioned script and stylesheet URLs',()=>{
  const html=fs.readFileSync(require.resolve(WEB+'index.html'),'utf8'),base='https://localhost/app/';
  const assets=Core.shellAssets(html,base);
  for(const match of html.matchAll(/<(?:script|link)\b[^>]*\s(?:src|href)="([^\"]+)"[^>]*>/g)) {
    assert.ok(assets.includes(new URL(match[1],base).href),'Missing entry dependency: '+match[1]);
  }
  assert.ok(assets.some(url=>new URL(url).pathname.endsWith('/styles.css')&&new URL(url).searchParams.has('v')));
  assert.deepEqual(Core.shellAssets('<script data-src="./fake.js" src=\'./real.js?v=1&amp;x=2\'></script>',base),[base+'real.js?v=1&x=2']);
  assert.throws(()=>Core.shellAssets('<script src="../other/app.js"></script>',base),/应用范围/);
});
test('offline shell reload uses the exact current URL without concealing another version or an HTTP failure',async()=>{
  const sw=serviceWorker(),cache=await sw.caches.open(Core.offlineCaches('https://localhost/app/').shell);
  const current='https://localhost/app/styles.css?v=current';
  await cache.put(current,new Response('body{color:teal}',{headers:{'content-type':'text/css'}}));
  await cache.put('https://localhost/app/styles.css',new Response('old unversioned CSS'));
  assert.equal(await (await sw.request(current,'reload')).text(),'body{color:teal}');
  assert.equal((await sw.request('styles.css?v=another','reload')).type,'error');
  assert.equal((await sw.request(current,'no-store')).type,'error');
  sw.network.fetch=async()=>new Response('missing',{status:404});
  assert.equal((await sw.request(current,'reload')).status,404);
});
test('Worker activation isolates different application scopes and reports its actual cache identities',async()=>{
  const caches=cacheStorage(),first=Core.offlineCaches('https://localhost/app/'),other=Core.offlineCaches('https://localhost/other/');
  assert.notEqual(first.shell,other.shell);
  const old=first.prefix+'shikuang-static-old',globalLegacy='shikuang-static-2.5.0-preview.1-r4';
  for(const name of [old,first.shell,first.models,other.shell,other.models,globalLegacy,'shikuang-other-app-scope-cache'])await caches.open(name);
  const sw=serviceWorker('https://localhost/app/',caches);await sw.activate();
  assert.equal(caches.stores.has(old),false);
  for(const name of [first.shell,first.models,other.shell,other.models,globalLegacy,'shikuang-other-app-scope-cache'])assert.equal(caches.stores.has(name),true,name);
  assert.deepEqual(JSON.parse(JSON.stringify(await sw.message({type:'OFFLINE_IDENTITY'}))),{scope:first.scope,shell:first.shell,models:first.models});
});
test('verified model migration from the former shared cache preserves other scopes and rejects wrong bytes',async()=>{
  const sw=serviceWorker(),{data,manifestHash}=await publish(sw),model=data.manifest.models[0],key=Core.modelResourceURL(model,manifestHash,'https://localhost/app/').href;
  const legacy=await sw.caches.open(Core.OFFLINE_CACHES.models),foreign='https://localhost/other/'+model.path;
  await legacy.put(foreign,new Response('other application bytes'));
  await legacy.put(key,new Response(Buffer.from([9])));sw.network.fetch=async()=>{throw Error('offline');};
  assert.equal((await sw.request(key)).type,'error');assert.equal(await legacy.match(key),undefined);assert.ok(await legacy.match(foreign));
  await legacy.put(key,new Response(data.files[model.path]));assert.deepEqual(Buffer.from(await (await sw.request(key)).arrayBuffer()),data.files[model.path]);
  assert.ok(await (await sw.caches.open(Core.offlineCaches('https://localhost/app/').models)).match(key));assert.equal(await legacy.match(key),undefined);assert.ok(await legacy.match(foreign));
});
test('offline readiness waits for activation/control, detects a page/Worker version mismatch, and cancels pending installation',async()=>{
  const {serviceWorkerFixture}=require('./helpers/app-fixture.cjs'),{MessageChannel}=require('node:worker_threads');
  const h=serviceWorkerFixture(),controller=new AbortController();h.serviceWorker.controller=null;h.worker.state='activating';
  let done=false;const pending=Core.offlineWorkerIdentity(h.serviceWorker,h.names.scope,controller.signal,MessageChannel).then(value=>{done=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);
  h.worker.state='activated';h.serviceWorker.controller=h.worker;h.serviceWorker.emit('controllerchange');assert.equal((await pending).shell,h.names.shell);
  h.worker.postMessage=(_data,ports)=>ports[0].postMessage({scope:h.names.scope,shell:h.names.prefix+'old-shell',models:h.names.models});
  await assert.rejects(Core.offlineWorkerIdentity(h.serviceWorker,h.names.scope,controller.signal,MessageChannel),/版本不一致/);
  h.registration.installing=Object.assign({},h.worker,{state:'installing'});
  const canceled=new AbortController(),waiting=Core.offlineWorkerIdentity(h.serviceWorker,h.names.scope,canceled.signal,MessageChannel);await new Promise(resolve=>setImmediate(resolve));canceled.abort();await assert.rejects(waiting,{name:'AbortError'});
  assert.equal(h.serviceWorker.listeners.get('controllerchange').size,0);
});
function nativeMigration({controller=true,stall=false}={}) {
  const removed=[],deleted=[],timers=[];let reloads=0;
  const root={__shikuangAppReady:true,Promise,URL,AbortController,crypto:require('node:crypto').webcrypto,Image:class {decode(){}},Capacitor:{isNativePlatform:()=>true},location:{href:'https://localhost/app/',reload:()=>reloads++},navigator:{serviceWorker:{controller:controller?{scriptURL:'https://localhost/app/sw.js'}:null,getRegistrations:()=>stall?new Promise(()=>{}):Promise.resolve([{scope:'https://localhost/app/',unregister:async()=>{removed.push('own');return true;}},{scope:'https://localhost/unrelated/',unregister:async()=>{removed.push('unrelated');return true;}},{scope:'https://other/app/',unregister:async()=>{removed.push('foreign');return true;}}])}},caches:{keys:async()=>['shikuang-static-old','unrelated-user-cache'],delete:async name=>{deleted.push(name);return true;}},indexedDB:{deleteDatabase(){throw Error('Never delete specimens');}},setTimeout:callback=>(timers.push(callback),timers.length),clearTimeout(){}};
  vm.runInNewContext(fs.readFileSync(require.resolve(WEB+'native-assets.js'),'utf8'),{window:root,URL,Promise,Error});
  return {root,removed,deleted,timers,reloads:()=>reloads};
}
test('native legacy Worker migration clears only owned registrations/assets, preserves history, reloads once',async()=>{
  const h=nativeMigration();const first=h.root.MineralNativeAssets.prepare(true),second=h.root.MineralNativeAssets.prepare(true);assert.equal(first,second);
  const result=await first;assert.equal(result.restartRequired,true);assert.equal(h.reloads(),1);assert.deepEqual(h.removed,['own']);assert.deepEqual(h.deleted,['shikuang-static-old']);
  await h.root.MineralNativeAssets.prepare(true);assert.equal(h.reloads(),1);
  const clean=nativeMigration({controller:false});assert.equal((await clean.root.MineralNativeAssets.prepare(true)).restartRequired,false);assert.equal(clean.reloads(),0);
});
test('stalled native asset migration times out and remains retryable',async()=>{
  const h=nativeMigration({stall:true}),pending=h.root.MineralNativeAssets.prepare(true);h.timers[0]();await assert.rejects(pending,/超过 5 秒/);
  const retry=h.root.MineralNativeAssets.prepare(true);assert.notEqual(retry,pending);h.timers[1]();await assert.rejects(retry,/超过 5 秒/);assert.equal(h.reloads(),0);
});
test('resource body deadlines cancel stalled readers; Abort returns without waiting on reader cancellation',async()=>{
  let cancels=0;
  const response={ok:true,headers:{get:()=>''},body:{getReader:()=>({read:()=>new Promise(()=>{}),cancel:()=>{cancels++;return new Promise(()=>{});},releaseLock(){}})}};
  await assert.rejects(Core.readResource(response,100,undefined,undefined,{timeout:10}),/读取超时/);assert.equal(cancels,1);
  const controller=new AbortController(),pending=Core.readResource(response,100,undefined,undefined,{signal:controller.signal});controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(cancels,2);
});

test('trusted ES5 boot gate exposes unsupported components and has a finite startup recovery deadline',()=>{
  const h=nativeMigration({controller:false});h.root.__shikuangAppReady=false;h.root.AbortController=undefined;
  const blocked=h.root.MineralNativeAssets.boot(true);assert.equal(blocked.supported,false);assert.match(h.root.__shikuangBootRecovery.message,/AbortController/);
  h.root.AbortController=AbortController;assert.equal(h.root.MineralNativeAssets.boot(true).supported,true);h.timers[0]();assert.match(h.root.__shikuangBootRecovery.message,/15 秒/);
  const ready=nativeMigration({controller:false});assert.equal(ready.root.MineralNativeAssets.boot(true).supported,true);assert.equal(ready.root.__shikuangBootRecovery,undefined);assert.equal(ready.timers.length,0);
});
