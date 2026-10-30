const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Core=require('../web/core.js');
const {fixture}=require('./helpers/app-fixture.cjs');
const catalog=JSON.parse(fs.readFileSync(require.resolve('../web/data/catalog.json'),'utf8'));
const section=body=>body.match(/<section class="detail-section book-evidence-section"[\s\S]*?<\/section>/)?.[0]||'';

test('four reviewed book entries show short statements, source and printed pages without extra requests or private material',async()=>{
  const before=JSON.stringify(catalog.minerals),f=fixture({catalog});await f.settle();let calls=0;f.context.fetch=()=>{calls++;throw new Error('unexpected extra request');};
  for(const [id,page] of [['ima-cuprite','053'],['ima-aragonite','092'],['ima-andalusite','159'],['ima-jadeite','189']]){
    await f.documentClick('[data-detail]',{detail:'catalog:'+id});const html=section(f.node('detailBody').innerHTML);
    assert.match(html,/书籍资料核对/);assert.match(html,/矿物宝石大百科（全二册）/);assert.match(html,/松原聪、宫胁律郎、门马纲一/);assert.ok(html.includes('印刷页 '+page));
    assert.equal((html.match(/data-book-field=/g)||[]).length,7);
    assert.match(html,/该页未明示硬度标度/);assert.match(html,/无量纲，不替代实测密度/);
    assert.doesNotMatch(html,/\/Users\/|EPUB\/|user-book-|[a-f0-9]{64}|无解理，一组不完全至中等解理/);
  }
  await f.documentClick('[data-detail]',{detail:'catalog:ima-aragonite'});assert.match(section(f.node('detailBody').innerHTML),/暂未采纳/);
  await f.documentClick('[data-detail]',{detail:'catalog:ima-jadeite'});assert.match(section(f.node('detailBody').innerHTML),/与主资料表述不同/);
  assert.equal(calls,0);assert.equal(JSON.stringify(catalog.minerals),before);
});

test('missing review or mismatched book ownership blocks only secondary display and preserves primary facts',async()=>{
  for(const mode of ['missing-review','source-owner','subject-name','source-page','unit']){
    const c=structuredClone(catalog),r=c.reviewed_book_evidence.records.find(r=>r.catalog_id==='ima-jadeite'&&r.field==='hardness');
    if(mode==='missing-review')delete r.review;
    if(mode==='source-owner')r.source_id='user-book-99';
    if(mode==='subject-name')r.name_en='Cuprite';
    if(mode==='source-page')r.printed_page='053';
    if(mode==='unit')r.unit='Mohs';
    const before=JSON.stringify(c.minerals),f=fixture({catalog:c});await f.settle();await f.documentClick('[data-detail]',{detail:'catalog:ima-jadeite'});
    assert.equal(section(f.node('detailBody').innerHTML),'',mode);assert.match(f.node('detailBody').innerHTML,/6–7/);assert.equal(JSON.stringify(c.minerals),before);
  }
});

test('reviewed secondary book facts expand catalog detail scope without creating model scope or changing physical checks',async()=>{
  const actual=catalog.minerals.find(r=>r.id==='ima-jadeite'),bare={id:actual.id,name_en:actual.name_en,formula:actual.formula};
  const c={...catalog,minerals:[{id:'ima-quartz',name_en:'Quartz',detail_key:'quartz'},bare]},f=fixture({catalog:c});await f.settle();
  for(const [scope,count] of [['expanded',2],['model',1]]){f.node('libraryScope').value=scope;f.node('libraryScope').fire('change');assert.equal((f.node('libraryList').innerHTML.match(/data-detail=/g)||[]).length,count);}
  assert.deepEqual(Object.keys(f.context.MINERAL_CLASSES),['quartz']);
  assert.deepEqual(Core.evidenceFor({reviewed_book_evidence:c.reviewed_book_evidence},{hardness:'6.5',luster:'metal'}),[]);
  const primary=structuredClone(actual.physical_properties),before=Core.evidenceFor({verified_properties:primary},{hardness:'9',luster:'metal'});
  await f.documentClick('[data-detail]',{detail:'catalog:ima-jadeite'});
  assert.deepEqual(Core.evidenceFor({verified_properties:primary,reviewed_book_evidence:c.reviewed_book_evidence},{hardness:'9',luster:'metal'}),before);
});

test('secondary strings are escaped and ambiguous source text is never rendered',async()=>{
  const c=structuredClone(catalog),book=c.reviewed_book_evidence.books[0];book.title='<img src=x onerror=bad()> 书';book.authors=['<script>bad()</script>'];
  c.reviewed_book_evidence.records.find(r=>r.catalog_id==='ima-jadeite'&&r.field==='luster').value='<img src=x onerror=bad()>';
  const f=fixture({catalog:c});await f.settle();await f.documentClick('[data-detail]',{detail:'catalog:ima-jadeite'});const html=section(f.node('detailBody').innerHTML);
  assert.match(html,/&lt;img/);assert.match(html,/&lt;script/);assert.doesNotMatch(html,/<img|<script/);
});


test('a larger global book collection does not hide the current species reviewed details',async()=>{
  const c=structuredClone(catalog),o=c.reviewed_book_evidence,base=o.books[0],subject=base.subjects.find(s=>s.catalog_id==='ima-cuprite'),rows=o.records.filter(r=>r.catalog_id==='ima-cuprite');
  for(let i=3;i<83;i++){
    const source='user-book-'+String(i).padStart(2,'0'),book=structuredClone(base);book.source_id=source;book.title='UNIT_ONLY other source '+i;book.subjects=[structuredClone(subject)];o.books.push(book);
    o.records.push(...rows.map(row=>({...structuredClone(row),source_id:source})));
  }
  assert.ok(o.books.length>16);assert.ok(o.records.length>512);
  const f=fixture({catalog:c});await f.settle();await f.documentClick('[data-detail]',{detail:'catalog:ima-jadeite'});
  assert.match(section(f.node('detailBody').innerHTML),/印刷页 189/);assert.match(section(f.node('detailBody').innerHTML),/书籍资料核对/);
});

test('a new same-book page uses subject review while old book-level review remains compatible',async()=>{
  const c=structuredClone(catalog),o=c.reviewed_book_evidence,book=o.books[0],r=structuredClone(o.records.find(r=>r.catalog_id==='ima-jadeite'&&r.field==='luster'));
  r.printed_page='190';r.value='UNIT_ONLY extra page';r.review.root_record_sha256='b'.repeat(64);
  book.subjects.push({catalog_id:'ima-jadeite',name_en:'Jadeite',printed_page:'190',approved_fields:['luster'],root_review_sha256:'b'.repeat(64)});o.records.push(r);
  const f=fixture({catalog:c});await f.settle();await f.documentClick('[data-detail]',{detail:'catalog:ima-jadeite'});const html=f.node('detailBody').innerHTML;
  assert.equal((html.match(/data-book-evidence="reviewed"/g)||[]).length,2);assert.match(html,/印刷页 189/);assert.match(html,/印刷页 190/);assert.match(html,/UNIT_ONLY extra page/);
  const broken=structuredClone(c);broken.reviewed_book_evidence.books[0].subjects.at(-1).root_review_sha256='c'.repeat(64);
  const g=fixture({catalog:broken});await g.settle();await g.documentClick('[data-detail]',{detail:'catalog:ima-jadeite'});assert.equal(section(g.node('detailBody').innerHTML),'');
});

test('unreviewed or marker-only book records do not grant expanded or model scope',async()=>{
  for(const mode of ['missing-review','marker-only','duplicate-current-field']){
    const c=structuredClone(catalog),o=c.reviewed_book_evidence,id=mode==='marker-only'?'ima-aragonite':'ima-jadeite',actual=c.minerals.find(r=>r.id===id);
    c.minerals=[{id:'ima-quartz',name_en:'Quartz',detail_key:'quartz'},{id,name_en:actual.name_en,formula:actual.formula}];
    if(mode==='missing-review')delete o.records.find(r=>r.catalog_id===id).review;
    if(mode==='marker-only'){o.records=o.records.filter(r=>r.catalog_id!==id);o.books[0].subjects.find(s=>s.catalog_id===id).approved_fields=[];}
    if(mode==='duplicate-current-field')o.records.push(structuredClone(o.records.find(r=>r.catalog_id===id)));
    const f=fixture({catalog:c});await f.settle();
    for(const scope of ['expanded','model']){f.node('libraryScope').value=scope;f.node('libraryScope').fire('change');assert.equal((f.node('libraryList').innerHTML.match(/data-detail=/g)||[]).length,1,mode);}
  }
});

test('five PDF-only mineral pages keep unknown hardness and typed mass density separate from primary properties',async()=>{
  const f=fixture({catalog});await f.settle();let calls=0;f.context.fetch=()=>{calls++;throw new Error('unexpected book request');};
  for(const id of ['ima-clinoenstatite','ima-tschermakite','ima-edenite','ima-pargasite','ima-anthophyllite']){
    const primary=catalog.minerals.find(r=>r.id===id);assert.equal(primary.physical_properties,undefined);
    await f.documentClick('[data-detail]',{detail:'catalog:'+id});const text=section(f.node('detailBody').innerHTML);
    assert.equal((text.match(/data-book-field=/g)||[]).length,4);assert.match(text,/PDF 第 496 页 · 印刷页未注明 · 表 28\.2/);
    assert.match(text,/Wenk、Andrei Bulakh/);assert.match(text,/该页未明示硬度标度/);assert.match(text,/g\/cm³/);
    assert.match(text,/测定方式未注明，不替代主资料的实测密度/);assert.doesNotMatch(text,/相对密度|无量纲|印刷页 481|\/Users\/|[a-f0-9]{64}/);
  }
  assert.equal(calls,0);
});

test('PDF locator, unknown scale, quantity type and exact new-source identity are required for secondary display',async()=>{
  for(const mode of ['no-pdf','false-folio','Mohs','dimensionless','measured','unknown-source','missing-review']){
    const c=structuredClone(catalog),o=c.reviewed_book_evidence,rows=o.records.filter(r=>r.catalog_id==='ima-clinoenstatite');
    const density=rows.find(r=>r.field==='density'),hardness=rows.find(r=>r.field==='hardness');
    if(mode==='no-pdf')delete rows[0].pdf_page_1based;
    if(mode==='false-folio')rows[0].printed_page='481';
    if(mode==='Mohs')hardness.hardness_scale='Mohs';
    if(mode==='dimensionless')density.unit='dimensionless';
    if(mode==='measured')density.quantity_kind='density_measured';
    if(mode==='missing-review')delete density.review;
    if(mode==='unknown-source'){o.books.find(b=>b.source_id==='new-book-03').source_id='new-book-99';rows.forEach(r=>r.source_id='new-book-99');}
    const before=JSON.stringify(c.minerals),f=fixture({catalog:c});await f.settle();await f.documentClick('[data-detail]',{detail:'catalog:ima-clinoenstatite'});
    assert.equal(section(f.node('detailBody').innerHTML),'',mode);assert.equal(JSON.stringify(c.minerals),before);
  }
});

test('book uses and streak descriptions show exact PDF and print locators with duplicate intake credited once',async()=>{
  const o=catalog.reviewed_book_evidence;assert.equal(o.books.filter(b=>b.book_sha256==='66b43cd348f1f902380d86a3fb2c1db005990ece468c6428cff82d44d57c9702').length,1);
  const f=fixture({catalog});await f.settle();await f.documentClick('[data-detail]',{detail:'catalog:ima-quartz'});
  let text=section(f.node('detailBody').innerHTML);assert.match(text,/主编：John P\. Rafferty/);assert.match(text,/PDF 第 252 页 · 印刷页 233/);
  assert.match(text,/data-book-field="uses"/);assert.match(text,/砂纸和喷砂磨料/);assert.match(text,/不代表当前标本的工业品级/);
  await f.documentClick('[data-detail]',{detail:'catalog:ima-orpiment'});text=section(f.node('detailBody').innerHTML);
  assert.match(text,/Tom Jackson/);assert.match(text,/PDF 第 14 页 · 印刷页 14/);assert.match(text,/金黄色/);assert.match(text,/与主资料表述不同/);
});

test('PDF book strings are escaped and private paths are rejected before display',async()=>{
  for(const mode of ['escape','private']){
    const c=structuredClone(catalog),book=c.reviewed_book_evidence.books.find(b=>b.source_id==='new-book-03'),row=c.reviewed_book_evidence.records.find(r=>r.catalog_id==='ima-clinoenstatite'&&r.field==='density');
    book.title='<img src=x onerror=bad()> 书';row.value=mode==='escape'?'<svg onload=bad()>密度</svg>':'file:///Users/UNIT_ONLY/private.pdf';
    const f=fixture({catalog:c});await f.settle();await f.documentClick('[data-detail]',{detail:'catalog:ima-clinoenstatite'});const text=section(f.node('detailBody').innerHTML);
    if(mode==='escape'){assert.match(text,/&lt;img/);assert.match(text,/&lt;svg/);assert.doesNotMatch(text,/<img|<svg/);}else assert.equal(text,'');
  }
});

test('new book-only species gain reference detail without model scope or evidenceFor influence',async()=>{
  const actual=catalog.minerals.find(r=>r.id==='ima-clinoenstatite'),bare={id:actual.id,name_en:actual.name_en,formula:actual.formula};
  const c={...catalog,minerals:[{id:'ima-quartz',name_en:'Quartz',detail_key:'quartz'},bare]},f=fixture({catalog:c});await f.settle();
  for(const [scope,count] of [['expanded',2],['model',1]]){f.node('libraryScope').value=scope;f.node('libraryScope').fire('change');assert.equal((f.node('libraryList').innerHTML.match(/data-detail=/g)||[]).length,count);}
  await f.documentClick('[data-detail]',{detail:'catalog:ima-clinoenstatite'});
  assert.deepEqual(Core.evidenceFor({reviewed_book_evidence:c.reviewed_book_evidence},{hardness:'6',luster:'metal'}),[]);
  assert.deepEqual(Object.keys(f.context.MINERAL_CLASSES),['quartz']);
});

test('the three OCR-reviewed mineral pages show27 separate statements with source and specimen limits',async()=>{
  const f=fixture({catalog});await f.settle();
  for(const [id,pdf,print,count] of [['ima-clinoclase',130,127,7],['ima-erythrite',130,127,7],['ima-millerite',85,78,7]]){
    assert.equal(catalog.minerals.find(r=>r.id===id).physical_properties,undefined);
    await f.documentClick('[data-detail]',{detail:'catalog:'+id});const text=section(f.node('detailBody').innerHTML);
    assert.equal((text.match(/data-book-field=/g)||[]).length,count);assert.ok(text.includes(`PDF 第 ${pdf} 页 · 印刷页 ${print}`));
    assert.match(text,/无量纲，不替代实测密度/);assert.match(text,/该页未明示硬度标度/);assert.match(text,/书目版本尚待复核；所列条目已按标注原页核对/);
    if(id==='ima-millerite'){
      assert.match(text,/晶体习性/);assert.match(text,/不是对当前标本的测量/);assert.match(text,/黑绿色/);assert.match(text,/绿黑色/);
      assert.match(text,/该书表格与正文措辞不同，两处分别保留/);assert.doesNotMatch(text,/与主资料表述不同/);
    }else{assert.match(text,/成因与产出（书籍陈述）/);assert.match(text,/不代表当前标本的形成环境、产地或物相/);}
    assert.doesNotMatch(text,/Garnierite|\/Users\/|OCR_trace|native_text/);
  }
  await f.documentClick('[data-detail]',{detail:'catalog:ima-andalusite'});
  const sections=[...f.node('detailBody').innerHTML.matchAll(/<section class="detail-section book-evidence-section"[\s\S]*?<\/section>/g)].map(m=>m[0]);
  assert.equal(sections.length,2);const added=sections.find(s=>s.includes('PDF 第 59 页 · 印刷页 53'));
  assert.equal((added.match(/data-book-field=/g)||[]).length,6);assert.match(added,/3\.1～3\.2 g\/cm³/);assert.match(added,/测定方式未注明/);
});

test('new environment and habit claims require specimen limits and exact source aliases',async()=>{
  for(const mode of ['phase-kind','missing-limit','wrong-SHA','wrong-alias']){
    const c=structuredClone(catalog),o=c.reviewed_book_evidence,id=mode==='wrong-alias'?'ima-andalusite':'ima-clinoclase';
    const row=o.records.find(r=>r.catalog_id===id&&r.field==='occurrence');
    if(mode==='phase-kind')row.quantity_kind='current_specimen_phase';
    if(mode==='missing-limit')row.limits=row.limits.filter(x=>x!=='no_current_specimen_measurement');
    if(mode==='wrong-SHA')o.books.find(b=>b.source_id==='new-book-11').book_sha256='51256632b45d54a53231d1cb6f8e6338743da918984dcc7edcdd37b900f65c47';
    if(mode==='wrong-alias')o.books.find(b=>b.source_id==='user-book-07').intake_aliases=['new-book-02'];
    const before=JSON.stringify(c.minerals),f=fixture({catalog:c});await f.settle();await f.documentClick('[data-detail]',{detail:'catalog:'+id});
    assert.equal(section(f.node('detailBody').innerHTML),'',mode);assert.equal(JSON.stringify(c.minerals),before);
  }
});

test('OCR-reviewed occurrence and habit never become physical evidence or image-model coverage',async()=>{
  const actual=catalog.minerals.find(r=>r.id==='ima-clinoclase'),bare={id:actual.id,name_en:actual.name_en,formula:actual.formula};
  const c={...catalog,minerals:[{id:'ima-quartz',name_en:'Quartz',detail_key:'quartz'},bare]},f=fixture({catalog:c});await f.settle();
  for(const [scope,count] of [['expanded',2],['model',1]]){f.node('libraryScope').value=scope;f.node('libraryScope').fire('change');assert.equal((f.node('libraryList').innerHTML.match(/data-detail=/g)||[]).length,count);}
  const sourceRows=catalog.reviewed_book_evidence.records.filter(r=>r.catalog_id==='ima-clinoclase');
  assert.deepEqual(Core.evidenceFor({reviewed_book_evidence:sourceRows},{hardness:'2.5',luster:'glass'}),[]);
  assert.deepEqual(Object.keys(f.context.MINERAL_CLASSES),['quartz']);
});
