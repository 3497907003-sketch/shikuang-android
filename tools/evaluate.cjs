const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const C = require('../web/core.js');
function evaluate(data, labels, knowledge, blocked = []) {
  if (data?.schema !== 'shikuang-evaluation-v2' || !Array.isArray(data.specimens) || !data.specimens.length) throw new Error('No labeled specimens supplied; accuracy cannot be measured.');
  if (JSON.stringify(data.labels) !== JSON.stringify(labels)) throw new Error('Model label order mismatch');
  const seen = new Set(), rows = [];
  for (const specimen of data.specimens) {
    if (!specimen.id || seen.has(specimen.id)) throw new Error('Repeated specimen ID: specimen-level splits must be disjoint');
    seen.add(specimen.id);
    if (!['daily','lab'].includes(specimen.scene) || !['calibration','test'].includes(specimen.split)) throw new Error('Each specimen needs an explicit scene and split');
    if (specimen.label !== 'unknown' && !labels.includes(specimen.label)) throw new Error(`Unknown label ${specimen.label}`);
    let result = null, rejection = specimen.rejected || '';
    const warnings = (specimen.qualityReports || []).flatMap((q,i)=>C.qualityWarnings(q).map(x=>`照片 ${i+1}：${x}`));
    if (warnings.some(x=>/偏暗|过曝|纹理过少/.test(x))) rejection = warnings.join('；');
    for (const screening of specimen.screening || []) {
      if(C.screen(screening.values,blocked).rejected)rejection=C.NON_MINERAL;
    }
    if (!rejection) {
      result = C.summarize(specimen.runs,labels,knowledge,specimen.observation || {});
      if (warnings.length) {
        result.reasons.push(...warnings); result.status = 'uncertain';
      }
    }
    rows.push({ id:specimen.id, scene:specimen.scene, split:specimen.split, truth:specimen.label,
      predicted:result?.key || null, top1:result?.key === specimen.label,
      top5:result?.rankings.some(x=>x.key===specimen.label) || false,
      strongSignal:result?.status === 'consistent', score:result?.score || 0,
      rejected:!!rejection, reasons:result?.reasons || [rejection] });
  }
  function metrics(group) {
    const known = group.filter(r=>r.truth!=='unknown'), unknown = group.filter(r=>r.truth==='unknown'), strong = known.filter(r=>r.strongSignal);
    const rate = (n,d) => d ? n/d : null;
    const perClass = [...new Set(known.map(r=>r.truth))].map(key=>{
      const tp=known.filter(r=>r.truth===key&&r.predicted===key).length;
      const fn=known.filter(r=>r.truth===key&&r.predicted!==key).length;
      const fp=known.filter(r=>r.truth!==key&&r.predicted===key).length;
      return { key, count:tp+fn, recall:rate(tp,tp+fn), f1:rate(2*tp,2*tp+fp+fn) };
    });
    const observed=rate(known.filter(r=>r.top1).length,known.length);
    const expected=known.length?perClass.reduce((sum,c)=>sum+c.count*known.filter(r=>r.predicted===c.key).length,0)/(known.length**2):null;
    const kappa=expected!==null&&expected<1?(observed-expected)/(1-expected):null;
    return { kappa, specimens:group.length, known:known.length, unknown:unknown.length,
      top1:rate(known.filter(r=>r.top1).length,known.length), top5:rate(known.filter(r=>r.top5).length,known.length),
      strongSignalCoverage:rate(strong.length,known.length), strongSignalAccuracy:rate(strong.filter(r=>r.top1).length,strong.length),
      unknownStrongSignalRate:rate(unknown.filter(r=>r.strongSignal).length,unknown.length),
      unknownRejectionRate:rate(unknown.filter(r=>r.rejected).length,unknown.length),
      macroF1:perClass.length?perClass.reduce((s,r)=>s+(r.f1||0),0)/perClass.length:null, perClass };
  }
  const groups={};
  for(const split of ['calibration','test'])for(const scene of ['all','daily','lab']){
    const group=rows.filter(r=>r.split===split&&(scene==='all'||r.scene===scene));
    if(group.length)groups[`${split}/${scene}`]=metrics(group);
  }
  return { policy:C.POLICY, warning:'Scores and thresholds are uncalibrated until a separate calibration set is used. Strong signal is provisional, not a verified identification.', groups, rows };
}
module.exports = { evaluate };
if(require.main===module){
  try{
    if(!process.argv[2])throw new Error('Usage: node tools/evaluate.cjs raw-predictions.json');
    const root=path.resolve(__dirname,'../web'), context={window:{}};
    for(const file of ['minerals','imagenet'])vm.runInNewContext(fs.readFileSync(path.join(root,`data/${file}.js`),'utf8'),context);
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'model-manifest.json'),'utf8'));
    console.log(JSON.stringify(evaluate(JSON.parse(fs.readFileSync(process.argv[2],'utf8')),manifest.labels,context.window.MINERAL_KB,context.window.IMAGENET_BLOCKED),null,2));
  }catch(e){console.error(e.message);process.exitCode=1;}
}
