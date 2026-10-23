const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {fixture}=require('./helpers/app-fixture.cjs');
const reviewedKeys=['quartz','fluorite','gypsum','graphite','barite','cassiterite'];
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

function knowledge(){
  const context={window:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../web/data/minerals.js'),'utf8'),context);
  return context.window.MINERAL_KB;
}
function section(body,status){
  return body.match(new RegExp('<section\\b[^>]*data-industrial-uses="'+status+'"[^>]*>([\\s\\S]*?)</section>'))?.[1];
}
function reviewedFact(){
  // This is a display/validation probe, not an additional sourced mineral fact.
  return {status:'verified',value:['用途字段检查专用文本'],source_url:'https://www.usgs.gov/centers/national-minerals-information-center',source_title:'USGS 测试来源标题',source_section:'Uses',retrieved_at:'2026-10-23',source_text_sha256:'a'.repeat(64),commodity_scope_zh:'检查专用商品品级限定'};
}

test('reviewed mineral-use records retain USGS provenance and show the complete commodity scope in details',async()=>{
  const records=knowledge(),before=JSON.stringify(records),f=fixture({knowledge:records});await f.settle();
  for(const key of reviewedKeys){
    const fact=records[key].verified_industrial_uses;assert.ok(fact,key);
    assert.equal(fact.status,'verified',key);assert.ok(Array.isArray(fact.value)&&fact.value.length>0,key);
    for(const value of fact.value)assert.ok(typeof value==='string'&&value.trim()&&/[\u3400-\u9fff]/.test(value),key);
    const source=new URL(fact.source_url);assert.equal(source.protocol,'https:',key);assert.ok(['www.usgs.gov','pubs.usgs.gov'].includes(source.hostname),key);
    assert.match(fact.source_text_sha256,/^[a-f0-9]{64}$/i,key);assert.equal(fact.retrieved_at,['barite','cassiterite'].includes(key)?'2026-10-24':'2026-10-23',key);
    for(const field of ['source_title','source_section','commodity_scope_zh'])assert.ok(typeof fact[field]==='string'&&fact[field].trim(),key+':'+field);
    assert.ok(Array.isArray(records[key].industrial_uses)&&records[key].industrial_uses.length>0,key+' legacy data retained');
    await f.documentClick('[data-detail]',{detail:key});const body=f.node('detailBody').innerHTML,uses=section(body,'verified');assert.ok(uses,key);
    assert.match(uses,/用途（已核对来源）/);assert.ok(uses.includes(escape(fact.commodity_scope_zh)),key+' scope');
    for(const value of fact.value)assert.ok(uses.includes(escape(value)),key+' reviewed use');
    assert.ok(uses.includes('href="'+escape(fact.source_url)+'"'),key+' source link');
    assert.ok(uses.includes(escape(fact.source_title)),key+' source title');assert.ok(uses.includes(escape(fact.source_section)),key+' source section');
    assert.match(uses,/rel="noopener noreferrer"/);
  }
  assert.equal(JSON.stringify(records),before,'opening details must preserve reviewed and legacy source data');
});

test('canonical-only halite and talc uses require the exact existing mineral identity and do not create legacy or model entries',async()=>{
  const context={window:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../web/data/minerals.js'),'utf8'),context);
  const records=context.window.MINERAL_KB,extensions=context.window.MINERAL_INDUSTRIAL_USE_EXTENSIONS;
  const catalog=JSON.parse(fs.readFileSync(require.resolve('../web/data/catalog.json'),'utf8')).minerals.filter(row=>['ima-halite','ima-talc'].includes(row.id));
  assert.equal(catalog.length,2);assert.equal(Object.keys(records).length,105);assert.equal(records.halite,undefined);assert.equal(records.talc,undefined);
  const f=fixture({knowledge:records,catalog:{minerals:catalog}});f.context.MINERAL_INDUSTRIAL_USE_EXTENSIONS=extensions;await f.settle();
  for(const reference of catalog){
    const extension=extensions[reference.id],fact=extension.verified_industrial_uses;
    assert.equal(extension.id,reference.id);assert.equal(extension.name_en,reference.name_en);assert.equal(extension.formula,reference.formula);
    await f.documentClick('[data-detail]',{detail:'catalog:'+reference.id});let body=f.node('detailBody').innerHTML,uses=section(body,'verified');
    assert.ok(uses,reference.id);for(const value of fact.value)assert.ok(uses.includes(escape(value)),reference.id);
    assert.ok(uses.includes(escape(fact.commodity_scope_zh)));assert.ok(uses.includes('href="'+escape(fact.source_url)+'"'));
    assert.doesNotMatch(f.node('detailType').textContent,/图像模型支持/);
    for(const field of ['id','name_en','formula']){
      const original=extension[field];extension[field]=original+'-mismatch';await f.documentClick('[data-detail]',{detail:'catalog:'+reference.id});
      body=f.node('detailBody').innerHTML;assert.equal(section(body,'verified'),undefined,reference.id+':'+field);assert.ok(!body.includes(fact.value[0]));extension[field]=original;
    }
    const original=fact.status;fact.status='needs_review';await f.documentClick('[data-detail]',{detail:'catalog:'+reference.id});assert.equal(section(f.node('detailBody').innerHTML,'verified'),undefined);fact.status=original;
  }
  assert.equal(Object.keys(records).length,105);assert.equal(records.halite,undefined);assert.equal(records.talc,undefined);
});

test('a use claim with incomplete review, provenance, or values cannot appear as reviewed',async()=>{
  const original=reviewedFact(),record={name_zh:'用途准入检查',industrial_uses:['原项目用途检查文本'],verified_industrial_uses:original},f=fixture({knowledge:{quartz:record}});await f.settle();
  for(const source_url of [original.source_url,'https://pubs.usgs.gov/periodicals/mcs2026/']){
    record.verified_industrial_uses={...original,source_url};await f.documentClick('[data-detail]',{detail:'quartz'});
    assert.ok(section(f.node('detailBody').innerHTML,'verified')?.includes(original.value[0]),source_url);
  }
  const invalid=[
    ['unreviewed status',{status:'needs_review'}],['inferred status',{status:'source_inferred'}],['missing status',{status:undefined}],
    ['missing source hash',{source_text_sha256:undefined}],['short source hash',{source_text_sha256:'a'.repeat(63)}],['nonhex source hash',{source_text_sha256:'z'.repeat(64)}],
    ['missing source URL',{source_url:undefined}],['insecure source URL',{source_url:'http://www.usgs.gov/source'}],['script URL',{source_url:'javascript:alert(1)'}],
    ['different source host',{source_url:'https://example.org/source'}],['lookalike source host',{source_url:'https://www.usgs.gov.example.org/source'}],['URL credentials redirect',{source_url:'https://www.usgs.gov@example.org/source'}],
    ['empty values',{value:[]}],['string instead of list',{value:original.value[0]}],['empty item',{value:[original.value[0],' ']}],['nonstring item',{value:[original.value[0],null]}],
    ...['source_title','source_section','retrieved_at','commodity_scope_zh'].map(field=>['missing '+field,{[field]:''}])
  ];
  for(const [label,change] of invalid){
    record.verified_industrial_uses={...original,...change};await f.documentClick('[data-detail]',{detail:'quartz'});const body=f.node('detailBody').innerHTML;
    assert.equal(section(body,'verified'),undefined,label);assert.ok(!body.includes(original.value[0]),label+' proposed text withheld');
    const legacy=section(body,'legacy');assert.ok(legacy,label);assert.match(legacy,/原项目资料，待复核/,label);assert.ok(legacy.includes(record.industrial_uses[0]),label);
  }
});

test('use text and provenance are HTML-escaped and the remaining original uses are explicitly unreviewed',async()=>{
  const records=knowledge(),f=fixture({knowledge:records});await f.settle();let legacyCount=0;
  for(const [key,record] of Object.entries(records)){
    if(reviewedKeys.includes(key)||!record.industrial_uses?.length)continue;
    await f.documentClick('[data-detail]',{detail:key});const body=f.node('detailBody').innerHTML,legacy=section(body,'legacy');
    assert.ok(legacy,key);assert.match(legacy,/原项目资料，待复核/,key);assert.equal(section(body,'verified'),undefined,key);
    for(const value of record.industrial_uses)assert.ok(legacy.includes(escape(value)),key);legacyCount++;
  }
  assert.ok(legacyCount>0,'existing unsourced uses must remain available with an explicit review label');
  const payload='中文 & <img src=x onerror=alert(1)> "引号"',fact=reviewedFact();
  fact.value=[payload];fact.source_title='USGS '+payload;fact.source_section='Uses '+payload;fact.commodity_scope_zh='限定 '+payload;
  const probe=fixture({knowledge:{quartz:{name_zh:'用途转义检查',industrial_uses:[payload],verified_industrial_uses:fact}}});await probe.settle();await probe.documentClick('[data-detail]',{detail:'quartz'});
  const verified=section(probe.node('detailBody').innerHTML,'verified');assert.ok(verified);
  for(const text of [payload,fact.source_title,fact.source_section,fact.commodity_scope_zh])assert.ok(verified.includes(escape(text)),text);
  assert.doesNotMatch(verified,/<img\b|<script\b/);
  delete probe.context.MINERAL_KB.quartz.verified_industrial_uses;await probe.documentClick('[data-detail]',{detail:'quartz'});
  const legacy=section(probe.node('detailBody').innerHTML,'legacy');assert.ok(legacy.includes(escape(payload)));assert.doesNotMatch(legacy,/<img\b/);
});
