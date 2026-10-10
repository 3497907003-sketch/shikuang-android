const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../web/core.js');
const keys = ['quartz','calcite','fluorite'];
const knowledge = { quartz:{hardness:7,luster:'玻璃光泽'},calcite:{hardness:3,luster:'玻璃至珍珠光泽'},fluorite:{hardness:4,luster:'玻璃光泽'} };
test('stable softmax handles extreme logits and rejects nonfinite outputs',()=>{
  const p=C.softmax([1000,999,-1000]);assert.ok(p.every(Number.isFinite));assert.ok(Math.abs(p.reduce((a,b)=>a+b)-1)<1e-12);
  assert.throws(()=>C.softmax([NaN,1]));assert.throws(()=>C.softmax([]));
});
test('probability outputs are not softmaxed twice',()=>assert.deepEqual(C.probabilities([0.7,0.2,0.1]),[0.7,0.2,0.1]));
test('outputs must match the exact model label count',()=>assert.throws(()=>C.summarize([{model:'a',photo:0,values:[1,2]}],keys,knowledge)));
test('each angle has equal weight regardless of available model count',()=>{
  const result=C.summarize([{model:'a',photo:0,values:[.9,.05,.05]},{model:'b',photo:0,values:[.9,.05,.05]},{model:'a',photo:1,values:[.05,.9,.05]}],keys,knowledge);
  assert.ok(Math.abs(result.scores[0]-.475)<1e-12);assert.equal(result.status,'uncertain');assert.ok(result.reasons.some(x=>x.includes('角度')));
});
test('physical observations flag conflict without increasing or changing image scores',()=>{
  const runs=[{model:'a',photo:0,values:[.9,.05,.05]},{model:'b',photo:0,values:[.9,.05,.05]}];
  const base=C.summarize(runs,keys,knowledge), conflict=C.summarize(runs,keys,knowledge,{hardness:'3'});
  assert.deepEqual(base.scores,conflict.scores);assert.equal(base.status,'consistent');assert.equal(conflict.status,'uncertain');assert.equal(conflict.checks[0].status,'conflict');
});
test('unknown knowledge and unmeasured hardness do not invent matching properties',()=>{
  assert.deepEqual(C.evidenceFor({}, {hardness:'7',luster:'metal'}),[]);assert.deepEqual(C.evidenceFor(knowledge.quartz,{hardness:''}),[]);
  assert.deepEqual(C.hardnessRange('6.5–7'),[6.5,7]);assert.equal(C.hardnessRange('未知'),null);
});
test('uncertain ranking is retained, with close candidates and model disagreement',()=>{
  const r=C.summarize([{model:'a',photo:0,values:[.5,.45,.05]},{model:'b',photo:0,values:[.4,.55,.05]}],keys,knowledge);
  assert.equal(r.rankings.length,3);assert.equal(r.status,'uncertain');assert.ok(r.reasons.some(x=>x.includes('模型')));
});
test('red and brown colors are not rejected as skin',()=>{
  const rgba=new Uint8ClampedArray(16*16*4);for(let i=0;i<rgba.length;i+=4){const high=i%12===0;rgba[i]=high?220:110;rgba[i+1]=high?110:50;rgba[i+2]=high?70:30;rgba[i+3]=255;}
  const q=C.quality(rgba,16,16);assert.equal(q.warnings.length,0);
});
test('quality guidance identifies dark and featureless photos',()=>{
  const q=C.quality(new Uint8ClampedArray(16*16*4),16,16);assert.ok(q.warnings.some(x=>x.includes('偏暗')));assert.ok(q.warnings.some(x=>x.includes('纹理')));
});
test('backup import validates schema, strips executable media and preserves confirmed labels',()=>{
  const raw={id:'1',time:1,name:'石英',rankings:[{key:'quartz',score:.8}],score:.8,photos:['javascript:alert(1)','data:text/html;base64,AAAA'],confirmedKey:'calcite',confirmationMethod:'XRD',notes:'<script>alert(1)</script>'};
  const parsed=C.parseImport(JSON.stringify({schema:'shikuang-records',version:2,records:[raw]}));assert.equal(parsed[0].confirmedKey,'calcite');assert.deepEqual(parsed[0].photos,[]);assert.equal(parsed[0].notes,raw.notes);
  assert.throws(()=>C.parseImport('{"records":[]}'));assert.throws(()=>C.parseImport(JSON.stringify({schema:'shikuang-records',version:2,records:[raw,raw]})));
});
test('a valid 100-record image backup larger than 10 MB imports and exports without losing photos',()=>{
  const photo='data:image/png;base64,'+require('node:fs').readFileSync(require.resolve('../icon-512.png')).toString('base64');
  const records=Array.from({length:100},(_,i)=>({id:`backup-${i}`,time:1,name:'照片备份测试',rankings:[{key:'quartz',score:.8}],score:.8,photos:[photo,photo,photo],notes:'保留完整记录',confirmedKey:'calcite',confirmationMethod:'备份往返测试'}));
  const text=JSON.stringify({schema:'shikuang-records',version:2,records});
  assert.ok(C.checkBackupSize(text)>10*1024*1024);
  const imported=C.parseImport(text),exported=JSON.stringify({schema:'shikuang-records',version:2,records:imported});
  C.checkBackupSize(exported);
  assert.deepEqual(C.parseImport(exported),imported);assert.equal(imported.length,100);
  assert.deepEqual(imported.map(r=>r.photos),records.map(r=>r.photos));
});
test('backup byte limits consistently reject files and UTF-8 text over 100 MB',()=>{
  assert.equal(C.checkBackupSize(C.BACKUP_LIMIT_BYTES),C.BACKUP_LIMIT_BYTES);
  assert.throws(()=>C.checkBackupSize(C.BACKUP_LIMIT_BYTES+1),/100 MB/);
  assert.equal(C.checkBackupSize('矿物'),6);
  const oversized='矿'.repeat(Math.floor(C.BACKUP_LIMIT_BYTES/3)+1);
  assert.throws(()=>C.parseImport(oversized),/100 MB/);
});
