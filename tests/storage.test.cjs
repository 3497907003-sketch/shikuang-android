const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {IDBFactory}=require('fake-indexeddb'),MineralCore=require('../web/core.js');
function store(factory=new IDBFactory(),timers={setTimeout,clearTimeout}){const values=new Map(),context={indexedDB:factory,...timers,MineralCore,window:{MINERAL_KB:{quartz:{name_zh:'石英',name_en:'Quartz'}}},localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)}};vm.runInNewContext(fs.readFileSync(require.resolve('../web/storage.js'),'utf8'),context);return {api:context.window.SpecimenStore,values,factory};}
const record=id=>({id,time:1,name:'石英',rankings:[{key:'quartz',score:.8}],score:.8});
test('concurrent imports cannot exceed the device record limit',async()=>{
 const {api}=store();await api.merge(Array.from({length:99},(_,i)=>record(String(i))));
 const attempts=await Promise.allSettled([api.merge([record('a')]),api.merge([record('b')])]);
 assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);assert.equal((await api.list()).length,100);
 await api.put({...record('0'),notes:'updated'});assert.equal((await api.list()).find(x=>x.id==='0').notes,'updated');
 await assert.rejects(api.put(record('over')),/100/);assert.equal((await api.list()).length,100);
});
test('migration preserves 1.0 history and does not duplicate it on later launches',async()=>{
 const {api,values}=store();values.set('shikuang_history',JSON.stringify([{name_zh:'石英',confidence:85,time:100}]));
 await api.migrate();await api.migrate();const rows=await api.list();assert.equal(rows.length,1);assert.equal(rows[0].score,.85);assert.ok(values.has('shikuang_history'));
});
test('duplicate backup IDs never overwrite an existing reviewed specimen',async()=>{
 const {api}=store();await api.put({...record('q'),confirmedKey:'quartz',confirmationMethod:'XRD'});
 assert.equal(await api.merge([{...record('q'),notes:'replacement'},record('r'),record('r')]),1);
 const rows=await api.list();assert.equal(rows.length,2);assert.equal(rows.find(x=>x.id==='q').confirmationMethod,'XRD');
});
test('version change closes the old connection and preserves records for the newer app',async()=>{
 const {api,factory}=store();await api.put(record('keep'));
 const newer=await new Promise((resolve,reject)=>{const r=factory.open('shikuang-specimens',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 await assert.rejects(api.list(),/更新 App/);
 const saved=await new Promise((resolve,reject)=>{const r=newer.transaction('records').objectStore('records').get('keep');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 assert.equal(saved.id,'keep');newer.close();
});
test('blocked or timed out opens are recoverable and close late connections',async()=>{
 const requests=[],callbacks=new Map();let timerId=0,closed=0;
 const factory={open(){const r={};requests.push(r);return r;}};
 const {api}=store(factory,{setTimeout:fn=>{callbacks.set(++timerId,fn);return timerId;},clearTimeout:id=>callbacks.delete(id)});
 let pending=api.list();requests[0].onblocked();await assert.rejects(pending,/其他页面占用/);
 requests[0].result={close(){closed++;}};requests[0].onsuccess();assert.equal(closed,1);
 pending=api.list();assert.equal(requests.length,2);[...callbacks.values()][0]();await assert.rejects(pending,/打开超时/);
 requests[1].result={close(){closed++;}};requests[1].onsuccess();assert.equal(closed,2);assert.equal(callbacks.size,0);
});
