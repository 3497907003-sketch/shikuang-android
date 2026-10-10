const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./helpers/app-fixture.cjs');

function mockCatalog(count=160){
  const source={title:'Official test directory',url:'https://example.org/ima.pdf',license:'CC BY-SA 3.0',license_url:'https://creativecommons.org/licenses/by-sa/3.0/',attribution:'Original authors; format adapted for tests.'};
  return {schema_version:1,version:'2026-09',retrieved_at:'2026-10-10',source,minerals:[{id:'ima-quartz',name_en:'Quartz',formula:'SiO₂',detail_key:'quartz',ima_status:'G',ima_number:'Historical code',source_url:source.url,source_page:4},...Array.from({length:count},(_,i)=>({id:'ima-test-'+(i+1),name_en:'Test mineral '+(i+1),formula:i===count-1?'NaPb₂(CO₃)₂(OH)':'CaCO₃',ima_status:i===count-1?'A ?':'A',ima_number:'2014-111',discovery_country:'Spain',first_reference:'Original journal, volume 29, page 915',second_reference:'',source_url:source.url,source_page:3,handbook_url:'https://example.org/handbook.pdf'}))]};
}
const cards=f=>(f.node('libraryList').innerHTML.match(/data-detail=/g)||[]).length;

test('catalog renders bounded pages, retains the loaded page and searches across unseen entries',async()=>{
  const f=fixture({catalog:mockCatalog()});await f.settle();f.route('library');
  assert.equal(cards(f),80);assert.equal(f.node('libraryCount').textContent,'161 项资料');
  await f.click('libraryMore');assert.equal(cards(f),160);await f.click('libraryMore');assert.equal(cards(f),161);assert.equal(f.node('libraryMore').hidden,true);
  f.route('identify');f.route('library');assert.equal(cards(f),161);
  f.node('librarySearch').value='TEST MINERAL 160';f.node('librarySearch').fire('input');assert.equal(cards(f),1);assert.match(f.node('libraryList').innerHTML,/NaPb₂/);
  f.node('librarySearch').value='NaPb2(CO3)2(OH)';f.node('librarySearch').fire('input');assert.equal(cards(f),1);
  f.node('librarySearch').value='not-in-directory';f.node('librarySearch').fire('input');assert.equal(cards(f),0);assert.match(f.node('libraryList').innerHTML,/没有匹配/);
});

test('expanded and image-model scopes retain original model keys while basic directory details expose provenance and gaps',async()=>{
  const f=fixture({catalog:mockCatalog()});await f.settle();
  for(const scope of ['expanded','model']){f.node('libraryScope').value=scope;f.node('libraryScope').fire('change');assert.equal(cards(f),1);assert.match(f.node('libraryList').innerHTML,/data-detail="quartz"/);}
  assert.deepEqual(Object.keys(f.context.MINERAL_CLASSES),['quartz']);
  await f.documentClick('[data-detail]',{detail:'catalog:ima-test-160'});
  assert.equal(f.node('detailTitle').textContent,'Test mineral 160');assert.match(f.node('detailType').textContent,/资料查阅/);
  const body=f.node('detailBody').innerHTML;
  for(const text of ['首次发现国家','Spain','A ?','2014-111','Original journal','未收录','全文未打包','原文未注明合成'])assert.ok(body.includes(text),text);
  assert.match(body,/https:\/\/example\.org\/ima\.pdf#page=3/);assert.match(body,/creativecommons\.org\/licenses\/by-sa\/3\.0/);
  assert.doesNotMatch(body,/undefined|批准时间：2014|图像模型支持/);
});

test('crystal scope shows measured samples in groups of five and excludes simulated records',async()=>{
  const catalog=mockCatalog(1),record=i=>({id:'sample-'+i,cell:{a:5.254,b:5.254,c:13.45,alpha:90,beta:90,gamma:120},space_group:'P6_3mc',authors:'Original authors',citation:'Journal 29 (2017), 915',article_title:'Measured specimen',experimental_notes:'Locality: original source\nT = 298 K',sample_origin:'原文未注明；未将缺少合成说明当作天然标本证明',source_file:'Specimen_'+i+'.amc',source_url:'https://www.rruff.net/amcsd/'});
  const crystals={source:{title:'AMCSD / RRUFF',url:'https://www.rruff.net/about/download-data/',scope:'测量事实与书目元数据'},by_species:{'ima-test-1':[...Array.from({length:7},(_,i)=>record(i)),{...record(8),article_title:'Hypothetical simulated specimen'}]}};
  const f=fixture({catalog,crystals});await f.settle();f.node('libraryScope').value='crystals';f.node('libraryScope').fire('change');assert.equal(cards(f),1);
  await f.documentClick('[data-detail]',{detail:'catalog:ima-test-1'});
  assert.equal((f.node('crystalRecords').innerHTML.match(/class="crystal-record"/g)||[]).length,5);
  assert.match(f.node('crystalRecords').innerHTML,/5.254 Å/);assert.match(f.node('crystalRecords').innerHTML,/120 °/);assert.match(f.node('crystalRecords').innerHTML,/P6_3mc/);assert.match(f.node('crystalRecords').innerHTML,/T = 298 K/);
  await f.documentClick('[data-more-crystals]');assert.equal((f.node('crystalRecords').innerHTML.match(/class="crystal-record"/g)||[]).length,7);assert.equal(f.node('moreCrystals').hidden,true);
  assert.match(f.node('crystalStatus').textContent,/7 \/ 7/);assert.doesNotMatch(f.node('crystalRecords').innerHTML,/Hypothetical/);
});

test('directory loads only on entering the library and rebuilds atomically after loading',async()=>{
  let finish,f,calls=0;const loader={status:'idle',load(){calls++;this.status='loading';return new Promise(resolve=>{finish=()=>{f.context.MINERAL_CATALOG=mockCatalog();this.status='ready';resolve();};});}};
  f=fixture({loader});await f.settle();assert.equal(calls,0);assert.equal(cards(f),1);
  await f.photo();await f.click('predictBtn');assert.equal(calls,0);assert.equal(f.node('result').hidden,false);
  f.route('library');await f.settle();assert.equal(calls,1);assert.equal(cards(f),1);assert.match(f.node('catalogLoadState').textContent,/正在打开/);
  finish();await f.settle();assert.equal(cards(f),80);assert.equal(f.node('libraryCount').textContent,'161 项资料');assert.match(f.node('catalogLoadState').textContent,/161 种/);
  f.route('identify');f.route('library');await f.settle();assert.equal(calls,1);
});

test('directory failures preserve original knowledge and expose an effective retry',async()=>{
  let f;const calls=[],loader={status:'idle',load(options){calls.push(options.retry);if(!options.retry){this.status='error';return Promise.reject(new Error('校验失败'));}f.context.MINERAL_CATALOG=mockCatalog(1);this.status='ready';return Promise.resolve();}};
  f=fixture({loader});await f.settle();f.route('library');await f.settle();assert.equal(cards(f),1);assert.equal(f.node('catalogRetry').hidden,false);assert.match(f.node('catalogLoadState').textContent,/校验失败/);
  await f.click('catalogRetry');assert.deepEqual(calls,[false,true]);assert.equal(cards(f),2);assert.equal(f.node('catalogRetry').hidden,true);
});

test('physical facts use field-specific sources, retain raw text and do not turn n.d. into a value',async()=>{
  const catalog=mockCatalog(1);catalog.minerals[1].physical_properties={hardness:{value:'2–3',raw:'2 - 3',source_url:'https://example.org/handbook.pdf',source_page:1,status:'verified'},density_measured:{value:'n.d.',raw:'n.d.',source_url:'https://example.org/handbook.pdf',source_page:1,status:'not_determined'}};
  const f=fixture({catalog});await f.settle();await f.documentClick('[data-detail]',{detail:'catalog:ima-test-1'});
  const body=f.node('detailBody').innerHTML;assert.match(body,/2–3/);assert.match(body,/原文：2 - 3/);assert.match(body,/MSA 矿物手册 · 第 1 页/);assert.match(body,/handbook\.pdf#page=1/);assert.match(body,/原文未给出可用值/);assert.doesNotMatch(body,/>n\.d\.</);
});

test('legacy labels for the same official species share one searchable card and keep result lookup working',async()=>{
  const catalog=mockCatalog(0);catalog.minerals.push({id:'ima-elbaite',name_en:'Elbaite',formula:'Na(Al₁.₅Li₁.₅)Al₆(Si₆O₁₈)(BO₃)₃(OH)₄',detail_key:'elbaite',legacy_keys:['elbaite','elbait'],aliases_en:['Elbait'],source_page:18});
  const knowledge={quartz:{name_zh:'石英',name_en:'Quartz'},elbaite:{name_zh:'锂电气石',name_en:'Elbaite'},elbait:{name_zh:'锂电气石',name_en:'Elbait'}};
  const f=fixture({catalog,knowledge,classes:{quartz:{zh:'石英'},elbait:{zh:'锂电气石'}}});await f.settle();assert.equal(cards(f),2);
  f.node('libraryScope').value='model';f.node('libraryScope').fire('change');assert.equal(cards(f),2);
  f.node('librarySearch').value='Elbait';f.node('librarySearch').fire('input');assert.equal(cards(f),1);assert.match(f.node('libraryList').innerHTML,/data-detail="elbaite"/);
  await f.documentClick('[data-detail]',{detail:'elbait'});assert.match(f.node('detailBody').innerHTML,/Elbaite/);assert.match(f.node('detailType').textContent,/图像模型支持/);
  assert.deepEqual(Object.keys(f.context.MINERAL_CLASSES),['quartz','elbait']);
});

test('specimen image references stay collapsed, link to evidence and preserve permission and training gaps',async()=>{
  const records=Array.from({length:7},(_,i)=>({id:'image-'+i,mineral_name:'Quartz',source:i?'RRUFF':'Wikimedia Commons',sample_id:'sample-'+i,image_page_url:'https://example.org/photo-'+i,original_image_url:'https://example.org/original-image.jpg',author:i?null:'Museum author',license:i?null:'CC BY-SA 4.0',license_url:'https://creativecommons.org/licenses/by-sa/4.0/',permission_status:i?'unverified_photo_reuse_permission':'per_file_open_license_requires_compliance_and_review',identification_evidence:{level:i?'rruff_xrd_and_chemical_analysis':'museum_photo_label_only_requires_expert_review',evidence_url:'https://example.org/evidence',independently_verified:false},training_ready:false}));
  const f=fixture({catalog:mockCatalog(0),images:{records:[...records,{...records[0],image_page_url:'javascript:alert(1)'}]}});await f.settle();await f.documentClick('[data-detail]',{detail:'quartz'});
  const body=f.node('detailBody').innerHTML,images=f.node('imageRecords').innerHTML;
  assert.match(body,/<details class="detail-section image-section">/);assert.match(body,/共生标本需专家标注/);
  assert.equal((images.match(/class="image-record"/g)||[]).length,5);assert.match(images,/Museum author/);assert.match(images,/CC BY-SA 4.0/);assert.match(images,/许可：待查/);assert.match(images,/来源称已用 X 射线衍射与化学分析确认/);assert.match(images,/尚未通过训练审核/);
  assert.doesNotMatch(images,/<img|original-image\.jpg|javascript:/);assert.match(f.node('catalogIntro').innerHTML,/7 条图片出处/);assert.match(f.node('catalogIntro').innerHTML,/通过训练审核 0 条/);
  await f.documentClick('[data-more-images]');assert.equal((f.node('imageRecords').innerHTML.match(/class="image-record"/g)||[]).length,7);assert.equal(f.node('moreImages').hidden,true);
});

test('review-required extraction is distinct from an unavailable source value and does not display damaged raw text',async()=>{
  const catalog=mockCatalog(0);catalog.minerals[0].physical_properties={cleavage:{value:null,raw:'damaged-vector-index',status:'needs_review',note:'原 PDF 的矢量指数需要人工复核',source_url:'https://example.org/quartz.pdf',source_page:1}};
  const f=fixture({catalog});await f.settle();await f.documentClick('[data-detail]',{detail:'quartz'});
  const body=f.node('detailBody').innerHTML;assert.match(body,/提取内容待复核，暂不作为有效物性/);assert.match(body,/矢量指数需要人工复核/);assert.match(body,/quartz\.pdf#page=1/);assert.doesNotMatch(body,/原文未给出可用值|damaged-vector-index/);
});
