// Pure SOURCE/DOM simulation: no Android, browser, network, images or model payloads.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto');
const {fixture}=require('./helpers/app-fixture.cjs');
const expectedRaw=fs.readFileSync(require.resolve('../android/app/src/androidTest/assets/book174-expected.json'));
const expected=JSON.parse(expectedRaw);
const java=fs.readFileSync(require.resolve('../android/app/src/androidTest/java/com/shikuang/app/MineralEngineInstrumentedTest.java'),'utf8');
const method=java.split('static String book174ReadOnlyScript(String expectedJSON) {')[1]?.split('\n    private void checkBookReferenceCatalog(')[0];
assert.ok(method,'instrumentation must contain the versioned source under test');
const source=method.split('\n').filter(line=>/^\s*"/.test(line)).map(line=>line.includes('+expectedJSON+')?`)(${JSON.stringify(expected)});`:JSON.parse(line.trim().replace(/,$/,''))).join('\n');
const catalogRaw=fs.readFileSync(require.resolve('../web/data/catalog.json'));
assert.equal(catalogRaw.length,expected.catalog_pin.bytes,'the Android public catalogue must actually be synchronized to this profile');
assert.equal(createHash('sha256').update(catalogRaw).digest('hex'),expected.catalog_pin.sha256,'exact currentbook174 Android catalogue pin');
const catalog=JSON.parse(catalogRaw);
const decode=value=>value.replace(/&(?:amp|lt|gt|quot|#39|#x[0-9a-f]+|#\d+);/gi,entity=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"})[entity]??String.fromCodePoint(parseInt(entity.slice(2,-1).replace(/^x/i,''),/^&#x/i.test(entity)?16:10)));

// Parse the small real book-section markup, preserving nested formula/statement nodes.
function sectionNode(html){
  const element=(tag='',attrs={})=>({tag,attrs,children:[],get textContent(){return this.children.map(child=>typeof child==='string'?child:child.textContent).join('');},get innerHTML(){return this.children.map(child=>typeof child==='string'?child:'<'+child.tag+'>'+child.innerHTML+'</'+child.tag+'>').join('');},querySelectorAll(selector){
    const matches=node=>{
      const attribute=selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      if(attribute)return Object.hasOwn(node.attrs,attribute[1])&&(attribute[2]===undefined||node.attrs[attribute[1]]===attribute[2]);
      const parts=selector.split('.');return (!parts[0]||parts[0]===node.tag)&&(!parts[1]||(node.attrs.class||'').split(/\s+/).includes(parts[1]));
    };
    const result=[];const visit=node=>{for(const child of node.children)if(typeof child!=='string'){if(matches(child))result.push(child);visit(child);}};visit(this);return result;
  },querySelector(selector){return this.querySelectorAll(selector)[0]||null;}});
  const root=element(),stack=[root];
  for(const token of html.match(/<[^>]*>|[^<]+/g)||[]){
    if(token.startsWith('</')){stack.pop();continue;}
    if(token.startsWith('<')){
      const match=token.match(/^<([\w-]+)([\s\S]*?)>$/);if(!match)continue;
      const attrs={};for(const attribute of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g))attrs[attribute[1]]=decode(attribute[2]||'');
      const node=element(match[1],attrs);stack.at(-1).children.push(node);if(!/^(br|hr|img|input|meta|link)$/.test(node.tag))stack.push(node);
    }else stack.at(-1).children.push(decode(token));
  }
  return root;
}

async function run({changeCatalog,changeSections,mutatePrimary}={}){
  const c=structuredClone(catalog);changeCatalog?.(c);const f=fixture({catalog:c});await f.settle();f.node('libraryScope').value='all';
  const originalQueryAll=f.context.document.querySelectorAll;f.context.document.getElementById=id=>f.node(id);
  f.context.document.querySelectorAll=selector=>{
    if(selector==='#libraryList [data-detail]')return [...f.node('libraryList').innerHTML.matchAll(/data-detail="([^"]+)"/g)].map(match=>({dataset:{detail:decode(match[1])},click(){void f.documentClick('[data-detail]',{detail:decode(match[1])});}}));
    if(selector==='#detailBody .book-evidence-section'){
      const sections=[...f.node('detailBody').innerHTML.matchAll(/<section class="detail-section book-evidence-section"[\s\S]*?<\/section>/g)].map(match=>match[0]);return (changeSections?.(sections)||sections).map(sectionNode);
    }
    return originalQueryAll(selector);
  };
  for(const id of ['libraryScope','librarySearch','classFilter'])f.node(id).dispatchEvent=event=>f.node(id).fire(event.type);
  f.node('closeDetail').click=()=>f.node('closeDetail').fire('click');
  if(mutatePrimary)f.node('closeDetail').addEventListener('click',()=>{c.minerals[0].sourceOnlyCounterexample=true;});
  Object.assign(f.context,{crypto:webcrypto,TextEncoder,Uint8Array,Event:class Event{constructor(type){this.type=type;}},__shikuangRuntimeSmoke:{}});
  for(const key of ['SpecimenStore','localStorage','MineralEngine'])Object.defineProperty(f.context,key,{get(){throw Error('forbidden access '+key);}});
  await vm.runInNewContext(source,f.context,{filename:'book174ReadOnlyScript.instrumentation.js'});return {state:f.context.__shikuangRuntimeSmoke,f};
}

test('the exact versioned instrumentation preserves118 and reads40 plus all56 rendered fields and61 cards',async()=>{
  new vm.Script(source);const {state,f}=await run();assert.equal(state.phase,'book174-checked',state.failure);const p=JSON.parse(JSON.stringify(state.bookEvidence174));
  assert.deepEqual([p.statements,p.books,p.pages,p.cards,p.primarySpecies],[174,10,20,61,6239]);
  assert.deepEqual(p.legacy118,{statements:118,books:9,pages:16,cards:28,checkedFields:40,checkedSpecies:13,mohsFields:10,candidateIds:Array.from({length:40},(_,i)=>'book42-'+String(i+1).padStart(3,'0')),bibliography:['new-book-04','new-book-07'],legacyUnknownScalePreserved:true,allRecordsBooksAndHoldUnchanged:true});
  assert.deepEqual(p.chinese56,{checkedFields:56,checkedSpecies:34,fieldCounts:{crystal_habit:5,cleavage:1,formula:23,occurrence:27},candidateIds:Array.from({length:57},(_,i)=>'Chinese42-'+String(i+1).padStart(3,'0')).filter(id=>id!=='Chinese42-023'),rootReviewSHA256:expected.root_review_sha256,sourceBookSHA256:expected.source_book_sha256,approvedPages:['341','342','445','446'],formulaNarrativesSeparate:true,formulaReadability:{zirconSiO4Subscript:true,ottensiteH2SubscriptBaseline3:true,computedStyleAvailable:false,fontSizes:{}},cleavage100FamilyOnly:true,excluded023Absent:true,allPublicProofsEqualFixedExpected:true});
  assert.match(p.primaryBeforeSHA256,/^[a-f0-9]{64}$/);assert.equal(p.primaryBeforeSHA256,p.primaryAfterSHA256);assert.equal(p.readOnly,true);
  assert.equal(f.node('libraryScope').value,'all');assert.equal(f.node('librarySearch').value,'');assert.equal(f.node('detailDialog').open,false);assert.equal(f.saved.size,0);
});

test('fixed public expectations bind every row page proof and exclude023 without private source payloads',()=>{
  assert.equal(expected.schema,'android-currentbook174-Root56-fixed-public-expectations-v1');assert.equal(expected.records.length,56);
  const canonical=x=>JSON.stringify(x,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).sort().reduce((o,k)=>{o[k]=value[k];return o;},{}):value);
  for(const row of expected.records){assert.equal(createHash('sha256').update(canonical(row.source_pages)).digest('hex'),row.review.source_evidence_sha256);assert.equal(row.review.root_record_sha256,expected.root_review_sha256);assert.notEqual(row.review.approved_candidate_id,'Chinese42-023');}
  assert.doesNotMatch(expectedRaw.toString(),/\/Users\/|private-renders|source_short_evidence|actual_complete_page_visually_reviewed/);
});

test('wrong current counts, missing approved rows and any legacy118 mutation are rejected',async()=>{
  for(const changeCatalog of [c=>c.reviewed_book_evidence.counts.selected_source_pages=19,c=>c.reviewed_book_evidence.records.pop(),c=>c.reviewed_book_evidence.books.pop(),c=>c.minerals.pop(),c=>c.reviewed_book_evidence.records[0].value+='wrong']){
    const {state}=await run({changeCatalog});assert.equal(state.phase,'failed');assert.match(state.failure,/Book174:/);
  }
});

test('the preserved40 still reject missing fields, untranslated labels, wrong bibliography and scale',async()=>{
  for(const changeSections of [
    sections=>sections.map(html=>html.replace(/<div data-book-field="structure_description"[\s\S]*?<\/dd><\/div>/g,'')),
    sections=>sections.map(html=>html.replace('<dt>加工过程</dt>','<dt>processing</dt>')),
    sections=>sections.map(html=>html.includes('The Rock &amp; Gem Book')?html.replace('出版：','作者：Dan Green · 出版：'):html),
    sections=>sections.map(html=>html.replace('美国修订版，2008','美国修订版，2009')),
    sections=>sections.map(html=>html.replace('顺序标度，不表示硬度倍数','该页未明示硬度标度')),
    sections=>sections.map(html=>html.replace('该页未明示硬度标度。','顺序标度。'))
  ]){const {state}=await run({changeSections});assert.equal(state.phase,'failed');assert.match(state.failure,/Book174:/);}
});

test('new56 reject formula and narrative merging, missing narrative, wrong plane and page locator',async()=>{
  for(const changeSections of [
    sections=>sections.map(html=>html.replace('<div data-book-formula>','<div data-book-formula>本书原叙述：')),
    sections=>sections.map(html=>html.replace(/<small class="field-hint">[\s\S]*?<\/small>/g,'')),
    sections=>sections.map(html=>html.replaceAll('{100}','{010}')),
    sections=>sections.map(html=>html.replace('印刷页 325','印刷页 324'))
  ]){const {state}=await run({changeSections});assert.equal(state.phase,'failed');assert.match(state.failure,/Book174:/);}
});

test('new56 reject altered Root/page proof, semantic value, conditions and forbidden023 identity',async()=>{
  for(const mutate of [r=>r.review.root_record_sha256='a'.repeat(64),r=>r.source_pages[0].render_sha256='b'.repeat(64),r=>r.review.proposal_field_sha256='c'.repeat(64),r=>r.value+='wrong',r=>r.conditions=[],r=>r.review.approved_candidate_id='Chinese42-023']){
    const {state}=await run({changeCatalog:c=>mutate(c.reviewed_book_evidence.records.find(r=>r.review?.approved_candidate_id==='Chinese42-009'))});assert.equal(state.phase,'failed');assert.match(state.failure,/Book174:/);
  }
});

test('semantic formula regressions fail even when the complete literal text remains identical',async()=>{
  for(const changeSections of [
    sections=>sections.map(html=>html.replace('SiO<sub>4</sub>','SiO4')),
    sections=>sections.map(html=>html.replace('·3H<sub>2</sub>O','·<sub>3</sub>H<sub>2</sub>O'))
  ]){const {state}=await run({changeSections});assert.equal(state.phase,'failed');assert.match(state.failure,/Zircon SiO4 semantic subscript|Ottensite H2 subscript and baseline hydrate3/);}
  // No getComputedStyle implementation is installed by this fixture. Font18
  // is measured only by the real WebView, and this mock does not claim it.
});

test('primary mutation is caught and SOURCE retains all original inference/history/cold gates',async()=>{
  const {state}=await run({mutatePrimary:true});assert.equal(state.phase,'failed');assert.match(state.failure,/all 6239 primary objects unchanged/);
  assert.equal(java.split('checkBookReferenceCatalog(reference);').length-1,1);
  for(const forbidden of ['SpecimenStore','localStorage','removeItem','deleteDatabase','fetch(','MineralEngine'])assert.ok(!source.includes(forbidden),forbidden);
  assert.ok(!source.includes('?.')&&!source.includes('??'),'injected JS preserves the existing legacy-provider syntax floor');
  assert.ok(java.includes('checkHistoryAfterActivityRecreate(savedRecords.getJSONObject(0).getString("id"));'));assert.ok(java.includes('captureColdProcessBaseline('));
  assert.ok(java.includes(expected.catalog_pin.sha256));assert.ok(java.includes('getContext().getAssets().open("book174-expected.json")'));
  const gate=java.split('private void checkBookReferenceCatalog(JSONObject reference) throws Exception {')[1].split('private void checkOfflineReferenceCatalog()')[0];
  assert.ok(gate.includes('assertTrue("Real WebView must measure formula CSS",readability.getBoolean("computedStyleAvailable"));'));
  assert.ok(gate.includes('assertTrue("Zircon must have semantic SiO4 subscript",readability.getBoolean("zirconSiO4Subscript"));'));
  assert.ok(gate.includes('assertTrue("Ottensite must retain baseline hydrate3 and subscript H2",readability.getBoolean("ottensiteH2SubscriptBaseline3"));'));
  assert.ok(gate.includes('assertEquals(2,fontSizes.length());'));
  for(const id of ['ima-zircon','ima-ottensite'])assert.ok(gate.includes(`assertEquals("18px",fontSizes.getString("${id}"));`));
});
