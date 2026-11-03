// Pure SOURCE/DOM simulation: no Android, browser, network, images or model payloads.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto');
const {fixture}=require('./helpers/app-fixture.cjs');
const expectedRaw=fs.readFileSync(require.resolve('../android/app/src/androidTest/assets/book190-expected.json'));
const expected=JSON.parse(expectedRaw);
const java=fs.readFileSync(require.resolve('../android/app/src/androidTest/java/com/shikuang/app/MineralEngineInstrumentedTest.java'),'utf8');
const method=java.split('static String book190ReadOnlyScript(String expectedJSON) {')[1]?.split('\n    private void checkBookReferenceCatalog(')[0];
assert.ok(method,'instrumentation must contain the versioned source under test');
const source=method.split('\n').filter(line=>/^\s*"/.test(line)).map(line=>line.includes('+expectedJSON+')?`)(${JSON.stringify(expected)});`:JSON.parse(line.trim().replace(/,$/,''))).join('\n');
const catalogRaw=fs.readFileSync(require.resolve('../web/data/catalog.json'));
assert.equal(catalogRaw.length,expected.catalog_pin.bytes,'the Android public catalogue must actually be synchronized to this profile');
assert.equal(createHash('sha256').update(catalogRaw).digest('hex'),expected.catalog_pin.sha256,'exact currentbook190 Android catalogue pin');
const catalog=JSON.parse(catalogRaw);
const decode=value=>value.replace(/&(?:amp|lt|gt|quot|#39|#x[0-9a-f]+|#\d+);/gi,entity=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"})[entity]??String.fromCodePoint(parseInt(entity.slice(2,-1).replace(/^x/i,''),/^&#x/i.test(entity)?16:10)));

// Parse the small real book-section markup, preserving nested formula/statement nodes.
function sectionNode(html){
  const element=(tag='',attrs={})=>({tag,attrs,children:[],get textContent(){return this.children.map(child=>typeof child==='string'?child:child.textContent).join('');},getAttribute(name){return Object.hasOwn(this.attrs,name)?this.attrs[name]:null;},get innerHTML(){return this.children.map(child=>typeof child==='string'?child:'<'+child.tag+'>'+child.innerHTML+'</'+child.tag+'>').join('');},querySelectorAll(selector){
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
  await vm.runInNewContext(source,f.context,{filename:'book190ReadOnlyScript.instrumentation.js'});return {state:f.context.__shikuangRuntimeSmoke,f};
}

test('the exact versioned instrumentation preserves118 and reads40 plus all56 and16 rendered fields and63 cards',async()=>{
  new vm.Script(source);const {state,f}=await run();assert.equal(state.phase,'book190-checked',state.failure);const p=JSON.parse(JSON.stringify(state.bookEvidence190));
  assert.deepEqual([p.statements,p.books,p.pages,p.cards,p.primarySpecies],[200,11,25,71,6239]);
  assert.deepEqual(p.legacy118,{statements:118,books:9,pages:16,cards:28,checkedFields:40,checkedSpecies:13,mohsFields:10,candidateIds:Array.from({length:40},(_,i)=>'book42-'+String(i+1).padStart(3,'0')),bibliography:['new-book-04','new-book-07'],legacyUnknownScalePreserved:true,allRecordsBooksAndHoldUnchanged:true});
  assert.deepEqual(p.chinese56,{checkedFields:56,checkedSpecies:34,fieldCounts:{crystal_habit:5,cleavage:1,formula:23,occurrence:27},candidateIds:Array.from({length:57},(_,i)=>'Chinese42-'+String(i+1).padStart(3,'0')).filter(id=>id!=='Chinese42-023'),rootReviewSHA256:expected.root_review_sha256,sourceBookSHA256:expected.source_book_sha256,approvedPages:['341','342','445','446'],formulaNarrativesSeparate:true,formulaReadability:{zirconSiO4Subscript:true,ottensiteH2SubscriptBaseline3:true,computedStyleAvailable:false,fontSizes:{}},cleavage100FamilyOnly:true,excluded023Absent:true,allPublicProofsEqualFixedExpected:true});
  assert.deepEqual(p.china16,{checkedFields:16,checkedSpecies:2,sections:3,approvedPages:['10','11','13'],fieldCounts:expected.china16.field_counts,candidateIds:Array.from({length:16},(_,i)=>'Chinese44-'+String(i+1).padStart(3,'0')),rootReviewSHA256:expected.china16.root_review_sha256,sourceBookSHA256:expected.china16.source_book_sha256,compilerCredit:true,unknownPrintedFolios:true,formulaNarrativesSeparate:true,formulaDOM:{copperLiteral:true,chalcopyriteSemanticSubscript:true,ariaLabelsPreserved:true},historicalScopeVisible:true,finiteSpecimenScopeVisible:true,surfaceTarnishScopeVisible:true,allPublicProofsEqualFixedExpected:true});
  assert.match(p.primaryBeforeSHA256,/^[a-f0-9]{64}$/);assert.equal(p.primaryBeforeSHA256,p.primaryAfterSHA256);assert.equal(p.readOnly,true);
  assert.equal(f.node('libraryScope').value,'all');assert.equal(f.node('librarySearch').value,'');assert.equal(f.node('detailDialog').open,false);assert.equal(f.saved.size,0);
});

test('fixed public expectations bind every row page proof and exclude023 without private source payloads',()=>{
  assert.equal(expected.schema,'android-currentbook190-Root56-China16-fixed-public-expectations-v1');assert.equal(expected.records.length,56);
  const canonical=x=>JSON.stringify(x,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).sort().reduce((o,k)=>{o[k]=value[k];return o;},{}):value);
  for(const row of expected.records){assert.equal(createHash('sha256').update(canonical(row.source_pages)).digest('hex'),row.review.source_evidence_sha256);assert.equal(row.review.root_record_sha256,expected.root_review_sha256);assert.notEqual(row.review.approved_candidate_id,'Chinese42-023');}
  assert.equal(expected.china16.source_Web_commit,'2af2cac72e610da78d47108dabdf99550dd7b1c8');
  assert.equal(expected.china16.records.length,16);assert.equal(expected.china16.book.credit_role,'compiler');assert.equal(Object.hasOwn(expected.china16.book,'isbn'),false);
  assert.deepEqual(Object.keys(expected.china16.pages),['10','11','13']);
  for(const row of expected.china16.records){assert.equal(createHash('sha256').update(canonical(row.source_pages)).digest('hex'),row.review.source_evidence_sha256);assert.equal(row.review.root_record_sha256,expected.china16.root_review_sha256);assert.equal(row.review.source_book_sha256,expected.china16.source_book_sha256);assert.equal(row.printed_page,null);}
  assert.doesNotMatch(expectedRaw.toString(),/\/Users\/|private-renders|source_short_evidence|actual_complete_page_visually_reviewed/);
});

test('China16 exact public collection rejects altered records, proofs, conditions, metadata and candidate sets',async()=>{
  for(const mutate of [
    (o,r)=>r.value+='wrong',(o,r)=>r.conditions=[],(o,r)=>r.limits=[],(o,r)=>r.unit='g/cm³',(o,r)=>r.hardness_scale='Mohs',
    (o,r)=>r.review.root_record_sha256='a'.repeat(64),(o,r)=>r.review.source_book_sha256='b'.repeat(64),
    (o,r)=>r.review.proposal_field_sha256='c'.repeat(64),(o,r)=>r.source_pages[0].render_sha256='d'.repeat(64),
    (o,r)=>r.printed_page='3',(o,r)=>r.pdf_page_1based=12,(o,r)=>r.review.approved_candidate_id='Chinese44-017',
    (o,r)=>r.formula_display=r.value,(o,r)=>o.records.push(structuredClone(r)),(o,r)=>o.records.splice(o.records.indexOf(r),1)
  ]){
    const {state}=await run({changeCatalog:c=>{const o=c.reviewed_book_evidence;mutate(o,o.records.find(r=>r.review?.approved_candidate_id==='Chinese44-008'));}});
    assert.equal(state.phase,'failed');assert.match(state.failure,/Book190:/);
  }
  for(const mutate of [b=>b.credit_role='editor',b=>b.credit_role='author',b=>b.authors=['某作者'],b=>b.isbn='unknown',b=>b.publisher='某出版社',b=>b.edition='第2版',b=>b.publication_year=2026,b=>b.bibliographic_pdf_pages=[12]]){
    const {state}=await run({changeCatalog:c=>mutate(c.reviewed_book_evidence.books.find(b=>b.source_id==='new-book-10'))});
    assert.equal(state.phase,'failed');assert.match(state.failure,/Book190:/);
  }
});

test('China16 real injected DOM checks reject missing page sections, compiler, formula, labels and finite scope',async()=>{
  const isChina=html=>html.includes('中国矿物（中文版）');
  for(const mutate of [
    html=>html.includes('PDF 第 13 页')?'':html,
    html=>html.replace('编者：中华人民共和国地质部地质博物馆','作者：中华人民共和国地质部地质博物馆'),
    html=>html.replace('1980年12月第1版、第1次印刷','2026年修订版'),
    html=>html.replace('书目页：PDF 第 3、4 页','书目页：PDF 第 3 页'),
    html=>html.replaceAll('印刷页未注明','印刷页 3'),
    html=>html.replace('不作为当前标本的物相、产地或实测物性',''),
    html=>html.replace('CuFeS<sub>2</sub>','CuFeS2'),
    html=>html.replace('aria-label="CuFeS₂"','aria-label="CuFeS2"'),
    html=>html.replace('保留本书化学式写法，不改主资料，也不是对当前标本的成分鉴定。',''),
    html=>html.replace('表面特征（书籍描述）','surface_features'),
    html=>html.replace('具名标本示例</dt>','物种通用属性</dt>'),
    html=>html.replace('不代表现今工业排名、储量或当前标本的工业品级',''),
    html=>html.replace('仅为书中具名标本示例，不是完整分布或普遍共生清单',''),
    html=>html.replace('锖色是书中描述的表面现象，不据此自动判定为另一矿物',''),
    html=>html.replace(/<small class="field-hint">本书[\s\S]*?<\/small>/g,'')
  ]){
    const {state}=await run({changeSections:sections=>sections.map(html=>isChina(html)?mutate(html):html)});
    assert.equal(state.phase,'failed');assert.match(state.failure,/Book190:/);
  }
});

test('wrong current counts, missing approved rows and any legacy118 mutation are rejected',async()=>{
  for(const changeCatalog of [c=>c.reviewed_book_evidence.counts.selected_source_pages=19,c=>c.reviewed_book_evidence.records.pop(),c=>c.reviewed_book_evidence.books.pop(),c=>c.minerals.pop(),c=>c.reviewed_book_evidence.records[0].value+='wrong']){
    const {state}=await run({changeCatalog});assert.equal(state.phase,'failed');assert.match(state.failure,/Book190:/);
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
  ]){const {state}=await run({changeSections});assert.equal(state.phase,'failed');assert.match(state.failure,/Book190:/);}
});

test('new56 reject formula and narrative merging, missing narrative, wrong plane and page locator',async()=>{
  for(const changeSections of [
    sections=>sections.map(html=>html.replace('<div data-book-formula>','<div data-book-formula>本书原叙述：')),
    sections=>sections.map(html=>html.replace(/<small class="field-hint">[\s\S]*?<\/small>/g,'')),
    sections=>sections.map(html=>html.replaceAll('{100}','{010}')),
    sections=>sections.map(html=>html.replace('印刷页 325','印刷页 324'))
  ]){const {state}=await run({changeSections});assert.equal(state.phase,'failed');assert.match(state.failure,/Book190:/);}
});

test('new56 reject altered Root/page proof, semantic value, conditions and forbidden023 identity',async()=>{
  for(const mutate of [r=>r.review.root_record_sha256='a'.repeat(64),r=>r.source_pages[0].render_sha256='b'.repeat(64),r=>r.review.proposal_field_sha256='c'.repeat(64),r=>r.value+='wrong',r=>r.conditions=[],r=>r.review.approved_candidate_id='Chinese42-023']){
    const {state}=await run({changeCatalog:c=>mutate(c.reviewed_book_evidence.records.find(r=>r.review?.approved_candidate_id==='Chinese42-009'))});assert.equal(state.phase,'failed');assert.match(state.failure,/Book190:/);
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
  assert.ok(java.includes(expected.catalog_pin.sha256));assert.ok(java.includes('getContext().getAssets().open("book190-expected.json")'));
  const gate=java.split('private void checkBookReferenceCatalog(JSONObject reference) throws Exception {')[1].split('private void checkOfflineReferenceCatalog()')[0];
  assert.ok(gate.includes('assertTrue("Real WebView must measure formula CSS",readability.getBoolean("computedStyleAvailable"));'));
  assert.ok(gate.includes('assertTrue("Zircon must have semantic SiO4 subscript",readability.getBoolean("zirconSiO4Subscript"));'));
  assert.ok(gate.includes('assertTrue("Ottensite must retain baseline hydrate3 and subscript H2",readability.getBoolean("ottensiteH2SubscriptBaseline3"));'));
  assert.ok(gate.includes('assertEquals(2,fontSizes.length());'));
  for(const id of ['ima-zircon','ima-ottensite'])assert.ok(gate.includes(`assertEquals("18px",fontSizes.getString("${id}"));`));
});
