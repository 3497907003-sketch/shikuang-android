const STATIC = 'shikuang-static-2.5.0-preview.1-r2';
const MODELS = 'shikuang-models-v2-20261010';
importScripts('./core.js');
const ASSETS = ['./', './index.html', './styles.css', './app.js', './native-assets.js', './core.js', './inference.js', './storage.js', './engine-worker.js', './media.js', './history.js', './icon-192.png', './icon-512.png', './icon-maskable.png', './version.json', './data/sources.js', './config.js', './icon.svg', './manifest.webmanifest', './data/classes.js', './data/minerals.js', './data/imagenet.js', './vendor/lucide.min.js', './vendor/ort.min.js', './vendor/ort-wasm-simd-threaded.mjs', './reference-loader.js', './gallery.js', './data/reviewed-photo-assets.json', './data/licenses/reviewed-photos-v25.txt', './data/reference-manifest.json', './data/licenses/ima-cnmnc-2026-09.txt'];
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
async function loadModel(request,url) {
  const model=await expectedModel(url),cache=await caches.open(MODELS);
  const repair=['reload','no-store'].includes(request.cache);
  if(!repair) {
    const exact=await cache.match(request);if(exact)return exact; // Engine verifies even cached bytes.
    // Migrate old URL-only caches only after checking the current manifest's exact bytes/hash.
    const legacyURL=new URL(url);legacyURL.search='';const legacy=await cache.match(legacyURL.href);
    if(legacy) {
      try {const verified=await boundedCheck(checkedModel(legacy,model),15000);await cache.put(request,verified.clone());await cache.delete(legacyURL.href);return verified;}
      catch(_){await cache.delete(legacyURL.href);}
    }
  }
  const verified=await fetchBounded(request,response=>checkedModel(response,model),90000);
  // Quota exhaustion must not turn a verified online response into a failed model.
  // Offline preparation separately checks whether all identity keys were persisted.
  if(request.cache!=='no-store')await boundedCheck(cache.put(request,verified.clone()),10000).catch(()=>{});
  return verified;
}
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(STATIC);await cache.addAll(ASSETS);
  const response=await loadManifest(new Request(manifestURL,{cache:'no-cache'}));if(!response.ok)throw new Error('Model manifest installation failed');await self.skipWaiting();
})()));
self.addEventListener('message',event=>{
  if(event.data && event.data.type==='ACTIVATE_UPDATE')self.skipWaiting();
  if(event.data && event.data.type==='INVALIDATE_MODEL')event.waitUntil((async()=>{
    const url=new URL(event.data.url);if(!owned(url)||!url.pathname.startsWith(scope.pathname+'models/'))return;
    const cache=await caches.open(MODELS);await cache.delete(url.href);
    const legacy=new URL(url);legacy.search='';await cache.delete(legacy.href);
    if(event.ports[0])event.ports[0].postMessage({removed:true});
  })());
});
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  const names=await caches.keys();await Promise.all(names.filter(name=>name.startsWith('shikuang-') && ![STATIC,MODELS].includes(name)).map(name=>caches.delete(name)));
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||!owned(url))return;
  event.respondWith((async()=>{
    try {
      if(url.pathname===manifestURL.pathname)return await loadManifest(request);
      if(url.pathname.startsWith(scope.pathname+'models/') && url.pathname.endsWith('.onnx'))return await loadModel(request,url);
      const cache=await caches.open(url.pathname.endsWith('.wasm')?MODELS:STATIC);
      const repair=['reload','no-store','no-cache'].includes(request.cache);
      const cached=repair?null:await cache.match(request);
      if(cached)return cached;
      try {const response=await fetchBounded(request);if(response.ok && request.cache!=='no-store')await boundedCheck(cache.put(request,response.clone()),10000).catch(()=>{});return response;}
      catch(error){if(!['reload','no-store'].includes(request.cache)){const fallback=await cache.match(request);if(fallback)return fallback;}if(request.mode==='navigate')return await cache.match(new URL('index.html',scope).href)||Response.error();throw error;}
    }catch(_){return Response.error();}
  })());
});
