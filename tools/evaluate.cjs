const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const C = require('../web/core.js');
function evaluate(data, labels, knowledge, blocked = [], contract = null) {
  if (!['shikuang-evaluation-v2','shikuang-evaluation-v3'].includes(data?.schema) || !Array.isArray(data.specimens) || !data.specimens.length) throw new Error('No labeled specimens supplied; accuracy cannot be measured.');
  if (JSON.stringify(data.labels) !== JSON.stringify(labels)) throw new Error('Model label order mismatch');
  const audited = data.schema === 'shikuang-evaluation-v3';
  let manifest, selected;
  if(audited){
    if(!contract || !/^[a-f0-9]{64}$/.test(contract.manifestHash))throw new Error('Current manifest identity is required for evaluation');
    manifest=C.validateManifest(contract.manifest,labels);selected=C.selectedModels(manifest,contract.mode!=='fast');
    if(data.modelVersion!==manifest.version || data.manifestSha256!==contract.manifestHash || JSON.stringify(data.models)!==JSON.stringify(manifest.models.map(m=>({id:m.id,sha256:m.sha256,temperature:m.temperature}))))throw new Error('Predictions belong to a different model manifest; regenerate them');
  }
  const seen = new Set(), seenPhotos = new Set(), rows = [];
  for (const specimen of data.specimens) {
    if (!specimen.id || seen.has(specimen.id)) throw new Error('Repeated specimen ID: specimen-level splits must be disjoint');
    seen.add(specimen.id);
    if (!['daily','lab'].includes(specimen.scene) || !['calibration','test'].includes(specimen.split)) throw new Error('Each specimen needs an explicit scene and split');
    if (specimen.label !== 'unknown' && !labels.includes(specimen.label)) throw new Error(`Unknown label ${specimen.label}`);
    let runs=specimen.runs;
    if(audited){
      if(!specimen.label_basis?.trim() || !Array.isArray(specimen.photos) || !specimen.photos.length || specimen.photos.length>3)throw new Error('Specimen needs label evidence and 1–3 source photos');
      for(const photo of specimen.photos){if(!/^[a-f0-9]{64}$/.test(photo.sha256) || seenPhotos.has(photo.sha256))throw new Error('A photo cannot be repeated across evaluation groups');seenPhotos.add(photo.sha256);}
      const full=C.selectedModels(manifest,true);
      C.validateAnalysis({runs,screening:specimen.screening,warnings:[],manifestSha256:data.manifestSha256,modelVersion:data.modelVersion},specimen.photos.length,full,manifest,contract.manifestHash);
      runs=runs.filter(r=>selected.some(m=>m.id===r.model)).map(r=>({...r,output:'logits',temperature:selected.find(m=>m.id===r.model).temperature}));
    }
    let result = null, rejection = specimen.rejected || '';
    const warnings = (specimen.qualityReports || []).flatMap((q,i)=>C.qualityWarnings(q).map(x=>`照片 ${i+1}：${x}`));
    if (warnings.some(x=>/偏暗|过曝|纹理过少/.test(x))) rejection = warnings.join('；');
    for (const screening of specimen.screening || []) {
      if(C.screen(screening.values,blocked).rejected)rejection=C.NON_MINERAL;
    }
    if (!rejection) {
      result = C.summarize(runs,labels,knowledge,specimen.observation || {});
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
  return { policy:C.POLICY, modelVersion:manifest?.version || null,manifestSha256:audited?contract.manifestHash:null,mode:audited?(contract.mode==='fast'?'fast':'ensemble'):'provided-runs',
    prediction_manifest_audited:audited,independent_label_verification:false,
    warning:'Metrics use supplied labels and recorded specimen/source groups. Identity checks cannot independently prove ground truth, physical exclusivity or independence from training. PIL and Canvas preprocessing can differ. Strong signal is provisional, not a verified identification.', groups, rows };
}
module.exports = { evaluate };
if(require.main===module){
  try{
    if(!process.argv[2])throw new Error('Usage: node tools/evaluate.cjs raw-predictions.json');
    const root=path.resolve(__dirname,'../web'), context={window:{}};
    for(const file of ['minerals','imagenet'])vm.runInNewContext(fs.readFileSync(path.join(root,`data/${file}.js`),'utf8'),context);
    const bytes=fs.readFileSync(path.join(root,'model-manifest.json')),manifest=JSON.parse(bytes),data=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    if(data.schema!=='shikuang-evaluation-v3')throw new Error('Regenerate predictions with the current tools/predict_samples.py; legacy files lack model identity and temperatures');
    const mode=process.argv[3] || 'ensemble';if(!['fast','ensemble'].includes(mode))throw new Error('Mode must be fast or ensemble');
    console.log(JSON.stringify(evaluate(data,manifest.labels,context.window.MINERAL_KB,context.window.IMAGENET_BLOCKED,{manifest,manifestHash:require('node:crypto').createHash('sha256').update(bytes).digest('hex'),mode}),null,2));
  }catch(e){console.error(e.message);process.exitCode=1;}
}
