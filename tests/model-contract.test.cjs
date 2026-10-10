const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const WEB=fs.existsSync(require('node:path').join(__dirname,'../web/core.js'))?'../web/':'../';
const Core=require(WEB+'core.js');
const {fixture,response,raw,hash,labels}=require('./helpers/model-contract.cjs');
const clone=v=>JSON.parse(JSON.stringify(v));
test('manifest chooses a two-classifier ensemble and a deliberate one-classifier fast mode',()=>{
  const manifest=Core.validateManifest(fixture().manifest,labels);
  assert.deepEqual(Core.selectedModels(manifest).map(m=>m.id),['mobilenet','efficientnet']);
  assert.deepEqual(Core.selectedModels(manifest,false).map(m=>m.id),['mobilenet']);
  assert.ok(Object.isFrozen(manifest.labels));assert.ok(Object.isFrozen(manifest.models[0]));
});
test('manifest rejects version/label/normalization drift, unsafe paths, bytes, gate calibration and mode mismatch',()=>{
  const changes=[m=>m.schemaVersion=2,m=>m.version='',m=>m.labels.reverse(),m=>m.input.layout='NHWC',m=>m.input.normalization.std[0]=0,m=>m.input.colorSpace='BGR',m=>m.input.shape[2]=100000,m=>m.models[0].path='models/../secret',m=>m.models[0].sha256='x'.repeat(64),m=>m.models[0].bytes=80000001,m=>m.models[0].bytes=1.5,m=>m.models[2].temperature=2,m=>m.modes.ensemble=['mobilenet'],m=>m.modes.fast=['mobilenet','efficientnet'],m=>m.models[1].id='mobilenet',m=>m.models[0].classes=99,m=>m.models[0].output='probabilities'];
  for(const change of changes){const m=clone(fixture().manifest);change(m);assert.throws(()=>Core.validateManifest(m,labels));}
});
test('preprocessing produces finite channel-major float32 values for all RGB boundaries',()=>{
  const m=Core.validateManifest(fixture().manifest),pixels=new Uint8ClampedArray(224*224*4);
  for(let i=0;i<224*224;i++)pixels.set([i%256,(i+31)%256,(i+67)%256,255],i*4);
  const input=Core.pixelsToInput(pixels,m.input);
  for(let c=0;c<3;c++)for(let i=0;i<224*224;i++)assert.equal(input[c*224*224+i],Math.fround((pixels[i*4+c]/255-m.input.normalization.mean[c])/m.input.normalization.std[c]));
});
test('resource readers stop oversized streams, require exact model bytes and cancel failed readers',async()=>{
  let cancelled=false;
  const oversized={ok:true,headers:{get:()=>''},body:{getReader:()=>({read:async()=>({done:false,value:new Uint8Array(11)}),cancel:async()=>cancelled=true,releaseLock(){}})}};
  await assert.rejects(Core.readResource(oversized,10),/大小/);assert.equal(cancelled,true);
  await assert.rejects(Core.readResource(response([1,2]),80,3),/大小/);
  await assert.rejects(Core.readResource({...response([1]),headers:{get:()=> 'text/html'}},80,1),/网页/);
});
test('partial, duplicate and version-mixed model results cannot silently become a mineral candidate',()=>{
  const m=Core.validateManifest(fixture().manifest),models=Core.selectedModels(m),valid=raw(m),digest=valid.manifestSha256;
  Core.validateAnalysis(valid,1,models,m,digest);
  const changes=[r=>r.runs.pop(),r=>r.runs[1]=r.runs[0],r=>r.runs[0]=null,r=>r.screening=[],r=>r.screening[0].values.pop(),r=>r.screening[0]=null,r=>r.modelVersion='old',r=>r.manifestSha256='0'.repeat(64),r=>r.runs[0].values=[NaN,1]];
  for(const change of changes){const r=clone(valid);change(r);assert.throws(()=>Core.validateAnalysis(r,1,models,m,digest));}
});
test('explicit logits and validation-set temperature preserve argmax without inflating probability',()=>{
  const cool=Core.summarize([{photo:0,model:'a',values:[4,0],output:'logits',temperature:1}],labels);
  const calibrated=Core.summarize([{photo:0,model:'a',values:[4,0],output:'logits',temperature:2}],labels);
  assert.equal(cool.key,calibrated.key);assert.ok(calibrated.score<cool.score);
  assert.throws(()=>Core.summarize([{photo:0,model:'a',values:[4,0],temperature:0}],labels));
});
test('specimen backup and restore preserve the model identity without trusting malformed imported hashes',()=>{
  const record={rankings:[{key:'quartz',score:.75}],modelCount:2,modelVersion:'2.5.0-models',manifestSha256:'a'.repeat(64)};
  const saved=Core.sanitizeRecord(record),restored=Core.parseImport(JSON.stringify({schema:'shikuang-records',version:2,records:[saved]}))[0];
  assert.equal(restored.modelVersion,record.modelVersion);assert.equal(restored.manifestSha256,record.manifestSha256);
  assert.equal(Core.sanitizeRecord({...record,manifestSha256:'../../model'}).manifestSha256,'');
  assert.equal(Core.sanitizeRecord({...record,modelVersion:'<script>'}).modelVersion,'');
});
function workerHarness({metadata,outputClassDelta=0}={}) {
  let current=fixture(),failPath='',loaded=0,released=0;
  const messages=[];
  class Tensor {constructor(type,data,dims){this.type=type;this.data=data;this.dims=dims;}dispose(){}}
  const context={URL,TextDecoder,Float32Array,MineralCore:Core,self:{location:{origin:'https://localhost'}},importScripts(){},postMessage:m=>messages.push(m),onmessage:null,crypto:require('node:crypto').webcrypto,ort:{env:{wasm:{}},Tensor,InferenceSession:{create:async bytes=>{loaded++;const gate=bytes[0]===3;return {inputNames:['input'],outputNames:['output'],...(metadata?{inputMetadata:[{isTensor:true,type:'float32',shape:metadata}],outputMetadata:[{isTensor:true,type:'float32',shape:['batch',gate?1000:2]}]}:{}),run:async()=>({output:new Tensor('float32',gate?new Float32Array(1000):new Float32Array([4,0]),[1,(gate?1000:2)+outputClassDelta])}),release:async()=>released++};}}},fetch:async url=>{
    if(url.pathname.endsWith('model-manifest.json'))return response(Buffer.from(JSON.stringify(current.manifest)));
    const path=url.pathname.slice(1);return path===failPath?response([],404):response(current.files[path]||[],current.files[path]?200:404);
  }};
  vm.runInNewContext(fs.readFileSync(require.resolve(WEB+'engine-worker.js'),'utf8'),context);
  return {messages,get loaded(){return loaded;},get released(){return released;},fail:path=>failPath=path,update:data=>current=data,async analyze(mode='ensemble'){const text=Buffer.from(JSON.stringify(current.manifest));await context.onmessage({data:{type:'analyze',base:'https://localhost/',inputs:[new Float32Array(3*224*224)],labels,modelIds:current.manifest.modes[mode],mode,manifestSha256:hash(text),screen:true,blocked:Array(1000).fill(false)}});return messages.at(-1);}};
}
test('worker reuses identical sessions but releases every old session after manifest identity changes',async()=>{
  const w=workerHarness();assert.equal((await w.analyze()).type,'result');assert.equal(w.loaded,3);
  await w.analyze();assert.equal(w.loaded,3);
  const next=fixture();next.manifest.version='2.5.1-test';next.files['models/mobilenet_int8.onnx']=Buffer.from([4]);next.manifest.models[0].sha256=hash(next.files['models/mobilenet_int8.onnx']);
  w.update(next);assert.equal((await w.analyze()).type,'result');assert.equal(w.released,3);assert.equal(w.loaded,6);
});
test('selected second classifier failure clears sessions and emits no partial ensemble result',async()=>{
  const w=workerHarness();w.fail('models/efficientnet.onnx');
  const result=await w.analyze();assert.equal(result.type,'error');assert.match(result.message,/404/);
  assert.equal(w.messages.some(m=>m.type==='result'),false);assert.equal(w.released,2);
  w.fail('');assert.equal((await w.analyze()).type,'result');assert.equal(w.loaded,5);
});
test('switching to fast mode releases unselected classifiers without reloading its gate or classifier',async()=>{
  const w=workerHarness();assert.equal((await w.analyze()).type,'result');assert.equal(w.loaded,3);
  const fast=await w.analyze('fast');assert.equal(fast.type,'result');assert.equal(fast.runs.length,1);assert.equal(w.loaded,3);assert.equal(w.released,1);
  assert.equal((await w.analyze()).type,'result');assert.equal(w.loaded,4);assert.equal(w.released,1);
});
test('worker accepts only a symbolic batch dimension and checks the actual output tensor shape',async()=>{
  assert.equal((await workerHarness({metadata:['batch',3,224,224]}).analyze()).type,'result');
  for(const metadata of [['batch',224,224,3],['batch',3,'height',224],['batch',3,112,112]]){
    const w=workerHarness({metadata});assert.equal((await w.analyze()).type,'error');assert.equal(w.released,1);assert.equal(w.messages.some(m=>m.type==='result'),false);
  }
  const w=workerHarness({outputClassDelta:1});assert.equal((await w.analyze()).type,'error');assert.equal(w.messages.some(m=>m.type==='result'),false);
});
