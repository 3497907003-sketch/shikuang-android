const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./helpers/app-fixture.cjs');

function deferredLoader(){
  let context,complete,fail;
  const calls=[],loader={status:'idle',load(options){
    calls.push(options);loader.status='loading';
    return new Promise((resolve,reject)=>{
      complete=()=>{context.MINERAL_CATALOG={schema_version:1,count:1,minerals:[{
        id:'ima-quartz',name_en:'Quartz',detail_key:'quartz',formula:'SiO2',ima_status:'A'
      }]};loader.status='ready';resolve();};
      fail=()=>{loader.status='error';reject(new Error('资料请求失败'));};
    });
  }};
  const f=fixture({loader});context=f.context;
  return {f,loader,calls,complete:()=>complete(),fail:()=>fail()};
}

test('first result detail loads full references without blocking recognition or waiting to open',async()=>{
  const x=deferredLoader(),{f}=x;
  await f.photo();await f.click('predictBtn');
  assert.equal(x.calls.length,0,'Photo recognition must not request the large catalogue');
  await f.click('detailBtn');
  assert.equal(f.node('detailDialog').open,true);
  assert.match(f.node('detailBody').innerHTML,/正在读取完整资料/);
  assert.equal(x.calls.length,1);
  assert.doesNotMatch(f.node('detailBody').innerHTML,/官方目录字段/);
  f.node('detailDialog').scrollTop=120;
  x.complete();await f.settle();
  assert.match(f.node('detailBody').innerHTML,/官方目录字段/);
  assert.doesNotMatch(f.node('detailBody').innerHTML,/正在读取完整资料/);
  assert.equal(f.node('detailDialog').scrollTop,120);
  assert.equal(f.node('result').hidden,false);
});

test('reference failure leaves the result and original detail usable with an explicit cache-repair retry',async()=>{
  const x=deferredLoader(),{f}=x;
  await f.photo();await f.click('predictBtn');await f.click('detailBtn');
  x.fail();await f.settle();
  assert.equal(f.node('detailDialog').open,true);
  assert.match(f.node('detailBody').innerHTML,/SiO/);
  assert.match(f.node('detailBody .detail-reference-state').innerHTML,/重试读取完整资料/);
  assert.equal(f.node('result').hidden,false);
  await f.documentClick('[data-retry-detail-reference]',{retryDetailReference:'quartz'});
  assert.equal(x.calls.length,2);assert.equal(x.calls[1].retry,true);
  x.complete();await f.settle();
  assert.match(f.node('detailBody').innerHTML,/官方目录字段/);
});

test('late catalogue completion cannot reopen a closed detail',async()=>{
  const x=deferredLoader(),{f}=x;
  await f.documentClick('[data-detail]',{detail:'quartz'});
  await f.click('closeDetail');
  const closedBody=f.node('detailBody').innerHTML;
  x.complete();await f.settle();
  assert.equal(f.node('detailDialog').open,false);
  assert.equal(f.node('detailBody').innerHTML,closedBody);
});

test('concurrent detail opens share the reference load and only refresh the current candidate',async()=>{
  const x=deferredLoader(),{f}=x;
  f.context.MINERAL_KB.pyrite={name_zh:'黄铁矿',name_en:'Pyrite',formula:'FeS2'};
  await f.documentClick('[data-detail]',{detail:'quartz'});
  await f.documentClick('[data-detail]',{detail:'pyrite'});
  assert.equal(x.calls.length,1);
  x.complete();await f.settle();
  assert.equal(f.node('detailTitle').textContent,'黄铁矿');
  assert.doesNotMatch(f.node('detailBody').innerHTML,/官方目录字段/);
  assert.doesNotMatch(f.node('detailBody').innerHTML,/正在读取完整资料/);
});
