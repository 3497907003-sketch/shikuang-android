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
  const body=f.node('detailBody').innerHTML;assert.match(body,/原文待翻译/);assert.match(body,/<details class="property-original">/);assert.match(body,/Unreviewed unusual source description\./);assert.doesNotMatch(body,/<details class="property-original" open/);
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
