const test=require('node:test'),assert=require('node:assert/strict');
const catalog=require('../web/data/catalog.json'),Core=require('../web/core.js'),{fixture}=require('./helpers/app-fixture.cjs');
const ids=['ima-greenockite','ima-linnaeite','ima-maucherite','ima-metacinnabar','ima-domeykite','ima-wurtzite','ima-stannite','ima-rickardite'];
const rows=catalog.reviewed_book_evidence.records.filter(r=>r.review?.approved_candidate_id?.startsWith('book56-'));
const sections=text=>(text.match(/<section class="detail-section book-evidence-section"[\s\S]*?<\/section>/g)||[]);
const escaped=s=>String(s).replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
test('book56 opens all eight actual catalog details with attributed Chinese properties and pending name notice',async()=>{
 const original=JSON.stringify(catalog.minerals),f=fixture({catalog});await f.settle();let extra=0;f.context.fetch=()=>{extra++;throw Error('no book or image download');};
 for(const id of ids){await f.documentClick('[data-detail]',{detail:'catalog:'+id});const body=f.node('detailBody').innerHTML,blocks=sections(body),book=blocks.join('');
  assert.equal(blocks.length,1,id);assert.match(book,/Minerals/);assert.match(book,/主编：John P\. Rafferty/);assert.match(book,/PDF 第 (330|331) 页 · 印刷页 (311|312)/);
  assert.match(body,/data-name-review="pending"/);assert.match(body,/中文名待核对，当前保留目录英文名/);
  for(const row of rows.filter(r=>r.catalog_id===id))assert.ok(book.includes(escaped(row.value)),row.review.approved_candidate_id);
  assert.match(book,/书中明确标注莫氏硬度；这是顺序标度/);assert.doesNotMatch(book,/PDF 第 332 页|\/Users\/|private-|book56-|[a-f0-9]{64}|source_literal/);
 }
 assert.equal(extra,0);assert.equal(JSON.stringify(catalog.minerals),original);
});
test('finite book56 semantic guard rejects altered scales, pages, authority and qualifiers without changing primary facts',async()=>{
 for(const mode of ['scale','unit','value','root','proposal','render','page','conditions','source','unknown-candidate']){
  const c=structuredClone(catalog),row=c.reviewed_book_evidence.records.find(r=>r.review?.approved_candidate_id==='book56-001');
  if(mode==='scale')row.hardness_scale=null;if(mode==='unit')row.unit='g/cm³';if(mode==='value')row.value='这个上传标本硬度已经确定';if(mode==='root')row.review.root_record_sha256='0'.repeat(64);if(mode==='proposal')row.review.proposal_field_sha256='0'.repeat(64);if(mode==='render')row.source_pages[0].render_sha256='0'.repeat(64);if(mode==='page'){row.pdf_page_1based=332;row.source_pages[0].pdf_page_1based=332;}if(mode==='conditions')row.conditions=[];if(mode==='source')row.source_id='user-book-99';if(mode==='unknown-candidate')row.review.approved_candidate_id='book56-999';
  const before=JSON.stringify(c.minerals),f=fixture({catalog:c});await f.settle();await f.documentClick('[data-detail]',{detail:'catalog:ima-greenockite'});assert.equal(sections(f.node('detailBody').innerHTML).length,0,mode);assert.equal(JSON.stringify(c.minerals),before);
 }
});
test('new book17 subjects cannot change source identity or editor credit and original quartz evidence still renders',async()=>{
 for(const [key,value]of [['title','A different title'],['credit_role','author'],['book_sha256','0'.repeat(64)]]){
  const c=structuredClone(catalog),book=c.reviewed_book_evidence.books.find(b=>b.source_id==='user-book-17');book[key]=value;const f=fixture({catalog:c});await f.settle();await f.documentClick('[data-detail]',{detail:'catalog:ima-wurtzite'});assert.equal(sections(f.node('detailBody').innerHTML).length,0,key);
 }
 const f=fixture({catalog});await f.settle();await f.documentClick('[data-detail]',{detail:'catalog:ima-quartz'});assert.ok(sections(f.node('detailBody').innerHTML).some(s=>s.includes('John P. Rafferty')&&s.includes('data-book-field="uses"')));
});
test('expanded book lookup keeps secondary data separate from model labels and physical comparisons',async()=>{
 const f=fixture({catalog});await f.settle();f.node('libraryScope').value='books';f.node('libraryScope').fire('change');assert.equal((f.node('libraryList').innerHTML.match(/data-detail=/g)||[]).length,71);assert.match(f.node('catalogIntro').innerHTML,/71 种矿物、200 条陈述/);
 assert.deepEqual(Core.evidenceFor({reviewed_book_evidence:rows},{hardness:'9',luster:'metal'}),[]);assert.deepEqual(Object.keys(f.context.MINERAL_CLASSES),['quartz']);assert.equal(rows.length,10);
 for(const id of ids){const m=catalog.minerals.find(r=>r.id===id);assert.equal(m.physical_properties,undefined);assert.equal(m.name_zh,undefined);}
});
