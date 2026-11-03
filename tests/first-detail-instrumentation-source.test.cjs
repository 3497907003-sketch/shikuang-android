// Host SOURCE/observer checks only; no Android, browser or native inference.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const java=fs.readFileSync(require.resolve('../android/app/src/androidTest/java/com/shikuang/app/MineralEngineInstrumentedTest.java'),'utf8');
function source(name){const method=java.split('static String '+name+'() {')[1]?.split('\n    }')[0];assert.ok(method);return method.split('\n').filter(line=>/^\s*"/.test(line)).map(line=>JSON.parse(line.trim().replace(/,$/,''))).join('\n');}
const setup=source('firstDetailSetupScript'),snapshot=source('firstDetailSnapshotScript');

test('exact native first-detail observer/snapshot Java strings parse as JavaScript',()=>{
  new vm.Script(setup);new vm.Script(snapshot);
  assert.doesNotMatch(setup+snapshot,/SpecimenStore\.(put|remove|merge)|localStorage\.clear|caches\.delete/);
});

function observer(result,error){
  const response={status:200},calls=[],listeners={};
  const realAnalyze=async(...args)=>{calls.push({kind:'analyze',args});if(error)throw error;return result;};
  const realFetch=async(...args)=>{calls.push({kind:'fetch',args});return response;};
  const context={location:{href:'https://localhost/',origin:'https://localhost'},URL,Request:class Request{},performance:{getEntriesByType:()=>[]},MineralReference:{status:'idle'},MineralEngine:{analyze:realAnalyze},fetch:realFetch,document:{getElementById:id=>({hidden:id==='view-library'}),addEventListener:(name,fn)=>{listeners[name]=fn;}}};context.window=context;
  vm.runInNewContext(setup,context);return {context,calls,response,listeners};
}

test('observer forwards real analysis/fetch arguments and exact results without supplying model outputs',async()=>{
  const result={key:'quartz',engine:'synthetic-observer-fixture',modelCount:3,modelVersion:'fixture',manifestSha256:'a'.repeat(64),diagnostics:{elapsedMs:1,residentSessionCount:4}},f=observer(result),photos=[{src:'fixture'}],options={precision:true};
  assert.strictEqual(await f.context.MineralEngine.analyze(photos,options),result);
  assert.strictEqual(f.calls[0].args[0],photos);assert.strictEqual(f.calls[0].args[1],options);assert.equal(f.calls.length,1);
  const requestOptions={cache:'reload'};f.context.__shikuangRuntimeSmoke.phase='first-detail-loading';
  assert.strictEqual(await f.context.fetch('./data/catalog.json',requestOptions),f.response);
  assert.strictEqual(f.calls[1].args[1],requestOptions);assert.equal(f.context.__shikuangRuntimeSmoke.firstDetailRequests[0].startedPhase,'first-detail-loading');
  assert.equal(f.context.__shikuangRuntimeSmoke.firstDetailAnalyze.engine,'synthetic-observer-fixture');
  f.listeners.click({target:{closest:()=>({})}});assert.equal(f.context.__shikuangRuntimeSmoke.libraryClicks,1);
});

test('observer rethrows native analysis failure and records a failed phase',async()=>{
  const error=new Error('synthetic observer failure'),f=observer(null,error);
  await assert.rejects(f.context.MineralEngine.analyze([]),e=>e===error);
  assert.equal(f.context.__shikuangRuntimeSmoke.phase,'failed');assert.match(f.context.__shikuangRuntimeSmoke.failure,/synthetic observer failure/);
});

test('snapshot observes source-bound public book fields and exposes missing rendered values',()=>{
  const catalog=JSON.parse(fs.readFileSync(require.resolve('../web/data/catalog.json'))),overlay=catalog.reviewed_book_evidence,rows=overlay.records.filter(row=>row.catalog_id==='ima-quartz');let missing=false;
  const sections=rows.map(row=>({querySelector(selector){if(selector==='p')return {textContent:overlay.books.find(b=>b.source_id===row.source_id).title};if(selector==='.field-hint')return {textContent:'PDF 第 '+row.pdf_page_1based+' 页'};return {querySelector(){return missing?null:{textContent:row.value};}};}}));
  const imageSection={open:false},body={textContent:'官方目录字段',querySelectorAll:()=>sections,querySelector:selector=>selector==='.image-section'?imageSection:null};
  const nodes={detailBody:body,detailDialog:{open:true},detailTitle:{textContent:'石英'},'view-library':{hidden:true}},s={initialLoaderStatus:'idle',initialIdentifyVisible:true,initialLibraryHidden:true,initialReferenceRequests:[],firstDetailBeforeClick:{},firstDetailAnalyze:{},libraryClicks:0,firstDetailRequests:[],firstDetailPhotoRequests:[]};
  const context={MINERAL_CATALOG:catalog,MINERAL_IMAGE_SOURCES:{records:new Array(871)},MineralReference:{status:'ready'},navigator:{onLine:false},document:{getElementById:id=>nodes[id]},__shikuangRuntimeSmoke:s};context.window=context;
  vm.runInNewContext(snapshot,context);assert.equal(s.firstResultDetail.quartzBookFields.length,3);assert(s.firstResultDetail.quartzBookFields.every(row=>row.renderedValueMatches));assert.equal(s.firstResultDetail.totalBookStatements,200);
  missing=true;vm.runInNewContext(snapshot,context);assert(s.firstResultDetail.quartzBookFields.every(row=>!row.renderedValueMatches));
});
