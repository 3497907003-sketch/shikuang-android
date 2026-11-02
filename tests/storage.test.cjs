const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {IDBFactory}=require('fake-indexeddb'),MineralCore=require('../web/core.js');
function store(factory=new IDBFactory(),timers={setTimeout,clearTimeout}){const values=new Map(),context={indexedDB:factory,...timers,MineralCore,window:{MINERAL_KB:{quartz:{name_zh:'石英',name_en:'Quartz'}}},localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)}};vm.runInNewContext(fs.readFileSync(require.resolve('../web/storage.js'),'utf8'),context);return {api:context.window.SpecimenStore,values,factory,context};}
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
test('migration retries after knowledge is unavailable and preserves the source text',async()=>{
 const {api,values,context}=store();const original=JSON.stringify([{name_zh:'石英',confidence:85,time:100}]);values.set('shikuang_history',original);context.window.MINERAL_KB={};
 await api.migrate();assert.equal(values.get('shikuang_v2_migrated'),undefined);assert.equal((await api.list()).length,0);assert.equal(values.get('shikuang_history'),original);
 context.window.MINERAL_KB={quartz:{name_zh:'石英',name_en:'Quartz'}};await api.migrate();await api.migrate();assert.equal((await api.list()).length,1);assert.equal(values.get('shikuang_v2_migrated'),'1');
});
test('partial migration stays retryable and never overwrites a reviewed migrated record',async()=>{
 const {api,values,context}=store();values.set('shikuang_history',JSON.stringify([{name_zh:'石英',confidence:85,time:100},{name_zh:'萤石',confidence:70,time:101}]));
 await api.migrate();assert.equal(values.get('shikuang_v2_migrated'),undefined);await api.put({...((await api.list())[0]),confirmedKey:'quartz',confirmationMethod:'XRD'});
 context.window.MINERAL_KB.fluorite={name_zh:'萤石',name_en:'Fluorite'};await api.migrate();const rows=await api.list();assert.equal(rows.length,2);assert.equal(rows.find(x=>x.key==='quartz').confirmationMethod,'XRD');assert.equal(values.get('shikuang_v2_migrated'),'1');
});
test('migration does not silently truncate a legacy history at fifty entries',async()=>{
 const {api,values}=store();values.set('shikuang_history',JSON.stringify(Array.from({length:52},(_,i)=>({name_zh:'石英',confidence:85,time:100+i}))));await api.migrate();assert.equal((await api.list()).length,52);
});
test('failed migration transaction never marks the source as migrated',async()=>{
 const {api,values}=store();await api.merge(Array.from({length:100},(_,i)=>record(String(i))));const original=JSON.stringify([{name_zh:'石英',confidence:85,time:200}]);values.set('shikuang_history',original);await assert.rejects(api.migrate(),/100/);assert.equal(values.get('shikuang_v2_migrated'),undefined);assert.equal(values.get('shikuang_history'),original);assert.equal((await api.list()).length,100);
});
test('an absent English name never falsely matches an unrelated legacy record',async()=>{
 const {api,values,context}=store();context.window.MINERAL_KB={quartz:{name_zh:'石英'}};values.set('shikuang_history',JSON.stringify([{name_zh:'未匹配的旧矿物',time:100,confidence:80}]));await api.migrate();assert.equal((await api.list()).length,0);assert.equal(values.get('shikuang_v2_migrated'),undefined);
});
test('atomic review changes only manual fields and keeps current model evidence',async()=>{
 const {api}=store();await api.put({...record('q'),notes:'最新分析',photos:['data:image/png;base64,AAAA'],modelVersion:'test-v2'});const updated=await api.review('q',{sampleId:'Q-01',confirmedKey:'quartz',confirmationMethod:'XRD'});assert.equal(updated.notes,'最新分析');assert.equal(updated.rankings[0].score,.8);assert.equal(updated.photos[0],'data:image/png;base64,AAAA');assert.equal(updated.modelVersion,'test-v2');await assert.rejects(api.review('q',{rankings:[{key:'calcite',score:1}]}),/仅支持/);assert.equal((await api.list())[0].rankings[0].key,'quartz');
});
test('analysis preserves both a new review and an explicit removal of review',async()=>{
 const {api}=store();await api.put(record('q'));await api.review('q',{confirmedKey:'quartz',confirmationMethod:'XRD'});const stale=(await api.list())[0];await api.review('q',{confirmedKey:'',confirmationMethod:''});const saved=await api.put({...stale,notes:'新分析'},{preserveReview:true});assert.equal(saved.confirmedKey,'');assert.equal(saved.confirmationMethod,'');assert.equal((await api.list())[0].notes,'新分析');
});
test('stale analysis or review cannot recreate a deleted specimen',async()=>{
 const {api}=store();await api.put(record('q'));await api.remove('q');await assert.rejects(api.put(record('q'),{preserveReview:true,requireExisting:true}),/已被删除/);await assert.rejects(api.review('q',{confirmedKey:'quartz',confirmationMethod:'XRD'}),/已被删除/);assert.equal((await api.list()).length,0);
});
test('migration over one hundred fails visibly without truncation or a completion flag',async()=>{
 const {api,values}=store();const original=JSON.stringify(Array.from({length:101},(_,i)=>({name_zh:'石英',confidence:85,time:100+i})));values.set('shikuang_history',original);await assert.rejects(api.migrate(),/100/);assert.equal((await api.list()).length,0);assert.equal(values.get('shikuang_history'),original);assert.equal(values.get('shikuang_v2_migrated'),undefined);
});
test('oversized legacy history still reports capacity when its names cannot yet be matched',async()=>{
 const {api,values,context}=store();context.window.MINERAL_KB={};const original=JSON.stringify(Array.from({length:101},(_,i)=>({name_zh:'未就绪',time:100+i})));values.set('shikuang_history',original);await assert.rejects(api.migrate(),/100/);assert.equal((await api.list()).length,0);assert.equal(values.get('shikuang_history'),original);assert.equal(values.get('shikuang_v2_migrated'),undefined);
});
