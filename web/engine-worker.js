'use strict';
let bootError;
try { importScripts('./vendor/ort.min.js','./core.js'); } catch(error) { bootError=error.message||String(error); }
const sessions=new Map();
let currentManifestHash='',busy=false;
const send=(type,value)=>postMessage({type,...value});
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
const matchesShape=(actual,expected)=>Array.isArray(actual)&&actual.length===expected.length&&actual.every((size,i)=>size===expected[i]||(i===0&&(size===-1||typeof size==='string')));
async function releaseSessions() {
  const loaded=Array.from(sessions.values());sessions.clear();
  for(const session of loaded) { try { await session.release(); } catch (_) {} }
}
async function retainSessions(models,base,manifestHash) {
  const wanted=new Set(models.map(model=>`${base}|${manifestHash}|${model.path}|${model.sha256}`));
  for(const [key,session] of sessions)if(!wanted.has(key)){sessions.delete(key);await session.release();}
}
async function modelSession(model,base,manifestHash) {
  const key=`${base}|${manifestHash}|${model.path}|${model.sha256}`;
  if(sessions.has(key))return sessions.get(key);
  let previous=0;
  const response=await fetch(new URL(model.path,base));
  const bytes=await MineralCore.readResource(response,MineralCore.MODEL_MAX_BYTES,model.bytes,size=>{
    if(Date.now()-previous>250){send('progress',{message:`读取 ${model.title} ${(size/1048576).toFixed(1)}/${(model.bytes/1048576).toFixed(1)} MB…`});previous=Date.now();}
  });
  if(!crypto.subtle)throw new Error('当前环境无法校验模型，请使用安装版或 HTTPS 地址');
  if(hex(await crypto.subtle.digest('SHA-256',bytes))!==model.sha256)throw new Error('模型文件校验失败，请重新准备离线资源或安装新版');
  send('progress',{message:`${model.title} 已校验，正在初始化…`});
  const loaded=await ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
  try {
    if(loaded.inputNames.length!==1||loaded.outputNames.length!==1||loaded.inputNames[0]!==model.inputName||loaded.outputNames[0]!==model.outputName)throw new Error('模型输入输出名称与清单不匹配');
    // Some bundled ORT releases do not expose shape metadata. The real run still validates its input
    // and we check the actual output tensor type/shape below; never infer metadata from filenames.
    const input=loaded.inputMetadata?.[0],output=loaded.outputMetadata?.[0];
    if(input&&(input.isTensor!==true||input.type!=='float32'||!matchesShape(input.shape,[1,3,224,224])))throw new Error('模型输入格式与清单不匹配');
    if(output&&(output.isTensor!==true||output.type!=='float32'||!matchesShape(output.shape,[1,model.classes])))throw new Error('模型输出格式与清单不匹配');
    sessions.set(key,loaded);return loaded;
  } catch(error) {await loaded.release();throw error;}
}
async function run(session,data,model) {
  const input=new ort.Tensor('float32',data,[1,3,224,224]);let output;
  try {
    output=await session.run({[model.inputName]:input});
    const tensor=output[model.outputName];
    if(!tensor||tensor.type!=='float32'||JSON.stringify(tensor.dims)!==JSON.stringify([1,model.classes]))throw new Error('模型输出类型或形状与标签清单不匹配');
    const values=Array.from(tensor.data);
    if(values.length!==model.classes||values.some(x=>!Number.isFinite(x)))throw new Error('模型输出与标签清单不匹配');
    return values;
  } finally {input.dispose();if(output)Object.values(output).forEach(t=>t.dispose?.());}
}
onmessage=async({data})=>{
  if(data.type!=='analyze')return;
  if(busy){send('error',{message:'已有分析正在进行，请先停止当前分析'});return;}
  busy=true;
  try {
    if(bootError)throw new Error(`识别依赖加载失败：${bootError}`);
    const {base,inputs,labels,mode,modelIds,blocked,manifestSha256}=data;
    const origin=new URL(base);
    if(!['https:','http:'].includes(origin.protocol)||origin.origin!==self.location.origin)throw new Error('模型资源必须来自当前应用');
    ort.env.wasm.wasmPaths=new URL('vendor/',base).href;ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;
    const bytes=await MineralCore.readResource(await fetch(new URL('model-manifest.json',base),{cache:'no-cache'}),100000);
    if(!crypto.subtle)throw new Error('当前环境无法校验模型，请使用安装版或 HTTPS 地址');
    const actualHash=hex(await crypto.subtle.digest('SHA-256',bytes));
    if(actualHash!==currentManifestHash){await releaseSessions();currentManifestHash=actualHash;}
    const manifest=MineralCore.validateManifest(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),labels);
    if(actualHash!==manifestSha256)throw new Error('模型清单版本已变化，请更新后重试');
    if(!['fast','ensemble'].includes(mode)||JSON.stringify(modelIds)!==JSON.stringify(manifest.modes[mode]))throw new Error('所选模式与模型清单不匹配');
    if(!Array.isArray(inputs)||inputs.length<1||inputs.length>3||inputs.some(input=>!(input instanceof Float32Array)||input.length!==3*224*224||input.some(x=>!Number.isFinite(x))))throw new Error('图像张量大小或数值不正确');
    if(!Array.isArray(blocked)||blocked.length!==1000||blocked.some(x=>typeof x!=='boolean'))throw new Error('输入筛查清单不完整');
    const models=MineralCore.selectedModels(manifest,mode==='ensemble'),runs=[],screening=[],warnings=[];
    const gate=manifest.models.find(m=>m.role==='input-gate');
    await retainSessions([gate,...models],base,actualHash);
    const gateSession=await modelSession(gate,base,actualHash);
    for(let i=0;i<inputs.length;i++) {
      send('progress',{message:`筛查输入图像 ${i+1}/${inputs.length}…`});
      const values=await run(gateSession,inputs[i],gate);screening.push({photo:i,values});
      if(MineralCore.screen(values,blocked).rejected)throw new Error(MineralCore.NON_MINERAL);
    }
    if(models.length===1)warnings.push('快速模式仅提供初步候选，建议使用交叉分析与实测物性复核');
    for(let m=0;m<models.length;m++) {
      const model=models[m],loaded=await modelSession(model,base,actualHash);
      for(let i=0;i<inputs.length;i++) {
        send('progress',{message:`分析图像 ${i+1}/${inputs.length} · ${model.title}`});
        const values=await run(loaded,inputs[i],model);runs.push({photo:i,model:model.id,values});
        if(m===0&&i===0)send('partial',{key:labels[MineralCore.argmax(values)]});
      }
    }
    send('result',{runs,screening,warnings,manifestSha256:actualHash,modelVersion:manifest.version});
  } catch(error) {
    // A failed selected model never leaves a half-updated session set or a partial ensemble result.
    await releaseSessions();currentManifestHash='';send('error',{message:error.message||'识别资源无法运行，请更新 App'});
  } finally {busy=false;}
};
postMessage(bootError?{type:'boot-error',message:bootError}:{type:'ready'});
