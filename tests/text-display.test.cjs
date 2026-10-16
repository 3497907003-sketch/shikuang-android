const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fixture}=require('./helpers/app-fixture.cjs');
const root=path.resolve(__dirname,'../web');

test('published text is valid UTF-8 and has no replacement or private-font characters',()=>{
  for(const file of ['index.html','app.js','styles.css','data/minerals.js','data/sources.js','data/catalog.json','data/crystals.json','data/image-sources.json']){
    const text=new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(path.join(root,file)));
    assert.doesNotMatch(text,/[\ufffd\ue000-\uf8ff]/u,file);
  }
  assert.match(fs.readFileSync(path.join(root,'index.html'),'utf8'),/<meta charset="utf-8">/);
});

test('reviewed PDF Symbol formulas and their manifest integrity survive publication',()=>{
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'data/catalog.json'),'utf8'));
  for(const [name,formula,page] of [['Gachingite','Au(Te₁₋ₓSeₓ) (0.2 ≈ x ≤ 0.5)',79],['Orcelite','Ni₅₋ₓAs₂ (x ≈ 0.25)',160],['Sluzhenikinite','Pd₁₅(Sb₇₋ₓSnₓ) (3 ≤ x ≤ 4)',201]]){
    const row=catalog.minerals.find(row=>row.name_en===name);
    assert.equal(row.formula,formula);assert.equal(row.source_page,page);
  }
  const entry=JSON.parse(fs.readFileSync(path.join(root,'data/reference-manifest.json'),'utf8')).files.find(item=>item.path==='data/catalog.json'),bytes=fs.readFileSync(path.join(root,entry.path));
  assert.equal(bytes.length,entry.bytes);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),entry.sha256);
});

test('chemical scripts render with ordinary font glyphs while preserving accessible formulas and escaping source text',async()=>{
  const formula='Fe²⁺₃(PO₄)₂·8H₂O <img src=x onerror=alert(1)>',knowledge={quartz:{name_zh:'石英',name_en:'Quartz',formula}};
  const f=fixture({knowledge});await f.settle();await f.photo();await f.click('predictBtn');
  assert.match(f.node('resultFormula').innerHTML,/<sup>2\+<\/sup><sub>3<\/sub>/);
  assert.match(f.node('resultFormula').innerHTML,/aria-label="Fe²⁺₃/);
  assert.match(f.node('resultFormula').innerHTML,/&lt;img/);assert.doesNotMatch(f.node('resultFormula').innerHTML,/<img/);
  await f.documentClick('[data-detail]',{detail:'quartz'});
  assert.match(f.node('detailBody').innerHTML,/<sub>4<\/sub>/);assert.doesNotMatch(f.node('detailBody').innerHTML,/<img/);
});

test('source occupancy decimals stay subscript while hydration and range decimals remain at baseline with exact accessible and copied formulas',async()=>{
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'data/catalog.json'),'utf8')),original=JSON.stringify(catalog),f=fixture({catalog}),copied=[];
  await f.settle();f.context.navigator.clipboard={writeText:async text=>copied.push(text)};
  for(const [name,formula,visible] of [
    ['Allophane','Al₂O₃(SiO₂)₁.₃₋₂.₀·2.5-3.0H₂O','<sub>1.3</sub><sub>-2.0</sub>·2.5-3.0H<sub>2</sub>O'],
    ['Gachingite','Au(Te₁₋ₓSeₓ) (0.2 ≈ x ≤ 0.5)','Au(Te<sub>1-x</sub>Se<sub>x</sub>) (0.2 ≈ x ≤ 0.5)'],
    ['Abernathyite','K(UO₂)(AsO₄)·3H₂O','·3H<sub>2</sub>O']
  ]){
    const row=catalog.minerals.find(item=>item.name_en===name);assert.equal(row.formula,formula,name+' authoritative source');
    await f.documentClick('[data-detail]',{detail:'catalog:'+row.id});const body=f.node('detailBody').innerHTML;
    assert.ok(body.includes(visible),name+' decimal or hydration position');
    assert.ok(body.includes('<span class="formula" aria-label="'+formula+'">'),name+' complete source accessibility');
    const payload=body.match(/data-copy-formula="([^"]*)"/);assert.ok(payload,name+' copy action');assert.equal(payload[1],formula);
    await f.documentClick('[data-copy-formula]',{copyFormula:payload[1]});assert.equal(copied.at(-1),formula,name+' exact source copy');
  }
  assert.equal(JSON.stringify(catalog),original);
});

test('a rendering-only numeric script boundary probe preserves superscript decimals and leaves ASCII or mixed-script periods unmerged',async()=>{
  // This syntax probe is not a claimed mineral formula or a training example.
  const formula='X₂.₅ Y².⁵ 0.25 ·2.5H₂O ₁.⁵',knowledge={quartz:{name_zh:'公式显示边界测试',formula}},copied=[],f=fixture({knowledge});
  await f.settle();await f.photo();await f.click('predictBtn');const result=f.node('resultFormula').innerHTML;
  assert.ok(result.includes('<sub>2.5</sub>'));assert.ok(result.includes('<sup>2.5</sup>'));
  assert.ok(result.includes(' 0.25 ·2.5H<sub>2</sub>O <sub>1</sub>.<sup>5</sup>'));
  assert.ok(result.includes('aria-label="'+formula+'"'));
  await f.documentClick('[data-detail]',{detail:'quartz'});const payload=f.node('detailBody').innerHTML.match(/data-copy-formula="([^"]*)"/);
  assert.ok(payload);assert.equal(payload[1],formula);f.context.navigator.clipboard={writeText:async text=>copied.push(text)};
  await f.documentClick('[data-copy-formula]',{copyFormula:payload[1]});assert.deepEqual(copied,[formula]);assert.equal(f.context.MINERAL_KB.quartz.formula,formula);
});

test('simple physical terms show Chinese and their original source while qualified descriptions remain intact',async()=>{
  const facts={crystal_system:{value:'Cubic',raw:'Cubic.',status:'verified'},streak:{value:'White',raw:'White.',status:'verified'},luster:{value:'Vitreous; waxy to dull when massive',raw:'Vitreous; waxy to dull when massive.',status:'verified'}};
  const f=fixture({knowledge:{quartz:{name_zh:'石英',name_en:'Quartz',verified_properties:facts}}});await f.settle();await f.documentClick('[data-detail]',{detail:'quartz'});
  const body=f.node('detailBody').innerHTML;assert.match(body,/等轴晶系/);assert.match(body,/原文：Cubic/);assert.match(body,/白色/);assert.match(body,/原文：White/);assert.match(body,/Vitreous; waxy to dull when massive/);
  assert.equal(f.context.MINERAL_KB.quartz.verified_properties.crystal_system.value,'Cubic');
});

test('all 89 linked knowledge labels show Chinese property descriptions and retain the source values',async()=>{
  const vm=require('node:vm'),context={window:{}};vm.runInNewContext(fs.readFileSync(path.join(root,'data/minerals.js'),'utf8'),context);
  const knowledge=context.window.MINERAL_KB,original=JSON.stringify(knowledge),labels=Object.keys(knowledge).filter(key=>knowledge[key].verified_properties),f=fixture({knowledge});await f.settle();
  assert.equal(labels.length,89);
  for(const key of labels){
    await f.documentClick('[data-detail]',{detail:key});
    const body=f.node('detailBody').innerHTML;
    assert.doesNotMatch(body,/原文待翻译/,key);
    for(const label of ['摩氏硬度','实测密度','晶系','解理','光泽','条痕']){
      const match=body.match(new RegExp('<dt>'+label+'</dt><dd><div class="property-value">([\\s\\S]*?)</div>'));
      assert.ok(match,key+':'+label);
      const primary=match[1].split('<details')[0].replace(/<[^>]+>/g,'');
      assert.doesNotMatch(primary,/[A-Za-z]{3}/,key+':'+label);
    }
  }
  assert.equal(JSON.stringify(knowledge),original);
});

test('new unreviewed English descriptions are marked for translation and the exact source is available in a closed disclosure',async()=>{
  const f=fixture({knowledge:{quartz:{name_zh:'石英',verified_properties:{luster:{value:'Unreviewed unusual source description',raw:'Unreviewed unusual source description.',status:'verified'}}}}});await f.settle();await f.documentClick('[data-detail]',{detail:'quartz'});
  const body=f.node('detailBody').innerHTML;assert.match(body,/原文待翻译/);assert.match(body,/<details class="property-original">/);assert.match(body,/原文：Unreviewed unusual source description</);assert.doesNotMatch(body,/<details class="property-original" open/);
});

test('all reviewed catalog extensions render Chinese with conditioned facts and leave unverified values empty',async()=>{
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'data/catalog.json'),'utf8'));
  const ids=catalog.physical_stats.extension_batches.flatMap(batch=>batch.records.map(r=>r.catalog_id));
  assert.ok(ids.length>=100);assert.equal(new Set(ids).size,ids.length);
  const f=fixture({catalog});await f.settle();
  let checked=0;
  for(const id of ids){
    const row=catalog.minerals.find(r=>r.id===id);await f.documentClick('[data-detail]',{detail:'catalog:'+id});
    const body=f.node('detailBody').innerHTML;assert.doesNotMatch(body,/原文待翻译/,id);
    for(const prop of Object.values(row.physical_properties)){
      if(prop.status==='verified'){
        assert.equal(prop.translation.source_value,prop.value);assert.equal(prop.translation.status,'reviewed');checked++;
      }else assert.equal(prop.value,null);
    }
  }
  assert.ok(checked>=498);
  for(const [id,condition] of [['ima-epsomite','合成样品'],['ima-uraninite','随氧化显著降低'],['ima-tridymite','约 100 °C 以下'],['ima-clintonite','垂直于 {001}']]){
    await f.documentClick('[data-detail]',{detail:'catalog:'+id});assert.ok(f.node('detailBody').innerHTML.includes(condition),id+':'+condition);
  }
});

test('negative plane indices retain their exact overbar position and damaged extraction is not shown as source transcription',async()=>{
  const value='Perfect on {101̅0}',fact={value,raw:'Perfect on 1010 lost-vector-glyph',status:'verified',translation:{status:'reviewed',source_value:value,text_zh:'{101̅0} 面完全'}};
  const f=fixture({knowledge:{quartz:{name_zh:'石英',verified_properties:{cleavage:fact}}}});await f.settle();await f.documentClick('[data-detail]',{detail:'quartz'});
  const body=f.node('detailBody').innerHTML;
  assert.match(body,/\{10<span class="miller-negative" aria-label="负 1">1<\/span>0\}/);
  assert.match(body,/数字上方横线表示负晶面指数/);assert.doesNotMatch(body,/lost-vector-glyph|\u0305/);
  assert.equal(f.context.MINERAL_KB.quartz.verified_properties.cleavage.value,value);
});

test('a stale translation or unverified non-null field cannot become a displayed verified mineral property',async()=>{
  const facts={luster:{value:'New unknown source wording',raw:'Old raw wording',status:'verified',translation:{status:'reviewed',source_value:'Old wording',text_zh:'错误的旧翻译'}},cleavage:{value:'Perfect on {001}',raw:'Inferred',status:'source_inferred',translation:{status:'reviewed',source_value:'Perfect on {001}',text_zh:'不应显示'}}};
  const f=fixture({knowledge:{quartz:{name_zh:'石英',verified_properties:facts}}});await f.settle();await f.documentClick('[data-detail]',{detail:'quartz'});
  const body=f.node('detailBody').innerHTML;assert.match(body,/原文待翻译/);assert.match(body,/原文：New unknown source wording/);assert.match(body,/来源推测尚无可核验值/);assert.doesNotMatch(body,/错误的旧翻译|不应显示|Old raw wording|原文：Perfect/);
});

test('copying a readable chemical formula preserves the exact source subscripts and charges',async()=>{
  const copied=[],f=fixture();await f.settle();f.context.navigator.clipboard={writeText:async text=>copied.push(text)};
  await f.documentClick('[data-copy-formula]',{copyFormula:'Fe²⁺₃(PO₄)₂·8H₂O'});
  assert.deepEqual(copied,['Fe²⁺₃(PO₄)₂·8H₂O']);assert.match(f.node('toast').textContent,/已复制原始化学式/);
});

test('model guidance follows the validated ensemble and fast configurations without blocking the home page',async()=>{
  let complete,ready=false;
  const f=fixture({engine:{prepare:()=>new Promise(resolve=>{complete=()=>{ready=true;resolve();};}),getModels:precision=>ready?Array.from({length:precision?2:1},(_,i)=>({id:'model-'+i})):[]}});
  await f.settle();assert.match(f.node('precisionHelp').textContent,/正在读取/);await f.photo();assert.equal(f.node('predictBtn').disabled,false);
  complete();await f.settle();assert.match(f.node('precisionHelp').textContent,/综合 2 个图像模型/);assert.match(f.node('guideModelMode').textContent,/1 个模型快速分析/);assert.doesNotMatch(f.node('guideModelMode').textContent,/3 个/);
});

test('unavailable model configuration leaves home controls and a readable recovery hint',async()=>{
  const f=fixture({engine:{prepare:()=>Promise.reject(new Error('Bad manifest')),getModels:()=>[]}});await f.settle();
  assert.match(f.node('precisionHelp').textContent,/模型清单未就绪/);await f.photo();assert.equal(f.node('predictBtn').disabled,false);
});

test('offline manifest fallback identifies the cached version and resource recovery without claiming a completed upgrade',async()=>{
  const f=fixture({engine:{prepare:async()=>{},models:[{id:'one'}],configuration:{version:'audited-older-models'},manifestCacheState:'offline-cache'}});await f.settle();
  assert.equal(f.node('modelResourceState').hidden,false);assert.match(f.node('modelResourceState').textContent,/网络不可达，使用已验证的缓存模型清单（audited-older-models）/);assert.match(f.node('modelResourceState').textContent,/资源不完整时停止分析，请重新准备/);assert.doesNotMatch(f.node('modelResourceState').textContent,/升级已完成|准确率/);
  f.context.MineralEngine.manifestCacheState='network';f.context.MineralEngine.configuration={version:'current-models'};await f.photo();await f.click('predictBtn');
  assert.match(f.node('modelResourceState').textContent,/current-models/);assert.doesNotMatch(f.node('modelResourceState').textContent,/缓存模型清单/);
});
