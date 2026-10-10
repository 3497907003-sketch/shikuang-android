const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto,createHash} = require('node:crypto');

function fixture() {
  const data = new Map([
    ['data/catalog.json',{schema_version:1,count:1,minerals:[{id:'ima-quartz',name_en:'Quartz'}]}],
    ['data/crystals.json',{schema_version:1,by_species:{}}],
    ['data/image-sources.json',{schema_version:1,entries:[]}]
  ]);
  const files = [...data].map(([path,value])=>{
    const bytes=Buffer.from(JSON.stringify(value));
    return {path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  });
  data.set('data/reference-manifest.json',{schema_version:1,files});
  const calls=[];
  const context={window:{MineralCore:require('../web/core.js')},crypto:webcrypto,TextDecoder,AbortController,DOMException,setTimeout,clearTimeout,Uint8Array,fetch:async(url,options)=>{
    calls.push({url,cache:options.cache});
    const value=data.get(url.replace('./',''));
    const bytes=Buffer.from(JSON.stringify(value));
    return {ok:true,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
  }};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/reference-loader.js'),'utf8'),context);
  return {context,data,calls,api:context.window.MineralReference};
}

test('reference data does not load at app startup; concurrent library opens share one verified load',async()=>{
  const f=fixture();
  assert.equal(f.calls.length,0);
  const a=f.api.load(),b=f.api.load();
  assert.strictEqual(a,b);
  await a;
  assert.equal(f.api.status,'ready');
  assert.equal(f.calls.length,4);
  assert.equal(f.context.window.MINERAL_CATALOG.minerals[0].name_en,'Quartz');
  await f.api.load();
  assert.equal(f.calls.length,4);
});

test('damaged reference bytes do not publish a partial catalogue; a repair bypasses cache',async()=>{
  const f=fixture(),original=f.data.get('data/crystals.json');
  f.data.set('data/crystals.json',{schema_version:1,by_species:{bad:[]}});
  await assert.rejects(f.api.load(),/不完整/);
  assert.equal(f.api.status,'error');
  assert.equal(f.context.window.MINERAL_CATALOG,undefined);
  f.data.set('data/crystals.json',original);
  await f.api.load({retry:true});
  assert.equal(f.api.status,'ready');
  assert.equal(f.calls.slice(-4).every(x=>x.cache==='reload'),true);
});

test('an unexpected resource path is rejected before downloading it',async()=>{
  const f=fixture();
  f.data.get('data/reference-manifest.json').files[0].path='https://example.org/data.json';
  await assert.rejects(f.api.load(),/无效资源/);
  assert.equal(f.calls.length,1);
  assert.equal(f.context.window.MINERAL_CATALOG,undefined);
});
