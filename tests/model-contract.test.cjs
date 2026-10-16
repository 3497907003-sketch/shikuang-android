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
function workerHarness({metadata,outputClassDelta=0,beforeRelease=async()=>{},onPostMessage=()=>{}}={}) {
  let current=fixture(),failPath='',loaded=0,released=0;
  const messages=[],resident=new Set(),created=[];let peakResident=0;
  class Tensor {constructor(type,data,dims){this.type=type;this.data=data;this.dims=dims;}dispose(){}}
  const create=async bytes=>{
    loaded++;created.push(bytes[0]);const gate=bytes[0]===3;
    const session={inputNames:['input'],outputNames:['output'],
      ...(metadata?{inputMetadata:[{isTensor:true,type:'float32',shape:metadata}],outputMetadata:[{isTensor:true,type:'float32',shape:['batch',gate?1000:2]}]}:{}),
      run:async()=>{assert.ok(resident.has(session),'Cannot run a released session');return {output:new Tensor('float32',gate?new Float32Array(1000):new Float32Array([4,0]),[1,(gate?1000:2)+outputClassDelta])};},
      release:async()=>{await beforeRelease();assert.equal(resident.delete(session),true,'Cannot release a session twice');released++;}};
    resident.add(session);peakResident=Math.max(peakResident,resident.size);return session;
  };
  const context={URL,TextDecoder,Float32Array,MineralCore:Core,self:{location:{origin:'https://localhost'}},importScripts(){},postMessage:m=>{messages.push(m);onPostMessage(m);},onmessage:null,crypto:require('node:crypto').webcrypto,ort:{env:{wasm:{}},Tensor,InferenceSession:{create}},fetch:async url=>{
    if(url.pathname.endsWith('model-manifest.json'))return response(Buffer.from(JSON.stringify(current.manifest)));
    const path=url.pathname.slice(1);return path===failPath?response([],404):response(current.files[path]||[],current.files[path]?200:404);
  }};
  vm.runInNewContext(fs.readFileSync(require.resolve(WEB+'engine-worker.js'),'utf8'),context);
  return {messages,created,dispatch:data=>context.onmessage({data}),get loaded(){return loaded;},get released(){return released;},get resident(){return resident.size;},get peakResident(){return peakResident;},fail:path=>failPath=path,update:data=>current=data,async analyze(mode='ensemble',photos=1){const text=Buffer.from(JSON.stringify(current.manifest));await context.onmessage({data:{type:'analyze',base:'https://localhost/',inputs:Array.from({length:photos},()=>new Float32Array(3*224*224)),labels,modelIds:current.manifest.modes[mode],mode,manifestSha256:hash(text),screen:true,blocked:Array(1000).fill(false)}});return messages.at(-1);}};
}
test('worker retains the gate and one classifier, and releases old identities before loading a changed manifest',async()=>{
  const w=workerHarness();assert.equal((await w.analyze()).type,'result');assert.equal(w.loaded,3);
  const repeated=await w.analyze('ensemble',3);assert.equal(repeated.runs.length,6);assert.equal(repeated.screening.length,3);
  assert.equal(w.loaded,5);assert.equal(w.released,3);assert.equal(w.resident,2);assert.equal(w.peakResident,2);
  assert.equal(w.created.filter(tag=>tag===3).length,1);
  const next=fixture();next.manifest.version='2.5.1-test';next.files['models/mobilenet_int8.onnx']=Buffer.from([4]);next.manifest.models[0].sha256=hash(next.files['models/mobilenet_int8.onnx']);
  w.update(next);assert.equal((await w.analyze()).type,'result');assert.equal(w.released,6);assert.equal(w.loaded,8);
  assert.equal(w.created.filter(tag=>tag===3).length,2);assert.equal(w.resident,2);assert.equal(w.peakResident,2);
});
test('worker awaits classifier release before allocating the next classifier',async()=>{
  let allowRelease,releaseStarted;
  const blocked=new Promise(resolve=>allowRelease=resolve),started=new Promise(resolve=>releaseStarted=resolve);
  const w=workerHarness({beforeRelease:async()=>{releaseStarted();await blocked;}}),pending=w.analyze();
  await started;assert.equal(w.loaded,2);assert.equal(w.resident,2);assert.equal(w.peakResident,2);
  assert.equal(w.messages.some(m=>m.type==='result'),false);
  allowRelease();assert.equal((await pending).type,'result');assert.equal(w.loaded,3);assert.equal(w.resident,2);assert.equal(w.peakResident,2);
});
test('selected second classifier failure clears sessions and emits no partial ensemble result',async()=>{
  const w=workerHarness();w.fail('models/efficientnet.onnx');
  const result=await w.analyze();assert.equal(result.type,'error');assert.match(result.message,/404/);
  assert.equal(w.messages.some(m=>m.type==='result'),false);assert.equal(w.released,2);assert.equal(w.resident,0);assert.equal(w.peakResident,2);
  w.fail('');assert.equal((await w.analyze()).type,'result');assert.equal(w.loaded,5);
});
test('mode switching retains the gate, reuses fast-mode sessions, and bounds ensemble sessions',async()=>{
  const w=workerHarness();assert.equal((await w.analyze()).type,'result');assert.equal(w.loaded,3);
  const fast=await w.analyze('fast');assert.equal(fast.type,'result');assert.equal(fast.runs.length,1);assert.equal(w.loaded,4);assert.equal(w.released,2);
  await w.analyze('fast');assert.equal(w.loaded,4);assert.equal(w.released,2);
  assert.equal((await w.analyze()).type,'result');assert.equal(w.loaded,5);assert.equal(w.released,3);
  assert.equal(w.created.filter(tag=>tag===3).length,1);assert.equal(w.resident,2);assert.equal(w.peakResident,2);
});
test('worker accepts only a symbolic batch dimension and checks the actual output tensor shape',async()=>{
  assert.equal((await workerHarness({metadata:['batch',3,224,224]}).analyze()).type,'result');
  for(const metadata of [['batch',224,224,3],['batch',3,'height',224],['batch',3,112,112]]){
    const w=workerHarness({metadata});assert.equal((await w.analyze()).type,'error');assert.equal(w.released,1);assert.equal(w.messages.some(m=>m.type==='result'),false);
  }
  const w=workerHarness({outputClassDelta:1});assert.equal((await w.analyze()).type,'error');assert.equal(w.messages.some(m=>m.type==='result'),false);
});
test('failed manifest cleanup retains unconfirmed sessions and cannot allocate or succeed again',async()=>{
  let fail=false;
  const w=workerHarness({beforeRelease:async()=>{if(fail)throw Error('software release rejection');}});
  assert.equal((await w.analyze()).type,'result');assert.equal(w.loaded,3);assert.equal(w.resident,2);
  const successes=w.messages.filter(m=>m.type==='result').length;
  const next=fixture();next.manifest.version='software-changed-manifest';w.update(next);fail=true;
  assert.equal((await w.analyze()).type,'error');assert.equal(w.loaded,3);assert.equal(w.resident,2);assert.equal(w.peakResident,2);
  assert.equal(w.messages.at(-1).workerResetRequired,true);assert.equal(w.messages.filter(m=>m.type==='result').length,successes);
  fail=false;assert.equal((await w.analyze('fast')).type,'error');assert.equal(w.loaded,3);assert.equal(w.resident,2);
});
test('classifier replacement release rejection retains references and fails before the next allocation',async()=>{
  const w=workerHarness({beforeRelease:async()=>{throw Error('software release rejection');}});
  const result=await w.analyze();assert.equal(result.type,'error');assert.equal(result.workerResetRequired,true);
  assert.equal(w.loaded,2);assert.equal(w.resident,2);assert.equal(w.messages.some(m=>m.type==='result'),false);
  assert.equal((await w.analyze()).type,'error');assert.equal(w.loaded,2);
});
test('outer failure cleanup and rejected metadata release cannot masquerade as successful cleanup',async()=>{
  for(const config of [{outputClassDelta:1},{metadata:['batch',3,112,112]}]){
    const w=workerHarness({...config,beforeRelease:async()=>{throw Error('software release rejection');}});
    const result=await w.analyze();assert.equal(result.type,'error');assert.equal(result.workerResetRequired,true);
    assert.equal(w.loaded,1);assert.equal(w.resident,1);assert.equal(w.released,0);
    assert.equal((await w.analyze()).type,'error');assert.equal(w.loaded,1);
  }
});

// Genuine Node Worker threads bridge the unchanged main workerRun control flow
// to the actual Worker program with software sessions. No WASM or model weights.
test('main engine terminates a genuine software Worker on release rejection, cancellation and overall deadline',{timeout:5000},async()=>{
  const {Worker:ThreadWorker}=require('node:worker_threads'),path=require('node:path');
  const workerRunSource=fs.readFileSync(require.resolve(WEB+'inference.js'),'utf8');
  const fragment=workerRunSource.slice(workerRunSource.indexOf('  function workerRun('),workerRunSource.indexOf('  async function evictResource('));
  for(const scenario of ['reject','cancel-hang','timeout-hang']){
    let began;const started=new Promise(resolve=>began=resolve),instances=[],deadlines=[];
    const child=`const {parentPort,workerData}=require('node:worker_threads');
      const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
      const WEB=workerData.web,Core=require(workerData.core);
      const {fixture,response,hash,labels}=require(workerData.helper);
      ${workerHarness.toString()}
      const w=workerHarness({onPostMessage:m=>parentPort.postMessage(m),beforeRelease:async()=>{
        parentPort.postMessage({softwareReleaseStarted:true});
        if(workerData.reject)throw Error('software release rejection');
        await new Promise(()=>{});
      }});
      parentPort.on('message',payload=>{void w.dispatch(payload).catch(e=>parentPort.postMessage({type:'software-unhandled-error',message:e.message}));});`;
    class WorkerBridge {
      constructor(){instances.push(this);this.terminationCalls=0;
        this.thread=new ThreadWorker(child,{eval:true,workerData:{web:path.dirname(require.resolve(WEB+'core.js'))+path.sep,
          core:require.resolve(WEB+'core.js'),helper:require.resolve('./helpers/model-contract.cjs'),reject:scenario==='reject'}});
        this.thread.on('message',data=>{if(data.softwareReleaseStarted)began();else this.onmessage?.({data});});
        this.thread.on('error',error=>this.onerror?.({message:error.message}));
      }
      postMessage(payload){this.thread.postMessage(payload);}
      terminate(){this.terminationCalls++;this.termination=this.thread.terminate();}
    }
    const context={URL,DOMException,Worker:WorkerBridge,location:{href:'https://localhost/index.html'},
      window:{Worker:WorkerBridge,IMAGENET_BLOCKED:Array(1000).fill(false),MINERAL_KB:{}},
      setTimeout:(fn,ms)=>ms===120000?(deadlines.push(fn),{softwareOverallDeadline:true}):setTimeout(fn,ms),
      clearTimeout:id=>{if(!id?.softwareOverallDeadline)clearTimeout(id);}};
    vm.runInNewContext("let worker,workerReady=false;const abort=signal=>{if(signal?.aborted)throw new DOMException('分析已停止','AbortError');};"+fragment+'\nthis.run=workerRun;',context);
    const controller=new AbortController(),pending=context.run([new Float32Array(3*224*224)],labels,{signal:controller.signal,
      report:()=>{},models:Core.selectedModels(fixture().manifest),manifestHash:hash(Buffer.from(JSON.stringify(fixture().manifest)))});
    // Attach the observer before the real thread can reject the main promise.
    const settled=pending.then(value=>({value}),error=>({error}));
    let bounded;
    try {
      await Promise.race([started,new Promise((_,reject)=>bounded=setTimeout(()=>reject(Error('software Worker release did not start')),1500))]);clearTimeout(bounded);
      if(scenario==='cancel-hang')controller.abort();
      if(scenario==='timeout-hang'){assert.equal(deadlines.length,1);deadlines[0]();}
      const outcome=await settled;assert.ok(outcome.error);assert.equal(outcome.value,undefined);
      assert.equal(instances[0].terminationCalls,1);assert.equal(await instances[0].termination,1);
      assert.equal(instances[0].onmessage,null);
      if(scenario==='reject')assert.match(outcome.error.message,/释放失败/);
      if(scenario==='cancel-hang')assert.equal(outcome.error.name,'AbortError');
      if(scenario==='timeout-hang')assert.match(outcome.error.message,/120 秒/);
    } finally {clearTimeout(bounded);for(const instance of instances)await instance.thread.terminate();}
  }
});
