const test=require('node:test'),assert=require('node:assert/strict');
const Media=require('../web/media.js'),{fixture}=require('./helpers/app-fixture.cjs');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const picture=src=>({src,naturalWidth:256,naturalHeight:256});
const result=score=>({key:'quartz',score,status:'uncertain',reasons:[],rankings:[{key:'quartz',score}],checks:[],agreement:1,photoCount:1,modelCount:1});
function png(width,height){const bytes=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);return bytes;}
function jpeg(width,height,marker=192){const bytes=Buffer.from([255,216,255,225,0,4,0,0,255,marker,0,8,8,0,0,0,0,1]);bytes.writeUInt16BE(height,13);bytes.writeUInt16BE(width,15);return bytes;}
function webp(kind,width,height){const payload=Buffer.alloc(kind==='VP8L'?5:10);if(kind==='VP8X'){payload.writeUIntLE(width-1,4,3);payload.writeUIntLE(height-1,7,3);}else if(kind==='VP8L'){payload[0]=47;payload.writeUInt32LE(((height-1)<<14)|(width-1),1);}else{payload[3]=157;payload[4]=1;payload[5]=42;payload.writeUInt16LE(width,6);payload.writeUInt16LE(height,8);}const bytes=Buffer.alloc(20+payload.length);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WEBP',8);bytes.write(kind,12);bytes.writeUInt32LE(payload.length,16);payload.copy(bytes,20);return bytes;}

test('compressed PNG, baseline/progressive JPEG and all three WebP headers expose dimensions without decode',()=>{
  for(const bytes of [png(4032,3024),jpeg(4032,3024),jpeg(4032,3024,194),webp('VP8X',4032,3024),webp('VP8L',4032,3024),webp('VP8 ',4032,3024)]){
    const dimensions=Media.imageDimensions(bytes);assert.equal(dimensions.width,4032);assert.equal(dimensions.height,3024);
  }
});
test('unknown, corrupt, zero and oversized compressed image dimensions fail closed',()=>{
  for(const bytes of [Buffer.from('fake image/jpeg'),Buffer.from('ftypavif'),png(0,300),png(9000,9000),jpeg(10000,10000),webp('VP8X',10000,10000),Buffer.from([255,216,255,225,0,1])])assert.throws(()=>Media.imageDimensions(bytes));
  for(const [width,height] of [[0,100],[100,0],[NaN,100],[Infinity,100],[1.5,100],[9000,9000]])assert.throws(()=>Media.scaledDimensions(width,height));
  assert.deepEqual(Media.scaledDimensions(3072,2048),{width:1536,height:1024});
  assert.deepEqual(Media.scaledDimensions(1,40000000),{width:1,height:1536});
});
test('photo header read is bounded and the 20MB cap is enforced before any byte read',async()=>{
  let end,reads=0;const file={size:20*1024*1024,slice:(_start,limit)=>{end=limit;reads++;return {arrayBuffer:async()=>png(100,100)};}};
  await Media.validatePhotoFile(file);assert.equal(end,512*1024);assert.equal(reads,1);
  await assert.rejects(Media.validatePhotoFile({...file,size:20*1024*1024+1}),/20 MB/);assert.equal(reads,1);
  const controller=new AbortController();controller.abort();await assert.rejects(Media.validatePhotoFile(file,{signal:controller.signal}),{name:'AbortError'});assert.equal(reads,1);
});
test('older Blob implementations use FileReader without an unbounded fallback or losing abort handling',async()=>{
  const fs=require('node:fs'),vm=require('node:vm');let reader;
  const context={module:{exports:{}},FileReader:class{constructor(){reader=this;}readAsArrayBuffer(){queueMicrotask(()=>{this.result=png(400,300);this.onload?.();});}abort(){this.onabort?.();}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/media.js'),'utf8'),context);
  const file={size:33,slice:()=>({})};const dimensions=await context.module.exports.validatePhotoFile(file);assert.equal(dimensions.width,400);assert.equal(dimensions.height,300);
  context.FileReader.prototype.readAsArrayBuffer=function(){};const controller=new AbortController(),pending=context.module.exports.validatePhotoFile(file,{signal:controller.signal});controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(reader.onload,null);
});
test('oversized file header is rejected before image decode or canvas allocation and a retry still works',async()=>{
  let decodes=0;const f=fixture({engine:{image:async src=>{decodes++;return picture(src);}}});
  f.node('fileInput').files=[f.photoFile(10000,10000)];f.node('fileInput').fire('change');await f.settle();
  assert.equal(decodes,0);assert.equal(f.created.filter(el=>el.id==='canvas').length,0);assert.equal(f.node('preview').hidden,true);assert.equal(f.node('galleryBtn').disabled,false);
  await f.photo();assert.equal(decodes,1);assert.equal(f.node('preview').hidden,false);
});
test('canceled old decode cannot fill a new specimen or unlock its later input task',async()=>{
  const first=deferred(),second=deferred();let calls=0;
  const f=fixture({engine:{image:async src=>{calls++;return calls===1?first.promise:calls===2?second.promise:picture(src);}}});
  await f.photo();assert.equal(f.node('cancelInput').hidden,false);assert.equal(f.node('cancelInput').textContent,'停止照片读取');await f.click('newSample');
  await f.photo();assert.equal(f.node('galleryBtn').disabled,true);
  first.resolve(picture('old'));await f.settle();assert.equal(f.node('preview').hidden,true);assert.equal(f.node('galleryBtn').disabled,true);
  second.resolve(picture('new'));await f.settle();assert.match(f.node('inputSummary').textContent,/已提交 1 张/);assert.equal(f.node('galleryBtn').disabled,false);assert.equal(f.revoked.length,2);
});
test('leaving identification aborts pending photo decode without changing already submitted photos or observations',async()=>{
  const pending=deferred();let calls=0;const f=fixture({engine:{image:async src=>++calls===2?pending.promise:picture(src)}});
  await f.photo();f.node('notes').value='磁性观察';f.node('notes').fire('input');await f.photo();f.route('records');
  pending.resolve(picture('late'));await f.settle();assert.match(f.node('inputSummary').textContent,/已提交 1 张/);assert.equal(f.node('notes').value,'磁性观察');assert.equal(f.node('galleryBtn').disabled,false);
});
test('input overall timeout clears locks immediately and suppresses a late header completion',async()=>{
  let id=0;const timers=new Map(),pending=deferred();const f=fixture({timers:{setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:timer=>timers.delete(timer)}});
  f.node('fileInput').files=[{size:33,slice:()=>({arrayBuffer:()=>pending.promise})}];f.node('fileInput').fire('change');await f.settle();
  const deadline=[...timers.values()].find(timer=>timer.ms===45000);assert.ok(deadline);deadline.fn();assert.equal(f.node('galleryBtn').disabled,false);assert.match(f.node('progress').textContent,/超时/);
  pending.resolve(png(100,100));await f.settle();assert.equal(f.node('preview').hidden,true);assert.match(f.node('progress').textContent,/超时/);
});
test('late camera permission releases only its own stream and camera capture creates a scaled canvas',async()=>{
  const old=deferred(),fresh=deferred();let calls=0,oldStops=0,newStops=0;
  const f=fixture();f.context.navigator.mediaDevices={getUserMedia:()=>++calls===1?old.promise:fresh.promise};
  await f.click('cameraBtn');f.route('records');f.route('identify');await f.click('cameraBtn');
  const freshStream={getTracks:()=>[{stop:()=>newStops++}]};fresh.resolve(freshStream);await f.settle();
  old.resolve({getTracks:()=>[{stop:()=>oldStops++}]});await f.settle();assert.equal(oldStops,1);assert.equal(newStops,0);assert.equal(f.node('cameraPreview').srcObject,freshStream);
  f.node('cameraPreview').videoWidth=3072;f.node('cameraPreview').videoHeight=2048;await f.click('takePhoto');
  const canvas=f.created.find(el=>el.id==='canvas');assert.equal(canvas.width,1536);assert.equal(canvas.height,1024);assert.equal(canvas.drawArgs.length,5);assert.equal(newStops,1);assert.equal(f.node('cameraDialog').open,false);assert.equal(f.node('preview').hidden,false);
});
test('invalid camera dimensions fail before canvas creation and release streams',async()=>{
  let stops=0;const f=fixture();f.context.navigator.mediaDevices={getUserMedia:async()=>({getTracks:()=>[{stop:()=>stops++}]})};await f.click('cameraBtn');
  f.node('cameraPreview').videoWidth=0;f.node('cameraPreview').videoHeight=480;await f.click('takePhoto');
  assert.equal(f.created.filter(el=>el.id==='canvas').length,0);assert.equal(stops,1);assert.equal(f.node('galleryBtn').disabled,false);
});
test('late close from a previous camera dialog does not stop the current open camera',async()=>{
  let stops=0;const f=fixture();const stream={getTracks:()=>[{stop:()=>stops++}]};
  f.context.navigator.mediaDevices={getUserMedia:async()=>stream};await f.click('cameraBtn');
  assert.equal(f.node('cameraDialog').open,true);f.node('cameraDialog').fire('close');
  assert.equal(stops,0);assert.equal(f.node('cameraPreview').srcObject,stream);assert.equal(f.node('galleryBtn').disabled,true);
  f.node('cameraDialog').close();assert.equal(stops,1);assert.equal(f.node('galleryBtn').disabled,false);
});
test('late close from a previous video dialog preserves the active recording',async()=>{
  let stops=0,recorder;const f=fixture();
  f.context.navigator.mediaDevices={getUserMedia:async()=>({getTracks:()=>[{stop:()=>stops++}]})};
  f.context.MediaRecorder=class{constructor(){recorder=this;this.state='inactive';}start(){this.state='recording';}stop(){this.state='inactive';}};
  await f.click('videoBtn');await f.click('recordVideo');f.node('videoDialog').fire('close');
  assert.equal(recorder.state,'recording');assert.equal(stops,0);assert.equal(f.node('stopVideo').hidden,false);
  f.node('videoDialog').close();assert.equal(recorder.state,'inactive');assert.equal(stops,1);assert.equal(f.node('galleryBtn').disabled,false);
});
test('canceling a recording prevents its delayed onstop from starting extraction',async()=>{
  let recorder,extractions=0,stops=0;const f=fixture();f.context.navigator.mediaDevices={getUserMedia:async()=>({getTracks:()=>[{stop:()=>stops++}]})};
  f.context.MediaRecorder=class{constructor(){recorder=this;this.state='inactive';}start(){this.state='recording';}stop(){this.state='inactive';}};
  f.context.MineralMedia.extractVideo=async()=>{extractions++;return {frames:[],duration:1};};await f.click('videoBtn');await f.click('recordVideo');
  recorder.ondataavailable({data:{size:100}});await f.click('newSample');recorder.onstop();await f.settle();
  assert.equal(extractions,0);assert.equal(stops,1);assert.equal(f.node('videoDialog').open,false);assert.equal(f.node('galleryBtn').disabled,false);
});
test('a new specimen ignores a late old analysis result without disturbing its later result',async()=>{
  const pending=deferred();let calls=0;const f=fixture({engine:{analyze:async()=>++calls===1?pending.promise:result(.31)}});
  await f.photo();await f.click('predictBtn');await f.click('newSample');await f.photo();await f.click('predictBtn');
  assert.equal(f.node('resultScore').textContent,'31%');pending.resolve(result(.99));await f.settle();assert.equal(f.node('resultScore').textContent,'31%');assert.equal(f.node('predictBtn').disabled,false);
});
test('saving an earlier angle during same-specimen input preserves record ID across retry',async()=>{
  const pending=deferred();let calls=0;const f=fixture({engine:{image:async src=>++calls===2?pending.promise:picture(src)}});
  await f.photo();await f.click('predictBtn');await f.click('saveBtn');await f.photo();pending.resolve(picture('thumbnail'));await f.settle();
  assert.equal(f.saved.size,1);await f.click('predictBtn');await f.click('saveBtn');assert.equal(f.saved.size,1);assert.equal([...f.saved.values()][0].photos.length,2);
});
test('finishing an old save after reset preserves the old record without binding it to the new specimen',async()=>{
  const pending=deferred();let calls=0;const f=fixture({engine:{image:async src=>++calls===2?pending.promise:picture(src)}});
  await f.photo();await f.click('predictBtn');await f.click('saveBtn');await f.click('newSample');await f.photo();pending.resolve(picture('old-thumbnail'));await f.settle();
  assert.equal(f.saved.size,1);await f.click('predictBtn');await f.click('saveBtn');assert.equal(f.saved.size,2);
});
test('native camera and photo picker stay distinct, while canceled native returns cannot replace a new draft',async()=>{
  const listeners={},pending=deferred(),sources=[];let decodes=0;const f=fixture({native:{Camera:{getPhoto:options=>{sources.push(options.source);return pending.promise;}},App:{addListener:async(name,fn)=>{listeners[name]=fn;}}},engine:{image:async src=>{decodes++;return picture(src);}}});await f.settle();
  await f.click('cameraBtn');assert.equal(f.node('cancelInput').textContent,'停止拍照');listeners.appStateChange({isActive:false});pending.resolve({webPath:'native:photo'});await f.settle();assert.equal(decodes,1);assert.equal(f.node('preview').hidden,false);
  const late=deferred();f.context.Capacitor.registerPlugin('Camera').getPhoto=options=>{sources.push(options.source);return late.promise;};await f.click('galleryBtn');
  assert.equal(f.node('cancelInput').textContent,'停止照片读取');assert.deepEqual(sources,['CAMERA','PHOTOS']);
  await f.click('newSample');late.resolve({webPath:'native:old'});await f.settle();assert.equal(decodes,1);assert.equal(f.node('preview').hidden,true);
});
test('restored native camera results are refused after user input or reset',async()=>{
  const listeners={};const f=fixture({native:{App:{addListener:async(name,fn)=>{listeners[name]=fn;}}}});await f.settle();await f.photo();
  listeners.appRestoredResult({pluginId:'Camera',success:true,data:{webPath:'native:old'}});await f.settle();assert.match(f.node('inputSummary').textContent,/已提交 1 张/);
  await f.click('newSample');listeners.appRestoredResult({pluginId:'Camera',success:true,data:{webPath:'native:old'}});await f.settle();assert.equal(f.node('preview').hidden,true);
});
