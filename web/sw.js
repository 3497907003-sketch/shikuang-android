importScripts('./core.js?v=20261011-2.5.0-preview.1-r9');
const CACHE_NAMES = MineralCore.offlineCaches(self.registration.scope);
const STATIC = CACHE_NAMES.shell;
const MODELS = CACHE_NAMES.models;
// Source-development pin. Build replaces it from the actual vendor bytes after
// deriving the release identity, so future ORT updates cannot retain this hash.
const RUNTIME_WASM = Object.freeze({"path":"vendor/ort-wasm-simd-threaded.wasm","bytes":11241642,"sha256":"704f51767fe3e11443aac6b5509c8654688e4cea3d988f96a069390b6eccbabc"});
const ASSETS = ['./', './index.html', './styles.css', './app.js', './native-assets.js', './core.js', './inference.js', './storage.js', './engine-worker.js', './media.js', './history.js', './icon-192.png', './icon-512.png', './icon-maskable.png', './version.json', './data/sources.js', './config.js', './icon.svg', './manifest.webmanifest', './data/classes.js', './data/minerals.js', './data/imagenet.js', './vendor/lucide.min.js', './vendor/ort.min.js', './vendor/ort-wasm-simd-threaded.mjs', './vendor/ort-wasm-simd-threaded.wasm', './reference-loader.js', './gallery.js', './viewport.js', './data/reviewed-photo-assets.json', './data/licenses/reviewed-photos-v25.txt', './data/reference-manifest.json', './data/licenses/ima-cnmnc-2026-09.txt'];
const scope = new URL(self.registration.scope);
const manifestURL = new URL('model-manifest.json',scope);
const hex = bytes => Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
const digest = async bytes => hex(await crypto.subtle.digest('SHA-256',bytes));
function owned(url) { return url.origin===scope.origin && url.pathname.startsWith(scope.pathname); }
async function fetchBounded(request,verify=response=>response,timeout=5000) {
  const controller=new AbortController();let timer;
  try { return await Promise.race([fetch(request,{signal:controller.signal}).then(verify),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Resource network timeout'));},timeout);})]); }
  finally {clearTimeout(timer);}
}
async function checkedManifest(response,state) {
  const bytes=await MineralCore.readResource(response,100000,undefined,undefined,{timeout:5000});
  const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  const manifest=MineralCore.validateManifest(raw,raw.labels),hash=await digest(bytes);
  const headers=new Headers(response.headers);headers.set('X-Shikuang-Manifest-State',state);headers.set('Content-Type','application/json');
  return {manifest,hash,response:new Response(bytes,{status:200,headers})};
}
function snapshotURL(hash) { const url=new URL(manifestURL);url.searchParams.set('sha256',hash);return url.href; }
async function loadManifest(request) {
  const cache=await caches.open(STATIC),repair=['reload','no-store'].includes(request.cache);
  let network;
  // Only transport failure permits a verified offline fallback. Invalid new contents
  // or HTTP errors remain visible, so an old cache cannot conceal a broken upgrade.
  try { network=await fetchBounded(request); }
  catch(error) {
    const old=repair?null:await cache.match(manifestURL.href);
    if(!old)throw error;
    return (await checkedManifest(old,'offline-cache')).response;
  }
  if(!network.ok)return network;
  // The manifest read is separately bounded even if a cache/network body stalls.
  const checked=await boundedCheck(checkedManifest(network,'network'),5000);
  if(request.cache!=='no-store') {
    await cache.put(snapshotURL(checked.hash),checked.response.clone());
    await cache.put(manifestURL.href,checked.response.clone());
  }
  return checked.response;
}
async function boundedCheck(promise,timeout) {
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Resource verification timeout')),timeout);})]);}finally{clearTimeout(timer);}
}
async function expectedModel(url) {
  const hash=url.searchParams.get('manifest'),modelHash=url.searchParams.get('model');
  if(!/^[a-f0-9]{64}$/.test(hash||'')||!/^[a-f0-9]{64}$/.test(modelHash||''))throw new Error('Model identity is missing');
  const cache=await caches.open(STATIC);
  let response=await cache.match(snapshotURL(hash));
  if(!response)response=await cache.match(manifestURL.href);
  if(!response)throw new Error('Prepare the model manifest first');
  const checked=await checkedManifest(response,'offline-cache');
  if(checked.hash!==hash)throw new Error('Model manifest changed; prepare resources again');
  const model=checked.manifest.models.find(row=>new URL(row.path,scope).pathname===url.pathname && row.sha256===modelHash);
  if(!model)throw new Error('Model is outside the active manifest');
  return model;
}
async function checkedModel(response,model) {
  const bytes=await MineralCore.readResource(response,MineralCore.MODEL_MAX_BYTES,model.bytes);
  if(await digest(bytes)!==model.sha256)throw new Error('Model checksum mismatch');
  const headers=new Headers(response.headers);headers.set('Content-Type','application/octet-stream');
  return new Response(bytes,{status:200,headers});
}
async function checkedWasm(response,timeout=90000) {
  const bytes=await MineralCore.readResource(response,32*1024*1024,RUNTIME_WASM.bytes,undefined,{timeout});
  // Reject HTML, truncated responses and non-WASM bodies before making a new
  // shell usable offline. ORT still validates/initializes the actual module.
  if(bytes.length<8||![0,97,115,109,1,0,0,0].every((value,i)=>bytes[i]===value))throw new Error('Runtime WASM header is invalid');
  if(await digest(bytes)!==RUNTIME_WASM.sha256)throw new Error('Runtime WASM checksum differs from this release');
  const headers=new Headers(response.headers);headers.set('Content-Type','application/wasm');
  return new Response(bytes,{status:200,headers});
}
async function cachedWasm(cache,request) {
  const response=await cache.match(request);if(!response)return null;
  try {return await checkedWasm(response,15000);}
  catch(_){await cache.delete(request);return null;}
}
async function loadWasm(request) {
  // ORT glue and its WASM are one release. Never migrate unversioned bytes from
  // the stable weight cache: a valid old module can be incompatible with new JS.
  const cache=await caches.open(STATIC),repair=['reload','no-store','no-cache'].includes(request.cache);
  if(!repair){const old=await cachedWasm(cache,request);if(old)return old;}
  let response;
  try {response=await fetchBounded(request);}
  catch(error) {
    const old=request.cache==='no-store'?null:await cachedWasm(cache,request);
    if(old)return old;throw error;
  }
  if(!response.ok)return response;
  const verified=await checkedWasm(response);
  if(request.cache!=='no-store')await boundedCheck(cache.put(request,verified.clone()),10000).catch(()=>{});
  return verified;
}
async function loadModel(request,url) {
  const model=await expectedModel(url),cache=await caches.open(MODELS);
  const repair=['reload','no-store'].includes(request.cache);
  if(!repair) {
    const exact=await cache.match(request);if(exact)return exact; // Engine verifies even cached bytes.
    // Migrate only this scope's exact URLs, after checking the current manifest.
    // Preserve other registrations' data in the former origin-wide model cache.
    const legacyURL=new URL(url);legacyURL.search='';
    const oldStores=[cache];
    if((await caches.keys()).includes(MineralCore.OFFLINE_CACHES.models))oldStores.push(await caches.open(MineralCore.OFFLINE_CACHES.models));
    for(const oldStore of oldStores)for(const candidate of oldStore===cache?[legacyURL.href]:[url.href,legacyURL.href]) {
      const legacy=await oldStore.match(candidate);if(!legacy)continue;
      let verified;
      try {verified=await boundedCheck(checkedModel(legacy,model),15000);}
      catch(_){await oldStore.delete(candidate);continue;}
      const persisted=await boundedCheck(cache.put(request,verified.clone()),10000).then(()=>true,()=>false);
      if(persisted)await oldStore.delete(candidate);
      return verified;
    }
  }
  const verified=await fetchBounded(request,response=>checkedModel(response,model),90000);
  // Quota exhaustion must not turn a verified online response into a failed model.
  // Offline preparation separately checks whether all identity keys were persisted.
  if(request.cache!=='no-store')await boundedCheck(cache.put(request,verified.clone()),10000).catch(()=>{});
  return verified;
}
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(STATIC),entryURL=new URL('index.html',scope);
  const entry=await fetchBounded(new Request(entryURL,{cache:'no-cache'}));
  if(!entry.ok)throw new Error('Offline entry document installation failed');
  const html=await boundedCheck(entry.clone().text(),5000);
  const assets=[...new Set([...ASSETS.map(path=>new URL(path,scope).href),...MineralCore.shellAssets(html,scope)])];
  // A new shell must not inherit still-fresh HTTP cache bodies from the old
  // release, including unversioned worker imports and reference metadata.
  const wasm=assets.filter(url=>new URL(url).pathname.endsWith('.wasm'));
  await boundedCheck(cache.addAll(assets.filter(url=>url!==scope.href&&url!==entryURL.href&&!wasm.includes(url)).map(url=>new Request(url,{cache:'reload'}))),60000);
  // Installation cannot activate a new ORT shell with the previous WASM or
  // no matching module. Failure leaves the active old shell/cache untouched.
  for(const url of wasm) {
    const response=await fetchBounded(new Request(url,{cache:'reload'}),checkedWasm,90000);
    await boundedCheck(cache.put(url,response),10000);
  }
  await cache.put(entryURL.href,entry.clone());await cache.put(scope.href,entry);
  const response=await loadManifest(new Request(manifestURL,{cache:'no-cache'}));if(!response.ok)throw new Error('Model manifest installation failed');await self.skipWaiting();
})()));
self.addEventListener('message',event=>{
  if(event.data?.type==='OFFLINE_IDENTITY' && event.ports[0])event.ports[0].postMessage({scope:CACHE_NAMES.scope,shell:STATIC,models:MODELS});
  if(event.data && event.data.type==='ACTIVATE_UPDATE')self.skipWaiting();
  if(event.data && event.data.type==='INVALIDATE_MODEL')event.waitUntil((async()=>{
    const url=new URL(event.data.url);if(!owned(url)||!url.pathname.startsWith(scope.pathname+'models/'))return;
    const cache=await caches.open(MODELS);await cache.delete(url.href);
    const legacy=new URL(url);legacy.search='';await cache.delete(legacy.href);
    if(event.ports[0])event.ports[0].postMessage({removed:true});
  })());
});
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  const names=await caches.keys();await Promise.all(names.filter(name=>name.startsWith(CACHE_NAMES.prefix) && ![STATIC,MODELS].includes(name)).map(name=>caches.delete(name)));
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||!owned(url))return;
  event.respondWith((async()=>{
    try {
      if(url.pathname===manifestURL.pathname)return await loadManifest(request);
      if(url.pathname.startsWith(scope.pathname+'models/') && url.pathname.endsWith('.onnx'))return await loadModel(request,url);
      if(url.pathname.endsWith('.wasm')){
        if(url.pathname!==new URL(RUNTIME_WASM.path,scope).pathname)throw new Error('Runtime is outside this release');
        return await loadWasm(request);
      }
      const cache=await caches.open(STATIC);
      const repair=['reload','no-store','no-cache'].includes(request.cache);
      const cached=repair?null:await cache.match(request);
      if(cached)return cached;
      try {const response=await fetchBounded(request);if(response.ok && request.cache!=='no-store')await boundedCheck(cache.put(request,response.clone()),10000).catch(()=>{});return response;}
      // A normal offline reload may use this release's exact shell URL. Explicit
      // no-store repair and the model/manifest verification rules remain strict.
      catch(error){if(request.cache!=='no-store'){const fallback=await cache.match(request);if(fallback)return fallback;if(request.mode==='navigate')return await cache.match(new URL('index.html',scope).href)||Response.error();}throw error;}
    }catch(_){return Response.error();}
  })());
});
