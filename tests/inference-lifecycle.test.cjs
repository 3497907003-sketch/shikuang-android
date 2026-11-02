const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {getEventListeners}=require('node:events');
const Core=require('../web/core.js');
const {fixture,response,raw,labels}=require('./helpers/model-contract.cjs');
const source=fs.readFileSync(require.resolve('../web/inference.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function observed(promise){let timer;try{return await Promise.race([promise.then(value=>({status:'resolved',value}),error=>({status:'rejected',error})),new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'pending'}),35);})]);}finally{clearTimeout(timer);}}
function harness(options={}){
 const data=fixture(),state={images:[],canvases:[],timers:new Map(),timerID:0,classifications:0,removed:0,cancelled:0,eventErrors:[],rejectQuality:false};
 const pixels=new Uint8ClampedArray(224*224*4);for(let i=0;i<224*224;i++){const n=i%2?180:65;pixels.set([n,n+10,n+20,255],i*4);}
 const plugin=options.plugin||{addListener:async()=>({remove:async()=>state.removed++}),classify:async payload=>{state.classifications++;options.beforeClassify?.(state);return raw(data.manifest,payload);},cancel:async()=>state.cancelled++};
 const window={MINERAL_KB:{quartz:{name_zh:'石英'},calcite:{}},IMAGENET_BLOCKED:Array(1000).fill(false),Worker:options.Worker,MineralNativeAssets:{prepare:async()=>({restartRequired:false})},Capacitor:{isNativePlatform:()=>options.native!==false,isPluginAvailable:()=>true,registerPlugin:()=>plugin},MineralMedia:{decodePhoto:async(src,{signal})=>{
  const img={naturalWidth:224,naturalHeight:224,src:'decoded:'+src,removeAttribute(name){assert.equal(name,'src');this.src='';this.released=true;}};state.images.push(img);options.afterDecode?.(img,signal);return img;
 }}};
 const context={window,MINERAL_KB:window.MINERAL_KB,MINERAL_CLASSES:Object.fromEntries(labels.map(k=>[k,k])),MineralCore:{...Core,quality:(...args)=>state.rejectQuality?{warnings:['偏暗']}:Core.quality(...args)},
  document:{createElement:()=>{const canvas={width:0,height:0,getContext:()=>({drawImage(){if(options.drawError)throw Error('synthetic draw failed');},getImageData(){if(options.pixelError)throw Error('synthetic pixels unavailable');return {data:pixels};}})};state.canvases.push(canvas);return canvas;}},
  URL,Blob,location:{href:'https://localhost/index.html'},Worker:options.Worker,DOMException,AbortController,TextDecoder,TextEncoder,
  setTimeout:(fn,ms)=>{const id=++state.timerID;state.timers.set(id,{fn,ms});return id;},clearTimeout:id=>state.timers.delete(id),
  fetch:options.fetch||(async()=>response(Buffer.from(JSON.stringify(data.manifest)))),crypto:options.crypto||require('node:crypto').webcrypto,btoa:s=>Buffer.from(s,'binary').toString('base64'),
  navigator:options.navigator||{},MessageChannel:options.MessageChannel};
 vm.runInNewContext(source,context);return {engine:window.MineralEngine,state,data,fire(ms){const timer=[...state.timers].find(([,t])=>t.ms===ms);assert.ok(timer,'expected engine timer');state.timers.delete(timer[0]);timer[1].fn();}};
}
function released(state){assert.ok(state.images.length>0);assert.ok(state.images.every(img=>img.src===''&&img.released),'owned decoded images must release their source');assert.ok(state.canvases.every(c=>c.width===0&&c.height===0),'owned canvases must release their backing store');}
test('analysis releases only its owned decoded images and crop canvases before inference',async()=>{
 const h=harness({beforeClassify:released});const photos=[{src:'submitted-photo-1'},{src:'submitted-photo-2'}];assert.equal((await h.engine.analyze(photos,{precision:false})).key,'quartz');released(h.state);assert.deepEqual(photos,[{src:'submitted-photo-1'},{src:'submitted-photo-2'}]);
});
test('quality rejection releases the decoded image/canvas and permits a fresh analysis',async()=>{
 const h=harness();h.state.rejectQuality=true;await assert.rejects(h.engine.analyze([{src:'dark'}]),/偏暗/);released(h.state);assert.equal(h.state.classifications,0);h.state.rejectQuality=false;assert.equal((await h.engine.analyze([{src:'retry'}])).key,'quartz');released(h.state);
});
test('cancel after decode resolves releases the image before any canvas or inference allocation',async()=>{
 const controller=new AbortController(),h=harness({afterDecode:()=>controller.abort()});await assert.rejects(h.engine.analyze([{src:'cancelled'}],{signal:controller.signal}),{name:'AbortError'});released(h.state);assert.equal(h.state.canvases.length,0);assert.equal(h.state.classifications,0);
});
test('invalid crop and failures while drawing or reading pixels release owned resources',async()=>{
 for(const options of [{crop:.2},{drawError:true},{pixelError:true}]){const h=harness(options);await assert.rejects(h.engine.analyze([{src:'bad',...(options.crop?{crop:options.crop}:{})}]));released(h.state);assert.equal(h.state.classifications,0);}
});
test('native listener cleanup may be synchronous or throw without stranding a completed analysis',async()=>{
 for(const remove of [()=>undefined,()=>{throw Error('synthetic removal failure');}]){
  const data=fixture(),h=harness({plugin:{addListener:async()=>({remove}),classify:async payload=>raw(data.manifest,payload),cancel:()=>undefined}});
  const result=await observed(h.engine.analyze([{src:'fixture'}],{precision:false}));assert.equal(result.status,'resolved');assert.equal(result.value.key,'quartz');assert.equal((await h.engine.analyze([{src:'retry'}],{precision:false})).key,'quartz');
 }
});
test('an older manifest request cannot overwrite or clear a newer completed preparation',async()=>{
 for(const oldFails of [false,true]){
  const requests=[],h=harness({native:false,fetch:()=>{const d=deferred();requests.push(d);return d.promise;}}),first=h.engine.prepare(),second=h.engine.prepare();
  const newer=fixture().manifest;newer.version='newer';requests[1].resolve(response(Buffer.from(JSON.stringify(newer))));assert.equal((await second).version,'newer');
  if(oldFails){requests[0].reject(Error('older fetch failed'));await assert.rejects(first,/older fetch failed/);}else{requests[0].resolve(response(Buffer.from(JSON.stringify(fixture().manifest))));await first;}
  assert.equal(h.engine.configuration?.version,'newer');assert.notEqual(h.engine.manifestCacheState,'failed');
 }
});
test('manifest deadline settles even when fetch ignores AbortSignal',async()=>{
 const h=harness({native:false,fetch:()=>new Promise(()=>{})}),pending=h.engine.prepare();h.fire(15000);const result=await observed(pending);assert.equal(result.status,'rejected');assert.match(result.error.message,/15 秒/);assert.equal(h.engine.manifestCacheState,'failed');
});
test('manifest deadline also covers a stalled digest after the response was read',async()=>{
 const begun=deferred(),h=harness({native:false,crypto:{subtle:{digest:()=>{begun.resolve();return new Promise(()=>{});}}}}),pending=h.engine.prepare();await begun.promise;h.fire(15000);const result=await observed(pending);assert.equal(result.status,'rejected');assert.match(result.error.message,/15 秒/);
});
function scriptedWorker(script,state){
 return class {
  constructor(){this.number=++state.instances;setImmediate(()=>this.emit({type:'ready'}));}
  emit(data){try{this.onmessage?.({data});}catch(error){state.eventErrors.push(error);}}
  postMessage(payload){setImmediate(()=>script(this,payload));}
  terminate(){this.terminated=true;state.terminated++;}
 };
}
test('worker progress callback exceptions reject promptly and discard the worker for a manual retry',async()=>{
 const state={instances:0,terminated:0,eventErrors:[]},data=fixture(),Worker=scriptedWorker((w,payload)=>w.number===1?w.emit({type:'progress',message:'synthetic-progress'}):w.emit({type:'result',...raw(data.manifest,payload)}),state),h=harness({native:false,Worker}),controller=new AbortController();
 const pending=h.engine.analyze([{src:'fixture'}],{signal:controller.signal,report:message=>{if(message==='synthetic-progress')throw Error('synthetic report failure');}});
 try{const result=await observed(pending);assert.equal(result.status,'rejected');assert.match(result.error.message,/synthetic report failure/);assert.equal(state.eventErrors.length,0);assert.equal(state.terminated,1);assert.equal((await h.engine.analyze([{src:'retry'}])).key,'quartz');}finally{controller.abort();void pending.catch(()=>{});}
});
test('cache-repair channel creation failure cannot strand the original worker error',async()=>{
 const state={instances:0,terminated:0,eventErrors:[]},Worker=scriptedWorker(w=>{w.emit({type:'resource-invalid',url:'https://localhost/models/mobilenet_int8.onnx'});w.emit({type:'error',message:'synthetic model checksum failure'});},state),h=harness({native:false,Worker,navigator:{serviceWorker:{controller:{postMessage(){}}}},MessageChannel:class {constructor(){throw Error('synthetic channel unavailable');}}}),controller=new AbortController();
 const pending=h.engine.analyze([{src:'fixture'}],{signal:controller.signal});try{const result=await observed(pending);assert.equal(result.status,'rejected');assert.match(result.error.message,/synthetic model checksum failure/);assert.match(result.error.message,/缓存/);assert.equal(state.terminated,1);}finally{controller.abort();void pending.catch(()=>{});}
});
test('worker termination failure cannot consume rejection or leave the stale worker selected',async()=>{
 const state={instances:0,terminated:0,eventErrors:[]},data=fixture(),Base=scriptedWorker((w,p)=>w.emit(w.number===1?{type:'boot-error',message:'synthetic startup failure'}:{type:'result',...raw(data.manifest,p)}),state),Worker=class extends Base {terminate(){super.terminate();throw Error('synthetic termination failure');}},h=harness({native:false,Worker}),controller=new AbortController();
 const pending=h.engine.analyze([{src:'fixture'}],{signal:controller.signal});try{const result=await observed(pending);assert.equal(result.status,'rejected');assert.match(result.error.message,/synthetic startup failure/);assert.equal((await h.engine.analyze([{src:'retry'}])).key,'quartz');assert.equal(state.instances,2);}finally{controller.abort();void pending.catch(()=>{});}
});
test('a startup progress callback failure discards the worker before it can post an analysis',async()=>{
 const state={instances:0,terminated:0,eventErrors:[]};let posts=0;
 const Worker=scriptedWorker(()=>posts++,state),h=harness({native:false,Worker});await assert.rejects(h.engine.analyze([{src:'fixture'}],{report:message=>{if(message.includes('启动浏览器'))throw Error('synthetic startup observer failure');}}),/synthetic startup observer failure/);await tick();assert.equal(state.terminated,1);assert.equal(posts,0);
});
test('cancellation reaches a synchronous native cancel method without losing AbortError',async()=>{
 const begun=deferred();let cancelled=0;const controller=new AbortController(),h=harness({plugin:{addListener:async()=>({remove:()=>undefined}),classify:()=>{begun.resolve();return new Promise(()=>{});},cancel:()=>{cancelled++;}}});
 const pending=h.engine.analyze([{src:'fixture'}],{signal:controller.signal});await begun.promise;controller.abort();const result=await observed(pending);assert.equal(result.status,'rejected');assert.equal(result.error.name,'AbortError');assert.equal(cancelled,1);
});
test('a native progress callback failure cancels its matching job and settles the analysis',async()=>{
 let callback,payload,cancelled;const begun=deferred(),h=harness({plugin:{addListener:async(name,fn)=>{callback=fn;return {remove:()=>undefined};},classify:p=>{payload=p;begun.resolve();return new Promise(()=>{});},cancel:p=>{cancelled=p;}}});
 const pending=h.engine.analyze([{src:'fixture'}],{report:message=>{if(message==='synthetic native progress')throw Error('synthetic native observer failure');}});await begun.promise;callback({jobId:payload.jobId,message:'synthetic native progress'});const result=await observed(pending);assert.equal(result.status,'rejected');assert.match(result.error.message,/synthetic native observer failure/);assert.equal(cancelled.jobId,payload.jobId);
});
test('an already-aborted manifest fetch still consumes its underlying rejected promise',async()=>{
 const controller=new AbortController(),h=harness({native:false,fetch:()=>{controller.abort();return Promise.reject(Error('synthetic ignored transport rejection'));}});await assert.rejects(h.engine.prepare({signal:controller.signal}),{name:'AbortError'});await tick();
});
test('an already-aborted unresponsive transport does not retain the engine abort listener',async()=>{
 const controller=new AbortController();let transportSignal;
 const h=harness({native:false,fetch:(url,options)=>{transportSignal=options.signal;controller.abort();return new Promise(()=>{});}}),pending=h.engine.prepare({signal:controller.signal});
 const result=await observed(pending);assert.equal(result.status,'rejected');assert.equal(result.error.name,'AbortError');assert.equal(getEventListeners(transportSignal,'abort').length,0);
});
