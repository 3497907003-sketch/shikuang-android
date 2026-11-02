const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const Core=require('../web/core.js'),{fixture}=require('./helpers/app-fixture.cjs');
const catalog=JSON.parse(fs.readFileSync(require.resolve('../web/data/catalog.json'),'utf8'));
const sections=html=>(html.match(/<section class="detail-section book-evidence-section"[\s\S]*?<\/section>/g)||[]).filter(s=>s.includes('中国矿物（中文版）'));
const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

test('China16 shows every approved short statement, compiler, historical edition and only actual field pages',async()=>{
  const rows=catalog.reviewed_book_evidence.records.filter(r=>r.source_id==='new-book-10');
  assert.equal(rows.length,16);assert.equal(new Set(rows.map(r=>r.catalog_id)).size,2);
  assert.deepEqual([...new Set(rows.map(r=>r.pdf_page_1based))].sort((a,b)=>a-b),[10,11,13]);
  const before=JSON.stringify(catalog.minerals),f=fixture({catalog});await f.settle();let calls=0;f.context.fetch=()=>{calls++;throw Error('no extra book request');};
  for(const id of ['ima-copper','ima-chalcopyrite']){
    await f.documentClick('[data-detail]',{detail:'catalog:'+id});const blocks=sections(f.node('detailBody').innerHTML),html=blocks.join('');
    assert.equal(blocks.length,id==='ima-copper'?1:2);
    assert.match(html,/编者：中华人民共和国地质部地质博物馆/);assert.doesNotMatch(html,/主编：|ISBN/);
    assert.match(html,/出版：上海科学技术出版社 · 1980年12月第1版、第1次印刷/);
    assert.match(html,/书目页：PDF 第 3、4 页/);assert.match(html,/印刷页未注明/);
    assert.match(html,/1980 年出版/);assert.match(html,/不作为当前标本的物相、产地或实测物性/);
    assert.equal((html.match(/不作为当前标本的物相、产地或实测物性/g)||[]).length,blocks.length);
    for(const row of rows.filter(r=>r.catalog_id===id)){
      const block=blocks.find(b=>b.includes('PDF 第 '+row.pdf_page_1based+' 页'))||'';
      assert.ok(block.includes(escape(row.value)),row.review.approved_candidate_id);
    }
    assert.doesNotMatch(html,/PDF 第 12 页|\/Users\/|private-|Chinese44-|[a-f0-9]{64}|最有工业价值|在现代并不具有重要的工业价值/);
  }
  assert.equal(calls,0);assert.equal(JSON.stringify(catalog.minerals),before);
});

test('China16 literal formulas remain distinct from narrative and render the sulphur count as semantic subscript',async()=>{
  const f=fixture({catalog});await f.settle();
  for(const [id,raw,visible] of [['ima-copper','Cu','Cu'],['ima-chalcopyrite','CuFeS₂','CuFeS<sub>2</sub>']]){
    await f.documentClick('[data-detail]',{detail:'catalog:'+id});const html=sections(f.node('detailBody').innerHTML).join('');
    const formula=html.match(/<div data-book-formula>[\s\S]*?<\/div>/)?.[0]||'';
    assert.ok(formula.includes('aria-label="'+raw+'"'));assert.ok(formula.includes(visible));
    assert.doesNotMatch(formula,/本书|条目|化学式为/);assert.match(html,/<small class="field-hint">本书/);
  }
});

test('China16 new typed fields keep finite specimen and historical-use scope visible',async()=>{
  const f=fixture({catalog});await f.settle();await f.documentClick('[data-detail]',{detail:'catalog:ima-chalcopyrite'});
  const html=sections(f.node('detailBody').innerHTML).join('');
  assert.match(html,/表面特征（书籍描述）/);assert.match(html,/具名标本示例/);
  assert.match(html,/仅为书中具名标本示例，不是完整分布或普遍共生清单/);
  assert.match(html,/不代表现今工业排名、储量或当前标本的工业品级/);
  assert.match(html,/锖色是书中描述的表面现象，不据此自动判定为另一矿物/);
});

test('China16 rejects unapproved credit, ISBN, formula, field, page, Root and context mutations without touching primary facts',async()=>{
  for(const mode of ['editor','author','ISBN','publisher','year','formula','root','render','page12','printed-folio','caption-scope','industrial-rank']){
    const c=structuredClone(catalog),o=c.reviewed_book_evidence,book=o.books.find(b=>b.source_id==='new-book-10');
    let row=o.records.find(r=>r.review?.approved_candidate_id==='Chinese44-008');
    if(mode==='editor'||mode==='author')book.credit_role=mode;
    if(mode==='ISBN')book.isbn='unknown';
    if(mode==='publisher')book.publisher='某出版社';
    if(mode==='year')book.publication_year=2026;
    if(mode==='formula')row.formula_display=row.value;
    if(mode==='root')row.review.root_record_sha256='0'.repeat(64);
    if(mode==='render')row.source_pages[0].render_sha256='0'.repeat(64);
    if(mode==='page12'){row.pdf_page_1based=12;row.source_pages[0].pdf_page_1based=12;}
    if(mode==='printed-folio')row.printed_page='3';
    if(mode==='caption-scope'){row=o.records.find(r=>r.review?.approved_candidate_id==='Chinese44-016');row.conditions=[];}
    if(mode==='industrial-rank'){row=o.records.find(r=>r.review?.approved_candidate_id==='Chinese44-014');row.value='黄铜矿是当前最有工业价值的铜矿物';}
    const before=JSON.stringify(c.minerals),f=fixture({catalog:c});await f.settle();await f.documentClick('[data-detail]',{detail:'catalog:ima-chalcopyrite'});
    assert.equal(sections(f.node('detailBody').innerHTML).length,0,mode);assert.equal(JSON.stringify(c.minerals),before);
  }
});

test('compiler and new field exceptions do not admit an unreviewed source or change legacy editor credit',async()=>{
  const c=structuredClone(catalog),book=c.reviewed_book_evidence.books.find(b=>b.source_id==='user-book-17');book.credit_role='compiler';
  const f=fixture({catalog:c});await f.settle();await f.documentClick('[data-detail]',{detail:'catalog:ima-quartz'});
  assert.doesNotMatch(f.node('detailBody').innerHTML,/编者：John P\. Rafferty/);
  const g=fixture({catalog});await g.settle();await g.documentClick('[data-detail]',{detail:'catalog:ima-quartz'});
  assert.match(g.node('detailBody').innerHTML,/主编：John P\. Rafferty/);
  const d=structuredClone(catalog),b=d.reviewed_book_evidence.books.find(b=>b.source_id==='new-book-10');b.source_id='user-book-99';b.credit_role='author';
  for(const row of d.reviewed_book_evidence.records)if(row.source_id==='new-book-10')row.source_id='user-book-99';
  const h=fixture({catalog:d});await h.settle();await h.documentClick('[data-detail]',{detail:'catalog:ima-chalcopyrite'});assert.equal(sections(h.node('detailBody').innerHTML).length,0);
});

test('new fields remain forbidden for a generic legacy source even when its row and subject are changed together',async()=>{
  const originalBook=catalog.reviewed_book_evidence.books.find(b=>b.source_id==='user-book-17');
  const ofBook=html=>(html.match(/<section class="detail-section book-evidence-section"[\s\S]*?<\/section>/g)||[]).filter(s=>s.includes(escape(originalBook.title)));
  const f=fixture({catalog});await f.settle();await f.documentClick('[data-detail]',{detail:'catalog:ima-quartz'});
  assert.ok(ofBook(f.node('detailBody').innerHTML).some(s=>s.includes('data-book-field="uses"')));
  for(const field of ['surface_features','named_specimen_observation']){
    const c=structuredClone(catalog),o=c.reviewed_book_evidence,book=o.books.find(b=>b.source_id==='user-book-17');
    const row=o.records.find(r=>r.source_id==='user-book-17'&&r.catalog_id==='ima-quartz'&&r.field==='uses');
    const subject=book.subjects.find(s=>s.catalog_id===row.catalog_id&&s.pdf_page_1based===row.pdf_page_1based);
    subject.approved_fields=subject.approved_fields.map(x=>x==='uses'?field:x);row.field=field;
    const before=JSON.stringify(c.minerals),g=fixture({catalog:c});await g.settle();await g.documentClick('[data-detail]',{detail:'catalog:ima-quartz'});
    assert.equal(ofBook(g.node('detailBody').innerHTML).length,0,field);assert.equal(JSON.stringify(c.minerals),before);
  }
});

test('China16 increases reviewed book lookup to63 species while model scope and physical evidence remain unchanged',async()=>{
  const f=fixture({catalog});await f.settle();f.node('libraryScope').value='books';f.node('libraryScope').fire('change');
  assert.equal((f.node('libraryList').innerHTML.match(/data-detail=/g)||[]).length,63);
  assert.match(f.node('catalogIntro').innerHTML,/书籍核对：63 种矿物、190 条陈述/);
  assert.deepEqual(Object.keys(f.context.MINERAL_CLASSES),['quartz']);
  assert.deepEqual(Core.evidenceFor({reviewed_book_evidence:catalog.reviewed_book_evidence},{hardness:'9',luster:'metal'}),[]);
});
