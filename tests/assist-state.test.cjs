const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('./helpers/app-fixture.cjs');
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const response=text=>new Response(JSON.stringify({choices:[{message:{content:text}}]}));
async function ready(f){await f.photo();await f.click('predictBtn');f.node('mode-online').fire('click');f.route('settings');f.node('apiKey').value='unit-test-placeholder';}

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
