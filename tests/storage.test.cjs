const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {IDBFactory}=require('fake-indexeddb'),MineralCore=require('../web/core.js');
function store(){const values=new Map(),context={indexedDB:new IDBFactory(),MineralCore,window:{MINERAL_KB:{quartz:{name_zh:'石英',name_en:'Quartz'}}},localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)}};vm.runInNewContext(fs.readFileSync(require.resolve('../web/storage.js'),'utf8'),context);return {api:context.window.SpecimenStore,values};}
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
