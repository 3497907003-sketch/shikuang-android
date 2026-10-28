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
