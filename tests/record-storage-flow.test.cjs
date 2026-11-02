const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {IDBFactory}=require('fake-indexeddb'),{fixture}=require('./helpers/app-fixture.cjs');
async function appWithDatabase(sampleId=''){
 const f=fixture();await f.settle();f.context.indexedDB=new IDBFactory();vm.runInNewContext(fs.readFileSync(require.resolve('../web/storage.js'),'utf8'),f.context);f.api=f.context.SpecimenStore;
 await f.photo();await f.click('predictBtn');f.node('sampleId').value=sampleId;await f.click('saveBtn');await f.until(()=>!f.node('saveBtn').disabled);f.id=(await f.api.list())[0].id;return f;
}
async function pausedAnalysisSave(f){
 let release;f.context.MineralEngine.image=src=>new Promise(resolve=>{release=()=>resolve({src,naturalWidth:256,naturalHeight:256});});f.node('saveBtn').fire('click');await f.until(()=>Boolean(release));return release;
}
async function openReview(f){f.route('records');await f.settle();await f.documentClick('[data-record]',{record:f.id});const row=(await f.api.list()).find(x=>x.id===f.id);f.node('recordSampleId').value=row.sampleId;f.node('confirmedKey').value=row.confirmedKey;f.node('confirmationMethod').value=row.confirmationMethod;}
async function saveReview(f){f.node('confirmedKey').value='quartz';f.node('confirmationMethod').value='XRD-2026';await f.documentClick('#updateRecord');}
test('delayed analysis save retains a review committed while thumbnails were pending',async()=>{
 const f=await appWithDatabase(),release=await pausedAnalysisSave(f);await openReview(f);await saveReview(f);assert.equal((await f.api.list())[0].confirmationMethod,'XRD-2026');release();await f.until(()=>!f.node('saveBtn').disabled);assert.equal((await f.api.list())[0].confirmationMethod,'XRD-2026');
});
test('review from an older open dialog preserves a newly committed analysis',async()=>{
 const f=await appWithDatabase();f.node('notes').value='新分析备注';const release=await pausedAnalysisSave(f);await openReview(f);release();await f.until(()=>!f.node('saveBtn').disabled);assert.equal((await f.api.list())[0].notes,'新分析备注');await saveReview(f);const row=(await f.api.list())[0];assert.equal(row.notes,'新分析备注');assert.equal(row.confirmationMethod,'XRD-2026');assert.equal(row.rankings[0].key,'quartz');
});
test('deleting a specimen while analysis save is pending does not resurrect it',async()=>{
 const f=await appWithDatabase(),release=await pausedAnalysisSave(f);await f.api.remove(f.id);release();await f.until(()=>!f.node('saveBtn').disabled);assert.equal((await f.api.list()).length,0);
});
test('a review number committed during thumbnail conversion wins over the unchanged save form',async()=>{
 const f=await appWithDatabase('LAB-A'),release=await pausedAnalysisSave(f);await openReview(f);f.node('recordSampleId').value='LAB-B';await saveReview(f);release();await f.until(()=>!f.node('saveBtn').disabled);assert.equal((await f.api.list())[0].sampleId,'LAB-B');
});
test('a main save can intentionally change its specimen number without a concurrent edit',async()=>{
 const f=await appWithDatabase('LAB-A');f.node('sampleId').value='LAB-C';await f.click('saveBtn');await f.until(()=>!f.node('saveBtn').disabled);assert.equal((await f.api.list())[0].sampleId,'LAB-C');
});
test('a stale review dialog does not write an unchanged old number over new analysis',async()=>{
 const f=await appWithDatabase('LAB-A');f.node('sampleId').value='LAB-C';const release=await pausedAnalysisSave(f);await openReview(f);release();await f.until(()=>!f.node('saveBtn').disabled);assert.equal((await f.api.list())[0].sampleId,'LAB-C');await saveReview(f);assert.equal((await f.api.list())[0].sampleId,'LAB-C');
});
test('conflicting deliberate number edits retain the review and let the form retry explicitly',async()=>{
 const f=await appWithDatabase('LAB-A');f.node('sampleId').value='LAB-C';const release=await pausedAnalysisSave(f);await openReview(f);f.node('recordSampleId').value='LAB-B';await saveReview(f);release();await f.until(()=>!f.node('saveBtn').disabled);assert.equal((await f.api.list())[0].sampleId,'LAB-B');assert.equal(f.node('sampleId').value,'LAB-C');
 f.route('identify');f.context.MineralEngine.image=async src=>({src,naturalWidth:256,naturalHeight:256});await f.click('saveBtn');await f.until(()=>!f.node('saveBtn').disabled);assert.equal((await f.api.list())[0].sampleId,'LAB-C');
});
test('a review committed before the delayed old-record read cannot be overwritten by the earlier snapshot',async()=>{
 const f=await appWithDatabase('LAB-A'),list=f.api.list;let releaseList,held=false;f.api.list=()=>{if(!held){held=true;return new Promise(resolve=>{releaseList=async()=>resolve(await list());});}return list();};f.node('saveBtn').fire('click');await f.until(()=>Boolean(releaseList));await openReview(f);f.node('recordSampleId').value='LAB-B';await saveReview(f);assert.equal((await list())[0].sampleId,'LAB-B');await releaseList();await f.until(()=>!f.node('saveBtn').disabled);assert.equal((await list())[0].sampleId,'LAB-B');assert.equal(f.node('sampleId').value,'LAB-B');
});
