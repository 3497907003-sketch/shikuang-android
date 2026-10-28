const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture}=require('./helpers/app-fixture.cjs');
const catalog=JSON.parse(fs.readFileSync(require.resolve('../web/data/catalog.json'),'utf8'));
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

test('all reviewed literature fields display Chinese source facts and exact pages while held values stay unavailable',async()=>{
  const before=JSON.stringify(catalog),rows=catalog.minerals.filter(row=>row.literature_properties),f=fixture({catalog});await f.settle();
  assert.equal(rows.length,113);assert.equal(catalog.literature_stats.source_batches.length,3);let verified=0,withheld=0;
  for(const row of rows){
    await f.documentClick('[data-detail]',{detail:'catalog:'+row.id});const body=f.node('detailBody').innerHTML;
    for(const [field,fact] of Object.entries(row.literature_properties)){
      const section=body.match(new RegExp('<section class="detail-section" data-literature-field="'+field+'">([\\s\\S]*?)</section>'))?.[1];assert.ok(section,row.id+':'+field);
      if(fact.status==='verified'){verified++;assert.ok(section.includes(escape(fact.value_zh)),row.id+':'+field);assert.ok(section.includes(escape(fact.source_url)+'#page='+fact.source_page));assert.ok(section.includes('第 '+fact.source_pages.join('、')+' 页'));}
      else{withheld++;assert.match(section,/所引文献未提供|资料待复核/);assert.doesNotMatch(section,/原文短摘|lateritic|metamorphic emery/);}
      if(field==='distribution')assert.match(section,/非完整或实时地点清单；不代表上传图片中标本的产地/);
    }
  }
  assert.equal(verified,224);assert.equal(withheld,2);assert.equal(JSON.stringify(catalog),before);
  assert.match(f.node('catalogIntro').innerHTML,/113 种矿物、224 项资料/);
  await f.documentClick('[data-detail]',{detail:'catalog:ima-realgar'});assert.doesNotMatch(f.node('detailBody').innerHTML,/未补猜|府县|\?\?/);
});

test('missing source identity never displays a literature proposal as verified and reviewed text is escaped',async()=>{
  const original=catalog.minerals.find(row=>row.id==='ima-realgar'),row=structuredClone(original),fact=row.literature_properties.occurrence;
  fact.value_zh='<img src=x onerror=alert(1)> 已核对文本';
  const f=fixture({catalog:{...catalog,minerals:[row]}});await f.settle();await f.documentClick('[data-detail]',{detail:'catalog:'+row.id});
  assert.match(f.node('detailBody').innerHTML,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(f.node('detailBody').innerHTML,/<img/);
  delete fact.root_ledger_sha256;await f.documentClick('[data-detail]',{detail:'catalog:'+row.id});assert.doesNotMatch(f.node('detailBody').innerHTML,/已核对文本/);assert.match(f.node('detailBody').innerHTML,/资料待复核/);
});
