const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('./helpers/app-fixture.cjs');
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const response=text=>new Response(JSON.stringify({choices:[{message:{content:text}}]}));
async function ready(f){await f.photo();await f.click('predictBtn');f.node('mode-online').fire('click');f.route('settings');f.node('apiKey').value='unit-test-placeholder';}
function realCrop(f){
  const fs=require('node:fs'),vm=require('node:vm'),context={window:{},document:f.context.document};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/inference.js'),'utf8'),context);
  f.context.MineralEngine.cropCanvas=context.window.MineralEngine.cropCanvas;
}
function requestSnapshot(body){const content=body.messages.find(row=>row.role==='user').content,text=Array.isArray(content)?content[0].text:content;return JSON.parse(text.slice(text.indexOf('\n')+1));}

test('assistance compares the real three or first five candidates and cannot promote a disputed top1 or confirm a specimen',async()=>{
  const keys=['quartz','calcite','fluorite','gypsum','beryl','pyrite'];
  for(const count of [3,5,6]){
    const result={key:'quartz',score:.13,status:'uncertain',reasons:['待复核'],rankings:keys.slice(0,count).map((key,index)=>({key,score:.13-index*.01})),checks:[],agreement:.3,photoCount:1,modelCount:1};
    const unchanged=JSON.stringify(result),f=fixture({engine:{analyze:async()=>result}});f.node('notes').value='白色不规则块体，有解理';f.node('hardness').value='3';f.node('luster').value='nonmetal';await ready(f);
    let body;f.context.fetch=async(_url,options)=>{body=JSON.parse(options.body);return response('首位石英候选与硬度观察冲突，方解石仍待进一步验证；也可能均不符。');};await f.click('assistBtn');
    const snapshot=requestSnapshot(body);assert.deepEqual(snapshot.candidates.map(row=>row.key),keys.slice(0,Math.min(count,5)));
    assert.deepEqual(snapshot.candidates.map(row=>row.model_score),result.rankings.slice(0,5).map(row=>row.score));
    assert.deepEqual(snapshot.observations,{description:'白色不规则块体，有解理',measured_hardness:'3',luster:'非金属光泽'});assert.deepEqual(snapshot.images,[]);
    assert.equal(typeof body.messages.find(row=>row.role==='user').content,'string');
    const rules=body.messages.find(row=>row.role==='system').content;assert.match(rules,/首位候选可能错误/);assert.match(rules,/全部候选不符/);assert.match(rules,/共生或多相/);assert.match(rules,/本次没有发送图片/);assert.match(rules,/不得声称看过图片/);
    assert.match(f.node('assistText').textContent,/^AI 纯文字资料比较（未发送图片）/);assert.equal(f.node('resultHeading').textContent,'石英');assert.equal(f.node('resultScore').textContent,'13%');assert.equal(JSON.stringify(result),unchanged);
    await f.click('saveBtn');const saved=[...f.saved.values()][0];assert.equal(saved.key,'quartz');assert.equal(saved.score,.13);assert.equal(saved.confirmedKey,'');assert.deepEqual(saved.rankings.map(row=>row.key),keys.slice(0,count));
  }
});

test('explicit image consent uploads the same selected center ROI at available detail, using the actual crop helper',async()=>{
  let decodes=0,body;const f=fixture({engine:{image:async src=>({src,naturalWidth:++decodes===1?3072:1536,naturalHeight:decodes===1?2048:1024})}});realCrop(f);
  await ready(f);f.route('identify');f.node('cropRange').value='75';f.node('cropRange').fire('input');await f.click('predictBtn');f.route('settings');f.node('assistImage').checked=true;
  const fullPhoto=f.node('preview').src;f.context.fetch=async(_url,options)=>{body=JSON.parse(options.body);return response('图中可见特征与各候选仍需比较。');};await f.click('assistBtn');
  const content=body.messages.find(row=>row.role==='user').content;assert.equal(content.length,2);assert.match(content[1].image_url.url,/^data:image\/png;base64,/);assert.notEqual(content[1].image_url.url,fullPhoto);
  const canvas=f.created.find(el=>el.drawArgs?.length===9);assert.ok(canvas);assert.deepEqual(canvas.drawArgs.slice(1),[384,128,768,768,0,0,768,768]);assert.notEqual(canvas.drawArgs[7],224);assert.equal(canvas.width,0);assert.equal(canvas.height,0);
  assert.equal(requestSnapshot(body).images[0].center_crop_ratio,.75);assert.match(body.messages[0].content,/先独立观察附图/);assert.match(body.messages[0].content,/用户选定的中心分析区域/);assert.match(f.node('assistText').textContent,/^AI 图像与文字参考（未经确认/);
});

test('a restored panoramic photo retains all available center ROI detail within the upload bound',async()=>{
  const f=fixture();realCrop(f);await ready(f);f.route('identify');f.node('cropRange').value='50';f.node('cropRange').fire('input');await f.click('predictBtn');f.route('settings');
  f.context.MineralEngine.image=async src=>({src,naturalWidth:4000,naturalHeight:1000});f.node('assistImage').checked=true;
  f.context.fetch=async()=>response('中心区域待复核');await f.click('assistBtn');
  const canvas=f.created.find(el=>el.drawArgs?.length===9);assert.ok(canvas);assert.deepEqual(canvas.drawArgs.slice(1),[1750,250,500,500,0,0,500,500]);
  assert.equal(canvas.width,0);assert.equal(canvas.height,0);
});

test('canceled ROI decoding cannot send a stale image or unlock a newer text request',async()=>{
  const stale=deferred(),fresh=deferred();let calls=0;const f=fixture();realCrop(f);await ready(f);f.context.MineralEngine.image=()=>stale.promise;f.node('assistImage').checked=true;
  f.context.fetch=()=>{calls++;return fresh.promise;};await f.click('assistBtn');f.route('records');f.route('settings');f.node('assistImage').checked=false;f.node('assistImage').fire('change');await f.click('assistBtn');assert.equal(calls,1);
  stale.resolve({src:'stale',naturalWidth:1536,naturalHeight:1024});await f.settle();assert.equal(calls,1);assert.equal(f.node('assistBtn').disabled,true);
  fresh.resolve(response('当前纯文字比较'));await f.settle();assert.match(f.node('assistText').textContent,/当前纯文字比较/);assert.equal(f.node('assistBtn').disabled,false);
});

test('changing image consent cancels the image request and suppresses its late reference',async()=>{
  const pending=deferred();let signal;const f=fixture();realCrop(f);await ready(f);f.node('assistImage').checked=true;f.context.fetch=(_url,options)=>{signal=options.signal;return pending.promise;};await f.click('assistBtn');
  f.node('assistImage').checked=false;f.node('assistImage').fire('change');assert.equal(signal.aborted,true);assert.equal(f.node('assistBtn').disabled,false);pending.resolve(response('旧图片参考'));await f.settle();assert.equal(f.node('assistText').textContent,'');assert.equal(f.node('result').hidden,false);
});

test('the 45s total assistance deadline also bounds ROI preparation before any network request',async()=>{
  let id=0,calls=0;const timers=new Map(),pending=deferred(),f=fixture({timers:{setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:timer=>timers.delete(timer)}});realCrop(f);await ready(f);
  f.node('assistImage').checked=true;f.context.MineralEngine.image=()=>pending.promise;f.context.fetch=async()=>{calls++;return response('不得显示');};await f.click('assistBtn');
  const deadline=[...timers.values()].find(timer=>timer.ms===45000);assert.ok(deadline);deadline.fn();await f.settle();assert.match(f.node('assistText').textContent,/45 秒/);assert.equal(f.node('assistBtn').disabled,false);assert.equal(calls,0);
  pending.resolve({src:'late',naturalWidth:1536,naturalHeight:1024});await f.settle();assert.equal(calls,0);assert.equal(f.node('result').hidden,false);
});

test('failed local resources expose an explicit image-only recovery without inventing a local result',async()=>{
  const f=fixture();realCrop(f);f.setError(new Error('模型资源加载失败'));await f.photo();f.node('mode-online').fire('click');await f.click('predictBtn');
  assert.equal(f.node('result').hidden,true);assert.equal(f.node('analysisRecovery').hidden,false);assert.equal(f.node('assistCurrent').hidden,false);await f.click('assistCurrent');assert.equal(f.context.location.hash,'#settings');f.node('apiKey').value='unit-test-placeholder';
  let calls=0,body;f.context.fetch=async(_url,options)=>{calls++;body=JSON.parse(options.body);return response('仅凭图片还不能确认，需补充实测物性。');};await f.click('assistBtn');assert.equal(calls,0);
  f.node('assistImage').checked=true;f.node('assistImage').fire('change');await f.click('assistBtn');assert.equal(calls,1);const snapshot=requestSnapshot(body);assert.equal(snapshot.local_candidates_status,'未取得本机候选');assert.deepEqual(snapshot.candidates,[]);assert.equal(snapshot.images.length,1);
  assert.match(body.messages[0].content,/本次未取得本机候选/);assert.match(f.node('assistText').textContent,/未取得本机候选，未经确认/);assert.equal(f.node('result').hidden,true);await f.click('saveBtn');assert.equal(f.saved.size,0);
  f.node('mode-offline').fire('click');await f.click('assistBtn');assert.equal(calls,1);f.node('mode-online').fire('click');f.route('identify');await f.click('newSample');assert.equal(f.node('assistCurrent').hidden,true);f.route('settings');await f.click('assistBtn');assert.equal(calls,1);
});

test('switching offline during image-only recovery decoding prevents the eventual network request',async()=>{
  const pending=deferred(),f=fixture();realCrop(f);f.setError(new Error('模型目录不可用'));await f.photo();await f.click('predictBtn');f.node('mode-online').fire('click');await f.click('assistCurrent');f.node('apiKey').value='unit-test-placeholder';f.node('assistImage').checked=true;
  let calls=0;f.context.MineralEngine.image=()=>pending.promise;f.context.fetch=async()=>{calls++;return response('不得显示');};await f.click('assistBtn');f.node('mode-offline').fire('click');pending.resolve({src:'late',naturalWidth:1536,naturalHeight:1024});await f.settle();assert.equal(calls,0);assert.equal(f.node('assistText').textContent,'');assert.equal(f.node('assistBtn').disabled,false);assert.equal(f.node('result').hidden,true);
});

test('canceled assist completion cannot write results or unlock a later request with the same revision',async()=>{
  const old=deferred(),fresh=deferred();let calls=0;const f=fixture();await ready(f);f.context.fetch=()=>++calls===1?old.promise:fresh.promise;
  await f.click('assistBtn');assert.equal(f.node('assistBtn').disabled,true);f.route('records');f.route('settings');await f.click('assistBtn');
  old.resolve(response('旧说明'));await f.settle();assert.equal(f.node('assistBtn').disabled,true);assert.doesNotMatch(f.node('assistText').textContent,/旧说明/);
  fresh.resolve(response('当前候选说明'));await f.settle();assert.equal(f.node('assistBtn').disabled,false);assert.match(f.node('assistText').textContent,/当前候选说明/);
});
test('editing manual observations aborts the service and retains the local candidate without late text',async()=>{
  const pending=deferred();let signal;const f=fixture();await ready(f);f.context.fetch=(_url,options)=>{signal=options.signal;return pending.promise;};await f.click('assistBtn');
  f.node('notes').value='新增条痕观察';f.node('notes').fire('input');assert.equal(signal.aborted,true);assert.equal(f.node('assistBtn').disabled,false);assert.equal(f.node('result').hidden,false);
  pending.resolve(response('已过时说明'));await f.settle();assert.equal(f.node('assistText').textContent,'');assert.equal(f.node('notes').value,'新增条痕观察');
});
test('oversized service bodies fail within the 1MB bound and preserve the local result',async()=>{
  const f=fixture();await ready(f);f.context.fetch=async()=>response('x'.repeat(1024*1024+1));await f.click('assistBtn');
  assert.equal(f.node('assistBtn').disabled,false);assert.equal(f.node('result').hidden,false);assert.doesNotMatch(f.node('assistText').textContent,/AI 文字参考/);assert.ok(f.node('assistText').textContent.length<1000);
});
test('45s deadline includes a stalled response body rather than only response headers',async()=>{
  let id=0;const timers=new Map(),f=fixture({timers:{setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:timer=>timers.delete(timer)}});await ready(f);
  let canceled=false;const stream=new ReadableStream({start(){},cancel(){canceled=true;}});f.context.fetch=async()=>new Response(stream);await f.click('assistBtn');
  const deadline=[...timers.values()].find(timer=>timer.ms===45000);assert.ok(deadline);assert.equal(f.node('assistBtn').disabled,true);deadline.fn();await f.settle();assert.equal(canceled,true);assert.equal(f.node('assistBtn').disabled,false);assert.match(f.node('assistText').textContent,/45 秒/);assert.equal(f.node('result').hidden,false);
});
test('explicit offline mode aborts assistance while leaving the image result available',async()=>{
  const pending=deferred();let signal;const f=fixture();await ready(f);f.context.fetch=(_url,options)=>{signal=options.signal;return pending.promise;};await f.click('assistBtn');
  f.node('mode-offline').fire('click');assert.equal(signal.aborted,true);assert.equal(f.node('assistBtn').disabled,false);assert.equal(f.node('result').hidden,false);
  pending.resolve(response('不能在离线模式显示的迟到说明'));await f.settle();assert.equal(f.node('assistText').textContent,'');
});
