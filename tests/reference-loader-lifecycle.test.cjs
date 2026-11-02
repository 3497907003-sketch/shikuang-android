const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto');
const Core=require('../web/core.js');
const source=fs.readFileSync(require.resolve('../web/reference-loader.js'),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function observed(promise){let timer;try{return await Promise.race([promise.then(value=>({status:'resolved',value}),error=>({status:'rejected',error})),new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'pending'}),35);})]);}finally{clearTimeout(timer);}}
function fixture(){
 const files=new Map([['data/catalog.json',{schema_version:1,count:1,minerals:[{id:'ima-quartz',name_en:'Quartz'}]}],['data/crystals.json',{schema_version:1,by_species:{}}],['data/image-sources.json',{schema_version:1,entries:[]}]]);
 const descriptors=[...files].map(([path,value])=>{const bytes=Buffer.from(JSON.stringify(value));return {path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};});files.set('data/reference-manifest.json',{schema_version:1,files:descriptors});
 const state={stallFetch:false,stallDigest:false,decoderFailure:false,timers:new Map(),timer:0,calls:[],digestBegun:deferred()};
 const previous={schema_version:1,count:0,minerals:[]};
 class Decoder {constructor(...args){if(state.decoderFailure)throw Error('synthetic decoder initialization failure');return new TextDecoder(...args);}}
 const context={window:{MineralCore:Core,MINERAL_CATALOG:previous},AbortController,DOMException,TextDecoder:Decoder,
  crypto:{subtle:{digest:(...args)=>{state.digestBegun.resolve();return state.stallDigest?new Promise(()=>{}):webcrypto.subtle.digest(...args);}}},
  setTimeout:(fn,ms)=>{const id=++state.timer;state.timers.set(id,{fn,ms});return id;},clearTimeout:id=>state.timers.delete(id),
  fetch:async(path,options)=>{state.calls.push({path,cache:options.cache});if(state.stallFetch)return new Promise(()=>{});const bytes=Buffer.from(JSON.stringify(files.get(path.replace('./',''))));return {ok:true,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};}};
 vm.runInNewContext(source,context);return {api:context.window.MineralReference,state,window:context.window,previous,expire(){const timer=[...state.timers].find(([,t])=>t.ms===45000);assert.ok(timer,'expected library overall deadline');state.timers.delete(timer[0]);timer[1].fn();}};
}
test('library deadline rejects an unresponsive fetch and a later explicit retry starts a fresh load',async()=>{
 const h=fixture();h.state.stallFetch=true;const pending=h.api.load();h.expire();const result=await observed(pending);assert.equal(result.status,'rejected');assert.match(result.error.message,/超时/);assert.equal(h.api.status,'error');assert.equal(h.window.MINERAL_CATALOG,h.previous);
 h.state.stallFetch=false;const loaded=await h.api.load({retry:true});assert.equal(loaded.minerals[0].id,'ima-quartz');assert.equal(h.state.calls.slice(-4).every(call=>call.cache==='reload'),true);
});
test('library deadline covers digest promises as well as fetch and response bodies',async()=>{
 const h=fixture();h.state.stallDigest=true;const pending=h.api.load();await h.state.digestBegun.promise;h.expire();const result=await observed(pending);assert.equal(result.status,'rejected');assert.match(result.error.message,/超时/);assert.equal(h.api.status,'error');assert.equal(h.window.MINERAL_CATALOG,h.previous);
 h.state.stallDigest=false;assert.equal((await h.api.load({retry:true})).minerals[0].name_en,'Quartz');
});
test('synchronous setup failure cannot permanently cache its rejected pending promise',async()=>{
 const h=fixture();h.state.decoderFailure=true;await assert.rejects(h.api.load(),/synthetic decoder initialization failure/);assert.equal(h.api.status,'error');assert.equal(h.state.calls.length,0);
 h.state.decoderFailure=false;assert.equal((await h.api.load({retry:true})).minerals[0].id,'ima-quartz');assert.equal(h.api.status,'ready');assert.equal(h.state.calls.length,4);
});
