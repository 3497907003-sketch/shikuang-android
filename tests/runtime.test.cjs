const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Core = require('../web/core.js');
const source = fs.readFileSync(require.resolve('../web/inference.js'), 'utf8');
const keys = ['quartz', 'calcite'];
const pixels = new Uint8ClampedArray(224 * 224 * 4);
for (let i=0;i<224*224;i++) { const n=i%2?180:65; pixels.set([n,n+10,n+20,255],i*4); }
const raw = () => ({runs:[{photo:0,model:'mobilenet',values:[.9,.1]}],screening:[{photo:0,values:Array(1000).fill(0)}],warnings:[]});
function harness(plugin, native=true, Worker, bundledBridge=false, decode=()=>Promise.resolve()) {
  const window={MINERAL_KB:{quartz:{name_zh:'石英'},calcite:{}},IMAGENET_BLOCKED:[],Worker,
    Capacitor:{isNativePlatform:()=>native,isPluginAvailable:()=>!!plugin,
      ...(bundledBridge?{Plugins:{MineralInference:plugin}}:{registerPlugin:()=>plugin})}};
  const context={window,MINERAL_KB:window.MINERAL_KB,MINERAL_CLASSES:Object.fromEntries(keys.map(k=>[k,k])),MineralCore:Core,
    document:{createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:pixels})})})},
    Image:class {naturalWidth=224;naturalHeight=224;decode(){return decode();}},
    URL,location:{href:'https://localhost/index.html'},Worker,setTimeout,clearTimeout,DOMException,
    crypto:require('node:crypto').webcrypto,btoa:s=>Buffer.from(s,'binary').toString('base64')};
  vm.runInNewContext(source,context);
  return window.MineralEngine;
}
test('Android uses native plugin with identical NCHW preprocessing; never starts a Worker',async()=>{
  let payload,removed=0;
  const engine=harness({addListener:async()=>({remove:async()=>removed++}),classify:async p=>{payload=p;return raw();},cancel:async()=>{}},true,class {constructor(){throw Error('Worker should not start');}});
  const result=await engine.analyze([{src:'fixture'}],{precision:false});
  assert.equal(result.engine,'onnx-native-android');assert.equal(result.key,'quartz');assert.equal(payload.models.length,1);
  const bytes=Buffer.from(payload.inputs[0],'base64');assert.equal(bytes.length,3*224*224*4);
  assert.ok(Math.abs(bytes.readFloatLE(0)-(65/255-.485)/.229)<1e-6);
  assert.ok(Math.abs(bytes.readFloatLE(224*224*4)-(75/255-.456)/.224)<1e-6);
  assert.deepEqual(Array.from(payload.labels),keys);assert.equal(removed,1);
});
test('cancel during stalled photo decode stops before dispatching either inference engine',async()=>{
  const engine=harness(null,true,undefined,false,()=>new Promise(()=>{})),controller=new AbortController();
  const pending=engine.analyze([{src:'fixture'}],{signal:controller.signal});controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
});
test('plain packaged Capacitor bridge works without npm registerPlugin runtime',async()=>{
  const engine=harness({addListener:()=>({remove:async()=>{}}),classify:async()=>raw(),cancel:async()=>{}},true,undefined,true);
  assert.equal((await engine.analyze([{src:'fixture'}])).engine,'onnx-native-android');
});
test('cancel before listener registration completes removes listener and does not start native job',async()=>{
  let register,jobStarts=0,removed=0,cancelled=0;
  const started=new Promise(resolve=>register=resolve),controller=new AbortController();let handle;
  const engine=harness({addListener:()=>{register();return new Promise(resolve=>handle=resolve);},classify:async()=>{jobStarts++;return raw();},cancel:async()=>cancelled++});
  const pending=engine.analyze([{src:'fixture'}],{signal:controller.signal});await started;controller.abort();
  await assert.rejects(pending,{name:'AbortError'});handle({remove:async()=>removed++});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(jobStarts,0);assert.equal(removed,1);assert.equal(cancelled,1);
});
test('cancel during native inference forwards matching job ID and next analysis succeeds',async()=>{
  let payload,cancelPayload,starts=0,removed=0;
  let begin;const begun=new Promise(resolve=>begin=resolve);
  const engine=harness({addListener:async()=>({remove:async()=>removed++}),classify:p=>{payload=p;starts++;if(starts>1)return Promise.resolve(raw());begin();return new Promise(()=>{});},cancel:async p=>cancelPayload=p});
  const controller=new AbortController(),pending=engine.analyze([{src:'fixture'}],{signal:controller.signal});
  await begun;controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(cancelPayload.jobId,payload.jobId);
  assert.equal((await engine.analyze([{src:'fixture'}])).key,'quartz');assert.equal(removed,2);
});
test('native missing component and failed input screening cannot produce a mineral candidate',async()=>{
  await assert.rejects(harness(null).analyze([{src:'fixture'}]),/缺少原生识别组件/);
  const engine=harness({addListener:async()=>({remove:async()=>{}}),classify:async()=>({...raw(),screening:[]}),cancel:async()=>{}});
  await assert.rejects(engine.analyze([{src:'fixture'}]),/输入筛查未完成/);
});
test('native rejected input yields the exact non-mineral message, even before remaining angles',async()=>{
  const engine=harness({addListener:async()=>({remove:async()=>{}}),classify:async()=>({runs:[],screening:[],warnings:[],rejected:true}),cancel:async()=>{}});
  await assert.rejects(engine.analyze([{src:'fixture'},{src:'fixture'}]),{message:Core.NON_MINERAL});
});
test('browser waits for worker readiness and reports bootstrap failures with a reusable retry',async()=>{
  let instances=[];
  class FakeWorker {
    constructor(){instances.push(this);setImmediate(()=>this.onmessage?.({data:{type:instances.length===1?'boot-error':'ready',message:'missing runtime'}}));}
    postMessage(){this.posted=true;setImmediate(()=>this.onmessage?.({data:{type:'result',...raw()}}));}
    terminate(){this.terminated=true;}
  }
  const engine=harness(null,false,FakeWorker);
  await assert.rejects(engine.analyze([{src:'fixture'}]),/missing runtime/);
  assert.equal(instances[0].posted,undefined);assert.equal(instances[0].terminated,true);
  assert.equal((await engine.analyze([{src:'fixture'}])).engine,'onnx-worker-wasm');assert.equal(instances[1].posted,true);
});
test('worker fails closed if the screening model cannot load; never emits mineral results',async()=>{
  const messages=[],modelFetches=[];
  const context={URL,onmessage:null,postMessage:m=>messages.push(m),importScripts(){},ort:{env:{wasm:{}}},
    fetch:async url=>url.pathname.endsWith('model-manifest.json')?{ok:true,json:async()=>({labels:keys,models:[{path:'models/imagenet_gate.onnx',sha256:'0'.repeat(64)}]})}:(modelFetches.push(url.pathname),{ok:false,status:404})};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/engine-worker.js'),'utf8'),context);
  assert.equal(messages[0].type,'ready');
  await context.onmessage({data:{type:'analyze',base:'https://localhost/',inputs:[new Float32Array(3*224*224)],labels:keys,models:[{file:'mobilenet_int8.onnx'}],screen:true,blocked:[]}});
  assert.equal(messages.at(-1).type,'error');assert.match(messages.at(-1).message,/404/);
  assert.equal(modelFetches.length,1);assert.equal(messages.some(m=>m.type==='result'),false);
});
