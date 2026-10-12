const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('./helpers/app-fixture.cjs');
const data=()=>{const c={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/data/minerals.js'),'utf8'),c);return {knowledge:c.window.MINERAL_KB,crystalSystems:c.window.MINERAL_CRYSTAL_SYSTEM_ANNOTATIONS};};

test('source-bound seven-system annotations cover all reviewed Hexagonal fields while preserving the original source values',()=>{
  const {knowledge,crystalSystems}=data(),reviewed=JSON.parse(fs.readFileSync(path.join(__dirname,'../tools/source-import/crystal-system-reviewed.json'),'utf8'));
  assert.equal(crystalSystems.records.length,23);assert.equal(crystalSystems.counts.legacy_labels,24);assert.equal(crystalSystems.counts.conditional_sources,3);
  const keys=crystalSystems.records.flatMap(row=>row.legacy_keys);assert.deepEqual([...keys].sort(),Object.keys(knowledge).filter(key=>/^Hexagonal/.test(knowledge[key].verified_properties?.crystal_system?.value||'')).sort());
  for(const row of crystalSystems.records){const source=reviewed.records.find(r=>r.source_url===row.source_url);assert.equal(row.source_pdf_sha256,source.source_pdf_sha256);assert.match(row.source_pdf_sha256,/^[a-f0-9]{64}$/);for(const key of row.legacy_keys){assert.equal(knowledge[key].verified_properties.crystal_system.value,row.source_original_value);assert.equal(knowledge[key].verified_properties.crystal_system.source_url,row.source_url);}}
  assert.equal(knowledge.quartz.verified_properties.crystal_system.raw,'Hexagonal.');assert.equal(knowledge.pyrrhotite.verified_properties.crystal_system.value,'Monoclinic, pseudohexagonal');assert.equal(knowledge.aragonite.verified_properties.crystal_system.value,'Orthorhombic, pseudohexagonal');
});

test('quartz calcite and corundum display trigonal from reviewed point groups with reviewed source transcription and classification links',async()=>{
  const loaded=data(),original=JSON.stringify(loaded.knowledge),f=fixture(loaded);await f.settle();
  for(const key of ['quartz','calcite','corundum']){await f.documentClick('[data-detail]',{detail:key});const body=f.node('detailBody').innerHTML;assert.match(body,/晶系（七晶系）/);assert.match(body,/三方晶系/);assert.match(body,/原文：Hexagonal</);assert.match(body,/dictionary\.iucr\.org\/Crystal_family/);assert.match(body,/table1o3o4o3\.pdf/);assert.doesNotMatch(body,/<div class="property-value">六方晶系/);}
  assert.match(f.node('detailBody').innerHTML,/原 PDF SHA-256/);assert.equal(JSON.stringify(loaded.knowledge),original);
});

test('confirmed sixfold point groups remain hexagonal; polytypes and alternatives cannot silently become one crystal system',async()=>{
  const f=fixture(data());await f.settle();
  for(const key of ['beryl','vanadinite','cancrinit']){await f.documentClick('[data-detail]',{detail:key});assert.match(f.node('detailBody').innerHTML,/六方晶系（源页点群/);}
  for(const key of ['graphite','molybdenite']){await f.documentClick('[data-detail]',{detail:key});const body=f.node('detailBody').innerHTML;assert.match(body,/六方晶系（2H多型/);assert.match(body,/三方晶系（3R多型/);assert.match(body,/不能凭照片替当前标本选择/);}
  await f.documentClick('[data-detail]',{detail:'fluorapatite'});assert.match(f.node('detailBody').innerHTML,/六方晶系（源页六方结构/);assert.match(f.node('detailBody').innerHTML,/单斜晶系（源页单斜结构/);
  await f.documentClick('[data-detail]',{detail:'quartz'});assert.match(f.node('detailBody').innerHTML,/低于573°C/);assert.match(f.node('detailBody').innerHTML,/不将高温β晶相套用/);
});

test('an internally inconsistent source point group is disclosed, and changed sources fail back to review rather than reusing a stale annotation',async()=>{
  const loaded=data(),f=fixture(loaded);await f.settle();await f.documentClick('[data-detail]',{detail:'proustite'});assert.match(f.node('detailBody').innerHTML,/空间群R3c对应3m，二者不一致/);assert.match(f.node('detailBody').innerHTML,/点群具体值待复核/);
  loaded.knowledge.quartz.verified_properties.crystal_system.source_url='https://example.com/unreviewed.pdf';await f.documentClick('[data-detail]',{detail:'quartz'});assert.match(f.node('detailBody').innerHTML,/原表六方分类（七晶系待复核）/);assert.doesNotMatch(f.node('detailBody').innerHTML,/晶系（七晶系）/);
});

test('annotation PDF checksum must match the fact even when URL and source value are unchanged',async()=>{
  const loaded=data(),f=fixture(loaded);await f.settle();
  loaded.knowledge.quartz.verified_properties.crystal_system.source_pdf_sha256='f'.repeat(64);
  await f.documentClick('[data-detail]',{detail:'quartz'});
  assert.match(f.node('detailBody').innerHTML,/原表六方分类（七晶系待复核）/);
  assert.doesNotMatch(f.node('detailBody').innerHTML,/晶系（七晶系）/);
  delete loaded.knowledge.quartz.verified_properties.crystal_system.source_pdf_sha256;
  await f.documentClick('[data-detail]',{detail:'quartz'});
  assert.doesNotMatch(f.node('detailBody').innerHTML,/晶系（七晶系）/);
});
